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

const statsRateLimits = new Map();
const STATS_RATE_WINDOW = 60000;
const STATS_MAX_REPORTS = 60; // per IP per minute
const MAX_REPORT_BYTES = parseInt(process.env.MAX_REPORT_BYTES || '', 10) || (5 * 1024 * 1024 * 1024 * 1024); // 5 TiB

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

/** GET /api/stats. Registered by server.js, before the error handler. */
function statsHandler(_req, res) {
    res.json({ totalBytes: cachedTotal });
}

/** POST /api/stats/report. Registered by server.js, before the error handler. */
function statsReportHandler(req, res) {
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
