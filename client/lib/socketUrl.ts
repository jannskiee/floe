/**
 * Resolves the signaling server's base URL for the browser.
 *
 * Historically this was a single build-time constant, which meant a self-hosted
 * instance had to REBUILD the client image to change where it points. That also
 * made a prebuilt image impossible: one image can only ever bake one URL.
 *
 * Resolution order, first match wins:
 *
 *   1. NEXT_PUBLIC_SOCKET_URL, inlined at build time. Keeps floe.one, Vercel, and
 *      the e2e suite behaving exactly as before, and still lets anyone bake a URL
 *      into their own image. An EMPTY value falls through, which is what the
 *      Docker image ships so runtime resolution takes over.
 *   2. In development only, http://localhost:3001, so `pnpm dev` needs no env file.
 *   3. GET /api/config on our own origin, served by a route handler that reads the
 *      SOCKET_URL environment variable at REQUEST time. This is the runtime hook.
 *   4. The page's own origin, which is correct when the client and the signaling
 *      server sit behind one reverse proxy (see docs/self-hosting/reverse-proxy).
 *
 * The result is cached and in-flight requests are shared, so the config endpoint
 * is hit at most once per page load.
 */

const DEV_FALLBACK = 'http://localhost:3001';

let cachedUrl: string | null = null;
let inflight: Promise<string> | null = null;

/** Strips trailing slashes so callers can always append `/api/...` safely. */
function normalize(url: string): string {
    return url.replace(/\/+$/, '');
}

async function fetchConfiguredUrl(): Promise<string> {
    try {
        // no-store matters three ways over: the service worker skips /api/, the
        // route sends Cache-Control: no-store, and this stops the HTTP cache from
        // pinning the first answer for the life of the tab.
        const res = await fetch('/api/config', { cache: 'no-store' });
        if (res.ok) {
            const { socketUrl } = await res.json();
            if (typeof socketUrl === 'string' && socketUrl.trim() !== '') {
                return socketUrl.trim();
            }
        }
    } catch {
        // Unreachable or malformed: fall through to the same-origin default.
    }
    return window.location.origin;
}

/**
 * Returns the signaling server base URL. Never rejects: every failure path ends
 * at the page's own origin.
 */
export function resolveSocketUrl(): Promise<string> {
    if (cachedUrl !== null) return Promise.resolve(cachedUrl);

    // Read as this exact expression. Next replaces the literal text
    // `process.env.NEXT_PUBLIC_SOCKET_URL` at build time; destructuring it or
    // computing the key would leave it undefined in the browser bundle.
    const baked = process.env.NEXT_PUBLIC_SOCKET_URL;
    if (baked && baked.trim() !== '') {
        cachedUrl = normalize(baked.trim());
        return Promise.resolve(cachedUrl);
    }

    if (process.env.NODE_ENV === 'development') {
        cachedUrl = DEV_FALLBACK;
        return Promise.resolve(cachedUrl);
    }

    // Server-side render. Resolve to a harmless empty base without caching, so a
    // value derived without a `window` can never be reused in the browser.
    if (typeof window === 'undefined') return Promise.resolve('');

    if (!inflight) {
        inflight = fetchConfiguredUrl().then((url) => {
            cachedUrl = normalize(url);
            inflight = null;
            return cachedUrl;
        });
    }
    return inflight;
}

/**
 * The resolved URL if it is already known, otherwise null.
 *
 * For callers that must issue their request synchronously inside the current
 * task, such as a `keepalive` fetch during page teardown, where awaiting a
 * promise would let the page unload first.
 */
export function peekSocketUrl(): string | null {
    return cachedUrl;
}

/** Clears the module cache. Tests only. */
export function resetSocketUrlCache(): void {
    cachedUrl = null;
    inflight = null;
}
