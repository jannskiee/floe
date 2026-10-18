// The global stats counter, lifted out of server.js whole: the per-IP limiter
// for the report endpoint, the per-report cap, the Upstash Redis client, the
// in-memory read cache and the two request handlers.
//
// server.js still registers both routes, and still sweeps statsRateLimits
// from its cleanup interval, as it does for turn.js. The registration lines
// have to stay ahead of app.use(errorHandler): Express dispatches error
// middleware in registration order, and a route mounted after it falls
// through to the built-in handler, which serialises err.stack into the body
// whenever app.get('env') is not exactly 'production'. Exporting handlers
// rather than a router keeps that ordering visible at the call site.
//
// This module reads process.env at require time for the two Upstash keys and
// MAX_REPORT_BYTES, so it must be required AFTER dotenv.config() in server.js.
// Required above it, both keys read undefined, upstashPost returns null, and
// production silently degrades to an in-memory counter that resets on every
// restart, with no test to notice.
//
// initStats() is called only from server.js's require.main === module block,
// never here at module scope: a require-time Upstash call would also run under
// node --test, which requires server.js and with it whatever server/.env the
// checkout holds.

const { rateKey } = require('./ratekey');
const { envLimit } = require('./envlimit');

const statsRateLimits = new Map();
const STATS_RATE_WINDOW = 60000;
const STATS_MAX_REPORTS = 60; // per IP per minute
const MAX_REPORT_BYTES = envLimit('MAX_REPORT_BYTES', 5 * 1024 * 1024 * 1024 * 1024); // 5 TiB

// ---------------------------------------------------------------------------
// Global stats — Upstash Redis (durable) + fast in-memory read cache
//
// GET /api/stats  — served from cachedTotal; zero Redis reads per poll request.
// POST /api/stats/report — receiver peers report bytes after a completed transfer.
//   Validates, increments cachedTotal, then hands the bytes to the next INCRBY
//   to Upstash, one in flight at a time (no-await).
//   Gracefully degrades to in-memory-only when UPSTASH_* env vars are absent.
// ---------------------------------------------------------------------------

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STATS_KEY = 'floe:bytes_total';
// Every Upstash call ends at 10 s, the startup read included, as turn.js ends
// the Cloudflare mint. Node's global fetch gives up on a silent server only at
// undici's 300 s defaults, and a hung Upstash would hold the one INCRBY in
// flight (sendPendingBytes) that long, with every report waiting behind it. A
// startup read slower than 10 s counts as failed, so the total waits for the
// first INCRBY's answer.
const UPSTASH_FETCH_TIMEOUT_MS = 10_000;

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
            signal: AbortSignal.timeout(UPSTASH_FETCH_TIMEOUT_MS),
        });
        if (!resp.ok) return null;
        const { result } = await resp.json();
        return result;
    } catch {
        return null;
    }
}

// The total only moves up. A report that lands while the startup GET is on its
// way is counted in cachedTotal already, and that GET may have been read before
// the report's INCRBY reached the counter, so the seed never lowers what is
// there; each INCRBY's reply, the counter's new total, raises it in turn.
// Upstash answers a number (INCRBY) or a string (GET), and anything else is
// ignored before Number() reads it: Number() throws on an object whose valueOf
// and toString are not callable, which would be an unhandled rejection in the
// INCRBY's settle handler.
function raiseTotal(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return;
    const n = Number(value);
    if (Number.isFinite(n) && n > cachedTotal) cachedTotal = n;
}

async function initStats() {
    const val = await upstashPost(['GET', STATS_KEY]);
    if (val !== null) raiseTotal(val);
}

// One INCRBY in flight at a time. The bytes of a report that lands while a
// call is on its way wait in pendingBytes and go in the next call, so a
// stalled Upstash holds one call however many networks report, and a report
// waiting its turn is never dropped. A call that fails, by its timeout or
// otherwise, drops only its own bytes, as one call per report did: the
// timeout ends the wait, not Upstash's work, so the call may have been
// applied, and INCRBY sent twice counts twice; a refused call (a read-only
// token refuses every write) would also go out again at once, forever. The
// slot is freed and the bytes that waited are sent before the answer is read,
// so no answer can hold them up. Bytes still waiting when the process exits
// are never sent, since shutdown() does not wait for them: at most one
// Upstash round trip of reports, 10 s of them during a stall.
let pendingBytes = 0;
let incrbyInFlight = false;

function sendPendingBytes() {
    if (incrbyInFlight || pendingBytes === 0) return;
    // The carry is a sum of reports. Redis refuses an increment it cannot read
    // as a 64-bit integer (JSON writes 1e21 and up in exponent form), which
    // would drop the whole call, so a call takes at most a safe integer of it
    // and the rest waits for the next.
    const bytes = Math.min(pendingBytes, Number.MAX_SAFE_INTEGER);
    pendingBytes -= bytes;
    incrbyInFlight = true;
    upstashPost(['INCRBY', STATS_KEY, bytes]).then((total) => {
        incrbyInFlight = false;
        sendPendingBytes();
        raiseTotal(total);
    });
}

function validateReportBytes(bytes, maxBytes) {
    return Number.isInteger(bytes) && bytes > 0 && bytes <= maxBytes;
}

/** GET /api/stats. Registered by server.js, before the error handler. */
function statsHandler(_req, res) {
    res.json({ totalBytes: cachedTotal });
}

/** POST /api/stats/report. Registered by server.js, before the error handler. */
function statsReportHandler(req, res) {
    const ip = rateKey(req.ip);
    const now = Date.now();

    const timestamps = (statsRateLimits.get(ip) || []).filter(t => now - t < STATS_RATE_WINDOW);
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
    pendingBytes += bytes;
    sendPendingBytes();

    res.json({ totalBytes: cachedTotal });
}

module.exports = {
    statsRateLimits,
    STATS_RATE_WINDOW,
    STATS_MAX_REPORTS,
    MAX_REPORT_BYTES,
    initStats,
    validateReportBytes,
    statsHandler,
    statsReportHandler,
};
