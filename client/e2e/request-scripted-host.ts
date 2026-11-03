/**
 * A request-link host of the test's own: a page with simple-peer and a plain WebSocket to
 * /ws, holding seat 0 with a host token, whose every move is a line of this file.
 *
 * The Go harness (cli/internal/e2ehost) is an honest engine under another key or none. This
 * is for the moves no engine makes: a proof held back past the relay verdict, a refusal
 * ahead of any proof or right behind one, a malformed tag, a host that acks, reads some of
 * the file and only then says the check failed, and signals the server has no business
 * sending. Its proof is computed here with the browser's own crypto.subtle, an
 * implementation the page under test does not use, so a page that agrees with it has not
 * only agreed with itself.
 */

import type { Browser, Page } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { createRequire } from 'module';
import { join } from 'path';
import { WEB_URL } from './helpers';
import { signalingDoor } from './request-helpers';

const requireFromClient = createRequire(join(__dirname, '..', 'package.json'));
const PAGE_URL = `${WEB_URL}/__floe-scripted-host`;

export interface ScriptedHostOptions {
    /** good: holds the key. bad: an honest proof under another key. malformed: a kc frame
     *  whose tag is no tag. none: no kc at all, so a page that waits gets silence. */
    proof: 'good' | 'bad' | 'malformed' | 'none';
    /** Once its proof is out. ack: acks every file and says received after the last.
     *  refuse: refuses with the key's code, in words no page may show. refuse-close: that,
     *  and closes right behind it, as a real host does. close: closes. hold: nothing.
     *  read-then-refuse: acks the first file, reads `after` bytes of it, and only then
     *  refuses, saved 0. */
    then: 'ack' | 'refuse' | 'refuse-close' | 'close' | 'hold' | 'read-then-refuse';
    /** read-then-refuse: how many bytes of file it takes first. */
    after?: number;
    /** The code it refuses with. Defaults to the key's own, unverified. */
    code?: string;
    /** The proof waits for releaseProof(), past the page's relay verdict. */
    holdProof?: boolean;
    /** Signals ahead of the real offer, and one more offer once connected. */
    noise?: boolean;
}

export interface ScriptedHostFrame {
    type?: string;
    code?: string;
    pv?: number;
    pvMin?: number;
    reason?: string;
    fileName?: string;
    fileSize?: number;
    bytes?: number;
}

export interface ScriptedHostState {
    /** Every frame this side heard, in order: a control frame as an object, file data as
     *  its length. */
    frames: ScriptedHostFrame[];
    closed: boolean;
    /** Whether the page's proof checked out under the key, with this side's implementation. */
    pageProofGood: boolean | null;
    /** How many bytes of file data it read. */
    fileBytes: number;
}

export interface ScriptedHost {
    /** The whole link the visitor opens. */
    link: string;
    room: string;
    key: string;
    state(): Promise<ScriptedHostState>;
    releaseProof(): Promise<void>;
    close(): Promise<void>;
}

/** server/hosttoken.js, written again with nothing of the app's. */
function roomFromToken(token: string): string {
    const b = Buffer.from(createHash('sha256').update(`floe-request-room-v1:${token}`).digest().subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const newKey = () => randomBytes(16).toString('base64url');

export async function startScriptedHost(browser: Browser, o: ScriptedHostOptions): Promise<ScriptedHost> {
    const token = randomBytes(32).toString('base64url');
    const room = roomFromToken(token);
    const key = newKey();
    const door = signalingDoor();
    const ctx = await browser.newContext();
    // See peer-error-text.spec.ts: a routed document counts as a public one, which Chromium
    // refuses a connection to this machine without this.
    await ctx.grantPermissions(['local-network-access'], { origin: WEB_URL });
    const page: Page = await ctx.newPage();
    await page.route(PAGE_URL, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>scripted host</title>' }),
    );
    await page.goto(PAGE_URL);
    await page.addScriptTag({ path: requireFromClient.resolve('simple-peer/simplepeer.min.js') });
    await page.evaluate(
        ({ room, key, token, wrong, serverUrl, proof, then, after, code, holdProof, noise }) =>
            new Promise<void>((resolve, reject) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                const state: ScriptedHostState = { frames: [], closed: false, pageProofGood: null, fileBytes: 0 };
                w.scripted = state;
                const encoder = new TextEncoder();
                const decode64 = (text: string) =>
                    Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
                const encode64 = (bytes: Uint8Array) =>
                    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                const fromHex = (text: string) =>
                    Uint8Array.from((text.replace(/:/g, '').match(/../g) as string[]).map((h) => parseInt(h, 16)));
                // The wire spec, written again: HMAC-SHA256(k, "floe-kc-v1" || 0x00 || role ||
                // len(room) || room || hS || hR). This side is the file receiver, so hR is its own.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const proofOf = async (peer: any, whose: 'sender' | 'receiver', underKey: string): Promise<string> => {
                    const local = fromHex((/a=fingerprint:sha-256 (\S+)/i.exec(peer._pc.localDescription.sdp) as string[])[1]);
                    const der = peer._pc.sctp.transport.getRemoteCertificates()[0];
                    const remote = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
                    const roomBytes = encoder.encode(room);
                    const message = new Uint8Array([
                        ...encoder.encode('floe-kc-v1'),
                        0,
                        whose === 'sender' ? 0x73 : 0x72,
                        roomBytes.length,
                        ...roomBytes,
                        ...remote,
                        ...local,
                    ]);
                    const hmac = await crypto.subtle.importKey('raw', decode64(underKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
                    return encode64(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, message)));
                };
                const heard = (raw: string | Uint8Array): ScriptedHostFrame => {
                    const text = typeof raw === 'string' ? raw : null;
                    if (text !== null) {
                        try {
                            return JSON.parse(text);
                        } catch {
                            // Text that is not a frame: kept as its length.
                        }
                    }
                    return { type: 'file-data', bytes: typeof raw === 'string' ? raw.length : raw.byteLength };
                };

                const ws = new WebSocket(`${serverUrl.replace(/^http/, 'ws')}/ws`);
                const signal = (s: unknown) => ws.send(JSON.stringify({ type: 'signal', roomId: room, signal: s }));
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let p: any = null;
                ws.onopen = () => ws.send(JSON.stringify({ type: 'join-room', roomId: room, hostToken: token }));
                ws.onerror = () => reject(new Error('the scripted host could not reach /ws'));
                ws.onmessage = (event) => {
                    const m = JSON.parse(event.data);
                    if (m.type === 'room-joined') {
                        if (m.role === 'host') resolve();
                        else reject(new Error('the server did not seat this page as the host'));
                    } else if (m.type === 'refused' || m.type === 'room-full' || m.type === 'error') {
                        reject(new Error(`the server answered the host join with ${m.type}`));
                    } else if (m.type === 'user-connected') {
                        start();
                    } else if (m.type === 'signal' && p) {
                        p.signal(m.signal);
                    }
                };

                function start() {
                    p = new w.SimplePeer({ initiator: true, trickle: true, readableObjectMode: true, config: { iceServers: [] } });
                    // Control frames go as binary from a file receiver, as the Go engine's do.
                    const say = (frame: object) => p.send(encoder.encode(JSON.stringify(frame)));
                    const refuse = () =>
                        say({ type: 'incompatible', reason: 'FLOEPEERTEXT Open evil.example', pv: 2, pvMin: 2, code: code ?? 'unverified', saved: 0 });
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
                    p.on('error', () => {});
                    p.on('close', () => {
                        state.closed = true;
                    });
                    p.on('data', (raw: string | Uint8Array) => {
                        const frame = heard(raw);
                        state.frames.push(frame);
                        if (frame.type === 'kc') {
                            void proofOf(p, 'sender', key).then((want) => {
                                state.pageProofGood = (frame as { tag?: string }).tag === want;
                            });
                        }
                        if (frame.type === 'file-data') state.fileBytes += frame.bytes ?? 0;
                        if (then === 'ack' || then === 'read-then-refuse') {
                            if (frame.type === 'metadata') {
                                say({ type: 'ack', id: (frame as { id?: string }).id, offset: 0, pv: 2, pvMin: 1, confirms: true });
                            }
                        }
                        if (then === 'ack' && frame.type === 'end') say({ type: 'received', verified: 1 });
                        if (then === 'read-then-refuse' && !w.turned && state.fileBytes >= (after ?? 1)) {
                            w.turned = true;
                            refuse();
                        }
                    });
                    const afterProof = () => {
                        if (then === 'refuse' || then === 'refuse-close') refuse();
                        // Right behind it, as a real host's teardown can be: the frame has been
                        // handed over, and the channel goes with what is already on the wire.
                        if (then === 'refuse-close') setTimeout(() => p.destroy(), 50);
                        if (then === 'close') setTimeout(() => p.destroy(), 50);
                    };
                    const giveProof = async () => {
                        if (proof === 'good') say({ type: 'kc', tag: await proofOf(p, 'receiver', key) });
                        if (proof === 'bad') say({ type: 'kc', tag: await proofOf(p, 'receiver', wrong) });
                        if (proof === 'malformed') say({ type: 'kc', tag: 'not-a-tag' });
                        afterProof();
                    };
                    p.on('connect', () => {
                        if (noise) signal(offer);
                        if (holdProof) w.releaseProof = giveProof;
                        else void giveProof();
                    });
                }
            }),
        {
            room,
            key,
            token,
            wrong: newKey(),
            serverUrl: door.url,
            proof: o.proof,
            then: o.then,
            after: o.after,
            code: o.code,
            holdProof: o.holdProof,
            noise: o.noise,
        },
    );
    return {
        link: `${WEB_URL}/r/${randomBytes(8).toString('base64url')}#${room}.${key}`,
        room,
        key,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state: () => page.evaluate(() => (window as any).scripted),
        releaseProof: () =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            page.evaluate(() => (window as any).releaseProof()),
        close: async () => {
            await ctx.close();
            door.close();
        },
    };
}
