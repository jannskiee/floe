const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

app.use(helmet());

const allowedOrigins = [
    process.env.CLIENT_URL,
    'http://localhost:3000',
].filter(Boolean);

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
    })
);

app.get('/', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    maxHttpBufferSize: 1e8,
});

const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const connectionCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_CONNECTIONS_PER_IP = 10;

io.use((socket, next) => {
    const ip =
        socket.handshake.headers['x-forwarded-for'] ||
        socket.handshake.address;
    const now = Date.now();

    if (!connectionCounts.has(ip)) {
        connectionCounts.set(ip, []);
    }

    const timestamps = connectionCounts.get(ip);
    const validTimestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
    validTimestamps.push(now);
    connectionCounts.set(ip, validTimestamps);

    if (validTimestamps.length > MAX_CONNECTIONS_PER_IP) {
        return next(new Error('Rate limit exceeded'));
    }

    next();
});

setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of connectionCounts.entries()) {
        const validTimestamps = timestamps.filter(
            (t) => now - t < RATE_LIMIT_WINDOW
        );
        if (validTimestamps.length === 0) {
            connectionCounts.delete(ip);
        } else {
            connectionCounts.set(ip, validTimestamps);
        }
    }
}, 60000);

io.on('connection', (socket) => {
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') {
            callback();
        }
    });

    socket.on('join-room', (roomId) => {
        if (
            !roomId ||
            typeof roomId !== 'string' ||
            !UUID_REGEX.test(roomId)
        ) {
            socket.emit('error', 'Invalid room ID');
            return;
        }

        socket.rooms.forEach((room) => {
            if (room !== socket.id) {
                socket.leave(room);
            }
        });

        const room = io.sockets.adapter.rooms.get(roomId);
        const numClients = room ? room.size : 0;

        if (numClients === 0) {
            socket.join(roomId);
            socket.emit('room-joined', { role: 'sender' });
        } else if (numClients === 1) {
            socket.join(roomId);
            socket.emit('room-joined', { role: 'receiver' });
            socket.to(roomId).emit('user-connected', socket.id);
        } else {
            socket.emit('room-full');
        }
    });

    socket.on('signal', (data) => {
        if (!data || typeof data !== 'object' || !data.signal) {
            return;
        }

        if (data.target && typeof data.target === 'string') {
            io.to(data.target).emit('signal', {
                signal: data.signal,
                sender: socket.id,
            });
        } else if (data.roomId && UUID_REGEX.test(data.roomId)) {
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

    socket.on('disconnect', () => { });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT);
