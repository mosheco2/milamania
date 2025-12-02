const speedGames = {};

// מאגר אותיות (עם משקל ליצירת מילים הגיוניות)
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
    console.log("⚡ Speed Mania Module Loaded");

    io.on('connection', (socket) => {
        
        // --- יצירת משחק (Host) ---
        socket.on('speed:createGame', ({ hostName }) => {
            const gameCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            
            speedGames[gameCode] = {
                hostId: socket.id,
                hostName: hostName,
                players: {},
                state: 'lobby',
                letters: [],
                gameDuration: 60
            };

            socket.join(gameCode);
            socket.emit('speed:gameCreated', { gameCode });
        });

        // --- הצטרפות שחקן ---
        socket.on('speed:join', ({ code, name }) => {
            const game = speedGames[code];
            if (!game) return socket.emit('speed:error', { message: "חדר לא נמצא" });
            if (game.state !== 'lobby') return socket.emit('speed:error', { message: "המשחק כבר התחיל" });

            game.players[socket.id] = {
                id: socket.id,
                name: name,
                score: 0,
                foundWords: []
            };

            socket.join(code);
            
            io.to(game.hostId).emit('speed:playerJoined', { 
                players: Object.values(game.players).map(p => ({ name: p.name, id: p.id }))
            });

            socket.emit('speed:joinedSuccess', { code });
        });

        // --- התחלת סיבוב ---
        socket.on('speed:startGame', ({ code }) => {
            const game = speedGames[code];
            if (!game || game.hostId !== socket.id) return;

            game.state = 'playing';
            game.letters = generateLetters(7); 
            
            Object.values(game.players).forEach(p => p.foundWords = []);

            io.to(code).emit('speed:roundStart', { 
                letters: game.letters,
                duration: game.gameDuration
            });

            setTimeout(() => {
                endSpeedRound(io, code);
            }, game.gameDuration * 1000);
        });

        // --- קבלת מילה משחקן ---
        socket.on('speed:submitWord', ({ word }) => {
            let gameCode = null;
            for(let code in speedGames) {
                if(speedGames[code].players[socket.id]) {
                    gameCode = code;
                    break;
                }
            }

            if (!gameCode) return;
            const game = speedGames[gameCode];
            if (game.state !== 'playing') return;

            const player = game.players[socket.id];
            if (!player.foundWords.includes(word)) {
                player.foundWords.push(word);
                io.to(game.hostId).emit('speed:hostUpdate', { 
                    totalWords: Object.values(game.players).reduce((acc, p) => acc + p.foundWords.length, 0)
                });
            }
        });

    });
}

function endSpeedRound(io, gameCode) {
    const game = speedGames[gameCode];
    if (!game || game.state !== 'playing') return;

    game.state = 'ended';

    const allWordsCount = {}; 
    Object.values(game.players).forEach(player => {
        player.foundWords.forEach(word => {
            allWordsCount[word] = (allWordsCount[word] || 0) + 1;
        });
    });

    const leaderboard = [];
    Object.values(game.players).forEach(player => {
        let uniqueCount = 0;
        player.foundWords.forEach(word => {
            if (allWordsCount[word] === 1) uniqueCount++;
        });
        player.score = uniqueCount;
        leaderboard.push({ name: player.name, score: uniqueCount, totalWords: player.foundWords.length });
    });

    leaderboard.sort((a, b) => b.score - a.score);
    io.to(gameCode).emit('speed:roundEnd', { leaderboard });
}

module.exports = { initSpeedGame };
