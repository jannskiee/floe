// The per-connection gate, driven through a fake peer with no simple-peer in it. The
// fake keeps what the session depends on from the real one: 'data' listeners called
// synchronously from a push, a send that throws until the channel is open, a null
// _channel on the answerer until ondatachannel.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkKeyText, parseLinkKey, type LinkKey } from '../linkKey';
import { incompatibleMessage, metadataMessage, SENDER_UNVERIFIED_REASON, ackMessage } from './protocol';
import { kcFrame, keyCheckTag, type CertSource, type FileRole } from './keyCheck';
import {
    MAX_EARLY_FRAMES,
    createKeySession,
    keySessionOf,
    linkKeyMode,
    type KeyMode,
    type KeyReport,
    type PeerLike,
} from './keySession';

const KEY_TEXT = 'AAECAwQFBgcICQoLDA0ODw';
const KEY = parseLinkKey(KEY_TEXT) as LinkKey;
const OTHER_KEY = parseLinkKey('AQIDBAUGBwgJCgsMDQ4PEA') as LinkKey;
const ROOM = '6f207790-92a6-4662-bb68-4c4059f75139';

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const printed = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const SENDER_CERT = bytes('the file sender certificate');
const RECEIVER_CERT = bytes('the file receiver certificate');
const HS = sha(SENDER_CERT);
const HR = sha(RECEIVER_CERT);

function pcOf(local: Uint8Array, remote: Uint8Array): CertSource {
    return {
        localDescription: { sdp: `m=application 9 x\r\na=fingerprint:sha-256 ${printed(sha(local))}\r\n` },
        remoteDescription: { sdp: `m=application 9 x\r\na=fingerprint:sha-256 ${printed(sha(remote))}\r\n` },
        sctp: { transport: { getRemoteCertificates: () => [buffer(remote)] } },
    };
}

type Listener = (...args: never[]) => void;

class FakePeer implements PeerLike {
    destroyed = false;
    initiator: boolean;
    _pc: CertSource | null;
    _channel: { readyState: string } | null;
    sent: Array<string | Uint8Array> = [];
    refuseSends = 0;
    private listeners = new Map<string, Listener[]>();

    constructor(o: { initiator?: boolean; pc?: CertSource | null; channel?: string | null } = {}) {
        this.initiator = o.initiator ?? true;
        this._pc = o.pc === undefined ? pcOf(SENDER_CERT, RECEIVER_CERT) : o.pc;
        this._channel = o.channel === null ? null : { readyState: o.channel ?? 'open' };
    }

    on(event: string, handler: Listener): unknown {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
        return this;
    }

    off(event: string, handler: Listener): unknown {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((h) => h !== handler));
        return this;
    }

    send(data: string | Uint8Array): void {
        if (this._channel?.readyState !== 'open') throw new Error('InvalidStateError');
        if (this.refuseSends > 0) {
            this.refuseSends -= 1;
            throw new Error('closing');
        }
        this.sent.push(data);
    }

    emit(event: string, ...args: unknown[]): void {
        for (const h of this.listeners.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
    }

    count(event: string): number {
        return (this.listeners.get(event) ?? []).length;
    }
}

function session(o: {
    peer?: FakePeer;
    fileRole?: FileRole;
    key?: LinkKey | null;
    mode?: KeyMode;
    room?: string;
    sdpFallback?: boolean;
} = {}) {
    const fileRole = o.fileRole ?? 'sender';
    const peer =
        o.peer ??
        new FakePeer(
            fileRole === 'sender'
                ? { initiator: true, pc: pcOf(SENDER_CERT, RECEIVER_CERT) }
                : { initiator: false, pc: pcOf(RECEIVER_CERT, SENDER_CERT) }
        );
    const verdicts: string[] = [];
    const reports: KeyReport[] = [];
    const ks = createKeySession({
        peer,
        fileRole,
        key: o.key === undefined ? KEY : o.key,
        roomId: o.room ?? ROOM,
        mode: o.mode ?? (fileRole === 'sender' ? 'detect' : 'enforce'),
        reportRole: fileRole,
        sdpFallback: o.sdpFallback,
        onVerdict: (v) => verdicts.push(v),
        onReport: (r) => reports.push(r),
    });
    return { peer, ks, verdicts, reports };
}

/** A real tag under the right inputs: what an honest peer of this role sends. */
function honestKc(role: FileRole, key: LinkKey = KEY, hS = HS, hR = HR): string {
    return kcFrame(keyCheckTag(key, role, ROOM, hS, hR));
}

const textOf = (frame: string | Uint8Array) => (typeof frame === 'string' ? frame : new TextDecoder().decode(frame));

describe('linkKeyMode, the one reader of the levers', () => {
    const on = { ENFORCE_LINK_KEYS: true, ENFORCE_SHARE_LINK_KEY: false };

    it('makes every receiver and the /r visitor enforce, and a share sender only detect, as shipped', () => {
        expect(linkKeyMode('share-receiver')).toBe('enforce');
        expect(linkKeyMode('request-visitor')).toBe('enforce');
        expect(linkKeyMode('share-sender')).toBe('detect');
    });

    it('turns a share sender into an enforcer at the cutover', () => {
        const cutover = { ENFORCE_LINK_KEYS: true, ENFORCE_SHARE_LINK_KEY: true };
        expect(linkKeyMode('share-sender', cutover)).toBe('enforce');
        expect(linkKeyMode('share-receiver', cutover)).toBe('enforce');
        expect(linkKeyMode('request-visitor', cutover)).toBe('enforce');
    });

    it('turns every page into an observer with the rollback lever, whatever the cutover says', () => {
        for (const ENFORCE_SHARE_LINK_KEY of [false, true]) {
            const off = { ENFORCE_LINK_KEYS: false, ENFORCE_SHARE_LINK_KEY };
            expect(linkKeyMode('share-sender', off)).toBe('observe');
            expect(linkKeyMode('share-receiver', off)).toBe('observe');
            expect(linkKeyMode('request-visitor', off)).toBe('observe');
        }
    });

    it('reads the levers passed to it', () => {
        expect(linkKeyMode('share-sender', on)).toBe('detect');
    });
});

describe('keySessionOf', () => {
    it('finds the session of a peer, keyed or not, and nothing for another peer', () => {
        const keyed = session();
        const keyless = session({ key: null });
        expect(keySessionOf(keyed.peer)).toBe(keyed.ks);
        expect(keySessionOf(keyless.peer)).toBe(keyless.ks);
        expect(keySessionOf(new FakePeer())).toBeUndefined();
    });
});

describe('a keyless session is a pure pass-through', () => {
    it('attaches nothing early, so simple-peer buffers exactly as it does today', () => {
        const { peer } = session({ key: null });
        expect(peer.count('data')).toBe(0);
        expect(peer.count('connect')).toBe(0);
        expect(peer.count('close')).toBe(0);
    });

    it('onData is peer.on with the same handler, and its result is peer.off', () => {
        const { peer, ks } = session({ key: null });
        const handler = vi.fn();
        const off = ks.onData(handler);
        expect(peer.count('data')).toBe(1);
        peer.emit('data', 'x');
        expect(handler).toHaveBeenCalledWith('x');
        off();
        expect(peer.count('data')).toBe(0);
    });

    it('sends what it is given and nothing else, on connect and on every frame', async () => {
        const { peer, ks, verdicts, reports } = session({ key: null });
        ks.onData(() => {});
        peer.emit('connect');
        peer.emit('data', honestKc('receiver'));
        ks.send('metadata');
        ks.send(bytes('chunk'));
        expect(peer.sent).toEqual(['metadata', bytes('chunk')]);
        expect(await ks.ownKcOut).toBe('none');
        expect(verdicts).toEqual([]);
        expect(reports).toEqual([]);
    });

    it('lets a send throw through, as peer.send does', () => {
        const { ks } = session({ key: null, peer: new FakePeer({ channel: null }) });
        expect(() => ks.send('x')).toThrow('InvalidStateError');
    });

    it('never judges and never reports', async () => {
        const { ks, reports } = session({ key: null, mode: 'enforce' });
        expect(ks.keyed).toBe(false);
        expect(ks.verdict()).toBe('pending');
        expect(ks.outcome()).toBeNull();
        expect(ks.peerTag({ type: 'kc', tag: 'x' })).toBe('pending');
        expect(ks.beforeFile()).toBe('pending');
        ks.noteSilent();
        ks.quiet();
        ks.dispose();
        expect(await ks.settle(1, () => false)).toBe('pending');
        expect(ks.verdict()).toBe('pending');
        expect(reports).toEqual([]);
    });

    it('admits every signal, as a page without a key does today', () => {
        const { ks } = session({ key: null });
        for (const signal of [{ renegotiate: true }, { type: 'offer', sdp: 'x' }, { type: 'offer', sdp: 'x' }, {}, null]) {
            expect(ks.admitSignal(signal)).toBe(true);
        }
    });
});

describe('a keyed session owns data from construction', () => {
    it('attaches its listeners at once, connect first of any page listener', () => {
        const { peer, ks } = session();
        expect(ks.keyed).toBe(true);
        expect(peer.count('data')).toBe(1);
        expect(peer.count('connect')).toBe(1);
        expect(peer.count('close')).toBe(1);
    });

    it('leaves the page to subscribe through onData alone, with no second peer listener', () => {
        const { peer, ks } = session();
        ks.onData(() => {});
        ks.onData(() => {});
        expect(peer.count('data')).toBe(1);
    });
});

describe('its own kc', () => {
    it('goes out once at connect, as TEXT from the file sender', async () => {
        const { peer, ks } = session();
        peer.emit('connect');
        expect(peer.sent).toEqual([honestKc('sender')]);
        expect(typeof peer.sent[0]).toBe('string');
        expect(await ks.ownKcOut).toBe('sent');
        peer.emit('connect');
        peer.emit('data', ackMessage('a', 0));
        ks.send('next');
        expect(peer.sent).toEqual([honestKc('sender'), 'next']);
    });

    it('goes out once at connect, as BINARY from the file receiver', async () => {
        const { peer, ks } = session({ fileRole: 'receiver' });
        peer.emit('connect');
        expect(peer.sent).toHaveLength(1);
        expect(peer.sent[0]).toBeInstanceOf(Uint8Array);
        expect(textOf(peer.sent[0])).toBe(honestKc('receiver'));
        expect(await ks.ownKcOut).toBe('sent');
    });

    it('goes out at the first inbound frame when that beats connect, which it usually does', () => {
        const { peer } = session({ fileRole: 'receiver' });
        peer.emit('data', honestKc('sender'));
        expect(peer.sent).toHaveLength(1);
        expect(textOf(peer.sent[0])).toBe(honestKc('receiver'));
        peer.emit('connect');
        expect(peer.sent).toHaveLength(1);
    });

    it('leads any send, whatever the send is', () => {
        const { peer, ks } = session();
        ks.send('metadata');
        ks.send(bytes('chunk'));
        expect(peer.sent).toEqual([honestKc('sender'), 'metadata', bytes('chunk')]);
    });

    it('never follows an abort: the abort sends it first, and a later connect sends nothing', () => {
        const { peer, ks } = session();
        const abort = incompatibleMessage(SENDER_UNVERIFIED_REASON, 'unverified');
        ks.send(abort);
        peer.emit('connect');
        peer.emit('data', ackMessage('a', 0));
        expect(peer.sent).toEqual([honestKc('sender'), abort]);
    });

    it('goes out before the reply to the frame that triggered it', () => {
        const { peer, ks } = session({ fileRole: 'receiver' });
        ks.onData(() => ks.send('ack'));
        peer.emit('data', honestKc('sender'));
        expect(peer.sent.map(textOf)).toEqual([honestKc('receiver'), 'ack']);
    });

    it('uses the send bound at construction, so a wrapper added later never sees it', () => {
        const peer = new FakePeer({ pc: pcOf(SENDER_CERT, RECEIVER_CERT) });
        const { ks } = session({ peer });
        const wrapper = vi.fn();
        peer.send = wrapper;
        peer.emit('connect');
        expect(wrapper).not.toHaveBeenCalled();
        expect(peer.sent).toEqual([honestKc('sender')]);
        ks.send('x');
        expect(peer.sent).toEqual([honestKc('sender'), 'x']);
    });

    it('waits for an open channel: the answerer has none until ondatachannel', async () => {
        const peer = new FakePeer({ initiator: false, channel: null, pc: pcOf(SENDER_CERT, RECEIVER_CERT) });
        const { ks, verdicts } = session({ peer });
        expect(() => peer.emit('connect')).not.toThrow();
        expect(peer.sent).toEqual([]);
        // A send this early fails as a raw send does, and spends nothing.
        expect(() => ks.send('x')).toThrow('InvalidStateError');
        expect(verdicts).toEqual([]);

        peer._channel = { readyState: 'connecting' };
        peer.emit('connect');
        expect(peer.sent).toEqual([]);

        peer._channel = { readyState: 'open' };
        peer.emit('data', ackMessage('a', 0));
        expect(peer.sent).toEqual([honestKc('sender')]);
        expect(await ks.ownKcOut).toBe('sent');
    });

    it('sends nothing on a destroyed peer', () => {
        const { peer } = session();
        peer.destroyed = true;
        peer.emit('connect');
        expect(peer.sent).toEqual([]);
    });

    it('tries again later when the channel refuses the send, and does not throw into the stream', async () => {
        const { peer, ks } = session();
        peer.refuseSends = 1;
        expect(() => peer.emit('connect')).not.toThrow();
        expect(peer.sent).toEqual([]);
        ks.send('x');
        expect(peer.sent).toEqual([honestKc('sender'), 'x']);
        expect(await ks.ownKcOut).toBe('sent');
    });

    it('lets nothing lead its kc when the channel refuses the kc and is still open', () => {
        // A frame ahead of the kc, and a kc behind an abort, are the two orders the
        // spec rules out. Every caller already treats a throw as a failed send.
        const { peer, ks } = session();
        peer.refuseSends = 1;
        expect(() => ks.send('abort')).toThrow();
        expect(peer.sent).toEqual([]);
        ks.send('next');
        expect(peer.sent).toEqual([honestKc('sender'), 'next']);
    });

    it('computes the certificate hashes once per connection', () => {
        const remote = vi.fn(() => [buffer(RECEIVER_CERT)]);
        const pc = { ...pcOf(SENDER_CERT, RECEIVER_CERT), sctp: { transport: { getRemoteCertificates: remote } } };
        const { peer, ks } = session({ peer: new FakePeer({ pc }) });
        peer.emit('connect');
        peer.emit('data', honestKc('receiver'));
        ks.send('x');
        expect(remote).toHaveBeenCalledTimes(1);
    });
});

describe('when the certificates cannot be read', () => {
    const noHashes = () => new FakePeer({ pc: { localDescription: null, remoteDescription: null } });

    it('sends no kc at all, never an empty one, and reports it once', async () => {
        const { peer, ks, verdicts, reports } = session({ peer: noHashes() });
        peer.emit('connect');
        peer.emit('data', honestKc('receiver'));
        ks.send('metadata');
        expect(peer.sent).toEqual(['metadata']);
        expect(await ks.ownKcOut).toBe('none');
        expect(ks.verdict()).toBe('unavailable');
        expect(ks.outcome()).toBe('unavailable');
        expect(verdicts).toEqual(['unavailable']);
        expect(reports).toEqual([{ role: 'sender', path: 'none', outcome: 'unavailable', mode: 'detect' }]);
    });

    it('holds for a peer with no connection left, and for a room id that does not fit', async () => {
        for (const made of [
            session({ peer: new FakePeer({ pc: null }) }),
            session({ room: 'x'.repeat(256) }),
            session({ room: '' }),
        ]) {
            made.peer.emit('connect');
            expect(made.peer.sent).toEqual([]);
            expect(made.ks.verdict()).toBe('unavailable');
            expect(await made.ks.ownKcOut).toBe('none');
        }
    });

    it('takes the SDP path through the lever, and says which path it took', () => {
        const pc = { ...pcOf(SENDER_CERT, RECEIVER_CERT), sctp: null };
        const fallback = session({ peer: new FakePeer({ pc }) });
        fallback.peer.emit('data', kcFrame(new Uint8Array(32)));
        expect(fallback.reports[0].path).toBe('sdp');
        expect(fallback.reports[0].outcome).toBe('bad-tag');

        const off = session({ peer: new FakePeer({ pc }), sdpFallback: false });
        off.peer.emit('connect');
        expect(off.ks.verdict()).toBe('unavailable');
        expect(off.reports[0].path).toBe('none');
    });
});

describe('the file sender judges the receiver', () => {
    it('verifies a good tag inside the callback that delivers it, in either framing, reporting nothing', () => {
        for (const frame of [honestKc('receiver'), bytes(honestKc('receiver'))]) {
            const { peer, ks, verdicts, reports } = session();
            peer.emit('data', frame);
            expect(ks.verdict()).toBe('verified');
            expect(ks.outcome()).toBeNull();
            expect(verdicts).toEqual(['verified']);
            expect(reports).toEqual([]);
        }
    });

    it('never hands a kc to a subscriber', () => {
        const { peer, ks } = session();
        const handler = vi.fn();
        ks.onData(handler);
        peer.emit('data', bytes(honestKc('receiver')));
        peer.emit('data', kcFrame(new Uint8Array(32)));
        expect(handler).not.toHaveBeenCalled();
    });

    it('fails a tag made under another key, and reports it once', () => {
        const { peer, ks, verdicts, reports } = session();
        peer.emit('data', honestKc('receiver', OTHER_KEY));
        expect(ks.verdict()).toBe('failed');
        expect(ks.outcome()).toBe('bad-tag');
        expect(verdicts).toEqual(['failed']);
        expect(reports).toEqual([{ role: 'sender', path: 'der', outcome: 'bad-tag', mode: 'detect' }]);
    });

    it('fails a tag made over other certificates, which is the attack this exists for', () => {
        const attacker = sha(bytes('the certificate of whoever stepped in'));
        const { peer, ks } = session();
        peer.emit('data', honestKc('receiver', KEY, attacker, HR));
        expect(ks.outcome()).toBe('bad-tag');
    });

    it('fails its own tag sent back to it, because the role is in the message', () => {
        const { peer, ks } = session();
        peer.emit('data', honestKc('sender'));
        expect(ks.outcome()).toBe('bad-tag');
    });

    it('fails a frame whose tag is malformed, without computing anything from it', () => {
        for (const frame of [
            '{"type":"kc"}',
            '{"type":"kc","tag":null}',
            '{"type":"kc","tag":7}',
            '{"type":"kc","tag":"short"}',
            `{"type":"kc","tag":"${'A'.repeat(42)}B"}`,
            `{"type":"kc","TAG":"${'A'.repeat(43)}"}`,
        ]) {
            const { peer, ks, reports } = session();
            peer.emit('data', frame);
            expect(ks.verdict(), frame).toBe('failed');
            expect(ks.outcome(), frame).toBe('malformed');
            expect(reports).toEqual([{ role: 'sender', path: 'der', outcome: 'malformed', mode: 'detect' }]);
        }
    });

    it('lets the first kc stand: a second is ignored whichever way it reads', () => {
        const good = session();
        good.peer.emit('data', honestKc('receiver'));
        good.peer.emit('data', honestKc('receiver', OTHER_KEY));
        expect(good.ks.verdict()).toBe('verified');
        expect(good.verdicts).toEqual(['verified']);
        expect(good.reports).toEqual([]);

        const bad = session();
        bad.peer.emit('data', honestKc('receiver', OTHER_KEY));
        bad.peer.emit('data', honestKc('receiver'));
        expect(bad.ks.verdict()).toBe('failed');
        expect(bad.verdicts).toEqual(['failed']);
        expect(bad.reports).toHaveLength(1);
    });
});

describe('frames that arrive before the first subscriber', () => {
    const ack = (i: number) => ackMessage(`f${i}`, 0);

    it('are latched and replayed synchronously to the first subscriber, in order', () => {
        const { peer, ks } = session();
        peer.emit('data', ack(1));
        peer.emit('data', bytes(ack(2)));
        const seen: unknown[] = [];
        ks.onData((d) => seen.push(d));
        expect(seen).toEqual([ack(1), bytes(ack(2))]);
    });

    it('are replayed once, and go straight through after that', () => {
        const { peer, ks } = session();
        peer.emit('data', ack(1));
        const first: unknown[] = [];
        const second: unknown[] = [];
        ks.onData((d) => first.push(d));
        ks.onData((d) => second.push(d));
        peer.emit('data', ack(2));
        expect(first).toEqual([ack(1), ack(2)]);
        expect(second).toEqual([ack(2)]);
    });

    it('stop at eight, and the first incompatible is kept whatever came before it', () => {
        const { peer, ks } = session();
        for (let i = 0; i < MAX_EARLY_FRAMES + 3; i++) peer.emit('data', ack(i));
        const refusal = incompatibleMessage('stopped', 'declined');
        peer.emit('data', refusal);
        peer.emit('data', incompatibleMessage('a second one', 'stopped'));
        const seen: unknown[] = [];
        ks.onData((d) => seen.push(d));
        expect(MAX_EARLY_FRAMES).toBe(8);
        expect(seen).toEqual([...Array.from({ length: 8 }, (_, i) => ack(i)), refusal]);
    });

    it('drop what no sender would read: a frame that does not classify, or one past the cap', () => {
        const { peer, ks } = session();
        peer.emit('data', 'not json');
        peer.emit('data', bytes('file-looking bytes'));
        peer.emit('data', `{"type":"ack","pad":"${'x'.repeat(1000)}"}`);
        peer.emit('data', '{"type":"hello"}');
        peer.emit('data', ack(1));
        const seen: unknown[] = [];
        ks.onData((d) => seen.push(d));
        expect(seen).toEqual([ack(1)]);
    });

    it('are dropped once the only subscriber has left, as a stream with no listener drops them', () => {
        const { peer, ks } = session();
        const off = ks.onData(() => {});
        off();
        peer.emit('data', ack(1));
        const later: unknown[] = [];
        ks.onData((d) => later.push(d));
        expect(later).toEqual([]);
    });

    it('are forgotten at the close', () => {
        const { peer, ks } = session();
        peer.emit('data', ack(1));
        peer.emit('close');
        const seen: unknown[] = [];
        ks.onData((d) => seen.push(d));
        expect(seen).toEqual([]);
    });

    it('on a file receiver include every frame, file bytes too, since the engine judges them all', () => {
        const { peer, ks } = session({ fileRole: 'receiver' });
        const chunk = bytes('a chunk of a file');
        const text = metadataMessage('a', 'a.bin', 4, 1, 1, 4);
        const overCap = 'x'.repeat(1200);
        peer.emit('data', text);
        peer.emit('data', chunk);
        peer.emit('data', overCap);
        const seen: unknown[] = [];
        ks.onData((d) => seen.push(d));
        expect(seen).toEqual([text, chunk, overCap]);
    });
});

describe('the file receiver hands every frame to the engine', () => {
    it('forwards kc, metadata and file bytes, the same object, and judges nothing itself', () => {
        const { peer, ks } = session({ fileRole: 'receiver' });
        const seen: unknown[] = [];
        ks.onData((d) => seen.push(d));
        const chunk = bytes('a chunk');
        const kc = honestKc('sender');
        peer.emit('data', kc);
        peer.emit('data', chunk);
        expect(seen).toEqual([kc, chunk]);
        expect(seen[1]).toBe(chunk);
        expect(ks.verdict()).toBe('pending');
    });

    it('peerTag verifies a good tag and answers at once', () => {
        const { ks, verdicts, reports } = session({ fileRole: 'receiver' });
        expect(ks.peerTag(JSON.parse(honestKc('sender')))).toBe('verified');
        expect(verdicts).toEqual(['verified']);
        expect(reports).toEqual([]);
    });

    it('peerTag fails a bad tag and a malformed one, and the first answer stands', () => {
        const bad = session({ fileRole: 'receiver' });
        expect(bad.ks.peerTag(JSON.parse(honestKc('sender', OTHER_KEY)))).toBe('failed');
        expect(bad.ks.outcome()).toBe('bad-tag');
        expect(bad.ks.peerTag(JSON.parse(honestKc('sender')))).toBe('failed');
        expect(bad.reports).toEqual([{ role: 'receiver', path: 'der', outcome: 'bad-tag', mode: 'enforce' }]);

        const malformed = session({ fileRole: 'receiver' });
        expect(malformed.ks.peerTag({ type: 'kc', tag: 7 })).toBe('failed');
        expect(malformed.ks.outcome()).toBe('malformed');
    });

    it('peerTag refuses the receiver\'s own tag sent back', () => {
        const { ks } = session({ fileRole: 'receiver' });
        expect(ks.peerTag(JSON.parse(honestKc('receiver')))).toBe('failed');
    });

    it('beforeFile decides missing while the proof is still pending, and only then', () => {
        const pending = session({ fileRole: 'receiver' });
        expect(pending.ks.beforeFile()).toBe('failed');
        expect(pending.ks.outcome()).toBe('missing');
        expect(pending.reports).toEqual([{ role: 'receiver', path: 'none', outcome: 'missing', mode: 'enforce' }]);
        // A proof that comes after the frame it had to come before changes nothing.
        expect(pending.ks.peerTag(JSON.parse(honestKc('sender')))).toBe('failed');

        const verified = session({ fileRole: 'receiver' });
        verified.ks.peerTag(JSON.parse(honestKc('sender')));
        expect(verified.ks.beforeFile()).toBe('verified');
    });

    it('fails closed on unreadable certificates, whichever frame comes first', () => {
        const peer = new FakePeer({ initiator: false, pc: { localDescription: null, remoteDescription: null } });
        const { ks, reports } = session({ peer, fileRole: 'receiver' });
        expect(ks.peerTag(JSON.parse(honestKc('sender')))).toBe('unavailable');
        expect(ks.beforeFile()).toBe('unavailable');
        expect(reports).toEqual([{ role: 'receiver', path: 'none', outcome: 'unavailable', mode: 'enforce' }]);
    });
});

describe('the two ends of one connection', () => {
    function pair(key: { sender: LinkKey; receiver: LinkKey } = { sender: KEY, receiver: KEY }, senderSees = RECEIVER_CERT) {
        const sender = session({ peer: new FakePeer({ initiator: true, pc: pcOf(SENDER_CERT, senderSees) }), key: key.sender });
        const receiver = session({
            peer: new FakePeer({ initiator: false, pc: pcOf(RECEIVER_CERT, SENDER_CERT) }),
            fileRole: 'receiver',
            key: key.receiver,
        });
        // What simple-peer does: a TEXT frame stays a string, a BINARY one a view.
        receiver.ks.onData((d) => {
            if (typeof d === 'string') {
                const kc = JSON.parse(d) as { type: string };
                if (kc.type === 'kc') receiver.ks.peerTag(kc as never);
            }
        });
        const flush = () => {
            sender.peer.sent.splice(0).forEach((f) => receiver.peer.emit('data', f));
            receiver.peer.sent.splice(0).forEach((f) => sender.peer.emit('data', f));
        };
        return { sender, receiver, flush };
    }

    it('verify each other with the same key over the certificates DTLS used', () => {
        const { sender, receiver, flush } = pair();
        sender.peer.emit('connect');
        receiver.peer.emit('connect');
        flush();
        expect(sender.ks.verdict()).toBe('verified');
        expect(receiver.ks.verdict()).toBe('verified');
    });

    it('fail on both sides with different keys', () => {
        const { sender, receiver, flush } = pair({ sender: KEY, receiver: OTHER_KEY });
        sender.peer.emit('connect');
        receiver.peer.emit('connect');
        flush();
        expect(sender.ks.outcome()).toBe('bad-tag');
        expect(receiver.ks.outcome()).toBe('bad-tag');
    });

    it('fail when something between them terminated DTLS, even holding nothing but the signaling', () => {
        const { sender, receiver, flush } = pair(undefined, bytes('the certificate of whoever stepped in'));
        sender.peer.emit('connect');
        receiver.peer.emit('connect');
        flush();
        expect(sender.ks.outcome()).toBe('bad-tag');
        expect(receiver.ks.outcome()).toBe('bad-tag');
    });
});

describe('silence', () => {
    it('in enforce mode is a failure, reported once', () => {
        const { ks, verdicts, reports } = session({ mode: 'enforce' });
        ks.noteSilent();
        ks.noteSilent();
        expect(ks.verdict()).toBe('failed');
        expect(ks.outcome()).toBe('silent');
        expect(verdicts).toEqual(['failed']);
        expect(reports).toEqual([{ role: 'sender', path: 'none', outcome: 'silent', mode: 'enforce' }]);
    });

    it('in detect and observe is not a failure and is never reported, or every send to a released CLI would warn', () => {
        for (const mode of ['detect', 'observe'] as const) {
            const { ks, verdicts, reports } = session({ mode });
            ks.noteSilent();
            expect(ks.verdict(), mode).toBe('pending');
            expect(ks.outcome(), mode).toBeNull();
            expect(verdicts).toEqual([]);
            expect(reports).toEqual([]);
        }
    });

    it('after a verdict changes nothing', () => {
        const { peer, ks, verdicts } = session({ mode: 'enforce' });
        peer.emit('data', honestKc('receiver'));
        ks.noteSilent();
        expect(ks.verdict()).toBe('verified');
        expect(verdicts).toEqual(['verified']);
    });
});

describe('the report', () => {
    it('fires once per connection, the first reason standing', () => {
        const { peer, reports } = session();
        peer.emit('data', honestKc('receiver', OTHER_KEY));
        peer.emit('data', incompatibleMessage('x', 'unverified'));
        expect(reports).toEqual([{ role: 'sender', path: 'der', outcome: 'bad-tag', mode: 'detect' }]);
    });

    it('names a refusal for this code, with the frame still reaching the engine', () => {
        const { peer, ks, reports } = session();
        const seen: unknown[] = [];
        ks.onData((d) => seen.push(d));
        const refusal = bytes(incompatibleMessage('x', 'unverified', 0));
        peer.emit('data', refusal);
        expect(reports).toEqual([{ role: 'sender', path: 'der', outcome: 'peer-refused', mode: 'detect' }]);
        expect(seen).toEqual([refusal]);
        expect(ks.verdict()).toBe('pending');
    });

    it('names a sender\'s stop for this code on a file receiver too', () => {
        const { peer, ks, reports } = session({ fileRole: 'receiver' });
        ks.onData(() => {});
        peer.emit('data', incompatibleMessage(SENDER_UNVERIFIED_REASON, 'unverified'));
        expect(reports).toEqual([{ role: 'receiver', path: 'der', outcome: 'peer-refused', mode: 'enforce' }]);
    });

    it('reports nothing for file bytes that spell a refusal, on a file receiver', () => {
        // A small file can hold exactly these bytes. To a file receiver a binary frame
        // is file data, so it is no report of a refusal.
        const { peer, ks, reports } = session({ fileRole: 'receiver' });
        ks.onData(() => {});
        peer.emit('data', bytes(incompatibleMessage(SENDER_UNVERIFIED_REASON, 'unverified')));
        expect(reports.filter((r) => r.outcome === 'peer-refused')).toEqual([]);
    });

    it('ignores every other refusal, and a hostile code', () => {
        const { peer, ks, reports } = session();
        ks.onData(() => {});
        peer.emit('data', incompatibleMessage('x', 'declined'));
        peer.emit('data', JSON.stringify({ type: 'incompatible', reason: 'x', pv: 2, pvMin: 1, code: 'UNVERIFIED' }));
        peer.emit('data', JSON.stringify({ type: 'incompatible', reason: 'x', pv: 2, pvMin: 1, code: { code: 'unverified' } }));
        expect(reports).toEqual([]);
    });

    it('holds enums and no peer value, no key and no room', () => {
        const { peer, reports } = session();
        peer.emit('data', honestKc('receiver', OTHER_KEY));
        const text = JSON.stringify(reports);
        expect(Object.keys(reports[0]).sort()).toEqual(['mode', 'outcome', 'path', 'role']);
        expect(text).not.toContain(KEY_TEXT);
        expect(text).not.toContain(ROOM);
        expect(text).not.toContain(JSON.parse(honestKc('receiver', OTHER_KEY)).tag);
    });

    it('is quiet after quiet()', () => {
        const { peer, ks, reports } = session();
        ks.quiet();
        peer.emit('data', honestKc('receiver', OTHER_KEY));
        expect(ks.verdict()).toBe('failed');
        expect(reports).toEqual([]);
    });
});

describe('the key itself', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reaches no frame, no report and no console', () => {
        const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
        const { peer, ks, reports } = session();
        peer.emit('connect');
        peer.emit('data', honestKc('receiver', OTHER_KEY));
        ks.send('x');
        const text = JSON.stringify({ sent: peer.sent.map(textOf), reports, ks });
        expect(text).not.toContain(KEY_TEXT);
        expect(linkKeyText(KEY)).toBe(KEY_TEXT);
        for (const log of logs) expect(log).not.toHaveBeenCalled();
    });

    it('is not on the session object for anything to walk', () => {
        const { ks } = session();
        for (const value of Object.values(ks)) expect(value).not.toBe(KEY);
        expect(JSON.stringify(ks)).not.toContain(KEY_TEXT);
    });
});

describe('the modules that hold the key or a peer\'s proof', () => {
    const FILES = ['../linkKey.ts', './keyCheck.ts', './keySession.ts', './sha256Sync.ts'];
    const code = (file: string) =>
        readFileSync(new URL(file, import.meta.url), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:'"])\/\/.*$/gm, '$1');

    for (const file of FILES) {
        it(`${file} has no sink of its own: no console, report, request or storage`, () => {
            const text = code(file);
            expect(text.length).toBeGreaterThan(500);
            for (const banned of [
                'console.', 'Sentry', 'captureMessage', 'captureException', 'addBreadcrumb', 'track(', 'fetch(',
                'XMLHttpRequest', 'sendBeacon', 'localStorage', 'sessionStorage', 'indexedDB', 'caches.', 'document.',
                'window.', 'location.', 'history.',
            ]) {
                expect(text.includes(banned), banned).toBe(false);
            }
        });

        it(`${file} throws fixed words only, so an error cannot quote a key, a tag or a room`, () => {
            for (const match of code(file).matchAll(/new Error\(([^)]*)\)/g)) {
                expect(match[1], match[0]).toMatch(/^'[^'$`]*'$/);
            }
        });
    }

    it('keySession.ts does not import simple-peer, and the engines take its type only', () => {
        const session = code('./keySession.ts');
        expect(session).not.toContain('simple-peer');
        for (const engine of ['./sender.ts', './receiver.ts']) {
            expect(code(engine)).toContain("import type { KeyOutcome, KeySession } from './keySession';");
            expect(code(engine).match(/from '\.\/keySession'/g)).toHaveLength(1);
        }
    });
});

describe('quiet', () => {
    it('stops an own kc that has not gone out, and says none', async () => {
        const { peer, ks } = session();
        ks.quiet();
        peer.emit('connect');
        peer.emit('data', ackMessage('a', 0));
        expect(peer.sent).toEqual([]);
        expect(await ks.ownKcOut).toBe('none');
    });

    it('changes nothing about one that has', async () => {
        const { peer, ks } = session();
        peer.emit('connect');
        ks.quiet();
        expect(peer.sent).toEqual([honestKc('sender')]);
        expect(await ks.ownKcOut).toBe('sent');
    });
});

describe('settle', () => {
    afterEach(() => vi.useRealTimers());

    it('answers at once with a verdict already made', async () => {
        const { peer, ks } = session({ mode: 'enforce' });
        peer.emit('data', honestKc('receiver'));
        expect(await ks.settle(1000, () => false)).toBe('verified');
    });

    it('answers when the verdict comes, and leaves no timer behind', async () => {
        vi.useFakeTimers();
        const { peer, ks } = session({ mode: 'enforce' });
        const answer = ks.settle(15_000, () => false);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        peer.emit('data', honestKc('receiver', OTHER_KEY));
        expect(await answer).toBe('failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('times out at the wait, and not before', async () => {
        vi.useFakeTimers();
        const { ks } = session({ mode: 'enforce' });
        let got: unknown = null;
        void ks.settle(15_000, () => false).then((v) => {
            got = v;
        });
        await vi.advanceTimersByTimeAsync(14_999);
        expect(got).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(got).toBe('timeout');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops when the caller says so', async () => {
        vi.useFakeTimers();
        const { ks } = session({ mode: 'enforce' });
        let stopped = false;
        const answer = ks.settle(15_000, () => stopped);
        stopped = true;
        await vi.advanceTimersByTimeAsync(500);
        expect(await answer).toBe('stopped');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops at once when the caller is already stopped', async () => {
        const { ks } = session({ mode: 'enforce' });
        expect(await ks.settle(15_000, () => true)).toBe('stopped');
    });

    it('stops at the close, and answers a later call the same way', async () => {
        vi.useFakeTimers();
        const { peer, ks } = session({ mode: 'enforce' });
        const answer = ks.settle(15_000, () => false);
        peer.emit('close');
        expect(await answer).toBe('stopped');
        expect(vi.getTimerCount()).toBe(0);
        expect(await ks.settle(15_000, () => false)).toBe('stopped');
    });
});

describe('the close and dispose', () => {
    it('a close before the kc went out resolves ownKcOut with none', async () => {
        const { peer, ks } = session();
        peer.emit('close');
        expect(await ks.ownKcOut).toBe('none');
    });

    it('a close reports nothing: a dropped connection is not a failed check', () => {
        const { peer, ks, reports, verdicts } = session({ mode: 'enforce' });
        peer.emit('close');
        expect(ks.verdict()).toBe('pending');
        expect(reports).toEqual([]);
        expect(verdicts).toEqual([]);
    });

    it('dispose takes every listener off and ends every wait', async () => {
        const { peer, ks } = session({ mode: 'enforce' });
        const answer = ks.settle(15_000, () => false);
        ks.dispose();
        expect(peer.count('data')).toBe(0);
        expect(peer.count('connect')).toBe(0);
        expect(peer.count('close')).toBe(0);
        expect(await answer).toBe('stopped');
        expect(await ks.ownKcOut).toBe('none');
        expect(peer.sent).toEqual([]);
    });
});

describe('a throwing page callback', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('does not break the data stream, and does not vanish: it surfaces in a microtask', () => {
        const rethrown: Array<() => void> = [];
        vi.stubGlobal('queueMicrotask', (f: () => void) => rethrown.push(f));
        const peer = new FakePeer({ pc: pcOf(SENDER_CERT, RECEIVER_CERT) });
        const ks = createKeySession({
            peer,
            fileRole: 'sender',
            key: KEY,
            roomId: ROOM,
            mode: 'detect',
            reportRole: 'sender',
            onVerdict: () => {
                throw new Error('verdict bug');
            },
            onReport: () => {
                throw new Error('report bug');
            },
        });
        expect(() => peer.emit('data', honestKc('receiver', OTHER_KEY))).not.toThrow();
        expect(ks.verdict()).toBe('failed');
        expect(rethrown).toHaveLength(2);
        expect(() => rethrown[0]()).toThrow();
        expect(() => rethrown[1]()).toThrow();
    });
});

describe('signals', () => {
    it('are held to the description the WebRTC role expects, not the file role', () => {
        // A request-link visitor sends the file and answers.
        const visitor = session({ peer: new FakePeer({ initiator: false, pc: pcOf(SENDER_CERT, RECEIVER_CERT) }) });
        expect(visitor.ks.admitSignal({ type: 'answer', sdp: 'v=0' })).toBe(false);
        expect(visitor.ks.admitSignal({ type: 'offer', sdp: 'v=0' })).toBe(true);
        expect(visitor.ks.admitSignal({ type: 'offer', sdp: 'v=0' })).toBe(false);

        // A request-link host receives the file and offers.
        const host = session({ peer: new FakePeer({ initiator: true, pc: pcOf(RECEIVER_CERT, SENDER_CERT) }), fileRole: 'receiver' });
        expect(host.ks.admitSignal({ type: 'offer', sdp: 'v=0' })).toBe(false);
        expect(host.ks.admitSignal({ type: 'answer', sdp: 'v=0' })).toBe(true);
    });

    it('drop renegotiation, and pass candidates', () => {
        const { ks } = session();
        expect(ks.admitSignal({ renegotiate: true })).toBe(false);
        expect(ks.admitSignal({ transceiverRequest: { kind: 'audio' } })).toBe(false);
        expect(ks.admitSignal({ candidate: { candidate: 'x' } })).toBe(true);
    });
});
