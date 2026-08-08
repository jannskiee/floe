import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards the caching policy in public/sw.js.
 *
 * This lives in lib/ rather than beside its subject because vitest.config.ts
 * collects only lib/**\/*.test.ts, and public/sw.js is a classic script served
 * verbatim to the browser: there is nothing to import. So it is read as text and
 * evaluated in a fresh function scope per test. A `new Function` body's scope
 * chain is the global scope alone, which is what makes the stubs below reachable
 * from its free `self`, `caches` and `fetch` references, and what keeps its
 * top-level consts out of this file.
 *
 * The worker has exactly two outcomes for any request: it calls respondWith and
 * answers from the Cache API, or it returns and lets the browser fetch the URL
 * as if no worker were registered. So "respondWith was never called" is a
 * complete statement of "this URL is not cached", not a proxy for one.
 */
const SW_SOURCE = readFileSync(
    fileURLToPath(new URL('../public/sw.js', import.meta.url)),
    'utf8'
);

const ORIGIN = 'https://www.floe.one';
const NETWORK_BODY = 'from the network';

// The name v4 shipped. An allowlist only reaches an already-installed visitor if
// the name changed, because activate purges by name and nothing else evicts.
const PREVIOUS_CACHE_NAME = 'floe-cache-v4';

interface FakeRequest {
    url: string;
    method: string;
    mode: string;
}

interface FakeResponse {
    status: number;
    body: string;
    clone(): FakeResponse;
}

function makeResponse(body: string, status = 200): FakeResponse {
    return { status, body, clone: () => makeResponse(body, status) };
}

/**
 * Enough of CacheStorage to run the worker. Two properties of the real API are
 * load-bearing and reproduced on purpose:
 *
 *   - cache.addAll takes relative paths, which the spec resolves against the
 *     worker's own location. That is why a precached '/' is findable at all.
 *   - Matching is by URL and method. A request's mode is NOT part of the key,
 *     which is why a navigation finds the entry addAll stored as an ordinary
 *     request. The offline fallback depends entirely on that.
 */
function createCacheStorage() {
    const stores = new Map<string, Map<string, FakeResponse>>();
    const opened: string[] = [];
    const precached: string[] = [];
    const key = (url: string) => new URL(url, `${ORIGIN}/sw.js`).href;

    function entriesFor(name: string) {
        const existing = stores.get(name);
        if (existing) return existing;
        const created = new Map<string, FakeResponse>();
        stores.set(name, created);
        return created;
    }

    const cacheStorage = {
        open: async (name: string) => {
            opened.push(name);
            const target = entriesFor(name);
            return {
                addAll: async (urls: string[]) => {
                    for (const url of urls) {
                        precached.push(url);
                        target.set(key(url), makeResponse(`precached ${url}`));
                    }
                },
                put: async (request: FakeRequest, response: FakeResponse) => {
                    target.set(key(request.url), response);
                },
            };
        },
        match: async (request: FakeRequest) => {
            for (const target of stores.values()) {
                const hit = target.get(key(request.url));
                if (hit) return hit;
            }
            return undefined;
        },
        keys: async () => [...stores.keys()],
        delete: async (name: string) => stores.delete(name),
    };

    return { cacheStorage, stores, opened, precached, entriesFor };
}

function loadServiceWorker() {
    const listeners = new Map<string, (event: unknown) => void>();
    const { cacheStorage, stores, opened, precached, entriesFor } = createCacheStorage();
    const fetchMock = vi.fn(async () => makeResponse(NETWORK_BODY));
    const skipWaiting = vi.fn();
    const claim = vi.fn();

    vi.stubGlobal('self', {
        addEventListener: (type: string, handler: (event: unknown) => void) => {
            listeners.set(type, handler);
        },
        location: new URL(`${ORIGIN}/sw.js`),
        skipWaiting,
        clients: { claim },
    });
    vi.stubGlobal('caches', cacheStorage);
    vi.stubGlobal('fetch', fetchMock);

    new Function(SW_SOURCE)();

    return { listeners, stores, opened, precached, entriesFor, fetchMock, skipWaiting, claim };
}

type Worker = ReturnType<typeof loadServiceWorker>;

/**
 * Fires one fetch event. An empty result means the worker declined the request,
 * so the browser goes to the network on its own.
 */
function dispatchFetch(
    sw: Worker,
    url: string,
    mode = 'cors',
    method = 'GET'
): Promise<FakeResponse>[] {
    const handled: Promise<FakeResponse>[] = [];
    const listener = sw.listeners.get('fetch');
    if (!listener) throw new Error('sw.js registered no fetch listener');
    const request: FakeRequest = { url, method, mode };
    listener({
        request,
        respondWith: (promise: Promise<FakeResponse>) => {
            handled.push(promise);
        },
    });
    return handled;
}

async function dispatchLifecycle(sw: Worker, type: 'install' | 'activate') {
    const pending: Promise<unknown>[] = [];
    const listener = sw.listeners.get(type);
    if (!listener) throw new Error(`sw.js registered no ${type} listener`);
    listener({
        waitUntil: (promise: Promise<unknown>) => {
            pending.push(promise);
        },
    });
    await Promise.all(pending);
}

/**
 * The worker writes to the cache without awaiting it, deliberately, so a slow
 * write never delays the response. Asserting on the write means draining those
 * microtasks first.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let sw: Worker;

beforeEach(() => {
    sw = loadServiceWorker();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('service worker registration', () => {
    it('registers install, activate and fetch listeners', () => {
        expect([...sw.listeners.keys()].sort()).toEqual(['activate', 'fetch', 'install']);
    });

    it('takes over open tabs instead of waiting for them to close', async () => {
        await dispatchLifecycle(sw, 'install');
        await dispatchLifecycle(sw, 'activate');
        expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
        expect(sw.claim).toHaveBeenCalledTimes(1);
    });
});

describe('install', () => {
    it('precaches the documents that must survive going offline', async () => {
        await dispatchLifecycle(sw, 'install');
        expect(sw.precached).toEqual(['/', '/download', '/how-it-works', '/privacy', '/terms']);
    });

    it('does not precache the GitHub mark, which no page requests directly', async () => {
        // The footer renders it through next/image, so the browser asks for
        // /_next/image?url=%2Fgithub-mark-white.png. A precached copy of the raw
        // file could never be matched.
        await dispatchLifecycle(sw, 'install');
        expect(sw.precached).not.toContain('/github-mark-white.png');
    });

    it('writes to a cache name the previous release did not use', async () => {
        // Without a rename, an existing visitor keeps every entry the old
        // denylist wrongly stored, and the fix never reaches the people it is for.
        await dispatchLifecycle(sw, 'install');
        expect(sw.opened[0]).not.toBe(PREVIOUS_CACHE_NAME);
    });
});

describe('activate', () => {
    it('deletes every cache except the current one', async () => {
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        sw.entriesFor(PREVIOUS_CACHE_NAME).set(`${ORIGIN}/docs/changelog`, makeResponse('stale'));
        sw.entriesFor('floe-cache-v3').set(`${ORIGIN}/_next/image?url=x`, makeResponse('stale'));

        await dispatchLifecycle(sw, 'activate');

        expect([...sw.stores.keys()]).toEqual([current]);
    });
});

describe('URLs the worker must leave alone', () => {
    const NOT_CACHED: [string, string][] = [
        // A reverse-proxy rewrite onto a Mintlify deployment we do not version.
        ['a proxied docs page', `${ORIGIN}/docs/changelog`],
        ['the docs index', `${ORIGIN}/docs`],
        ['a docs RSC payload', `${ORIGIN}/docs/changelog?_rsc=J6c4qteBDi_nDJmH`],
        // Proves the docs guard outranks the /_next/static allowlist. This is
        // Mintlify's build output, and its hashes are not our promise to keep.
        ['a docs build asset', `${ORIGIN}/docs/_next/static/chunks/mintlify.js`],
        // A live optimizer whose output changes with the source and the config.
        ['the image optimizer', `${ORIGIN}/_next/image?url=%2Fgithub-mark-white.png&w=32&q=75`],
        // Names chunks from the deployment that produced it, so a cached copy is
        // the stale-bundle error lib/staleBundle.ts cannot reload its way out of.
        ['our own RSC payload', `${ORIGIN}/download?_rsc=1a2b3c4d`],
        ['the runtime config endpoint', `${ORIGIN}/api/config`],
        ['a signaling API route', `${ORIGIN}/api/turn-credentials`],
        ['socket.io polling', `${ORIGIN}/socket.io/?EIO=4&transport=polling`],
        ['sitemap.xml', `${ORIGIN}/sitemap.xml`],
        ['robots.txt', `${ORIGIN}/robots.txt`],
        ['the web app manifest', `${ORIGIN}/manifest.webmanifest`],
        ['a hash-suffixed icon route', `${ORIGIN}/icon.svg?f7a1c2b9`],
        ['a public image', `${ORIGIN}/og.png`],
        ['the CLI install script', `${ORIGIN}/install.sh`],
        ['another host entirely', 'https://api.floe.one/api/turn-credentials'],
        ['build output on another host', 'https://cdn.example.com/_next/static/chunks/a.js'],
    ];

    for (const [label, url] of NOT_CACHED) {
        it(`passes ${label} straight to the network`, () => {
            expect(dispatchFetch(sw, url)).toHaveLength(0);
        });
    }

    it('ignores non-GET requests to an otherwise cacheable path', () => {
        expect(dispatchFetch(sw, `${ORIGIN}/_next/static/chunks/a.js`, 'cors', 'POST')).toHaveLength(0);
    });
});

describe('/_next/static is the only cache-first path', () => {
    const CACHED: [string, string][] = [
        ['a build chunk', `${ORIGIN}/_next/static/chunks/4f2a91c3.js`],
        ['a build stylesheet', `${ORIGIN}/_next/static/css/9b1c0e.css`],
        ['a self-hosted next/font file', `${ORIGIN}/_next/static/media/geist-a1b2c3.woff2`],
    ];

    for (const [label, url] of CACHED) {
        it(`caches ${label}, whose filename is a hash of its bytes`, async () => {
            const handled = dispatchFetch(sw, url);
            expect(handled).toHaveLength(1);
            await expect(handled[0]).resolves.toMatchObject({ body: NETWORK_BODY });
        });
    }

    it('serves a repeat request from the cache without a second network hit', async () => {
        const url = `${ORIGIN}/_next/static/chunks/4f2a91c3.js`;

        await dispatchFetch(sw, url)[0];
        await flush();
        expect(sw.fetchMock).toHaveBeenCalledTimes(1);

        await expect(dispatchFetch(sw, url)[0]).resolves.toMatchObject({ body: NETWORK_BODY });
        expect(sw.fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('navigations', () => {
    it('prefers the network over a cached copy', async () => {
        await dispatchLifecycle(sw, 'install');

        const handled = dispatchFetch(sw, `${ORIGIN}/`, 'navigate');
        expect(handled).toHaveLength(1);
        await expect(handled[0]).resolves.toMatchObject({ body: NETWORK_BODY });
        expect(sw.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refreshes the cached copy from the network answer', async () => {
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];

        await dispatchFetch(sw, `${ORIGIN}/`, 'navigate')[0];
        await flush();

        expect(sw.stores.get(current)?.get(`${ORIGIN}/`)).toMatchObject({ body: NETWORK_BODY });
    });

    it('falls back to the precache when the network is gone', async () => {
        await dispatchLifecycle(sw, 'install');
        sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        const handled = dispatchFetch(sw, `${ORIGIN}/download`, 'navigate');
        expect(handled).toHaveLength(1);
        // addAll stored this under an ordinary request. Finding it from a
        // navigation is the spec property the whole fallback rests on.
        await expect(handled[0]).resolves.toMatchObject({ body: 'precached /download' });
    });

    it('leaves docs navigations alone, not just docs subresources', () => {
        // The guard has to sit above the navigate branch, or every docs page
        // lands in the cache and only a rename can evict it.
        expect(dispatchFetch(sw, `${ORIGIN}/docs/changelog`, 'navigate')).toHaveLength(0);
        expect(dispatchFetch(sw, `${ORIGIN}/docs`, 'navigate')).toHaveLength(0);
    });

    it('does not mistake a route that merely starts with the letters docs', () => {
        // A bare startsWith('/docs') would swallow both of these, which are ours.
        expect(dispatchFetch(sw, `${ORIGIN}/docsomething`, 'navigate')).toHaveLength(1);
        expect(dispatchFetch(sw, `${ORIGIN}/docs-archive`, 'navigate')).toHaveLength(1);
    });
});
