// Asks the self-hosted client, from inside its own container, for every picture
// its pages use, once, right after it starts (owner answer 25).
//
// Why. A page's first request for an image at a width makes Next's optimizer
// resize the master then and there. If the browser abandons that request while
// the resize is under way, the optimizer is left holding unfinished work for
// that image and width, and every later request for the same address waits on
// it: measured on Next 16.3.8, one request abandoned 5 ms in and a second for
// the same address had no answer 330 s later. An image already in the cache
// is not affected. So nothing a visitor does can leave a picture unanswerable
// once this has asked for each one first, and patiently: this never abandons a
// request itself. Next 16.4.0 fixed the stall upstream (vercel/next.js#98168;
// e2e/warm-images.ts holds the before-and-after measurement). The warm-up
// stays as a cheap guard, and it spares each picture's first visitor the
// resize.
//
// The e2e suite has warmed the same way since #577 (e2e/warm-images.ts, which
// holds the measurement). That file may import nothing, so the logic is
// copied here, and lib/dockerWarm.test.ts holds the two copies together.
//
// It asks only its own server, at the loopback address, and only for
// pictures the site serves from its own public folder.

/** The site's pages, as e2e/warm-images.ts lists them. */
export const WARM_PAGES = ['/', '/download', '/how-it-works', '/privacy', '/terms'];

/** What Chromium sends with an image request. The optimizer picks the output
 *  format from it and keys its cache by that format. */
export const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

/** The one line docker/start.mjs prints, and only when this did not finish. */
export const WARM_FAILED_LINE =
    'Floe: the image warm-up did not finish; pictures are resized on first request instead.';

/**
 * Every optimizer address in a page's HTML, each once, sorted: the same
 * function as imageAddresses in e2e/warm-images.ts, which explains the three
 * spellings an address can take.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function imageAddresses(html) {
    const found = new Set();
    for (const match of html.matchAll(/\/_next\/image\?(?:\\u0026|[^"'\s<>,\\])+/g)) {
        const address = match[0].replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
        const params = new URLSearchParams(address.slice(address.indexOf('?') + 1));
        if (params.get('url') && /^\d+$/.test(params.get('w') ?? '') && /^\d+$/.test(params.get('q') ?? '')) {
            found.add(address);
        }
    }
    return [...found].sort();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the server at `origin` answers, then loads each page and asks
 * for each picture they name, one request at a time. Never throws: resolves
 * true when every answer was a 200, false otherwise. No request carries a
 * deadline, on purpose (see the top of this file).
 *
 * @param {{ origin: string, fetch?: typeof fetch, pages?: string[], tries?: number, retryDelayMs?: number }} opts
 * @returns {Promise<boolean>}
 */
export async function warmImageCache(opts) {
    const get = opts.fetch ?? globalThis.fetch;
    const pages = opts.pages ?? WARM_PAGES;
    const tries = opts.tries ?? 120;
    const retryDelayMs = opts.retryDelayMs ?? 500;
    try {
        const addresses = new Set();
        for (const [i, page] of pages.entries()) {
            let res = null;
            // Only the first page waits: once it answers, the server is up.
            for (let attempt = 0; res === null && attempt < (i === 0 ? tries : 1); attempt++) {
                try {
                    res = await get(opts.origin + page);
                } catch {
                    await sleep(retryDelayMs);
                }
            }
            if (res === null || !res.ok) return false;
            for (const address of imageAddresses(await res.text())) {
                // A picture from the public folder: its url starts with one
                // slash. Anything else would have the optimizer fetch another
                // host on this one's behalf.
                const source = new URLSearchParams(address.slice(address.indexOf('?') + 1)).get('url') ?? '';
                if (source.startsWith('/') && !source.startsWith('//')) addresses.add(address);
            }
        }
        let ok = true;
        for (const address of addresses) {
            const res = await get(opts.origin + address, { headers: { accept: IMAGE_ACCEPT } });
            await res.arrayBuffer();
            if (res.status !== 200) ok = false;
        }
        return ok;
    } catch {
        return false;
    }
}
