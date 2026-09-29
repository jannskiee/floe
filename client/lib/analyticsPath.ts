// Which paths the Umami tracker is allowed to load on.
//
// The tracker reports location.href. data-exclude-hash and data-exclude-search
// strip the fragment and the query, which is what keeps a share link's room id
// out of it, but neither strips the PATH, and a request link carries its link id
// in the path. So the tracker is not configured differently on /r; it is not
// loaded there at all.
//
// Pure and window-free so client/vitest.config.ts (environment: 'node') can
// cover it. components/UmamiScript.tsx is the one caller.

/** True when the Umami script may load for this pathname.
 *
 *  Compared lowercased, deliberately, even though Next routes are
 *  case-sensitive and /R/<id> never reaches the page. This function's job is to
 *  keep a tracker off a family of URLs, so it errs toward silence: a host,
 *  proxy or future redirect that folds case must not be able to turn the
 *  tracker back on.
 *
 *  An absent pathname also returns false. usePathname() returns a string in the
 *  App Router, but if it ever did not, the cost of being wrong in this direction
 *  is a missing pageview, and in the other direction it is a link id in an
 *  analytics record. */
export function loadsUmami(pathname: string | null | undefined): boolean {
    if (!pathname) return false;
    const path = pathname.toLowerCase();
    // Exactly /r, or something under it. Not a bare prefix test: /relay and
    // /robots.txt start with the same letters and are ordinary pages.
    return !(path === '/r' || path.startsWith('/r/'));
}

// The second line of defense: what the tracker may SEND, wherever it runs.
//
// loadsUmami keeps the tracker off /r, but it only decides whether the script
// renders. Once a page loads the tracker it wraps history.pushState and
// replaceState and reports every URL the document moves to, so a document that
// later reaches /r (the CP-QA F3-02 path: /r, a soft navigation to /privacy,
// Back) reports /r/<linkId> as a pageview and then as the next referrer. The
// /r footer no longer navigates softly, which closes that path at its root;
// this closes it for any path nobody has found yet.
//
// The live cloud.umami.is script reads data-before-send as the NAME of a
// window function, calls it with (type, payload) before every send, and sends
// only what it returns when that is truthy (verified 2026-09-25 against the
// 4810-byte script, sha256 prefix 91a876d767646fd5). It looks the name up at
// send time, and sends everything when no function is there.

/** The window property UmamiScript names in data-before-send. */
export const UMAMI_BEFORE_SEND = 'floeUmamiBeforeSend';

/** The before-send hook: the payload itself to send it, false to drop it. */
export function umamiBeforeSend<T>(type: string, payload: T): T | false {
    return umamiPayloadAllowed(payload) ? payload : false;
}

/** False when the payload's url or referrer is a /r path, or cannot be read.
 *
 *  Every payload the tracker builds carries both: url is the absolute page URL,
 *  referrer is a same-origin path, another origin's whole URL, or '' on a
 *  direct visit. Paths are judged with loadsUmami's rule. The url is judged
 *  from any origin, since it is always this page. The referrer is judged only
 *  when it is a path or names a Floe host (floe.one, apex or www, or the page's
 *  own host): a link id can only be a same-site referrer, because after a soft
 *  navigation the tracker's referrer is the previous in-app URL, and /r sends
 *  no referrer at all (Referrer-Policy no-referrer). A /r path on another
 *  site's referrer, reddit.com/r/..., is that site's page, and dropping it
 *  would only lose the visit. An absent url or referrer names no page and
 *  passes. */
export function umamiPayloadAllowed(payload: unknown): boolean {
    if (typeof payload !== 'object' || payload === null) return false;
    const { url, referrer, hostname } = payload as { url?: unknown; referrer?: unknown; hostname?: unknown };
    return pathAllowed(url) && referrerAllowed(referrer, url, hostname);
}

// The hosts a request link is served from on floe.one. A self-hosted instance
// is its page's own host.
const FLOE_HOSTS = ['floe.one', 'www.floe.one'];

// Relative values parse onto this, which is how a same-origin path is told
// from another origin's URL.
const PATH_BASE = 'http://umami.invalid';
const PATH_BASE_HOST = 'umami.invalid';

function referrerAllowed(referrer: unknown, url: unknown, hostname: unknown): boolean {
    if (typeof referrer !== 'string' || referrer === '') return pathAllowed(referrer);
    let host: string;
    try {
        host = new URL(referrer, PATH_BASE).hostname;
    } catch {
        return false;
    }
    const floeHosts = new Set(FLOE_HOSTS);
    if (typeof hostname === 'string') floeHosts.add(hostname.toLowerCase());
    if (typeof url === 'string') {
        try {
            floeHosts.add(new URL(url).hostname);
        } catch {
            // A url that is not absolute names no host of its own.
        }
    }
    if (host !== PATH_BASE_HOST && !floeHosts.has(host)) return true;
    return pathAllowed(referrer);
}

function pathAllowed(value: unknown): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') return false;
    try {
        const pathname = new URL(value, PATH_BASE).pathname;
        // The parsed path keeps percent-encoding, so /%72/<id> and /r%2F<id>
        // are judged decoded as well. A path that will not decode is dropped.
        return loadsUmami(pathname) && loadsUmami(decodeURIComponent(pathname));
    } catch {
        return false;
    }
}
