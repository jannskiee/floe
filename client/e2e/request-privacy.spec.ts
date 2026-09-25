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

/** Every request that would mean the page reached for the network on load.
 *
 *  `/api/config` is on the list because resolveSocketUrl() asks for it before
 *  any socket on a build with no NEXT_PUBLIC_SOCKET_URL baked in, so it is the
 *  earliest sign that something started resolving a signaling server.
 *
 *  The websocket listener is not redundant. Playwright's `request` event never
 *  fires for a WebSocket upgrade. Socket.IO's default transports start with
 *  HTTP polling, so a handshake is visible as a request today, but the day
 *  anyone pins `transports: ['websocket']` this helper would go quietly blind,
 *  and S1-WEB-03 reuses it for a page that really does open a socket. */
function watchSignaling(page: Page): string[] {
    const seen: string[] = [];
    const interesting = (url: string) =>
        url.includes('socket.io') ||
        url.includes('turn-credentials') ||
        url.includes('/api/config');
    page.on('request', (req) => {
        if (interesting(req.url())) seen.push(req.url());
    });
    // Filtered, not raw: `next dev` opens its own hot-reload socket
    // (/_next/webpack-hmr) on every page load, and an unfiltered watch counts
    // that as the page reaching for a signaling server.
    page.on('websocket', (ws) => {
        if (interesting(ws.url())) seen.push(ws.url());
    });
    return seen;
}

test.describe('request privacy', () => {
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

        // A hydration barrier, and it is load-bearing. page.goto waits for
        // `load`, while the real <script> element is appended by next/script in
        // an effect AFTER hydration, so a broken gate would append it moments
        // after a count assertion had already passed. This text appears only
        // once RequestShell's own mount effect has run, by which point
        // next/script's effect has had its chance too.
        await expect(page.getByText('SEND FILES THROUGH THIS LINK')).toBeVisible();
        await expect(page.locator('script[src*="cloud.umami.is"]')).toHaveCount(0);
        // The half that needs no hydration at all: in the App Router,
        // next/script emits ReactDOM.preload output into the SERVED HTML for an
        // afterInteractive script, so a /r that rendered the tracker would carry
        // this link tag before a single effect ran.
        await expect(page.locator('link[rel="preload"][href*="cloud.umami.is"]')).toHaveCount(0);
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

    test.describe('leaving /r', () => {
        // page.route cannot see a request a service worker makes, and the
        // collector POST must never slip past it. The worker plays no part in
        // how the footer navigates.
        test.use({ serviceWorkers: 'block' });

        test('E2E-10 the footer leaves /r by a page load, and Back hands Umami nothing', async ({
            page,
        }) => {
            // CP-QA F3-02 and F5-01: with next/link in the /r footer, Privacy
            // was a soft navigation, the tracker loaded by /privacy stayed in
            // the /r document, and Back reported /r/<linkId> as a pageview
            // (then as the referrer of the next page). The same soft hop is
            // what sent Next-Url: /r/<linkId> to the server (F3-01), skipped
            // beforeunload (F5-02) and left / offline (F5-04), so the marker
            // check below covers the root of all five on every build.
            //
            // The Umami half needs a tracker that really runs, which only a
            // build with a website id has (E2E_EXPECT_UMAMI=1, as E2E-10
            // above). Then the tracker script, a public static file, is the
            // one request let through; every other request to an umami.is
            // host is the collector, recorded here and never sent.
            const expectUmami = process.env.E2E_EXPECT_UMAMI === '1';
            // Every collector request, as its URL plus its body.
            const umami: string[] = [];
            // The page path each collected payload reported.
            const reported: string[] = [];
            await page.route(
                (url) => url.hostname === 'umami.is' || url.hostname.endsWith('.umami.is'),
                (route) => {
                    const request = route.request();
                    const url = new URL(request.url());
                    if (
                        expectUmami &&
                        request.method() === 'GET' &&
                        url.hostname === 'cloud.umami.is' &&
                        url.pathname === '/script.js'
                    ) {
                        return route.continue();
                    }
                    const body = request.postData() ?? '';
                    umami.push(`${request.url()} ${body}`);
                    try {
                        reported.push(new URL(JSON.parse(body).payload.url).pathname);
                    } catch {
                        // Not a payload with a page URL; still checked below.
                    }
                    return route.abort();
                }
            );
            const collected = (path: string) => reported.includes(path);

            await page.goto(LINK);
            await expect(page.getByText('SEND FILES THROUGH THIS LINK')).toBeVisible();
            await page.evaluate(() => {
                (window as unknown as Record<string, unknown>).__floeRequestDocument = true;
            });

            await page.getByRole('link', { name: 'Privacy', exact: true }).click();
            await page.waitForURL((url) => url.pathname === '/privacy');
            // A page load: the /r document, and its marker, are gone. A soft
            // navigation keeps both, and that document is the one the tracker
            // would load into.
            expect(
                await page.evaluate(
                    () => (window as unknown as Record<string, unknown>).__floeRequestDocument
                ),
                'Privacy was a soft navigation off /r'
            ).toBeUndefined();
            if (expectUmami) {
                // Non-vacuity: the tracker is live on /privacy, so it would
                // have seen whatever Back did next.
                await expect.poll(() => collected('/privacy')).toBe(true);
            }

            await page.goBack();
            await page.waitForURL((url) => url.pathname === `/r/${LINK_ID}`);
            await expect(page.getByText('SEND FILES THROUGH THIS LINK')).toBeVisible();

            // The next page is where a leaked /r would show as the referrer.
            await page.getByRole('link', { name: 'Terms', exact: true }).click();
            await page.waitForURL((url) => url.pathname === '/terms');
            if (expectUmami) {
                await expect.poll(() => collected('/terms')).toBe(true);
            }

            for (const sent of umami) {
                expect(sent, 'an Umami request carried the request link').not.toContain('/r/');
                expect(sent, 'an Umami request carried the link id').not.toContain(LINK_ID);
                expect(sent, 'an Umami request carried the room id').not.toContain(ROOM_ID);
            }
        });
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
