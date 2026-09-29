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
 *  direct visit. Only the path is judged, with loadsUmami's rule, so a /r path
 *  from any origin is dropped too; that errs toward silence, like loadsUmami.
 *  An absent url or referrer names no page and passes. */
export function umamiPayloadAllowed(payload: unknown): boolean {
    if (typeof payload !== 'object' || payload === null) return false;
    const { url, referrer } = payload as { url?: unknown; referrer?: unknown };
    return pathAllowed(url) && pathAllowed(referrer);
}

function pathAllowed(value: unknown): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') return false;
    try {
        const pathname = new URL(value, 'http://umami.invalid').pathname;
        // The parsed path keeps percent-encoding, so /%72/<id> and /r%2F<id>
        // are judged decoded as well. A path that will not decode is dropped.
        return loadsUmami(pathname) && loadsUmami(decodeURIComponent(pathname));
    } catch {
        return false;
    }
}
