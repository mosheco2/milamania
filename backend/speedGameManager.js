const speedGames = {};

// מאגר אותיות (תדירות עברית)
const LETTERS_POOL = [
    ...'אאאאאאאבבבגגגדההההההויוווווזחחטייייייכללללממממננננסעעפפצקררררשתתת'.split('')
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
    console.log("⚡ Speed Mania Module Loaded (With Review Phase)");

    io.on('connection', (socket) => {
        
        // --- יצירת משחק ---
        socket.on('speed:createGame', ({ hostName, teamCount, duration }) => {
            const gameCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            const teams = {};
            const teamConfigs = [
                {name: 'הכחולים 🔵', color: '#3498db'}, {name: 'האדומים 🔴', color: '#e74c3c'},
                {name: 'הירוקים 🟢', color: '#2ecc71'}, {name: 'הצהובים 🟡', color: '#f1c40f'},
                {name: 'הסגולים 🟣', color: '#9b59b6'}
            ];
            
            for(let i=0; i< (teamCount || 2); i++) {
                const tid = "T" + (i+1);
                teams[tid] = { 
                    id: tid, 
                    ...teamConfigs[i],
                    score: 0, 
                    players: [], // {id, name}
                    currentBoard: [null,null,null,null,null,null,null], 
                    foundWords: [] // מילים שנמצאו בסיבוב הנוכחי
                };
            }

            speedGames[gameCode] = {
                hostId: socket.id,
                hostName: hostName,
                players: {}, // map socketId -> player data
                teams: teams,
                state: 'lobby',
                letters: [],
                gameDuration: duration || 60,
                startTime: null
            };

            socket.join(gameCode);
            socket.emit('speed:gameCreated', { gameCode, teams });
        });

        // --- הצטרפות שחקן ---
        socket.on('speed:join', ({ code, name, teamId }) => {
            const game = speedGames[code];
            if (!game) return socket.emit('speed:error', { message: "חדר לא נמצא" });
            if (!teamId) teamId = Object.keys(game.teams)[0];

            game.players[socket.id] = { id: socket.id, name, teamId };
            
            // הוספה לרשימת הקבוצה (למניעת כפילויות)
            if(!game.teams[teamId].players.find(p => p.id === socket.id)) {
                game.teams[teamId].players.push({ id: socket.id, name });
            }

            socket.join(code);
            socket.join(`speed-${code}-${teamId}`);

            // שידור עדכון מלא לכולם (כדי שכולם יראו את רשימות השחקנים)
            io.to(code).emit('speed:rosterUpdate', { teams: game.teams });
            sendHostUpdate(io, game);

            socket.emit('speed:joinedSuccess', { 
                teamName: game.teams[teamId].name, teamColor: game.teams[teamId].color, teamId,
                gameState: game.state, letters: game.letters, currentBoard: game.teams[teamId].currentBoard
            });
        });

        // --- התחלת סיבוב ---
        socket.on('speed:startGame', ({ code }) => {
            const game = speedGames[code];
            if (!game) return;

            game.state = 'playing';
            game.letters = generateLetters(7); 
            game.startTime = Date.now();
            
            // איפוס לסיבוב חדש
            Object.values(game.teams).forEach(t => {
                t.foundWords = []; 
                t.currentBoard = [null,null,null,null,null,null,null];
            });

            io.to(code).emit('speed:roundStart', { letters: game.letters, duration: game.gameDuration });
            sendHostUpdate(io, game);

            // טיימר צד שרת
            setTimeout(() => {
                endSpeedRoundPhase(io, code);
            }, game.gameDuration * 1000);
        });

        // --- עדכון לוח משותף ---
        socket.on('speed:updateTeamBoard', ({ indices }) => {
            const { game, player } = getPlayerGame(socket.id);
            if(!game || !player) return;
            
            game.teams[player.teamId].currentBoard = indices;
            socket.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices });
        });

        // --- הגשת מילה ---
        socket.on('speed:submitWord', ({ word }) => {
            const { game, player } = getPlayerGame(socket.id);
            if (!game || game.state !== 'playing') return;

            const team = game.teams[player.teamId];
            
            // אם המילה טרם נמצאה ע"י הקבוצה
            if (!team.foundWords.includes(word)) {
                team.foundWords.push(word);
                
                // עדכון לחברי הקבוצה
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:wordAccepted', { word });
                
                // ניקוי הלוח המשותף אחרי שליחה
                team.currentBoard = [null,null,null,null,null,null,null];
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices: team.currentBoard });

                sendHostUpdate(io, game);
            }
        });
        
        // --- סיום שיפוט וחישוב ניקוד סופי ---
        socket.on('speed:finalizeRound', ({ code, approvedWordsByTeam }) => {
            // approvedWordsByTeam = { 'T1': ['מילה1', 'מילה2'], 'T2': [...] }
            const game = speedGames[code];
            if (!game) return;

            // חישוב ייחודיות (Global Uniqueness)
            const allWordsMap = {};
            
            // 1. מיפוי כל המילים המאושרות מכל הקבוצות
            Object.entries(approvedWordsByTeam).forEach(([teamId, words]) => {
                words.forEach(word => {
                    allWordsMap[word] = (allWordsMap[word] || 0) + 1;
                });
            });

            // 2. מתן ניקוד לקבוצות
            const roundResults = []; // לדיווח
            
            Object.entries(approvedWordsByTeam).forEach(([teamId, words]) => {
                const team = game.teams[teamId];
                let uniqueCount = 0;
                
                words.forEach(word => {
                    // מילה מזכה בניקוד רק אם היא מופיעה פעם אחת בכל המשחק (רק אצל הקבוצה הזו)
                    if (allWordsMap[word] === 1) {
                        uniqueCount++;
                    }
                });
                
                // עדכון הניקוד המצטבר
                team.score += uniqueCount;
                
                roundResults.push({
                    teamId: teamId,
                    name: team.name,
                    roundPoints: uniqueCount,
                    totalScore: team.score,
                    color: team.color
                });
            });

            game.state = 'lobby'; // מחזירים למצב לובי לסיבוב הבא
            
            // שליחת תוצאות לכולם
            io.to(code).emit('speed:roundResults', { results: roundResults });
            sendHostUpdate(io, game);
        });

        socket.on('speed:getHostState', ({ code }) => {
            const game = speedGames[code];
            if(game) sendHostUpdate(io, game);
        });
    });
}

function getPlayerGame(socketId) {
    for(let code in speedGames) {
        if(speedGames[code].players[socketId]) return { game: speedGames[code], player: speedGames[code].players[socketId] };
    }
    return {};
}

function sendHostUpdate(io, game) {
    if(!game) return;
    const timeLeft = game.startTime ? Math.max(0, game.gameDuration - Math.floor((Date.now() - game.startTime)/1000)) : 0;
    
    io.to(game.hostId).emit('speed:hostFullUpdate', { 
        teams: game.teams,
        state: game.state,
        timeLeft
    });
}

// פונקציה שרצה כשהזמן נגמר - מעבירה את המשחק למצב שיפוט
function endSpeedRoundPhase(io, gameCode) {
    const game = speedGames[gameCode];
    if (!game || game.state !== 'playing') return;

    game.state = 'review';
    
    // שידור לכולם שהזמן נגמר
    io.to(gameCode).emit('speed:timeUp');
    
    // שידור למנהל לפתוח מסך שיפוט
    sendHostUpdate(io, game);
}

module.exports = { initSpeedGame };
