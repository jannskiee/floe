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
const { rateKey } = require('./ratekey');
const { HOST_TOKEN_REGEX, hostTokenHash, roomIdFromToken } = require('./hosttoken');

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

// A room id must be a UUID. handleJoinRoom and POST /api/code both check it,
// and client/lib/roomLink.ts mirrors the pattern, so keep the two in step.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
// `features` is read from the policy store on every request, never cached, so
// it flips in the same cleanup tick as the handlers the store gates. Always
// present: [] tells a client "new server, request links off" apart from an old
// server, which has no key at all.
function healthHandler(_req, res) {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        features: policyStore.requestLinks() ? ['request-1'] : [],
    });
}
app.get('/health', healthHandler);

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

app.get('/api/turn-credentials', turnCredentialsHandler);

// ---------------------------------------------------------------------------
// Global stats counter (server/stats.js)
//
// Required after dotenv.config() above for the same reason as turn.js:
// stats.js reads the two Upstash keys and MAX_REPORT_BYTES at require time.
// ---------------------------------------------------------------------------

const {
    statsRateLimits,
    STATS_RATE_WINDOW,
    initStats,
    validateReportBytes,
    statsHandler,
    statsReportHandler,
} = require('./stats');

app.get('/api/stats', statsHandler);
app.post('/api/stats/report', statsReportHandler);

// ---------------------------------------------------------------------------
// Request-link policy (server/policy.js)
//
// The kill switch for request links. POLICY_FILE is an absolute path read from
// the environment once, here; the file's CONTENT is re-read on every cleanup
// tick, so flipping the feature needs no restart. Unset or empty means no file,
// which means request links are off. Read once now, before server.listen, so
// /health is right from the first request.
// ---------------------------------------------------------------------------

const { createPolicyStore } = require('./policy');

const policyStore = createPolicyStore({
    path: process.env.POLICY_FILE || '',
    onChange: applyPolicyChange,
});
try { policyStore.reload(); } catch { /* fails closed: the store starts off */ }

// ---------------------------------------------------------------------------
// Code phrase API  (/api/code)
// CLI callers use this to generate and resolve short human-readable codes.
// ---------------------------------------------------------------------------

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
// A second, much tighter budget for FAILED resolves only, on the same 60 s
// window and the same key as the limiter above. The shared 60/min ceiling is a
// volume control, not a guessing control: it lets one address try 60 phrases a
// minute forever. A real receiver never misses more than a handful of times (a
// typo, a stale code), so charging only misses costs legitimate use nothing
// while cutting an address's guessing rate by six.
const codeFailures = new Map(); // rate key → [timestamps of failed resolves]
const CODE_FAIL_MAX = parseInt(process.env.MAX_FAILED_CODE_RESOLVES, 10) || 10;

// Generic per-IP sliding-window limiter as Express middleware. req.ip resolves
// correctly via the `trust proxy` setting above, matching the turn/stats logic.
function makeRateLimiter(map, windowMs, max) {
    return (req, res, next) => {
        const now = Date.now();
        const key = rateKey(req.ip);
        const timestamps = (map.get(key) || []).filter(t => now - t < windowMs);
        if (timestamps.length >= max) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        timestamps.push(now);
        map.set(key, timestamps);
        next();
    };
}
const codeRateLimiter = makeRateLimiter(codeRateLimits, CODE_RATE_WINDOW, CODE_MAX_REQUESTS);

const words = require('./words.json');
const codeToRoom = new Map(); // code → { roomId, expires }
// Reverse index, so a room can retire its own code without scanning codeToRoom.
// It holds only room ids the server already knows; it is never serialized into a
// response, so it cannot leak a room id to a caller.
const roomToCode = new Map(); // roomId → code

// Both directions verify the other side before deleting. generateCode reuses a
// code whose entry has expired but has not been swept yet, so for up to a
// cleanup interval the same phrase can be the live code of a new room while it
// is still the stale reverse entry of an old one. Without these checks,
// retiring the old room would delete the new room's working code.
function dropCode(code, roomId) {
    codeToRoom.delete(code);
    if (roomToCode.get(roomId) === code) roomToCode.delete(roomId);
}

// Retire whatever code a room currently owns. Idempotent, and a no-op for a
// room that never registered one (a browser-to-browser link transfer).
function forgetCode(roomId) {
    const code = roomToCode.get(roomId);
    if (code === undefined) return;
    roomToCode.delete(roomId);
    const entry = codeToRoom.get(code);
    if (entry && entry.roomId === roomId) codeToRoom.delete(code);
}

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
//
// One live code per room. A sender that registers twice (a retry, a restart)
// used to leave both phrases working, so a guess against either opened the same
// room and the room's exposure grew with every retry. Retiring first also frees
// the room's own MAX_ACTIVE_CODES slot, so a re-registration can never be the
// request that pushes the table over its ceiling.
function registerCodeHandler(req, res) {
    const { roomId } = req.body || {};
    if (!roomId || !UUID_REGEX.test(roomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    // A request room is seated by its host token and request-join, never by a
    // code, so no phrase may ever alias one. Same answer as a malformed id.
    const reserved = typeof roomId === 'string' ? roomMeta.get(roomId.toLowerCase()) : undefined;
    if (reserved && reserved.kind === 'request') {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    forgetCode(roomId);
    if (codeToRoom.size >= MAX_ACTIVE_CODES) {
        return res.status(503).json({ error: 'Server busy, try again shortly' });
    }
    const code = generateCode();
    codeToRoom.set(code, { roomId, expires: Date.now() + 600000 }); // 10 min TTL
    roomToCode.set(roomId, code);
    res.json({ code });
}
app.post('/api/code', codeRateLimiter, registerCodeHandler);

// GET /api/code/:code — resolve a code to a room ID (called by CLI receiver)
//
// The budget is spent before the lookup, never after, so a caller that has run
// out learns nothing from the answer: the 429 is byte-identical whether the
// phrase it asked about is live, expired or was never registered, and it never
// carries a room id. A hit costs nothing, so a receiver holding a real code is
// never turned away by its own retries. A miss costs one.
//
// No log line when the budget runs out: the key is derived from a client
// address, so logging it logs addresses, and logging without it hands an
// anonymous caller a line-per-request flood lever.
function resolveCodeHandler(req, res) {
    const now = Date.now();
    const key = rateKey(req.ip);
    const failures = (codeFailures.get(key) || []).filter(t => now - t < CODE_RATE_WINDOW);
    if (failures.length >= CODE_FAIL_MAX) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    const entry = codeToRoom.get(req.params.code);
    if (!entry || now > entry.expires) {
        // Sweep an expired entry through dropCode so the reverse index cannot
        // outlive the forward one.
        if (entry) dropCode(req.params.code, entry.roomId);
        failures.push(now);
        codeFailures.set(key, failures);
        // Body unchanged: cli/engine/code/client.go branches on this 404.
        return res.status(404).json({ error: 'Code not found or expired' });
    }
    res.json({ roomId: entry.roomId });
}
app.get('/api/code/:code', codeRateLimiter, resolveCodeHandler);

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

const connectionCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
// Configurable so test/staging environments (which drive many connections from a
// single IP) can raise the ceiling. Production keeps the default of 30.
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 30;

// Counts admitted connections only: a refused attempt is not recorded. Recording
// it (the old push-then-compare) let a client that retries faster than the limit,
// or many clients behind one address reconnecting after a restart or a proxy
// reload, keep its own window full and stay blocked for as long as it retried.
function checkRateLimit(ip) {
    const key = rateKey(ip);
    const now = Date.now();
    const timestamps = (connectionCounts.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
    if (timestamps.length >= MAX_CONNECTIONS_PER_IP) {
        connectionCounts.set(key, timestamps);
        return false;
    }
    timestamps.push(now);
    connectionCounts.set(key, timestamps);
    return true;
}

// Periodic cleanup of old rate limit entries and expired codes
function cleanupTick(now = Date.now()) {
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
    for (const [key, timestamps] of codeFailures.entries()) {
        const valid = timestamps.filter(t => now - t < CODE_RATE_WINDOW);
        if (valid.length === 0) codeFailures.delete(key);
        else codeFailures.set(key, valid);
    }
    // dropCode, not codeToRoom.delete: the reverse index has to go in step.
    for (const [code, entry] of codeToRoom.entries()) {
        if (now > entry.expires) dropCode(code, entry.roomId);
    }
    // Last, and in its own try/catch: a throw inside a setInterval callback
    // reaches the process backstop (crashguard.test.js fails on that line).
    try { policyStore.reload(); } catch { /* keep the last good policy */ }
    // A reservation whose host has been gone for longer than the grace ends
    // here, so the effective grace is 10 to 11 minutes (exactly 10 on a reclaim
    // attempt, the lazy check in handleHostJoin).
    try {
        for (const [roomId, meta] of roomMeta) {
            if (meta.kind === 'request' && meta.hostPeerId === null && now - meta.hostAbsentSince > REQUEST_GRACE_MS) {
                endReservation(roomId);
            }
        }
    } catch { /* the next tick sweeps again */ }
    try {
        for (const [roomId, meta] of roomMeta) {
            if (meta.kind === 'request' && now - meta.createdAt > REQUEST_MAX_AGE_MS) endReservation(roomId);
        }
    } catch { /* the next tick sweeps again */ }
    try {
        for (const [key, ts] of requestCreates) {
            const valid = ts.filter(t => now - t < REQUEST_CREATE_WINDOW_MS);
            if (valid.length === 0) requestCreates.delete(key);
            else requestCreates.set(key, valid);
        }
    } catch { /* the next tick trims again */ }
}

// .unref() so the interval doesn't prevent the process from exiting (e.g. in tests).
const cleanupInterval = setInterval(() => cleanupTick(), 60000).unref();

// ---------------------------------------------------------------------------
// Unified room registry
//
// Both Socket.IO (browser) and WebSocket (CLI) peers share this registry.
// Each "peer" is a plain object with:
//   { id, type, key, roomId, send(type, data) }
// where key is the rateKey of the address the connection was admitted under.
//
// This means a browser and a CLI can be in the same room and exchange
// WebRTC signals through the same routing logic.
// ---------------------------------------------------------------------------

const rooms = new Map(); // roomId → [peer, peer]

// One record per live room, created with the room and deleted with it in
// destroyRoom, so it can never outlive the room or hold more entries than
// `rooms` does. `keys` holds the sealDigest of every rate key whose peer has
// routed a signal in the room (handleSignal), including peers that have since
// left: that history is what the seal in handleJoinRoom reads.
const roomMeta = new Map(); // roomId → { keys: Set<sealDigest(rateKey)> }

// The seal tells keys apart without keeping them. A rate key is an address (an
// IPv4 address in full, an IPv6 /64), a room can live for hours, and the
// privacy page promises an IP address is kept at most about two minutes. So a
// room keeps an HMAC-SHA256 of each key under a secret drawn once per process:
// equal keys still match within this process, hashing every IPv4 address does
// not reverse a digest, and every digest means nothing after a restart. The
// secret lives in this binding only. Never log, print, export or persist it.
const SEAL_SECRET = crypto.randomBytes(32);

// String() so a missing key digests as 'undefined' (one shared key, which the
// seal fails open for) instead of throwing inside update() on the
// unauthenticated join and signal paths.
function sealDigest(key) {
    return crypto.createHmac('sha256', SEAL_SECRET).update(String(key)).digest('base64');
}

// The single way a room stops existing. A room that is gone must not leave a
// working code behind it: the phrase is the whole secret, and a code outliving
// its room is a phrase an attacker can still guess for whatever is created at
// that id next. Every rooms.delete goes through here.
//
// A request room is the one exception to "the record dies with the room": its
// reservation outlives the empty room so the host can reclaim its seat with the
// token, and only endReservation (grace expiry, request-close, a policy purge)
// ends it (spec 04 5.12).
function destroyRoom(roomId) {
    rooms.delete(roomId);
    const meta = roomMeta.get(roomId);
    if (!(meta && meta.kind === 'request')) roomMeta.delete(roomId);
    forgetCode(roomId);
}

// ---------------------------------------------------------------------------
// Request rooms (Request link, Stage 1)
//
// A room reserved by a host token rather than by join order. Floe Desktop joins
// /ws with join-room {roomId, hostToken}; the room id must be the derivation of
// the token (server/hosttoken.js), and the server keeps only SHA-256(token).
// Seat 0 is whoever presents the token, never array position; the visitor comes
// in through request-join, which never creates a room.
//
// A reservation is a bounded exception to "no room metadata outliving its
// room": created only by a token join, at most REQUEST_CREATES_PER_DAY per rate
// key per rolling 24 h and MAX_REQUEST_ROOMS live, and ended REQUEST_GRACE_MS
// after its host socket closes. A flood of the cap refuses only new request
// links (limited), never ordinary rooms, codes or the room seal.
//
// Privacy: the record holds a digest of the host's rate key (sealDigest), never
// the key, and requestCreates is keyed the same way; a reservation can live for
// days and the privacy page promises an address is kept at most about two
// minutes. Nothing here logs: no id, token, key or address, and no per-attempt
// line (a flood lever).
// ---------------------------------------------------------------------------

// FLOE_TEST_REQUEST_GRACE_MS is a test knob like HEARTBEAT_MS, not an
// operator setting: server/crashguard.test.js shortens the grace so a spawned
// server's real sweep ends reservations on its first cleanup tick. It can only
// shorten the grace, never lengthen it; production leaves it unset.
const REQUEST_GRACE_FULL_MS = 10 * 60 * 1000;
const REQUEST_GRACE_MS = (() => {
    const n = parseInt(process.env.FLOE_TEST_REQUEST_GRACE_MS, 10);
    return Number.isSafeInteger(n) && n >= 0 && n < REQUEST_GRACE_FULL_MS ? n : REQUEST_GRACE_FULL_MS;
})();
const REQUEST_CREATES_PER_DAY = 20;
const REQUEST_CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// A constant, not an env var (D-088 G6).
const MAX_REQUEST_ROOMS = 5000;
// Per socket, per rolling 60 s (D-023). The window lives on the peer object,
// so it dies with the socket and needs no map and no sweep.
const REQUEST_JOINS_PER_MINUTE = 30;
const REQUEST_JOIN_WINDOW_MS = 60 * 1000;
// A reservation older than the longest link life (7 days) plus the grace ends
// at the next sweep, sealed or not (D-021): a drop is capped at 24 h, and a
// modified desktop could otherwise hold one for as long as its socket lives.
const REQUEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

// sealDigest(rateKey) -> timestamps of successful creates inside the window, at
// most REQUEST_CREATES_PER_DAY each. Written only on a successful create, which
// already took an admitted connection; trimmed by cleanupTick.
//
// At most REQUEST_CREATE_KEYS_MAX keys (D-116). The per-key budget cannot bind
// an attacker holding many keys (IPv6 /64s, or any X-Forwarded-For on a
// self-host exposed directly), and a create followed by request-close frees its
// MAX_REQUEST_ROOMS slot, so without a ceiling the log grows by one entry per
// key per day. Past the ceiling the least recently created key is dropped
// (an expired one first, since the Map is kept in last-create order): never a
// limited answer to a new key, which would let one many-key caller stop every
// request link for a day. Dropping a key's history can only give that key a
// fresh budget; MAX_REQUEST_ROOMS stays the global bound on live reservations.
// Measured cost at the ceiling (Node 22, heapUsed after gc): about 3.0 MB with
// one timestamp per key (299 B a key) and about 5.0 MB with the full 20.
const REQUEST_CREATE_KEYS_MAX = 10000;
const requestCreates = new Map();

function createsInWindow(key, now = Date.now()) {
    const ts = requestCreates.get(sealDigest(key));
    if (!ts) return 0;
    let n = 0;
    for (const t of ts) if (now - t < REQUEST_CREATE_WINDOW_MS) n++;
    return n;
}

function recordCreate(key, now = Date.now()) {
    const digest = sealDigest(key);
    const ts = (requestCreates.get(digest) || []).filter(t => now - t < REQUEST_CREATE_WINDOW_MS);
    ts.push(now);
    // Re-inserted at the back, so the Map stays in last-create order and its
    // first key is always the one to drop.
    requestCreates.delete(digest);
    while (requestCreates.size >= REQUEST_CREATE_KEYS_MAX) {
        requestCreates.delete(requestCreates.keys().next().value);
    }
    requestCreates.set(digest, ts);
}

// The live request-room ids, kept in step with roomMeta so the global cap in
// handleHostJoin is one size read: a refused create at a full cap would
// otherwise walk every room (ordinary ones too) on every frame, and it spends
// no budget, so one socket could repeat it. A request meta enters roomMeta
// only in handleHostJoin and leaves only through forgetReservation.
const requestRoomIds = new Set();

// A walk, kept as the test oracle for requestRoomIds.
function countRequestRooms() {
    let n = 0;
    for (const meta of roomMeta.values()) if (meta.kind === 'request') n++;
    return n;
}

function forgetReservation(roomId) {
    roomMeta.delete(roomId);
    requestRoomIds.delete(roomId);
}

// Silent: a sealed visitor's drop runs on its data channel and needs nothing
// more from this server.
function endReservation(roomId) {
    for (const p of rooms.get(roomId) || []) p.roomId = null;
    rooms.delete(roomId);
    forgetReservation(roomId);
}

// A member of a request room leaves it: its socket closed (handleDisconnect)
// or it joined somewhere else. Spec 04 5.6.8.
//
// The host leaving starts the grace: hostPeerId is cleared and
// hostAbsentSince stamped, and the reservation stays. An unsealed visitor is
// sent back to Host absent and loses its seat, because the host's Go client
// never reconnects within a session and a reclaiming host is a new peer that an
// old half-negotiated visitor could not answer; its Try again pairs cleanly. A
// sealed visitor keeps its seat and hears peer-disconnected: its drop runs on
// the data channel, which needs nothing from this server.
//
// The visitor leaving frees seat 1 and tells the host peer-disconnected. A
// sealed room stays sealed, so a later request-join answers room-full until the
// host reopens.
function leaveRequestRoom(peer, meta, now = Date.now()) {
    const roomId = peer.roomId;
    const remaining = (rooms.get(roomId) || []).filter(p => p.id !== peer.id);
    if (peer.id === meta.hostPeerId) {
        meta.hostPeerId = null;
        meta.hostAbsentSince = now;
        if (!meta.sealed) {
            for (const v of remaining) {
                v.roomId = null;
                try { v.send('host-absent', {}); } catch { /* undeliverable */ }
            }
            rooms.delete(roomId);
        } else {
            for (const v of remaining) {
                try { v.send('peer-disconnected', {}); } catch { /* undeliverable */ }
            }
            if (remaining.length) rooms.set(roomId, remaining);
            else rooms.delete(roomId);
        }
    } else {
        for (const h of remaining) {
            try { h.send('peer-disconnected', {}); } catch { /* undeliverable */ }
        }
        if (remaining.length) rooms.set(roomId, remaining);
        else rooms.delete(roomId);
    }
    peer.roomId = null;
}

// The leave-first step of a join, for the request handlers.
function leaveCurrentRoom(peer) {
    if (!peer.roomId) return;
    const current = roomMeta.get(peer.roomId);
    if (current && current.kind === 'request') {
        leaveRequestRoom(peer, current);
        return;
    }
    const oldRoom = rooms.get(peer.roomId);
    if (oldRoom) {
        const remaining = oldRoom.filter(p => p.id !== peer.id);
        if (remaining.length === 0) destroyRoom(peer.roomId);
        else rooms.set(peer.roomId, remaining);
    }
    peer.roomId = null;
}

// Newest valid host wins. After a laptop sleeps, the host's old socket can
// survive 30 to 60 s; the token holder's new socket replaces that ghost rather
// than being locked out by it. The ghost's roomId is cleared, so its later
// close is a no-op in handleDisconnect. No user-connected is re-sent.
//
// A replacement is the host departure the server never saw (D-116), so an
// UNSEALED room loses its visitor exactly as leaveRequestRoom would have done
// it: host-absent, seat cleared. That visitor was paired with the dead socket
// and cannot answer the new host's offer; left seated, it would hold seat 1
// against the invited person while the new host waits for a user-connected
// that never comes. Its Try again then pairs cleanly. A sealed visitor stays:
// its drop runs on the data channel.
function reclaimHostSeat(peer, roomId, meta, now = Date.now()) {
    if (peer.roomId && peer.roomId !== roomId) leaveCurrentRoom(peer, now);
    const room = rooms.get(roomId) || [];
    const old = room.find(p => p.id === meta.hostPeerId);
    if (old && old.id !== peer.id) {
        room.splice(room.indexOf(old), 1);
        old.roomId = null;
    }
    if (!meta.sealed && meta.hostPeerId !== peer.id) {
        for (const v of room.filter(p => p.id !== peer.id)) {
            room.splice(room.indexOf(v), 1);
            v.roomId = null;
            try { v.send('host-absent', {}); } catch { /* undeliverable */ }
        }
    }
    if (!room.includes(peer)) room.push(peer);
    rooms.set(roomId, room);
    peer.roomId = roomId;
    meta.hostPeerId = peer.id;
    meta.hostAbsentSince = null;
    peer.send('room-joined', { role: 'host' });
}

// A request room seals by itself once both seats have routed a signal
// (D-116), the signal-time rule the room seal uses for ordinary rooms
// (D-113): a pair that has exchanged an offer and an answer is the pair the
// drop runs between. request-seal stays the host's explicit, idempotent
// confirmation, but it cannot be the only seal: if the visitor's socket drops
// between the data channel opening and the host's seal frame, that seal finds
// seat 1 empty, and a third party could be seated (and the host sent
// user-connected) in the middle of the drop.
//
// `signaled` holds the ids of seated peers that have routed a signal in the
// current pairing, at most the host and one visitor: it is cleared when a
// visitor is seated and on reopen, and nothing is added once sealed. A visitor
// offered to that leaves before answering has received nothing, so the room
// stays open for the next one.
function noteRequestSignal(meta, sender, target) {
    if (meta.sealed) return;
    meta.signaled.add(sender.id);
    if (meta.signaled.has(target.id)) meta.sealed = true;
}

// The per-socket request-join budget. A frame past it is dropped before any
// lookup: no reply, no room change, no log line, so a flooder gets nothing to
// tune against and one socket can make the server do at most 30 lookups and
// 30 small replies a minute.
function requestJoinAllowed(peer, now = Date.now()) {
    const budget = peer.joinBudget;
    if (!budget || now - budget.windowStart >= REQUEST_JOIN_WINDOW_MS) {
        peer.joinBudget = { windowStart: now, count: 1 };
        return true;
    }
    if (budget.count >= REQUEST_JOINS_PER_MINUTE) return false;
    budget.count++;
    return true;
}

// request-join over Socket.IO (the /r page) or /ws (a CLI visitor). Never
// creates a room and never takes seat 0. Precedence (spec 04 5.6.4): the
// budget, the id's shape, the kill switch (which wins over every other
// answer), then host-absent for an unknown or ordinary id alike (no existence
// oracle), an idempotent re-join, room-full for a sealed link (the truthful
// answer while its host is briefly away), host-absent for an empty seat 0,
// room-full for a full room, and only then the seat. The two-key room seal
// is not applied here: seat 0 is token-held and seat 1 is closed by
// request-seal, so a visitor sharing the host's address is seated.
function handleRequestJoin(peer, roomId, now = Date.now()) {
    if (!requestJoinAllowed(peer, now)) return;
    if (typeof roomId !== 'string' || !UUID_REGEX.test(roomId)) {
        peer.send('error', { message: 'Invalid room ID' });
        return;
    }
    if (!policyStore.requestLinks()) {
        peer.send('disabled', {});
        return;
    }
    const id = roomId.toLowerCase();
    const meta = roomMeta.get(id);
    if (!meta || meta.kind !== 'request') {
        peer.send('host-absent', {});
        return;
    }
    if (peer.roomId === id) return; // already seated here: no second user-connected
    if (meta.sealed) {
        peer.send('room-full', {});
        return;
    }
    if (meta.hostPeerId === null) {
        peer.send('host-absent', {});
        return;
    }
    const room = rooms.get(id);
    if (!room || room.length >= 2) {
        peer.send('room-full', {});
        return;
    }
    const host = room.find(p => p.id === meta.hostPeerId);
    if (!host) {
        peer.send('host-absent', {}); // defensive: a seated host is always in the array
        return;
    }

    leaveCurrentRoom(peer);
    room.push(peer);
    peer.roomId = id;
    meta.signaled.clear(); // a new pairing: both seats must signal again
    peer.send('request-joined', { role: 'visitor' });
    try {
        host.send('user-connected', { id: peer.id });
    } catch {
        // Undeliverable; the host times out on its own.
    }
}

// request-seal, request-reopen and request-close over /ws, from the host only
// (spec 04 5.6.6). Silent on any mismatch, like handleSignal: no oracle and no
// reply to amplify. The length check keeps a 1 MB id from being lowercased.
// The reservation is looked up before the membership check, so the lookup's
// null check is the guard between an unknown room and a property read.
//
// seal: the data channel is open; a later request-join answers room-full.
// A no-op without a seated visitor.
// reopen: after a Decline the owner chose to keep waiting on, or a failed
// setup. A seated visitor (a squatter, or a declined page that never leaves:
// there is no leave message) is evicted with room-full, and the room unseals.
// close: the room and its reservation are gone; a later request-join answers
// host-absent. An unsealed visitor hears host-absent; a sealed one is left to
// its data channel.
function handleRequestControl(peer, type, roomId) {
    if (typeof roomId !== 'string' || roomId.length !== 36) return;
    const id = roomId.toLowerCase();
    const meta = roomMeta.get(id);
    if (!meta || meta.kind !== 'request' || meta.hostPeerId !== peer.id || peer.roomId !== id) return;
    const room = rooms.get(id) || [];
    const visitor = room.find(p => p.id !== peer.id);

    if (type === 'request-seal') {
        if (visitor) meta.sealed = true;
        return;
    }
    if (type === 'request-reopen') {
        if (visitor) {
            room.splice(room.indexOf(visitor), 1);
            visitor.roomId = null;
            try { visitor.send('room-full', {}); } catch { /* undeliverable */ }
        }
        meta.sealed = false;
        meta.signaled.clear();
        return;
    }
    if (type === 'request-close') {
        if (visitor) {
            visitor.roomId = null;
            if (!meta.sealed) {
                try { visitor.send('host-absent', {}); } catch { /* undeliverable */ }
            }
        }
        rooms.delete(id);
        forgetReservation(id);
        peer.roomId = null;
    }
}

// join-room {roomId, hostToken} over /ws. The check order is a security
// property (spec 04 5.6.2): shape checks first, the token regex before any
// hash, then the derivation (one SHA-256) BEFORE the policy check so a
// malformed or foreign token never learns the flag state, then the policy,
// then the lookup with a constant-time compare of two 32-byte digests, and the
// limits before anything is created. Replies are server constants only.
function handleHostJoin(peer, roomId, hostToken, now = Date.now()) {
    if (typeof roomId !== 'string' || !UUID_REGEX.test(roomId)) {
        peer.send('error', { message: 'Invalid room ID' });
        return;
    }
    if (typeof hostToken !== 'string' || !HOST_TOKEN_REGEX.test(hostToken)) {
        peer.send('error', { message: 'Invalid host token' });
        return;
    }
    // Lowercase, the derivation's own spelling, is the one key the room lives
    // under, whatever case the host sent.
    const id = roomIdFromToken(hostToken);
    if (roomId.toLowerCase() !== id) {
        peer.send('error', { message: 'Invalid host token' });
        return;
    }
    if (!policyStore.requestLinks()) {
        peer.send('refused', { code: 'disabled' });
        return;
    }

    const presented = hostTokenHash(hostToken);
    const meta = roomMeta.get(id);
    if (meta && meta.kind === 'request') {
        if (!crypto.timingSafeEqual(presented, meta.hostTokenHash)) {
            peer.send('room-full', {});
            return;
        }
        if (meta.hostPeerId === null && now - meta.hostAbsentSince > REQUEST_GRACE_MS) {
            endReservation(id); // lazy expiry, then a fresh (counted) create below
        } else {
            reclaimHostSeat(peer, id, meta, now); // not counted against the daily budget
            return;
        }
    }
    // Never convert an ordinary room into a reserved one.
    if (roomMeta.has(id) || rooms.has(id)) {
        peer.send('room-full', {});
        return;
    }
    if (createsInWindow(peer.key, now) >= REQUEST_CREATES_PER_DAY) {
        peer.send('refused', { code: 'limited' });
        return;
    }
    if (requestRoomIds.size >= MAX_REQUEST_ROOMS) {
        peer.send('refused', { code: 'limited' });
        return;
    }

    leaveCurrentRoom(peer);
    roomMeta.set(id, {
        keys: new Set(), // the room seal's field; a join never counts (handleSignal)
        kind: 'request',
        hostTokenHash: presented,
        hostPeerId: peer.id,
        hostKey: sealDigest(peer.key),
        sealed: false,
        signaled: new Set(), // peer ids, not keys: who has signaled in this pairing (noteRequestSignal)
        createdAt: now,
        hostAbsentSince: null,
    });
    requestRoomIds.add(id);
    rooms.set(id, [peer]);
    peer.roomId = id;
    recordCreate(peer.key, now);
    peer.send('room-joined', { role: 'host' });
}

// Runs after the policy store swapped in a new policy whose effective flag
// changed. When request links go from on to off, every UNSEALED request room is
// ended: the seated host is told refused {code:'disabled'}, a seated visitor
// disabled, and both lose their seat. A sealed room is left alone, because its
// drop runs on its data channel and needs nothing more from this server.
// Nothing here logs: the store already wrote its one fixed line.
function applyPolicyChange(prev, next) {
    if (!(prev && prev.requestLinks === true) || (next && next.requestLinks === true)) return;
    for (const [roomId, meta] of roomMeta) {
        if (meta.kind !== 'request' || meta.sealed) continue;
        for (const p of rooms.get(roomId) || []) {
            p.roomId = null;
            try {
                if (p.id === meta.hostPeerId) p.send('refused', { code: 'disabled' });
                else p.send('disabled', {});
            } catch {
                // Undeliverable; the peer times out on its own.
            }
        }
        rooms.delete(roomId);
        forgetReservation(roomId);
    }
}

function createSocketIOPeer(socket, key) {
    return {
        id: socket.id,
        type: 'socketio',
        key,
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

// One full inbound frame (the wss maxPayload below). A whole signaling exchange
// is under 10 KB, so a /ws target holding more than one frame's worth of undrained
// output is not reading, and everything further aimed at it accumulates in this
// process's heap. Measured before this bound: one attacker pair, the flooder and
// a partner that paused its socket, grew the server's working set by 157 MB in
// about 3.2 seconds and was still climbing when the probe stopped itself. With
// the bound in place the same probe ran its full 30 seconds instead of stopping
// itself: 2600 frames offered, 94 MB peak, 30 MB above where it started.
const WS_SEND_BUFFER_CEILING = 1e6;

function createWSPeer(ws, key) {
    return {
        id: ws.peerId,
        type: 'ws',
        key,
        roomId: null,
        send(type, data) {
            if (ws.readyState !== WebSocket.OPEN) return;
            // Checked before every send, so what one peer can aim at another
            // through this path is bounded at the ceiling plus the one frame in
            // flight, about 2 MB. That is the bound on this path alone: the
            // app-level ping reply further down answers on the socket's own
            // behalf without coming through here, so a socket's total is that
            // reply's backlog on top of this. Terminate rather than drop: a peer
            // this far behind has already stopped being a peer, and dropping
            // alone would leave the queued megabyte held for the life of the
            // socket. Silent, though not for a rate reason: terminate() moves
            // readyState to CLOSING synchronously, so the guard above swallows
            // every later send and this branch can fire at most once per socket,
            // which connection creation already bounds. It stays silent because
            // this change is scoped to the bound itself, which leaves the path
            // with no counter and no log line for an operator to see.
            if (ws.bufferedAmount > WS_SEND_BUFFER_CEILING) {
                ws.terminate();
                return;
            }
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

    // Never seat by join order in a request room, host present or in grace:
    // without this, a plain join-room into a reservation whose room array is
    // gone would create the room and take seat 0. Before the leave-first block,
    // so a refused peer keeps whatever seat it had. Named `reserved`: `meta`
    // below is the seal's.
    const reserved = roomMeta.get(roomId.toLowerCase());
    if (reserved && reserved.kind === 'request') {
        peer.send('room-full', {});
        return;
    }

    // A request-room member leaves through the request rules (a host's
    // departure starts the grace); that clears peer.roomId, so the ordinary
    // block below is skipped.
    if (peer.roomId) {
        const current = roomMeta.get(peer.roomId);
        if (current && current.kind === 'request') leaveRequestRoom(peer, current);
    }

    // If already in a room, leave it first
    if (peer.roomId) {
        const oldRoom = rooms.get(peer.roomId);
        if (oldRoom) {
            const remaining = oldRoom.filter(p => p.id !== peer.id);
            if (remaining.length === 0) destroyRoom(peer.roomId);
            else rooms.set(peer.roomId, remaining);
        }
        peer.roomId = null;
    }

    // The seal. Once two distinct keys have routed signals in a room, a third
    // key is refused for as long as the room exists, so a stranger holding the
    // link cannot take the receiver's seat after the receiver leaves or drops.
    //
    // Counted in signaling keys, never in seats and never as a "has been
    // paired" flag. The browser re-joins a reconnecting sender with a bare
    // join-room (P2PTransfer.tsx, the socket reconnect handler), which can land
    // in seat two beside its own ghost, and under a new key when the sender's
    // network changed while it waited. A flag or a seat count would then have
    // the sender seal its own room against the real receiver. Neither the ghost
    // nor the waiting sender routes a signal, while a real pair always has
    // before any file byte moves (handleSignal).
    //
    // Fails open, on purpose, for peers that share a key (one NAT, one IPv6
    // /64): they never reach two keys, so a stranger behind the receiver's own
    // address is not refused. Closing that needs a per-room token, and the
    // released clients have no field to send one in. The e2e suite runs every
    // peer on one host, which can reach two keys on a dual-stack loopback
    // (127.0.0.1 keys as itself, ::1 as its /64) but cannot present a third, so
    // it is never refused.
    const meta = roomMeta.get(roomId);
    if (meta && meta.keys.size >= 2 && !meta.keys.has(sealDigest(peer.key))) {
        peer.send('room-full', {});
        return;
    }

    const room = rooms.get(roomId) || [];

    if (room.length === 0) {
        room.push(peer);
        rooms.set(roomId, room);
        roomMeta.set(roomId, { keys: new Set() });
        peer.roomId = roomId;
        peer.send('room-joined', { role: 'sender' });
    } else if (room.length === 1) {
        room.push(peer);
        rooms.set(roomId, room);
        peer.roomId = roomId;
        // The code has done its job: both seats are taken, so retire it. Burning
        // here rather than on the first GET is what keeps a pre-join failure
        // recoverable. A receiver that resolves the code and then cannot reach
        // the room (a 429 on ICE credentials, an output path it cannot write,
        // --relay-only against a relay-less server, desktop Hide my IP) never
        // took a seat, so it must be able to retry the same code.
        forgetCode(roomId);
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

    // From here the signal goes to the other seat, and only now does the
    // sender's key count toward the room seal (handleJoinRoom). A sender and a
    // receiver each route one (the offer, the answer) before any file byte can
    // move; a ghost never routes one, and a lone sender has no seat to route to.
    // Only the sender of the signal counts: a receiver that was offered to and
    // left before answering has received nothing. The key comes from the
    // connection, never from the frame. At most three keys: once two count, only
    // a peer already seated then can add one more.
    //
    // Not in a request room (D-116): nothing reads its keys (the reserved guard
    // in handleJoinRoom returns first), and its seat 1 frees on the visitor's
    // own disconnect, so the three-key bound above does not hold there and a
    // digest per visitor would pile up for the life of the reservation.
    const meta = roomMeta.get(senderPeer.roomId);
    if (meta && meta.kind !== 'request') meta.keys.add(sealDigest(senderPeer.key));
    else if (meta) noteRequestSignal(meta, senderPeer, targetPeer);

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

function handleDisconnect(peer, now = Date.now()) {
    // Also covers a ghost host that newest-host-wins replaced: its roomId was
    // cleared, so its late close changes nothing.
    if (!peer.roomId) return;
    const meta = roomMeta.get(peer.roomId);
    if (meta && meta.kind === 'request') {
        leaveRequestRoom(peer, meta, now);
        return;
    }
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
    if (remaining.length === 0) destroyRoom(peer.roomId);
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
    // The key the room seal counts this peer under (handleJoinRoom).
    socket.data.rateKey = rateKey(ip);
    next();
});

io.on('connection', (socket) => {
    const peer = createSocketIOPeer(socket, socket.data.rateKey);

    socket.on('ping', (callback) => {
        if (typeof callback === 'function') callback();
    });

    socket.on('join-room', (roomId) => {
        handleJoinRoom(peer, roomId);
    });

    // The visitor's only way in; the host is always on /ws (no Socket.IO host
    // path). handleRequestJoin checks the budget, then the type, first.
    socket.on('request-join', (roomId) => {
        handleRequestJoin(peer, roomId);
    });

    socket.on('signal', (data) => {
        if (!data || typeof data !== 'object' || !data.signal) return;
        handleSignal(peer, data.signal, data.target || null);
    });

    socket.on('disconnecting', () => {
        handleDisconnect(peer);
    });
});

// ---------------------------------------------------------------------------
// WebSocket server — used by CLI clients
// Path: /ws
// ---------------------------------------------------------------------------

// maxPayload caps inbound frames at 1 MB to match Socket.IO's maxHttpBufferSize.
// Signaling carries only SDP/ICE (< 10 KB); larger frames are rejected (close 1009).
const wss = new WebSocketServer({ noServer: true, maxPayload: 1e6 });

// Heartbeat period. A test knob, not an operator setting: production and every
// self-host leave it unset and run at 30 s. server/crashguard.test.js sets it so
// the reap it asserts happens in under two seconds instead of 86.
// Clamped, because setInterval takes a 32-bit signed delay and turns anything
// below 1 or above that range into 1 ms: an unset or unparsable value is 30 s,
// but HEARTBEAT_MS=1, a negative number or one past the 32-bit range would
// otherwise ping and reap every peer within milliseconds of it connecting, and
// by design neither kill path says so. The floor is 100 ms; the crash-guard
// tests run at 300.
const HEARTBEAT_MS = Math.min(
    2147483647,
    Math.max(100, parseInt(process.env.HEARTBEAT_MS, 10) || 30000)
);

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
    ws.pingNonce = null;

    const peer = createWSPeer(ws, rateKey(ip));

    ws.on('pong', (data) => handlePong(ws, data));

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
                // A dispatch, not a field read inside handleJoinRoom: a server
                // that predates request links seats this frame by join order,
                // which is why the host insists on role 'host' in the reply.
                if (msg.hostToken !== undefined) handleHostJoin(peer, msg.roomId, msg.hostToken);
                else handleJoinRoom(peer, msg.roomId);
                break;
            case 'request-join':
                handleRequestJoin(peer, msg.roomId);
                break;
            case 'request-seal':
            case 'request-reopen':
            case 'request-close':
                handleRequestControl(peer, msg.type, msg.roomId);
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

// Heartbeat: detect and close dead WebSocket connections every 30 seconds.
//
// Each ping carries a fresh 8-byte nonce and only a pong echoing it counts, so
// liveness means "this peer answered the question we just asked". A flag set by
// any pong, or set only while a ping is outstanding, is defeated the same way: a
// peer that sends unsolicited pongs faster than the interval keeps its seat
// forever without ever reading. The nonce is not a secret, it only has to be
// unpredictable to a peer that is not listening. RFC 6455 requires a pong to
// carry the ping's payload, and every shipped Floe client answers through its
// library's default handler (gorilla/websocket for the CLI and the desktop app,
// ws for Node), so honest peers keep their seats unchanged. A reap writes no log
// line and moves no counter, so a deploy check that greps for unhandled errors
// is silent whether or not this fires; only a live probe sees it.
function heartbeatTick(clients) {
    clients.forEach((ws) => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.pingNonce = crypto.randomBytes(8);
        ws.ping(ws.pingNonce);
    });
}

function handlePong(ws, data) {
    if (ws.pingNonce && Buffer.isBuffer(data) && data.equals(ws.pingNonce)) {
        ws.isAlive = true;
        // Spent: a replay of these bytes answers nothing after the next tick.
        ws.pingNonce = null;
    }
}

const heartbeat = setInterval(() => heartbeatTick(wss.clients), HEARTBEAT_MS).unref();

wss.on('close', () => clearInterval(heartbeat));

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

const PORT = process.env.PORT || 3001;

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
    rateKey,
    generateCode,
    registerCodeHandler,
    resolveCodeHandler,
    checkRateLimit,
    handleJoinRoom,
    handleSignal,
    handleDisconnect,
    createWSPeer,
    heartbeatTick,
    handlePong,
    WS_SEND_BUFFER_CEILING,
    rooms,
    roomMeta,
    codeToRoom,
    roomToCode,
    codeFailures,
    connectionCounts,
    turnRateLimits,
    validateReportBytes,
    statsRateLimits,
    makeRateLimiter,
    codeRateLimits,
    selectMinimalIceUrls,
    server,
    healthHandler,
    policyStore,
    cleanupTick,
    applyPolicyChange,
    handleHostJoin,
    reclaimHostSeat,
    endReservation,
    createsInWindow,
    countRequestRooms,
    requestCreates,
    REQUEST_GRACE_MS,
    REQUEST_CREATES_PER_DAY,
    REQUEST_CREATE_WINDOW_MS,
    MAX_REQUEST_ROOMS,
    REQUEST_CREATE_KEYS_MAX,
    requestRoomIds,
    handleRequestJoin,
    requestJoinAllowed,
    REQUEST_JOINS_PER_MINUTE,
    handleRequestControl,
    REQUEST_MAX_AGE_MS,
};
