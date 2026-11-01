// The send loop with the link-key hooks, on a real session over a fake peer. Without
// a key the frames are today's, byte for byte. With one, a bad proof stops the send at
// the earliest of "before the first metadata, if it already arrived" and "the first
// ack", so never after a file byte; an enforcing sender waits for the proof first.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLinkKey, type LinkKey } from '../linkKey';
import {
    KEY_CHECK_WAIT_MS,
    SENDER_UNVERIFIED_REASON,
    ackMessage,
    classifyControl,
    incompatibleMessage,
    receivedMessage,
    type Incompatible,
} from './protocol';
import { kcFrame, keyCheckTag, type CertSource } from './keyCheck';
import { createKeySession, type KeyMode, type KeyReport, type KeySession, type PeerLike } from './keySession';
import { sendAbortReason, sendFiles, type BufferChannel, type SenderCallbacks, type SenderDeps } from './sender';

const KEY = parseLinkKey('AAECAwQFBgcICQoLDA0ODw') as LinkKey;
const OTHER_KEY = parseLinkKey('AQIDBAUGBwgJCgsMDQ4PEA') as LinkKey;
const ROOM = '6f207790-92a6-4662-bb68-4c4059f75139';

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const printed = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');

const SENDER_CERT = bytes('the file sender certificate');
const RECEIVER_CERT = bytes('the file receiver certificate');

const HONEST_PC: CertSource = {
    localDescription: { sdp: `a=fingerprint:sha-256 ${printed(sha(SENDER_CERT))}\r\n` },
    remoteDescription: { sdp: `m=application\r\na=fingerprint:sha-256 ${printed(sha(RECEIVER_CERT))}\r\n` },
    sctp: { transport: { getRemoteCertificates: () => [RECEIVER_CERT.buffer.slice(0) as ArrayBuffer] } },
};

/** What an honest file receiver sends: a BINARY kc over both certificates. */
const receiverKc = (key: LinkKey = KEY) => bytes(kcFrame(keyCheckTag(key, 'receiver', ROOM, sha(SENDER_CERT), sha(RECEIVER_CERT))));
const senderKc = () => kcFrame(keyCheckTag(KEY, 'sender', ROOM, sha(SENDER_CERT), sha(RECEIVER_CERT)));

const UNVERIFIED_ABORT = incompatibleMessage(SENDER_UNVERIFIED_REASON, 'unverified');

type Frame = string | Uint8Array | ArrayBuffer;

/** A peer and channel whose other end is a script. */
function makeRig(pc: CertSource | null = HONEST_PC) {
    const listeners = new Map<string, Array<(...a: never[]) => void>>();
    const channelClose = new Set<() => void>();
    const sent: Array<string | Uint8Array> = [];
    let onSent: (frame: string | Uint8Array) => void = () => {};
    const peer: PeerLike & { destroyed: boolean } = {
        destroyed: false,
        initiator: true,
        _pc: pc,
        _channel: { readyState: 'open' },
        on(event: string, handler: (...a: never[]) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
            return this;
        },
        off(event: string, handler: (...a: never[]) => void) {
            listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler));
            return this;
        },
        send(frame: string | Uint8Array) {
            sent.push(frame);
            onSent(frame);
        },
    };
    const emit = (event: string, ...args: unknown[]) => {
        for (const h of listeners.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
    };
    const channel = {
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener(type: string, handler: () => void) {
            if (type === 'close') channelClose.add(handler);
        },
        removeEventListener(type: string, handler: () => void) {
            if (type === 'close') channelClose.delete(handler);
        },
    };
    return {
        peer,
        sent,
        channel,
        deliver: (frame: Frame) => emit('data', frame),
        closeChannel: () => [...channelClose].forEach((h) => h()),
        setOnSent(f: (frame: string | Uint8Array) => void) {
            onSent = f;
        },
        emit,
    };
}

type Rig = ReturnType<typeof makeRig>;

function sessionOn(rig: Rig, mode: KeyMode, key: LinkKey | null = KEY) {
    const reports: KeyReport[] = [];
    const ks = createKeySession({
        peer: rig.peer,
        fileRole: 'sender',
        key,
        roomId: ROOM,
        mode,
        reportRole: 'sender',
        onReport: (r) => reports.push(r),
    });
    return { ks, reports };
}

function depsOn(rig: Rig, ks: KeySession): SenderDeps {
    return {
        send: (d) => ks.send(d),
        onData: (h) => ks.onData(h),
        channel: rig.channel,
        hashBlob: async () => null,
    };
}

const metadataIdOf = (frame: string | Uint8Array): string | null => {
    if (typeof frame !== 'string') return null;
    const parsed = JSON.parse(frame) as { type?: string; id?: string };
    return parsed.type === 'metadata' ? (parsed.id as string) : null;
};

/** A receiver that acks every metadata once, in a macrotask's worth of order. */
function acking(rig: Rig, before?: (id: string) => void) {
    rig.setOnSent((frame) => {
        const id = metadataIdOf(frame);
        if (id === null) return;
        queueMicrotask(() => {
            before?.(id);
            rig.deliver(ackMessage(id, 0));
        });
    });
}

const typeOf = (frame: string | Uint8Array): string => {
    if (typeof frame !== 'string') return 'binary';
    return (JSON.parse(frame) as { type: string }).type;
};

const files = (n = 1) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, file: new File([new Uint8Array(16).fill(0x41 + i)], `${i}.bin`) }));

function recorder() {
    const log: string[] = [];
    const failed: Array<{ outcome: string; where: string }> = [];
    const stops: Array<{ code: string | null; saved: number; rangeOverlaps: boolean }> = [];
    const errors: string[] = [];
    const cb: SenderCallbacks = {
        onError: (m) => {
            errors.push(m);
            log.push('error');
        },
        onFileStart: () => log.push('fileStart'),
        onAck: () => log.push('ack'),
        onAllSent: () => log.push('allSent'),
        onStopped: (s) => {
            stops.push(s);
            log.push('stopped');
        },
        onFailed: (f) => log.push(`failed:${f.kind}`),
        onKeyCheckFailed: (f) => {
            failed.push(f);
            log.push('keyCheckFailed');
        },
    };
    return { cb, log, failed, stops, errors };
}

describe('sendAbortReason takes a code', () => {
    const channel = (): BufferChannel => ({
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
    });

    it('with none, sends the frame it always did', async () => {
        const sent: unknown[] = [];
        await sendAbortReason((d) => sent.push(d), channel(), 'Transfer blocked.');
        expect(sent).toEqual([incompatibleMessage('Transfer blocked.')]);
    });

    it('with one, carries it, as TEXT, on the range that code uses', async () => {
        const sent: unknown[] = [];
        await sendAbortReason((d) => sent.push(d), channel(), SENDER_UNVERIFIED_REASON, 'unverified');
        expect(sent).toEqual([
            '{"type":"incompatible","reason":"sender could not confirm the receiver holds this link","pv":2,"pvMin":2,"code":"unverified"}',
        ]);
    });
});

describe('a send with no key is the send of today', () => {
    it('sends metadata, a chunk and end, and no kc', async () => {
        const rig = makeRig();
        const r = recorder();
        acking(rig);
        await sendFiles(
            { send: (d) => rig.peer.send(d), onData: (h) => { rig.peer.on('data', h); return () => rig.peer.off('data', h); }, channel: rig.channel, hashBlob: async () => null },
            files(),
            r.cb
        );
        expect(rig.sent.map(typeOf)).toEqual(['metadata', 'binary', 'end']);
        expect(r.failed).toEqual([]);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
    });

    it('takes a keyless session the same way, through its pass-through', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'enforce', null);
        const r = recorder();
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['metadata', 'binary', 'end']);
        expect(r.failed).toEqual([]);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
        expect(reports).toEqual([]);
    });

    it('drops a kc that arrives anyway: an unhandled kc is ignored, in the ack wait and after it', async () => {
        const rig = makeRig();
        const r = recorder();
        acking(rig, () => rig.deliver(receiverKc(OTHER_KEY)));
        await sendFiles(
            { send: (d) => rig.peer.send(d), onData: (h) => { rig.peer.on('data', h); return () => rig.peer.off('data', h); }, channel: rig.channel, hashBlob: async () => null },
            files(),
            r.cb
        );
        rig.deliver(`{"type":"kc","tag":7}`);
        expect(rig.sent.map(typeOf)).toEqual(['metadata', 'binary', 'end']);
        expect(r.errors).toEqual([]);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
    });
});

describe('detect: the web sender of a share link', () => {
    it('goes on past a good proof, with its own kc first', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'detect');
        const r = recorder();
        rig.deliver(receiverKc());
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent[0]).toBe(senderKc());
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end']);
        expect(ks.verdict()).toBe('verified');
        expect(r.failed).toEqual([]);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
        expect(reports).toEqual([]);
    });

    it('goes on past silence, a receiver that holds no key, and reports nothing', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'detect');
        const r = recorder();
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end']);
        expect(r.failed).toEqual([]);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
        expect(reports).toEqual([]);
    });

    it('stops before the first metadata when a bad proof has already arrived, naming no file', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'detect');
        const r = recorder();
        rig.deliver(receiverKc(OTHER_KEY));
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent).toEqual([senderKc(), UNVERIFIED_ABORT]);
        expect(r.failed).toEqual([{ outcome: 'bad-tag', where: 'before-metadata' }]);
        expect(r.log).toEqual(['keyCheckFailed']);
        expect(reports.map((x) => x.outcome)).toEqual(['bad-tag']);
    });

    it('stops at the first ack when the bad proof came with it, before any file byte', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'detect');
        const r = recorder();
        // An ordered channel: the receiver's kc is ahead of its ack.
        acking(rig, () => rig.deliver(receiverKc(OTHER_KEY)));
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'incompatible']);
        expect(rig.sent[2]).toBe(UNVERIFIED_ABORT);
        expect(r.failed).toEqual([{ outcome: 'bad-tag', where: 'first-ack' }]);
        // onAck reports a file the receiver took, and this one is not going.
        expect(r.log).toEqual(['keyCheckFailed']);
    });

    it('treats a malformed proof the same way, and says so', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'detect');
        const r = recorder();
        acking(rig, () => rig.deliver('{"type":"kc","tag":"short"}'));
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'incompatible']);
        expect(r.failed).toEqual([{ outcome: 'malformed', where: 'first-ack' }]);
    });

    it('checks only the first file: a proof after the first ack is reported, and no file is cut short for it', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'detect');
        const r = recorder();
        let ends = 0;
        rig.setOnSent((frame) => {
            const id = metadataIdOf(frame);
            if (id !== null) queueMicrotask(() => rig.deliver(ackMessage(id, 0)));
            if (typeOf(frame) === 'end') {
                ends += 1;
                if (ends === 1) rig.deliver(receiverKc(OTHER_KEY));
            }
        });
        await sendFiles(depsOn(rig, ks), files(2), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end', 'metadata', 'binary', 'end']);
        expect(r.failed).toEqual([]);
        expect(ks.verdict()).toBe('failed');
        expect(reports.map((x) => x.outcome)).toEqual(['bad-tag']);
    });

    it('goes on when this browser cannot read the certificates, with no kc, and reports it', async () => {
        const rig = makeRig({ localDescription: null, remoteDescription: null });
        const { ks, reports } = sessionOn(rig, 'detect');
        const r = recorder();
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['metadata', 'binary', 'end']);
        expect(r.failed).toEqual([]);
        expect(reports).toEqual([{ role: 'sender', path: 'none', outcome: 'unavailable', mode: 'detect' }]);
    });

    it('reads a refusal the way it reads any other: onStopped with the code, once, and no second stop', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'detect');
        const r = recorder();
        rig.setOnSent((frame) => {
            if (metadataIdOf(frame) !== null) {
                queueMicrotask(() => rig.deliver(bytes(incompatibleMessage('receiver could not confirm the sender holds this link', 'unverified', 0))));
            }
        });
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata']);
        expect(r.stops).toEqual([{ code: 'unverified', saved: 0, rangeOverlaps: true }]);
        expect(r.failed).toEqual([]);
        expect(reports.map((x) => x.outcome)).toEqual(['peer-refused']);
    });

    it('says one thing when the receiver refuses while the abort is still leaving', async () => {
        const rig = makeRig();
        rig.channel.bufferedAmount = 1;
        const { ks } = sessionOn(rig, 'detect');
        const r = recorder();
        rig.deliver(receiverKc(OTHER_KEY));
        const done = sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        await vi.waitFor(() => expect(rig.sent).toContain(UNVERIFIED_ABORT));
        rig.deliver(bytes(incompatibleMessage('x', 'unverified', 0)));
        rig.channel.bufferedAmount = 0;
        await done;
        expect(r.stops).toHaveLength(1);
        expect(r.failed).toEqual([]);
    });
});

describe('observe: the rollback lever', () => {
    it('never stops a send for a failed check, and still reports it', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'observe');
        const r = recorder();
        rig.deliver(receiverKc(OTHER_KEY));
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end']);
        expect(r.failed).toEqual([]);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
        expect(reports.map((x) => x.outcome)).toEqual(['bad-tag']);
    });
});

describe('enforce: the cutover, and floe send --link-only\'s browser twin', () => {
    afterEach(() => vi.useRealTimers());

    it('names no file until the proof has checked out', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'enforce');
        const r = recorder();
        rig.emit('connect');
        acking(rig);
        const done = sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(rig.sent).toEqual([senderKc()]);

        rig.deliver(receiverKc());
        await done;
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end']);
        expect(r.failed).toEqual([]);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
        expect(reports).toEqual([]);
    });

    it('goes at once when the proof beat the send', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        rig.deliver(receiverKc());
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end']);
    });

    it('stops on a bad proof, names no file, and has told the receiver why', async () => {
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'enforce');
        const r = recorder();
        const done = sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        rig.deliver(receiverKc(OTHER_KEY));
        await done;
        expect(rig.sent).toEqual([senderKc(), UNVERIFIED_ABORT]);
        expect(reports).toEqual([{ role: 'sender', path: 'der', outcome: 'bad-tag', mode: 'enforce' }]);
        expect(r.failed).toEqual([{ outcome: 'bad-tag', where: 'wait' }]);
        expect(r.log).toEqual(['keyCheckFailed']);
    });

    it('stops on a malformed proof', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        const done = sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        rig.deliver('{"type":"kc","tag":null}');
        await done;
        expect(r.failed).toEqual([{ outcome: 'malformed', where: 'wait' }]);
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'incompatible']);
    });

    it('gives up on silence at KEY_CHECK_WAIT_MS, with the same frame a bad proof gets', async () => {
        vi.useFakeTimers();
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'enforce');
        const r = recorder();
        rig.emit('connect');
        const done = sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        await vi.advanceTimersByTimeAsync(KEY_CHECK_WAIT_MS - 1);
        expect(rig.sent).toEqual([senderKc()]);
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(rig.sent).toEqual([senderKc(), UNVERIFIED_ABORT]);
        expect(r.failed).toEqual([{ outcome: 'silent', where: 'wait' }]);
        expect(reports).toEqual([{ role: 'sender', path: 'der', outcome: 'silent', mode: 'enforce' }]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops when this browser cannot read the certificates, with no kc', async () => {
        const rig = makeRig({ localDescription: null, remoteDescription: null });
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        rig.emit('connect');
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent).toEqual([UNVERIFIED_ABORT]);
        expect(r.failed).toEqual([{ outcome: 'unavailable', where: 'wait' }]);
    });

    it('reads a refusal in the wait as a refusal, and says nothing of its own', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        rig.emit('connect');
        const done = sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        rig.deliver(bytes(incompatibleMessage('They said no.', 'declined')));
        await done;
        expect(rig.sent).toEqual([senderKc()]);
        expect(r.stops).toEqual([{ code: 'declined', saved: 0, rangeOverlaps: true }]);
        expect(r.failed).toEqual([]);
    });

    it('ends quietly when this page tears the transfer down in the wait', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        let destroyed = false;
        const done = sendFiles(depsOn(rig, ks), files(), { ...r.cb, isDestroyed: () => destroyed }, { keyCheck: ks });
        destroyed = true;
        await done;
        expect(rig.sent).toEqual([]);
        expect(r.log).toEqual([]);
    });

    it('calls a channel that closed in the wait what the ack wait calls it, in the order a real close comes', async () => {
        // simple-peer's own onclose attribute handler is the channel's first listener:
        // the peer emits 'close', which answers the wait, and the engine's listener on
        // that same event runs only after that microtask. Measured in Chromium 156 and
        // Firefox 157.
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        const done = sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        await new Promise((resolve) => setTimeout(resolve, 0)); // the wait has begun
        rig.emit('close');
        for (let i = 0; i < 10; i++) await Promise.resolve();
        rig.closeChannel();
        await done;
        expect(rig.sent.map(typeOf).filter((t) => t !== 'kc')).toEqual([]);
        expect(r.errors).toEqual(['Connection lost. The other device may have closed the tab.']);
        expect(r.log).toEqual(['error', 'failed:closed']);
    });

    it('reports nothing when the page destroys the peer while the abort is leaving', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        let destroyed = false;
        rig.setOnSent((frame) => {
            if (typeof frame === 'string' && frame.includes('"incompatible"')) destroyed = true;
        });
        const done = sendFiles(depsOn(rig, ks), files(), { ...r.cb, isDestroyed: () => destroyed }, { keyCheck: ks });
        rig.deliver(receiverKc(OTHER_KEY));
        await done;
        expect(destroyed).toBe(true);
        expect(r.failed).toEqual([]);
        expect(r.log).not.toContain('keyCheckFailed');
    });

    it('releases what it holds on every exit', async () => {
        vi.useFakeTimers();
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const done = sendFiles(depsOn(rig, ks), files(), recorder().cb, { keyCheck: ks });
        rig.deliver(receiverKc(OTHER_KEY));
        await vi.runAllTimersAsync();
        await done;
        expect(vi.getTimerCount()).toBe(0);
    });
});

// Found by the real-browser bench (tools/browser-cert-capture/session-bench.mjs): the
// session replays what came early synchronously, inside the subscribe, so the engine's
// listener can run before openSession has finished. It read reportStop while that was
// still a const in its temporal dead zone, and the throw reached the page's error
// handler as a ReferenceError, on the most ordinary tampered link.
describe('frames that beat the send', () => {
    afterEach(() => vi.unstubAllGlobals());

    for (const mode of ['detect', 'enforce', 'observe'] as const) {
        it(`${mode}: a refusal that was already here is reported once, and nothing throws`, async () => {
            const rethrown: Array<() => void> = [];
            vi.stubGlobal('queueMicrotask', (f: () => void) => rethrown.push(f));
            const rig = makeRig();
            const { ks } = sessionOn(rig, mode);
            const r = recorder();
            rig.deliver(bytes(incompatibleMessage('receiver could not confirm the sender holds this link', 'unverified', 0)));
            await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
            expect(rethrown).toHaveLength(0);
            expect(r.stops).toEqual([{ code: 'unverified', saved: 0, rangeOverlaps: true }]);
            expect(r.log).toEqual(['error', 'stopped']);
            expect(r.failed).toEqual([]);
            expect(rig.sent).toEqual([senderKc()]);
        });
    }

    it('a bad proof and then a refusal, both already here, read as the refusal', async () => {
        const rethrown: Array<() => void> = [];
        vi.stubGlobal('queueMicrotask', (f: () => void) => rethrown.push(f));
        const rig = makeRig();
        const { ks, reports } = sessionOn(rig, 'detect');
        const r = recorder();
        rig.deliver(receiverKc(OTHER_KEY));
        rig.deliver(bytes(incompatibleMessage('x', 'unverified', 0)));
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rethrown).toHaveLength(0);
        expect(r.stops).toHaveLength(1);
        expect(r.failed).toEqual([]);
        expect(rig.sent).toEqual([senderKc()]);
        expect(reports.map((x) => x.outcome)).toEqual(['bad-tag']);
    });

    it('an ack that came before any metadata answers nothing', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'detect');
        const r = recorder();
        rig.deliver(ackMessage('f0', 0));
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end']);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
    });

    it('a received that came before the send counts as the claim it is, and the send goes on', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'detect');
        const r = recorder();
        rig.deliver(bytes(receivedMessage(1)));
        acking(rig);
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks });
        expect(rig.sent.map(typeOf)).toEqual(['kc', 'metadata', 'binary', 'end']);
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
    });
});

describe('a keyed send that is delivered', () => {
    it('still ends on received when it asked to', async () => {
        const rig = makeRig();
        const { ks } = sessionOn(rig, 'enforce');
        const r = recorder();
        rig.deliver(receiverKc());
        rig.setOnSent((frame) => {
            const id = metadataIdOf(frame);
            if (id !== null) queueMicrotask(() => rig.deliver(ackMessage(id, 0)));
            if (typeOf(frame) === 'end') queueMicrotask(() => rig.deliver(bytes(receivedMessage(1))));
        });
        await sendFiles(depsOn(rig, ks), files(), r.cb, { keyCheck: ks, requireReceived: true });
        expect(r.log).toEqual(['ack', 'fileStart', 'allSent']);
    });
});

describe('the abort frame', () => {
    it('reads as a deliberate stop with this code on a current peer', () => {
        const msg = classifyControl(UNVERIFIED_ABORT) as Incompatible;
        expect(msg.code).toBe('unverified');
        expect(msg.pv).toBe(2);
        expect(msg.pvMin).toBe(2);
    });
});
