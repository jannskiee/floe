import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as e2e from '../e2e/warm-images';
import { IMAGE_ACCEPT, WARM_PAGES, WARM_FAILED_LINE, imageAddresses, warmImageCache } from '../docker/warm-images.mjs';

// The self-hosted image's warm-up of its own image optimizer (owner answer
// 25): docker/start.mjs starts the server, then docker/warm-images.mjs asks it
// once for every picture the pages use. The e2e suite has warmed the same way
// since #577 (e2e/warm-images.ts, which says why); that file may import
// nothing, so the image carries a copy, and this holds the two together.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the image warm-up reads pages as the e2e warm-up does', () => {
    const PAGES = [
        '<img srcset="/_next/image?url=%2Fscreenshots%2Fa.png&amp;w=640&amp;q=75 640w, /_next/image?url=%2Fscreenshots%2Fa.png&amp;w=750&amp;q=75 750w">',
        '<link rel="preload" as="image" imageSrcSet="/_next/image?url=%2Fgithub-mark-white.png&amp;w=32&amp;q=75 1x"/>' +
            '<script>self.__next_f.push([1,"/_next/image?url=%2Fscreenshots%2Fa.png\\u0026w=750\\u0026q=75"])</script>',
        '<a href="/_next/image?url=%2Fa.png">no width</a><a href="/_next/image?w=640&amp;q=75">no image</a>',
        '<p>no images</p>',
    ];

    for (const [i, html] of PAGES.entries()) {
        it(`page ${i + 1}: the same addresses`, () => {
            expect(imageAddresses(html)).toEqual(e2e.imageAddresses(html));
        });
    }

    it('the same pages and the same Accept header', () => {
        expect(WARM_PAGES).toEqual(e2e.WARM_PAGES);
        expect(IMAGE_ACCEPT).toBe(e2e.IMAGE_ACCEPT);
    });
});

describe('warmImageCache', () => {
    const ORIGIN = 'http://127.0.0.1:3000';
    const IMG = '/_next/image?url=%2Fa.png&amp;w=32&amp;q=75';

    // A stand-in server: refuses the first `down` connections, then serves
    // two pages that share one image and a remote one, and records each ask.
    function standIn(opts: { down?: number; imageStatus?: number } = {}) {
        const asked: { url: string; accept: string | null; signal: unknown }[] = [];
        let down = opts.down ?? 0;
        let open = 0;
        let mostOpen = 0;
        const fetchFn = async (url: string, init: { headers?: Record<string, string>; signal?: unknown } = {}) => {
            if (down > 0) {
                down -= 1;
                throw new TypeError('fetch failed');
            }
            asked.push({ url, accept: init.headers?.accept ?? null, signal: init.signal });
            open += 1;
            mostOpen = Math.max(mostOpen, open);
            await new Promise((r) => setTimeout(r, 1));
            open -= 1;
            const path = url.slice(ORIGIN.length);
            if (path.startsWith('/_next/image')) {
                return new Response(new Uint8Array(4), { status: opts.imageStatus ?? 200 });
            }
            const html =
                path === '/'
                    ? `<img src="${IMG}"><img src="/_next/image?url=https%3A%2F%2Fexample.com%2Fx.png&amp;w=32&amp;q=75">`
                    : `<img src="${IMG}">`;
            return new Response(html, { status: 200 });
        };
        return { fetchFn, asked, mostOpen: () => mostOpen };
    }

    it('waits for the server, then asks for every local image once, one at a time', async () => {
        const s = standIn({ down: 3 });
        const ok = await warmImageCache({ origin: ORIGIN, fetch: s.fetchFn as typeof fetch, pages: ['/', '/download'], retryDelayMs: 1 });
        expect(ok).toBe(true);
        expect(s.asked.map((a) => a.url)).toEqual([
            `${ORIGIN}/`,
            `${ORIGIN}/download`,
            `${ORIGIN}/_next/image?url=%2Fa.png&w=32&q=75`,
        ]);
        expect(s.mostOpen()).toBe(1);
        expect(s.asked[2].accept).toBe(IMAGE_ACCEPT);
    });

    it('asks only its own server, and never for a picture from another host', async () => {
        const s = standIn();
        await warmImageCache({ origin: ORIGIN, fetch: s.fetchFn as typeof fetch, pages: ['/'], retryDelayMs: 1 });
        for (const a of s.asked) expect(a.url.startsWith(`${ORIGIN}/`)).toBe(true);
        expect(s.asked.some((a) => a.url.includes('example.com'))).toBe(false);
    });

    it('never abandons a request: abandoning one is what leaves an image unanswerable', async () => {
        const s = standIn();
        await warmImageCache({ origin: ORIGIN, fetch: s.fetchFn as typeof fetch, pages: ['/'], retryDelayMs: 1 });
        for (const a of s.asked) expect(a.signal).toBeUndefined();
    });

    it('reports a failure instead of throwing', async () => {
        const bad = standIn({ imageStatus: 500 });
        expect(await warmImageCache({ origin: ORIGIN, fetch: bad.fetchFn as typeof fetch, pages: ['/'], retryDelayMs: 1 })).toBe(false);
        const never = standIn({ down: 1_000 });
        expect(
            await warmImageCache({ origin: ORIGIN, fetch: never.fetchFn as typeof fetch, pages: ['/'], retryDelayMs: 1, tries: 5 })
        ).toBe(false);
    });
});

describe('docker/start.mjs', () => {
    const START = read('../docker/start.mjs');
    const DOCKERFILE = read('../Dockerfile');

    it('starts the server first and never waits on the warm-up', () => {
        const server = START.indexOf("await import('./server.js')");
        const warm = START.indexOf("import('./warm-images.mjs')");
        expect(server).toBeGreaterThan(-1);
        expect(warm).toBeGreaterThan(server);
        // The warm-up runs in a function nothing awaits; the server import is
        // the module's only top-level await.
        const detached = START.indexOf('void (async () => {');
        expect(detached).toBeGreaterThan(server);
        expect(warm).toBeGreaterThan(detached);
        expect(START.slice(0, detached).match(/\bawait\b/g)).toHaveLength(1);
    });

    it('logs one fixed line, and only on failure', () => {
        expect(WARM_FAILED_LINE).toBe('Floe: the image warm-up did not finish; pictures are resized on first request instead.');
        expect(START).toContain(WARM_FAILED_LINE);
        expect(START.match(/console\./g)).toHaveLength(1);
        expect(START).toContain('console.warn(WARM_FAILED_LINE)');
    });

    it('is what the image runs', () => {
        expect(DOCKERFILE).toContain('CMD ["node", "start.mjs"]');
        expect(DOCKERFILE).toContain('/app/docker/start.mjs');
        expect(DOCKERFILE).toContain('/app/docker/warm-images.mjs');
    });
});
