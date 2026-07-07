// Load server/.env into process.env for direct (non-Docker) runs. dotenv does not
// override variables already set in the environment, so Docker/platform-injected
// values take precedence and containers without a .env file are unaffected.
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
app.use(helmet());
app.use(express.json());

// Trust N proxy hops so req.ip resolves to the real client IP.
// Set TRUSTED_PROXY_COUNT=0 for direct exposure, 1 (default) behind one proxy (Render/Fly/Vercel).
const TRUSTED_PROXY_COUNT = parseInt(process.env.TRUSTED_PROXY_COUNT || '1', 10);
app.set('trust proxy', TRUSTED_PROXY_COUNT);

// Extract the real client IP from an X-Forwarded-For header, discarding
// client-supplied spoofed entries by only trusting the rightmost N hops.
function getClientIp(xffHeader, socketAddr) {
    if (!xffHeader) return socketAddr || 'unknown';
    const hops = String(xffHeader).split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length === 0) return socketAddr || 'unknown';
    // The rightmost TRUSTED_PROXY_COUNT entries were appended by trusted proxies;
    // the entry just before them is the genuine client.
    const idx = Math.max(0, hops.length - TRUSTED_PROXY_COUNT);
    return hops[idx] || socketAddr || 'unknown';
}

const allowedOrigins = [
    process.env.CLIENT_URL,
    'https://www.floe.one',
    'https://floe.one',
    'http://localhost:3000',
].filter(Boolean);

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
    })
);

app.get('/', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/health', (_req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// ---------------------------------------------------------------------------
// TURN credential generation
// ---------------------------------------------------------------------------

const STUN_FALLBACK = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

const turnRateLimits = new Map();
const TURN_RATE_WINDOW = 60000;
const TURN_MAX_REQUESTS = 20;

const statsRateLimits = new Map();
const STATS_RATE_WINDOW = 60000;
const STATS_MAX_REPORTS = 60; // per IP per minute
const MAX_REPORT_BYTES = parseInt(process.env.MAX_REPORT_BYTES || '', 10) || (5 * 1024 * 1024 * 1024 * 1024); // 5 TB

// Per-IP limiter for the code endpoints (register + resolve). These were the
// only unauthenticated HTTP routes without a limiter: unbounded POSTs grow
// codeToRoom (a memory-exhaustion vector) and unbounded GETs allow brute-force
// enumeration of active codes. Default 60/min is far above the 1-2 requests a
// real transfer makes; raise via MAX_CODE_REQUESTS_PER_IP for CI/staging.
const codeRateLimits = new Map();
const CODE_RATE_WINDOW = 60000;
const CODE_MAX_REQUESTS = parseInt(process.env.MAX_CODE_REQUESTS_PER_IP, 10) || 60;
// Hard ceiling on simultaneously-live codes, bounding memory regardless of how
// requests are spread across IPs.
const MAX_ACTIVE_CODES = parseInt(process.env.MAX_ACTIVE_CODES, 10) || 10000;

// Generic per-IP sliding-window limiter as Express middleware. req.ip resolves
// correctly via the `trust proxy` setting above, matching the turn/stats logic.
function makeRateLimiter(map, windowMs, max) {
    return (req, res, next) => {
        const now = Date.now();
        const timestamps = (map.get(req.ip) || []).filter(t => now - t < windowMs);
        if (timestamps.length >= max) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        timestamps.push(now);
        map.set(req.ip, timestamps);
        next();
    };
}
const codeRateLimiter = makeRateLimiter(codeRateLimits, CODE_RATE_WINDOW, CODE_MAX_REQUESTS);

function generateCoturnCredentials() {
    const turnSecret = process.env.TURN_SECRET;
    const turnDomain = process.env.TURN_DOMAIN;
    if (!turnSecret || !turnDomain) return null;

    const ttl = 24 * 3600;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:floeuser`;
    const password = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');

    return [
        { urls: `stun:${turnDomain}:3478` },
        { urls: `turn:${turnDomain}:3478`, username, credential: password },
        { urls: `turns:${turnDomain}:5349`, username, credential: password },
    ];
}

// ---------------------------------------------------------------------------
// Cloudflare Realtime TURN
//
// When CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_KEY_API_TOKEN are set, mint
// short-lived ICE servers from Cloudflare's global anycast TURN network. The
// credentials are not per-user, so cache one set in memory and refresh well
// before the 24h TTL instead of calling the API on every request. STUN and TURN
// are returned as separate entries so the client's relay-off filter
// (filterIceServers) can drop TURN while keeping STUN.
// ---------------------------------------------------------------------------

const CLOUDFLARE_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID;
const CLOUDFLARE_TURN_KEY_API_TOKEN = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
const CF_TURN_TTL = 24 * 3600;         // credential lifetime requested from Cloudflare (seconds)
const CF_CACHE_MS = 12 * 3600 * 1000;  // refresh our cached copy every 12h (well within the TTL)

let cfIceCache = { servers: null, expires: 0 };

async function generateCloudflareIceServers() {
    if (!CLOUDFLARE_TURN_KEY_ID || !CLOUDFLARE_TURN_KEY_API_TOKEN) return null;
    if (cfIceCache.servers && Date.now() < cfIceCache.expires) return cfIceCache.servers;
    try {
        const resp = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${CLOUDFLARE_TURN_KEY_API_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ ttl: CF_TURN_TTL }),
            }
        );
        if (!resp.ok) return cfIceCache.servers; // serve last good copy on a transient failure
        const { iceServers } = await resp.json();
        if (!iceServers) return cfIceCache.servers;

        // Cloudflare returns one object with all URLs and a single credential.
        // Split STUN from TURN so the client can strip TURN while keeping STUN
        // when the user disables relay fallback.
        const raw = Array.isArray(iceServers) ? iceServers : [iceServers];
        const stunUrls = [];
        const turnUrls = [];
        let username;
        let credential;
        for (const s of raw) {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            for (const u of urls) {
                (u.startsWith('stun:') ? stunUrls : turnUrls).push(u);
            }
            if (s.username) { username = s.username; credential = s.credential; }
        }
        const servers = [];
        if (stunUrls.length) servers.push({ urls: stunUrls });
        if (turnUrls.length) servers.push({ urls: turnUrls, username, credential });
        if (!servers.length) return cfIceCache.servers;

        cfIceCache = { servers, expires: Date.now() + CF_CACHE_MS };
        return servers;
    } catch {
        return cfIceCache.servers; // network hiccup: last good copy (may be null, then we fall through)
    }
}

app.get('/api/turn-credentials', async (req, res) => {
    const ip = req.ip;  // Express resolves this correctly via trust proxy
    const now = Date.now();

    if (!turnRateLimits.has(ip)) turnRateLimits.set(ip, []);
    const timestamps = turnRateLimits.get(ip).filter(t => now - t < TURN_RATE_WINDOW);
    if (timestamps.length >= TURN_MAX_REQUESTS) return res.status(429).json({ error: 'Too many requests' });
    timestamps.push(now);
    turnRateLimits.set(ip, timestamps);

    // Prefer Cloudflare's managed TURN, then self-hosted coturn, then public STUN.
    const credentials = (await generateCloudflareIceServers()) || generateCoturnCredentials();
    res.json(credentials || STUN_FALLBACK);
});

// ---------------------------------------------------------------------------
// Code phrase API  (/api/code)
// CLI callers use this to generate and resolve short human-readable codes.
// ---------------------------------------------------------------------------

const words = require('./words.json');
const codeToRoom = new Map(); // code → { roomId, expires }

// `pick` is injectable so tests can force deterministic collisions; production
// uses crypto.randomInt (a CSPRNG, and free of modulo bias) because the code
// phrase is the only secret guarding a transfer.
function generateCode(pick = () => words[crypto.randomInt(words.length)]) {
    for (let i = 0; i < 10; i++) {
        const code = `${pick()}-${pick()}-${pick()}`;
        const existing = codeToRoom.get(code);
        if (!existing || Date.now() > existing.expires) return code;
    }
    // Extremely unlikely collision after 10 attempts; add a 4th word to widen the space.
    return `${pick()}-${pick()}-${pick()}-${pick()}`;
}

// POST /api/code — register a code for a room ID (called by CLI sender)
app.post('/api/code', codeRateLimiter, (req, res) => {
    const { roomId } = req.body || {};
    if (!roomId || !UUID_REGEX.test(roomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    if (codeToRoom.size >= MAX_ACTIVE_CODES) {
        return res.status(503).json({ error: 'Server busy, try again shortly' });
    }
    const code = generateCode();
    codeToRoom.set(code, { roomId, expires: Date.now() + 600000 }); // 10 min TTL
    res.json({ code });
});

// GET /api/code/:code — resolve a code to a room ID (called by CLI receiver)
app.get('/api/code/:code', codeRateLimiter, (req, res) => {
    const entry = codeToRoom.get(req.params.code);
    if (!entry || Date.now() > entry.expires) {
        codeToRoom.delete(req.params.code);
        return res.status(404).json({ error: 'Code not found or expired' });
    }
    res.json({ roomId: entry.roomId });
});

// ---------------------------------------------------------------------------
// Global stats — Upstash Redis (durable) + fast in-memory read cache
//
// GET /api/stats  — served from cachedTotal; zero Redis reads per poll request.
// POST /api/stats/report — receiver peers report bytes after a completed transfer.
//   Validates, increments cachedTotal, then fires INCRBY to Upstash (no-await).
//   Gracefully degrades to in-memory-only when UPSTASH_* env vars are absent.
// ---------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STATS_KEY = 'floe:bytes_total';

let cachedTotal = 0;

async function upstashPost(command) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
    try {
        const resp = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(command),
        });
        if (!resp.ok) return null;
        const { result } = await resp.json();
        return result;
    } catch {
        return null;
    }
}

async function initStats() {
    const val = await upstashPost(['GET', STATS_KEY]);
    if (val !== null) cachedTotal = Number(val) || 0;
}

function validateReportBytes(bytes, maxBytes) {
    return Number.isInteger(bytes) && bytes > 0 && bytes <= maxBytes;
}

app.get('/api/stats', (_req, res) => {
    res.json({ totalBytes: cachedTotal });
});

app.post('/api/stats/report', (req, res) => {
    const ip = req.ip;
    const now = Date.now();

    if (!statsRateLimits.has(ip)) statsRateLimits.set(ip, []);
    const timestamps = statsRateLimits.get(ip).filter(t => now - t < STATS_RATE_WINDOW);
    if (timestamps.length >= STATS_MAX_REPORTS) {
        return res.status(429).json({ error: 'Too many reports' });
    }
    timestamps.push(now);
    statsRateLimits.set(ip, timestamps);

    const { bytes } = req.body || {};
    if (!validateReportBytes(bytes, MAX_REPORT_BYTES)) {
        return res.status(400).json({ error: 'Invalid byte count' });
    }

    cachedTotal += bytes;
    upstashPost(['INCRBY', STATS_KEY, bytes]);

    res.json({ totalBytes: cachedTotal });
});

// ---------------------------------------------------------------------------
// Rate limiting (Socket.IO connections + WebSocket connections share this map)
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const connectionCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
// Configurable so test/staging environments (which drive many connections from a
// single IP) can raise the ceiling. Production keeps the default of 30.
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 30;

function checkRateLimit(ip) {
    const now = Date.now();
    if (!connectionCounts.has(ip)) connectionCounts.set(ip, []);
    const timestamps = connectionCounts.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
    timestamps.push(now);
    connectionCounts.set(ip, timestamps);
    return timestamps.length <= MAX_CONNECTIONS_PER_IP;
}

// Periodic cleanup of old rate limit entries and expired codes
// .unref() so the interval doesn't prevent the process from exiting (e.g. in tests).
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of connectionCounts.entries()) {
        const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (valid.length === 0) connectionCounts.delete(ip);
        else connectionCounts.set(ip, valid);
    }
    for (const [ip, timestamps] of turnRateLimits.entries()) {
        const valid = timestamps.filter(t => now - t < TURN_RATE_WINDOW);
        if (valid.length === 0) turnRateLimits.delete(ip);
        else turnRateLimits.set(ip, valid);
    }
    for (const [ip, timestamps] of statsRateLimits.entries()) {
        const valid = timestamps.filter(t => now - t < STATS_RATE_WINDOW);
        if (valid.length === 0) statsRateLimits.delete(ip);
        else statsRateLimits.set(ip, valid);
    }
    for (const [ip, timestamps] of codeRateLimits.entries()) {
        const valid = timestamps.filter(t => now - t < CODE_RATE_WINDOW);
        if (valid.length === 0) codeRateLimits.delete(ip);
        else codeRateLimits.set(ip, valid);
    }
    for (const [code, entry] of codeToRoom.entries()) {
        if (now > entry.expires) codeToRoom.delete(code);
    }
}, 60000).unref();

// ---------------------------------------------------------------------------
// Unified room registry
//
// Both Socket.IO (browser) and WebSocket (CLI) peers share this registry.
// Each "peer" is a plain object with:
//   { id, type, roomId, send(type, data) }
//
// This means a browser and a CLI can be in the same room and exchange
// WebRTC signals through the same routing logic.
// ---------------------------------------------------------------------------

const rooms = new Map(); // roomId → [peer, peer]

function createSocketIOPeer(socket) {
    return {
        id: socket.id,
        type: 'socketio',
        roomId: null,
        send(type, data) {
            // 'user-connected' historically sent just the peer ID string in the
            // Socket.IO version. Keep this for browser backward compatibility.
            if (type === 'user-connected') {
                socket.emit(type, typeof data === 'object' ? data.id : data);
            } else {
                socket.emit(type, data);
            }
        },
    };
}

function createWSPeer(ws) {
    return {
        id: ws.peerId,
        type: 'ws',
        roomId: null,
        send(type, data) {
            if (ws.readyState !== WebSocket.OPEN) return;
            // Spread data into the top-level object alongside "type"
            ws.send(JSON.stringify({ type, ...data }));
        },
    };
}

function handleJoinRoom(peer, roomId) {
    if (!roomId || typeof roomId !== 'string' || !UUID_REGEX.test(roomId)) {
        peer.send('error', { message: 'Invalid room ID' });
        return;
    }

    // If already in a room, leave it first
    if (peer.roomId) {
        const oldRoom = rooms.get(peer.roomId);
        if (oldRoom) {
            const remaining = oldRoom.filter(p => p.id !== peer.id);
            if (remaining.length === 0) rooms.delete(peer.roomId);
            else rooms.set(peer.roomId, remaining);
        }
        peer.roomId = null;
    }

    const room = rooms.get(roomId) || [];

    if (room.length === 0) {
        room.push(peer);
        rooms.set(roomId, room);
        peer.roomId = roomId;
        peer.send('room-joined', { role: 'sender' });
    } else if (room.length === 1) {
        room.push(peer);
        rooms.set(roomId, room);
        peer.roomId = roomId;
        peer.send('room-joined', { role: 'receiver' });
        // Tell the first peer that a second peer has joined
        room[0].send('user-connected', { id: peer.id });
    } else {
        peer.send('room-full', {});
    }
}

function handleSignal(senderPeer, signal, targetId) {
    if (!signal) return;

    // A peer may only signal within the room it has actually joined. Use the
    // server-tracked roomId (never a client-supplied one) so a peer cannot
    // route signals into a room it is not a member of.
    if (!senderPeer.roomId) return;
    const room = rooms.get(senderPeer.roomId);
    if (!room) return;

    // Every room holds exactly two peers, so the target is always "the other
    // peer in my room". If the client named a specific target, it must match
    // that peer; otherwise the signal is dropped.
    const targetPeer = room.find(p => p.id !== senderPeer.id);
    if (!targetPeer) return;
    if (targetId && targetPeer.id !== targetId) return;

    targetPeer.send('signal', { signal, sender: senderPeer.id });
}

function handleDisconnect(peer) {
    if (!peer.roomId) return;
    const room = rooms.get(peer.roomId);
    if (!room) return;

    // Notify the other peer in the room
    room.forEach(p => {
        if (p.id !== peer.id) {
            p.send('peer-disconnected', {});
            p.roomId = null;
        }
    });

    rooms.delete(peer.roomId);
    peer.roomId = null;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Socket.IO (browser web app — unchanged protocol, new routing backend)
// ---------------------------------------------------------------------------

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    maxHttpBufferSize: 1e6, // Signaling only: SDP/ICE < 10 KB
});

io.use((socket, next) => {
    const ip = getClientIp(socket.handshake.headers['x-forwarded-for'], socket.handshake.address);
    if (!checkRateLimit(ip)) return next(new Error('Rate limit exceeded'));
    next();
});

io.on('connection', (socket) => {
    const peer = createSocketIOPeer(socket);

    socket.on('ping', (callback) => {
        if (typeof callback === 'function') callback();
    });

    socket.on('join-room', (roomId) => {
        handleJoinRoom(peer, roomId);
    });

    socket.on('signal', (data) => {
        if (!data || typeof data !== 'object' || !data.signal) return;
        handleSignal(peer, data.signal, data.target || null);
    });

    socket.on('disconnecting', () => {
        handleDisconnect(peer);
    });

    socket.on('disconnect', () => {});
});

// ---------------------------------------------------------------------------
// WebSocket server — used by CLI clients
// Path: /ws
// ---------------------------------------------------------------------------

// maxPayload caps inbound frames at 1 MB to match Socket.IO's maxHttpBufferSize.
// Signaling carries only SDP/ICE (< 10 KB); larger frames are rejected (close 1009).
const wss = new WebSocketServer({ noServer: true, maxPayload: 1e6 });

// Manually route WebSocket upgrades so the ws library does NOT interfere
// with Socket.IO's own WebSocket upgrade on /socket.io/.
// Without this, ws calls socket.destroy() for paths that don't match '/ws',
// which kills Socket.IO's transport upgrade and forces unreliable long-polling.
server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    }
    // All other paths (e.g. /socket.io/) are left untouched for Socket.IO
});

wss.on('connection', (ws, req) => {
    const ip = getClientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress);
    if (!checkRateLimit(ip)) {
        ws.close(1008, 'Rate limit exceeded');
        return;
    }

    ws.peerId = crypto.randomUUID();
    ws.isAlive = true;

    const peer = createWSPeer(ws);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'join-room':
                handleJoinRoom(peer, msg.roomId);
                break;
            case 'signal':
                handleSignal(peer, msg.signal, msg.target || null);
                break;
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    });

    ws.on('close', () => handleDisconnect(peer));
    ws.on('error', () => handleDisconnect(peer));
});

// Heartbeat: detect and close dead WebSocket connections every 30 seconds
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000).unref();

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Graceful shutdown (SIGTERM from platform, SIGINT from Ctrl-C)
// ---------------------------------------------------------------------------

function shutdown() {
    clearInterval(cleanupInterval);
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
    io.close();
    server.close(() => process.exit(0));
    // Force-exit after 10 s if connections don't drain in time.
    setTimeout(() => process.exit(1), 10_000).unref();
}

// ---------------------------------------------------------------------------
// Entry point — only bind / register OS signals when run directly (not in tests)
// ---------------------------------------------------------------------------

if (require.main === module) {
    server.listen(PORT);
    initStats().catch(() => {}); // seed cachedTotal from Redis on startup
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

// Exported for unit tests — not part of the public API.
module.exports = {
    getClientIp,
    generateCode,
    checkRateLimit,
    handleJoinRoom,
    handleSignal,
    handleDisconnect,
    rooms,
    codeToRoom,
    connectionCounts,
    turnRateLimits,
    validateReportBytes,
    statsRateLimits,
    makeRateLimiter,
    codeRateLimits,
};
