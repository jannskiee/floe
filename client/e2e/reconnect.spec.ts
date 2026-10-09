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

import { test, expect } from '@playwright/test';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFixture, sha256OfBlobUrl, browserSenderSetup } from './helpers';

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
