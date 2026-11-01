/**
 * A connection the signaling server refuses, and the retry it then admits.
 *
 * The per-address connection limiter answers a refused Socket.IO connection
 * with a CONNECT_ERROR packet ("Rate limit exceeded"). socket.io-client treats
 * that as final, so useSignaling retries by hand, and that retry ends in a
 * plain 'connect' rather than the Manager's 'reconnect'.
 *
 * The suite's server runs with the limiter lifted (playwright.config.ts), and a
 * real refusal can take a minute to clear, so the refusal is put on the wire
 * instead: the page is held on HTTP long-polling, and the server's answer to
 * one CONNECT, the packet `40{"sid":...}`, is swapped for the packet the
 * limiter's middleware sends, `44{"message":"Rate limit exceeded"}`. The
 * server itself admitted the connection; the page is told it did not. Engine.io
 * v4 joins the packets of one polling body with U+001E.
 */

import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { createFixture, fixtureDir, removeFixtureDir, browserSenderSetup } from './helpers';

const FIXTURE_DIR = fixtureDir('floe-e2e-refused-connect');
const BANNER = 'Too many refreshes. Reconnecting';
const SEPARATOR = '\x1e';
const REFUSAL = '44{"message":"Rate limit exceeded"}';

test.afterAll(() => {
    removeFixtureDir(FIXTURE_DIR);
});

interface Wire {
    /** Refuse the next CONNECT the server answers, once. */
    refuseNextConnect(): void;
    /** How many CONNECT answers were swapped for a refusal. */
    refused(): number;
    /** Every Socket.IO packet the page has sent since the last refuseNextConnect(). */
    sentSinceArmed(): string[];
    /** Every Socket.IO packet the page has received since then, refusals included. */
    receivedSinceArmed(): string[];
}

/** Hold the page on long-polling and stand between it and the server. Install
 *  before the first navigation. */
async function onTheWire(page: Page): Promise<Wire> {
    let armed = false;
    let refused = 0;
    let sent: string[] = [];
    let received: string[] = [];

    // No upgrade: a CONNECT answered over a WebSocket would pass the swap by.
    await page.routeWebSocket(/socket\.io/, (ws) => {
        void ws.close();
    });
    page.on('request', (r) => {
        if (r.method() === 'POST' && /\/socket\.io\/\?.*transport=polling/.test(r.url())) {
            sent.push(...(r.postData() ?? '').split(SEPARATOR));
        }
    });
    await page.route(/\/socket\.io\/\?.*transport=polling/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        let response;
        let text: string;
        try {
            response = await route.fetch();
            text = await response.text();
        } catch {
            // The page went offline or closed with this poll in flight. Playwright
            // drops a fetched body when the context closes, after the page is gone
            // and every assertion has run, so aborting here adds no reconnect or
            // join-room that a test counts.
            return route.abort().catch(() => {});
        }
        const packets = text.split(SEPARATOR);
        const answer = packets.findIndex((p) => p.startsWith('40'));
        if (armed && answer >= 0) {
            packets[answer] = REFUSAL;
            armed = false;
            refused += 1;
        }
        received.push(...packets);
        await route.fulfill({ response, body: packets.join(SEPARATOR) }).catch(() => {});
    });

    return {
        refuseNextConnect() {
            armed = true;
            sent = [];
            received = [];
        },
        refused: () => refused,
        sentSinceArmed: () => sent,
        receivedSinceArmed: () => received,
    };
}

const eventFrames = (frames: string[], event: string) => frames.filter((f) => f.includes(`["${event}"`));

test('the refusal banner goes away once a retry is admitted', async ({ page }) => {
    const wire = await onTheWire(page);
    wire.refuseNextConnect();
    await page.goto('/');

    await expect(page.getByText(BANNER)).toBeVisible({ timeout: 15_000 });
    expect(wire.refused()).toBe(1);

    // The first retry comes 2 to 10 s after the refusal (lib/reconnectBackoff.ts).
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(BANNER), 'the page is connected and still says it is reconnecting').toHaveCount(0, {
        timeout: 5_000,
    });
});

test('a sender whose reconnect is refused joins its room again exactly once', async ({ browser }) => {
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 64 * 1024);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
        const wire = await onTheWire(page);
        const link = await browserSenderSetup(page, fixturePath);
        const roomId = new URL(link).hash.replace('#room=', '');
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 10_000 });

        // Drop the socket, and refuse the reconnect that follows.
        wire.refuseNextConnect();
        await ctx.setOffline(true);
        await expect(page.getByText('Offline', { exact: true })).toBeVisible({ timeout: 15_000 });
        await ctx.setOffline(false);

        await expect(page.getByText(BANNER)).toBeVisible({ timeout: 30_000 });
        expect(wire.refused()).toBe(1);
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText(BANNER)).toHaveCount(0, { timeout: 5_000 });

        // The reconnect handler's join was buffered while the socket was
        // refused, and the admitted retry carried it: one join for this room,
        // and the server's answer to it. A second join here would move a
        // seated sender out of its seat (lib/rejoinRetry.ts).
        await expect
            .poll(() => eventFrames(wire.receivedSinceArmed(), 'room-joined').length, { timeout: 10_000 })
            .toBeGreaterThanOrEqual(1);
        await page.waitForTimeout(1_500);
        const joins = eventFrames(wire.sentSinceArmed(), 'join-room');
        expect(joins, `join-room frames after the refusal: ${JSON.stringify(joins)}`).toHaveLength(1);
        expect(joins[0]).toContain(roomId);
        expect(eventFrames(wire.receivedSinceArmed(), 'room-joined')).toHaveLength(1);
    } finally {
        await ctx.close();
    }
});

test('an incomplete link keeps its Link Invalid card through a reconnect and a refusal', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const card = page.getByRole('heading', { name: 'Link Invalid' });

    try {
        const wire = await onTheWire(page);
        // The page never joins a room for this link, so nothing is coming to
        // replace the card: it has to survive whatever the socket does.
        await page.goto('/#room=not-a-valid-uuid');
        await expect(card).toBeVisible();
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15_000 });

        // A plain blip. The reconnect handler used to clear the card here.
        await ctx.setOffline(true);
        await expect(page.getByText('Offline', { exact: true })).toBeVisible({ timeout: 15_000 });
        await ctx.setOffline(false);
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(card, 'the card was lost to a reconnect').toBeVisible();
        await expect(page.getByText('Secure room joined')).toHaveCount(0);

        // And a reconnect the server refuses, then admits.
        wire.refuseNextConnect();
        await ctx.setOffline(true);
        await expect(page.getByText('Offline', { exact: true })).toBeVisible({ timeout: 15_000 });
        await ctx.setOffline(false);
        await expect.poll(() => wire.refused(), { timeout: 30_000 }).toBe(1);
        await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(card, 'the card was lost to a refused reconnect').toBeVisible();
        // The banner never took the card's place, and no join went out.
        await expect(page.getByText(BANNER)).toHaveCount(0);
        expect(eventFrames(wire.sentSinceArmed(), 'join-room')).toHaveLength(0);
    } finally {
        await ctx.close();
    }
});

// A page in a browser with no WebRTC says so in the banner, and that sentence
// is its whole account (main-page-no-webrtc.spec.ts). It has to outlast the
// socket as the card above does: a reconnect cleared it, and a refusal wrote
// its own banner over it that the admitted retry then took down, so the page
// ended up saying nothing at all.
const NO_WEBRTC = [
    {
        page: 'receiving',
        path: () => `/#room=${randomUUID()}`,
        sentence:
            'This browser cannot receive files through Floe because WebRTC is missing or turned off. Open the link in a current version of Chrome, Edge, Firefox or Safari.',
    },
    {
        page: 'sending',
        path: () => '/',
        sentence:
            'This browser cannot send files through Floe because WebRTC is missing or turned off. Use a current version of Chrome, Edge, Firefox or Safari.',
    },
];

for (const c of NO_WEBRTC) {
    test(`a ${c.page} page without WebRTC keeps its sentence through a reconnect and a refusal`, async ({ browser }) => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const sentence = page.getByText(c.sentence);

        try {
            await page.addInitScript(() => {
                delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
            });
            const wire = await onTheWire(page);
            await page.goto(c.path());
            await expect(sentence).toBeVisible({ timeout: 15_000 });
            await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15_000 });

            // A plain blip. The reconnect handler used to clear the sentence here.
            await ctx.setOffline(true);
            await expect(page.getByText('Offline', { exact: true })).toBeVisible({ timeout: 15_000 });
            await ctx.setOffline(false);
            await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
            await expect(sentence, 'the sentence was lost to a reconnect').toBeVisible();
            expect(eventFrames(wire.sentSinceArmed(), 'join-room')).toHaveLength(0);

            // And a reconnect the server refuses, then admits.
            wire.refuseNextConnect();
            await ctx.setOffline(true);
            await expect(page.getByText('Offline', { exact: true })).toBeVisible({ timeout: 15_000 });
            await ctx.setOffline(false);
            await expect.poll(() => wire.refused(), { timeout: 30_000 }).toBe(1);
            await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
            await expect(sentence, 'the sentence was lost to a refused reconnect').toBeVisible();
            await expect(page.getByText(BANNER)).toHaveCount(0);
            expect(eventFrames(wire.sentSinceArmed(), 'join-room')).toHaveLength(0);
        } finally {
            await ctx.close();
        }
    });
}
