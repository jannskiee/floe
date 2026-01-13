const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 1e8,
});

io.on('connection', (socket) => {
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') {
            callback();
        }
    });

    socket.on('join-room', (roomId) => {
        const room = io.sockets.adapter.rooms.get(roomId);
        const numClients = room ? room.size : 0;

        if (numClients === 0) {
            socket.join(roomId);
            console.log(`Room ${roomId} created by ${socket.id}`);
        } else if (numClients === 1) {
            socket.join(roomId);
            socket.to(roomId).emit('user-connected', socket.id);
            console.log(`User ${socket.id} joined room ${roomId}`);
        } else {
            socket.emit('room-full');
        }
    });

    socket.on('signal', (data) => {
        if (data.target) {
            io.to(data.target).emit('signal', {
                signal: data.signal,
                sender: socket.id,
            });
        } else if (data.roomId) {
            socket.to(data.roomId).emit('signal', {
                signal: data.signal,
                sender: socket.id,
            });
        }
    });

    socket.on('disconnecting', () => {
        const rooms = socket.rooms;
        rooms.forEach((roomId) => {
            socket.to(roomId).emit('peer-disconnected');
        });
    });

    socket.on('disconnect', () => {
        console.log('User Disconnected', socket.id);
    });
});

server.listen(3001, () => {
    console.log('SERVER RUNNING ON PORT 3001');
});
