// The TURN concern, lifted out of server.js whole: the credential sources
// (Cloudflare Realtime, then self-hosted coturn, then public STUN), the URL
// trimming, the per-IP limiter for the endpoint, and the request handler.
//
// server.js still registers the route itself. The registration line has to
// stay ahead of app.use(errorHandler), because Express dispatches error
// middleware in registration order and a route mounted after it falls
// through to the built-in handler, which serialises err.stack into the body
// whenever app.get('env') is not exactly 'production'. Nothing in the test
// suite asserts registration position, so a router mounted here instead of a
// handler exported to there could reintroduce that leak with everything
// green. Exporting a handler makes the ordering visible at the call site.
//
// This module reads process.env at require time for the two Cloudflare keys,
// so it must be required AFTER dotenv.config() in server.js. Required above
// it, both keys read undefined, generateCloudflareIceServers returns null,
// and production silently degrades to coturn or Google STUN with no test to
// notice.

const crypto = require('crypto');

const STUN_FALLBACK = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

const turnRateLimits = new Map();
const TURN_RATE_WINDOW = 60000;
// Default 20/min is ample for real users (one fetch per page load or CLI
// invocation); raise via MAX_TURN_REQUESTS_PER_IP in CI/staging where many
// CLI runs share one IP - a 429 silently degrades clients to Google STUN.
const TURN_MAX_REQUESTS = parseInt(process.env.MAX_TURN_REQUESTS_PER_IP, 10) || 20;

function generateCoturnCredentials() {
    const turnSecret = process.env.TURN_SECRET;
    const turnDomain = process.env.TURN_DOMAIN;
    if (!turnSecret || !turnDomain) return null;

    // 24h, matching CF_TURN_TTL below. Do not shorten: every sender fetches ICE
    // credentials BEFORE its wait for a peer, that wait is intentionally
    // unbounded (share a link, wait for hours), and no surface ever refreshes
    // the list. A shorter TTL silently kills relayed transfers for any receiver
    // who opens the link after the credentials expire.
    const ttl = 24 * 3600;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:floeuser`;
    // SHA-1 is not a choice here. The TURN REST credential mechanism
    // (draft-uberti-behave-turn-rest) specifies HMAC-SHA1, and coturn
    // accepts nothing else under use-auth-secret, so any other digest
    // produces credentials the relay rejects. HMAC-SHA1 is also not the
    // broken thing: SHA-1 collision attacks do not carry to HMAC-SHA1.
    // CodeQL flags this as js/weak-cryptographic-algorithm; alert 1 was
    // dismissed on this exact line while it lived in server.js, and moving
    // the file re-raised it because a dismissal is pinned to a location.
    // The rationale lives here now so it travels with the code.
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
// credentials are not per-user, so cache one set in memory for a short window
// instead of calling the API on every request. STUN and TURN are returned as
// separate entries so the client's relay-off filter (filterIceServers) can drop
// TURN while keeping STUN.
// ---------------------------------------------------------------------------

const CLOUDFLARE_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID;
const CLOUDFLARE_TURN_KEY_API_TOKEN = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
const CF_TURN_TTL = 24 * 3600;         // credential lifetime requested from Cloudflare (seconds)
// Every client inside one cache window shares one username. 5 minutes leaves
// at most 288 simultaneously valid usernames over a credential's 24h life (a
// 60 s window would leave about 1,440 inside the 20/min limiter), and a window
// this short makes a Cloudflare usage row attributable to one issuance.
const CF_CACHE_MS = 5 * 60 * 1000;
// A copy minted within the last CF_STALE_MS is still inside its own 24h
// lifetime with an hour to spare, so it may be served while Cloudflare's API
// fails. Derived, never chosen: an API outage shorter than about 23 hours never
// becomes a relay outage, and a revoked key stops looking healthy once its last
// copy ages out.
const CF_STALE_MS = (CF_TURN_TTL - 3600) * 1000;
// Node's global fetch has no timeout of its own. Without one, a hung Cloudflare
// connection hangs every request waiting on the mint (a browser receiver's join
// waits on it) while /health stays green.
const CF_FETCH_TIMEOUT_MS = 10_000;

let cfIceCache = { servers: null, expires: 0, mintedAt: 0 };
let cfInflight = null;           // the one mint in flight, or null
let cfNextMintAt = 0;            // no mint starts before this, after a success or a failure
let cfLastFailLogAt = -Infinity; // one failure line per cache window at most

// selectMinimalIceUrls reduces Cloudflare's full URL list (8 entries: STUN on two
// ports plus TURN duplicated across udp/tcp/tls on :53/:80/:443/:3478/:5349) to
// one URL per connectivity class. WebRTC clients gather candidates and open TURN
// allocations per URL per network interface, so redundant URLs multiply ICE work;
// on multi-adapter machines (VPN, VMware, WSL) the full list pushed connection
// setup from ~1s to 20-30s. Three classes cover every network:
//   - STUN (server-reflexive discovery), prefer the standard :3478
//   - TURN over UDP (the fast relay path)
//   - TURN over TLS, prefer :443 (indistinguishable from HTTPS; the canonical
//     fallback on UDP-blocking networks, covering what :53/:80/:5349 duplicated)
// Pattern-based so it keeps working if Cloudflare reorders or extends its list.
function selectMinimalIceUrls(stunUrls, turnUrls) {
    const stun = stunUrls.find(u => u.includes(':3478')) || stunUrls[0];
    // RFC 7065: a turn: URI without a transport param defaults to UDP.
    const udp = turnUrls.find(u => u.startsWith('turn:') && (u.includes('transport=udp') || !u.includes('transport=')));
    const tls =
        turnUrls.find(u => u.startsWith('turns:') && u.includes(':443')) ||
        turnUrls.find(u => u.startsWith('turns:')) ||
        turnUrls.find(u => u.includes('transport=tcp'));
    return {
        stunUrls: stun ? [stun] : [],
        turnUrls: [...new Set([udp, tls].filter(Boolean))],
    };
}

// The last good copy while it is still inside CF_STALE_MS, else null.
function usableCloudflareCopy(now) {
    if (!cfIceCache.servers) return null;
    return now - cfIceCache.mintedAt <= CF_STALE_MS ? cfIceCache.servers : null;
}

// A reason word only: never the response body, a username or a credential.
function logMintFailure(reason) {
    const now = Date.now();
    if (now - cfLastFailLogAt < CF_CACHE_MS) return;
    cfLastFailLogAt = now;
    console.error(`Cloudflare TURN mint failed (${reason})`);
}

async function generateCloudflareIceServers() {
    if (!CLOUDFLARE_TURN_KEY_ID || !CLOUDFLARE_TURN_KEY_API_TOKEN) return null;
    const now = Date.now();
    if (cfIceCache.servers && now < cfIceCache.expires) return cfIceCache.servers;
    const usable = usableCloudflareCopy(now);
    // In flight is checked before the negative window, or a burst of page loads
    // right after a restart falls through to STUN while the first mint runs.
    if (cfInflight) return usable || cfInflight;
    if (now < cfNextMintAt) return usable;
    cfInflight = startCloudflareMint();
    return usable || cfInflight;
}

// Owns the shared in-flight promise, which must never reject: nothing awaits it
// when a stale copy was served, and an un-awaited rejection reaches server.js's
// uncaughtException backstop with origin 'unhandledRejection' (verified on Node
// 20, 22 and 24), where crashguard.test.js fails on the "Unhandled error" line.
// Hence the whole body sits in try/catch; never add process.on('unhandledRejection').
async function startCloudflareMint() {
    // Set before the await, so at most one mint starts per window by construction.
    cfNextMintAt = Date.now() + CF_CACHE_MS;
    try {
        const servers = await mintCloudflareIceServers();
        if (servers) return servers;
    } catch {
        // mintCloudflareIceServers catches its own errors; this arm only keeps a
        // future change there from turning into a rejection here.
    } finally {
        cfInflight = null;
    }
    return usableCloudflareCopy(Date.now());
}

// One upstream call. Returns the trimmed server list and caches it, or null
// after logging why (a TimeoutError, a status, no servers); the caller decides
// what to serve instead.
async function mintCloudflareIceServers() {
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
                signal: AbortSignal.timeout(CF_FETCH_TIMEOUT_MS),
            }
        );
        if (!resp.ok) {
            logMintFailure(`status ${resp.status}`);
            return null;
        }
        const { iceServers } = await resp.json();
        if (!iceServers) {
            logMintFailure('no-ice-servers');
            return null;
        }

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
        // Trim to the minimal effective set before serving: fewer URLs means far
        // less ICE gathering work on every client (see selectMinimalIceUrls).
        const minimal = selectMinimalIceUrls(stunUrls, turnUrls);
        const servers = [];
        if (minimal.stunUrls.length) servers.push({ urls: minimal.stunUrls });
        if (minimal.turnUrls.length) servers.push({ urls: minimal.turnUrls, username, credential });
        if (!servers.length) {
            logMintFailure('no-ice-servers');
            return null;
        }

        const mintedAt = Date.now();
        cfIceCache = { servers, expires: mintedAt + CF_CACHE_MS, mintedAt };
        return servers;
    } catch (err) {
        logMintFailure(err && err.name ? err.name : 'error');
        return null;
    }
}

// Test hook: forget the cached copy, the in-flight mint and both windows.
function __resetCfCacheForTests() {
    cfIceCache = { servers: null, expires: 0, mintedAt: 0 };
    cfInflight = null;
    cfNextMintAt = 0;
    cfLastFailLogAt = -Infinity;
}

/** GET /api/turn-credentials. Registered by server.js, before the error handler. */
async function turnCredentialsHandler(req, res) {
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
}

module.exports = {
    STUN_FALLBACK,
    turnRateLimits,
    TURN_RATE_WINDOW,
    TURN_MAX_REQUESTS,
    generateCoturnCredentials,
    selectMinimalIceUrls,
    generateCloudflareIceServers,
    turnCredentialsHandler,
    CF_TURN_TTL,
    CF_CACHE_MS,
    CF_STALE_MS,
    __resetCfCacheForTests,
};
