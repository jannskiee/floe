/**
 * The link key on the main page, in real browsers.
 *
 * A share link carries a random key in its fragment that no server sees. After DTLS
 * opens, each side that holds it proves so with an HMAC bound to the certificates
 * actually in use, and a receiver holding it refuses a sender that cannot. These
 * tests drive the real page: two of them with each other, and one against a scripted
 * peer whose proof is computed here with the browser's own crypto.subtle, an
 * implementation the page does not use (it has sha256Sync.ts), so a page that agrees
 * with it has not only agreed with itself.
 *
 * What cannot be seen from a running page lives in lib/linkKeyBoundaries.test.ts.
 * The Sentry report has no DSN in this build: lib/keyCheckReport.test.ts holds it.
 *
 * The Cache Storage check needs the worker, so a production build (see
 * service-worker.spec.ts); under next dev it reads an empty store and says so on the
 * test. The Firefox cells are opt-in, FLOE_E2E_FIREFOX=1, and no CI leg sets it: CI
 * installs Chromium only. Fixtures live in each test's own output folder.
 */

import { test, expect, chromium, firefox, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { join } from 'path';
import {
    KEY_FAILED_RECEIVER,
    KEY_FAILED_SENDER,
    KEY_REFUSED_SENDER,
    KEY_SILENT_SENDER,
    KEY_UNAVAILABLE_RECEIVER,
    KEY_UNAVAILABLE_SENDER,
} from '../lib/linkKeyCopy';
import { SENDER_REJECTED } from '../lib/senderStop';
import { ENFORCE_LINK_KEYS, ENFORCE_SHARE_LINK_KEY, KEY_CHECK_WAIT_MS, KEY_RECEIVE_WAIT_MS, MAKE_LINK_KEYS } from '../lib/transfer/protocol';
import {
    KEYED_SHARE_LINK,
    SERVER_URL,
    SHARE_LINK_TEXT,
    WEB_URL,
    browserSenderSetup,
    collectStdout,
    createFixture,
    keyOfShareLink,
    roomOfShareLink,
    sha256OfBlobUrl,
    spawnSend,
    waitForExit,
    withKey,
    CLI_TIMEOUT_MS,
} from './helpers';

const requireFromClient = createRequire(join(__dirname, '..', 'package.json'));
const PEER_URL = `${WEB_URL}/__floe-scripted-peer`;

const INVALID_CARD = 'Link Invalid';
const CARD_WORDS = 'This link is incomplete, already in use, or locked to the networks that first used it.';

// 16 random bytes are always a canonical key: the encoder writes zero padding bits.
const newKey = () => randomBytes(16).toString('base64url');

const SOME_KEY = 'AAECAwQFBgcICQoLDA0ODw';

async function optedOut(ctx: BrowserContext): Promise<BrowserContext> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    return ctx;
}

// ---------------------------------------------------------------------------
// Watching what a page does
// ---------------------------------------------------------------------------

/** What this page puts on its data channels, in order: a control frame by its type,
 *  a text or binary frame that is not one as text or binary:<bytes>. Read where
 *  simple-peer hands it to the browser, so a wrapper around peer.send cannot hide
 *  one. A receiver's control frames are binary, so they are read by content. */
async function watchChannel(ctx: BrowserContext): Promise<void> {
    await ctx.addInitScript(() => {
        const sent: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__channelSent = sent;
        const typeOf = (text: string): string | null => {
            try {
                const parsed = JSON.parse(text);
                return typeof parsed?.type === 'string' ? parsed.type : null;
            } catch {
                return null;
            }
        };
        const real = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
            if (typeof data === 'string') {
                sent.push(typeOf(data) ?? 'text');
            } else {
                const bytes = data as ArrayBufferView;
                const small = bytes.byteLength <= 1000;
                const type = small ? typeOf(new TextDecoder().decode(bytes)) : null;
                sent.push(type ?? `binary:${bytes.byteLength}`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (real as any).call(this, data);
        } as typeof RTCDataChannel.prototype.send;
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const channelSent = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__channelSent ?? []);

/** Every request and socket frame of a context. A navigation's URL is read up to its
 *  #: the browser sends no fragment, and Playwright reports it on the request anyway. */
function watchTraffic(ctx: BrowserContext) {
    const urls: string[] = [];
    const bodies: string[] = [];
    const headers: Promise<void>[] = [];
    const heardHeaders: string[] = [];
    const frames: string[] = [];
    let sockets = 0;
    ctx.on('request', (request) => {
        urls.push(request.url().split('#')[0]);
        const body = request.postData();
        if (body) bodies.push(body);
        // A request a service worker answered never resolves allHeaders() in Chromium, so
        // the headers Playwright already holds stand in for it after a moment.
        const asSent = Promise.race([
            request.allHeaders(),
            new Promise<Record<string, string>>((resolve) => setTimeout(() => resolve(request.headers()), 2_000)),
        ]);
        headers.push(
            asSent.then(
                (all) => void heardHeaders.push(Object.values(all).join('\n')),
                () => undefined,
            ),
        );
    });
    return {
        /** Call before the page navigates: a socket opened earlier goes unseen. */
        watchSockets(page: Page) {
            page.on('websocket', (ws) => {
                sockets += 1;
                urls.push(ws.url());
                const hear = (frame: { payload: string | Buffer }) =>
                    frames.push(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('latin1'));
                ws.on('framesent', hear);
                ws.on('framereceived', hear);
            });
        },
        frames: () => frames,
        sockets: () => sockets,
        urls: () => urls,
        /** Everything this context said to or heard from a server, as one string. */
        async everything(): Promise<string> {
            await Promise.all(headers);
            return [...urls, ...bodies, ...heardHeaders, ...frames].join('\n');
        },
        /** Whether a join-room reached the wire, by polling or by the socket. */
        joined: () => [...bodies, ...frames].some((text) => text.includes('join-room')),
    };
}

/** What the page keeps in the browser, as text, with the count of stored responses. */
function storedByPage(page: Page, secret: string) {
    return page.evaluate(async (needle) => {
        const hits: string[] = [];
        let entries = 0;
        for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            for (const request of await cache.keys()) {
                entries += 1;
                if (request.url.includes(needle)) hits.push(`cache url in ${name}`);
                const response = await cache.match(request);
                if (response && (await response.text()).includes(needle)) hits.push(`cache body in ${name}`);
            }
        }
        for (const store of [localStorage, sessionStorage]) {
            for (let i = 0; i < store.length; i += 1) {
                const key = store.key(i) as string;
                if (key.includes(needle) || (store.getItem(key) ?? '').includes(needle)) hits.push('web storage');
            }
        }
        if (document.cookie.includes(needle)) hits.push('cookie');
        return { entries, hits };
    }, secret);
}

// ---------------------------------------------------------------------------
// A scripted peer: a page of the test's own, with simple-peer and Socket.IO
// ---------------------------------------------------------------------------

async function scriptedPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
    const ctx = await browser.newContext();
    // See peer-error-text.spec.ts: a routed document counts as a public one, which
    // Chromium refuses Socket.IO polling to localhost:3001 without this.
    await ctx.grantPermissions(['local-network-access'], { origin: WEB_URL });
    const page = await ctx.newPage();
    await page.route(PEER_URL, (route) => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>scripted peer</title>',
    }));
    await page.goto(PEER_URL);
    await page.addScriptTag({ path: requireFromClient.resolve('socket.io-client/dist/socket.io.js') });
    await page.addScriptTag({ path: requireFromClient.resolve('simple-peer/simplepeer.min.js') });
    await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const encoder = new TextEncoder();
        const decode64 = (text: string) =>
            Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        const encode64 = (bytes: Uint8Array) =>
            btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const fromHex = (text: string) =>
            Uint8Array.from((text.replace(/:/g, '').match(/../g) as string[]).map((h) => parseInt(h, 16)));
        // The wire spec, written again with nothing of the app's: HMAC-SHA256(k,
        // "floe-kc-v1" || 0x00 || role || len(room) || room || hS || hR).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        w.proof = async (peer: any, self: 'sender' | 'receiver', whose: 'sender' | 'receiver', room: string, key: string): Promise<string> => {
            const local = fromHex((/a=fingerprint:sha-256 (\S+)/i.exec(peer._pc.localDescription.sdp) as string[])[1]);
            const der = peer._pc.sctp.transport.getRemoteCertificates()[0];
            const remote = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
            const [hS, hR] = self === 'sender' ? [local, remote] : [remote, local];
            const roomBytes = encoder.encode(room);
            const message = new Uint8Array([
                ...encoder.encode('floe-kc-v1'),
                0,
                whose === 'sender' ? 0x73 : 0x72,
                roomBytes.length,
                ...roomBytes,
                ...hS,
                ...hR,
            ]);
            const hmac = await crypto.subtle.importKey('raw', decode64(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            return encode64(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, message)));
        };
        // One entry per frame this side heard: a control frame as an object, file
        // data as its length.
        w.heard = (raw: string | Uint8Array): unknown => {
            const text = typeof raw === 'string' ? raw : raw.byteLength <= 1000 ? new TextDecoder().decode(raw) : null;
            if (text !== null) {
                try {
                    return JSON.parse(text);
                } catch { /* file data */ }
            }
            return { type: 'file-data', bytes: typeof raw === 'string' ? raw.length : raw.byteLength };
        };
    });
    return { page, close: () => ctx.close() };
}

interface ScriptedFrame {
    type?: string;
    code?: string;
    pv?: number;
    pvMin?: number;
    saved?: number;
    tag?: string;
    id?: string;
    bytes?: number;
}

interface ScriptedState {
    frames: ScriptedFrame[];
    closed: boolean;
    pageProofGood: boolean | null;
}

const scriptedState = (page: Page): Promise<ScriptedState> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.evaluate(() => (window as any).scripted);

/**
 * A file receiver that takes the second seat of the page's room.
 *
 * proof: good (holds the key), bad (an honest proof under another key), none (a
 * released peer, which has no kc to send). then: what it does once connected.
 */
async function scriptedReceiver(
    page: Page,
    o: { room: string; key: string; proof: 'good' | 'bad' | 'none'; then: 'ack' | 'close' | 'refuse' | 'hold' },
): Promise<void> {
    await page.evaluate(({ room, key, proof, then, wrong, serverUrl }) => new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const state: ScriptedState = { frames: [], closed: false, pageProofGood: null };
        w.scripted = state;
        const socket = w.io(serverUrl);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let p: any = null;
        const say = (frame: object) => p.send(new TextEncoder().encode(JSON.stringify(frame)));
        // Its proof goes once and ahead of anything else it says, as a real receiver's
        // does, at the first frame or at the connect, whichever is first.
        let proofOut: Promise<void> | null = null;
        const sendProof = (): Promise<void> => {
            if (!proofOut) {
                proofOut = proof === 'none'
                    ? Promise.resolve()
                    : w.proof(p, 'receiver', 'receiver', room, proof === 'good' ? key : wrong).then((tag: string) => {
                        say({ type: 'kc', tag });
                    });
            }
            return proofOut as Promise<void>;
        };
        socket.on('connect', () => socket.emit('join-room', room));
        socket.on('room-joined', () => resolve());
        socket.on('room-full', () => reject(new Error('room-full')));
        socket.on('signal', (d: { sender: string; signal: unknown }) => {
            if (!p) {
                p = new w.SimplePeer({ initiator: false, trickle: true, readableObjectMode: true, config: { iceServers: [] } });
                p.on('signal', (signal: unknown) => socket.emit('signal', { target: d.sender, roomId: room, signal }));
                p.on('error', () => {});
                p.on('close', () => { state.closed = true; });
                p.on('data', (raw: string | Uint8Array) => {
                    const frame = w.heard(raw);
                    state.frames.push(frame);
                    if (frame.type === 'kc') {
                        void w.proof(p, 'receiver', 'sender', room, key).then((want: string) => {
                            state.pageProofGood = frame.tag === want;
                        });
                    }
                    void sendProof().then(() => {
                        if (then === 'ack' && frame.type === 'metadata') {
                            say({ type: 'ack', id: frame.id, offset: 0, pv: 2, pvMin: 1, confirms: true });
                        }
                        if (then === 'ack' && frame.type === 'end') {
                            say({ type: 'received', verified: 1 });
                        }
                    });
                });
                p.on('connect', () => {
                    void sendProof().then(() => {
                        // A destroy right behind the send would take the frame with it,
                        // and well inside the 2 s a relay-off page waits to start.
                        if (then === 'close') setTimeout(() => p.destroy(), 400);
                        if (then === 'refuse') {
                            say({ type: 'incompatible', reason: 'FLOEPEERTEXT Open evil.example', pv: 2, pvMin: 2, code: 'unverified' });
                        }
                    });
                });
            }
            p.signal(d.signal);
        });
    }), { ...o, wrong: newKey(), serverUrl: SERVER_URL });
}

interface TurningState {
    bytes: number;
    closed: boolean;
}

const readsThenTurnsState = (page: Page): Promise<TurningState> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.evaluate(() => (window as any).scripted);

/**
 * A file receiver that sends no proof at first, acks the first metadata, reads `after`
 * bytes of the file and only then turns: a proof under another key and a close, or a
 * refusal in the key's code, with words the page must not show.
 */
async function readsThenTurns(
    page: Page,
    o: { room: string; key: string; after: number; turn: 'bad-proof-then-close' | 'refuse' },
): Promise<void> {
    await page.evaluate(({ room, after, turn, wrong, serverUrl }) => new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const state: TurningState = { bytes: 0, closed: false };
        w.scripted = state;
        const socket = w.io(serverUrl);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let p: any = null;
        let turned = false;
        const say = (frame: object) => p.send(new TextEncoder().encode(JSON.stringify(frame)));
        socket.on('connect', () => socket.emit('join-room', room));
        socket.on('room-joined', () => resolve());
        socket.on('room-full', () => reject(new Error('room-full')));
        socket.on('signal', (d: { sender: string; signal: unknown }) => {
            if (!p) {
                p = new w.SimplePeer({ initiator: false, trickle: true, readableObjectMode: true, config: { iceServers: [] } });
                p.on('signal', (signal: unknown) => socket.emit('signal', { target: d.sender, roomId: room, signal }));
                p.on('error', () => {});
                p.on('close', () => { state.closed = true; });
                p.on('data', (raw: string | Uint8Array) => {
                    if (typeof raw === 'string') {
                        const frame = JSON.parse(raw);
                        if (frame.type === 'metadata') say({ type: 'ack', id: frame.id, offset: 0, pv: 2, pvMin: 1, confirms: true });
                        return;
                    }
                    state.bytes += raw.byteLength;
                    if (turned || state.bytes < after) return;
                    turned = true;
                    if (turn === 'refuse') {
                        say({ type: 'incompatible', reason: 'FLOEPEERTEXT Open evil.example', pv: 2, pvMin: 2, code: 'unverified', saved: 0 });
                        return;
                    }
                    void w.proof(p, 'receiver', 'receiver', room, wrong).then((tag: string) => {
                        say({ type: 'kc', tag });
                        setTimeout(() => p.destroy(), 50);
                    });
                });
            }
            p.signal(d.signal);
        });
    }), { ...o, wrong: newKey(), serverUrl: SERVER_URL });
}

/** Whether clicking the wordmark raises the leave prompt, which is the page holding the
 *  tab. It navigates away otherwise, so this is a test's last question to its page. */
async function wordmarkAsks(page: Page): Promise<boolean> {
    let asked = false;
    const onDialog = (dialog: import('@playwright/test').Dialog) => {
        if (dialog.type() === 'beforeunload') asked = true;
        void dialog.dismiss();
    };
    page.on('dialog', onDialog);
    try {
        await page.getByRole('button', { name: 'Floe home' }).click({ noWaitAfter: true });
        await page.waitForTimeout(1_500);
    } finally {
        page.off('dialog', onDialog);
    }
    return asked;
}

/**
 * A file sender that takes the first seat, with one small file to give.
 *
 * proof: good, bad or none, as above. noise: signals to send the page ahead of the
 * real offer, and one more offer after the connection is up. silent: a connection with
 * nothing on it, which is what a middle that kept the file for itself leaves this page.
 */
async function scriptedSender(
    page: Page,
    o: { room: string; key: string; proof: 'good' | 'bad' | 'none'; noise?: boolean; binaryFirst?: boolean; silent?: boolean },
): Promise<void> {
    await page.evaluate(({ room, key, proof, noise, binaryFirst, silent, wrong, serverUrl }) => new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const state: ScriptedState = { frames: [], closed: false, pageProofGood: null };
        w.scripted = state;
        const FILE = new TextEncoder().encode('the bytes of a small scripted file');
        const socket = w.io(serverUrl);
        socket.on('connect', () => socket.emit('join-room', room));
        socket.on('room-joined', () => resolve());
        socket.on('room-full', () => reject(new Error('room-full')));
        socket.on('user-connected', (userId: string) => {
            const p = new w.SimplePeer({ initiator: true, trickle: true, readableObjectMode: true, config: { iceServers: [] } });
            const signal = (s: unknown) => socket.emit('signal', { target: userId, roomId: room, signal: s });
            let offer: unknown = null;
            let noiseDone = !noise;
            p.on('signal', (s: { type?: string }) => {
                if (s.type === 'offer') offer = s;
                if (!noiseDone) {
                    noiseDone = true;
                    // None of these may reach simple-peer: a signal with no field it
                    // knows destroys the peer, and an answer to nothing fails it.
                    signal({ junk: 1 });
                    signal({ renegotiate: true });
                    signal({ type: 'transceiverRequest', transceiverRequest: { kind: 'video' } });
                    signal({ type: 'answer', sdp: 'v=0\r\n' });
                }
                signal(s);
            });
            socket.on('signal', (d: { signal: unknown }) => p.signal(d.signal));
            p.on('error', () => {});
            p.on('close', () => { state.closed = true; });
            p.on('data', (raw: string | Uint8Array) => {
                const frame = w.heard(raw);
                state.frames.push(frame);
                if (frame.type === 'kc') {
                    void w.proof(p, 'sender', 'receiver', room, key).then((want: string) => {
                        state.pageProofGood = frame.tag === want;
                    });
                }
                if (frame.type === 'ack') {
                    p.send(FILE);
                    p.send(JSON.stringify({ type: 'end' }));
                }
            });
            p.on('connect', async () => {
                if (silent) return;
                if (noise) signal(offer);
                if (binaryFirst) p.send(FILE);
                if (proof !== 'none') {
                    p.send(JSON.stringify({ type: 'kc', tag: await w.proof(p, 'sender', 'sender', room, proof === 'good' ? key : wrong) }));
                }
                p.send(JSON.stringify({
                    type: 'metadata',
                    id: 'scripted',
                    fileName: 'scripted.bin',
                    fileSize: FILE.byteLength,
                    index: 1,
                    total: 1,
                    totalBytes: FILE.byteLength,
                    pv: 2,
                    pvMin: 1,
                }));
            });
        });
    }), { noise: false, binaryFirst: false, silent: false, ...o, wrong: newKey(), serverUrl: SERVER_URL });
}

// The two rollback levers (protocol.ts) are a one-line deploy for a production problem.
// With either off, the cells below describe another product, so they stand aside and
// the lever's own cells wake up: a flip must not have to fight this file to merge.
const LEVERS_ON = MAKE_LINK_KEYS && ENFORCE_LINK_KEYS;
const LEVER_CELLS = 'with a rollback lever off';

test.beforeEach(({}, testInfo) => {
    testInfo.skip(!LEVERS_ON && !testInfo.titlePath.includes(LEVER_CELLS), 'a rollback lever is off');
});

// ---------------------------------------------------------------------------
// Two real pages
// ---------------------------------------------------------------------------

test.describe('a link the web app makes', () => {
    test('carries a key, and the file arrives checked, with nothing new on either page', async ({ browser }, testInfo) => {
        const fixture = createFixture(testInfo.outputDir, 3 * 1024 * 1024);
        const senderCtx = await browser.newContext();
        const receiverCtx = await optedOut(await browser.newContext());
        await watchChannel(senderCtx);
        await watchChannel(receiverCtx);
        const sender = await senderCtx.newPage();
        const receiver = await receiverCtx.newPage();
        try {
            const link = await browserSenderSetup(sender, fixture.path);
            expect(link).toMatch(KEYED_SHARE_LINK);

            await receiver.goto(link);
            const download = receiver.locator('a[download]').first();
            await expect(download).toBeVisible({ timeout: 30_000 });
            expect(await sha256OfBlobUrl(receiver, (await download.getAttribute('href')) as string)).toBe(fixture.sha256);
            await expect(sender.getByText('All Files Sent!')).toBeVisible({ timeout: 30_000 });
            await expect(receiver.locator('[data-mark="verified"]')).toBeVisible({ timeout: 15_000 });

            // On success the person sees nothing new.
            for (const page of [sender, receiver]) {
                await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
                await expect(page.getByRole('heading', { name: INVALID_CARD })).toHaveCount(0);
            }

            // Each side's own proof leads everything it sends on this connection.
            const fromSender = await channelSent(sender);
            const fromReceiver = await channelSent(receiver);
            expect(fromSender[0]).toBe('kc');
            expect(fromSender[1]).toBe('metadata');
            expect(fromSender.filter((frame) => frame === 'kc')).toHaveLength(1);
            expect(fromReceiver[0]).toBe('kc');
            expect(fromReceiver.filter((frame) => frame === 'kc')).toHaveLength(1);
            expect(fromReceiver).toContain('ack');
            expect(fromReceiver).toContain('received');
        } finally {
            await senderCtx.close();
            await receiverCtx.close();
        }
    });

    // The documented gap (DV1), pinned so it stays a choice: a receiver with no key
    // sends nothing new and ignores the kc, and a detect-mode sender goes on.
    test('still reaches a page opened with no key, which checks nothing', async ({ browser }, testInfo) => {
        test.skip(ENFORCE_SHARE_LINK_KEY, 'a sender refuses such a page from the cutover on');
        const fixture = createFixture(testInfo.outputDir, 256 * 1024);
        const senderCtx = await browser.newContext();
        const receiverCtx = await optedOut(await browser.newContext());
        await watchChannel(receiverCtx);
        const sender = await senderCtx.newPage();
        const receiver = await receiverCtx.newPage();
        try {
            const link = await browserSenderSetup(sender, fixture.path);
            await receiver.goto(link.replace(/#.*/, `#room=${roomOfShareLink(link)}`));
            const download = receiver.locator('a[download]').first();
            await expect(download).toBeVisible({ timeout: 30_000 });
            expect(await sha256OfBlobUrl(receiver, (await download.getAttribute('href')) as string)).toBe(fixture.sha256);
            expect(await channelSent(receiver)).not.toContain('kc');
            await expect(sender.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
        } finally {
            await senderCtx.close();
            await receiverCtx.close();
        }
    });
});

for (const relayFallback of [true, false]) {
    // With relay fallback off the send starts 2 s after the connection, the same 2 s
    // a refusing browser waits before it closes, so the close can beat the send.
    test(`a tampered key ends on both pages, with no download and no file byte sent (relay fallback ${relayFallback ? 'on' : 'off'})`, async ({ browser }, testInfo) => {
        const fixture = createFixture(testInfo.outputDir, 2 * 1024 * 1024);
        const senderCtx = await browser.newContext();
        const receiverCtx = await optedOut(await browser.newContext());
        await watchChannel(senderCtx);
        await watchChannel(receiverCtx);
        const sender = await senderCtx.newPage();
        const receiver = await receiverCtx.newPage();
        const errors: string[] = [];
        for (const page of [sender, receiver]) page.on('pageerror', (e) => errors.push(e.name));
        try {
            const link = await browserSenderSetup(sender, fixture.path, { relayFallback });
            let tampered = newKey();
            while (tampered === keyOfShareLink(link)) tampered = newKey();
            await receiver.goto(withKey(link, tampered));

            await expect(receiver.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(receiver.locator('a[download]')).toHaveCount(0);

            const senderLine = sender
                .getByText(KEY_FAILED_SENDER, { exact: true })
                .or(sender.getByText(KEY_REFUSED_SENDER, { exact: true }));
            await expect(senderLine).toBeVisible({ timeout: 30_000 });
            await expect(sender.getByText('Transfer failed', { exact: true })).toBeVisible();
            await expect(sender.getByText('Connection lost', { exact: false })).toHaveCount(0);

            // A moment later neither page has talked over it, and the frames are in.
            await sender.waitForTimeout(3_000);
            await expect(receiver.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible();
            await expect(senderLine).toBeVisible();
            await expect(receiver.locator('a[download]')).toHaveCount(0);

            const fromSender = await channelSent(sender);
            expect(fromSender[0]).toBe('kc');
            // File bytes are binary on this path, and a sender's control is text.
            expect(fromSender.filter((frame) => frame.startsWith('binary:'))).toEqual([]);
            expect(fromSender).not.toContain('end');

            const fromReceiver = await channelSent(receiver);
            expect(fromReceiver[0]).toBe('kc');
            expect(fromReceiver).toContain('incompatible');
            expect(fromReceiver).not.toContain('ack');
            expect(errors, 'an uncaught error on either page').toEqual([]);
        } finally {
            await senderCtx.close();
            await receiverCtx.close();
        }
    });
}

test('a receiving page refused by the check lets go of the tab while the sender is still there', async ({ browser }, testInfo) => {
    const fixture = createFixture(testInfo.outputDir, 256 * 1024);
    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOut(await browser.newContext());
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();
    try {
        const link = await browserSenderSetup(sender, fixture.path);
        let tampered = newKey();
        while (tampered === keyOfShareLink(link)) tampered = newKey();
        await receiver.goto(withKey(link, tampered));
        await expect(receiver.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible({ timeout: 30_000 });
        expect(await wordmarkAsks(receiver), 'the receiving page still holds the tab').toBe(false);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

// ---------------------------------------------------------------------------
// A link cut or damaged
// ---------------------------------------------------------------------------

test.describe('a link that was cut or damaged', () => {
    const ROOM = '6f207790-92a6-4662-bb68-4c4059f75139';
    const cuts: Array<[string, string]> = [
        ['k alone', `/#k=${SOME_KEY}`],
        ['k cut at the &', `/#k=${SOME_KEY}&`],
        ['the & sent as an HTML entity', `/#k=${SOME_KEY}&amp;room=${ROOM}`],
        ['a malformed k', `/?s=x#k=bad&room=${ROOM}`],
        ['a k with a non-canonical last character', `/#k=AAECAwQFBgcICQoLDA0ODB&room=${ROOM}`],
        ['two keys', `/#k=${SOME_KEY}&k=${SOME_KEY}&room=${ROOM}`],
        ['k with its room only in the query', `/?room=${ROOM}#k=${SOME_KEY}`],
        ['a room cut to nothing', '/#room='],
        ['a room cut short', `/#room=${ROOM.slice(0, 20)}`],
        ['a web link with its whole fragment lost', '/?s=abc'],
        ['a k in another letter case', `/#K=${SOME_KEY}&room=${ROOM}`],
        ['a k moved into the query', `/?k=${SOME_KEY}&room=${ROOM}`],
        ['the fragment percent-encoded whole', `/#k%3D${SOME_KEY}%26room%3D${ROOM}`],
    ];

    for (const [name, path] of cuts) {
        test(`${name}: Link Invalid, and no join`, async ({ context, page }) => {
            const traffic = watchTraffic(context);
            traffic.watchSockets(page);
            await page.goto(path);

            await expect(page.getByRole('heading', { name: INVALID_CARD })).toBeVisible();
            await expect(page.getByRole('alert').filter({ hasText: INVALID_CARD })).toContainText(CARD_WORDS);
            // Neither of the two things this page used to open instead: a link that was
            // cut is a receiving page with nothing to receive, never a sending page.
            await expect(page.locator('main').getByText('Receive', { exact: true })).toBeVisible();
            await expect(page.getByText('Drop files or click to browse')).toHaveCount(0);
            await expect(page.getByText('Secure room joined')).toHaveCount(0);

            // The socket does connect on this page, so the wait below is for something.
            await expect.poll(() => traffic.urls().some((url) => url.includes('/socket.io/')), { timeout: 15_000 }).toBe(true);
            await page.waitForTimeout(1_500);
            expect(traffic.joined(), 'a join-room frame').toBe(false);
        });
    }

    // Guards against over-rejection, and proves the watcher above can see a join.
    test('the same page with a whole link joins, and the watcher hears it', async ({ context, page }) => {
        const traffic = watchTraffic(context);
        traffic.watchSockets(page);
        const room = randomUUID();
        await page.goto(`/#k=${SOME_KEY}&room=${room}`);
        await expect(page.getByText('Secure room joined')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('heading', { name: INVALID_CARD })).toHaveCount(0);
        await expect.poll(() => traffic.joined(), { timeout: 15_000 }).toBe(true);
    });

    test('a parameter in any order and an unknown one change nothing', async ({ page }) => {
        await page.goto(`/#x=1&room=${randomUUID()}&k=${SOME_KEY}`);
        await expect(page.getByText('Secure room joined')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('heading', { name: INVALID_CARD })).toHaveCount(0);
    });

    test('the sending page keeps its place when the fragment names no link', async ({ page }) => {
        await page.goto('/#about');
        await expect(page.getByText('Drop files or click to browse')).toBeVisible();
        await expect(page.getByRole('heading', { name: INVALID_CARD })).toHaveCount(0);
    });
});

// ---------------------------------------------------------------------------
// A fragment-only navigation
// ---------------------------------------------------------------------------

test.describe('another link in the same tab', () => {
    // No sender in the room, so nothing holds the tab and the reload runs at once.
    const openWaiting = async (page: Page, key: string, room: string) => {
        await page.goto(`/#k=${key}&room=${room}`);
        await expect(page.getByText('The sender is not connected')).toBeVisible({ timeout: 15_000 });
    };
    const reloads = (page: Page) => {
        let loads = 0;
        page.on('load', () => { loads += 1; });
        return () => loads;
    };

    test('a key that changed under the same room reloads', async ({ page }) => {
        const room = randomUUID();
        await openWaiting(page, SOME_KEY, room);
        const count = reloads(page);
        await page.evaluate(([k, r]) => { location.hash = `k=${k}&room=${r}`; }, [newKey(), room]);
        await expect.poll(count, { timeout: 10_000 }).toBeGreaterThan(0);
    });

    test('a link that became incomplete reloads, into the card', async ({ page }) => {
        const room = randomUUID();
        await openWaiting(page, SOME_KEY, room);
        const count = reloads(page);
        await page.evaluate((k) => { location.hash = `k=${k}`; }, SOME_KEY);
        await expect.poll(count, { timeout: 10_000 }).toBeGreaterThan(0);
        await expect(page.getByRole('heading', { name: INVALID_CARD })).toBeVisible();
    });

    test('the same room and key in another order reloads nothing', async ({ page }) => {
        const room = randomUUID();
        await openWaiting(page, SOME_KEY, room);
        const count = reloads(page);
        await page.evaluate(([k, r]) => { location.hash = `room=${r}&k=${k}`; }, [SOME_KEY, room]);
        await page.waitForTimeout(1_500);
        expect(count()).toBe(0);
        await expect(page.getByText('The sender is not connected')).toBeVisible();
    });
});

// ---------------------------------------------------------------------------
// The page against a scripted peer
// ---------------------------------------------------------------------------

test.describe('a keyed receiving page', () => {
    const open = async (browser: Browser, peer: Page, proof: 'good' | 'bad' | 'none', extra: { noise?: boolean; binaryFirst?: boolean; silent?: boolean } = {}) => {
        const room = randomUUID();
        const key = newKey();
        await scriptedSender(peer, { room, key, proof, ...extra });
        const ctx = await optedOut(await browser.newContext());
        await watchChannel(ctx);
        // Counted where simple-peer applies a description.
        await ctx.addInitScript(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            w.__remoteDescriptions = 0;
            const real = RTCPeerConnection.prototype.setRemoteDescription;
            RTCPeerConnection.prototype.setRemoteDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
                w.__remoteDescriptions += 1;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (real as any).apply(this, args);
            } as typeof RTCPeerConnection.prototype.setRemoteDescription;
        });
        const page = await ctx.newPage();
        await page.goto(`${WEB_URL}/?s=e2e#k=${key}&room=${room}`);
        return { ctx, page };
    };

    test('takes a file from a sender that proves the key, and proves it back', async ({ browser }) => {
        const peer = await scriptedPage(browser);
        const { ctx, page } = await open(browser, peer.page, 'good');
        try {
            await expect(page.locator('a[download]').first()).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
            // A third implementation of the tag agrees with the page, both ways.
            await expect.poll(async () => (await scriptedState(peer.page)).pageProofGood, { timeout: 10_000 }).toBe(true);
            expect((await channelSent(page))[0]).toBe('kc');
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    for (const proof of ['bad', 'none'] as const) {
        test(`refuses a sender with ${proof === 'bad' ? 'a proof under another key' : 'no proof'}: no ack, no file, and its fixed line`, async ({ browser }) => {
            const peer = await scriptedPage(browser);
            const { ctx, page } = await open(browser, peer.page, proof);
            try {
                await expect(page.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible({ timeout: 30_000 });
                await expect(page.locator('a[download]')).toHaveCount(0);
                await expect(page.getByText('scripted.bin')).toHaveCount(0);

                await expect.poll(async () => (await scriptedState(peer.page)).frames.some((f) => f.type === 'incompatible'), { timeout: 10_000 }).toBe(true);
                const { frames } = await scriptedState(peer.page);
                expect(frames.map((f) => f.type)).not.toContain('ack');
                const refusal = frames.find((f) => f.type === 'incompatible') as ScriptedFrame;
                expect(refusal.code).toBe('unverified');
                expect(refusal.pv).toBe(2);
                expect(refusal.pvMin).toBe(2);
                expect(refusal.saved).toBe(0);
                // And the page lets the connection go once that has had time to leave.
                await expect.poll(async () => (await scriptedState(peer.page)).closed, { timeout: 10_000 }).toBe(true);
                // Its own proof still went first: the sender can tell a refusal from a
                // receiver that holds no key.
                expect(frames[0].type).toBe('kc');
            } finally {
                await ctx.close();
                await peer.close();
            }
        });
    }

    // What a middle leaves a receiver when it took the file from the real sender and
    // keeps quiet: a connection with nothing on it. No frame ever arrives to judge, so
    // this is the page's own clock, the Go receiver's idle clock (final audit report 27 F2).
    test('refuses a sender that connects and says nothing, once the wait is over', async ({ browser }) => {
        test.setTimeout(KEY_RECEIVE_WAIT_MS + 45_000);
        const peer = await scriptedPage(browser);
        const { ctx, page } = await open(browser, peer.page, 'none', { silent: true });
        try {
            await expect(page.getByText('Connected', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText(KEY_FAILED_RECEIVER, { exact: true })).toHaveCount(0);
            await expect(page.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible({ timeout: KEY_RECEIVE_WAIT_MS + 15_000 });
            await expect.poll(async () => (await scriptedState(peer.page)).frames.some((f) => f.type === 'incompatible'), { timeout: 10_000 }).toBe(true);
            const refusal = (await scriptedState(peer.page)).frames.find((f) => f.type === 'incompatible') as ScriptedFrame;
            expect(refusal.code).toBe('unverified');
            await expect.poll(async () => (await scriptedState(peer.page)).closed, { timeout: 10_000 }).toBe(true);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    // A failed check is this page's last word. Whoever runs the server can drop the
    // socket, and a re-join would clear the banner and put the page back on waiting
    // (final audit report 27 F5).
    test('keeps a failed check through a socket that drops and comes back', async ({ browser }) => {
        const peer = await scriptedPage(browser);
        const { ctx, page } = await open(browser, peer.page, 'bad');
        try {
            const banner = page.getByText(KEY_FAILED_RECEIVER, { exact: true });
            await expect(banner).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 10_000 });
            await ctx.setOffline(true);
            await expect(page.getByText('Offline', { exact: true })).toBeVisible({ timeout: 15_000 });
            await ctx.setOffline(false);
            await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15_000 });
            // Long enough for a re-join to have cleared it.
            await page.waitForTimeout(2_000);
            await expect(banner).toBeVisible();
            await expect(page.getByText('Waiting for the sender', { exact: false })).toHaveCount(0);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    test('refuses file data ahead of any proof, and keeps none of it', async ({ browser }) => {
        const peer = await scriptedPage(browser);
        const { ctx, page } = await open(browser, peer.page, 'good', { binaryFirst: true });
        try {
            await expect(page.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(page.locator('a[download]')).toHaveCount(0);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    // The gate between the server and simple-peer. A signal with no field it knows
    // destroys the peer, an answer to nothing fails it, and a second description is
    // what the certificate fallback relies on never seeing.
    test('drops what the server has no business sending it, and the transfer goes on', async ({ browser }) => {
        const peer = await scriptedPage(browser);
        const { ctx, page } = await open(browser, peer.page, 'good', { noise: true });
        try {
            await expect(page.locator('a[download]').first()).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Connection failed', { exact: false })).toHaveCount(0);
            // The offer, once, though two reached the page.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(await page.evaluate(() => (window as any).__remoteDescriptions)).toBe(1);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });
});

test.describe('a sending page', () => {
    const open = async (browser: Browser, testDir: string, opts: { relayFallback?: boolean } = {}) => {
        const fixture = createFixture(testDir, 256 * 1024);
        const ctx = await browser.newContext();
        await watchChannel(ctx);
        const page = await ctx.newPage();
        const link = await browserSenderSetup(page, fixture.path, opts);
        return { ctx, page, link, room: roomOfShareLink(link), key: keyOfShareLink(link) };
    };

    test('sends to a receiver that proves the key, and proves it first', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'good', then: 'ack' });
            await expect(page.getByText('All Files Sent!')).toBeVisible({ timeout: 30_000 });
            await expect.poll(async () => (await scriptedState(peer.page)).pageProofGood, { timeout: 10_000 }).toBe(true);
            const { frames } = await scriptedState(peer.page);
            expect(frames[0].type).toBe('kc');
            expect(frames.some((f) => f.type === 'file-data')).toBe(true);
            await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    // Every web send to a released floe looks like this, so it must keep working and
    // must stay quiet: the sender only detects until the cutover.
    test('sends to a receiver that says nothing, as a released floe does', async ({ browser }, testInfo) => {
        test.skip(ENFORCE_SHARE_LINK_KEY, 'a sender refuses such a receiver from the cutover on');
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'none', then: 'ack' });
            await expect(page.getByText('All Files Sent!')).toBeVisible({ timeout: 30_000 });
            expect((await scriptedState(peer.page)).frames.some((f) => f.type === 'file-data')).toBe(true);
            await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    test('stops at a bad proof that came with an ack: no file byte, one abort, and its fixed line', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'bad', then: 'ack' });
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Transfer failed', { exact: true })).toBeVisible();

            await expect.poll(async () => (await scriptedState(peer.page)).frames.some((f) => f.type === 'incompatible'), { timeout: 10_000 }).toBe(true);
            const { frames } = await scriptedState(peer.page);
            expect(frames.filter((f) => f.type === 'file-data')).toEqual([]);
            expect(frames.filter((f) => f.type === 'incompatible')).toHaveLength(1);
            const abort = frames.find((f) => f.type === 'incompatible') as ScriptedFrame;
            expect(abort.code).toBe('unverified');
            expect(abort.pv).toBe(2);
            expect(abort.pvMin).toBe(2);
            // Nothing follows the abort.
            expect(frames[frames.length - 1].type).toBe('incompatible');
            // And the page closes what the check ended.
            await expect.poll(async () => (await scriptedState(peer.page)).closed, { timeout: 10_000 }).toBe(true);
            expect((await channelSent(page)).filter((frame) => frame.startsWith('binary:'))).toEqual([]);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    test('shows its own line for a refusal, never the words that came with it', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'good', then: 'refuse' });
            await expect(page.getByText(KEY_REFUSED_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('FLOEPEERTEXT', { exact: false })).toHaveCount(0);
            expect((await channelSent(page)).filter((frame) => frame.startsWith('binary:'))).toEqual([]);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    // Nothing else speaks at progress 0: the close handler keeps quiet there, and the
    // error handler blames the connection. Relay fallback off is what makes the close
    // land before the send starts.
    test('is not talked over when the connection goes right after a bad proof', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir, { relayFallback: false });
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'bad', then: 'close' });
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Transfer failed', { exact: true })).toBeVisible();
            await page.waitForTimeout(3_000);
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toBeVisible();
            await expect(page.getByText('Connection lost', { exact: false })).toHaveCount(0);
            expect((await channelSent(page)).filter((frame) => frame.startsWith('binary:'))).toEqual([]);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    test('closes the connection when it is refused, so the other side is not left waiting', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'good', then: 'refuse' });
            await expect(page.getByText(KEY_REFUSED_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect.poll(async () => (await scriptedState(peer.page)).closed, { timeout: 10_000 }).toBe(true);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    test('keeps its account of a failed check when the other side leaves', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'bad', then: 'ack' });
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Transfer failed', { exact: true })).toBeVisible();
            await peer.close();
            await page.waitForTimeout(3_000);
            await expect(page.getByText('Transfer failed', { exact: true })).toBeVisible();
            await expect(page.getByText('Peer disconnected', { exact: false })).toHaveCount(0);
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toBeVisible();
        } finally {
            await ctx.close();
        }
    });

    // A failed check is this page's last word. Whoever runs the server can seat someone
    // else, and a new peer would clear the account of what happened (report 27 F5).
    test('keeps a failed check when someone else takes the seat', async ({ browser }, testInfo) => {
        const first = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(first.page, { room, key, proof: 'bad', then: 'ack' });
            const banner = page.getByText(KEY_FAILED_SENDER, { exact: true });
            await expect(banner).toBeVisible({ timeout: 30_000 });
            await first.close();
            const second = await scriptedPage(browser);
            try {
                await scriptedReceiver(second.page, { room, key, proof: 'good', then: 'ack' });
                // Long enough for a new peer to have offered and cleared it.
                await page.waitForTimeout(3_000);
                await expect(banner).toBeVisible();
                expect((await scriptedState(second.page)).frames).toEqual([]);
            } finally {
                await second.close();
            }
        } finally {
            await ctx.close();
        }
    });

    test('lets go of the tab after a failed check', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'bad', then: 'ack' });
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
            expect(await wordmarkAsks(page), 'the sending page still holds the tab').toBe(false);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    // A hostile receiver acks, reads some of the file, and only then says the check failed.
    // The first byte goes right behind the ack, so "nothing was sent" is false from there,
    // whatever progress says: it reads 0 below half a percent of a file.
    test.describe('once the receiver has answered a file', () => {
        const BIG = 64 * 1024 * 1024;
        const MIB = 1024 * 1024;

        const noneOfThatWords = async (page: Page) => {
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toHaveCount(0);
            await expect(page.getByText(KEY_REFUSED_SENDER, { exact: true })).toHaveCount(0);
            await expect(page.getByText(/nothing was sent/i)).toHaveCount(0);
        };

        const openBig = async (browser: Browser, testDir: string, size: number) => {
            const fixture = createFixture(testDir, size);
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            const link = await browserSenderSetup(page, fixture.path);
            return { ctx, page, room: roomOfShareLink(link), key: keyOfShareLink(link) };
        };

        test('a bad proof after some of the file, then a close: the connection was lost, not nothing sent', async ({ browser }, testInfo) => {
            test.setTimeout(180_000);
            const peer = await scriptedPage(browser);
            const { ctx, page, room, key } = await openBig(browser, testInfo.outputDir, BIG);
            try {
                await readsThenTurns(peer.page, { room, key, after: MIB, turn: 'bad-proof-then-close' });
                await expect.poll(async () => (await readsThenTurnsState(peer.page)).closed, { timeout: 60_000 }).toBe(true);
                expect((await readsThenTurnsState(peer.page)).bytes).toBeGreaterThanOrEqual(MIB);
                // The engine or the close handler, whichever hears it first.
                await expect(page.getByText(/^(Connection lost|The connection closed before the transfer finished|Connection failed)/)).toBeVisible({ timeout: 15_000 });
                await noneOfThatWords(page);
            } finally {
                await ctx.close();
                await peer.close();
            }
        });

        test('a refusal after some of the file: the plain words', async ({ browser }, testInfo) => {
            test.setTimeout(180_000);
            const peer = await scriptedPage(browser);
            const { ctx, page, room, key } = await openBig(browser, testInfo.outputDir, BIG);
            try {
                await readsThenTurns(peer.page, { room, key, after: MIB, turn: 'refuse' });
                await expect(page.getByText(SENDER_REJECTED, { exact: true })).toBeVisible({ timeout: 60_000 });
                await expect(page.getByText('Transfer failed', { exact: true })).toBeVisible();
                await expect(page.getByText('FLOEPEERTEXT', { exact: false })).toHaveCount(0);
                expect((await readsThenTurnsState(peer.page)).bytes).toBeGreaterThanOrEqual(MIB);
                await noneOfThatWords(page);
            } finally {
                await ctx.close();
                await peer.close();
            }
        });

        test('a refusal after the whole of a small file: the plain words', async ({ browser }, testInfo) => {
            const size = 128 * 1024;
            const peer = await scriptedPage(browser);
            const { ctx, page, room, key } = await openBig(browser, testInfo.outputDir, size);
            try {
                await readsThenTurns(peer.page, { room, key, after: size, turn: 'refuse' });
                await expect(page.getByText(SENDER_REJECTED, { exact: true })).toBeVisible({ timeout: 30_000 });
                await expect(page.getByText('Transfer failed', { exact: true })).toBeVisible();
                await noneOfThatWords(page);
            } finally {
                await ctx.close();
                await peer.close();
            }
        });
    });
});

test.describe(LEVER_CELLS, () => {
    test.skip(LEVERS_ON, 'MAKE_LINK_KEYS and ENFORCE_LINK_KEYS are both on');

    test('MAKE_LINK_KEYS off: a new link holds no key, and the file arrives as it did', async ({ browser }, testInfo) => {
        test.skip(MAKE_LINK_KEYS, 'MAKE_LINK_KEYS is on');
        const fixture = createFixture(testInfo.outputDir, 256 * 1024);
        const senderCtx = await browser.newContext();
        const receiverCtx = await optedOut(await browser.newContext());
        await watchChannel(senderCtx);
        await watchChannel(receiverCtx);
        const sender = await senderCtx.newPage();
        const receiver = await receiverCtx.newPage();
        try {
            const link = await browserSenderSetup(sender, fixture.path);
            expect(link).not.toContain('k=');
            expect(link).toContain('#room=');
            await receiver.goto(link);
            const download = receiver.locator('a[download]').first();
            await expect(download).toBeVisible({ timeout: 30_000 });
            expect(await sha256OfBlobUrl(receiver, (await download.getAttribute('href')) as string)).toBe(fixture.sha256);
            expect(await channelSent(sender)).not.toContain('kc');
            expect(await channelSent(receiver)).not.toContain('kc');
        } finally {
            await senderCtx.close();
            await receiverCtx.close();
        }
    });

    test('ENFORCE_LINK_KEYS off: a tampered key stops nothing, and each page still sends its proof', async ({ browser }, testInfo) => {
        test.skip(!MAKE_LINK_KEYS || ENFORCE_LINK_KEYS, 'needs keyed links with ENFORCE_LINK_KEYS off');
        const fixture = createFixture(testInfo.outputDir, 256 * 1024);
        const senderCtx = await browser.newContext();
        const receiverCtx = await optedOut(await browser.newContext());
        await watchChannel(senderCtx);
        await watchChannel(receiverCtx);
        const sender = await senderCtx.newPage();
        const receiver = await receiverCtx.newPage();
        try {
            const link = await browserSenderSetup(sender, fixture.path);
            expect(link).toMatch(KEYED_SHARE_LINK);
            await receiver.goto(withKey(link, newKey()));
            const download = receiver.locator('a[download]').first();
            await expect(download).toBeVisible({ timeout: 30_000 });
            expect(await sha256OfBlobUrl(receiver, (await download.getAttribute('href')) as string)).toBe(fixture.sha256);
            await expect(sender.getByText('All Files Sent!')).toBeVisible({ timeout: 30_000 });
            for (const page of [sender, receiver]) {
                await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
                expect((await channelSent(page))[0]).toBe('kc');
            }
        } finally {
            await senderCtx.close();
            await receiverCtx.close();
        }
    });
});

// The path the cutover turns on, ENFORCE_SHARE_LINK_KEY: a one-line flip, so these wake
// up by themselves with it. Run against the flipped lever for the record of this PR.
test.describe('a sending page after the cutover', () => {
    test.skip(!ENFORCE_SHARE_LINK_KEY, 'ENFORCE_SHARE_LINK_KEY is off until the cutover');

    const open = async (browser: Browser, dir: string) => {
        const fixture = createFixture(dir, 64 * 1024);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const link = await browserSenderSetup(page, fixture.path);
        return { ctx, page, room: roomOfShareLink(link), key: keyOfShareLink(link) };
    };

    test('names no file until the receiver has proved the key', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'good', then: 'ack' });
            await expect(page.getByText('All Files Sent!')).toBeVisible({ timeout: 30_000 });
            const types = (await scriptedState(peer.page)).frames.map((f) => f.type);
            expect(types[0]).toBe('kc');
            expect(types).toContain('metadata');
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    test('refuses a receiver that stays silent, with no file named and the neutral line', async ({ browser }, testInfo) => {
        test.setTimeout(KEY_CHECK_WAIT_MS + 60_000);
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'none', then: 'hold' });
            await expect(page.getByText(KEY_SILENT_SENDER, { exact: true })).toBeVisible({ timeout: KEY_CHECK_WAIT_MS + 15_000 });
            await expect(page.getByText('Transfer failed', { exact: true })).toBeVisible();
            await expect.poll(async () => (await scriptedState(peer.page)).frames.some((f) => f.type === 'incompatible'), { timeout: 10_000 }).toBe(true);
            const { frames } = await scriptedState(peer.page);
            expect(frames.map((f) => f.type)).toEqual(['kc', 'incompatible']);
            const abort = frames[1];
            expect(abort.code).toBe('unverified');
            expect(abort.pv).toBe(2);
            expect(abort.pvMin).toBe(2);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    test('refuses a bad proof at once, with no file named', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'bad', then: 'hold' });
            await expect(page.getByText(KEY_FAILED_SENDER, { exact: true })).toBeVisible({ timeout: 15_000 });
            await expect.poll(async () => (await scriptedState(peer.page)).frames.some((f) => f.type === 'incompatible'), { timeout: 10_000 }).toBe(true);
            expect((await scriptedState(peer.page)).frames.map((f) => f.type)).toEqual(['kc', 'incompatible']);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });

    // The channel closing in the wait gets the ack wait's words, and the page's own
    // guard is what keeps those words off a teardown of its own (sender.ts).
    test('says the connection was lost when the channel closes in the wait', async ({ browser }, testInfo) => {
        const peer = await scriptedPage(browser);
        const { ctx, page, room, key } = await open(browser, testInfo.outputDir);
        try {
            await scriptedReceiver(peer.page, { room, key, proof: 'none', then: 'close' });
            await expect(page.getByText('Connection lost. The other device may have closed the tab.', { exact: true })).toBeVisible({ timeout: 15_000 });
            await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
        } finally {
            await ctx.close();
            await peer.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Where the key may not go
// ---------------------------------------------------------------------------

test('the key is in no request, no socket frame and nothing the browser stores', async ({ browser }, testInfo) => {
    const fixture = createFixture(testInfo.outputDir, 512 * 1024);
    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOut(await browser.newContext());
    const fromSender = watchTraffic(senderCtx);
    const fromReceiver = watchTraffic(receiverCtx);
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();
    fromSender.watchSockets(sender);
    fromReceiver.watchSockets(receiver);
    try {
        const link = await browserSenderSetup(sender, fixture.path);
        const key = keyOfShareLink(link);
        const room = roomOfShareLink(link);

        // The receiver opens the link from a page its worker already controls. In a fresh
        // context no worker is in the way, so its navigate guard never comes into play and
        // this store could not show the leak this test names. A production build only, and
        // Chromium only: Playwright's Firefox never shows a controller.
        if (process.env.CI) {
            await receiver.goto(WEB_URL);
            await receiver.evaluate(() => navigator.serviceWorker.ready);
            await expect
                .poll(() => receiver.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 })
                .toBe(true);
            await receiver.goto('about:blank');
        }
        await receiver.goto(link);
        const download = receiver.locator('a[download]').first();
        await expect(download).toBeVisible({ timeout: 30_000 });
        await expect(sender.getByText('All Files Sent!')).toBeVisible({ timeout: 30_000 });

        // Not vacuous: the key is on both pages, and the watchers see the room, which
        // does go to the signaling server, in what they heard.
        await expect(sender.locator('code').filter({ hasText: SHARE_LINK_TEXT })).toContainText(key);
        expect(await receiver.evaluate(() => location.hash)).toContain(key);
        expect(await fromSender.everything()).toContain(room);
        expect(await fromReceiver.everything()).toContain(room);
        expect(fromSender.sockets() + fromReceiver.sockets()).toBeGreaterThan(0);

        expect(await fromSender.everything(), 'the sender page told a server the key').not.toContain(key);
        expect(await fromReceiver.everything(), 'the receiver page told a server the key').not.toContain(key);

        for (const page of [sender, receiver]) {
            // A production build has a worker and a store, filled once it has installed;
            // next dev has neither, and the check then reads web storage alone.
            if (process.env.CI) {
                await expect
                    .poll(async () => (await storedByPage(page, key)).entries, { timeout: 30_000 })
                    .toBeGreaterThan(0);
            }
            const stored = await storedByPage(page, key);
            expect(stored.hits, 'the key in browser storage').toEqual([]);
            test.info().annotations.push({ type: 'cache-storage', description: `${stored.entries} stored responses read` });
        }
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

// ---------------------------------------------------------------------------
// A browser that cannot read the certificate
// ---------------------------------------------------------------------------

test('the SDP fallback carries a whole transfer where the certificate API is missing', async ({ browser }, testInfo) => {
    const fixture = createFixture(testInfo.outputDir, 512 * 1024);
    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOut(await browser.newContext());
    for (const ctx of [senderCtx, receiverCtx]) {
        await ctx.addInitScript(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (RTCDtlsTransport.prototype as any).getRemoteCertificates;
        });
    }
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();
    try {
        const link = await browserSenderSetup(sender, fixture.path);
        expect(link).toMatch(KEYED_SHARE_LINK);
        await receiver.goto(link);
        for (const page of [sender, receiver]) {
            // The API really is gone on the page that ran the check.
            expect(await page.evaluate(() => typeof RTCDtlsTransport.prototype.getRemoteCertificates)).toBe('undefined');
        }
        const download = receiver.locator('a[download]').first();
        await expect(download).toBeVisible({ timeout: 30_000 });
        expect(await sha256OfBlobUrl(receiver, (await download.getAttribute('href')) as string)).toBe(fixture.sha256);
        for (const page of [sender, receiver]) {
            await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
        }
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

// A browser that truly cannot check: the API is gone and the description fails the
// fallback's strict shape, since a second m= line is the trick that shape is there
// to refuse. It says so, never claims the other side failed, and moves no file.
const cannotCheck = (ctx: BrowserContext) =>
    ctx.addInitScript(() => {
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

test('a receiving page that cannot read the certificates says so and receives nothing', async ({ browser }, testInfo) => {
    const fixture = createFixture(testInfo.outputDir, 256 * 1024);
    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOut(await browser.newContext());
    await cannotCheck(receiverCtx);
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();
    try {
        const link = await browserSenderSetup(sender, fixture.path);
        await receiver.goto(link);
        await expect(receiver.getByText(KEY_UNAVAILABLE_RECEIVER, { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(receiver.locator('a[download]')).toHaveCount(0);
        // The sender hears a refusal, and no file goes.
        await expect(sender.getByText(KEY_REFUSED_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('a sending page that cannot read the certificates sends no proof, and is told so when the receiver refuses', async ({ browser }, testInfo) => {
    const fixture = createFixture(testInfo.outputDir, 256 * 1024);
    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOut(await browser.newContext());
    await cannotCheck(senderCtx);
    await watchChannel(senderCtx);
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();
    try {
        const link = await browserSenderSetup(sender, fixture.path);
        await receiver.goto(link);
        await expect(sender.getByText(KEY_UNAVAILABLE_SENDER, { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(receiver.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(receiver.locator('a[download]')).toHaveCount(0);
        const sent = await channelSent(sender);
        expect(sent).not.toContain('kc');
        expect(sent.filter((frame) => frame.startsWith('binary:'))).toEqual([]);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

// ---------------------------------------------------------------------------
// The QR code
// ---------------------------------------------------------------------------

test('the QR code of the longer link still renders at level M and 156 px', async ({ browser }, testInfo) => {
    const fixture = createFixture(testInfo.outputDir, 1024);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
        const link = await browserSenderSetup(page, fixture.path);
        expect(link).toMatch(KEYED_SHARE_LINK);
        await page.getByRole('button', { name: 'Show QR' }).click();
        await expect(page.getByText('Scan to receive files')).toBeVisible();
        const qr = page.locator('svg[width="156"]');
        const { width, height } = (await qr.boundingBox()) as { width: number; height: number };
        expect(width).toBe(156);
        expect(height).toBe(156);

        // A QR version is its size, and the level is in which version a length needs.
        // At level M version 5 holds 84 bytes and version 6 holds 106, 41 modules a
        // side, where level L would still fit this link in version 5, at 37.
        expect(link.length).toBeGreaterThan(84);
        expect(link.length).toBeLessThanOrEqual(106);
        expect(await qr.getAttribute('viewBox')).toBe('0 0 41 41');
        // Left for a person, or a QR reader, to look at: the phone scan is the owner's.
        await qr.screenshot({ path: testInfo.outputPath('qr.png') });
    } finally {
        await ctx.close();
    }
});

// ---------------------------------------------------------------------------
// Across engines: local only, FLOE_E2E_FIREFOX=1
// ---------------------------------------------------------------------------

test.describe('across engines', () => {
    test.skip(!process.env.FLOE_E2E_FIREFOX, 'set FLOE_E2E_FIREFOX=1 to run the Firefox cells (no CI leg does)');

    let chrome: Browser;
    let gecko: Browser;

    test.beforeAll(async () => {
        // The config's project settings do not reach these. Real host addresses on
        // both, as the certificate capture ran: one engine cannot resolve the other's
        // mDNS names on every machine.
        chrome = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
        gecko = await firefox.launch({
            firefoxUserPrefs: {
                'media.peerconnection.ice.obfuscate_host_addresses': false,
                'media.peerconnection.ice.proxy_only_if_behind_proxy': false,
            },
        });
    });

    test.afterAll(async () => {
        await chrome?.close();
        await gecko?.close();
    });

    const webToWeb = async (from: Browser, to: Browser, dir: string) => {
        const fixture = createFixture(dir, 3 * 1024 * 1024);
        const senderCtx = await from.newContext({ baseURL: WEB_URL });
        const receiverCtx = await optedOut(await to.newContext({ baseURL: WEB_URL }));
        const sender = await senderCtx.newPage();
        const receiver = await receiverCtx.newPage();
        try {
            const link = await browserSenderSetup(sender, fixture.path);
            expect(link).toMatch(KEYED_SHARE_LINK);
            await receiver.goto(link);
            const download = receiver.locator('a[download]').first();
            await expect(download).toBeVisible({ timeout: 60_000 });
            expect(await sha256OfBlobUrl(receiver, (await download.getAttribute('href')) as string)).toBe(fixture.sha256);
            for (const page of [sender, receiver]) {
                await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
            }
        } finally {
            await senderCtx.close();
            await receiverCtx.close();
        }
    };

    // ({}, testInfo) is the shape Playwright requires: these cells launch their own browsers.
    test('Chromium to Firefox', async ({}, testInfo) => webToWeb(chrome, gecko, testInfo.outputDir));
    test('Firefox to Chromium', async ({}, testInfo) => webToWeb(gecko, chrome, testInfo.outputDir));

    test('a tampered key ends on Firefox too, with no file', async ({}, testInfo) => {
        const fixture = createFixture(testInfo.outputDir, 256 * 1024);
        const senderCtx = await chrome.newContext({ baseURL: WEB_URL });
        const receiverCtx = await optedOut(await gecko.newContext({ baseURL: WEB_URL }));
        const sender = await senderCtx.newPage();
        const receiver = await receiverCtx.newPage();
        try {
            const link = await browserSenderSetup(sender, fixture.path);
            await receiver.goto(withKey(link, newKey()));
            await expect(receiver.getByText(KEY_FAILED_RECEIVER, { exact: true })).toBeVisible({ timeout: 60_000 });
            await expect(receiver.locator('a[download]')).toHaveCount(0);
        } finally {
            await senderCtx.close();
            await receiverCtx.close();
        }
    });

    // The only proof that Go and Gecko agree on the DER (the soak carries no keyed Go
    // traffic, and CI runs Chromium only). HEAD floe prints a keyed link from PR-4 on:
    // this asserts that shape first, because a keyless link would prove nothing here.
    test('HEAD floe to Firefox', async ({}, testInfo) => {
        const fixture = createFixture(testInfo.outputDir, 3 * 1024 * 1024);
        const { linkPromise, proc } = spawnSend(fixture.path);
        const senderOut = collectStdout(proc);
        const receiverCtx = await optedOut(await gecko.newContext({ baseURL: WEB_URL }));
        const receiver = await receiverCtx.newPage();
        try {
            const link = await linkPromise;
            expect(link).toContain('#k=');
            await receiver.goto(link);
            const download = receiver.locator('a[download]').first();
            await expect(download).toBeVisible({ timeout: 60_000 });
            expect(await sha256OfBlobUrl(receiver, (await download.getAttribute('href')) as string)).toBe(fixture.sha256);
            await expect(receiver.locator('[data-mark="verified"]')).toBeVisible({ timeout: 15_000 });
            expect(await waitForExit(proc, CLI_TIMEOUT_MS)).toBe(0);
            await expect.poll(senderOut).toMatch(/Verified\s+SHA-256 matched/);
        } finally {
            await receiverCtx.close();
            proc.kill();
        }
    });
});
