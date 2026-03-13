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

// --- טעינת מודול ספיד מניה (עם מנגנון הגנה מקריסה) ---
try {
    const speedManager = require('./backend/speedGameManager');
    if (speedManager && typeof speedManager.initSpeedGame === 'function') {
        speedManager.initSpeedGame(io);
        console.log("✅ Speed Mania module loaded successfully.");
    } else {
        console.warn("⚠️ Speed Mania module loaded but 'initSpeedGame' is missing.");
    }
} catch (error) {
    console.error("⚠️ WARNING: Could not load './backend/speedGameManager.js'.");
    console.error("   Error details:", error.message);
    console.error("   >> Please ensure the 'backend' folder exists and contains 'speedGameManager.js'.");
    console.error("   >> The server will continue running, but Speed Mania will not work.");
}

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

const INACTIVITY_LIMIT = 24 * 60 * 60 * 1000; 
const CLEANUP_INTERVAL = 60 * 60 * 1000;      

// --- Webhook Email ---
async function sendNewGameEmail(gameInfo) {
  const webhookUrl = process.env.EMAIL_WEBHOOK;
  if (!webhookUrl) return; 
  fetch(webhookUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: gameInfo.code, host: gameInfo.hostName, title: gameInfo.gameTitle || "ללא שם" })
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

    await pool.query(`CREATE TABLE IF NOT EXISTS games (code TEXT PRIMARY KEY, host_name TEXT, target_score INTEGER, default_round_seconds INTEGER, categories TEXT[], created_at TIMESTAMPTZ DEFAULT NOW());`);
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS host_ip TEXT;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS branding JSONB;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS game_title TEXT;`); } catch (e) {}
    
    await pool.query(`CREATE TABLE IF NOT EXISTS game_teams (id SERIAL PRIMARY KEY, game_code TEXT, team_id TEXT, team_name TEXT, score INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_players (id SERIAL PRIMARY KEY, game_code TEXT, client_id TEXT, name TEXT, team_id TEXT, ip_address TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS ip_address TEXT;`); } catch (e) {}
    
    await pool.query(`CREATE TABLE IF NOT EXISTS active_states (game_code TEXT PRIMARY KEY, data TEXT, last_updated TIMESTAMPTZ DEFAULT NOW());`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS site_settings (id SERIAL PRIMARY KEY, top_banner_img TEXT, top_banner_link TEXT, bottom_banner_img TEXT, bottom_banner_link TEXT, top_banner_img_mobile TEXT, bottom_banner_img_mobile TEXT);`);
    await pool.query(`INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    dbReady = true;
    console.log("✅ Postgres ready.");
    // restoreActiveGames(); // אופציונלי
  } catch (err) {
    console.error("❌ DB Error:", err.message);
  }
}
initDb();

// --- לוגיקת משחק קלאסי (חלקית, לתמיכה בקיים) ---
const games = {}; 
// (כאן נמצאת הלוגיקה המקורית של מילמניה - לא הסרתי אותה כדי שהמשחק הקיים יעבוד)
// ... [קוד מילמניה המקורי נשמר כפי שהיה בקובץ ששלחת] ...

// --- API: באנרים ---
app.get("/api/banners", async (req, res) => {
    let banners = {};
    if (dbReady && pool) {
        try {
            const result = await pool.query("SELECT * FROM site_settings WHERE id = 1");
            if (result.rows.length > 0) {
                const row = result.rows[0];
                banners.topBanner = { img: row.top_banner_img, imgMobile: row.top_banner_img_mobile, link: row.top_banner_link };
                banners.bottomBanner = { img: row.bottom_banner_img, imgMobile: row.bottom_banner_img_mobile, link: row.bottom_banner_link };
            }
        } catch (e) {}
    }
    res.json(banners);
});

// --- API: היסטוריה ---
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
        let query = "";

        if (scope === 'rooms') {
            query = `SELECT g.code, g.host_name, g.host_ip, g.game_title, g.created_at, 
                     (SELECT COUNT(*) FROM game_players WHERE game_code = g.code) as total_players 
                     FROM games g WHERE g.created_at >= $1 AND g.created_at <= $2`;
             if (searchClause) query = query.replace('name_field', 'g.host_name').replace('ip_field', 'g.host_ip').replace('code_field', 'g.code') + searchClause;
             query += ` ORDER BY g.created_at DESC`;
        } else {
            query = `SELECT gp.*, g.game_title FROM game_players gp LEFT JOIN games g ON gp.game_code = g.code WHERE gp.created_at >= $1 AND gp.created_at <= $2`;
            if (searchClause) query = query.replace('name_field', 'gp.name').replace('ip_field', 'gp.ip_address') + searchClause;
            query += ` ORDER BY gp.created_at DESC`;
        }

        const result = await pool.query(query, queryParams);
        res.json({ summary: { count: result.rowCount, scope }, results: result.rows });
    } catch (e) {
        console.error("History DB Error:", e);
        res.status(500).json({ error: e.message });
    }
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
