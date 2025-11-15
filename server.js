const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// מגישים את קבצי ה-HTML / JS / CSS מתוך public
app.use(express.static(path.join(__dirname, "public")));

// מצב המשחקים בזיכרון (לא בבסיס נתונים)
const games = {};

// מאגרי מילים לפי חבילות
const wordPacks = {
  family: [
    "כלב","חתול","אמא","אבא","אח","אחות","גן","בית ספר","מחברת","עיפרון",
    "כדור","נדנדה","גלידה","עוגה","פיצה","מים","חולצה","מכנסיים","נעליים",
    "חדר","מיטה","שמיכה","צעצוע","בובה","בלון","סוכריה","קניון","סבא",
    "סבתא","ים","בריכה","מעלית","מדרגות","חנות צעצועים","טלוויזיה","מסעדה",
    "חג","מתנה","יום הולדת"
  ],
  classic: [
    "מטוס","מחשב","טלפון","עיתון","מגדל","חשמל","ספרייה","תאטרון","רופא",
    "נהג מונית","אינטרנט","מקרר","חלון","חברה","משפחה","מכונית","תחנת דלק",
    "גשר","משטרה","חייל","אוטובוס","רמזור","כביש","פקק תנועה","משרד","שכן",
    "גינה ציבורית","קפה","כיסא","שולחן","חניה","קופה רושמת","מרפאה","ספר",
    "חנות נעליים","חנות בגדים","שלט חוצות","תחנת אוטובוס"
  ],
  hard: [
    "דמוקרטיה","חופש","אחריות","לחץ","השראה","יצירתיות","חברות","סבלנות",
    "שאפתנות","בדידות","פחד","אומץ","אמון","תסכול","ויתור","ניצחון","תחרות",
    "אסטרטגיה","דמיון","עתיד","עבר","הווה","משבר","הצלחה","כישלון","שגרה",
    "הפתעה","זיכרון","חלום","ציפיות"
  ]
};

const TEAM_LETTERS = ["A","B","C","D","E"];

// מחזיר רשימת מילים לפי חבילה (או הכל)
function getWordList(packKey) {
  if (packKey && wordPacks[packKey]) {
    return wordPacks[packKey].slice();
  }
  // "all" או לא הוגדר -> מחברים את הכל
  const set = new Set();
  Object.values(wordPacks).forEach(list => {
    list.forEach(w => set.add(w));
  });
  return Array.from(set);
}

// מייצר קוד משחק קצר, למשל AB4F
function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// בוחר מילה רנדומלית שלא חזרה על עצמה יותר מדי
function pickRandomWord(game) {
  if (!game.wordList || game.wordList.length === 0) {
    game.wordList = getWordList(game.wordPack);
    game.usedIndices = new Set();
  }

  if (game.usedIndices.size >= game.wordList.length) {
    // התחלה מחודשת של רשימת המילים
    game.usedIndices = new Set();
  }

  let idx;
  let tries = 0;
  do {
    idx = Math.floor(Math.random() * game.wordList.length);
    tries++;
    if (tries > 200) break;
  } while (game.usedIndices.has(idx));

  game.usedIndices.add(idx);
  return game.wordList[idx];
}

// מה אנחנו מחזירים לפרונט (בלי כל הפרטים הפנימיים)
function getPublicGameSummary(game) {
  return {
    code: game.code,
    targetScore: game.targetScore,
    wordPack: game.wordPack,
    teams: game.teams,
    players: Object.values(game.players).map(p => ({
      id: p.clientId,
      name: p.name,
      teamId: p.teamId,
      isHost: !!p.isHost,
      isConnected: !!p.isConnected
    })),
    state: game.state
  };
}

// בונה אובייקט ניקוד {A: מספר, B: מספר, ...}
function buildScoresObject(game) {
  const scores = {};
  for (const [id, team] of Object.entries(game.teams)) {
    scores[id] = team.score;
  }
  return scores;
}

io.on("connection", socket => {
  console.log("לקוח התחבר:", socket.id);

  // יצירת משחק (על ידי המנהל)
  socket.on("createGame", (data, cb) => {
    let code;
    do {
      code = generateGameCode();
    } while (games[code]);

    const targetScore = Number(data.targetScore) || 30;
    const wordPack = data.wordPack || "classic";

    let teamCount = Number(data.teamCount) || 2;
    if (teamCount < 2) teamCount = 2;
    if (teamCount > 5) teamCount = 5;

    const teamNames = data.teamNames || {};
    const teams = {};

    for (let i = 0; i < teamCount; i++) {
      const id = TEAM_LETTERS[i];
      const fallbackName = "קבוצה " + (i + 1);
      const nameFromClient = teamNames[id];
      teams[id] = {
        id,
        name: nameFromClient && nameFromClient.trim()
          ? nameFromClient.trim()
          : fallbackName,
        score: 0
      };
    }

    const hostClientId = (data && data.clientId) ? String(data.clientId) : socket.id;

    const game = {
      code,
      hostId: socket.id, // מזהה socket של המנהל
      wordPack,
      targetScore,
      teams,
      players: {},
      state: {
        phase: "lobby", // lobby | playing
        currentTeamId: null,
        explainerId: null, // כאן נשמור socketId של המסביר הפעיל
        currentWord: null
      },
      wordList: getWordList(wordPack),
      usedIndices: new Set()
    };

    game.players[hostClientId] = {
      clientId: hostClientId,
      socketId: socket.id,
      name: data.hostName || "מנהל",
      teamId: TEAM_LETTERS[0], // ברירת מחדל: הקבוצה הראשונה
      isHost: true,
      isConnected: true
    };

    games[code] = game;
    socket.join(code);

    const summary = getPublicGameSummary(game);
    cb && cb({ ok: true, gameCode: code, game: summary, clientId: hostClientId });
    io.to(code).emit("gameUpdated", summary);

    console.log("נוצר משחק חדש:", code);
  });

  // שחקן מצטרף למשחק / מתחבר מחדש
  socket.on("joinGame", (data, cb) => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const name = (data.playerName || "").trim();
    const game = games[code];

    if (!game) {
      cb && cb({ ok: false, error: "המשחק לא נמצא" });
      return;
    }
    if (!name) {
      cb && cb({ ok: false, error: "חייבים שם שחקן" });
      return;
    }

    const requestedTeamId = (data.teamId || "").toUpperCase();
    const teamId = game.teams[requestedTeamId]
      ? requestedTeamId
      : Object.keys(game.teams)[0];

    let rawClientId = (data.clientId || "").trim();
    if (!rawClientId) {
      rawClientId = "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    let player = game.players[rawClientId];
    if (player) {
      // חיבור מחדש לאותו שחקן
      player.socketId = socket.id;
      player.name = name;
      player.teamId = teamId;
      player.isConnected = true;
    } else {
      // שחקן חדש
      player = {
        clientId: rawClientId,
        socketId: socket.id,
        name,
        teamId,
        isHost: false,
        isConnected: true
      };
      game.players[rawClientId] = player;
    }

    socket.join(code);

    const summary = getPublicGameSummary(game);
    cb && cb({ ok: true, gameCode: code, game: summary, clientId: rawClientId });
    io.to(code).emit("gameUpdated", summary);

    console.log(`שחקן ${name} הצטרף למשחק ${code} לקבוצה ${teamId}`);
  });

  // התחלת סיבוב (רק המנהל)
  socket.on("startRound", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (socket.id !== game.hostId) return;

    const requestedTeamId = (data.teamId || "").toUpperCase();
    const teamId = game.teams[requestedTeamId]
      ? requestedTeamId
      : Object.keys(game.teams)[0];

    let explainerClientId = data.explainerId;
    let explainerPlayer = explainerClientId ? game.players[explainerClientId] : null;
    const roundTime = Number(data.roundTime) || 60;

    // אם לא נבחר מסביר תקין – נבחר אוטומטית שחקן מהקבוצה (מחוברים, מעדיפים לא-מנהל)
    if (!explainerPlayer || explainerPlayer.teamId !== teamId || !explainerPlayer.isConnected) {
      const allCandidates = Object.values(game.players).filter(
        p => p.teamId === teamId && p.isConnected
      );
      const nonHostCandidates = allCandidates.filter(p => !p.isHost);

      const chosenList = nonHostCandidates.length ? nonHostCandidates : allCandidates;
      if (chosenList.length === 0) {
        console.log("אין שחקנים מחוברים בקבוצה", teamId, "למשחק", code);
        return;
      }
      explainerPlayer = chosenList[0];
    }

    if (!explainerPlayer || !explainerPlayer.socketId) {
      console.log("לא נמצא socketId למסביר במשחק", code);
      return;
    }

    game.state.phase = "playing";
    game.state.currentTeamId = teamId;
    game.state.explainerId = explainerPlayer.socketId; // שומרים socketId
    game.state.currentWord = pickRandomWord(game);

    const payload = {
      teamId,
      explainerId: explainerPlayer.socketId,
      roundTime,
      scores: buildScoresObject(game),
      targetScore: game.targetScore,
      teams: game.teams
    };

    io.to(code).emit("roundStarted", payload);
    io.to(explainerPlayer.socketId).emit("wordForExplainer", {
      word: game.state.currentWord
    });

    console.log(`סיבוב התחיל במשחק ${code}, קבוצה ${teamId}, מסביר clientId=${explainerPlayer.clientId}`);
  });

  // המסביר לוחץ "נכון"
  socket.on("markCorrect", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (game.state.phase !== "playing") return;
    if (socket.id !== game.state.explainerId) return;

    const teamId = game.state.currentTeamId;
    if (!teamId || !game.teams[teamId]) return;

    game.teams[teamId].score += 1;
    game.state.currentWord = pickRandomWord(game);

    io.to(code).emit("scoreUpdated", {
      scores: buildScoresObject(game),
      targetScore: game.targetScore,
      teams: game.teams
    });

    io.to(game.state.explainerId).emit("wordForExplainer", {
      word: game.state.currentWord
    });
  });

  // המסביר לוחץ "דילוג"
  socket.on("skipWord", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (game.state.phase !== "playing") return;
    if (socket.id !== game.state.explainerId) return;

    game.state.currentWord = pickRandomWord(game);
    io.to(game.state.explainerId).emit("wordForExplainer", {
      word: game.state.currentWord
    });
  });

  // סיום סיבוב (רק המנהל)
  socket.on("endRound", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (socket.id !== game.hostId) return;

    const teamId = game.state.currentTeamId;

    game.state.phase = "lobby";
    game.state.currentTeamId = null;
    game.state.explainerId = null;
    game.state.currentWord = null;

    io.to(code).emit("roundEnded", {
      scores: buildScoresObject(game),
      teamId,
      teams: game.teams
    });
  });

  // סיום משחק (רק המנהל)
  socket.on("endGame", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (socket.id !== game.hostId) return;

    let maxScore = -Infinity;
    for (const t of Object.values(game.teams)) {
      if (t.score > maxScore) maxScore = t.score;
    }
    const winners = Object.values(game.teams).filter(t => t.score === maxScore);

    const payload = {
      scores: buildScoresObject(game),
      teams: game.teams,
      winnerTeamIds: winners.map(t => t.id)
    };

    io.to(code).emit("gameEnded", payload);
    delete games[code];

    console.log("משחק הסתיים ונמחק:", code);
  });

  // ניתוק שחקן
  socket.on("disconnect", () => {
    console.log("לקוח התנתק:", socket.id);
    for (const code of Object.keys(games)) {
      const game = games[code];

      let foundPlayer = null;
      for (const p of Object.values(game.players)) {
        if (p.socketId === socket.id) {
          foundPlayer = p;
          break;
        }
      }
      if (!foundPlayer) continue;

      const wasHost = socket.id === game.hostId;

      // לא מוחקים את השחקן – רק מסמנים כמנותק
      foundPlayer.isConnected = false;
      foundPlayer.socketId = null;

      // אם אין אף שחקן מחובר – מוחקים את המשחק
      const anyConnected = Object.values(game.players).some(p => p.isConnected);
      if (!anyConnected) {
        delete games[code];
        console.log("משחק נמחק כי אין שחקנים מחוברים:", code);
        continue;
      }

      // אם המנהל התנתק – מעבירים מנהל למישהו אחר שמחובר
      if (wasHost) {
        const candidates = Object.values(game.players).filter(p => p.isConnected);
        if (candidates.length) {
          game.hostId = candidates[0].socketId;
          candidates[0].isHost = true;
        }
      }

      const summary = getPublicGameSummary(game);
      io.to(code).emit("gameUpdated", summary);
    }
  });
});

server.listen(PORT, () => {
  console.log("שרת כהנ'ס רץ על פורט", PORT);
  console.log("פתח דפדפן על http://localhost:" + PORT + "/");
});
