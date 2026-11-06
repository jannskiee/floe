import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// What the service worker does with a chunk somebody planted.
//
// Any script that runs once on this origin can write to Cache Storage: a tracker,
// or Mintlify's scripts under /docs, which are same-origin through the rewrite.
// When the worker answered /_next/static from its store first, one such write
// was a chunk that ran on every later load, across deploys, on the page that
// holds a transfer's link. public/sw.js now asks the network first and uses the
// store only when fetch itself rejects. lib/serviceWorker.test.ts holds the
// branches; this holds them in a real browser, with a real chunk and a real load.
//
// lib/serviceWorkerRegistration.ts registers the worker in a production build
// only, so `next dev` has none. CI serves a production build. To run this
// locally, build it the way CI does and serve it the same way:
//
//   NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001 pnpm build
//   CI=1 pnpm test:e2e service-worker.spec.ts
// ---------------------------------------------------------------------------

const CACHE_NAME = 'floe-cache-v7';
const PLANTED = 'window.__floePlanted = 1;';

test('a chunk planted in Cache Storage does not run on an online load, and the load overwrites it', async ({
    page,
}) => {
    // On a build with a website id the tracker runs here too, and a page view
    // from a test is not a visit. This test needs the worker, and page.route is
    // not promised to see past one, so Umami's own switch keeps it quiet as well.
    await page.route(
        (url) => url.hostname === 'umami.is' || url.hostname.endsWith('.umami.is'),
        (route) => route.abort()
    );
    await page.addInitScript(() => {
        localStorage.setItem('umami.disabled', '1');
    });

    await page.goto('/');

    // Polled from here: waitForFunction takes the promise this returns as truthy
    // whatever it resolves to, so it cannot answer the question.
    const registered = await expect
        .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)), {
            timeout: process.env.CI ? 30_000 : 5_000,
        })
        .toBe(true)
        .then(
            () => true,
            () => false
        );
    // Never vacuous on CI, where the build is a production one.
    if (process.env.CI) expect(registered, 'a production build registers the worker').toBe(true);
    test.skip(!registered, 'next dev registers no service worker; see the top of this file');

    // install precaches, activate purges and claims.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });

    // A chunk the document itself names, so the reload has to ask for it.
    const chunk = await page.evaluate(() => {
        const script = [...document.scripts].find((s) => new URL(s.src || location.href).pathname.startsWith('/_next/static/chunks/'));
        return script?.src ?? null;
    });
    expect(chunk, 'the page names a build chunk').not.toBeNull();
    const url = chunk as string;

    // What the host really serves for that address, asked for outside the page
    // and outside its worker.
    const real = await (await page.request.get(url)).text();
    expect(real).not.toContain('__floePlanted');

    await page.evaluate(
        async ({ url, body, cacheName }) => {
            const cache = await caches.open(cacheName);
            await cache.put(
                new Request(url),
                new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript' } })
            );
        },
        { url, body: PLANTED, cacheName: CACHE_NAME }
    );

    // Online, under the worker that was just given the chance.
    await page.reload();

    const after = await page.evaluate((chunkUrl) => {
        return {
            planted: (window as unknown as Record<string, unknown>).__floePlanted,
            controlled: !!navigator.serviceWorker.controller,
            asked: performance.getEntriesByName(chunkUrl).length,
        };
    }, url);
    // Non-vacuity: the reload went through the worker and asked for this chunk,
    // so a plant the worker served would have run before the load event.
    expect(after.controlled, 'the reload was under the worker').toBe(true);
    expect(after.asked, 'the reload asked for the planted chunk').toBeGreaterThan(0);
    expect(after.planted, 'the planted chunk ran').toBeUndefined();

    // The worker stores every 200 it gets, a beat after answering.
    await expect
        .poll(
            () =>
                page.evaluate(
                    async ({ url, cacheName }) => {
                        const entry = await (await caches.open(cacheName)).match(url);
                        return entry ? entry.text() : null;
                    },
                    { url, cacheName: CACHE_NAME }
                ),
            { message: 'the stored entry holds the real bytes again' }
        )
        .toBe(real);

    // The cache of this version is the only one left.
    expect(await page.evaluate(() => caches.keys())).toEqual([CACHE_NAME]);

    // One more plant, the one an online load cannot reach: under another name,
    // and older than the worker's own cache, so caches.match would find it first.
    // A rejected fetch has to read the worker's cache and no other.
    await page.evaluate(
        async ({ url, body, cacheName }) => {
            await caches.delete(cacheName);
            const elsewhere = await caches.open('elsewhere');
            await caches.open(cacheName);
            await elsewhere.put(
                new Request(url),
                new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript' } })
            );
        },
        { url, body: PLANTED, cacheName: CACHE_NAME }
    );
    await page.reload();
    await expect
        .poll(
            () =>
                page.evaluate(
                    async ({ url, cacheName }) => {
                        const entry = await (await caches.open(cacheName)).match(url);
                        return entry ? entry.text() : null;
                    },
                    { url, cacheName: CACHE_NAME }
                ),
            { message: "the worker's own cache holds the real bytes again" }
        )
        .toBe(real);

    // A load whose every fetch rejects. The document and the chunk come from the
    // worker's cache, or the plant would run here.
    await page.context().setOffline(true);
    await page.reload();
    const offline = await page.evaluate((chunkUrl) => {
        return {
            planted: (window as unknown as Record<string, unknown>).__floePlanted,
            controlled: !!navigator.serviceWorker.controller,
            asked: performance.getEntriesByName(chunkUrl).length,
        };
    }, url);
    expect(offline.controlled, 'the offline load was under the worker').toBe(true);
    expect(offline.asked, 'the offline load asked for the chunk').toBeGreaterThan(0);
    expect(offline.planted, 'a rejected fetch read the plant').toBeUndefined();
});
