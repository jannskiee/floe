/**
 * Asks the client for every image its pages can show, one at a time and
 * patiently, before any test runs.
 *
 * Why the suite needs it. A page's first request for an image at a width makes
 * Next's optimizer resize the master then and there. If the browser abandons
 * that request while the resize is under way, which is what a test does every
 * time it closes a page that is still loading, the optimizer is left holding
 * unfinished work for that image and width, and every later request for the
 * same address waits on it. Measured on Next 16.3.8 under `next start`
 * (2026-10-14): one request abandoned 5 ms in, and a second request for the
 * same address had no answer 330 s later. Other images and other widths were
 * answered in under 100 ms throughout. The address answers again only some
 * time after everyone has stopped asking for it.
 *
 * In the suite this showed as image-density.spec.ts failing at its 60 s wait,
 * and failing again on its retry, on whichever runner an earlier test had
 * closed the home page at the wrong moment: macOS and Windows both, on
 * 2026-10-13. The trace of one retry holds four image requests, three answered
 * in under 15 ms and one with no answer at all. It was read as a slow runner
 * and the wait was raised from 15 s to 60 s, which changed nothing, because
 * the image was never coming.
 *
 * Next 16.4.0 fixed it upstream (vercel/next.js#98168, issue #96538). Measured
 * 2026-10-15 under `next start`: six fresh starts whose first image request
 * was dropped at the socket at once left the address unanswered past 30 s on
 * 16.3.8 every time, and answered within 112 ms on 16.4.0 every time. The
 * warm-up stays: it is one request per picture, it keeps the suite from
 * resting on that fix, and no test pays for a cold resize.
 *
 * An image that is already in the optimizer's cache is not affected: forty
 * requests abandoned within 3 ms of a cached address left it answering in
 * 3 ms. So nothing here stops a test from closing a page. It makes sure no
 * test is ever the first to ask.
 *
 * Every address a browser can ask for is in the page's served HTML, because
 * next/image writes all of an image's candidate widths into its srcset. That
 * is where the list comes from, so a new image or a new width needs no edit
 * here.
 *
 * No imports, for the reason cli-binary.ts gives: global-setup.ts loads this
 * in-process, and lib/e2eWarmImages.test.ts imports it under vitest.
 */

/** The site's pages. Every spec that loads a page with an image loads one of
 *  these; lib/e2eWarmImages.test.ts holds image-density.spec.ts to the list. */
export const WARM_PAGES: readonly string[] = ['/', '/download', '/how-it-works', '/privacy', '/terms'];

/** What Chromium sends with an image request. The optimizer picks the output
 *  format from it and keys its cache by that format, so a warm-up that sent
 *  another header could fill a different entry from the one a test asks for. */
export const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

/**
 * Every optimizer address in a page's HTML, each once, sorted.
 *
 * The same address shows up in three spellings: in an attribute (`&amp;`
 * between its parameters), in a preload link, and inside the page data script,
 * where it sits in a JavaScript string: the closing quote is escaped, and an
 * ampersand may be written \u0026. An address ends at white space, a quote, a
 * comma (srcset separates candidates with one) or any other backslash.
 */
export function imageAddresses(html: string): string[] {
    const found = new Set<string>();
    for (const match of html.matchAll(/\/_next\/image\?(?:\\u0026|[^"'\s<>,\\])+/g)) {
        const address = match[0].replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
        const params = new URLSearchParams(address.slice(address.indexOf('?') + 1));
        // Only a whole address: the image, a width and a quality.
        if (params.get('url') && /^\d+$/.test(params.get('w') ?? '') && /^\d+$/.test(params.get('q') ?? '')) {
            found.add(address);
        }
    }
    return [...found].sort();
}

/**
 * Loads each page, then each image address the pages name, one request at a
 * time. Returns how many addresses it asked for. Throws, naming the address,
 * on anything but a 200: a run whose images cannot be had should stop here,
 * before a test reports it as a timeout somewhere else.
 */
export async function warmImages(
    base: string,
    pages: readonly string[] = WARM_PAGES,
    limitMs = 120_000
): Promise<number> {
    const origin = base.replace(/\/+$/, '');
    const addresses = new Set<string>();
    for (const page of pages) {
        const res = await fetch(origin + page, { signal: AbortSignal.timeout(limitMs) });
        if (!res.ok) throw new Error(`warm-images: ${page} answered ${res.status}`);
        for (const address of imageAddresses(await res.text())) addresses.add(address);
    }
    for (const address of addresses) {
        let status: number;
        try {
            const res = await fetch(origin + address, {
                headers: { accept: IMAGE_ACCEPT },
                signal: AbortSignal.timeout(limitMs),
            });
            await res.arrayBuffer();
            status = res.status;
        } catch {
            throw new Error(`warm-images: no answer for ${address} within ${limitMs / 1000} s`);
        }
        if (status !== 200) throw new Error(`warm-images: ${address} answered ${status}`);
    }
    return addresses.size;
}
