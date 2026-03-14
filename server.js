// server.js - מילמניה

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// ----------------------
//   Static & JSON
// ----------------------

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ----------------------
//   Postgres
// ----------------------

let pool = null;
let dbReady = false;

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("⚠️ No DATABASE_URL provided. Running without Postgres.");
    return;
  }

  try {
    pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });

    // משחקים
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        code TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        target_score INTEGER NOT NULL,
        default_round_seconds INTEGER NOT NULL,
        categories TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // קבוצות
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_teams (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL,
        team_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0
      );
    `);

    // שחקנים
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        team_id TEXT NOT NULL
      );
    `);

    dbReady = true;
    console.log("✅ Postgres ready.");
  } catch (err) {
    console.error("❌ Failed to init Postgres:", err);
  }
}

initDb();

// ----------------------
//   In-memory state
// ----------------------

const games = {};
const roundTimers = {};

// הגדרות עיצוב גלובליות שנשמרות בזיכרון (עבור מסכי הניהול)
let globalBanners = {};
let globalSettings = {};

// ----------------------
//   Word bank
// ----------------------

const WORD_BANK = [
  { text: "חתול", category: "animals" },
  { text: "כלב", category: "animals" },
  { text: "פיל", category: "animals" },
  { text: "שולחן", category: "objects" },
  { text: "מחשב", category: "technology" },
  { text: "טלפון", category: "technology" },
  { text: "פיצה", category: "food" },
  { text: "המבורגר", category: "food" },
  { text: "משפחה", category: "family" },
  { text: "חופשה", category: "travel" },
  { text: "ים", category: "travel" },
  { text: "כדורגל", category: "sports" },
  { text: "כדורסל", category: "sports" },
  { text: "סדרה בטלוויזיה", category: "entertainment" },
  { text: "סרט", category: "entertainment" },
  { text: "שיר", category: "music" },
  { text: "גיטרה", category: "music" },
  { text: "יער", category: "nature" },
  { text: "מדבר", category: "nature" },
  { text: "חג פסח", category: "holidays" },
  { text: "ראש השנה", category: "holidays" },
  { text: "מורה", category: "school" },
  { text: "תלמיד", category: "school" },
  { text: "בוס", category: "work" },
  { text: "משרד", category: "work" },
];

function getRandomWord(categories) {
  let pool = WORD_BANK;

  if (Array.isArray(categories) && categories.length > 0) {
    const catSet = new Set(categories);
    const filtered = WORD_BANK.filter((w) => catSet.has(w.category));
    if (filtered.length > 0) {
      pool = filtered;
    }
  }

  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ----------------------
//   Utils
// ----------------------

function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sanitizeGame(game) {
  if (!game) return null;

  const teams = {};
  Object.entries(game.teams || {}).forEach(([teamId, t]) => {
    teams[teamId] = {
      id: t.id || teamId,
      name: t.name,
      score: t.score || 0,
      players: Array.isArray(t.players) ? [...t.players] : [],
    };
  });

  const playersByClientId = {};
  Object.entries(game.playersByClientId || {}).forEach(([cid, p]) => {
    playersByClientId[cid] = {
      clientId: cid,
      name: p.name,
      teamId: p.teamId,
    };
  });

  return {
    code: game.code,
    hostName: game.hostName,
    targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds,
    categories: game.categories || [],
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    lastActivity: game.lastActivity,
    logoUrl: game.logoUrl || null,
    banners: game.banners || {},
    teams,
    playersByClientId,
    currentRound: game.currentRound || null,
  };
}

function broadcastGame(game) {
  if (!game || !game.code) return;
  io.to("game-" + game.code).emit("gameUpdated", sanitizeGame(game));
}

function clearRoundTimer(gameCode) {
  if (roundTimers[gameCode]) {
    clearInterval(roundTimers[gameCode]);
    delete roundTimers[gameCode];
  }
}

async function finishRound(gameCode, options = { reason: "manual" }) {
  const code = (gameCode || "").toUpperCase().trim();
  const game = games[code];
  if (!game || !game.currentRound) return;

  const round = game.currentRound;
  round.active = false;
  round.isActive = false;
  clearRoundTimer(code);

  const teamId = round.teamId;
  const roundScore = typeof round.roundScore === "number" && round.roundScore > 0 ? round.roundScore : 0;

  // צבירת ניקוד
  if (teamId && game.teams[teamId]) {
    game.teams[teamId].score = (game.teams[teamId].score || 0) + roundScore;
  }

  game.lastActivity = new Date();
  game.updatedAt = new Date();

  if (dbReady && pool && teamId && game.teams[teamId]) {
    try {
      await pool.query(
        `UPDATE game_teams SET score = $1 WHERE game_code = $2 AND team_id = $3`,
        [game.teams[teamId].score, code, teamId]
      );
    } catch (err) {
      console.error("Error updating team score:", err);
    }
  }

  const totalScore = teamId && game.teams[teamId] ? game.teams[teamId].score : 0;

  console.log(`⏹️ Round ended in game ${code}, team ${teamId}, roundScore=${roundScore}, reason=${options.reason}`);

  broadcastGame(game);

  io.to("game-" + code).emit("roundFinished", {
    teamId,
    roundScore,
    totalScore,
    reason: options.reason || "manual",
  });

  if (options.reason === "timer") {
    // שליחת שם הקבוצה לפופאפ סיום הזמן
    const finalTeamName = teamId && game.teams[teamId] ? game.teams[teamId].name : "";
    
    io.to("game-" + code).emit("roundTimeUp", { 
      code,
      roundScore,
      teamId,
      teamName: finalTeamName
    });
  }

  game.currentRound = null;
}

// ----------------------
//   Socket.io
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // שחזור חיבור מנהל
  socket.on("hostReconnect", (data, callback) => {
    try {
      const code = (data.gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }
      
      game.hostSocketId = socket.id;
      socket.join("game-" + code);
      console.log(`👑 Host reconnected to game ${code}`);
      
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in hostReconnect:", err);
      callback && callback({ ok: false, error: "שגיאה בשחזור חיבור." });
    }
  });

  // יצירת משחק
  socket.on("createGame", async (data, callback) => {
    try {
      const { hostName, targetScore = 40, defaultRoundSeconds = 60, categories = [], teamNames = {} } = data || {};
      if (!hostName || !hostName.trim()) return callback && callback({ ok: false, error: "נא להזין שם מנהל." });

      let code; do { code = generateGameCode(); } while (games[code]);

      const teams = {}; const now = new Date();
      ["A", "B", "C", "D", "E"].forEach((id) => {
        const name = (teamNames[id] || "").trim();
        if (name) teams[id] = { id, name, score: 0, players: [] };
      });
      if (Object.keys(teams).length === 0) {
        teams["A"] = { id: "A", name: "קבוצה A", score: 0, players: [] };
        teams["B"] = { id: "B", name: "קבוצה B", score: 0, players: [] };
      }

      const game = {
        code, hostSocketId: socket.id, hostName: hostName.trim(), targetScore: parseInt(targetScore, 10) || 40,
        defaultRoundSeconds: parseInt(defaultRoundSeconds, 10) || 60, categories: Array.isArray(categories) ? categories : [],
        createdAt: now, updatedAt: now, lastActivity: now, logoUrl: null, banners: {}, teams, playersByClientId: {}, currentRound: null,
      };

      games[code] = game;
      socket.join("game-" + code);

      if (dbReady && pool) {
        try {
          await pool.query(
            `INSERT INTO games (code, host_name, target_score, default_round_seconds, categories) VALUES ($1, $2, $3, $4, $5)`,
            [game.code, game.hostName, game.targetScore, game.defaultRoundSeconds, game.categories]
          );
          for (const t of Object.values(game.teams)) {
            await pool.query(
              `INSERT INTO game_teams (game_code, team_id, team_name, score) VALUES ($1, $2, $3, $4)`,
              [game.code, t.id, t.name, t.score]
            );
          }
        } catch (err) { console.error("Error persisting game:", err); }
      }

      console.log(`🎮 New game created: ${code} by host ${game.hostName}`);
      callback && callback({ ok: true, gameCode: code, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in createGame:", err);
      callback && callback({ ok: false, error: "שגיאה ביצירת המשחק." });
    }
  });

  // הצטרפות משתמש למשחק (כולל שחזור מצב Reconnect)
  socket.on("joinGame", async (data, callback) => {
    try {
      const { gameCode, name, teamId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];

      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      
      const playerName = (name || "").trim();
      if (!playerName) return callback && callback({ ok: false, error: "נא להזין שם שחקן." });

      let chosenTeamId = (teamId || "").trim();
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
        const teamIds = Object.keys(game.teams || {});
        if (!teamIds.length) return callback && callback({ ok: false, error: "אין קבוצות פעילות." });
        chosenTeamId = teamIds[0];
      }

      const clientId = socket.id;
      
      if (data.teamName && game.teams[chosenTeamId]) {
        game.teams[chosenTeamId].name = data.teamName;
      }

      game.playersByClientId[clientId] = { clientId, name: playerName, teamId: chosenTeamId };

      if (!Array.isArray(game.teams[chosenTeamId].players)) game.teams[chosenTeamId].players = [];
      if (!game.teams[chosenTeamId].players.includes(clientId)) game.teams[chosenTeamId].players.push(clientId);

      // שחזור תפקיד המסביר אם השחקן התנתק וחזר
      if (
        game.currentRound && 
        game.currentRound.active &&
        game.currentRound.teamId === chosenTeamId &&
        game.currentRound.explainerName === playerName
      ) {
        console.log(`🔄 Reclaimed explainer role for ${playerName} in game ${code}`);
        game.currentRound.explainerId = clientId;
      }

      game.lastActivity = new Date();
      game.updatedAt = new Date();

      if (dbReady && pool) {
        try {
          await pool.query(
            `INSERT INTO game_players (game_code, client_id, name, team_id) VALUES ($1, $2, $3, $4)`,
            [code, clientId, playerName, chosenTeamId]
          );
        } catch (err) { console.error("Error persisting game player:", err); }
      }

      console.log(`👤 Player joined: ${playerName} -> game ${code}, team ${chosenTeamId}`);
      socket.join("game-" + code);

      callback && callback({ ok: true, game: sanitizeGame(game), clientId, teamId: chosenTeamId });
      broadcastGame(game);
    } catch (err) {
      console.error("Error in joinGame:", err);
      callback && callback({ ok: false, error: "שגיאה בהצטרפות למשחק." });
    }
  });

  // הסרת שחקן
  socket.on("removePlayer", async (data, callback) => {
    try {
      const { gameCode, clientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });

      const player = game.playersByClientId[clientId];
      if (!player) return callback && callback({ ok: false, error: "השחקן לא נמצא." });

      const teamId = player.teamId;
      delete game.playersByClientId[clientId];

      if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
        game.teams[teamId].players = game.teams[teamId].players.filter(pId => pId !== clientId);
      }

      if (game.currentRound && game.currentRound.explainerId === clientId) {
        await finishRound(code, { reason: "player_disconnected" }); 
      } else {
        game.updatedAt = new Date();
        broadcastGame(game);
      }
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in removePlayer:", err);
      callback && callback({ ok: false, error: "שגיאה בהסרת שחקן." });
    }
  });

  // התחלת סיבוב
  socket.on("startRound", async (data, callback) => {
    try {
      const { gameCode, teamId, durationSeconds, explainerClientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });

      let chosenTeamId = (teamId || "").trim();
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
        const teamIds = Object.keys(game.teams || {});
        if (!teamIds.length) return callback && callback({ ok: false, error: "אין קבוצות." });
        chosenTeamId = teamIds[0];
      }

      clearRoundTimer(code);

      const team = game.teams[chosenTeamId];
      const playersInTeam = (team.players || []).map(clientId => game.playersByClientId[clientId]);
      if (!playersInTeam.length) return callback && callback({ ok: false, error: "אין שחקנים בקבוצה." });

      let explainingPlayer = explainerClientId ? playersInTeam.find(p => p && p.clientId === explainerClientId) : null;
      if (!explainingPlayer) explainingPlayer = playersInTeam[Math.floor(Math.random() * playersInTeam.length)];

      const totalSeconds = parseInt(durationSeconds, 10) || game.defaultRoundSeconds || 60;
      const now = new Date();

      game.currentRound = {
        teamId: chosenTeamId,
        explainerId: explainingPlayer.clientId,
        explainerName: explainingPlayer.name,
        secondsLeft: totalSeconds,
        active: true,
        isActive: true,
        roundScore: 0,
        startedAt: now.toISOString(),
      };

      game.updatedAt = now;
      game.lastActivity = now;

      io.to("game-" + code).emit("roundStarted", { game: sanitizeGame(game) });
      broadcastGame(game);

      roundTimers[code] = setInterval(() => {
        const g = games[code];
        if (!g || !g.currentRound) { clearRoundTimer(code); return; }

        g.currentRound.secondsLeft -= 1;
        if (g.currentRound.secondsLeft <= 0) {
          finishRound(code, { reason: "timer" });
        } else {
          io.to("game-" + code).emit("roundTick", { gameCode: code, secondsLeft: g.currentRound.secondsLeft });
          broadcastGame(g);
        }
      }, 1000);

      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in startRound:", err);
      callback && callback({ ok: false, error: "שגיאה בתחילת סיבוב." });
    }
  });

  // עדכון ניקוד סיבוב
  socket.on("changeRoundScore", (data, callback) => {
    try {
      const { gameCode, delta } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) return callback && callback({ ok: false, error: "אין סיבוב פעיל." });

      const d = parseInt(delta, 10) || 0;
      if (typeof game.currentRound.roundScore !== "number") game.currentRound.roundScore = 0;
      game.currentRound.roundScore = Math.max(0, game.currentRound.roundScore + d);
      
      callback && callback({ ok: true, roundScore: game.currentRound.roundScore });
      broadcastGame(game);
    } catch (err) {
      console.error("Error in changeRoundScore:", err);
      callback && callback({ ok: false, error: "שגיאה בעדכון ניקוד." });
    }
  });

  // קבלת מילה למסביר
  socket.on("getNextWord", (data, callback) => {
    try {
      const gameCode = (data.gameCode || "").toUpperCase().trim();
      const game = games[gameCode];
      if (!game || !game.currentRound || !game.currentRound.active) return callback && callback({ ok: false, error: "אין סיבוב פעיל." });

      const word = getRandomWord(game.categories || []);
      callback && callback({ ok: true, word: word.text, category: word.category });
    } catch (err) {
      callback && callback({ ok: false, error: "שגיאה בקבלת מילה." });
    }
  });

  // סיום סיבוב ידני
  socket.on("endRound", async (data, callback) => {
    try {
      await finishRound(data.gameCode, { reason: "manual" });
      callback && callback({ ok: true });
    } catch (err) {
      callback && callback({ ok: false, error: "שגיאה בסיום סיבוב." });
    }
  });

  // עדכון ניקוד קבוצה חופשי
  socket.on("updateScore", async (data, callback) => {
    try {
      const { gameCode, teamId, delta } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];

      if (!game || !game.teams[teamId]) {
        return callback && callback({ ok: false, error: "המשחק/קבוצה לא נמצאו." });
      }

      const change = parseInt(delta, 10) || 0;
      game.teams[teamId].score = Math.max(
        0,
        (game.teams[teamId].score || 0) + change
      );
      game.updatedAt = new Date();
      game.lastActivity = new Date();

      if (dbReady && pool) {
        try {
          await pool.query(
            `UPDATE game_teams SET score = $1 WHERE game_code = $2 AND team_id = $3`,
            [game.teams[teamId].score, code, teamId]);
        } catch (err) { console.error("Error updating team score:", err); }
      }

      broadcastGame(game);
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in updateScore:", err);
      callback && callback({ ok: false, error: "שגיאה בעדכון ניקוד." });
    }
  });

  // סיום המשחק
  socket.on("endGame", async (data, callback) => {
    try {
      const code = (data.gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });

      clearRoundTimer(code);
      delete games[code];

      if (dbReady && pool) {
        try {
          await pool.query(`DELETE FROM game_players WHERE game_code = $1;`, [code]);
          await pool.query(`DELETE FROM game_teams WHERE game_code = $1;`, [code]);
          await pool.query(`DELETE FROM games WHERE code = $1;`, [code]);
        } catch (err) { console.error("Error cleaning game from DB:", err); }
      }

      io.to("game-" + code).emit("gameEnded", { code });
      callback && callback({ ok: true });
      console.log(`🛑 Game ended: ${code}`);
    } catch (err) {
      callback && callback({ ok: false, error: "שגיאה בסיום משחק." });
    }
  });

  socket.on("getGameState", (data, callback) => {
    try {
      const code = ((data && data.gameCode) || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      callback && callback({ ok: false, error: "שגיאה בקבלת מצב." });
    }
  });

  // ניתוק חיבור
  socket.on("disconnect", async () => {
    // מניעת ניתוק המנהל עצמו (Host)
    for (const code of Object.keys(games)) {
      if (games[code] && socket.id === games[code].hostSocketId) return;
    }

    try {
      for (const code of Object.keys(games)) {
        const game = games[code];
        if (!game) continue;

        const player = game.playersByClientId ? game.playersByClientId[socket.id] : null;
        if (!player) continue;

        const clientId = socket.id;
        const teamId = player.teamId;

        delete game.playersByClientId[clientId];

        if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
          game.teams[teamId].players = game.teams[teamId].players.filter(pId => pId !== clientId);
        }

        game.lastActivity = new Date();
        game.updatedAt = new Date();

        if (dbReady && pool) {
          try {
            await pool.query(`DELETE FROM game_players WHERE game_code = $1 AND client_id = $2`, [code, clientId]);
          } catch (err) { console.error("Error deleting game player on disconnect:", err); }
        }

        if (game.currentRound && game.currentRound.explainerId === clientId) {
          console.log(`⚠️ Explainer disconnected (game ${code}). Timer continues, waiting for reconnect...`);
        }
        
        broadcastGame(game);
      }
    } catch (err) {
      console.error("Error in disconnect handler:", err);
    }
  });
});

// ----------------------
//   Admin API & Settings
// ----------------------

const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

app.get("/api/banners", (req, res) => {
  res.json({
    ...globalBanners,
    topBanner: globalSettings.topBanner || null,
    bottomBanner: globalSettings.bottomBanner || null
  });
});

app.post("/api/admin/banners", (req, res) => {
  const { adminCode, logo, index, host, player } = req.body || {};
  if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false, error: "Forbidden" });
  
  if (logo) globalBanners.logo = logo;
  if (index) globalBanners.index = index;
  if (host) globalBanners.host = host;
  if (player) globalBanners.player = player;
  
  res.json({ ok: true });
});

app.post("/admin/settings", (req, res) => {
  const adminCode = req.query.code || "";
  if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false, error: "Forbidden" });
  
  const { topBannerImg, topBannerLink, bottomBannerImg, bottomBannerLink } = req.body || {};
  globalSettings.topBanner = { img: topBannerImg, link: topBannerLink };
  globalSettings.bottomBanner = { img: bottomBannerImg, link: bottomBannerLink };
  
  res.json({ ok: true });
});

app.post("/admin/reset", async (req, res) => {
  const adminCode = req.query.code || "";
  if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false, error: "Forbidden" });
  
  for (const code of Object.keys(games)) {
    clearRoundTimer(code);
    delete games[code];
  }
  
  if (dbReady && pool) {
    try {
      await pool.query("DELETE FROM game_players;");
      await pool.query("DELETE FROM game_teams;");
      await pool.query("DELETE FROM games;");
    } catch (err) {
      console.error("Error resetting DB:", err);
    }
  }
  res.json({ ok: true });
});

app.get("/admin/summary", async (req, res) => {
  try {
    const code = req.query.code || "";
    if (code !== ADMIN_CODE) return res.status(403).json({ error: "Forbidden" });

    const summary = { activeGames: [], recentGames: [] };

    Object.values(games).forEach((g) => {
      const players = Object.values(g.playersByClientId || {}).map(p => ({
        clientId: p.clientId, name: p.name, teamId: p.teamId,
      }));
      summary.activeGames.push({
        code: g.code, hostName: g.hostName, targetScore: g.targetScore,
        defaultRoundSeconds: g.defaultRoundSeconds, categories: g.categories,
        teamCount: Object.keys(g.teams || {}).length, playerCount: players.length,
        createdAt: g.createdAt, players,
      });
    });

    if (dbReady && pool) {
      const dbRes = await pool.query(`SELECT code, host_name, target_score, default_round_seconds, categories, created_at FROM games ORDER BY created_at DESC LIMIT 50`);
      summary.recentGames = dbRes.rows.map(g => ({
        code: g.code, hostName: g.host_name, targetScore: g.target_score, defaultRoundSeconds: g.default_round_seconds,
        categories: g.categories, createdAt: g.created_at,
      }));
    }
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/admin/reports", async (req, res) => {
  const adminCode = req.query.code || "";
  if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false, error: "Forbidden" });
  
  const type = req.query.type;
  if (dbReady && pool) {
    try {
      if (type === "games") {
        const dbRes = await pool.query("SELECT code, host_name, created_at FROM games ORDER BY created_at DESC LIMIT 100");
        return res.json({ data: dbRes.rows });
      } else if (type === "ips") {
        const dbRes = await pool.query("SELECT client_id, name, game_code as code FROM game_players ORDER BY id DESC LIMIT 100");
        return res.json({ 
          data: dbRes.rows.map(r => ({ ip_address: r.client_id, name: r.name, code: r.code, created_at: new Date() })) 
        });
      }
    } catch (err) { console.error("Error fetching reports:", err); }
  }
  res.json({ data: [] });
});

app.post("/admin/game/:gameCode/close", async (req, res) => {
  try {
    const adminCode = req.query.code || "";
    if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false, error: "Forbidden" });

    const code = (req.params.gameCode || "").toUpperCase().trim();
    if (!games[code]) return res.status(404).json({ ok: false, error: "המשחק לא נמצא." });

    clearRoundTimer(code);
    delete games[code];

    if (dbReady && pool) {
      try {
        await pool.query(`DELETE FROM game_players WHERE game_code = $1;`, [code]);
        await pool.query(`DELETE FROM game_teams WHERE game_code = $1;`, [code]);
        await pool.query(`DELETE FROM games WHERE code = $1;`, [code]);
      } catch (err) { }
    }

    io.to("game-" + code).emit("gameEnded", { code });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// --- הוספת נתיב: שינוי שם קבוצה ע"י אדמין ראשי ---
app.post("/admin/game/:gameCode/team", async (req, res) => {
  try {
    const adminCode = req.query.code || "";
    if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false, error: "Forbidden" });

    const code = (req.params.gameCode || "").toUpperCase().trim();
    const { teamId, newName } = req.body || {};

    if (!games[code]) return res.status(404).json({ ok: false, error: "Game not found." });
    if (!teamId || !newName) return res.status(400).json({ ok: false, error: "Missing parameters." });
    if (!games[code].teams[teamId]) return res.status(404).json({ ok: false, error: "Team not found." });

    // עדכון בזיכרון
    games[code].teams[teamId].name = newName.trim();
    games[code].updatedAt = new Date();

    // עדכון במסד הנתונים
    if (dbReady && pool) {
      try {
        await pool.query(
          `UPDATE game_teams SET team_name = $1 WHERE game_code = $2 AND team_id = $3`,
          [newName.trim(), code, teamId]
        );
      } catch (err) {
        console.error("Error renaming team in DB:", err);
      }
    }

    // שידור למסכים
    broadcastGame(games[code]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error renaming team:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
