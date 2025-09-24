import express from 'express';
import createServer from 'http';
import { Server } from 'socket.io';
import { counterRouter } from './routes/counter/counter.routes.js';
let cont = 0;
const app = express();
const server = createServer.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
app.get('/', (req, res) => {
    res.send('Bienvenido al server de Camilita')
});

app.use("/api", counterRouter);



io.on('connection', (socket) => { });

server.listen(3000, () => {
    console.log('API server listening on port 3000');
});

const setIntervalId = setInterval(() => {
    cont++;
    io.emit('message', `Hello from server: ${cont}`);
}, 1000);