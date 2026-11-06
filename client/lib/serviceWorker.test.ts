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
 * takes the request over, or it returns and lets the browser fetch the URL as if
 * no worker were registered. Only the first path can ever reach the Cache API,
 * so "respondWith was never called" is a complete statement of "this URL is not
 * cached", not a proxy for one. (Taking a request over does not imply answering
 * from cache: the navigate branch and /_next/static both answer from the network
 * through respondWith, and read the cache only when fetch itself rejects.)
 */
const SW_SOURCE = readFileSync(
    fileURLToPath(new URL('../public/sw.js', import.meta.url)),
    'utf8'
);

const ORIGIN = 'https://www.floe.one';
const NETWORK_BODY = 'from the network';

// The name v6 shipped. The rename is NOT what stops a planted chunk running:
// network-first does that, the moment v7 activates, whatever the cache is
// called. The rename is what deletes every entry v6 already stored, a planted
// one included, because activate purges by name and nothing else ever evicts.
const PREVIOUS_CACHE_NAME = 'floe-cache-v6';

interface FakeRequest {
    url: string;
    method: string;
    mode: string;
}

interface FakeResponse {
    status: number;
    ok: boolean;
    body: string;
    clone(): FakeResponse;
}

function makeResponse(body: string, status = 200): FakeResponse {
    return {
        status,
        ok: status >= 200 && status < 300,
        body,
        clone: () => makeResponse(body, status),
    };
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
                match: async (request: FakeRequest) => target.get(key(request.url)),
            };
        },
        // Every cache on the origin, oldest first, as the real one searches. The
        // worker must not use this: a copy planted under another name would answer.
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

    const held: Promise<unknown>[] = [];
    return { listeners, stores, opened, precached, entriesFor, fetchMock, skipWaiting, claim, held };
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
        waitUntil: (promise: Promise<unknown>) => {
            sw.held.push(promise);
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
 * write never delays the response; waitUntil keeps the worker alive for it. Asserting
 * on the write means draining those microtasks first.
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
        // The routing change alone already stops those entries being served.
        // The rename is what evicts them from disk, since activate purges by
        // name and nothing else ever does.
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
        // v5 stored every opened share link under its full URL. The literal name
        // is deliberate: whatever later releases are called, v5 must stay purged.
        sw.entriesFor('floe-cache-v5').set(`${ORIGIN}/?s=x#room=y`, makeResponse('a share link v5 kept'));

        await dispatchLifecycle(sw, 'activate');

        expect([...sw.stores.keys()]).toEqual([current]);
    });

    it('purges the v6 cache on activate, a planted chunk with it', async () => {
        // v6 answered /_next/static from its store for as long as an entry was
        // there, so one same-origin script run could leave a chunk that outlived
        // every deploy. The literal name is deliberate, as for v5 above.
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        expect(current).not.toBe('floe-cache-v6');
        sw.entriesFor('floe-cache-v6').set(`${ORIGIN}/_next/static/chunks/x.js`, makeResponse('window.__planted = 1'));

        await dispatchLifecycle(sw, 'activate');

        expect(sw.stores.has('floe-cache-v6')).toBe(false);
        expect([...sw.stores.keys()]).toEqual([current]);
        // Nothing is left to answer with, even with the network gone.
        sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(dispatchFetch(sw, `${ORIGIN}/_next/static/chunks/x.js`)[0]).resolves.toBeUndefined();
    });
});

describe('URLs the worker must leave alone', () => {
    const NOT_CACHED: [string, string][] = [
        // A reverse-proxy rewrite onto a Mintlify deployment we do not version.
        ['a proxied docs page', `${ORIGIN}/docs/changelog`],
        ['the docs index', `${ORIGIN}/docs`],
        // Measured on the live site: /DOCS/changelog and /Docs/changelog both
        // return the docs with a 200, byte for byte identical to the lowercase
        // spelling. The routing in front of the worker is case-insensitive, so
        // the guard has to be too.
        ['an all-caps docs path', `${ORIGIN}/DOCS/changelog`],
        ['a mixed-case docs path', `${ORIGIN}/Docs/changelog`],
        ['a mixed-case docs index', `${ORIGIN}/Docs`],
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
        ['socket.io behind a proxy prefix', `${ORIGIN}/app/socket.io/?EIO=4`],
        ['sitemap.xml', `${ORIGIN}/sitemap.xml`],
        ['robots.txt', `${ORIGIN}/robots.txt`],
        ['the web app manifest', `${ORIGIN}/manifest.webmanifest`],
        ['a hash-suffixed icon route', `${ORIGIN}/icon.svg?f7a1c2b9`],
        ['a public image', `${ORIGIN}/og.png`],
        ['the CLI install script', `${ORIGIN}/install.sh`],
        // The pinned tracker sits outside /_next/static on purpose: the worker
        // never answers for it, so a planted copy could never be served, and
        // the browser's integrity check has the only word on its bytes.
        ['the pinned Umami copy', `${ORIGIN}/vendor/umami-8104cfaf.js`],
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

describe('/_next/static is network-first, with the cache as the offline fallback', () => {
    const CHUNK = `${ORIGIN}/_next/static/chunks/4f2a91c3.js`;
    const PLANTED = 'window.__planted = 1';

    const CACHED: [string, string][] = [
        ['a build chunk', CHUNK],
        ['a build stylesheet', `${ORIGIN}/_next/static/css/9b1c0e.css`],
        ['a self-hosted next/font file', `${ORIGIN}/_next/static/media/geist-a1b2c3.woff2`],
    ];

    for (const [label, url] of CACHED) {
        it(`caches ${label}, whose filename is a hash of its bytes`, async () => {
            await dispatchLifecycle(sw, 'install');
            const handled = dispatchFetch(sw, url);
            expect(handled).toHaveLength(1);
            await expect(handled[0]).resolves.toMatchObject({ body: NETWORK_BODY });
            await flush();
            expect(sw.stores.get(sw.opened[0])?.get(url)).toMatchObject({ body: NETWORK_BODY });
        });
    }

    it('a repeat request goes to the network again and refreshes the stored copy', async () => {
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];

        await dispatchFetch(sw, CHUNK)[0];
        await flush();
        expect(sw.fetchMock).toHaveBeenCalledTimes(1);

        sw.fetchMock.mockResolvedValueOnce(makeResponse('the bytes of this load'));
        await expect(dispatchFetch(sw, CHUNK)[0]).resolves.toMatchObject({ body: 'the bytes of this load' });
        await flush();
        expect(sw.fetchMock).toHaveBeenCalledTimes(2);
        expect(sw.stores.get(current)?.get(CHUNK)).toMatchObject({ body: 'the bytes of this load' });
    });

    it('a copy planted in the store never answers while the network does, and is overwritten', async () => {
        // One same-origin script run can write to Cache Storage: a tracker, or
        // Mintlify's scripts under /docs. Under cache-first its entry ran on
        // every later load, across deploys, on the page that holds a link.
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        sw.entriesFor(current).set(CHUNK, makeResponse(PLANTED));

        await expect(dispatchFetch(sw, CHUNK)[0]).resolves.toMatchObject({ body: NETWORK_BODY });
        await flush();

        expect(sw.fetchMock).toHaveBeenCalledTimes(1);
        expect(sw.stores.get(current)?.get(CHUNK)).toMatchObject({ body: NETWORK_BODY });
    });

    it('the stored copy answers only when fetch itself rejects', async () => {
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        sw.entriesFor(current).set(CHUNK, makeResponse('the copy from an earlier load'));
        sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await expect(dispatchFetch(sw, CHUNK)[0]).resolves.toMatchObject({ body: 'the copy from an earlier load' });
        await flush();
        // A rejected fetch has nothing to store, so the copy stays as it was.
        expect(sw.stores.get(current)?.get(CHUNK)).toMatchObject({ body: 'the copy from an earlier load' });
        // With nothing stored either, the page gets the network error it would
        // have had with no worker registered.
        sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(dispatchFetch(sw, `${ORIGIN}/_next/static/chunks/never-seen.js`)[0]).resolves.toBeUndefined();
    });

    it('a copy planted under another cache name never answers, even when fetch rejects', async () => {
        // caches.match searches every cache on the origin, so this store would
        // answer a rejected fetch, and the 200 that overwrites the worker's own
        // copy would never reach it. One script run can make such a cache.
        await dispatchLifecycle(sw, 'install');
        sw.entriesFor('elsewhere').set(CHUNK, makeResponse(PLANTED));
        sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await expect(dispatchFetch(sw, CHUNK)[0]).resolves.toBeUndefined();
    });

    it('a copy planted under an older cache of that name stays out after an online load', async () => {
        // The durable shape, run in real Chromium for the review: delete the
        // worker's cache, make another, open the worker's again, so the plant is
        // the oldest cache the origin holds and caches.match would find it first.
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        sw.stores.delete(current);
        sw.entriesFor('elsewhere').set(CHUNK, makeResponse(PLANTED));
        sw.entriesFor(current);

        await expect(dispatchFetch(sw, CHUNK)[0]).resolves.toMatchObject({ body: NETWORK_BODY });
        await flush();
        expect(sw.stores.get(current)?.get(CHUNK)).toMatchObject({ body: NETWORK_BODY });

        sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(dispatchFetch(sw, CHUNK)[0]).resolves.toMatchObject({ body: NETWORK_BODY });
    });

    it('holds the write that overwrites a plant with waitUntil', async () => {
        // A browser may stop the worker once respondWith has settled, and this
        // write is what heals a plant.
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        sw.entriesFor(current).set(CHUNK, makeResponse(PLANTED));

        await dispatchFetch(sw, CHUNK)[0];

        expect(sw.held).toHaveLength(1);
        await sw.held[0];
        expect(sw.stores.get(current)?.get(CHUNK)).toMatchObject({ body: NETWORK_BODY });
    });

    // A 206 is a range answer, whose ok is true, so only the status can keep it
    // out. A 0 is an opaque answer, whose bytes nobody can read.
    for (const status of [0, 206, 404, 500, 503]) {
        it(`a ${status} passes through, unstored, and is never swapped for a stored copy`, async () => {
            // An old tab asking for a chunk the last deploy removed gets the
            // host's 404. If that fell back to the store, an entry planted at
            // an old build's URL would run, which is the path this closes.
            await dispatchLifecycle(sw, 'install');
            const current = sw.opened[0];
            sw.entriesFor(current).set(CHUNK, makeResponse(PLANTED));
            sw.fetchMock.mockResolvedValueOnce(makeResponse('an error page', status));

            await expect(dispatchFetch(sw, CHUNK)[0]).resolves.toMatchObject({ status, body: 'an error page' });
            await flush();

            // The stored copy is untouched: a bad answer proves nothing about it.
            expect(sw.stores.get(current)?.get(CHUNK)).toMatchObject({ body: PLANTED });

            const missing = `${ORIGIN}/_next/static/chunks/gone.js`;
            sw.fetchMock.mockResolvedValueOnce(makeResponse('an error page', status));
            await expect(dispatchFetch(sw, missing)[0]).resolves.toMatchObject({ status });
            await flush();
            expect(sw.stores.get(current)?.has(missing)).toBe(false);
        });
    }

    it('a throw while handling the answer does not fall back to the store', async () => {
        // Why the handlers are the two arguments of one then(): with
        // then().catch() a throw in the success path would read the store too.
        await dispatchLifecycle(sw, 'install');
        sw.entriesFor(sw.opened[0]).set(CHUNK, makeResponse(PLANTED));
        sw.fetchMock.mockResolvedValueOnce({
            ...makeResponse(NETWORK_BODY),
            clone: () => {
                throw new TypeError('body already used');
            },
        });

        await expect(dispatchFetch(sw, CHUNK)[0]).rejects.toThrow('body already used');
    });

    it('does not touch the store before the network answers', async () => {
        // caches.match first was the whole of the old path.
        await dispatchLifecycle(sw, 'install');
        sw.entriesFor(sw.opened[0]).set(CHUNK, makeResponse(PLANTED));
        const openedBefore = sw.opened.length;
        let answer: (response: FakeResponse) => void = () => {};
        sw.fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));

        const pending = dispatchFetch(sw, CHUNK)[0];
        await flush();
        expect(sw.opened).toHaveLength(openedBefore);

        answer(makeResponse(NETWORK_BODY));
        await expect(pending).resolves.toMatchObject({ body: NETWORK_BODY });
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

    it('does not let a bad answer overwrite the offline copy', async () => {
        // A captive portal answering 200 with its login page, or an edge 5xx
        // during a deploy, would otherwise become this visitor's offline
        // fallback until the next cache rename.
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        sw.fetchMock.mockResolvedValueOnce(makeResponse('captive portal login', 503));

        await dispatchFetch(sw, `${ORIGIN}/download`, 'navigate')[0];
        await flush();

        expect(sw.stores.get(current)?.get(`${ORIGIN}/download`)).toMatchObject({
            body: 'precached /download',
        });
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

    it('leaves case-variant docs navigations alone too', () => {
        // A case-sensitive guard would miss these and the navigate branch would
        // cache them, which is the leak the whole change exists to close.
        expect(dispatchFetch(sw, `${ORIGIN}/DOCS/changelog`, 'navigate')).toHaveLength(0);
        expect(dispatchFetch(sw, `${ORIGIN}/Docs/changelog`, 'navigate')).toHaveLength(0);
    });

    it('does not mistake a route that merely starts with the letters docs', () => {
        // A bare startsWith('/docs') would swallow both of these, which are ours.
        expect(dispatchFetch(sw, `${ORIGIN}/docsomething`, 'navigate')).toHaveLength(1);
        expect(dispatchFetch(sw, `${ORIGIN}/docs-archive`, 'navigate')).toHaveLength(1);
    });
});

describe('share links and request links', () => {
    // A room id or a request link id in Cache Storage is a copy of a capability
    // on the visitor's disk. An empty dispatch means the worker never took the
    // request over, which is the only path to the Cache API (see the top of
    // this file).
    const ROOM_ID = '7f3a9c2e-1b4d-4e8f-9a6b-2c5d8e1f0a3b';

    it('does not cache a navigation that carries a room fragment', () => {
        // The CLI's link shape: a fragment and no nonce.
        expect(dispatchFetch(sw, `${ORIGIN}/#room=${ROOM_ID}`, 'navigate')).toHaveLength(0);
    });

    it('does not cache a navigation that carries an s nonce without a fragment', () => {
        expect(dispatchFetch(sw, `${ORIGIN}/?s=abcd1234`, 'navigate')).toHaveLength(0);
    });

    it('does not cache a navigation that carries a legacy room query', () => {
        // Older links put the room id in ?room=<id>, which getRoomFromUrl and
        // the CLI's code.Resolve still accept. No fragment and no nonce, so only
        // the room predicate can stop it.
        expect(dispatchFetch(sw, `${ORIGIN}/?room=${ROOM_ID}`, 'navigate')).toHaveLength(0);
    });

    it('does not cache /?s=x#room=y', () => {
        expect(dispatchFetch(sw, `${ORIGIN}/?s=x#room=y`, 'navigate')).toHaveLength(0);
    });

    it('does not cache /r/abc#uuid', () => {
        expect(dispatchFetch(sw, `${ORIGIN}/r/abc#uuid`, 'navigate')).toHaveLength(0);
    });

    it('does not cache a link that carries a link key, in any shape', () => {
        const KEY = 'AbCdEfGhIjKlMnOpQrStUg';
        for (const link of [
            `${ORIGIN}/?s=x#k=${KEY}&room=${ROOM_ID}`,
            `${ORIGIN}/#k=${KEY}&room=${ROOM_ID}`,
            `${ORIGIN}/r/abc#${ROOM_ID}.${KEY}`,
            `${ORIGIN}/#k=${KEY}`,
            // No builder makes this one. A mangled link can, and with no fragment
            // and no nonce only the k guard stops it.
            `${ORIGIN}/?k=${KEY}`,
        ]) {
            expect(dispatchFetch(sw, link, 'navigate'), link).toHaveLength(0);
        }
    });

    it('a document planted under another cache name never answers a failed load', async () => {
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];
        sw.stores.delete(current);
        sw.entriesFor('elsewhere').set(`${ORIGIN}/`, makeResponse('planted document'));
        sw.entriesFor(current);
        sw.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await expect(dispatchFetch(sw, `${ORIGIN}/`, 'navigate')[0]).resolves.toBeUndefined();
    });

    it('holds the write that overwrites a stored document with waitUntil', async () => {
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];

        await dispatchFetch(sw, `${ORIGIN}/`, 'navigate')[0];

        expect(sw.held).toHaveLength(1);
        await sw.held[0];
        expect(sw.stores.get(current)?.get(`${ORIGIN}/`)).toMatchObject({ body: NETWORK_BODY });
    });

    it('does not cache /R/abc', () => {
        // No fragment and no nonce, so only the lowercased /r guard can stop it.
        expect(dispatchFetch(sw, `${ORIGIN}/R/abc`, 'navigate')).toHaveLength(0);
    });

    it('does not cache the bare /r path', () => {
        expect(dispatchFetch(sw, `${ORIGIN}/r`, 'navigate')).toHaveLength(0);
    });

    it('does not mistake a route that merely starts with the letter r', () => {
        expect(dispatchFetch(sw, `${ORIGIN}/relay`, 'navigate')).toHaveLength(1);
        expect(dispatchFetch(sw, `${ORIGIN}/r-archive`, 'navigate')).toHaveLength(1);
    });

    it('still caches /', async () => {
        await dispatchLifecycle(sw, 'install');
        const current = sw.opened[0];

        const handled = dispatchFetch(sw, `${ORIGIN}/`, 'navigate');
        expect(handled).toHaveLength(1);
        await handled[0];
        await flush();

        expect(sw.stores.get(current)?.get(`${ORIGIN}/`)).toMatchObject({ body: NETWORK_BODY });
    });

    it('still leaves /docs alone', () => {
        expect(dispatchFetch(sw, `${ORIGIN}/docs`, 'navigate')).toHaveLength(0);
        expect(dispatchFetch(sw, `${ORIGIN}/docs/changelog`, 'navigate')).toHaveLength(0);
    });
});
