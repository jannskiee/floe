/**
 * The main page's relay gate, in a browser.
 *
 * Two pages on one machine connect over a host candidate, so the gate the
 * sender runs when its route reads as relayed (lib/relay.ts evaluateRelayGate)
 * has never run on a CI leg: its two blocks, the notice the relayBlocked latch
 * keeps after the connection closes, and the reasons the receiver shows had
 * unit tests and source pins only. A sending context that reads its route as
 * relayed covers them here.
 *
 * relayedSender() below spoofs the route with an init script: every local
 * candidate the sender's stats report contains reads as a relay candidate, and
 * one named file reads as one byte over the cap, so the over-limit block can
 * fire without a 2 GB file existing. The real transfer still runs over the
 * host candidate the machine picks, which is why the first test is a real
 * send and not just a block.
 *
 * The simple-peer gotcha is in the script: its replacement takes no named
 * parameter, so getStats.length stays 0, which simple-peer 9.11.1 requires of
 * the promise form it waits on to connect.
 */

import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { createHash } from 'crypto';
import { RELAY_SIZE_LIMIT } from '../lib/relay';
import { RELAY_OFF_REASON } from '../lib/senderSelfStop';
import { RELAY_BLOCK_REASON } from '../lib/request/constants';
import {
    browserSenderSetup,
    sha256OfBlobUrl,
} from './helpers';

/** The name of the file the init script sizes up past the cap. The page's
 *  dedupe key is name+size+modified time, so the spoofed size keeps it its
 *  own row even in a context that has picked another file by the same name. */
const OVER_CAP = 'over-cap.bin';

/**
 * A sending context whose WebRTC route reads as relayed: the stats its peer
 * connection reports name every local candidate a relay candidate, and the
 * file `OVER_CAP` reports itself as one byte over the relay cap. One byte,
 * not two: RELAY_SIZE_LIMIT + 1 is the smallest total that trips the gate,
 * and the file behind it is still small enough to actually send.
 *
 * The receiver takes no such script: it shows what the sender's abort frame
 * names (lib/transfer/receiver.ts, the isAbortReason branch), not what its
 * own route would be.
 */
async function relayedSender(browser: Browser): Promise<BrowserContext> {
    const ctx = await browser.newContext();
    await ctx.addInitScript(({ name, size }: { name: string; size: number }) => {
        const getStats = RTCPeerConnection.prototype.getStats;
        // A rest parameter keeps getStats.length at 0, which simple-peer needs.
        RTCPeerConnection.prototype.getStats = function (this: RTCPeerConnection, ...args: unknown[]) {
            const real = getStats as (...a: unknown[]) => Promise<RTCStatsReport>;
            return real.apply(this, args).then((report) => {
                const copy = new Map<string, Record<string, unknown>>();
                report.forEach((stat: Record<string, unknown>, id: string) => {
                    copy.set(id, stat.type === 'local-candidate' ? { ...stat, candidateType: 'relay' } : stat);
                });
                return copy as unknown as RTCStatsReport;
            });
        } as typeof getStats;
        const realSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
        Object.defineProperty(Blob.prototype, 'size', {
            configurable: true,
            get() {
                return this instanceof File && this.name === name ? size : realSize.call(this);
            },
        });
    }, { name: OVER_CAP, size: RELAY_SIZE_LIMIT + 1 });
    return ctx;
}

/** The receiving context a person without stats on gets: "Contribute to
 *  global stats" stored off, as reconnect.spec.ts does. */
async function optedOutContext(ctx: BrowserContext): Promise<BrowserContext> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    return ctx;
}

test('a small send over a relayed route lands whole, with the relay badge up', async ({ browser }) => {
    // The 2 GB + 1 byte spoof only touches a file named OVER_CAP, so a
    // different name keeps this a plain send.
    const buffer = Buffer.from(Array(1024).fill(7));
    const expectedHash = createHash('sha256').update(buffer).digest('hex');
    const fixture = { name: 'small-file.bin', mimeType: 'application/octet-stream', buffer };

    const senderCtx = await relayedSender(browser);
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, fixture);
        await receiverPage.goto(link);

        // Relay fallback is on and the batch is under the cap, so the gate
        // proceeds at once (lib/relay.ts relayProbeDelayMs is 0): the send
        // starts ahead of the two-second probe.
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });
        const blobUrl = (await downloadLink.getAttribute('href'))!;
        expect(await sha256OfBlobUrl(receiverPage, blobUrl)).toBe(expectedHash);

        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });

        // The badge is ConnectionStatusBadge's label: useConnectionType calls
        // pc.getStats(), which is the patched prototype, so the badge reads
        // the spoofed relay candidate.
        await expect(senderPage.getByText('Relay', { exact: true })).toBeVisible({ timeout: 10_000 });
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('a relayed route with relay fallback off fails the send and names the reason', async ({ browser }) => {
    const buffer = Buffer.from(Array(1024).fill(7));
    const fixture = { name: 'small-file.bin', mimeType: 'application/octet-stream', buffer };

    const senderCtx = await relayedSender(browser);
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        // The untick is the only move this test makes on the page: with it,
        // the 2 s probe wait is on, so the window the block acts in is the
        // whole two seconds the send waits for the route.
        const link = await browserSenderSetup(senderPage, fixture, { relayFallback: false });
        await receiverPage.goto(link);

        // The gate blocks before any byte is read, so the page ends on the
        // banner, not a progress bar.
        await expect(senderPage.getByText('Connection failed. This link was made with Network relay fallback off.')).toBeVisible({ timeout: 30_000 });
        await expect(senderPage.getByText('Connection failed', { exact: true })).toBeVisible({ timeout: 30_000 });

        // The sender's abort frame carries the reason, verbatim, and it
        // arrives with the close.
        await expect(receiverPage.getByText(RELAY_OFF_REASON)).toBeVisible({ timeout: 30_000 });
        await expect(receiverPage.locator('a[download]')).toHaveCount(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('an over-cap send on a relayed route is blocked, and its notice outlives the connection', async ({ browser }) => {
    // The buffer behind the name is small on purpose: the page blocks before
    // it reads a byte, so the gate never sees the real size, and the SHA-256
    // proof of test one already covered the bytes this one never moves.
    const buffer = Buffer.from(Array(1024).fill(7));

    const senderCtx = await relayedSender(browser);
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, { name: OVER_CAP, mimeType: 'application/octet-stream', buffer });
        await receiverPage.goto(link);

        // The status comes from the block itself, ahead of the teardown the
        // block performs.
        await expect(senderPage.getByText('Transfer blocked. Relay limit exceeded.')).toBeVisible({ timeout: 30_000 });

        // The notice it keeps after the connection is the relayBlocked latch
        // (lib/relay.ts has no say in it; P2PTransfer.tsx does): the live
        // check it ors with reads connectionType, which peer.destroy()
        // resets, so without the latch the banner would drop the moment the
        // block tears the peer down. The badge is that reset made visible,
        // and it has to leave Relay before the notice is the only thing left
        // that says it.
        await expect(senderPage.getByText('Relay', { exact: true })).toBeHidden({ timeout: 30_000 });
        await expect(senderPage.getByText('Transfer limit exceeded.')).toBeVisible();

        // The count row reads the total the page itself computed, which is
        // the spoofed one, against the cap the page knows: 1 file, its size,
        // and the cap it is held to.
        await expect(senderPage.getByText('1 · 2 GB / 2 GB')).toBeVisible();

        // The receiver hears the same two words the main page's block text
        // names (lib/request/constants.ts RELAY_BLOCK_REASON, which P2PTransfer
        // builds inline and lib/relay.test.ts keeps in step with), and
        // nothing of the file reaches it: the block is before the first byte.
        await expect(receiverPage.getByText(RELAY_BLOCK_REASON)).toBeVisible({ timeout: 30_000 });
        await expect(receiverPage.locator('a[download]')).toHaveCount(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
