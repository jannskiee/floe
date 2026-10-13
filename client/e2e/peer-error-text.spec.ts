/**
 * The words of a connection error are never the other peer's.
 *
 * The other peer chooses the SDP it relays through the signaling server, and
 * a browser that cannot parse a description quotes the line it stopped at in
 * the error it raises ("Failed to parse SessionDescription. <line> ..."). The
 * page used to draw that message after "Connection error:" and send it to
 * Sentry, so whoever held the link could put a sentence of their choosing in
 * Floe's own red banner, on the receiving page and on the sending page.
 *
 * Both tests relay one description that cannot be parsed, carrying a marker,
 * and read what the real page shows: a fixed sentence, and the marker nowhere.
 * The peer here is scripted, a routed page with a bare Socket.IO client, as
 * in partial-receive.spec.ts.
 *
 * Whether this Chromium still quotes the line is recorded on the test as an
 * annotation and never fails it: the assertion that matters holds whatever
 * the browser says, and a browser that stops quoting must not turn the suite
 * red.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { SERVER_URL, WEB_URL, browserSenderSetup } from './helpers';

const PEER_URL = `${WEB_URL}/__floe-scripted-peer`;
const requireFromClient = createRequire(join(__dirname, '..', 'package.json'));

const MARKER = 'FLOEPEERTEXT';
// Not a line any SDP grammar has, so the parser stops on it.
const HOSTILE_SDP = `v=0\r\nx=${MARKER} Your link has a problem. Open evil.example and paste it there\r\n`;

const RECEIVER_SENTENCE =
    'Connection failed. Reload the page to try again. If it fails again, ask the sender for a new link.';
const SENDER_SENTENCE =
    'Connection failed. Ask the other device to open the link again. If it fails again, reload the page, add the files again, and share the new link.';

/** A page of the test's own with a Socket.IO client, and simple-peer when asked. */
async function scriptedPeer(
    browser: Browser,
    { simplePeer = false }: { simplePeer?: boolean } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
    const ctx = await browser.newContext();
    // A page.route fulfilment counts as a public document to Chromium, which
    // then refuses its Socket.IO polling to localhost:3001. Only this
    // test-made page gets the permission; see loopback-host.spec.ts.
    await ctx.grantPermissions(['local-network-access'], { origin: WEB_URL });
    const page = await ctx.newPage();
    await page.route(PEER_URL, (route) => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>scripted peer</title>',
    }));
    await page.goto(PEER_URL);
    await page.addScriptTag({ path: requireFromClient.resolve('socket.io-client/dist/socket.io.js') });
    if (simplePeer) await page.addScriptTag({ path: requireFromClient.resolve('simple-peer/simplepeer.min.js') });
    return { page, close: () => ctx.close() };
}

/** Note on the test whether this browser quotes an unparsed SDP line. */
async function noteVector(page: Page, type: 'offer' | 'answer'): Promise<void> {
    const said = await page.evaluate(async ({ type, sdp }) => {
        const pc = new RTCPeerConnection();
        try {
            if (type === 'answer') await pc.setLocalDescription(await pc.createOffer());
            await pc.setRemoteDescription({ type, sdp });
            return null;
        } catch (e) {
            return String((e as Error).message);
        } finally {
            pc.close();
        }
    }, { type, sdp: HOSTILE_SDP });
    test.info().annotations.push({
        type: 'peer-text-vector',
        description: said === null
            ? `this Chromium accepted the ${type} it should not parse`
            : said.includes(MARKER)
                ? `this Chromium quotes the unparsed line of an ${type} in its error`
                : `this Chromium no longer quotes the unparsed line of an ${type}`,
    });
}

test.describe('peer error text', () => {
    test('a receiving page shows its fixed sentence, never the text of an offer it could not parse', async ({ browser }) => {
        const roomId = randomUUID();
        const peer = await scriptedPeer(browser);
        const receiverCtx = await browser.newContext();
        try {
            await noteVector(peer.page, 'offer');
            // The first joiner holds the sender seat, and offers the moment
            // the receiver arrives.
            await peer.page.evaluate(({ roomId, serverUrl, sdp }) => new Promise<void>((resolve, reject) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const socket = (window as any).io(serverUrl);
                socket.on('connect', () => socket.emit('join-room', roomId));
                socket.on('room-joined', () => resolve());
                socket.on('room-full', () => reject(new Error('room-full')));
                socket.on('user-connected', (userId: string) => {
                    socket.emit('signal', { target: userId, roomId, signal: { type: 'offer', sdp } });
                });
            }), { roomId, serverUrl: SERVER_URL, sdp: HOSTILE_SDP });

            await receiverCtx.addInitScript(() => {
                try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
            });
            const receiver = await receiverCtx.newPage();
            await receiver.goto(`${WEB_URL}/#room=${roomId}`);

            await expect(receiver.getByText(RECEIVER_SENTENCE, { exact: true })).toBeVisible({ timeout: 30_000 });
            const shown = await receiver.locator('body').innerText();
            expect(shown).not.toContain(MARKER);
            expect(shown).not.toContain('evil.example');
            expect(shown).not.toContain('Connection error');
            expect(shown).not.toContain('SessionDescription');
        } finally {
            await receiverCtx.close();
            await peer.close();
        }
    });

    test('a sending page shows its fixed sentence, never the text of an answer it could not parse', async ({ browser }, testInfo) => {
        const fixture = testInfo.outputPath('peer-error.bin');
        writeFileSync(fixture, Buffer.alloc(1024, 7));
        const senderCtx = await browser.newContext();
        const peer = await scriptedPeer(browser);
        try {
            await noteVector(peer.page, 'answer');
            const sender = await senderCtx.newPage();
            const link = await browserSenderSetup(sender, fixture);
            const roomId = new URL(link).hash.replace(/^#room=/, '');

            // The second joiner is the receiver: it answers the sender's
            // first offer, once, with a description that cannot be parsed.
            await peer.page.evaluate(({ roomId, serverUrl, sdp }) => new Promise<void>((resolve, reject) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const socket = (window as any).io(serverUrl);
                let answered = false;
                socket.on('connect', () => socket.emit('join-room', roomId));
                socket.on('room-joined', () => resolve());
                socket.on('room-full', () => reject(new Error('room-full')));
                socket.on('signal', (d: { sender: string; signal?: { type?: string } }) => {
                    if (answered || d.signal?.type !== 'offer') return;
                    answered = true;
                    socket.emit('signal', { target: d.sender, roomId, signal: { type: 'answer', sdp } });
                });
            }), { roomId, serverUrl: SERVER_URL, sdp: HOSTILE_SDP });

            await expect(sender.getByText(SENDER_SENTENCE, { exact: true })).toBeVisible({ timeout: 30_000 });
            const shown = await sender.locator('body').innerText();
            expect(shown).not.toContain(MARKER);
            expect(shown).not.toContain('evil.example');
            expect(shown).not.toContain('Connection error');
            expect(shown).not.toContain('SessionDescription');
        } finally {
            await senderCtx.close();
            await peer.close();
        }
    });

    // The Link Invalid card is drawn from one value of the banner state, and
    // a sender that stops with a reason puts its own words there. The page
    // used to ask whether the state contained "Link Expired", so a sender
    // could switch a connected receiver to the card ("This link is expired,
    // already in use ...") on a link that was good.
    test('a stop reason that spells the Link Invalid value shows as an ordinary banner, never the card', async ({ browser }) => {
        const roomId = randomUUID();
        const peer = await scriptedPeer(browser, { simplePeer: true });
        const receiverCtx = await browser.newContext();
        try {
            // A real connection this time: the frame travels the data channel.
            await peer.page.evaluate(({ roomId, serverUrl, frame }) => new Promise<void>((resolve, reject) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                const socket = w.io(serverUrl);
                socket.on('connect', () => socket.emit('join-room', roomId));
                socket.on('room-joined', () => resolve());
                socket.on('room-full', () => reject(new Error('room-full')));
                socket.on('user-connected', (userId: string) => {
                    const p = new w.SimplePeer({ initiator: true, trickle: true, config: { iceServers: [] } });
                    p.on('signal', (signal: unknown) => socket.emit('signal', { target: userId, roomId, signal }));
                    socket.on('signal', (d: { signal: unknown }) => p.signal(d.signal));
                    p.on('connect', () => p.send(frame));
                    p.on('error', () => {});
                });
            }), {
                roomId,
                serverUrl: SERVER_URL,
                frame: JSON.stringify({ type: 'incompatible', reason: 'Link Expired or Busy' }),
            });

            await receiverCtx.addInitScript(() => {
                try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
            });
            const receiver = await receiverCtx.newPage();
            await receiver.goto(`${WEB_URL}/#room=${roomId}`);

            await expect(receiver.getByText('The sender stopped the transfer.', { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(receiver.getByRole('heading', { name: 'Link Invalid' })).toHaveCount(0);
        } finally {
            await receiverCtx.close();
            await peer.close();
        }
    });

    // The ack's offset is whatever the receiver typed. An object whose
    // toString is not a function made the sending page throw while it worded
    // its refusal, and nothing awaited the send: the page stayed on
    // "Connected" for good, with no banner. It now refuses in fixed words.
    test('a sending page refuses an ack whose offset is an object, and says so', async ({ browser }, testInfo) => {
        const fixture = testInfo.outputPath('bad-ack.bin');
        writeFileSync(fixture, Buffer.alloc(1024, 7));
        const senderCtx = await browser.newContext();
        const peer = await scriptedPeer(browser, { simplePeer: true });
        try {
            const sender = await senderCtx.newPage();
            const link = await browserSenderSetup(sender, fixture);
            const roomId = new URL(link).hash.replace(/^#room=/, '');

            // The second joiner is the receiver: a real connection, and one
            // answer to the first file's metadata.
            await peer.page.evaluate(({ roomId, serverUrl }) => new Promise<void>((resolve, reject) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                const socket = w.io(serverUrl);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let p: any = null;
                socket.on('connect', () => socket.emit('join-room', roomId));
                socket.on('room-joined', () => resolve());
                socket.on('room-full', () => reject(new Error('room-full')));
                socket.on('signal', (d: { sender: string; signal: unknown }) => {
                    if (!p) {
                        p = new w.SimplePeer({ initiator: false, trickle: true, config: { iceServers: [] } });
                        p.on('signal', (signal: unknown) => socket.emit('signal', { target: d.sender, roomId, signal }));
                        p.on('error', () => {});
                        p.on('data', (data: Uint8Array) => {
                            let msg: { type?: string; id?: string };
                            try {
                                msg = JSON.parse(new TextDecoder().decode(data));
                            } catch {
                                return;
                            }
                            if (msg.type !== 'metadata') return;
                            // Binary, like every receiver-to-sender frame.
                            p.send(new TextEncoder().encode(
                                `{"type":"ack","id":${JSON.stringify(msg.id)},"offset":{"toString":0}}`
                            ));
                        });
                    }
                    p.signal(d.signal);
                });
            }), { roomId, serverUrl: SERVER_URL });

            await expect(sender.getByText(
                'The receiver asked to resume "bad-ack.bin" from a position that is not a number, which is not possible. Please try again.',
                { exact: true },
            )).toBeVisible({ timeout: 30_000 });
            await expect(sender.getByText('Transfer failed', { exact: true })).toBeVisible();
        } finally {
            await senderCtx.close();
            await peer.close();
        }
    });
});
