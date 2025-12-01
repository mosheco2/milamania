const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
// --- שינוי 1: ייבוא ספריית פוסטגרס ---
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = "ONEBTN";

// --- שינוי 2: הגדרת חיבור לבסיס הנתונים ---
// מומלץ ב-Render להשתמש במשתנה סביבה DATABASE_URL, אך שמתי את ה-Internal URL שסיפקת כברירת מחדל.
const connectionString = process.env.DATABASE_URL || 'postgresql://cohens_db_user:8L7xFSkbfYyh3y6NfyMkiND1CqNE7FRN@dpg-d4fb40v5r7bs73cjo860-a/cohens_db';

// יצירת מאגר חיבורים (Pool)
const pool = new Pool({
    connectionString: connectionString,
    // ב-Render חובה להשתמש ב-SSL בחיבור חיצוני, ולעיתים גם בפנימי.
    // ההגדרה הזו מאפשרת חיבור גם אם תעודת ה-SSL לא מאומתת (סטנדרטי ב-Render).
    ssl: { rejectUnauthorized: false }
});

// בדיקת חיבור ראשונית
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Error acquiring client', err.stack);
    } else {
        console.log('✅ Connected to PostgreSQL database successfully!');
        release();
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ניהול מצב (State) בזיכרון (רק למשחקים פעילים) ---
const games = {};

// --- שינוי 3: יצירת טבלאות בסיס נתונים אם לא קיימות ---
async function initDB() {
    try {
        // טבלת באנרים - שורה אחת שתחזיק את כל ה-JSON
        await pool.query(`
            CREATE TABLE IF NOT EXISTS banners (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL
            );
        `);
        // וידוא שיש שורה ראשונית (ID=1)
        await pool.query(`INSERT INTO banners (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING;`);

        // טבלת היסטוריית משחקים
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_history (
                code VARCHAR(10) PRIMARY KEY,
                host_name VARCHAR(255),
                host_ip VARCHAR(50),
                game_title VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE,
                ended_at TIMESTAMP WITH TIME ZONE,
                total_players INT,
                total_teams INT,
                teams_data JSONB -- שמירת מבנה הקבוצות והשחקנים כ-JSON
            );
        `);
        console.log("✅ Database tables initialized.");
    } catch (e) {
        console.error("❌ Error initializing database tables:", e);
    }
}
// הפעלת אתחול ה-DB בעליית השרת
initDB();


// --- קטגוריות מילים (ללא שינוי) ---
const wordCategories = {
    food: ["פיצה", "פלאפל", "סושי", "המבורגר", "גלידה", "שוקולד", "פסטה", "סלט", "תפוח", "בננה"],
    animals: ["כלב", "חתול", "אריה", "פיל", "ג'ירפה", "קוף", "זברה", "דוב", "ציפור", "דג"],
    objects: ["כיסא", "שולחן", "מחשב", "טלפון", "מכונית", "ספר", "עט", "כוס", "בקבוק", "תיק"],
    sports: ["כדורגל", "כדורסל", "טניס", "שחייה", "ריצה", "אופניים", "כדורעף", "ג'ודו", "התעמלות", "טיפוס"],
    professions: ["רופא", "מורה", "שוטר", "כבאים", "טבח", "נהג", "טייס", "זמר", "שחקן", "צייר"],
    technology: ["אינטרנט", "וואטסאפ", "אינסטגרם", "טיקטוק", "מקלדת", "עכבר", "מסך", "סוללה", "מטען", "אוזניות"],
    nature: ["עץ", "פרח", "ים", "שמש", "ירח", "כוכב", "ענן", "גשם", "רוח", "אש"],
    home: ["מטבח", "סלון", "חדר שינה", "אמבטיה", "מרפסת", "גינה", "גג", "חלון", "דלת", "מדרגות"],
    clothing: ["חולצה", "מכנסיים", "שמלה", "חצאית", "נעליים", "גרביים", "כובע", "מעיל", "צעיף", "כפפות"],
    emotions: ["שמחה", "עצב", "כעס", "פחד", "הפתעה", "אהבה", "שנאה", "קנאה", "געגוע", "תקווה"],
    transport: ["אוטובוס", "רכבת", "מטוס", "אונייה", "מונית", "אופנוע", "קורקינט", "משאית", "טרקטור", "רכבל"],
    instruments: ["גיטרה", "פסנתר", "תוף", "כינור", "חליל", "חצוצרה", "סקסופון", "מפוחית", "אקורדיון", "דרבוקה"],
    countries: ["ישראל", "ארה״ב", "צרפת", "איטליה", "ספרד", "יוון", "תאילנד", "יפן", "סין", "ברזיל"],
    colors: ["אדום", "כחול", "צהוב", "ירוק", "כתום", "סגול", "ורוד", "שחור", "לבן", "אפור"],
    verbs: ["לרוץ", "לקפוץ", "לשיר", "לרקוד", "לצחוק", "לבכות", "לאכול", "לשתות", "לישון", "לחשוב"]
};

// --- פונקציות עזר (ללא שינוי) ---
function generateGameCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getWords(categories, customWords) {
    let words = [];
    if (customWords && customWords.trim().length > 0) {
        words = words.concat(customWords.split(',').map(w => w.trim()));
    }
    if (categories.includes('all')) {
        Object.values(wordCategories).forEach(arr => words = words.concat(arr));
    } else {
        categories.forEach(cat => {
            if (wordCategories[cat]) words = words.concat(wordCategories[cat]);
        });
    }
    return words.sort(() => Math.random() - 0.5);
}

function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

// =========================================
//  API Routes (מעודכנים לעבודה מול DB)
// =========================================

// קבלת באנרים (שליפה מה-DB)
app.get("/api/banners", async (req, res) => {
    try {
        const result = await pool.query('SELECT data FROM banners WHERE id = 1');
        if (result.rows.length > 0) {
            res.json(result.rows[0].data);
        } else {
            res.json({});
        }
    } catch (e) {
        console.error("Error fetching banners from DB:", e);
        res.status(500).json({ error: "DB error" });
    }
});

// שמירת באנרים (עדכון ב-DB)
app.post("/api/banners", async (req, res) => {
    try {
        const bannersJson = JSON.stringify(req.body);
        await pool.query('UPDATE banners SET data = $1 WHERE id = 1', [bannersJson]);
        res.json({ ok: true });
    } catch (e) {
        console.error("Error saving banners to DB:", e);
        res.status(500).json({ error: "Failed to save banners to DB" });
    }
});

app.post('/create-game', (req, res) => { res.redirect('/'); });


// =========================================
//  Admin API Routes (מעודכנים)
// =========================================

// סטטיסטיקות זמן אמת (נשאר מבוסס זיכרון כי זה Live)
app.get("/admin/stats", (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: "Unauthorized" });

    const activeGamesList = Object.values(games).map(g => ({
        code: g.code,
        hostName: g.hostName,
        hostIp: g.hostIp,
        createdAt: g.createdAt,
        playerCount: Object.keys(g.playersByClientId).length,
        teamCount: Object.keys(g.teams).length,
        isActive: true,
        gameTitle: g.gameTitle,
        teams: g.teams
    }));

    const uniqueIps = new Set();
    Object.values(games).forEach(g => {
        if(g.hostIp) uniqueIps.add(g.hostIp);
        Object.values(g.playersByClientId).forEach(p => {
            if(p.ip) uniqueIps.add(p.ip);
        });
    });

    res.json({
        stats: {
            activeGamesCount: activeGamesList.length,
            connectedSockets: io.engine.clientsCount,
            uniqueIps: uniqueIps.size // הערה: זה מציג יוניק IP רק של מחוברים כרגע. ליומי צריך DB.
        },
        activeGames: activeGamesList
    });
});


// *** ה-ENDPOINT המעודכן להיסטוריה מול ה-DB ***
app.get("/admin/history", async (req, res) => {
    const { code, startDate, endDate, search, scope } = req.query;

    if (code !== ADMIN_CODE) return res.status(403).json({ error: "Unauthorized" });
    if (!startDate || !endDate) return res.status(400).json({ error: "Missing dates" });

    // בניית שאילתת SQL דינמית
    let queryText = `
        SELECT code, host_name, host_ip, game_title, created_at, ended_at, total_players, total_teams, teams_data 
        FROM game_history 
        WHERE created_at >= $1 AND created_at <= $2
    `;
    
    // הגדרת טווח תאריכים (סוף יום)
    const endDateTime = new Date(endDate);
    endDateTime.setHours(23, 59, 59, 999);
    const queryParams = [startDate, endDateTime.toISOString()];

    // הוספת תנאי חיפוש אם יש ערך
    if (search && search.trim() !== '') {
        const searchTerm = `%${search.trim().toLowerCase()}%`;
        queryParams.push(searchTerm);
        const paramIdx = queryParams.length;

        let searchClause = "";
        // חיפוש בחדרים
        if (scope === 'rooms' || scope === 'all') {
            searchClause += ` (LOWER(code) LIKE $${paramIdx} OR LOWER(game_title) LIKE $${paramIdx})`;
        }
        // חיפוש במשתמשים ו-IP (כולל חיפוש בתוך ה-JSONB של הקבוצות)
        if (scope === 'users' || scope === 'all') {
            const userClause = ` (LOWER(host_name) LIKE $${paramIdx} OR host_ip LIKE $${paramIdx} OR teams_data::text ILIKE $${paramIdx})`;
            searchClause = searchClause ? `(${searchClause} OR ${userClause})` : userClause;
        }
        
        if (searchClause) {
            queryText += ` AND ${searchClause}`;
        }
    }

    queryText += ` ORDER BY created_at DESC`;

    try {
        const result = await pool.query(queryText, queryParams);
        // המרת שמות שדות כדי שיתאימו למה שהפרונט מצפה (teams_data -> teams)
        const formattedGames = result.rows.map(row => ({
            ...row,
            teams: row.teams_data, // הפרונט מצפה ל-teams
            isActive: false // היסטוריה תמיד לא פעילה
        }));
        res.json({ games: formattedGames });
    } catch (e) {
        console.error("Error fetching history from DB:", e);
        res.status(500).json({ error: "DB search error" });
    }
});

// =========================================
//  Socket.IO Logic (ללא שינוי)
// =========================================

io.on('connection', (socket) => {
    const clientIp = getClientIp(socket.request);
    console.log(`New client connected: ${socket.id} from ${clientIp}`);

    socket.on('createGame', (data, callback) => {
        const gameCode = generateGameCode();
        const words = getWords(data.categories, data.customWords);
        
        const teams = {};
        Object.entries(data.teamNames).forEach(([key, name]) => {
            if (name) teams[key] = { id: key, name: name, score: 0, players: [] };
        });

        games[gameCode] = {
            code: gameCode,
            hostId: socket.id,
            hostName: data.hostName,
            hostIp: clientIp,
            gameTitle: data.gameTitle,
            createdAt: new Date().toISOString(),
            teams: teams,
            playersByClientId: {}, 
            words: words,
            wordsPointer: 0,
            branding: data.branding,
            settings: {
                targetScore: parseInt(data.targetScore) || 50,
                roundSeconds: parseInt(data.roundSeconds) || 60
            },
            currentRound: { isActive: false }
        };

        socket.join(gameCode);
        console.log(`Game created: ${gameCode} by ${data.hostName}`);
        callback({ ok: true, gameCode: gameCode, game: games[gameCode] });
    });

    socket.on('joinGame', (data, callback) => {
        const { gameCode, name, teamId } = data;
        const game = games[gameCode];
        if (!game) return callback({ ok: false, error: "משחק לא נמצא" });
        if (!game.teams[teamId]) return callback({ ok: false, error: "קבוצה לא קיימת" });

        game.playersByClientId[socket.id] = { 
            id: socket.id, 
            name: name, 
            teamId: teamId, 
            ip: clientIp 
        };
        game.teams[teamId].players.push(socket.id);
        
        socket.join(gameCode);
        console.log(`Player ${name} joined game ${gameCode} team ${teamId}`);
        io.to(gameCode).emit('gameUpdated', game);
        callback({ ok: true, game: game, clientId: socket.id, teamId: teamId });
    });

    socket.on('getGameState', (data) => {
        const game = games[data.gameCode];
        if(game) socket.emit('gameUpdated', game);
    });

    socket.on('removePlayer', (data) => {
        const { gameCode, clientId } = data;
        const game = games[gameCode];
        if(game && game.hostId === socket.id) {
            const player = game.playersByClientId[clientId];
            if(player) {
                const team = game.teams[player.teamId];
                if(team) {
                    team.players = team.players.filter(pid => pid !== clientId);
                }
                delete game.playersByClientId[clientId];
                
                io.to(clientId).emit('playerRemoved');
                io.in(gameCode).socketsLeave(clientId);
                io.to(gameCode).emit('gameUpdated', game);
            }
        }
    });

    socket.on('startRound', (data, callback) => {
        const { gameCode, teamId, explainerClientId } = data;
        const game = games[gameCode];
        if (!game || game.hostId !== socket.id) return callback({ ok: false, error: "לא מורשה" });
        if (game.currentRound.isActive) return callback({ ok: false, error: "סיבוב כבר פעיל" });

        let actualExplainerId = explainerClientId;
        if(!actualExplainerId) {
            const teamPlayers = game.teams[teamId].players;
            if(teamPlayers.length === 0) return callback({ok:false, error: "אין שחקנים בקבוצה זו"});
            actualExplainerId = teamPlayers[Math.floor(Math.random() * teamPlayers.length)];
        }

        game.currentRound = {
            isActive: true,
            teamId: teamId,
            explainerId: actualExplainerId,
            explainerName: game.playersByClientId[actualExplainerId].name,
            roundScore: 0,
            startTime: Date.now(),
            timer: null
        };

        let secondsLeft = game.settings.roundSeconds;
        
        game.currentRound.timer = setInterval(() => {
            secondsLeft--;
            io.to(gameCode).emit('roundTick', { gameCode, secondsLeft });
            if (secondsLeft <= 0) {
                endRoundInternal(gameCode);
            }
        }, 1000);

        io.to(gameCode).emit('roundStarted', { game: game });
        callback({ ok: true });
    });

    socket.on('getNextWord', (data, callback) => {
        const game = games[data.gameCode];
        if(!game || !game.currentRound.isActive || game.currentRound.explainerId !== socket.id) {
            return callback({ ok: false, error: "לא מורשה" });
        }
        if(game.wordsPointer >= game.words.length) game.wordsPointer = 0;
        const word = game.words[game.wordsPointer++];
        callback({ ok: true, word: word });
    });

    socket.on('changeRoundScore', (data, callback) => {
        const game = games[data.gameCode];
        if(!game || !game.currentRound.isActive || game.currentRound.explainerId !== socket.id) return;
        
        game.currentRound.roundScore += data.delta;
        io.to(data.gameCode).emit('roundScoreUpdated', { gameCode: data.gameCode, roundScore: game.currentRound.roundScore });
        if(callback) callback();
    });

    socket.on('endRound', (data) => {
        const game = games[data.gameCode];
        if (game && game.hostId === socket.id) {
            endRoundInternal(data.gameCode);
        }
    });

    function endRoundInternal(gameCode) {
        const game = games[gameCode];
        if (!game || !game.currentRound.isActive) return;

        clearInterval(game.currentRound.timer);
        
        const team = game.teams[game.currentRound.teamId];
        team.score += game.currentRound.roundScore;
        
        const roundSummary = {
            teamName: team.name,
            roundScore: game.currentRound.roundScore,
            totalScore: team.score
        };

        game.currentRound = { isActive: false };
        io.to(gameCode).emit('roundTimeUp', roundSummary);
        io.to(gameCode).emit('gameUpdated', game);

        if (team.score >= game.settings.targetScore) {
            io.to(gameCode).emit('gameOver', { winningTeam: team.name });
        }
    }

    socket.on('endGame', (data) => {
        const game = games[data.gameCode];
        if (game && game.hostId === socket.id) {
            closeGameInternal(data.gameCode, false);
        }
    });

    socket.on('hostReconnect', (data, callback) => {
        const game = games[data.gameCode];
        if(game) {
             if(game.hostId !== socket.id) {
                 console.log(`Host reconnected to ${data.gameCode}, updating socket ID.`);
                 game.hostId = socket.id;
             }
             socket.join(data.gameCode);
             callback({ ok: true, game });
        } else {
            callback({ ok: false });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

// --- שינוי 4: פונקציית סגירת משחק אסינכרונית ששומרת ל-DB ---
async function closeGameInternal(gameCode, isAdminAction) {
    const game = games[gameCode];
    if (!game) return;

    if (game.currentRound.timer) clearInterval(game.currentRound.timer);
    
    const endedAt = new Date().toISOString();
    const totalPlayers = Object.keys(game.playersByClientId).length;
    const totalTeams = Object.keys(game.teams).length;
    
    // הכנת מבנה הנתונים של הקבוצות לשמירה ב-JSONB
    const teamsData = Object.values(game.teams).map(t => ({
        ...t,
        players: t.players.map(pid => game.playersByClientId[pid])
    }));

    try {
        // שמירה בבסיס הנתונים
        await pool.query(
            `INSERT INTO game_history (code, host_name, host_ip, game_title, created_at, ended_at, total_players, total_teams, teams_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [game.code, game.hostName, game.hostIp, game.gameTitle, game.createdAt, endedAt, totalPlayers, totalTeams, JSON.stringify(teamsData)]
        );
        console.log(`✅ Game ${gameCode} saved to DB history.`);
    } catch (e) {
        console.error(`❌ Error saving game ${gameCode} to DB:`, e);
    }

    io.to(gameCode).emit(isAdminAction ? 'adminClosedGame' : 'gameEnded');
    io.in(gameCode).socketsLeave(gameCode);
    delete games[gameCode];
    console.log(`Game ${gameCode} removed from active memory.`);
}


server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
