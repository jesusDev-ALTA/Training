import socketclient from 'socket.io-client';

const socket = socketclient('http://localhost:3000');

socket.on('message', (data) => {
    console.log(data);
});
