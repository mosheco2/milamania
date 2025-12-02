const speedGames = {};

// מאגר אותיות משופר
const LETTERS_POOL = [
    ...'אאאאאאבבבגגגדההההויווווזחחטייייכלללמממנננסעעפפצקררררשתתת'.split('')
];

function generateLetters(count = 7) {
    let result = [];
    for(let i=0; i<count; i++) {
        const rand = Math.floor(Math.random() * LETTERS_POOL.length);
        result.push(LETTERS_POOL[rand]);
    }
    return result;
}

function initSpeedGame(io) {
    console.log("⚡ Speed Mania Module Loaded (Multi-Team Mode)");

    io.on('connection', (socket) => {
        
        // --- יצירת משחק (Host) ---
        socket.on('speed:createGame', ({ hostName, teamCount, duration }) => {
            const gameCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            
            // יצירת קבוצות
            const teams = {};
            const teamNames = ['הכחולים', 'האדומים', 'הירוקים', 'הצהובים', 'הסגולים'];
            for(let i=0; i< (teamCount || 2); i++) {
                const tid = "T" + (i+1);
                teams[tid] = { 
                    id: tid, 
                    name: teamNames[i], 
                    score: 0, 
                    players: [],
                    currentBoard: [], // המצב המשותף של הלוח!
                    foundWords: [] 
                };
            }

            speedGames[gameCode] = {
                hostId: socket.id,
                hostName: hostName,
                players: {}, // { socketId: { name, teamId } }
                teams: teams,
                state: 'lobby',
                letters: [],
                gameDuration: duration || 60
            };

            socket.join(gameCode);
            socket.emit('speed:gameCreated', { gameCode, teams });
        });

        // --- הצטרפות שחקן ---
        socket.on('speed:join', ({ code, name, teamId }) => {
            const game = speedGames[code];
            if (!game) return socket.emit('speed:error', { message: "חדר לא נמצא" });
            
            // אם לא נבחרה קבוצה, נבחר אוטומטית את הראשונה
            if (!teamId) teamId = Object.keys(game.teams)[0];
            if (!game.teams[teamId]) return socket.emit('speed:error', { message: "קבוצה לא קיימת" });

            game.players[socket.id] = {
                id: socket.id,
                name: name,
                teamId: teamId
            };
            
            game.teams[teamId].players.push({ id: socket.id, name: name });

            socket.join(code);
            socket.join(`speed-${code}-${teamId}`); // חדר ייעודי לקבוצה לסנכרון לוח

            // עדכון המנהל
            io.to(game.hostId).emit('speed:playerJoined', { teams: game.teams });

            // שליחת אישור לשחקן עם פרטי הקבוצה
            socket.emit('speed:joinedSuccess', { 
                teamName: game.teams[teamId].name,
                teamId: teamId
            });
        });

        // --- התחלת סיבוב ---
        socket.on('speed:startGame', ({ code }) => {
            const game = speedGames[code];
            if (!game || game.hostId !== socket.id) return;

            game.state = 'playing';
            game.letters = generateLetters(7); 
            
            // איפוס לוחות ומילים לכל הקבוצות
            Object.values(game.teams).forEach(t => {
                t.foundWords = [];
                t.currentBoard = []; // איפוס הלוח המשותף
            });

            // שליחת אותיות לכולם
            io.to(code).emit('speed:roundStart', { 
                letters: game.letters,
                duration: game.gameDuration
            });

            // טיימר צד שרת
            setTimeout(() => {
                endSpeedRound(io, code);
            }, game.gameDuration * 1000);
        });

        // --- סנכרון לוח קבוצתי (Drag & Drop) ---
        socket.on('speed:updateTeamBoard', ({ indices }) => {
            // 1. מצא את המשחק והקבוצה
            let gameCode, player;
            for(let c in speedGames) {
                if(speedGames[c].players[socket.id]) {
                    gameCode = c;
                    player = speedGames[c].players[socket.id];
                    break;
                }
            }
            
            if(!gameCode || !player) return;
            const game = speedGames[gameCode];
            
            // 2. עדכון הלוח בזיכרון השרת
            if(game.teams[player.teamId]) {
                game.teams[player.teamId].currentBoard = indices;
                
                // 3. שידור לכל חברי הקבוצה (מלבד השולח)
                socket.to(`speed-${gameCode}-${player.teamId}`).emit('speed:boardUpdated', { 
                    indices: indices,
                    movedBy: player.name 
                });
            }
        });

        // --- הגשת מילה ---
        socket.on('speed:submitWord', ({ word }) => {
            let gameCode, player;
            for(let c in speedGames) {
                if(speedGames[c].players[socket.id]) {
                    gameCode = c;
                    player = speedGames[c].players[socket.id];
                    break;
                }
            }

            if (!gameCode) return;
            const game = speedGames[gameCode];
            if (game.state !== 'playing') return;

            const team = game.teams[player.teamId];
            
            // בדיקה אם המילה כבר נמצאה ע"י הקבוצה
            if (!team.foundWords.includes(word)) {
                team.foundWords.push(word);
                
                // עדכון המנהל
                const totalWordsAllTeams = Object.values(game.teams).reduce((acc, t) => acc + t.foundWords.length, 0);
                io.to(game.hostId).emit('speed:hostUpdate', { totalWords: totalWordsAllTeams });
                
                // עדכון כל חברי הקבוצה שהמילה התקבלה
                io.to(`speed-${gameCode}-${player.teamId}`).emit('speed:wordAccepted', { word });
            }
        });

    });
}

function endSpeedRound(io, gameCode) {
    const game = speedGames[gameCode];
    if (!game || game.state !== 'playing') return;

    game.state = 'ended';

    // בדיקת ייחודיות מילים (Global Uniqueness)
    const allWordsMap = {}; 
    
    // שלב 1: ספירה כמה קבוצות מצאו כל מילה
    Object.values(game.teams).forEach(team => {
        team.foundWords.forEach(word => {
            allWordsMap[word] = (allWordsMap[word] || 0) + 1;
        });
    });

    // שלב 2: ניקוד לקבוצות
    const leaderboard = [];
    Object.values(game.teams).forEach(team => {
        let uniqueCount = 0;
        team.foundWords.forEach(word => {
            if (allWordsMap[word] === 1) uniqueCount++; // רק אם רק קבוצה אחת מצאה
        });
        team.score += uniqueCount; // צבירת ניקוד
        leaderboard.push({ 
            name: team.name, 
            score: uniqueCount, 
            totalWords: team.foundWords.length 
        });
    });

    leaderboard.sort((a, b) => b.score - a.score);
    io.to(gameCode).emit('speed:roundEnd', { leaderboard });
}

module.exports = { initSpeedGame };
