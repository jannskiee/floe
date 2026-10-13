import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IMAGE_ACCEPT, WARM_PAGES, imageAddresses, warmImages } from '../e2e/warm-images';

// The e2e suite's warm-up of the image optimizer (e2e/warm-images.ts, which
// says why it exists). It lives here because vitest reads lib/ and app/ only,
// and a *.test.ts under e2e/ would be collected by Playwright.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('imageAddresses', () => {
    const A640 = '/_next/image?url=%2Fscreenshots%2Fa.png&w=640&q=75';
    const A750 = '/_next/image?url=%2Fscreenshots%2Fa.png&w=750&q=75';
    const MARK = '/_next/image?url=%2Fgithub-mark-white.png&w=32&q=75';

    it('reads every candidate out of a srcset, with the entity between parameters undone', () => {
        const html =
            '<img alt="" loading="lazy" sizes="100vw" ' +
            'srcset="/_next/image?url=%2Fscreenshots%2Fa.png&amp;w=640&amp;q=75 640w, ' +
            '/_next/image?url=%2Fscreenshots%2Fa.png&amp;w=750&amp;q=75 750w" ' +
            'src="/_next/image?url=%2Fscreenshots%2Fa.png&amp;w=750&amp;q=75"/>';
        expect(imageAddresses(html)).toEqual([A640, A750]);
    });

    it('reads a preload link and the page data script, where the quote is escaped', () => {
        const html =
            '<link rel="preload" as="image" imageSrcSet="/_next/image?url=%2Fgithub-mark-white.png&amp;w=32&amp;q=75 1x"/>' +
            '<script>self.__next_f.push([1,"{\\"src\\":\\"/_next/image?url=%2Fscreenshots%2Fa.png&w=640&q=75\\"}"])</script>' +
            '<script>self.__next_f.push([1,"/_next/image?url=%2Fscreenshots%2Fa.png\\u0026w=750\\u0026q=75"])</script>';
        expect(imageAddresses(html)).toEqual([MARK, A640, A750]);
    });

    it('lists an address once however often the page names it, in a fixed order', () => {
        const html = `<img src="${MARK}"><img src="${A750}"><img src="${MARK}"><img srcset="${A640} 1x, ${A750} 2x">`;
        expect(imageAddresses(html)).toEqual([MARK, A640, A750]);
    });

    it('leaves out anything that is not a whole address', () => {
        const html =
            '<a href="/_next/image?url=%2Fa.png">no width</a>' +
            '<a href="/_next/image?w=640&amp;q=75">no image</a>' +
            '<a href="/_next/image?url=%2Fa.png&amp;w=wide&amp;q=75">a width that is not a number</a>' +
            '<a href="/_next/static/chunks/main.js">not the optimizer</a>';
        expect(imageAddresses(html)).toEqual([]);
    });

    it('finds nothing in a page with no images', () => {
        expect(imageAddresses('<html><body><p>Send files</p></body></html>')).toEqual([]);
    });
});

describe('warmImages', () => {
    // A stand-in for the client: two pages that share one image, and a record
    // of what was asked for, in order, and how many requests were open at once.
    function standIn(answers: Record<string, number> = {}) {
        const asked: { path: string; accept: string | null }[] = [];
        let open = 0;
        let mostOpen = 0;
        const pages: Record<string, string> = {
            '/': '<img srcset="/_next/image?url=%2Fa.png&amp;w=640&amp;q=75 640w, /_next/image?url=%2Fa.png&amp;w=750&amp;q=75 750w">',
            '/download': '<img src="/_next/image?url=%2Fa.png&amp;w=640&amp;q=75"><img src="/_next/image?url=%2Fb.png&amp;w=32&amp;q=75">',
        };
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const path = url.pathname + url.search;
            asked.push({ path, accept: new Headers(init?.headers).get('accept') });
            open++;
            mostOpen = Math.max(mostOpen, open);
            await new Promise((r) => setTimeout(r, 2));
            open--;
            const status = answers[path] ?? (path in pages || path.startsWith('/_next/image') ? 200 : 404);
            return new Response(pages[path] ?? 'x', { status });
        }) as typeof fetch;
        return { asked, mostOpen: () => mostOpen, restore: () => void (globalThis.fetch = original) };
    }

    it('asks for each page, then each image once, one request at a time, as a browser would ask', async () => {
        const server = standIn();
        try {
            const count = await warmImages('http://localhost:3000/', ['/', '/download']);
            expect(count).toBe(3);
            expect(server.asked.map((a) => a.path)).toEqual([
                '/',
                '/download',
                '/_next/image?url=%2Fa.png&w=640&q=75',
                '/_next/image?url=%2Fa.png&w=750&q=75',
                '/_next/image?url=%2Fb.png&w=32&q=75',
            ]);
            // Never two at once: this is the warm-up, not a load test.
            expect(server.mostOpen()).toBe(1);
            for (const a of server.asked.slice(2)) expect(a.accept).toBe(IMAGE_ACCEPT);
        } finally {
            server.restore();
        }
    });

    it('stops the run, naming the address, when an image cannot be had', async () => {
        const server = standIn({ '/_next/image?url=%2Fa.png&w=750&q=75': 500 });
        try {
            await expect(warmImages('http://localhost:3000', ['/', '/download'])).rejects.toThrow(
                'warm-images: /_next/image?url=%2Fa.png&w=750&q=75 answered 500'
            );
        } finally {
            server.restore();
        }
    });

    it('stops the run when a page does not load', async () => {
        const server = standIn();
        try {
            await expect(warmImages('http://localhost:3000', ['/', '/gone'])).rejects.toThrow('warm-images: /gone answered 404');
        } finally {
            server.restore();
        }
    });
});

describe('the suite runs the warm-up before its first test', () => {
    it('is awaited by the global setup, against the address the tests use', () => {
        const setup = read('../e2e/global-setup.ts');
        expect(setup).toMatch(/export default async function globalSetup\(/);
        expect(setup).toMatch(/await warmImages\(/);
    });

    it('covers every page the image test opens', () => {
        const spec = read('../e2e/image-density.spec.ts');
        const opened = [...spec.matchAll(/page\.goto\('([^']+)'\)/g)].map((m) => m[1]);
        expect(opened.length).toBeGreaterThan(1);
        for (const page of opened) expect(WARM_PAGES, page).toContain(page);
    });
});
