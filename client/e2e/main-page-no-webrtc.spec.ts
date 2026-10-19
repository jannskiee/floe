import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { browserSenderSetup, createFixture } from './helpers';
import { forwardSocketFrames, framesFor } from './request-helpers';

// ---------------------------------------------------------------------------
// The main page in a browser with no WebRTC data channels.
//
// Tor Browser, Mullvad Browser and Firefox with media.peerconnection.enabled
// off have no RTCPeerConnection, and new SimplePeer throws there. A receiving
// page used to join its room first and then throw, so it held the seat while
// the sender waited on a peer that was never built; a sending page found out
// only once a receiver joined. Each now says so in the red banner, and a
// receiving page never joins, so the seat stays free for a browser that can
// take it.
//
// Deleting the constructor in an init script is what such a browser looks
// like from the page, the same probe as the /r page's E2E-12.
// ---------------------------------------------------------------------------

const RECEIVING =
    'This browser cannot receive files through Floe because WebRTC is missing or turned off. Open the link in a current version of Chrome, Edge, Firefox or Safari.';
const SENDING =
    'This browser cannot send files through Floe because WebRTC is missing or turned off. Use a current version of Chrome, Edge, Firefox or Safari.';

async function withoutWebRtc(page: Page): Promise<string[]> {
    await page.addInitScript(() => {
        delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
    });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    return errors;
}

test('a receiving page without WebRTC never takes its seat and says why', async ({ page }) => {
    const errors = await withoutWebRtc(page);
    const frames = await forwardSocketFrames(page);

    await page.goto(`/#room=${randomUUID()}`);

    // The socket is up and the page has run for a ping interval, so a join
    // made on load would be on the wire by now.
    await expect.poll(() => framesFor(frames.outgoing, 'ping').length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(framesFor(frames.outgoing, 'join-room')).toEqual([]);

    await expect(page.getByText(RECEIVING)).toBeVisible();
    // The banner is the whole account: no joining steps under it, and no
    // keep-open line for a tab that nothing depends on.
    await expect(page.getByText('Secure room joined')).toHaveCount(0);
    await expect(page.getByText(/closing it interrupts the download/i)).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('a sending page without WebRTC says why on load', async ({ page }) => {
    const errors = await withoutWebRtc(page);

    await page.goto('/');

    await expect(page.getByText(SENDING)).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
});

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-no-webrtc');

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a sending page without WebRTC keeps its sentence when a receiver joins', async ({ page, browser }) => {
    // Its errors are not asserted: the peer it then tries to build still
    // throws there, and the sentence is what says why.
    await withoutWebRtc(page);
    const { path } = createFixture(FIXTURE_DIR, 1024);
    const link = await browserSenderSetup(page, path);
    await expect(page.getByText(SENDING)).toBeVisible();

    const ctx = await browser.newContext();
    try {
        const receiver = await ctx.newPage();
        await receiver.goto(link);
        // The reset for a new recipient used to take the sentence down here.
        await expect(page.getByText('Peer joined. Starting transfer')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(SENDING), 'the sentence was lost when a receiver joined').toBeVisible();
    } finally {
        await ctx.close();
    }
});
