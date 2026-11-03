import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { REQUEST_REPORT_ADDRESS } from '../lib/request/report';
import { refusalCopy, visitorCopy } from '../lib/request/visitorCopy';
import { ENFORCE_LINK_KEYS, KEY_CHECK_WAIT_MS } from '../lib/transfer/protocol';
import { UMAMI_INTEGRITY, UMAMI_SRC } from '../lib/umamiPin';
import { E2E_REPORT_EMAIL } from './report-email';
import { startScriptedHost } from './request-scripted-host';
import {
    channelSent,
    channelText,
    countStatsAttempts,
    partsOfRequestLink,
    requestLink,
    startRequestHost,
    storedByPage,
    stunOnlyIce,
    underTheWorker,
    waitForHostEvent,
    watchChannel,
    watchTraffic,
} from './request-helpers';

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
const KEY = 'AbCdEfGhIjKlMnOpQrStUg';
const KEYED_LINK = `/r/${LINK_ID}#${ROOM_ID}.${KEY}`;

// The tracker is a pinned copy on this origin (lib/umamiPin.ts), so what it
// looks like on a page is one script and the link next/script preloads it with.
// A test that counts zero of these says something about the tracker only while
// the same two selectors find it where it does load: the E2E_EXPECT_UMAMI arm
// below holds that.
const UMAMI_SCRIPT = 'script[src^="/vendor/umami-"]';
const UMAMI_PRELOAD = 'link[rel="preload"][href^="/vendor/umami-"]';

/** Every Umami host. The tracker's own file is on this origin, so anything here
 *  is its collector, and no test may reach that. */
const isUmamiHost = (url: URL) => url.hostname === 'umami.is' || url.hostname.endsWith('.umami.is');

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
    // On a build with a website id (E2E_EXPECT_UMAMI=1) the real tracker runs on
    // every page but /r. A page view from a test is not a visit, so nothing here
    // reaches the collector, whatever the test is about. A test that reads what
    // was sent adds its own route on top; the newest route answers first.
    test.beforeEach(async ({ page }) => {
        await page.route(isUmamiHost, (route) => route.abort());
    });

    test('E2E-09 no /r entry in Cache Storage, opened from a page the worker controls', async ({ page }) => {
        // This test needs the service worker, and page.route is not promised to
        // see past one, so Umami's own switch keeps the tracker quiet as well.
        await page.addInitScript(() => {
            localStorage.setItem('umami.disabled', '1');
        });

        // components/ServiceWorkerRegistration.tsx gates registration on
        // NODE_ENV === 'production', so under `next dev` there is no worker and
        // no Cache Storage at all. The assertions below are still true there,
        // just not informative. With CI set this is a production build, and a
        // worker that never took control fails here rather than passing on an
        // empty store. Under a page it controls, every navigation below meets the
        // worker's fetch handler, which a link opened in a fresh context never does.
        const controlled = await underTheWorker(page);

        // Every shape of a request link. Twice each: the first navigation is the
        // one a worker could cache, the second is the one it could serve from
        // cache and re-store. The one with no fragment has only the /r guard
        // between it and the store, so that guard's going shows here. The others
        // have the fragment or the query guard behind it, and show when both go.
        for (const link of [KEYED_LINK, LINK, `/r/${LINK_ID}`, `/r/${LINK_ID}?k=${KEY}`]) {
            await page.goto(link);
            await page.goto(link);
            if (controlled) {
                // The worker was in the way of this navigation.
                expect(await page.evaluate(() => !!navigator.serviceWorker.controller), link).toBe(true);
            }
        }

        const { urls, hits } = await storedByPage(page, KEY);
        expect(hits, 'the link key in browser storage').toEqual([]);

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

    // The request-link key on a real drop, on a real page. What cannot be seen from a
    // running page lives in lib/request/visitorBoundaries.test.ts. The Sentry report has no
    // DSN in an ordinary build: lib/keyCheckReport.test.ts and the same boundary test hold
    // it, and the opt-in cell below reads it where it leaves the page.
    test.describe('the link key', () => {
        const FILE_NAME = 'a-very-particular-name.bin';
        const FILE_SIZE = 123_457;

        /** A file to pick, and an empty folder for what the host saves. */
        const scratch = (dir: string) => {
            const file = `${dir}/${FILE_NAME}`;
            const out = `${dir}/out`;
            mkdirSync(out, { recursive: true });
            writeFileSync(file, randomBytes(FILE_SIZE));
            return { file, out };
        };

        test('is in no request, no socket frame, nothing stored and nothing drawn', async ({ page, context }, testInfo) => {
            await stunOnlyIce(context);
            const stats = await countStatsAttempts(context);
            const traffic = watchTraffic(context);
            traffic.watchSockets(page);
            const { file, out } = scratch(testInfo.outputDir);
            const h = startRequestHost({ outDir: out, decide: 'accept', key: true });
            try {
                const link = await requestLink(h);
                const { linkId, room, key } = partsOfRequestLink(link);
                if (!key) throw new Error('the harness made no key');
                const controlled = await underTheWorker(page);
                await page.goto(link);
                await expect(page.getByText(visitorCopy.readyIntro, { exact: true })).toBeVisible();
                // The home page above reads the public counter, and this page must not.
                const statsBefore = await stats();
                // The key is in this page's address, so what follows checks something.
                expect(await page.evaluate(() => location.hash)).toContain(key);

                // The one link on the page built from the address.
                const report = await page.getByRole('link', { name: visitorCopy.reportLink }).getAttribute('href');
                expect(report).toContain(linkId);
                expect(report).not.toContain(key);
                expect(report).not.toContain(room);

                await page.locator('input[type=file]:not([webkitdirectory])').first().setInputFiles(file);
                await page.getByRole('button', { name: /^Send \d+ files?$/ }).click();
                await expect(page.getByRole('heading', { name: /^(ALL \d+ FILES|1 FILE) ARRIVED$/ })).toBeVisible({ timeout: 60_000 });
                await waitForHostEvent(h, 'done', 30_000);

                // Not vacuous: the watchers hear the room, which does go to the signaling
                // server, and a socket did open.
                const heard = await traffic.everything();
                expect(heard).toContain(room);
                expect(traffic.sockets()).toBeGreaterThan(0);
                expect(heard, 'this page told a server the key').not.toContain(key);

                expect(await page.content(), 'the key is drawn or in the markup').not.toContain(key);
                expect(await page.title()).not.toContain(key);

                // A production build has a worker and a store, filled once it has
                // installed; next dev has neither, and this reads web storage alone.
                const stored = await storedByPage(page, key);
                expect(stored.hits, 'the key in browser storage').toEqual([]);
                if (controlled) expect(stored.entries).toBeGreaterThan(0);
                test.info().annotations.push({ type: 'cache-storage', description: `${stored.entries} stored responses read` });
                expect(await stats()).toBe(statsBefore);
            } finally {
                h.stop();
                await h.exited;
            }
        });

        for (const kc of ['bad', 'none'] as const) {
            test(`a host ${kc === 'bad' ? 'under another key' : 'with no proof'}: no file name or size left the page, and the view is V6f`, async ({ page, context }, testInfo) => {
                test.skip(!ENFORCE_LINK_KEYS, 'ENFORCE_LINK_KEYS is off, and nothing stops');
                test.setTimeout(KEY_CHECK_WAIT_MS + 60_000);
                await stunOnlyIce(context);
                const stats = await countStatsAttempts(context);
                await watchChannel(context);
                const traffic = watchTraffic(context);
                traffic.watchSockets(page);
                const { file, out } = scratch(testInfo.outputDir);
                const h = startRequestHost({ outDir: out, decide: 'accept', key: true, kc });
                try {
                    const link = await requestLink(h);
                    const { key } = partsOfRequestLink(link);
                    if (!key) throw new Error('the harness made no key');
                    await page.goto(link);
                    await page.locator('input[type=file]:not([webkitdirectory])').first().setInputFiles(file);
                    // The page does hold the two values this test looks for.
                    await expect(page.getByText(FILE_NAME)).toBeVisible();
                    await page.getByRole('button', { name: /^Send \d+ files?$/ }).click();

                    await expect(page.getByRole('heading', { name: visitorCopy.keyFailedTitle })).toBeVisible({
                        timeout: KEY_CHECK_WAIT_MS + 30_000,
                    });
                    await expect(page.getByText(visitorCopy.keyFailedBody, { exact: true })).toBeVisible();
                    expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });

                    // Its proof and its stop, and not one frame more.
                    await expect.poll(() => channelSent(page)).toEqual(['kc', 'incompatible']);
                    const words = (await channelText(page)).join('\n');
                    const heard = await traffic.everything();
                    for (const what of [FILE_NAME, String(FILE_SIZE)]) {
                        expect(words, `${what} went down the channel`).not.toContain(what);
                        expect(heard, `${what} went to a server`).not.toContain(what);
                    }
                    expect(words).not.toContain('metadata');
                    expect(words, 'the key went down the channel').not.toContain(key);
                    expect(heard, 'this page told a server the key').not.toContain(key);

                    // The host decided nothing and kept nothing.
                    const names = h.events.map((e) => e.event);
                    expect(names).not.toContain('deciding');
                    expect(readdirSync(out)).toEqual([]);
                    expect(await stats()).toBe(0);
                } finally {
                    h.stop();
                    await h.exited;
                }
            });
        }
    });

    // O7 on /r (decision W2): this page is where the soak most needs a signal. Opt-in, as
    // E2E_EXPECT_UMAMI is, because it needs a page with a DSN, which no CI leg has. next dev
    // takes it from the environment (a production build, at build time):
    //   E2E_EXPECT_SENTRY=1 NEXT_PUBLIC_SENTRY_DSN=http://floe@127.0.0.1:9/1 pnpm test:e2e request-privacy.spec.ts
    // Nothing leaves the machine: the route answers every envelope here.
    test.describe('what Sentry hears on /r', () => {
        // As above: page.route has to see the envelope, so no worker.
        test.use({ serviceWorkers: 'block' });

        const FILE_NAME = 'a-very-particular-name.bin';

        /** Every envelope the page sends, as text, answered here. */
        const envelopes = async (page: Page) => {
            const seen: string[] = [];
            await page.route(/\/api\/\d+\/envelope\//, (route) => {
                seen.push(route.request().postData() ?? '');
                return route.fulfill({ status: 200, json: {}, headers: { 'access-control-allow-origin': '*' } });
            });
            return seen;
        };

        /** The one event an envelope holding this message carries. */
        const warningIn = (seen: string[]) => {
            const lines = seen.filter((text) => text.includes('Link key check failed')).flatMap((text) => text.split('\n'));
            const events = lines.filter((line) => line.includes('Link key check failed')).map((line) => JSON.parse(line));
            return events as Array<{
                level: string;
                message: string;
                tags: Record<string, string>;
                fingerprint: string[];
                request?: { url?: string };
                extra?: unknown;
                user?: unknown;
            }>;
        };

        const pickAndSend = async (page: Page, file: string) => {
            await page.locator('input[type=file]:not([webkitdirectory])').first().setInputFiles(file);
            await page.getByRole('button', { name: /^Send \d+ files?$/ }).click();
        };

        const expectOneWarning = async (seen: string[], outcome: string, secrets: string[], path = 'der') => {
            await expect.poll(() => warningIn(seen).length, { timeout: 20_000 }).toBeGreaterThan(0);
            // Long enough for a second one to have gone, if a second one were going.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            const events = warningIn(seen);
            expect(events).toHaveLength(1);
            const [event] = events;
            expect(event.level).toBe('warning');
            expect(event.message).toBe('Link key check failed');
            expect(event.tags).toMatchObject({
                'linkkey.role': 'visitor',
                'linkkey.path': path,
                'linkkey.outcome': outcome,
                'linkkey.mode': 'enforce',
            });
            expect(event.fingerprint).toEqual(['link-key', 'visitor', outcome, path]);
            expect(event.request?.url ?? '').toMatch(/\/r\/redacted$/);
            expect(event.extra ?? {}).toEqual({});
            // An empty geo is lib/noLocation.ts asking Sentry to work out no location.
            expect(event.user ?? {}).toEqual({ geo: {} });
            // And in nothing this page sent Sentry, any event, breadcrumb or span.
            const everything = seen.join('\n');
            for (const secret of [...secrets, FILE_NAME]) {
                expect(everything, 'a report holds what it must not').not.toContain(secret);
            }
        };

        for (const [kc, outcome] of [['bad', 'bad-tag'], ['none', 'silent']] as const) {
            test(`a failed check (${outcome}) sends one warning of four enums, and no link, key or name`, async ({ page, context }, testInfo) => {
                test.skip(process.env.E2E_EXPECT_SENTRY !== '1', 'needs a build with a Sentry DSN');
                test.setTimeout(KEY_CHECK_WAIT_MS + 60_000);
                await stunOnlyIce(context);
                const seen = await envelopes(page);
                const file = testInfo.outputPath(FILE_NAME);
                const out = testInfo.outputPath('out');
                mkdirSync(out, { recursive: true });
                writeFileSync(file, randomBytes(4096));
                const h = startRequestHost({ outDir: out, decide: 'accept', key: true, kc });
                try {
                    const link = await requestLink(h);
                    const { key, room, linkId } = partsOfRequestLink(link);
                    await page.goto(link);
                    await pickAndSend(page, file);
                    await expect(page.getByRole('heading', { name: visitorCopy.keyFailedTitle })).toBeVisible({
                        timeout: KEY_CHECK_WAIT_MS + 30_000,
                    });
                    await expectOneWarning(seen, outcome, [key as string, room, linkId]);
                } finally {
                    h.stop();
                    await h.exited;
                }
            });
        }

        test('a host that refuses this page sends the one warning too, and none of its words', async ({ browser, page, context }, testInfo) => {
            test.skip(process.env.E2E_EXPECT_SENTRY !== '1', 'needs a build with a Sentry DSN');
            await stunOnlyIce(context);
            const seen = await envelopes(page);
            const file = testInfo.outputPath(FILE_NAME);
            writeFileSync(file, randomBytes(4096));
            const h = await startScriptedHost(browser, { proof: 'good', then: 'refuse-close' });
            try {
                await page.goto(h.link);
                await pickAndSend(page, file);
                await expect(page.getByRole('heading', { name: refusalCopy('unverified', 0, 1).title })).toBeVisible({ timeout: 30_000 });
                await expectOneWarning(seen, 'peer-refused', [h.key, h.room, 'FLOEPEERTEXT']);
            } finally {
                await h.close();
            }
        });

        // V6g, for the soak: a browser that cannot read the certificates is told apart from
        // a host that failed, in the report as on the card. The API is gone and the
        // description fails the fallback's strict shape, so there was nothing to hash.
        test('a browser that cannot check sends the one warning, path none', async ({ page, context }, testInfo) => {
            test.skip(process.env.E2E_EXPECT_SENTRY !== '1', 'needs a build with a Sentry DSN');
            await stunOnlyIce(context);
            await context.addInitScript(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (RTCDtlsTransport.prototype as any).getRemoteCertificates;
                const real = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'remoteDescription')?.get;
                Object.defineProperty(RTCPeerConnection.prototype, 'remoteDescription', {
                    configurable: true,
                    get(this: RTCPeerConnection) {
                        const held = real?.call(this);
                        return held ? { type: held.type, sdp: `${held.sdp}m=text 9 UDP/TLS 0\r\n` } : held;
                    },
                });
            });
            const seen = await envelopes(page);
            const file = testInfo.outputPath(FILE_NAME);
            const out = testInfo.outputPath('out');
            mkdirSync(out, { recursive: true });
            writeFileSync(file, randomBytes(4096));
            const h = startRequestHost({ outDir: out, decide: 'accept', key: true });
            try {
                const link = await requestLink(h);
                const { key, room, linkId } = partsOfRequestLink(link);
                await page.goto(link);
                await pickAndSend(page, file);
                await expect(page.getByRole('heading', { name: visitorCopy.cantCheckTitle })).toBeVisible({ timeout: 30_000 });
                await expectOneWarning(seen, 'unavailable', [key as string, room, linkId], 'none');
            } finally {
                h.stop();
                await h.exited;
            }
        });

        test('a keyed drop that passes sends no warning at all', async ({ page, context }, testInfo) => {
            test.skip(process.env.E2E_EXPECT_SENTRY !== '1', 'needs a build with a Sentry DSN');
            await stunOnlyIce(context);
            const seen = await envelopes(page);
            const file = testInfo.outputPath(FILE_NAME);
            const out = testInfo.outputPath('out');
            mkdirSync(out, { recursive: true });
            writeFileSync(file, randomBytes(4096));
            const h = startRequestHost({ outDir: out, decide: 'accept', key: true });
            try {
                const { key } = partsOfRequestLink(await requestLink(h));
                await page.goto(await requestLink(h));
                await pickAndSend(page, file);
                await expect(page.getByRole('heading', { name: /^(ALL \d+ FILES|1 FILE) ARRIVED$/ })).toBeVisible({ timeout: 60_000 });
                await new Promise((resolve) => setTimeout(resolve, 1_500));
                expect(warningIn(seen)).toEqual([]);
                expect(seen.join('\n')).not.toContain(key as string);
            } finally {
                h.stop();
                await h.exited;
            }
        });
    });

    test('E2E-10 no-referrer header and no Umami on /r', async ({ page }) => {
        const umami: string[] = [];
        page.on('request', (req) => {
            const url = new URL(req.url());
            if (isUmamiHost(url) || url.pathname.startsWith('/vendor/umami-')) umami.push(req.url());
        });
        // As in E2E-09: the arm below loads / in a browser where /r may have
        // registered the worker, and nothing leaves this machine either way.
        await page.addInitScript(() => {
            localStorage.setItem('umami.disabled', '1');
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
        await expect(page.locator(UMAMI_SCRIPT)).toHaveCount(0);
        // The half that needs no hydration at all: in the App Router,
        // next/script emits ReactDOM.preload output into the SERVED HTML for an
        // afterInteractive script, so a /r that rendered the tracker would carry
        // this link tag before a single effect ran.
        await expect(page.locator(UMAMI_PRELOAD)).toHaveCount(0);
        expect(umami).toEqual([]);

        if (process.env.E2E_EXPECT_UMAMI === '1') {
            // A failed integrity check is silent to the page: the script just
            // never runs, and the only word of it is in this console.
            const refused: string[] = [];
            page.on('console', (message) => {
                if (/integrity/i.test(message.text())) refused.push(message.text());
            });

            // The build under test has a website id, so "no script on /r" means
            // the path gate, not an absent id. Without this arm the assertion
            // above passes on every build that simply has analytics turned off.
            const home = await page.goto('/');
            expect(home?.headers()['referrer-policy']).toBe(
                'strict-origin-when-cross-origin'
            );
            const script = page.locator(UMAMI_SCRIPT);
            await expect(script).toHaveCount(1);
            // The pinned copy, from this origin, checked by the browser, and
            // naming the collector it reports to.
            await expect(script).toHaveAttribute('src', UMAMI_SRC);
            await expect(script).toHaveAttribute('integrity', UMAMI_INTEGRITY);
            await expect(script).toHaveAttribute('data-host-url', 'https://gateway.umami.is');
            await expect(page.locator(UMAMI_PRELOAD)).toHaveAttribute('integrity', UMAMI_INTEGRITY);
            await expect(script).toHaveAttribute('data-exclude-hash', 'true');
            await expect(script).toHaveAttribute('data-exclude-search', 'true');
            await expect(script).toHaveAttribute('data-do-not-track', 'true');
            // The send filter (lib/analyticsPath.ts umamiBeforeSend): the
            // tracker finds it by this name on window, and sends everything
            // unfiltered when nothing is there.
            await expect(script).toHaveAttribute('data-before-send', 'floeUmamiBeforeSend');
            expect(
                await page.evaluate(
                    () => typeof (window as unknown as Record<string, unknown>).floeUmamiBeforeSend
                )
            ).toBe('function');
            // The browser ran it, so its bytes matched.
            await page.waitForFunction(() => 'umami' in window);
            expect(refused).toEqual([]);
            // Served as a script, or nosniff would have refused it.
            const served = await page.request.get(UMAMI_SRC);
            expect(served.status()).toBe(200);
            expect(served.headers()['content-type']).toMatch(/javascript/);
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
            // above). Its file is on this origin; every request to an umami.is
            // host is the collector, recorded here and never sent.
            const expectUmami = process.env.E2E_EXPECT_UMAMI === '1';
            // Every collector request, as its URL plus its body.
            const umami: string[] = [];
            // The page path each collected payload reported.
            const reported: string[] = [];
            await page.route(isUmamiHost, (route) => {
                const request = route.request();
                const body = request.postData() ?? '';
                umami.push(`${request.url()} ${body}`);
                try {
                    reported.push(new URL(JSON.parse(body).payload.url).pathname);
                } catch {
                    // Not a payload with a page URL; still checked below.
                }
                return route.abort();
            });
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

    test.describe('what the tracker reports', () => {
        // As above: page.route has to see the collector POST, so no worker.
        test.use({ serviceWorkers: 'block' });

        test('a page holding a keyed fragment reports no key, room id, query or title', async ({ page }) => {
            test.skip(process.env.E2E_EXPECT_UMAMI !== '1', 'needs a build with a website id');
            const KEY = 'AbCdEfGhIjKlMnOpQrStUg';
            const sent: { url: string; body: string }[] = [];
            await page.route(isUmamiHost, (route) => {
                const request = route.request();
                sent.push({ url: request.url(), body: request.postData() ?? '' });
                return route.abort();
            });

            // A page with no transfer on it: the question is what the tracker
            // does with the address, not what the page does with the link.
            await page.goto(`/privacy?s=n0nce#k=${KEY}&room=${ROOM_ID}`);
            await expect.poll(() => sent.length).toBeGreaterThan(0);

            // The key is still in the page, so this checks something.
            expect(await page.evaluate(() => location.hash)).toContain(KEY);
            for (const { url, body } of sent) {
                expect(url).toBe('https://gateway.umami.is/api/send');
                const { payload } = JSON.parse(body) as { payload: Record<string, unknown> };
                expect(new URL(payload.url as string).pathname).toBe('/privacy');
                expect(payload.url).not.toContain('#');
                expect(payload.url).not.toContain('?');
                expect(payload).not.toHaveProperty('title');
                for (const secret of [KEY, ROOM_ID, 'n0nce']) {
                    expect(`${url} ${body}`, secret).not.toContain(secret);
                }
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

    test('E2E-12b an in-app browser is told what this page works in, and opens no socket', async ({ browser }) => {
        // Facebook's browser on an iPhone, the shape lib/inAppBrowser.test.ts
        // uses. A request link is something sent to another person, often in a
        // chat app, so this is a likely first screen.
        const ctx = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.35.108;FBBV/542017005;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/17.1;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
            viewport: { width: 390, height: 844 },
        });
        const page = await ctx.newPage();
        const signaling = watchSignaling(page);
        try {
            await page.goto(LINK);

            await expect(page.getByRole('heading', { name: 'Open in your browser' })).toBeVisible();
            await expect(page.getByText(visitorCopy.inAppAdvice)).toBeVisible();
            // The home page's advice sentence names Safari; this page's does
            // not. The steps under it still do ("Open in Safari" on an
            // iPhone): leaving the app's browser is the first move either way.
            await expect(page.getByText(/Chrome or Safari/)).toHaveCount(0);
            // So the box of steps says what it is here: the other choice, not
            // the way to do what the sentence above it asked.
            await expect(page.getByText(visitorCopy.inAppStepsTitle, { exact: true })).toBeVisible();
            await expect(page.getByText('How to open in your browser')).toHaveCount(0);
            // The longer sentence still fits a phone: no sideways scroll.
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
            // Withheld, not covered: nothing of the page behind is rendered.
            await expect(page.getByText(visitorCopy.readyEyebrow)).toHaveCount(0);
            await page.waitForTimeout(1_000);
            expect(signaling).toEqual([]);

            await page.getByRole('button', { name: /Continue anyway/ }).click();
            await expect(page.getByText(visitorCopy.readyEyebrow)).toBeVisible();
            await expect(page.getByText(visitorCopy.betaSupport)).toBeVisible();
        } finally {
            await ctx.close();
        }
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

    // A link with a key that cannot be read is no bare link into the same room. Twin of the
    // row in cli/engine/code/testdata/link-shapes.json, on the page itself.
    for (const [name, link] of [
        ['a key cut short', `/r/${LINK_ID}#${ROOM_ID}.${KEY.slice(0, 10)}`],
        ['a k in the query', `/r/${LINK_ID}?k=${KEY}#${ROOM_ID}`],
        ['a k in the query beside a whole key', `/r/${LINK_ID}?k=${KEY}#${KEYED_LINK.split('#')[1]}`],
        ['an escape in a keyed fragment', `/r/${LINK_ID}#${ROOM_ID}%2E${KEY}`],
    ] as const) {
        test(`E2E-13 ${name} opens no socket, and reads as incomplete`, async ({ page }) => {
            const signaling = watchSignaling(page);
            await page.goto(link);
            await expect(page.getByText(visitorCopy.incompleteTitle)).toBeVisible();
            await page.waitForTimeout(1_000);
            expect(signaling).toEqual([]);
        });
    }

    test('a whole keyed link opens on Ready, and reaches for nothing until Send', async ({ page }) => {
        const signaling = watchSignaling(page);
        await page.goto(KEYED_LINK);
        await expect(page.getByText(visitorCopy.readyIntro, { exact: true })).toBeVisible();
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
        await expect(page.getByText(visitorCopy.readyIntro, { exact: true })).toBeVisible();
        await page.waitForTimeout(1_000);
        expect(signaling).toEqual([]);
    });

    test('Report this link writes to the address this server was given, with the link id and no fragment', async ({
        page,
    }) => {
        // This page is on localhost, which is not floe.one, so the link is
        // drawn only because playwright.config.ts gave the client an address
        // (REQUEST_REPORT_EMAIL), and that address is the whole recipient. A
        // server whose operator set none draws no link; that half is
        // lib/request/report.test.ts, since one run has one client.
        const signaling = watchSignaling(page);

        await page.goto(LINK);

        const report = page.getByRole('link', { name: visitorCopy.reportLink });
        await expect(report).toBeVisible();
        const href = (await report.getAttribute('href')) ?? '';
        expect(href.startsWith('mailto:')).toBe(true);
        const [to, query, ...more] = href.slice('mailto:'.length).split('?');
        expect(more).toEqual([]);
        expect(to).toBe(E2E_REPORT_EMAIL);
        // floe.one's own address is for floe.one's links.
        expect(href).not.toContain(REQUEST_REPORT_ADDRESS);

        // The link id and this page's origin, and nothing else riding along.
        const params = new URLSearchParams(query);
        expect([...params.keys()]).toEqual(['subject', 'body']);
        expect(params.get('subject')).toBe(`Report Floe request link ${LINK_ID}`);
        expect(params.get('body')).toBe(`Link: ${new URL(page.url()).origin}/r/${LINK_ID}`);

        // Never the room: the part after the # is the seat, and a report that
        // carried it would hand the seat to whoever reads the mailbox.
        expect(page.url()).toContain(`#${ROOM_ID}`);
        expect(href).not.toContain(ROOM_ID);
        expect(href).not.toContain('#');
        expect(href.toLowerCase()).not.toContain('%23');

        // The address came down with the page: it cost no request.
        await page.waitForTimeout(1_000);
        expect(signaling).toEqual([]);
    });
});
