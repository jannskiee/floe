// The receive engine with the link-key hooks, on a real session over a fake peer. A
// receiver that holds k takes nothing from a sender until its proof has checked out:
// no ack, no prompt, no validation, not a byte kept. Without a key every frame reads as
// it does today, and an incoming kc is dropped.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseLinkKey, type LinkKey } from '../linkKey';
import {
    PROTOCOL_VERSION,
    RECEIVER_UNVERIFIED_REASON,
    SENDER_UNVERIFIED_REASON,
    endMessage,
    incompatibleMessage,
    metadataMessage,
} from './protocol';
import { kcFrame, keyCheckTag, type CertSource } from './keyCheck';
import { createKeySession, type KeyMode, type KeyReport, type PeerLike } from './keySession';
import { createReceiver } from './receiver';

const KEY = parseLinkKey('AAECAwQFBgcICQoLDA0ODw') as LinkKey;
const OTHER_KEY = parseLinkKey('AQIDBAUGBwgJCgsMDQ4PEA') as LinkKey;
const ROOM = '6f207790-92a6-4662-bb68-4c4059f75139';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: string | Uint8Array) => (typeof b === 'string' ? b : new TextDecoder().decode(b));
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const printed = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');

const SENDER_CERT = bytes('the file sender certificate');
const RECEIVER_CERT = bytes('the file receiver certificate');

const HONEST_PC: CertSource = {
    localDescription: { sdp: `a=fingerprint:sha-256 ${printed(sha(RECEIVER_CERT))}\r\n` },
    remoteDescription: { sdp: `m=application\r\na=fingerprint:sha-256 ${printed(sha(SENDER_CERT))}\r\n` },
    sctp: { transport: { getRemoteCertificates: () => [SENDER_CERT.buffer.slice(0) as ArrayBuffer] } },
};

const senderKc = (key: LinkKey = KEY) => kcFrame(keyCheckTag(key, 'sender', ROOM, sha(SENDER_CERT), sha(RECEIVER_CERT)));
const receiverKc = () => kcFrame(keyCheckTag(KEY, 'receiver', ROOM, sha(SENDER_CERT), sha(RECEIVER_CERT)));

const REFUSAL = '{"type":"incompatible","reason":"receiver could not confirm the sender holds this link","pv":2,"pvMin":2,"code":"unverified","saved":0}';

const nodeHash = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');

function rig(o: { mode?: KeyMode; key?: LinkKey | null; pc?: CertSource | null } = {}) {
    const listeners = new Map<string, Array<(...a: never[]) => void>>();
    const sent: Array<string | Uint8Array> = [];
    const peer: PeerLike = {
        destroyed: false,
        initiator: false,
        _pc: o.pc === undefined ? HONEST_PC : o.pc,
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
        },
    };
    const reports: KeyReport[] = [];
    const ks = createKeySession({
        peer,
        fileRole: 'receiver',
        key: o.key === undefined ? KEY : o.key,
        roomId: ROOM,
        mode: o.mode ?? 'enforce',
        reportRole: 'receiver',
        onReport: (r) => reports.push(r),
    });
    const errors: string[] = [];
    const failed: Array<{ outcome: string; unavailable: boolean }> = [];
    const started: string[] = [];
    const completed: string[] = [];
    const rx = createReceiver(
        {
            send: (d) => ks.send(d),
            onError: (m) => errors.push(m),
            onFileStart: (_i, _t, name) => started.push(name),
            onFileComplete: (f) => completed.push(f.fileName),
            onKeyCheckFailed: (f) => failed.push(f),
        },
        { keyCheck: ks, hashBlob: nodeHash }
    );
    ks.onData(rx.handleMessage);
    const deliver = (frame: string | Uint8Array) => {
        for (const h of listeners.get('data') ?? []) (h as (d: unknown) => void)(frame);
    };
    return { peer, ks, rx, sent, deliver, reports, errors, failed, started, completed };
}

const META = metadataMessage('a', 'a.bin', 4, 1, 1, 4);
const FILE = new Uint8Array([1, 2, 3, 4]);

/** The frames this receiver sent, read as the sender would. */
const typesOf = (sent: Array<string | Uint8Array>) =>
    sent.map((f) => (JSON.parse(text(f)) as { type: string }).type);

describe('a receiver with no key', () => {
    function keyless() {
        const sent: Array<string | Uint8Array> = [];
        const errors: string[] = [];
        const completed: Uint8Array[] = [];
        const rx = createReceiver({
            send: (d) => sent.push(d),
            onError: (m) => errors.push(m),
            onFileComplete: (f) => {
                void f.blob.arrayBuffer().then((b) => completed.push(new Uint8Array(b)));
            },
        });
        return { rx, sent, errors, completed };
    }

    it('drops a kc: no error, no ack, and nothing written to the file', async () => {
        const h = keyless();
        h.rx.handleMessage(senderKc());
        h.rx.handleMessage('{"type":"kc","tag":7}');
        expect(h.sent).toEqual([]);
        expect(h.errors).toEqual([]);

        h.rx.handleMessage(META);
        expect(typesOf(h.sent)).toEqual(['ack']);
        // Mid-file too, where the browser used to append any unknown control string.
        h.rx.handleMessage(senderKc());
        h.rx.handleMessage(FILE);
        h.rx.handleMessage(endMessage());
        await h.rx.settled();
        await vi.waitFor(() => expect(h.completed).toHaveLength(1));
        expect([...h.completed[0]]).toEqual([...FILE]);
        expect(h.errors).toEqual([]);
    });

    it('reads a binary frame that spells a kc as file data, as framing decides (#316)', async () => {
        const h = keyless();
        const spelled = bytes(senderKc());
        h.rx.handleMessage(metadataMessage('a', 'a.json', spelled.byteLength, 1, 1, spelled.byteLength));
        h.rx.handleMessage(spelled);
        h.rx.handleMessage(endMessage());
        await h.rx.settled();
        await vi.waitFor(() => expect(h.completed).toHaveLength(1));
        expect(text(h.completed[0])).toBe(senderKc());
    });

    it('takes a keyless session as no session: its acks and frames are today\'s', async () => {
        const h = rig({ key: null });
        h.deliver(senderKc());
        h.deliver(META);
        h.deliver(FILE);
        h.deliver(endMessage());
        await h.rx.settled();
        expect(typesOf(h.sent)).toEqual(['ack', 'received']);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.failed).toEqual([]);
        expect(h.reports).toEqual([]);
    });

    it('shows a sender\'s stop for this code in the sender\'s cleaned words, as any stop', () => {
        const h = keyless();
        h.rx.handleMessage(incompatibleMessage(SENDER_UNVERIFIED_REASON, 'unverified'));
        expect(h.errors).toEqual([SENDER_UNVERIFIED_REASON]);
    });
});

describe('a receiver with the key: a good proof', () => {
    it('takes the file as usual, with its own kc in front of its first reply', async () => {
        const h = rig();
        h.deliver(senderKc());
        h.deliver(META);
        h.deliver(FILE);
        h.deliver(endMessage());
        await h.rx.settled();
        expect(typesOf(h.sent)).toEqual(['kc', 'ack', 'received']);
        expect(h.sent[0]).toBeInstanceOf(Uint8Array);
        expect(text(h.sent[0])).toBe(receiverKc());
        expect(h.completed).toEqual(['a.bin']);
        expect(h.failed).toEqual([]);
        expect(h.errors).toEqual([]);
        expect(h.reports).toEqual([]);
        expect(h.ks.verdict()).toBe('verified');
    });

    it('ignores a second kc, good or bad', async () => {
        const h = rig();
        h.deliver(senderKc());
        h.deliver(senderKc(OTHER_KEY));
        h.deliver('{"type":"kc"}');
        h.deliver(META);
        expect(typesOf(h.sent)).toEqual(['kc', 'ack']);
        expect(h.failed).toEqual([]);
    });

    it('reads an over-cap string as it always did once the proof is in', () => {
        const h = rig();
        h.deliver(senderKc());
        h.deliver('x'.repeat(1200));
        const last = JSON.parse(text(h.sent[h.sent.length - 1])) as { code: string };
        expect(last.code).toBe('path-too-long');
        expect(h.failed).toEqual([]);
        expect(h.errors).toHaveLength(1);
    });

    it('reads a hostile description as it always did once the proof is in', () => {
        const h = rig();
        h.deliver(senderKc());
        h.deliver(JSON.stringify({ type: 'metadata', id: 'a', fileName: 'a', fileSize: -1, index: 1, total: 1, totalBytes: 0 }));
        expect(h.errors).toHaveLength(1);
        expect(h.failed).toEqual([]);
    });

    it('reads a sender\'s stop for this code as a fixed outcome, never its words', () => {
        const h = rig();
        h.deliver(senderKc());
        h.deliver(META);
        h.deliver(incompatibleMessage('A HOSTILE SENTENCE', 'unverified'));
        expect(h.failed).toEqual([{ outcome: 'peer-refused', unavailable: false }]);
        expect(h.errors).toEqual([]);
        expect(h.reports.map((r) => r.outcome)).toEqual(['peer-refused']);
    });

    it('shows any other sender stop in today\'s words', () => {
        const h = rig();
        h.deliver(senderKc());
        h.deliver(META);
        h.deliver(incompatibleMessage('The sender stopped: a file could not be read on their device.'));
        expect(h.errors).toEqual(['The sender stopped: a file could not be read on their device.']);
        expect(h.failed).toEqual([]);
    });

    it('says nothing of a stop that comes after every file is here', async () => {
        const h = rig();
        h.deliver(senderKc());
        h.deliver(META);
        h.deliver(FILE);
        h.deliver(endMessage());
        await h.rx.settled();
        h.deliver(incompatibleMessage('late', 'unverified'));
        expect(h.failed).toEqual([]);
        expect(h.errors).toEqual([]);
    });
});

describe('a receiver with the key: frames that beat its subscription', () => {
    // The page subscribes at construction, so this is the belt: what a session latched
    // reaches the engine in order, and is judged as if it had just arrived.
    function latched() {
        const listeners: Array<(d: string | Uint8Array) => void> = [];
        const sent: Array<string | Uint8Array> = [];
        const failed: Array<{ outcome: string; unavailable: boolean }> = [];
        const started: string[] = [];
        const errors: string[] = [];
        const peer: PeerLike = {
            destroyed: false,
            initiator: false,
            _pc: HONEST_PC,
            _channel: { readyState: 'open' },
            on(event: string, handler: (...a: never[]) => void) {
                if (event === 'data') listeners.push(handler as (d: string | Uint8Array) => void);
                return this;
            },
            off() {
                return this;
            },
            send(frame: string | Uint8Array) {
                sent.push(frame);
            },
        };
        const ks = createKeySession({ peer, fileRole: 'receiver', key: KEY, roomId: ROOM, mode: 'enforce', reportRole: 'receiver' });
        const deliver = (frame: string | Uint8Array) => listeners.forEach((l) => l(frame));
        const subscribe = () => {
            const rx = createReceiver(
                {
                    send: (d) => ks.send(d),
                    onFileStart: (_i, _t, name) => started.push(name),
                    onKeyCheckFailed: (f) => failed.push(f),
                    onError: (m) => errors.push(m),
                },
                { keyCheck: ks, hashBlob: nodeHash }
            );
            ks.onData(rx.handleMessage);
        };
        return { deliver, subscribe, sent, failed, started, errors };
    }

    it('a good proof and a file description, kept in order', () => {
        const h = latched();
        h.deliver(senderKc());
        h.deliver(META);
        expect(h.sent).toHaveLength(1);
        h.subscribe();
        expect(typesOf(h.sent)).toEqual(['kc', 'ack']);
        expect(h.started).toEqual(['a.bin']);
        expect(h.failed).toEqual([]);
        expect(h.errors).toEqual([]);
    });

    it('a file description ahead of the proof, kept in order, is refused as it would have been', () => {
        const h = latched();
        h.deliver(META);
        h.deliver(senderKc());
        h.subscribe();
        expect(typesOf(h.sent)).toEqual(['kc', 'incompatible']);
        expect(h.started).toEqual([]);
        expect(h.failed).toEqual([{ outcome: 'missing', unavailable: false }]);
    });
});

describe('a receiver with the key: a bad proof', () => {
    const cases: Array<[string, () => string, string]> = [
        ['a tag under another key', () => senderKc(OTHER_KEY), 'bad-tag'],
        ['the receiver\'s own tag sent back', () => receiverKc(), 'bad-tag'],
        ['no tag', () => '{"type":"kc"}', 'malformed'],
        ['a tag of the wrong type', () => '{"type":"kc","tag":7}', 'malformed'],
        ['a tag of the wrong length', () => '{"type":"kc","tag":"short"}', 'malformed'],
        ['a tag that is not canonical', () => `{"type":"kc","tag":"${'A'.repeat(42)}B"}`, 'malformed'],
    ];

    for (const [name, frame, outcome] of cases) {
        it(`${name}: refuses with the code, and nothing reaches a callback that could prompt`, () => {
            const h = rig();
            h.deliver(frame());
            expect(h.sent).toHaveLength(2);
            expect(text(h.sent[0])).toBe(receiverKc());
            // BINARY, as every frame toward a sender.
            expect(h.sent[1]).toBeInstanceOf(Uint8Array);
            expect(text(h.sent[1])).toBe(REFUSAL);
            expect(h.failed).toEqual([{ outcome, unavailable: false }]);
            expect(h.errors).toEqual([]);
            expect(h.started).toEqual([]);
            expect(h.reports).toEqual([{ role: 'receiver', path: 'der', outcome, mode: 'enforce' }]);
        });
    }

    it('drops everything after the refusal', async () => {
        const h = rig();
        h.deliver(senderKc(OTHER_KEY));
        const after = h.sent.length;
        h.deliver(senderKc());
        h.deliver(META);
        h.deliver(FILE);
        h.deliver(endMessage());
        await h.rx.settled();
        expect(h.sent).toHaveLength(after);
        expect(h.failed).toHaveLength(1);
        expect(h.started).toEqual([]);
        expect(h.completed).toEqual([]);
    });

    it('shows no tag, no reason and no key anywhere a page could read', () => {
        const h = rig();
        h.deliver(senderKc(OTHER_KEY));
        const shown = JSON.stringify({ errors: h.errors, failed: h.failed, reports: h.reports });
        expect(shown).not.toContain(JSON.parse(senderKc(OTHER_KEY)).tag);
        expect(shown).not.toContain('AAECAwQFBgcICQoLDA0ODw');
    });
});

describe('a receiver with the key: no proof yet', () => {
    const frames: Array<[string, () => string | Uint8Array]> = [
        ['metadata', () => META],
        ['a description Go would refuse', () => JSON.stringify({ type: 'metadata', id: 'a', fileName: 'a', fileSize: -1, index: 1, total: 1, totalBytes: 0 })],
        ['a description from a future protocol', () => JSON.stringify({ type: 'metadata', id: 'a', fileName: 'a', fileSize: 4, index: 1, total: 1, totalBytes: 4, pv: PROTOCOL_VERSION + 5, pvMin: PROTOCOL_VERSION + 5 })],
        ['end', () => endMessage()],
        ['a sender stop in the sender\'s words', () => incompatibleMessage('A HOSTILE SENTENCE')],
        ['a binary frame', () => FILE],
        ['a binary frame that spells a valid proof', () => bytes(senderKc())],
        ['a string past the control cap', () => 'x'.repeat(1200)],
    ];

    for (const [name, frame] of frames) {
        it(`${name}: refused as missing, with no ack, no prompt and no validation answer`, async () => {
            const h = rig();
            h.deliver(frame());
            expect(h.sent).toHaveLength(2);
            expect(text(h.sent[0])).toBe(receiverKc());
            expect(text(h.sent[1])).toBe(REFUSAL);
            expect(h.failed).toEqual([{ outcome: 'missing', unavailable: false }]);
            expect(h.errors).toEqual([]);
            expect(h.started).toEqual([]);
            expect(h.reports).toEqual([{ role: 'receiver', path: 'der', outcome: 'missing', mode: 'enforce' }]);
            await h.rx.settled();
            expect(h.completed).toEqual([]);
        });
    }

    it('a proof that comes after the frame it had to come before is too late', () => {
        const h = rig();
        h.deliver(META);
        h.deliver(senderKc());
        h.deliver(META);
        expect(typesOf(h.sent)).toEqual(['kc', 'incompatible']);
        expect(h.failed).toHaveLength(1);
    });

    it('frames that were never going to start anything are still dropped, as today', () => {
        const h = rig();
        for (const frame of ['{"type":"hello"}', 'not json', '{"type":"ack","id":"a","offset":0}', '{"type":"received","verified":1}']) {
            h.deliver(frame);
        }
        expect(typesOf(h.sent)).toEqual(['kc']);
        expect(h.failed).toEqual([]);
        expect(h.errors).toEqual([]);
        expect(h.ks.verdict()).toBe('pending');
        // And the proof still counts.
        h.deliver(senderKc());
        h.deliver(META);
        expect(typesOf(h.sent)).toEqual(['kc', 'ack']);
    });
});

describe('a receiver with the key: certificates it cannot read', () => {
    const noCerts: CertSource = { localDescription: null, remoteDescription: null };

    it('refuses the first frame that needs them, says which kind of failure, and sends no kc', () => {
        for (const frame of [senderKc(), META, FILE]) {
            const h = rig({ pc: noCerts });
            h.deliver(frame);
            expect(h.sent.map(text)).toEqual([REFUSAL]);
            expect(h.failed).toEqual([{ outcome: 'unavailable', unavailable: true }]);
            expect(h.errors).toEqual([]);
            expect(h.reports).toEqual([{ role: 'receiver', path: 'none', outcome: 'unavailable', mode: 'enforce' }]);
        }
    });
});

describe('observe: a receiver under the rollback lever', () => {
    it('never stops for a bad proof, and reports it', async () => {
        const h = rig({ mode: 'observe' });
        h.deliver(senderKc(OTHER_KEY));
        h.deliver(META);
        h.deliver(FILE);
        h.deliver(endMessage());
        await h.rx.settled();
        expect(typesOf(h.sent)).toEqual(['kc', 'ack', 'received']);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.failed).toEqual([]);
        expect(h.reports.map((r) => r.outcome)).toEqual(['bad-tag']);
    });

    it('never stops for a missing proof, and reports it', async () => {
        const h = rig({ mode: 'observe' });
        h.deliver(META);
        h.deliver(FILE);
        h.deliver(endMessage());
        await h.rx.settled();
        expect(typesOf(h.sent)).toEqual(['kc', 'ack', 'received']);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.failed).toEqual([]);
        expect(h.reports.map((r) => r.outcome)).toEqual(['missing']);
    });

    it('keeps going when the certificates cannot be read', async () => {
        const h = rig({ mode: 'observe', pc: { localDescription: null, remoteDescription: null } });
        h.deliver(senderKc());
        h.deliver(META);
        h.deliver(FILE);
        h.deliver(endMessage());
        await h.rx.settled();
        expect(typesOf(h.sent)).toEqual(['ack', 'received']);
        expect(h.completed).toEqual(['a.bin']);
    });

    it('still takes an over-cap string the way it always did', () => {
        const h = rig({ mode: 'observe' });
        h.deliver('x'.repeat(1200));
        const last = JSON.parse(text(h.sent[h.sent.length - 1])) as { code: string };
        expect(last.code).toBe('path-too-long');
        expect(h.errors).toHaveLength(1);
    });
});

describe('the reason this side sends', () => {
    it('is the receiver-voiced one', () => {
        expect((JSON.parse(REFUSAL) as { reason: string }).reason).toBe(RECEIVER_UNVERIFIED_REASON);
    });
});
