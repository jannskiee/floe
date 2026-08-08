// Bump on any change to what is cached OR to the response headers, because the
// Cache API stores whole responses, headers included. Without a bump, returning
// visitors keep pre-change copies indefinitely. The bump is also the only purge
// this worker has: the activate handler below deletes every cache that is not
// the current one, so renaming is how a bad entry gets evicted from a machine
// we cannot reach.
//
// v5 replaces a denylist with an allowlist. v4 served every same-origin
// non-navigation GET cache-first and forever, which froze three classes of URL
// that are dynamic at a fixed address:
//
//   /docs        a reverse-proxy rewrite onto a Mintlify deployment we do not
//                version (see the rewrites in next.config.mjs). Measured on the
//                live site, this pinned docs pages to a deployment three
//                releases old across 230 entries, and a visitor had no way to
//                recover short of clearing site data.
//   /_next/image a live optimizer whose output changes with the source file and
//                with the images config.
//   ?_rsc=       the payloads the App Router fetches on client-side navigation.
//                These are worse than stale text: a cached payload names chunks
//                from the deployment that produced it, which is exactly the
//                stale-bundle error lib/staleBundle.ts reloads to escape, and a
//                reload cannot clear the Cache API. The worker was manufacturing
//                the failure that module exists to recover from, then disabling
//                its remedy.
const CACHE_NAME = 'floe-cache-v5';

// Navigations only. These are the documents that must still render with no
// network, served by the fallback in the navigate branch below. /github-mark-white.png
// used to sit here and was never once a hit: the footer renders it through
// next/image, so the URL the browser actually asks for is /_next/image?url=...
const STATIC_ASSETS = [
    '/',
    '/download',
    '/how-it-works',
    '/privacy',
    '/terms',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== 'GET') return;
    if (url.hostname !== self.location.hostname) return;
    if (url.pathname.includes('socket.io')) return;
    // Never cache API traffic. /api/config carries the runtime server address, so
    // a cached copy would pin the client to a stale one forever. Behind a
    // one-domain reverse proxy the signaling server's own /api/ routes are
    // same-origin too. The allowlist at the bottom would exclude these anyway,
    // but the guard stays explicit because lib/socketUrl.ts documents it as a
    // guarantee its callers depend on.
    if (url.pathname.startsWith('/api/')) return;

    // The docs are a reverse-proxy rewrite, which makes a third-party site
    // same-origin and therefore ours to break. Mintlify ships its own HTML, its
    // own RSC payloads and its own build output, all of which change whenever it
    // redeploys and none of which we version. This has to sit ABOVE the navigate
    // branch, or docs pages get cached as navigations and only a rename evicts
    // them. The predicate mirrors the two rewrite rules in next.config.mjs
    // exactly, rather than a bare prefix test that would also swallow a future
    // route like /docsomething.
    if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // Cache-first is only ever correct for a URL whose bytes cannot change, and
    // /_next/static is the one path where Next guarantees that: the filename
    // carries a hash of the contents, so a changed file gets a new URL instead
    // of a new answer at the old one. That covers the JS chunks, the CSS, and the
    // self-hosted next/font woff2 files under /_next/static/media.
    //
    // Everything else on this origin is dynamic at a fixed address, including
    // /_next/image, the ?_rsc= payloads, sitemap.xml, robots.txt, the web app
    // manifest and the hash-suffixed icon routes. All of it goes to the network
    // exactly as it would with no worker registered at all.
    if (!url.pathname.startsWith('/_next/static/')) return;

    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(request).then((response) => {
                if (response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                }
                return response;
            });
        })
    );
});
