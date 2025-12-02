const speedGames = {};

// מאגר אותיות משופר (תדירות עברית גבוהה)
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
    io.on('connection', (socket) => {
        
        // --- יצירת משחק ---
        socket.on('speed:createGame', ({ hostName, teamCount, duration }) => {
            const gameCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            
            // יצירת קבוצות
            const teams = {};
            const teamConfigs = [
                {name: 'הכחולים 🔵', color: '#3498db'},
                {name: 'האדומים 🔴', color: '#e74c3c'},
                {name: 'הירוקים 🟢', color: '#2ecc71'},
                {name: 'הצהובים 🟡', color: '#f1c40f'},
                {name: 'הסגולים 🟣', color: '#9b59b6'}
            ];
            
            for(let i=0; i< (teamCount || 2); i++) {
                const tid = "T" + (i+1);
                teams[tid] = { 
                    id: tid, 
                    ...teamConfigs[i],
                    score: 0, 
                    players: [],
                    currentBoard: [null, null, null, null, null, null, null], 
                    foundWords: [] 
                };
            }

            speedGames[gameCode] = {
                hostId: socket.id,
                hostName: hostName,
                players: {},
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
            
            if (!teamId || !game.teams[teamId]) return socket.emit('speed:error', { message: "קבוצה לא קיימת" });

            game.players[socket.id] = { id: socket.id, name: name, teamId: teamId };
            
            // הוספה לרשימת הקבוצה למעקב
            if(!game.teams[teamId].players.find(p => p.id === socket.id)) {
                game.teams[teamId].players.push({ id: socket.id, name: name });
            }

            socket.join(code);
            socket.join(`speed-${code}-${teamId}`); // חדר פרטי לקבוצה

            // עדכון המנהל (מלא)
            sendHostUpdate(io, game);

            // אישור לשחקן
            socket.emit('speed:joinedSuccess', { 
                teamName: game.teams[teamId].name,
                teamColor: game.teams[teamId].color,
                teamId: teamId,
                gameState: game.state,
                letters: game.letters,
                currentBoard: game.teams[teamId].currentBoard
            });
        });

        // --- התחלת סיבוב (סינכרוני לכולם) ---
        socket.on('speed:startGame', ({ code }) => {
            const game = speedGames[code];
            if (!game) return;

            game.state = 'playing';
            game.letters = generateLetters(7); 
            game.startTime = Date.now();
            
            // איפוס לוחות
            Object.values(game.teams).forEach(t => {
                t.foundWords = [];
                t.currentBoard = [null, null, null, null, null, null, null];
            });

            // שידור לכולם
            io.to(code).emit('speed:roundStart', { 
                letters: game.letters,
                duration: game.gameDuration
            });

            sendHostUpdate(io, game);

            // טיימר בשרת
            setTimeout(() => {
                endSpeedRound(io, code);
            }, game.gameDuration * 1000);
        });

        // --- סנכרון לוח קבוצתי ---
        socket.on('speed:updateTeamBoard', ({ indices }) => {
            const { game, player } = getPlayerGame(socket.id);
            if(!game || !player) return;
            
            // עדכון בזיכרון השרת
            game.teams[player.teamId].currentBoard = indices;
            
            // שידור לחברי הקבוצה (מלבד השולח)
            socket.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices });
        });

        // --- בדיקת מילה ---
        socket.on('speed:submitWord', ({ word }) => {
            const { game, player } = getPlayerGame(socket.id);
            if (!game || game.state !== 'playing') return;

            const team = game.teams[player.teamId];
            
            // האם המילה כבר נמצאה ע"י הקבוצה?
            if (!team.foundWords.includes(word)) {
                team.foundWords.push(word);
                
                // עדכון הקבוצה כולה
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:wordAccepted', { word });
                
                // איפוס הלוח לקבוצה
                team.currentBoard = [null, null, null, null, null, null, null];
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices: team.currentBoard });

                sendHostUpdate(io, game);
            }
        });
        
        // --- בקשת סטטוס למנהל (למקרה של ריענון) ---
        socket.on('speed:getHostState', ({ code }) => {
            const game = speedGames[code];
            if(game) sendHostUpdate(io, game);
        });
    });
}

function getPlayerGame(socketId) {
    for(let code in speedGames) {
        if(speedGames[code].players[socketId]) {
            return { game: speedGames[code], player: speedGames[code].players[socketId] };
        }
    }
    return {};
}

function sendHostUpdate(io, game) {
    if(!game) return;
    io.to(game.hostId).emit('speed:hostFullUpdate', { 
        teams: game.teams,
        state: game.state,
        timeLeft: game.startTime ? Math.max(0, game.gameDuration - Math.floor((Date.now() - game.startTime)/1000)) : 0
    });
}

function endSpeedRound(io, gameCode) {
    const game = speedGames[gameCode];
    if (!game || game.state !== 'playing') return;

    game.state = 'ended';

    // חישוב ניקוד (ייחודיות)
    const allWordsMap = {}; 
    Object.values(game.teams).forEach(team => {
        team.foundWords.forEach(word => {
            allWordsMap[word] = (allWordsMap[word] || 0) + 1;
        });
    });

    const leaderboard = [];
    Object.values(game.teams).forEach(team => {
        let uniqueCount = 0;
        team.foundWords.forEach(word => {
            if (allWordsMap[word] === 1) uniqueCount++;
        });
        team.score += uniqueCount;
        leaderboard.push({ name: team.name, score: uniqueCount, totalWords: team.foundWords.length, color: team.color });
    });

    leaderboard.sort((a, b) => b.score - a.score);
    
    io.to(gameCode).emit('speed:roundEnd', { leaderboard });
    sendHostUpdate(io, game);
}

module.exports = { initSpeedGame };
