import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// The /r visitor page, before any of it does anything.
//
// Every test here is about what does NOT happen. A request link is a capability
// sitting in a URL that will be pasted into chat apps, mail clients and link
// scanners, and the promise the page makes is that opening it costs the visitor
// and the host nothing: no room seat taken, no IP address gathered, no id handed
// to an analytics vendor, no copy of the URL left in Cache Storage, and no
// Referer carrying the link id to the next origin the visitor clicks through to.
//
// "No socket" is asserted by counting requests rather than by looking at the UI,
// because the failure this guards against is invisible: a page that joined the
// room and then rendered the same words.
// ---------------------------------------------------------------------------

const LINK_ID = 'AAAAAAAAAAA';
const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const LINK = `/r/${LINK_ID}#${ROOM_ID}`;

/** `page.waitForFunction` as a boolean: did the condition hold in time? Used
 *  where a timeout is an answer rather than a failure. */
async function waitFor(
    page: Page,
    condition: () => boolean | Promise<boolean>,
    timeout: number
): Promise<boolean> {
    return page
        .waitForFunction(condition, null, { timeout })
        .then(() => true)
        .catch(() => false);
}

/** Every request that would mean the page reached for the network on load. */
function watchSignaling(page: Page): string[] {
    const seen: string[] = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('socket.io') || url.includes('turn-credentials')) seen.push(url);
    });
    return seen;
}

test.describe('request privacy', () => {
    test.skip(
        !!process.env.CI && process.env.FLOE_E2E_REQUEST_LINK !== '1',
        'runs in the non-gating request-link job until S1-WEB-09'
    );

    test('E2E-09 no /r entry in Cache Storage', async ({ page }) => {
        await page.goto('/');

        // components/ServiceWorkerRegistration.tsx gates registration on
        // NODE_ENV === 'production', so under `next dev` there is no worker and
        // no Cache Storage at all. The assertions below are still true there,
        // just not informative, which is why the non-vacuity check at the end
        // runs only when a worker actually took control.
        //
        // Two waits rather than one long one: a dev run has no registration to
        // find and gives up after three seconds, while a production run gets a
        // generous window for install, activate and claim.
        const registered = await waitFor(
            page,
            () => navigator.serviceWorker?.getRegistration().then((r) => !!r),
            3_000
        );
        const controlled =
            registered && (await waitFor(page, () => !!navigator.serviceWorker.controller, 20_000));

        // Twice: the first navigation is the one a worker could cache, the
        // second is the one it could serve from cache and re-store.
        await page.goto(LINK);
        await page.goto(LINK);

        const urls = await page.evaluate(async () => {
            const out: string[] = [];
            for (const name of await caches.keys()) {
                const cache = await caches.open(name);
                for (const request of await cache.keys()) out.push(request.url);
            }
            return out;
        });

        for (const url of urls) {
            expect(url, 'a request link was written to Cache Storage').not.toContain('/r/');
            // A fragment in a cache key is the older shape of the same leak:
            // a navigation's request.url keeps the fragment, so a cached
            // /?s=n#room=<uuid> would store a room secret on disk.
            expect(url, 'a fragment was written to Cache Storage').not.toContain('#');
        }

        if (controlled) {
            // Non-vacuity: the worker really is writing entries (it precaches
            // "/" at install), so "no /r entry" is a statement about /r rather
            // than about an empty cache.
            expect(urls.some((u) => new URL(u).pathname === '/')).toBe(true);
        }
    });

    test('E2E-10 no-referrer header and no Umami on /r', async ({ page }) => {
        // Nothing leaves this machine even if the assertion below is wrong.
        await page.route('https://cloud.umami.is/**', (route) => route.abort());
        const umami: string[] = [];
        page.on('request', (req) => {
            if (req.url().includes('cloud.umami.is')) umami.push(req.url());
        });

        const response = await page.goto(LINK);
        expect(response?.headers()['referrer-policy']).toBe('no-referrer');

        await expect(page.locator('script[src*="cloud.umami.is"]')).toHaveCount(0);
        expect(umami).toEqual([]);

        if (process.env.E2E_EXPECT_UMAMI === '1') {
            // The build under test has a website id, so "no script on /r" means
            // the path gate, not an absent id. Without this arm the assertion
            // above passes on every build that simply has analytics turned off.
            const home = await page.goto('/');
            expect(home?.headers()['referrer-policy']).toBe(
                'strict-origin-when-cross-origin'
            );
            const script = page.locator('script[src*="cloud.umami.is"]');
            await expect(script).toHaveCount(1);
            await expect(script).toHaveAttribute('data-exclude-hash', 'true');
            await expect(script).toHaveAttribute('data-exclude-search', 'true');
        }
    });

    test('E2E-12 unsupported browser opens no socket', async ({ page }) => {
        await page.addInitScript(() => {
            // The capability the page probes for. Deleting the constructor is
            // what a browser without data channels looks like from here.
            delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
        });
        const signaling = watchSignaling(page);

        await page.goto(LINK);

        await expect(page.getByText('This browser cannot send through Floe')).toBeVisible();
        await expect(page.getByText('Open the link in current Chrome or Edge.')).toBeVisible();
        // A terminal state offers nothing to retry, so nothing should appear
        // after it either.
        await page.waitForTimeout(1_000);
        expect(signaling).toEqual([]);
    });

    test('E2E-13 incomplete link opens no socket', async ({ page }) => {
        const signaling = watchSignaling(page);

        // The link without everything after the #, which is the likeliest way
        // for one to arrive broken.
        await page.goto(`/r/${LINK_ID}`);

        await expect(page.getByText('This link looks incomplete')).toBeVisible();
        await expect(
            page.getByText('Copy the whole link again, including everything after the # sign.')
        ).toBeVisible();
        await page.waitForTimeout(1_000);
        expect(signaling).toEqual([]);
    });

    test('no socket and no turn-credentials request on page load', async ({ page }) => {
        const signaling = watchSignaling(page);

        await page.goto(LINK);

        // A whole, usable link on a supported browser: the page shows the Ready
        // header and still reaches for nothing. Joining is the visitor's move,
        // not the page's, which is what keeps a link scanner or a chat app's
        // preview fetcher from taking the seat or collecting an IP address.
        await expect(page.getByText('SEND FILES THROUGH THIS LINK')).toBeVisible();
        await expect(
            page.getByText('This is a Floe request link.', { exact: false })
        ).toBeVisible();
        await page.waitForTimeout(1_000);
        expect(signaling).toEqual([]);
    });
});
