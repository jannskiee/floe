/**
 * The browser sender's own stops, seen from the other side, and its relay
 * list when the first read of it failed.
 *
 * A file the sender can no longer read is the realistic case of a send that
 * stops on the sending side: picked, then moved or deleted before its turn.
 * Chromium keeps the picked File and fails its read once the file is gone from
 * disk, which is exactly what removing the fixture after Create does.
 *
 * Receivers stay out of the stats counter: the browser with its "Contribute to
 * global stats" toggle stored off.
 */

import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { rmSync } from 'fs';
import { join } from 'path';
import { SHARE_LINK_TEXT, browserSenderSetup, createFixture, fixtureDir, removeFixtureDir, sha256OfBlobUrl, writeRandomFile } from './helpers';

const FIXTURE_DIR = fixtureDir('floe-e2e-sender-stops');

test.afterAll(() => {
    removeFixtureDir(FIXTURE_DIR);
});

async function optedOutContext(ctx: BrowserContext): Promise<BrowserContext> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    return ctx;
}

test('a sender that cannot read a file tells the receiver why and closes', async ({ browser }) => {
    const first = { path: join(FIXTURE_DIR, 'kept.bin'), sha256: '' };
    first.sha256 = writeRandomFile(first.path, 256 * 1024);
    const second = { path: join(FIXTURE_DIR, 'gone.bin') };
    writeRandomFile(second.path, 256 * 1024);

    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        await senderPage.goto('/');
        await senderPage.locator('input[type="file"]').first().setInputFiles([first.path, second.path]);
        await senderPage.locator('button', { hasText: /create secure link/i }).click();
        const linkEl = senderPage.locator('code').filter({ hasText: SHARE_LINK_TEXT });
        await expect(linkEl).toBeVisible({ timeout: 10_000 });
        const link = (await linkEl.textContent())!.trim();

        // Gone from disk before its turn: the read fails mid-batch.
        rmSync(second.path);

        await receiverPage.goto(link);
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });
        expect(await sha256OfBlobUrl(receiverPage, (await downloadLink.getAttribute('href'))!)).toBe(first.sha256);

        await expect(senderPage.getByText(/Could not read ".*"/)).toBeVisible({ timeout: 15_000 });
        // The receiver is told, in the sender's fixed words, instead of
        // waiting for the rest for as long as the sending tab stays open.
        await expect(
            receiverPage.getByText('The sender stopped: a file could not be read on their device. Ask them to check it and send again.'),
        ).toBeVisible({ timeout: 15_000 });
        await expect(receiverPage.getByText(/Waiting for the rest/)).toHaveCount(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('a sender whose first read of the relay list failed reads it again before it connects', async ({ browser }) => {
    const file = createFixture(join(FIXTURE_DIR, 'relay-list'), 64 * 1024);

    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    let reads = 0;
    await senderCtx.route('**/api/turn-credentials', async (route) => {
        reads += 1;
        // The read at page load fails, as it does while the server is down.
        if (reads === 1) return route.fulfill({ status: 503, body: 'down' });
        return route.continue();
    });
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        await senderPage.goto('/');
        await expect.poll(() => reads, { timeout: 15_000 }).toBe(1);
        await senderPage.locator('input[type="file"]').first().setInputFiles(file.path);
        await senderPage.locator('button', { hasText: /create secure link/i }).click();
        const linkEl = senderPage.locator('code').filter({ hasText: SHARE_LINK_TEXT });
        await expect(linkEl).toBeVisible({ timeout: 10_000 });

        await receiverPage.goto((await linkEl.textContent())!.trim());
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });
        expect(await sha256OfBlobUrl(receiverPage, (await downloadLink.getAttribute('href'))!)).toBe(file.sha256);

        // The page asked again before it built the connection for this
        // receiver, instead of going on with the STUN-only defaults.
        expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

interface ClosesEarly {
    floeFrames: string[];
    floeClosed: boolean;
}

/** A receiving context whose page closes its data channel half a second after
 *  it opens, inside the 2 s the sender waits before its first frame. The
 *  channel and not the whole peer connection: closing the connection reaches a
 *  Chromium sender as a "User-Initiated Abort" error, which the error handler
 *  already answers, while a channel that closes reaches it as a close and
 *  nothing else. Its signaling socket keeps the seat, so the server never
 *  tells the sender that it left. The frames that reached it first are kept,
 *  so the test can see the close came before the send. */
async function closesBeforeTheFirstFile(browser: Browser): Promise<BrowserContext> {
    const ctx = await optedOutContext(await browser.newContext());
    await ctx.addInitScript(() => {
        const held = window as unknown as ClosesEarly;
        held.floeFrames = [];
        held.floeClosed = false;
        const Native = window.RTCPeerConnection;
        class Watched extends Native {
            constructor(config?: RTCConfiguration) {
                super(config);
                this.addEventListener('datachannel', ({ channel }) => {
                    channel.addEventListener('message', ({ data }) => {
                        held.floeFrames.push(typeof data === 'string' ? data.slice(0, 20) : 'binary');
                    });
                    let armed = false;
                    const arm = () => {
                        if (armed) return;
                        armed = true;
                        setTimeout(() => {
                            channel.close();
                            held.floeClosed = true;
                        }, 500);
                    };
                    if (channel.readyState === 'open') arm();
                    else channel.addEventListener('open', arm);
                });
            }
        }
        window.RTCPeerConnection = Watched;
    });
    return ctx;
}

test('a receiver whose channel closes before the first file leaves the sender waiting for the next one', async ({ browser }) => {
    const file = createFixture(join(FIXTURE_DIR, 'closed-before-send'), 64 * 1024);

    const senderCtx = await browser.newContext();
    const firstCtx = await closesBeforeTheFirstFile(browser);
    const senderPage = await senderCtx.newPage();
    const firstPage = await firstCtx.newPage();

    try {
        // Relay fallback off keeps the 2 s between the connection and the first
        // frame (lib/relay.ts relayProbeDelayMs), which the close lands inside.
        const link = await browserSenderSetup(senderPage, file.path, { relayFallback: false });
        await firstPage.goto(link);
        await expect
            .poll(() => firstPage.evaluate(() => (window as unknown as ClosesEarly).floeClosed), { timeout: 30_000 })
            .toBe(true);
        // Nothing but the sender's link-key proof reached it: the send had not begun.
        expect(
            await firstPage.evaluate(() => (window as unknown as ClosesEarly).floeFrames.filter((f) => !f.startsWith('{"type":"kc"'))),
        ).toEqual([]);

        // The page goes back to waiting, in the words it uses when the server says
        // the receiver left, instead of saying a send is starting that never will.
        await expect(senderPage.getByText('Peer joined. Starting transfer')).toBeHidden({ timeout: 10_000 });
        await expect(senderPage.getByText('Peer disconnected. Waiting for reconnection', { exact: true })).toBeVisible();
        // The link still works, so the tab is still held.
        await expect(senderPage.getByText('Keep this tab open and in front. Closing it cancels the transfer.')).toBeVisible();

        // The first receiver gives its seat up, and the next one gets the whole file.
        await firstCtx.close();
        const nextCtx = await optedOutContext(await browser.newContext());
        try {
            const nextPage = await nextCtx.newPage();
            await nextPage.goto(link);
            const downloadLink = nextPage.locator('a[download]').first();
            await expect(downloadLink).toBeVisible({ timeout: 30_000 });
            expect(await sha256OfBlobUrl(nextPage, (await downloadLink.getAttribute('href'))!)).toBe(file.sha256);
            await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });
        } finally {
            await nextCtx.close();
        }
    } finally {
        await senderCtx.close();
        await firstCtx.close();
    }
});
