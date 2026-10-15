/**
 * Signaling resilience tests.
 *
 * The room registry must survive one peer's socket dropping: the sender's
 * displayed link has to stay valid across a Socket.IO blip (the client
 * re-joins its room on reconnect) and across a receiver closing its tab
 * (the server removes only that peer instead of deleting the room).
 *
 * Offline emulation notes (context.setOffline):
 *   - It reliably fails NEW connections and in-flight HTTP, but does NOT tear
 *     down an already-established WebSocket. The client instead detects the
 *     drop via the window 'offline' event: engine.io-client closes its
 *     transport on that event, but skips registering the listener when the
 *     signaling host is literally "localhost". That is why the e2e
 *     environment points NEXT_PUBLIC_SOCKET_URL at http://127.0.0.1:3001
 *     (see playwright.config.ts), which is also the production code path.
 *   - setOffline is per browser context; receiver contexts stay online.
 */

import { test, expect, type BrowserContext, type WebSocketRoute } from '@playwright/test';
import { rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { io as ioClient, type Socket } from 'socket.io-client';
import { SERVER_URL, createFixture, sha256OfBlobUrl, browserSenderSetup } from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-reconnect');
// Small on purpose: these tests exercise room lifecycle, not throughput.
const FIXTURE_SIZE = 1024 * 1024;

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('sender link survives a signaling blip (client re-joins on reconnect)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);

        // 'Ready'/'Offline' is the ConnectionStatusBadge's socket indicator,
        // and the only place either word appears on the page.
        await expect(senderPage.getByText('Ready', { exact: true })).toBeVisible({ timeout: 10_000 });

        await senderCtx.setOffline(true);
        // The client must OBSERVE the drop before we go back online, otherwise
        // there is no disconnect/reconnect cycle to test (see header note).
        await expect(
            senderPage.getByText('Offline', { exact: true }),
            'sender never noticed the socket drop; is the client running with NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001?',
        ).toBeVisible({ timeout: 15_000 });

        await senderCtx.setOffline(false);
        // Reconnect is attempt-driven (delay 500 ms, capped at 3000 ms), so
        // the badge recovers within a few seconds. The re-join emit is buffered
        // and flushed BEFORE the client's own 'connect' handler runs, so once
        // the badge shows Ready the join-room packet is already on the wire;
        // the short settle only covers the server processing it.
        await expect(senderPage.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15_000 });
        await senderPage.waitForTimeout(500);

        // The ORIGINAL link must still work for a fresh receiver.
        await receiverPage.goto(link);
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        expect(await sha256OfBlobUrl(receiverPage, blobUrl)).toBe(expectedHash);
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('sender link survives a receiver closing its tab before the transfer finishes', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    const senderCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const firstReceiverCtx = await browser.newContext();
    const secondReceiverCtx = await browser.newContext();

    // Socket.IO frames the sender's page receives, so the test can wait for
    // the server's notice itself (see the wait below).
    let senderSockets = 0;
    let peerDisconnectedNotices = 0;
    senderPage.on('websocket', (ws) => {
        // next dev opens its own HMR socket; only the signaling one counts.
        if (!ws.url().includes('/socket.io/')) return;
        senderSockets++;
        ws.on('framereceived', ({ payload }) => {
            if (typeof payload === 'string' && payload.includes('"peer-disconnected"')) {
                peerDisconnectedNotices++;
            }
        });
    });

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);

        // First receiver joins, then leaves before the transfer completes.
        // 'Peer joined' appears on the plain socket join, and the sender only
        // sends the first byte a fixed 2 s AFTER the WebRTC connect (the
        // relay-detection window in handleCreateLink), so closing now is
        // guaranteed to interrupt even with a small fixture.
        const firstReceiverPage = await firstReceiverCtx.newPage();
        await firstReceiverPage.goto(link);
        await expect(senderPage.getByText(/Peer joined/).first()).toBeVisible({ timeout: 30_000 });
        await firstReceiverCtx.close();

        // The context close reaches the server as a clean disconnect and the
        // server tells the sender. Pre-fix, the server also deleted the whole
        // room here, which the second join disproves. The notice is awaited on
        // the wire rather than on screen, so this test checks the room
        // lifecycle and not how the page reacts to the notice, which depends
        // on whether the first receiver's WebRTC connection was already up.
        expect(senderSockets, 'the sender page never opened a signaling WebSocket').toBeGreaterThan(0);
        await expect.poll(() => peerDisconnectedNotices, { timeout: 15_000 }).toBeGreaterThan(0);

        // A second receiver joins the SAME link and completes the transfer.
        const secondReceiverPage = await secondReceiverCtx.newPage();
        await secondReceiverPage.goto(link);
        const downloadLink = secondReceiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        expect(await sha256OfBlobUrl(secondReceiverPage, blobUrl)).toBe(expectedHash);
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });
    } finally {
        await senderCtx.close();
        try { await firstReceiverCtx.close(); } catch { /* already closed mid-test */ }
        await secondReceiverCtx.close();
    }
});

// ---------------------------------------------------------------------------
// Pairing after a drop (WEB-01, WEB-02, WEB-06)
//
// The server seats by join order and tells only the first seat when a second
// peer arrives, and only the sender page reacted to that notice. So a sender
// that came back BEHIND a waiting receiver was never told to offer, and both
// pages waited forever. And a sender whose re-join the room refused, because
// the socket that died still held its seat, kept showing a link into a room it
// was no longer in.
// ---------------------------------------------------------------------------

/** A receiver context with its "Contribute to global stats" toggle stored off. */
async function optedOutContext(ctx: BrowserContext): Promise<BrowserContext> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    return ctx;
}

/** Takes the sender offline and waits until its page has seen the drop. */
async function dropSender(senderCtx: BrowserContext, senderPage: import('@playwright/test').Page): Promise<void> {
    await expect(senderPage.getByText('Ready', { exact: true })).toBeVisible({ timeout: 10_000 });
    await senderCtx.setOffline(true);
    await expect(
        senderPage.getByText('Offline', { exact: true }),
        'sender never noticed the socket drop; is the client running with NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001?',
    ).toBeVisible({ timeout: 15_000 });
}

test('a receiver that joins while the sender is offline gets the files once the sender is back', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);
        await dropSender(senderCtx, senderPage);

        // The sender's socket is gone, so the receiver takes the first seat
        // of an empty room, and says what it knows instead of waiting on a
        // sender that is not there.
        await receiverPage.goto(link);
        await expect(receiverPage.getByText('The sender is not connected')).toBeVisible({ timeout: 15_000 });
        await expect(receiverPage.getByText('Waiting for the sender to start')).toHaveCount(0);

        // Back online, the sender re-joins behind the receiver. The receiver
        // gives the first seat back, the sender is told a peer arrived, and
        // the transfer runs.
        await senderCtx.setOffline(false);
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 45_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        expect(await sha256OfBlobUrl(receiverPage, blobUrl)).toBe(expectedHash);
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

/** A bare Socket.IO peer that takes a seat in a room and does nothing else. */
function seatHolder(roomId: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = ioClient(SERVER_URL, { forceNew: true, reconnection: false });
        const timer = setTimeout(() => {
            socket.disconnect();
            reject(new Error('a seat holder was not seated within 10 s'));
        }, 10_000);
        socket.on('connect', () => socket.emit('join-room', roomId));
        socket.on('room-joined', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.on('room-full', () => {
            clearTimeout(timer);
            socket.disconnect();
            reject(new Error('the room was already full'));
        });
        socket.on('connect_error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function roomOf(link: string): string {
    const room = new URLSearchParams(new URL(link).hash.replace(/^#/, '')).get('room');
    if (!room) throw new Error(`no room in ${link}`);
    return room;
}

test('a sender whose re-join is refused keeps trying, and its link works once the room is free', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();
    const holders: Socket[] = [];

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);
        await dropSender(senderCtx, senderPage);

        // Both seats taken while the sender is away: what the sender finds
        // when its own dead socket and a receiver still hold the room.
        holders.push(await seatHolder(roomOf(link)));
        holders.push(await seatHolder(roomOf(link)));

        await senderCtx.setOffline(false);
        await expect(senderPage.getByText('Reconnecting to your link')).toBeVisible({ timeout: 20_000 });

        // The seats free up, and the next retry takes the room back.
        holders.splice(0).forEach((s) => s.disconnect());
        await expect(senderPage.getByText('Waiting for peer')).toBeVisible({ timeout: 30_000 });

        await receiverPage.goto(link);
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        expect(await sha256OfBlobUrl(receiverPage, blobUrl)).toBe(expectedHash);
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });
    } finally {
        holders.forEach((s) => s.disconnect());
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('a receiver whose re-join is refused after a blip keeps its link until its old seat frees', async ({ browser }) => {
    // The old socket holds its seat until the server's heartbeat gives up on
    // it (about 45 s), so the second half of this test waits that out.
    test.setTimeout(150_000);
    const receiverCtx = await optedOutContext(await browser.newContext());
    const receiverPage = await receiverCtx.newPage();
    const holders: Socket[] = [];

    // A network switch, as the server sees it: the page's WebSocket goes, and
    // the server's end of it stays open and silent until the heartbeat. Only
    // the page side is closed below; with onClose set, Playwright does not
    // pass that close on to the server. setOffline cannot model this: the
    // server hears that close at once.
    //
    // The page's session opens over HTTP polling and then upgrades to this
    // WebSocket: the page sends "2probe", the server answers "3probe", and the
    // page's "5" makes the WebSocket its transport. A close before that "5"
    // only fails the upgrade, and the page carries on over polling, never
    // disconnected, so nothing re-joins and the seat never frees. That was
    // every ubuntu failure of this test (five runs on 2026-10-14 and 15; the
    // trace of main's run 38687849686 forwards "2probe" and "3probe" within
    // 0.46 s of the page opening and never a "5"). So the page's frames are
    // forwarded here, and only a socket that has carried the "5" is closed.
    const pageSides: { ws: WebSocketRoute; upgraded: boolean }[] = [];
    await receiverPage.routeWebSocket(/\/socket\.io\//, (ws) => {
        const side = { ws, upgraded: false };
        const server = ws.connectToServer();
        ws.onMessage((message) => {
            if (message === '5') side.upgraded = true;
            server.send(message);
        });
        ws.onClose(() => {});
        pageSides.push(side);
    });

    try {
        const roomId = randomUUID();
        // The sending seat, held by a socket that never offers, so the page
        // stays connecting: the window in which its reconnect re-joins.
        const sender = await seatHolder(roomId);
        holders.push(sender);
        let arrivals = 0;
        sender.on('user-connected', () => { arrivals += 1; });

        await receiverPage.goto(`/?s=e2e#room=${roomId}`);
        await expect.poll(() => arrivals, { timeout: 15_000 }).toBe(1);
        const transport = () => pageSides.find((side) => side.upgraded);
        await expect.poll(() => transport() !== undefined, { timeout: 15_000 }).toBe(true);

        await transport()!.ws.close();

        // The page reconnects at once under a new socket while its old one
        // still holds the receiving seat, so the re-join is answered
        // room-full. That used to put up the final Link Invalid card at once,
        // over a link that works again within the minute.
        await receiverPage.waitForTimeout(8_000);
        await expect(receiverPage.getByText('Link Invalid')).toHaveCount(0);

        // Once the server gives up on the old socket, a retry takes the seat
        // and the sending side hears of it.
        await expect.poll(() => arrivals, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
        await expect(receiverPage.getByText('Link Invalid')).toHaveCount(0);
    } finally {
        holders.forEach((s) => s.disconnect());
        await receiverCtx.close();
    }
});

test('a sender whose room stays taken is told its link stopped working', async ({ browser }) => {
    // Holds two seats for a minute, so it is opt-in: FLOE_E2E_SLOW=1.
    test.skip(!process.env.FLOE_E2E_SLOW, 'slow: set FLOE_E2E_SLOW=1 to run');
    test.setTimeout(150_000);
    const { path: fixturePath } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    const senderCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const holders: Socket[] = [];

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);
        await dropSender(senderCtx, senderPage);
        holders.push(await seatHolder(roomOf(link)));
        holders.push(await seatHolder(roomOf(link)));
        await senderCtx.setOffline(false);

        await expect(senderPage.getByText('Reconnecting to your link')).toBeVisible({ timeout: 20_000 });
        // Six retries over 59 s, all refused, then the page says so.
        await expect(
            senderPage.getByText('This link stopped working. Reload the page, add the files again, and share the new link.'),
        ).toBeVisible({ timeout: 90_000 });
        await expect(senderPage.getByText('Link stopped working', { exact: true })).toBeVisible();
    } finally {
        holders.forEach((s) => s.disconnect());
        await senderCtx.close();
    }
});

test('a finished send still looks finished once its status changes', async ({ browser }) => {
    const { path: fixturePath } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);
        await receiverPage.goto(link);
        await expect(receiverPage.locator('a[download]').first()).toBeVisible({ timeout: 30_000 });
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });

        const row = senderPage.locator('div.flex.items-center.gap-3').filter({ hasText: basename(fixturePath) });
        await expect(senderPage.getByText('Sent 1 file', { exact: true })).toBeVisible();
        await expect(row.locator('svg.text-green-500')).toHaveCount(1);

        // This page's own socket dropping is one of three events that rewrite
        // the status after a finished send (the peer leaving and the peer
        // erroring are the others). Whichever sentence it lands on, the file
        // left this browser: the row keeps its check and the progress row its
        // count. Both used to follow the status sentence, so the last file
        // went back to a spinner under "Transfer complete".
        await senderCtx.setOffline(true);
        await expect(senderPage.getByText('All Files Sent!')).toHaveCount(0, { timeout: 15_000 });
        await expect(senderPage.getByText(/^(Transfer complete|Connection interrupted)$/)).toBeVisible();

        await expect(senderPage.getByText('Sent 1 file', { exact: true })).toBeVisible();
        await expect(senderPage.getByText(/Sending file [0-9]+ of [0-9]+/)).toHaveCount(0);
        await expect(row.locator('svg.text-green-500')).toHaveCount(1);
        await expect(row.locator('svg.animate-spin')).toHaveCount(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
