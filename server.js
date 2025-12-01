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
const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

const INACTIVITY_LIMIT = 24 * 60 * 60 * 1000; // 24 שעות
const CLEANUP_INTERVAL = 60 * 60 * 1000;      // בדיקה כל שעה

// --- Webhook Email ---
async function sendNewGameEmail(gameInfo) {
  const webhookUrl = process.env.EMAIL_WEBHOOK;
  if (!webhookUrl) return; 

  fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
          code: gameInfo.code,
          host: gameInfo.hostName,
          title: gameInfo.gameTitle || "ללא שם"
      })
  }).catch(err => console.error("Webhook error:", err.message));
}

// --- Setup ---
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

let pool = null;
let dbReady = false;

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("⚠️ No DATABASE_URL. Persistence disabled.");
    return;
  }
  try {
    pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });

    // טבלאות מקוריות
    await pool.query(`CREATE TABLE IF NOT EXISTS games (code TEXT PRIMARY KEY, host_name TEXT, target_score INTEGER, default_round_seconds INTEGER, categories TEXT[], created_at TIMESTAMPTZ DEFAULT NOW());`);
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS host_ip TEXT;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS branding JSONB;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS game_title TEXT;`); } catch (e) {}

    await pool.query(`CREATE TABLE IF NOT EXISTS game_teams (id SERIAL PRIMARY KEY, game_code TEXT, team_id TEXT, team_name TEXT, score INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_players (id SERIAL PRIMARY KEY, game_code TEXT, client_id TEXT, name TEXT, team_id TEXT, ip_address TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS ip_address TEXT;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`); } catch (e) {}

    await pool.query(`CREATE TABLE IF NOT EXISTS active_states (game_code TEXT PRIMARY KEY, data TEXT, last_updated TIMESTAMPTZ DEFAULT NOW());`);
    
    // --- טבלה להגדרות אתר גלובליות (באנרים) ---
    await pool.query(`CREATE TABLE IF NOT EXISTS site_settings (
        id SERIAL PRIMARY KEY,
        top_banner_img TEXT,
        top_banner_link TEXT,
        bottom_banner_img TEXT,
        bottom_banner_link TEXT,
        top_banner_img_mobile TEXT,
        bottom_banner_img_mobile TEXT
    );`);
    
    // וידוא שקיימת שורה אחת לפחות
    await pool.query(`
        INSERT INTO site_settings (id) 
        VALUES (1) 
        ON CONFLICT (id) DO NOTHING;
    `);

    dbReady = true;
    console.log("✅ Postgres ready.");
    await restoreActiveGames();
  } catch (err) {
    console.error("❌ DB Error:", err.message);
  }
}
initDb();

// --- State ---
const games = {};
const roundTimers = {};

const safeCb = (cb, data) => { if (typeof cb === 'function') cb(data); };

async function saveGameState(game) {
    if (!dbReady || !game) return;
    try {
        const gameToSave = JSON.parse(JSON.stringify(game));
        const json = JSON.stringify(gameToSave);
        await pool.query(
            `INSERT INTO active_states (game_code, data, last_updated) VALUES ($1, $2, NOW()) 
             ON CONFLICT (game_code) DO UPDATE SET data = $2, last_updated = NOW()`,
            [game.code, json]
        );
    } catch (e) { console.error("Save State Error:", e.message); }
}

async function deleteGameState(gameCode) {
    if (!dbReady) return;
    try {
        await pool.query(`DELETE FROM active_states WHERE game_code = $1`, [gameCode]);
    } catch (e) { console.error("Delete State Error:", e.message); }
}

async function restoreActiveGames() {
    if (!dbReady) return;
    console.log("♻️ Restoring games...");
    try {
        const res = await pool.query("SELECT * FROM active_states");
        res.rows.forEach(row => {
            try {
                const game = JSON.parse(row.data);
                games[game.code] = game;
                if (game.currentRound && game.currentRound.active) {
                    const now = Date.now();
                    const lastUpdate = new Date(row.last_updated).getTime();
                    const secondsPassed = Math.floor((now - lastUpdate) / 1000);
                    game.currentRound.secondsLeft -= secondsPassed;
                    if (game.currentRound.secondsLeft > 0) {
                        startTimerInterval(game.code);
                    } else {
                        finishRound(game.code, { reason: "timer" });
                    }
                }
            } catch (e) { console.error("Failed to parse game", row.game_code); }
        });
    } catch (e) { console.error("Restore Error:", e.message); }
}

// מאגר מילים
const WORD_BANK = [
    {text:"כלב",category:"animals"},{text:"חתול",category:"animals"},{text:"פיל",category:"animals"},{text:"אריה",category:"animals"},{text:"ג'ירפה",category:"animals"},{text:"קוף",category:"animals"},{text:"דג",category:"animals"},{text:"ציפור",category:"animals"},{text:"נחש",category:"animals"},{text:"צפרדע",category:"animals"},
    {text:"פיצה",category:"food"},{text:"המבורגר",category:"food"},{text:"סושי",category:"food"},{text:"פסטה",category:"food"},{text:"גלידה",category:"food"},{text:"שוקולד",category:"food"},{text:"לחם",category:"food"},{text:"תפוח",category:"food"},{text:"בננה",category:"food"},{text:"עוגה",category:"food"},
    {text:"שולחן",category:"objects"},{text:"כיסא",category:"objects"},{text:"מנורה",category:"objects"},{text:"ספר",category:"objects"},{text:"עט",category:"objects"},{text:"תיק",category:"objects"},{text:"שעון",category:"objects"},{text:"משקפיים",category:"objects"},{text:"מפתח",category:"objects"},{text:"כוס",category:"objects"},
    {text:"כדורגל",category:"sports"},{text:"כדורסל",category:"sports"},{text:"טניס",category:"sports"},{text:"שחייה",category:"sports"},{text:"ריצה",category:"sports"},{text:"אופניים",category:"sports"},{text:"ג'ודו",category:"sports"},{text:"כדורעף",category:"sports"},{text:"בייסבול",category:"sports"},{text:"גלישה",category:"sports"},
    {text:"רופא",category:"professions"},{text:"מורה",category:"professions"},{text:"שוטר",category:"professions"},{text:"כבאים",category:"professions"},{text:"טבח",category:"professions"},{text:"נהג",category:"professions"},{text:"זמר",category:"professions"},{text:"שחקן",category:"professions"},{text:"צייר",category:"professions"},{text:"מתכנת",category:"professions"},
    {text:"מחשב",category:"technology"},{text:"טלפון",category:"technology"},{text:"טאבלט",category:"technology"},{text:"אינטרנט",category:"technology"},{text:"רובוט",category:"technology"},{text:"חללית",category:"technology"},{text:"לוויין",category:"technology"},{text:"מקלדת",category:"technology"},{text:"עכבר",category:"technology"},{text:"מסך",category:"technology"},
    {text:"עץ",category:"nature"},{text:"פרח",category:"nature"},{text:"ים",category:"nature"},{text:"הר",category:"nature"},{text:"נהר",category:"nature"},{text:"שמש",category:"nature"},{text:"ירח",category:"nature"},{text:"כוכב",category:"nature"},{text:"ענן",category:"nature"},{text:"גשם",category:"nature"},
    {text:"סלון",category:"home"},{text:"מטבח",category:"home"},{text:"אמבטיה",category:"home"},{text:"חדר שינה",category:"home"},{text:"מרפסת",category:"home"},{text:"גינה",category:"home"},{text:"גג",category:"home"},{text:"דלת",category:"home"},{text:"חלון",category:"home"},{text:"מיטה",category:"home"},
    {text:"חולצה",category:"clothing"},{text:"מכנסיים",category:"clothing"},{text:"שמלה",category:"clothing"},{text:"חצאית",category:"clothing"},{text:"נעליים",category:"clothing"},{text:"גרביים",category:"clothing"},{text:"כובע",category:"clothing"},{text:"מעיל",category:"clothing"},{text:"צעיף",category:"clothing"},{text:"כפפות",category:"clothing"},
    {text:"שמחה",category:"emotions"},{text:"עצב",category:"emotions"},{text:"כעס",category:"emotions"},{text:"פחד",category:"emotions"},{text:"הפתעה",category:"emotions"},{text:"אהבה",category:"emotions"},{text:"שנאה",category:"emotions"},{text:"קנאה",category:"emotions"},{text:"גאווה",category:"emotions"},{text:"בושה",category:"emotions"},
    {text:"מכונית",category:"transport"},{text:"אוטובוס",category:"transport"},{text:"רכבת",category:"transport"},{text:"מטוס",category:"transport"},{text:"אונייה",category:"transport"},{text:"אופנוע",category:"transport"},{text:"משאית",category:"transport"},{text:"מונית",category:"transport"},{text:"קלנועית",category:"transport"},{text:"מסוק",category:"transport"},
    {text:"גיטרה",category:"instruments"},{text:"פסנתר",category:"instruments"},{text:"תוף",category:"instruments"},{text:"כינור",category:"instruments"},{text:"חליל",category:"instruments"},{text:"חצוצרה",category:"instruments"},{text:"סקסופון",category:"instruments"},{text:"אקורדיון",category:"instruments"},{text:"מפוחית",category:"instruments"},{text:"דרבוקה",category:"instruments"},
    {text:"ישראל",category:"countries"},{text:"ארה״ב",category:"countries"},{text:"צרפת",category:"countries"},{text:"איטליה",category:"countries"},{text:"ספרד",category:"countries"},{text:"יפן",category:"countries"},{text:"סין",category:"countries"},{text:"רוסיה",category:"countries"},{text:"מצרים",category:"countries"},{text:"יוון",category:"countries"},
    {text:"אדום",category:"colors"},{text:"כחול",category:"colors"},{text:"ירוק",category:"colors"},{text:"צהוב",category:"colors"},{text:"כתום",category:"colors"},{text:"סגול",category:"colors"},{text:"ורוד",category:"colors"},{text:"חום",category:"colors"},{text:"שחור",category:"colors"},{text:"לבן",category:"colors"},
    {text:"לרוץ",category:"verbs"},{text:"לקפוץ",category:"verbs"},{text:"לשיר",category:"verbs"},{text:"לרקוד",category:"verbs"},{text:"לאכול",category:"verbs"},{text:"לשתות",category:"verbs"},{text:"לישון",category:"verbs"},{text:"לחשוב",category:"verbs"},{text:"לדבר",category:"verbs"},{text:"לכתוב",category:"verbs"}
];

function getRandomWord(game) {
  if (game.customWordsList && game.customWordsList.length > 0) {
      const wordText = game.customWordsList.shift();
      return { text: wordText, category: 'מותאם אישית', isCustom: true };
  }
  let pool = [];
  const categories = game.categories || [];
  if (Array.isArray(categories) && categories.length > 0 && !categories.includes('all')) {
    const catSet = new Set(categories);
    const filtered = WORD_BANK.filter((w) => catSet.has(w.category));
    pool = pool.concat(filtered);
  } else {
    pool = pool.concat(WORD_BANK);
  }
  if (pool.length === 0) return { text: "אין מילים", category: "כללי" };
  const idx = Math.floor(Math.random() * pool.length);
  return { ...pool[idx], isCustom: false };
}

function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) { code += chars[Math.floor(Math.random() * chars.length)]; }
  return code;
}

function sanitizeGame(game) {
  if (!game) return null;
  const teams = {};
  Object.entries(game.teams || {}).forEach(([teamId, t]) => {
    teams[teamId] = { id: t.id || teamId, name: t.name, score: t.score || 0, players: Array.isArray(t.players) ? [...t.players] : [] };
  });
  const playersByClientId = {};
  Object.entries(game.playersByClientId || {}).forEach(([cid, p]) => {
    playersByClientId[cid] = { clientId: cid, name: p.name, teamId: p.teamId, isHost: p.isHost || false, joinedAt: p.joinedAt };
  });
  return {
    code: game.code, hostName: game.hostName,
    gameTitle: game.gameTitle || null,
    targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds, categories: game.categories || [],
    createdAt: game.createdAt, updatedAt: game.updatedAt, lastActivity: game.lastActivity,
    logoUrl: game.logoUrl || null, banners: game.banners || {},
    branding: game.branding || null,
    teams, playersByClientId, currentRound: game.currentRound || null,
  };
}

function broadcastGame(game) {
  if (!game || !game.code) return;
  io.to("game-" + game.code).emit("gameUpdated", sanitizeGame(game));
}

function clearRoundTimer(gameCode) {
  if (roundTimers[gameCode]) { clearInterval(roundTimers[gameCode]); delete roundTimers[gameCode]; }
}

function startTimerInterval(code) {
    clearRoundTimer(code);
    roundTimers[code] = setInterval(() => {
        const g = games[code];
        if (!g || !g.currentRound || !g.currentRound.active) { clearRoundTimer(code); return; }
        g.currentRound.secondsLeft--;
        if (g.currentRound.secondsLeft <= 0) {
            g.currentRound.secondsLeft = 0;
            finishRound(code, { reason: "timer" });
        } else {
            io.to("game-" + code).emit("roundTick", { gameCode: code, secondsLeft: g.currentRound.secondsLeft });
        }
    }, 1000);
}

setInterval(() => {
    const now = Date.now();
    Object.keys(games).forEach(code => {
        const game = games[code];
        if (now - new Date(game.lastActivity).getTime() > INACTIVITY_LIMIT) {
            clearRoundTimer(code);
            delete games[code];
            deleteGameState(code);
        }
    });
}, CLEANUP_INTERVAL);

async function finishRound(gameCode, options = { reason: "manual" }) {
  const code = (gameCode || "").toUpperCase().trim();
  const game = games[code];
  if (!game || !game.currentRound) return;

  const round = game.currentRound;
  round.active = false; round.isActive = false;
  clearRoundTimer(code);

  const teamId = round.teamId;
  const roundScore = typeof round.roundScore === "number" && round.roundScore > 0 ? round.roundScore : 0;

  if (teamId && game.teams[teamId]) {
    game.teams[teamId].score = (game.teams[teamId].score || 0) + roundScore;
  }

  game.lastActivity = new Date();
  game.updatedAt = new Date();

  if (dbReady && pool && teamId && game.teams[teamId]) {
    try {
      await pool.query(`UPDATE game_teams SET score = $1 WHERE game_code = $2 AND team_id = $3`, 
      [game.teams[teamId].score, code, teamId]);
    } catch (err) {}
  }

  const totalScore = teamId && game.teams[teamId] ? game.teams[teamId].score : 0;
  saveGameState(game);
  broadcastGame(game);
  io.to("game-" + code).emit("forceRefreshPlayers");
  io.to("game-" + code).emit("roundFinished", { teamId, roundScore, totalScore, reason: options.reason || "manual" });

  if (options.reason === "timer") {
    const teamName = teamId && game.teams[teamId] ? game.teams[teamId].name : `קבוצה ${teamId || ""}`;
    io.to("game-" + code).emit("roundTimeUp", { code, roundScore, teamId, teamName, totalScore: totalScore || 0 });
  }
  game.currentRound = null;
}

io.on("connection", (socket) => {
  socket.on("createGame", async (data, callback) => {
    try {
      const { hostName, gameTitle="", targetScore=40, defaultRoundSeconds=60, categories=[], teamNames={}, branding=null, customWords="" } = data || {};
      if (!hostName) return safeCb(callback, { ok: false, error: "Missing host name" });

      let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (clientIp && clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

      let code;
      do { code = generateGameCode(); } while (games[code]);

      const teams = {};
      const now = new Date();
      
      ["A", "B", "C", "D", "E"].forEach((id) => {
        const name = (teamNames[id] || "").trim();
        if (name) teams[id] = { id, name, score: 0, players: [] };
      });
      
      if (Object.keys(teams).length === 0) {
        teams["A"] = { id: "A", name: "קבוצה A", score: 0, players: [] };
        teams["B"] = { id: "B", name: "קבוצה B", score: 0, players: [] };
      }

      let customWordsList = [];
      if (customWords && typeof customWords === 'string') {
          customWordsList = customWords.split(',').map(w => w.trim()).filter(w => w.length > 0);
      }

      const game = {
        code, hostSocketId: socket.id, hostName,
        gameTitle: gameTitle.trim(),
        targetScore, defaultRoundSeconds, categories,
        createdAt: now, updatedAt: now, lastActivity: now, 
        logoUrl: null, banners: {}, branding, 
        teams, playersByClientId: {}, currentRound: null,
        customWordsList
      };

      games[code] = game;
      socket.join("game-" + code);

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO games (code, host_name, target_score, default_round_seconds, categories, host_ip, game_title) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [code, hostName, targetScore, defaultRoundSeconds, categories, clientIp, game.gameTitle]);
          
          if(branding) {
             try { await pool.query(`UPDATE games SET branding = $1 WHERE code = $2`, [JSON.stringify(branding), code]); } catch(e){}
          }

          for (const t of Object.values(teams)) {
            await pool.query(`INSERT INTO game_teams (game_code, team_id, team_name, score) VALUES ($1, $2, $3, $4)`,
              [code, t.id, t.name, 0]);
          }
        } catch (e) { console.error("DB Create Error:", e); }
      }

      saveGameState(game);
      sendNewGameEmail(game);
      safeCb(callback, { ok: true, gameCode: code, game: sanitizeGame(game) });

    } catch (err) {
      console.error("CreateGame Error:", err);
      safeCb(callback, { ok: false, error: "Server Error" });
    }
  });

  socket.on("joinGame", async (data, callback) => {
    try {
      const { gameCode, name, teamId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      let game = games[code];

      if (!game) return safeCb(callback, { ok: false, error: "המשחק לא נמצא." });

      const playerName = (name || "").trim();
      if (!playerName) return safeCb(callback, { ok: false, error: "שם חסר." });

      let chosenTeamId = teamId;
      if (!chosenTeamId && data.teamName) {
         const entry = Object.entries(game.teams).find(([k,v]) => v.name === data.teamName);
         if(entry) chosenTeamId = entry[0];
      }
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
         const keys = Object.keys(game.teams);
         if(keys.length) chosenTeamId = keys[0];
         else return safeCb(callback, {ok:false, error:"No teams"});
      }

      const clientId = socket.id;
      let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (clientIp && clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
      const now = new Date();

      game.playersByClientId[clientId] = { clientId, name: playerName, teamId: chosenTeamId, isHost: false, ip: clientIp, joinedAt: now };
      if(!game.teams[chosenTeamId].players.includes(clientId)) {
          game.teams[chosenTeamId].players.push(clientId);
      }

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO game_players (game_code, client_id, name, team_id, ip_address, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
            [code, clientId, playerName, chosenTeamId, clientIp, now]);
        } catch (e) {}
      }

      game.lastActivity = now;
      saveGameState(game);

      socket.join("game-" + code);
      safeCb(callback, { ok: true, game: sanitizeGame(game), clientId, teamId: chosenTeamId, teamName: game.teams[chosenTeamId].name, isHost: false });
      broadcastGame(game);

    } catch (err) {
      console.error("JoinGame Error:", err);
      safeCb(callback, { ok: false, error: "Join Error" });
    }
  });

  socket.on("hostReconnect", (data, callback) => {
      const code = (data?.gameCode || "").toUpperCase().trim();
      const game = games[code];
      
      if(!game) return safeCb(callback, {ok:false, error:"Not found"});
      
      if(game.hostName) game.hostSocketId = socket.id;
      socket.join("game-" + code);
      safeCb(callback, { ok: true, game: sanitizeGame(game) });
  });

  socket.on("getGameState", (data, callback) => {
      const code = (data?.gameCode || "").toUpperCase().trim();
      if(games[code]) safeCb(callback, { ok: true, game: sanitizeGame(games[code]) });
      else safeCb(callback, { ok: false });
  });

  socket.on("startRound", async (data, callback) => {
      const game = games[data.gameCode];
      if(!game) return safeCb(callback, {ok:false, error: "Game not found"});
      
      clearRoundTimer(data.gameCode);
      const team = game.teams[data.teamId];
      if(!team) return safeCb(callback, {ok:false, error: "Invalid team"});

      let explainer = null;
      const pIds = team.players;
      if(data.explainerClientId && pIds.includes(data.explainerClientId)) explainer = data.explainerClientId;
      if(!explainer && pIds.length > 0) explainer = pIds[Math.floor(Math.random() * pIds.length)];
      
      if(!explainer) return safeCb(callback, {ok:false, error: "אין שחקנים בקבוצה זו! אי אפשר להתחיל."});

      const pObj = game.playersByClientId[explainer];
      const now = new Date();
      
      game.currentRound = {
          teamId: data.teamId,
          explainerId: explainer,
          explainerName: pObj ? pObj.name : "Unknown",
          secondsLeft: parseInt(data.roundSeconds) || 60,
          active: true, isActive: true, roundScore: 0, startedAt: now.toISOString()
      };
      
      game.lastActivity = now;
      saveGameState(game);

      broadcastGame(game);
      io.to("game-" + game.code).emit("roundStarted", { game: sanitizeGame(game) });

      startTimerInterval(game.code);
      safeCb(callback, {ok:true});
  });

  socket.on("changeRoundScore", (data, cb) => {
      const game = games[data.gameCode];
      if(game && game.currentRound && game.currentRound.active) {
          const d = parseInt(data.delta) || 0;
          game.currentRound.roundScore = Math.max(0, (game.currentRound.roundScore || 0) + d);
          game.lastActivity = new Date();
          saveGameState(game);
          
          safeCb(cb, {ok:true});
          
          io.to("game-" + game.code).emit("roundScoreUpdated", {
              gameCode: game.code,
              roundScore: game.currentRound.roundScore,
              teamId: game.currentRound.teamId
          });
          
      } else {
          safeCb(cb, {ok:false, error: "Round not active"});
      }
  });

  socket.on("getNextWord", (data, cb) => {
      const game = games[data.gameCode];
      if(game && game.currentRound) {
          const w = getRandomWord(game);
          if (w.isCustom) {
              saveGameState(game);
          }
          safeCb(cb, {ok:true, word: w.text, category: w.category});
      }
  });

  socket.on("endRound", (data, cb) => {
      finishRound(data.gameCode, {reason:"manual"});
      safeCb(cb, {ok:true});
  });

  socket.on("endGame", (data, cb) => {
      const code = data.gameCode;
      if(games[code]) {
          clearRoundTimer(code);
          delete games[code];
          deleteGameState(code);
          io.to("game-" + code).emit("gameEnded", { code });
          safeCb(cb, {ok:true});
      }
  });

  socket.on("removePlayer", (data, cb) => {
      const game = games[data.gameCode];
      if(!game) return safeCb(cb, {ok:false});
      
      const pid = data.clientId;
      const p = game.playersByClientId[pid];
      if(p) {
          delete game.playersByClientId[pid];
          if(game.teams[p.teamId]) {
              game.teams[p.teamId].players = game.teams[p.teamId].players.filter(id=>id!==pid);
          }
          saveGameState(game);
          
          io.to(pid).emit("playerRemoved");

          if(game.currentRound && game.currentRound.explainerId === pid) {
              finishRound(game.code, {reason:"player_disconnected"});
          } else {
              broadcastGame(game);
          }
      }
      safeCb(cb, {ok:true});
  });

  socket.on("disconnect", () => {
      const pid = socket.id;
      Object.values(games).forEach(g => {
          if(g.hostSocketId === pid) return; 
          if(g.playersByClientId[pid]) {
              const p = g.playersByClientId[pid];
              delete g.playersByClientId[pid];
              if(g.teams[p.teamId]) {
                  g.teams[p.teamId].players = g.teams[p.teamId].players.filter(id=>id!==pid);
              }
              
              saveGameState(g);

              if(g.currentRound && g.currentRound.explainerId === pid) {
                  finishRound(g.code, {reason:"player_disconnected"});
              } else {
                  broadcastGame(g);
              }
          }
      });
  });
});

// =========================================
//  Admin API Routes (מעודכנים)
// =========================================

// סטטיסטיקות זמן אמת
app.get("/admin/stats", async (req, res) => {
  const code = req.query.code || "";
  if (code !== ADMIN_CODE) return res.status(403).json({ error: "Forbidden" });

  let dbStats = { totalUniqueIps: 0 };
  if (dbReady && pool) {
    try {
      const ipRes = await pool.query(`SELECT COUNT(DISTINCT ip_address) as count FROM game_players`);
      dbStats.totalUniqueIps = ipRes.rows[0].count;
    } catch (e) { console.error("Stats DB Error", e); }
  }

  const activeGames = Object.values(games).map(g => ({
    code: g.code,
    hostName: g.hostName,
    gameTitle: g.gameTitle || "ללא שם",
    playerCount: Object.keys(g.playersByClientId).length,
    teamCount: Object.keys(g.teams).length,
    createdAt: g.createdAt,
    hostIp: g.hostIp,
    teams: g.teams,
    players: Object.values(g.playersByClientId).map(p => ({ name: p.name, ip: p.ip, joinedAt: p.joinedAt })),
    isActive: true
  }));

  res.json({ 
      stats: { 
          activeGamesCount: activeGames.length,
          connectedSockets: io.engine.clientsCount,
          uniqueIps: dbStats.totalUniqueIps
      },
      activeGames: activeGames
  });
});


// --- ה-ENDPOINT החדש להיסטוריה (תומך בפיצול חדרים/שחקנים וסיכומים) ---
app.get("/admin/history", async (req, res) => {
    const { code, startDate, endDate, search, scope } = req.query;

    if (code !== ADMIN_CODE) return res.status(403).json({ error: "Unauthorized" });
    if (!dbReady || !pool) return res.status(503).json({ error: "DB not ready" });
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const queryParams = [start.toISOString(), end.toISOString()];
    let searchClause = "";

    if (search && search.trim() !== '') {
        queryParams.push(`%${search.trim().toLowerCase()}%`);
        searchClause = `AND (LOWER(name_field) LIKE $3 OR ip_field LIKE $3 ${scope === 'rooms' ? 'OR LOWER(code_field) LIKE $3' : ''})`;
    }

    try {
        let results = [];
        let count = 0;

        if (scope === 'rooms') {
            // שליפת חדרים
            let query = `
                SELECT g.code, g.host_name, g.host_ip, g.game_title, g.created_at,
                       (SELECT COUNT(*) FROM game_players WHERE game_code = g.code) as total_players,
                       (SELECT COUNT(*) FROM game_teams WHERE game_code = g.code) as total_teams
                FROM games g
                WHERE g.created_at >= $1 AND g.created_at <= $2
            `;
            if (searchClause) {
                query = query.replace('name_field', 'g.host_name').replace('ip_field', 'g.host_ip').replace('code_field', 'g.code') + searchClause;
            }
            query += ` ORDER BY g.created_at DESC`;
            
            const result = await pool.query(query, queryParams);
            count = result.rowCount;

            // העשרת הנתונים (קבוצות ושחקנים)
            results = await Promise.all(result.rows.map(async (gameRow) => {
                const teamsRes = await pool.query(`SELECT * FROM game_teams WHERE game_code = $1`, [gameRow.code]);
                const teamsMap = {};
                teamsRes.rows.forEach(t => teamsMap[t.team_id] = { ...t, players: [] });
                const playersRes = await pool.query(`SELECT * FROM game_players WHERE game_code = $1`, [gameRow.code]);
                playersRes.rows.forEach(p => {
                    if (teamsMap[p.team_id]) teamsMap[p.team_id].players.push({ name: p.name, ip: p.ip_address });
                });
                return {
                    ...gameRow,
                    hostName: gameRow.host_name, hostIp: gameRow.host_ip, gameTitle: gameRow.game_title, createdAt: gameRow.created_at,
                    totalPlayers: parseInt(gameRow.total_players), totalTeams: parseInt(gameRow.total_teams),
                    teams: teamsMap, isActive: false
                };
            }));

        } else {
            // שליפת שחקנים
            let query = `
                SELECT gp.*, g.game_title 
                FROM game_players gp
                LEFT JOIN games g ON gp.game_code = g.code
                WHERE gp.created_at >= $1 AND gp.created_at <= $2
            `;
            if (searchClause) {
                query = query.replace('name_field', 'gp.name').replace('ip_field', 'gp.ip_address') + searchClause;
            }
            query += ` ORDER BY gp.created_at DESC`;

            const result = await pool.query(query, queryParams);
            count = result.rowCount;
            results = result.rows;
        }

        res.json({ summary: { count, scope }, results });

    } catch (e) {
        console.error("Error fetching history from DB:", e);
        res.status(500).json({ error: "DB search error" });
    }
});


// --- API לבאנרים (עליון ותחתון - מעודכן למובייל) ---
app.get("/api/banners", async (req, res) => {
    let banners = {};
    if (dbReady && pool) {
        try {
            const result = await pool.query("SELECT top_banner_img, top_banner_link, bottom_banner_img, bottom_banner_link, top_banner_img_mobile, bottom_banner_img_mobile FROM site_settings WHERE id = 1");
            if (result.rows.length > 0) {
                const row = result.rows[0];
                banners.topBanner = { img: row.top_banner_img, imgMobile: row.top_banner_img_mobile, link: row.top_banner_link };
                banners.bottomBanner = { img: row.bottom_banner_img, imgMobile: row.bottom_banner_img_mobile, link: row.bottom_banner_link };
            }
        } catch (e) { console.error("Error fetching banners:", e); }
    }
    res.json(banners);
});

// --- API לשמירת הגדרות באנרים (מעודכן למובייל) ---
app.post("/api/banners", async (req, res) => {
    const { topBanner, bottomBanner } = req.body;
    
    if (dbReady && pool) {
        try {
            await pool.query(
                `UPDATE site_settings SET 
                    top_banner_img = $1, top_banner_link = $2, top_banner_img_mobile = $5,
                    bottom_banner_img = $3, bottom_banner_link = $4, bottom_banner_img_mobile = $6
                 WHERE id = 1`,
                [
                    topBanner?.img || null, topBanner?.link || null, 
                    bottomBanner?.img || null, bottomBanner?.link || null,
                    topBanner?.imgMobile || null, bottomBanner?.imgMobile || null
                ]
            );
            res.json({ ok: true });
        } catch (e) { 
            console.error("Error saving banner settings:", e);
            res.status(500).json({ ok: false, error: "DB Error" });
        }
    } else {
        res.status(503).json({ ok: false, error: "No DB" });
    }
});

// --- API לסגירת חדר (פנימי) ---
app.post("/admin/game/:gameCode/close", (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).send();
    const code = req.params.gameCode;
    if(games[code]) {
        clearRoundTimer(code);
        delete games[code];
        deleteGameState(code);
        io.to("game-" + code).emit("adminClosedGame", { code });
        res.json({ok:true});
    } else {
        // גם אם לא בזיכרון, ננסה למחוק מה-DB של המצבים הפעילים
        deleteGameState(code);
        res.json({ok:true, message: "Room force closed from DB state"});
    }
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
