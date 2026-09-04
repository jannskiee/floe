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
        // Trim to the minimal effective set before serving: fewer URLs means far
        // less ICE gathering work on every client (see selectMinimalIceUrls).
        const minimal = selectMinimalIceUrls(stunUrls, turnUrls);
        const servers = [];
        if (minimal.stunUrls.length) servers.push({ urls: minimal.stunUrls });
        if (minimal.turnUrls.length) servers.push({ urls: minimal.turnUrls, username, credential });
        if (!servers.length) return cfIceCache.servers;

        cfIceCache = { servers, expires: Date.now() + CF_CACHE_MS };
        return servers;
    } catch {
        return cfIceCache.servers; // network hiccup: last good copy (may be null, then we fall through)
    }
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
};
