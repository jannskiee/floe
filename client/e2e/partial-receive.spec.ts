/**
 * How a receive ends when the sender goes away partway (WEB-03, WEB-04).
 *
 * The receiver page used to draw its green check and "1 file received" as soon
 * as one file was in the list, whatever the sender had announced, and the
 * progress row of the file that never finished stayed on screen at its last
 * percent. A sender that vanished during file 2 of 3 left a page that looked
 * done, with a bar still saying a file was arriving.
 *
 * The sender here is scripted, not the app: a routed page that joins the room
 * first, offers on user-connected, and writes the frames by hand, so the spec
 * decides the exact point at which it disappears. Closing a real sender tab
 * mid-file races the transfer on loopback. The frames come from the real
 * builders through the loopback bundle (e2e/loopback/entry.ts).
 *
 * The receiver is the real app, with its "Contribute to global stats" toggle
 * stored off before any script runs.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { join } from 'path';
import { LOOPBACK_BUNDLE } from './cli-binary';
import { SERVER_URL, WEB_URL } from './helpers';

const SENDER_URL = `${WEB_URL}/__floe-partial-sender`;
const requireFromClient = createRequire(join(__dirname, '..', 'package.json'));

const KIB = 1024;
const MIB = 1024 * 1024;

/** One scripted file: how many bytes it announces and how many it really sends. */
interface Step {
    announced: number;
    sent: number;
    // false: the end marker carries no SHA-256, as from a floe older than
    // 1.11.0 or a browser whose hash was not ready, so the file is checked
    // by size only.
    hash?: boolean;
}

interface Rig {
    receiver: Page;
    sender: Page;
    statsReports: () => number;
    close: () => Promise<void>;
}

/**
 * Seats the scripted sender, then opens the real receiver on the same room.
 * Two contexts, so the Local Network Access grant below stays off the app.
 */
async function openRig(browser: Browser, roomId: string): Promise<Rig> {
    const senderCtx: BrowserContext = await browser.newContext();
    // A page.route fulfilment counts as a public document to Chromium, which
    // then refuses its Socket.IO polling to localhost:3001. Only this
    // test-made page gets the permission; see loopback-host.spec.ts.
    await senderCtx.grantPermissions(['local-network-access'], { origin: WEB_URL });
    const sender = await senderCtx.newPage();
    await sender.route(SENDER_URL, (route) => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>scripted sender</title>',
    }));
    await sender.goto(SENDER_URL);
    await sender.addScriptTag({ path: requireFromClient.resolve('simple-peer/simplepeer.min.js') });
    await sender.addScriptTag({ path: requireFromClient.resolve('socket.io-client/dist/socket.io.js') });
    await sender.addScriptTag({ path: LOOPBACK_BUNDLE });

    // The first joiner holds the sender seat. Resolves once the server has
    // seated it, so the receiver below is always the second joiner.
    await sender.evaluate(({ roomId, serverUrl }) => new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const socket = w.io(serverUrl);
        w.scripted = { socket, peer: null, acks: [] as string[], connected: false };
        socket.on('connect', () => socket.emit('join-room', roomId));
        socket.on('room-joined', () => resolve());
        socket.on('room-full', () => reject(new Error('room-full')));
        socket.on('user-connected', (userId: string) => {
            const peer = new w.SimplePeer({
                initiator: true,
                trickle: true,
                readableObjectMode: true,
                config: { iceServers: [] },
            });
            w.scripted.peer = peer;
            peer.on('signal', (signal: unknown) => socket.emit('signal', { target: userId, roomId, signal }));
            socket.on('signal', (d: { signal: unknown }) => peer.signal(d.signal));
            // The receiver answers each file description with a text frame
            // naming the file it is ready for.
            peer.on('data', (d: unknown) => {
                if (typeof d !== 'string') return;
                try {
                    const msg = JSON.parse(d);
                    if (msg.type === 'ack') w.scripted.acks.push(msg.id);
                } catch { /* not a control frame */ }
            });
            peer.on('connect', () => { w.scripted.connected = true; });
            // Destroying the peer below surfaces here; nothing to report.
            peer.on('error', () => {});
        });
    }), { roomId, serverUrl: SERVER_URL });

    const receiverCtx = await browser.newContext();
    await receiverCtx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    const receiver = await receiverCtx.newPage();
    let reports = 0;
    receiver.on('request', (req) => {
        if (req.url().includes('/api/stats/report')) reports++;
    });
    await receiver.goto(`${WEB_URL}/#room=${roomId}`);
    await sender.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (window as any).scripted.connected === true,
        undefined,
        { timeout: 30_000 },
    );

    return {
        receiver,
        sender,
        statsReports: () => reports,
        close: async () => {
            await receiverCtx.close();
            await senderCtx.close();
        },
    };
}

/**
 * Sends the scripted files in order on the open channel. A step whose `sent`
 * is below `announced` stops there, with no end marker and every byte flushed,
 * and nothing after it is sent: that is the file the sender dies in.
 */
async function sendSteps(sender: Page, steps: Step[]): Promise<void> {
    await sender.evaluate(async ({ steps }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const { peer, acks } = w.scripted;
        const channel: RTCDataChannel = peer._channel;
        const CHUNK = 16 * 1024;
        const pause = () => new Promise((r) => setTimeout(r, 5));
        const ackFor = async (id: string) => {
            while (!acks.includes(id)) await pause();
        };
        const drained = async (below: number) => {
            while (channel.bufferedAmount > below) await pause();
        };
        const hex = (buf: ArrayBuffer) =>
            Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

        const total = steps.length;
        const totalBytes = steps.reduce((sum: number, s: { announced: number }) => sum + s.announced, 0);
        for (let i = 0; i < total; i++) {
            const step = steps[i];
            const id = crypto.randomUUID();
            peer.send(w.floeLoopback.metadataMessage(id, `part-${i + 1}.bin`, step.announced, i + 1, total, totalBytes));
            // The description of file N+1 waits behind file N's SHA-256 check
            // on the receiver, so this answer also proves file N was handed over.
            await ackFor(id);

            // Never starts with '{': nothing here can read as a control frame.
            const body = new Uint8Array(step.sent).fill(0x61 + i);
            for (let off = 0; off < body.byteLength; off += CHUNK) {
                peer.send(body.subarray(off, off + CHUNK));
                if (channel.bufferedAmount > 1024 * 1024) await drained(256 * 1024);
            }
            await drained(0);
            if (step.sent < step.announced) return;
            peer.send(w.floeLoopback.endMessage(
                step.hash === false ? null : hex(await crypto.subtle.digest('SHA-256', body)),
            ));
        }
        await drained(0);
    }, { steps });
}

/** The line at the foot of the card, never its copy in the status region. */
function footLine(page: Page, text: string | RegExp) {
    return page.getByText(text).and(page.locator(':not([role="status"])'));
}

/** The card's one status region, which says how the receive ended. */
function endRegion(page: Page) {
    return page.getByRole('main').getByRole('status');
}

test('a sender that vanishes during file 2 of 3 does not leave the receiver looking finished', async ({ browser }) => {
    const rig = await openRig(browser, randomUUID());
    try {
        // File 1 whole, then a quarter of file 2, and the sender is gone.
        await sendSteps(rig.sender, [
            { announced: KIB, sent: KIB },
            { announced: 16 * MIB, sent: 4 * MIB },
            { announced: KIB, sent: KIB },
        ]);

        // Mid-transfer: one file handed over, the second one arriving.
        await expect(rig.receiver.locator('a[download]')).toHaveCount(1);
        await expect(rig.receiver.getByRole('progressbar')).toBeVisible();
        await expect(endRegion(rig.receiver)).toBeEmpty();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await rig.sender.evaluate(() => (window as any).scripted.peer.destroy());

        await expect(
            footLine(rig.receiver, 'Received 1 of 3 files. The transfer ended before the rest arrived.'),
        ).toBeVisible();
        await expect(endRegion(rig.receiver)).toHaveText(
            'Received 1 of 3 files. The transfer ended before the rest arrived.',
        );
        // No completion line, so no check of either kind: the two are one
        // element.
        await expect(rig.receiver.getByText(/^\d+ files? received$/)).toHaveCount(0);
        await expect(rig.receiver.locator('[data-mark]')).toHaveCount(0);
        // The row for the file that never finished is gone with it.
        await expect(rig.receiver.getByRole('progressbar')).toHaveCount(0);
        // What did arrive is still there to download.
        await expect(rig.receiver.locator('a[download]')).toHaveCount(1);
        expect(rig.statsReports(), 'a partial receive reported stats').toBe(0);
    } finally {
        await rig.close();
    }
});

test('a full receive still ends on the completion line, before and after the sender leaves', async ({ browser }) => {
    const rig = await openRig(browser, randomUUID());
    try {
        await sendSteps(rig.sender, [
            { announced: KIB, sent: KIB },
            { announced: 2 * MIB, sent: 2 * MIB },
            { announced: KIB, sent: KIB },
        ]);

        await expect(footLine(rig.receiver, /^3 files received$/)).toBeVisible();
        await expect(endRegion(rig.receiver)).toHaveText('3 files received');
        // Every file matched: the green check in front of the count line,
        // and the words for screen readers only (the desktop's rule).
        await expect(rig.receiver.locator('[data-mark="verified"]')).toBeVisible();
        await expect(rig.receiver.locator('[data-mark="plain"]')).toHaveCount(0);
        await expect(rig.receiver.getByText('SHA-256 matched', { exact: true })).toHaveClass('sr-only');
        await expect(rig.receiver.locator('a[download]')).toHaveCount(3);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await rig.sender.evaluate(() => (window as any).scripted.peer.destroy());

        // The wordmark's status turning to "Not connected" is how the page
        // shows the close has landed, so the checks below read the end state.
        await expect(rig.receiver.getByTitle('Not connected')).toBeVisible();
        await expect(rig.receiver.getByRole('progressbar')).toHaveCount(0);
        await expect(footLine(rig.receiver, /^3 files received$/)).toBeVisible();
        await expect(rig.receiver.getByText(/The transfer ended before the rest arrived/)).toHaveCount(0);
        expect(rig.statsReports(), 'the opted-out receiver reported stats').toBe(0);
    } finally {
        await rig.close();
    }
});

test('a full receive with a file checked by size only ends on the gray check', async ({ browser }) => {
    const rig = await openRig(browser, randomUUID());
    try {
        await sendSteps(rig.sender, [
            { announced: KIB, sent: KIB },
            { announced: KIB, sent: KIB, hash: false },
        ]);

        // Every file arrived, so the count line is the complete one, but one
        // came with no SHA-256: the gray plain check, and no words at all.
        await expect(footLine(rig.receiver, /^2 files received$/)).toBeVisible();
        await expect(endRegion(rig.receiver)).toHaveText('2 files received');
        await expect(rig.receiver.locator('[data-mark="plain"]')).toBeVisible();
        await expect(rig.receiver.locator('[data-mark="verified"]')).toHaveCount(0);
        await expect(rig.receiver.getByText('SHA-256 matched', { exact: true })).toHaveCount(0);
        await expect(rig.receiver.locator('a[download]')).toHaveCount(2);
    } finally {
        await rig.close();
    }
});
