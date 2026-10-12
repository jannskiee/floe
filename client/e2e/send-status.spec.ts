/**
 * What a sender's status line says after a send did NOT go through.
 *
 * "Transfer complete" is what the page writes when the other side leaves, or
 * when its own signaling socket drops, after a finished send. Each test here
 * puts the page in a state where that sentence would be untrue and then makes
 * one of those two things happen.
 *
 * A browser receiver never refuses a file by code and never closes its peer
 * connection in the middle of one: `floe receive` and Floe Desktop do both.
 * So the receiving page here keeps hold of its RTCPeerConnection and its data
 * channel, and the test does on them what those receivers do on theirs.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFixture, browserSenderSetup } from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-send-status');
// What the status reads once an interrupted recipient has also left the room:
// the page goes back to waiting for them, which is true, since the link still
// works. Either sentence is right. "Transfer complete" is not.
const AFTER_AN_INTERRUPTION = /^(Connection interrupted|Peer disconnected[.] Waiting for reconnection)$/;

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface Held {
    floePc?: RTCPeerConnection;
    floeChannel?: RTCDataChannel;
    floeSlowSend?: boolean;
}

/** A receiver context whose page keeps its peer connection and data channel
 *  within reach, and keeps its transfers out of the stats counter. */
async function receiverContext(browser: Browser): Promise<BrowserContext> {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
        const Native = window.RTCPeerConnection;
        class Watched extends Native {
            constructor(config?: RTCConfiguration) {
                super(config);
                const held = window as unknown as Held;
                held.floePc = this;
                this.addEventListener('datachannel', (event) => {
                    held.floeChannel = event.channel;
                });
            }
        }
        window.RTCPeerConnection = Watched;
    });
    return ctx;
}

/** A sender context whose page can be slowed down. Between two pages on one
 *  machine a file of any sensible size is through before a recipient can be
 *  stopped, so once the test sets floeSlowSend every binary frame first holds
 *  the page for a few milliseconds. Nothing about what is sent changes. */
async function senderContext(browser: Browser): Promise<BrowserContext> {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        const send = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: never) {
            if ((window as unknown as Held).floeSlowSend && typeof data !== 'string') {
                const until = performance.now() + 6;
                while (performance.now() < until) { /* hold the page */ }
            }
            return send.call(this, data);
        } as typeof send;
    });
    return ctx;
}

const slowDown = (senderPage: Page) =>
    senderPage.evaluate(() => {
        (window as unknown as Held).floeSlowSend = true;
    });

/** Waits until the sender's bar is moving, then closes the recipient's peer
 *  connection, the way a receiver that is stopped closes its own. */
async function stopMidFile(senderPage: Page, recipientPage: Page): Promise<void> {
    const percent = senderPage.getByText(/^[0-9]+%$/);
    const read = async () => ((await percent.count()) ? Number.parseInt((await percent.first().textContent()) ?? '0', 10) : 0);
    await expect.poll(read, { message: 'the send never got going', timeout: 45_000, intervals: [40] }).toBeGreaterThanOrEqual(2);
    await recipientPage.evaluate(() => (window as unknown as Held).floePc?.close());
    expect(await read(), 'the file was already through when the recipient stopped; slow the sending page further').toBeLessThan(95);
}

test('a refusal after the last byte stays a failure when the page loses its socket', async ({ browser }) => {
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 1024 * 1024);
    const senderCtx = await browser.newContext();
    const receiverCtx = await receiverContext(browser);
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();
    // The sender's badge reads "Direct" while a peer is up, so the word
    // "Offline" never shows there. The signaling socket closing is read off
    // the wire instead (next dev's own HMR socket does not count).
    let signalingClosed = 0;
    senderPage.on('websocket', (ws) => {
        if (ws.url().includes('/socket.io/')) ws.on('close', () => { signalingClosed += 1; });
    });

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);
        await receiverPage.goto(link);
        await expect(receiverPage.locator('a[download]').first()).toBeVisible({ timeout: 30_000 });
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });

        // What a receiver that could not save the last file sends. Not a hash
        // mismatch: that one code has its own sentence and its own latch.
        // Every other late refusal goes through the generic path.
        const refusal = JSON.stringify({
            type: 'incompatible',
            reason: 'The receiver could not save a file.',
            pv: 1,
            pvMin: 1,
            code: 'write-failed',
            saved: 0,
        });
        await receiverPage.evaluate((frame) => (window as unknown as Held).floeChannel?.send(frame), refusal);
        await expect(senderPage.getByText('Transfer failed', { exact: true })).toBeVisible({ timeout: 10_000 });

        // The page's own socket dropping must not turn a refused send green.
        await senderCtx.setOffline(true);
        await expect
            .poll(() => signalingClosed, { message: 'the sender page never dropped its signaling socket', timeout: 15_000 })
            .toBeGreaterThan(0);
        await senderPage.waitForTimeout(1_500);
        await expect(senderPage.getByText('Transfer complete', { exact: true })).toHaveCount(0, { timeout: 3_000 });
        await expect(senderPage.getByText('Transfer failed', { exact: true })).toBeVisible();
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

// The baseline for the test after it: what a sender has shown since #500 when
// its recipient stops in the middle of a file.
test('a recipient who stops mid-file is reported as an interruption', async ({ browser }) => {
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 24 * 1024 * 1024);
    const senderCtx = await senderContext(browser);
    const recipientCtx = await receiverContext(browser);
    const senderPage = await senderCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);
        await slowDown(senderPage);
        const recipientPage = await recipientCtx.newPage();
        await recipientPage.goto(link);
        await stopMidFile(senderPage, recipientPage);

        await expect(senderPage.getByText('Connection interrupted', { exact: true })).toBeVisible({ timeout: 15_000 });
        await recipientCtx.close();
        await senderPage.waitForTimeout(1_500);
        await expect(senderPage.getByText('Transfer complete', { exact: true })).toHaveCount(0, { timeout: 3_000 });
        await expect(senderPage.getByText(AFTER_AN_INTERRUPTION)).toBeVisible();
    } finally {
        await senderCtx.close();
        try { await recipientCtx.close(); } catch { /* already closed mid-test */ }
    }
});

// The same thing, done by a second recipient after a first one took the whole
// file. A second send must not be read through the first one's outcome.
test('a second recipient who stops mid-file is reported the same way', async ({ browser }) => {
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 24 * 1024 * 1024);
    const senderCtx = await senderContext(browser);
    const firstCtx = await receiverContext(browser);
    const secondCtx = await receiverContext(browser);
    const senderPage = await senderCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);

        const firstPage = await firstCtx.newPage();
        await firstPage.goto(link);
        await expect(firstPage.locator('a[download]').first()).toBeVisible({ timeout: 60_000 });
        await expect(senderPage.getByText('Sent 1 file', { exact: true })).toBeVisible({ timeout: 10_000 });
        await firstCtx.close();

        await slowDown(senderPage);
        const secondPage = await secondCtx.newPage();
        await secondPage.goto(link);
        // The first send's "100%" row goes away when the new recipient joins;
        // wait for that, or stopMidFile reads the old figure.
        await expect(senderPage.getByText(/Peer joined/).first()).toBeVisible({ timeout: 30_000 });
        await expect(senderPage.getByText(/^[0-9]+%$/)).toHaveCount(0);
        await stopMidFile(senderPage, secondPage);

        await expect(senderPage.getByText('Connection interrupted', { exact: true })).toBeVisible({ timeout: 15_000 });
        await secondCtx.close();
        await senderPage.waitForTimeout(1_500);
        await expect(senderPage.getByText('Transfer complete', { exact: true })).toHaveCount(0, { timeout: 3_000 });
        await expect(senderPage.getByText(AFTER_AN_INTERRUPTION)).toBeVisible();
        await expect(senderPage.getByText('Sent 1 file', { exact: true })).toHaveCount(0);
    } finally {
        await senderCtx.close();
        try { await firstCtx.close(); } catch { /* already closed mid-test */ }
        try { await secondCtx.close(); } catch { /* already closed mid-test */ }
    }
});
