// Load server/.env into process.env for direct (non-Docker) runs. dotenv does not
// override variables already set in the environment, so Docker/platform-injected
// values take precedence.
//
// quiet is explicit because dotenv 17 flipped its default to false. Without it,
// every start prints "injected env (N) from .env" followed by a rotating
// advertisement for the maintainer's paid product. That line is emitted even when
// no .env exists, which is exactly the case in our containers, so it would be the
// first thing in every self-hoster's logs and in every crash-loop iteration.
require('dotenv').config({ quiet: true });

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

// After cors on purpose. A malformed body makes this middleware throw, and the
// error short-circuits straight to the error handler; if cors ran later, that
// response would carry no Access-Control-Allow-Origin and the browser would
// surface a readable 400 as an opaque CORS failure instead.
app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/health', (_req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// ---------------------------------------------------------------------------
// TURN credential generation (server/turn.js)
//
// Required after dotenv.config() above: turn.js reads the two Cloudflare keys
// at require time, and above the dotenv call both would read undefined.
// ---------------------------------------------------------------------------

const {
    turnRateLimits,
    TURN_RATE_WINDOW,
    selectMinimalIceUrls,
    turnCredentialsHandler,
} = require('./turn');

const {
    statsRateLimits,
    STATS_RATE_WINDOW,
    initStats,
    validateReportBytes,
    statsHandler,
    statsReportHandler,
} = require('./stats');

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

app.get('/api/turn-credentials', turnCredentialsHandler);

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

app.get('/api/stats', statsHandler);
app.post('/api/stats/report', statsReportHandler);

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Final error handler. Registered last so it catches anything the routes or the
 * body parser throw.
 *
 * Express's built-in handler is not safe to rely on here. It serialises
 * err.stack into the response body whenever app.get('env') is anything other
 * than exactly 'production', and it never consults err.expose, so the leak is
 * not limited to 5xx: a malformed JSON body is enough to return the absolute
 * path of every frame on the server's filesystem. Getting NODE_ENV right is
 * necessary but it is a single misconfigured environment variable away from
 * regressing, and a blank NODE_ENV= reads the same as unset.
 *
 * So the response never depends on the environment: always JSON (every client
 * in this repo calls resp.json()), always a generic message. The stack still
 * goes to the process log, which is the only place it is useful.
 */
function errorHandler(err, _req, res, _next) {
    const raw = err && err.status;
    const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;

    console.error(err && err.stack ? err.stack : err);

    // Headers already flushed means a route failed mid-response; anything we
    // write now would corrupt it.
    if (res.headersSent) return;

    res.status(status).json({ error: status < 500 ? 'Bad request' : 'Internal server error' });
}

app.use(errorHandler);

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

    // signal is the only peer-supplied value this server serializes: roomId is
    // UUID-checked and target is only compared. JSON.stringify recurses, so a
    // nested-array signal overflows the stack (measured: 2235 levels, a 4.4 KB
    // frame) inside createWSPeer.send for a CLI target or socket.io's encoder
    // for a browser one, and throws where nothing catches it. Silent on purpose:
    // logging per attempt is a flood lever at a rate the caller picks.
    try {
        targetPeer.send('signal', { signal, sender: senderPeer.id });
    } catch {
        // Undeliverable. The peers time out on their own.
    }
}

function handleDisconnect(peer) {
    if (!peer.roomId) return;
    const room = rooms.get(peer.roomId);
    if (!room) return;

    // Remove only the disconnecting peer (same shape as the leave-old-room
    // block in handleJoinRoom). The remaining peer keeps its seat and roomId,
    // so the room survives a one-sided drop: the departed side can rejoin the
    // same room id after a Socket.IO auto-reconnect, and a stale socket's late
    // ping-timeout disconnect removes just its own ghost entry instead of
    // tearing down a room the same user has already rejoined.
    const remaining = room.filter(p => p.id !== peer.id);
    remaining.forEach(p => p.send('peer-disconnected', {}));
    if (remaining.length === 0) rooms.delete(peer.roomId);
    else rooms.set(peer.roomId, remaining);
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

// Answer an upgrade we will not complete, then close. Same shape as ws's own
// abortHandshake. A bare destroy would also work; a reason on the wire is what
// makes a misconfigured proxy diagnosable.
function refuseUpgrade(socket, code) {
    if (!socket.writable) {
        socket.destroy();
        return;
    }
    const body = http.STATUS_CODES[code] || 'Bad Request';
    socket.once('finish', () => socket.destroy());
    socket.end(
        `HTTP/1.1 ${code} ${body}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body
    );
}

// Manually route WebSocket upgrades so the ws library does NOT interfere
// with Socket.IO's own WebSocket upgrade on /socket.io/.
// Without this, ws calls socket.destroy() for paths that don't match '/ws',
// which kills Socket.IO's transport upgrade and forces unreliable long-polling.
function handleUpgradeRequest(req, socket, head) {
    // First, before anything below can throw. Node removes its own socket
    // 'error' listener before emitting 'upgrade', and for a target neither we
    // nor engine.io claims nothing attaches another, so a client reset in that
    // window is an unhandled 'error' event. ws attaches its own in setSocket, so
    // a completed /ws connection is unaffected.
    socket.on('error', () => {});

    // req.url is a raw request target, not a URL. Node's parser accepts several
    // that WHATWG URL rejects ("//", "///", "//?", "//[", "//@", "//%"), and a
    // throw here runs synchronously inside the listener. new URL rather than a
    // split on '?' because it also matches the absolute-form target
    // (GET http://api.floe.one/ws HTTP/1.1) some proxies send.
    let pathname;
    try {
        pathname = new URL(req.url, 'http://x').pathname;
    } catch {
        refuseUpgrade(socket, 400);
        return;
    }

    if (pathname !== '/ws') return;

    // engine.io claims a socket by a literal prefix compare on the UNPARSED
    // target (`path === req.url.slice(0, path.length)`) while the line above
    // compares a normalized pathname, so "/socket.io/../ws?EIO=4" satisfies
    // both. engine.io runs first and has already upgraded the socket, and
    // completing it twice throws. Reusing engine.io's own predicate, rather than
    // matching dot segments, covers the %2e%2e and backslash spellings too.
    if (req.url.startsWith(io.path() + '/')) return;

    // Any future drift between the two routers lands on that same throw.
    // Destroy rather than refuse: reaching here means someone else may own this
    // socket, and writing a 400 into one engine.io has upgraded puts
    // "HTTP/1.1 400 Bad Request" mid-stream in a live WebSocket (measured).
    try {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } catch {
        socket.destroy();
    }
}

server.on('upgrade', handleUpgradeRequest);

wss.on('connection', (ws, req) => {
    // Before the rate-limit return below, which never reaches the real handler
    // at the foot of this function. ws emits 'error' on the WebSocket for any
    // framing fault (an unmasked frame is 4 bytes), close() only starts the
    // handshake and leaves the Receiver reading for 30s, and an 'error' with no
    // listener throws. Both listeners run; handleDisconnect is idempotent.
    ws.on('error', () => {});

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

        // JSON.parse('null') returns null without throwing, so the catch above
        // does not cover it and reading .type raises a TypeError inside a ws
        // 'message' listener, where nothing catches it: a 4-byte frame ends the
        // process. Same guard the Socket.IO signal handler already applies.
        if (!msg || typeof msg !== 'object') return;

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
    // Mandatory once uncaughtException is handled below, or a bind failure
    // (EADDRINUSE, EACCES) is absorbed by it and the process stays alive
    // listening to nothing. Removed once bound: left attached it also fires for
    // post-listen accept errors (EMFILE, ENFILE), which would make exhausting
    // the descriptor table another way to end the process.
    const failFastOnBindError = (err) => {
        console.error('HTTP server error:', err);
        process.exit(1);
    };
    server.on('error', failFastOnBindError);

    // Log and keep serving. Rooms, codes and the stats total are in memory, so
    // exiting drops every transfer in progress, and a caller who can reach a
    // throw on demand would burn PM2's max_restarts and take the server down for
    // good: the exit IS the attack. No crash budget, for the same reason.
    //
    // A backstop, not a repair. Measured: a throw out of a ws 'message' listener
    // leaves that Receiver stuck mid-write, so ws never emits 'close',
    // handleDisconnect never runs, and the peer leaks from `rooms` and
    // `wss.clients` for the life of the process, poisoning that room id. The
    // heartbeat reaps the descriptor, not the seat. Hence every throw we know of
    // is fixed at its source above rather than left to this, and
    // crashguard.test.js fails on an "Unhandled error" line reaching here.
    //
    // Also catches unhandled rejections, which arrive with origin
    // 'unhandledRejection' (verified on Node 20, 22 and 24, the CI, dev and
    // image versions), so a separate handler for them would be dead code.
    //
    // Inside require.main so `node --test` keeps Node's default behavior.
    process.on('uncaughtException', (err, origin) => {
        console.error(`Unhandled error (${origin}), server still serving:`, err);
    });

    server.listen(PORT, () => server.off('error', failFastOnBindError));
    initStats().catch(() => {}); // seed cachedTotal from Redis on startup
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

// Exported for unit tests — not part of the public API.
module.exports = {
    errorHandler,
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
    selectMinimalIceUrls,
};
