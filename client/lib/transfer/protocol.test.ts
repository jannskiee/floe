import { describe, it, expect } from 'vitest';
import {
    PROTOCOL_VERSION,
    MIN_PROTOCOL_VERSION,
    CONTROL_MSG_MAX,
    HIGH_WATER,
    LOW_WATER,
    DEFAULT_CHUNK,
    MAX_CHUNK,
    chunkSize,
    classifyControl,
    compatErrorMessage,
    peerCompatErrorMessage,
    compatErrorFromIncompatible,
    refusalCodeOf,
    REFUSAL_CODES,
    REQUEST_ACK_TIMEOUT_MS,
    REQUEST_ACK_GRACE_MS,
    normalizeSha256,
    verifiedCountOf,
    SEND_FILE_HASHES,
    type Incompatible,
    type Received,
    metadataMessage,
    ackMessage,
    endMessage,
} from './protocol';
import { sanitizeDisplayText } from '../download';

const enc = new TextEncoder();

function toUint8(s: string): Uint8Array {
    return enc.encode(s);
}

function toArrayBuffer(s: string): ArrayBuffer {
    return toUint8(s).buffer as ArrayBuffer;
}

describe('constants', () => {
    // Pinned to the Go twins ProtocolVersion / MinProtocolVersion in
    // cli/engine/transfer/protocol.go, where TestProtocolVersionPinnedToClient
    // holds the same numbers. Bump both sides together, or peers on the two
    // implementations refuse each other before any bytes move.
    it('PROTOCOL_VERSION is 1', () => expect(PROTOCOL_VERSION).toBe(1));
    it('MIN_PROTOCOL_VERSION is 1', () => expect(MIN_PROTOCOL_VERSION).toBe(1));
    it('SEND_FILE_HASHES is on, with false as the rollback lever', () => expect(SEND_FILE_HASHES).toBe(true));
    it('CONTROL_MSG_MAX is 1000', () => expect(CONTROL_MSG_MAX).toBe(1000));
    it('HIGH_WATER is 8 MB', () => expect(HIGH_WATER).toBe(8 * 1024 * 1024));
    it('LOW_WATER is 4 MB', () => expect(LOW_WATER).toBe(4 * 1024 * 1024));
    // Pinned to VisitorAckTimeout and VisitorAckGrace in
    // cli/engine/transfer/deadlines.go, where TestDeadlineConstantsMatchTS
    // holds the same numbers. The deciding side's window is their difference
    // and the waiting side's timer their sum, so moving one side alone would
    // let the "expired" frame race the waiting side's own timeout.
    it('REQUEST_ACK_TIMEOUT_MS and REQUEST_ACK_GRACE_MS match VisitorAckTimeout and VisitorAckGrace', () => {
        expect(REQUEST_ACK_TIMEOUT_MS).toBe(600000);
        expect(REQUEST_ACK_GRACE_MS).toBe(15000);
        expect(REQUEST_ACK_TIMEOUT_MS - REQUEST_ACK_GRACE_MS).toBe(585000);
    });
});

describe('chunkSize', () => {
    it('returns DEFAULT_CHUNK when no sctp max', () => {
        expect(chunkSize()).toBe(DEFAULT_CHUNK);
        expect(chunkSize(undefined)).toBe(DEFAULT_CHUNK);
        expect(chunkSize(null)).toBe(DEFAULT_CHUNK);
        expect(chunkSize(0)).toBe(DEFAULT_CHUNK);
    });

    it('clamps to MAX_CHUNK when sctp max is huge', () => {
        expect(chunkSize(Infinity)).toBe(DEFAULT_CHUNK); // Infinity is not finite
        expect(chunkSize(1_000_000)).toBe(MAX_CHUNK);
    });

    it('uses sctp max when within bounds', () => {
        expect(chunkSize(128 * 1024)).toBe(128 * 1024);
    });

    it('uses sctp max when it is less than DEFAULT_CHUNK', () => {
        expect(chunkSize(16 * 1024)).toBe(16 * 1024);
    });
});

describe('message builders round-trip', () => {
    it('metadataMessage parses back correctly', () => {
        const raw = metadataMessage('abc', 'file.txt', 1024, 1, 3, 3072);
        const msg = JSON.parse(raw);
        expect(msg).toMatchObject({ type: 'metadata', id: 'abc', fileName: 'file.txt', fileSize: 1024, index: 1, total: 3 });
    });

    it('ackMessage parses back correctly', () => {
        const raw = ackMessage('xyz', 512);
        const msg = JSON.parse(raw);
        expect(msg).toMatchObject({ type: 'ack', id: 'xyz', offset: 512 });
    });

    it('endMessage parses back correctly', () => {
        const raw = endMessage();
        const msg = JSON.parse(raw);
        expect(msg).toMatchObject({ type: 'end' });
    });
});

describe('compatErrorMessage', () => {
    it('cleans the peer-supplied version string', () => {
        // The peer's ver lands in the error banner, so a bidi override or an
        // escape inside it is dropped before the message is built.
        const msg = compatErrorMessage(false, '', 'v2\u202e\u001b', 1, 1, 1, 1);
        expect(msg).toContain('v2');
        expect(msg).not.toContain('\u202e');
        expect(msg).not.toContain('\u001b');
    });
    it('cleans the peer version wherever it lands in the arguments', () => {
        // peerCompatErrorMessage swaps the two version strings, so the
        // peer-supplied one arrives in the localVer slot. Sanitizing by
        // argument position rather than by both would put an unmapped peer
        // string on the wire. Go maps both for the same reason.
        const msg = peerCompatErrorMessage(true, '', 'v2\u202e\u001b', 1, 1, 2, 2);
        expect(msg).toContain('v2');
        expect(msg).not.toContain('\u202e');
        expect(msg).not.toContain('\u001b');
    });
});

/**
 * The wire half of the same mismatch. These mirror the two
 * peerCompatErrorMessage assertions in TestCompatErrorMessage
 * (cli/engine/transfer/protocol_test.go), so both implementations pin the same
 * sentences and a drift in either shows up as a failing test rather than as a
 * peer being told the wrong side is old.
 */
describe('peerCompatErrorMessage', () => {
    it('tells an older peer that its own floe is the old one', () => {
        const msg = peerCompatErrorMessage(false, 'v2.0.0', 'v1.5.5', 2, 2, 1, 1);
        expect(msg).toContain('your floe is too old');
        expect(msg).toContain('You: protocol 1 (v1.5.5)  Peer: protocol 2 (v2.0.0)');
        expect(msg).toContain('Update Floe to continue.');
    });

    it('tells a newer peer that our side is the old one', () => {
        const msg = peerCompatErrorMessage(true, 'v1.5.5', 'v2.0.0', 1, 1, 2, 2);
        expect(msg).toContain("peer's floe is too old");
        expect(msg).toContain('You: protocol 2 (v2.0.0)  Peer: protocol 1 (v1.5.5)');
        expect(msg).toContain('Ask the other side to update Floe.');
    });

    it('never puts browser-specific prose on the wire', () => {
        // The whole point of the function. The reader may be running the CLI
        // or the desktop app, where "your browser" is wrong and refreshing a
        // page is not a thing. A naive flip into compatErrorMessage fails
        // exactly here.
        for (const localTooOld of [true, false]) {
            const msg = peerCompatErrorMessage(localTooOld, '', 'v2.0.0', 1, 1, 2, 2);
            expect(msg).not.toContain('browser');
            expect(msg).not.toContain('Refresh the page');
            expect(msg).not.toContain('floe update');
        }
    });

    it('keeps the two-space indent that survives a reader stripping newlines', () => {
        // Not cosmetic. sanitizeDisplayText removes control characters, and a
        // newline is one, so a browser peer displaying this verbatim loses
        // every line break. The two spaces are what keep the sentences apart.
        const msg = peerCompatErrorMessage(false, '', 'v2.0.0', 1, 1, 2, 2);
        expect(msg).toContain('\n  You: ');
        expect(msg).toContain('\n  Update Floe to continue.');
        expect(sanitizeDisplayText(msg, 300)).toContain('.  You: ');
    });

    it('omits an empty version instead of printing empty parentheses', () => {
        const msg = peerCompatErrorMessage(true, '', '', 1, 1, 2, 2);
        expect(msg).not.toContain('()');
    });
});

describe('compatErrorFromIncompatible', () => {
    it('rebuilds a version mismatch instead of trusting the reason', () => {
        // The reason was written by the other side, for the other side. Read
        // back as sent it would tell this browser that the peer is too old,
        // when in fact this browser is.
        const msg = compatErrorFromIncompatible({
            type: 'incompatible',
            reason:
                "Cannot transfer: peer's floe is too old.\n  You: protocol 2 (1.11.0)  Peer: protocol 1\n  Ask the other side to update Floe.",
            pv: 2,
            pvMin: 2,
            ver: '1.11.0',
        });
        expect(msg).toContain('your browser is running an older version of Floe');
        expect(msg).toContain('Refresh the page to get the latest version.');
        expect(msg).toContain('Peer: protocol 2 (1.11.0)');
        expect(msg).not.toContain('Ask the other side');
    });

    it('prints a deliberate abort verbatim, because its range overlaps ours', () => {
        // The #429 contract: an overlapping range means the frame is not about
        // versions at all, and the reason is the only account of what happened.
        const reason = 'Transfer blocked: relay connections are capped at 2 GB.';
        expect(
            compatErrorFromIncompatible({
                type: 'incompatible',
                reason,
                pv: PROTOCOL_VERSION,
                pvMin: MIN_PROTOCOL_VERSION,
            })
        ).toBe(reason);
    });

    it('falls back when a legacy peer sent no reason at all', () => {
        expect(compatErrorFromIncompatible({ type: 'incompatible', reason: '' })).toBe(
            'The other side rejected the transfer.'
        );
    });
});

/**
 * `code` is whatever the peer typed: classifyControl casts, it does not check.
 * refusalCodeOf is the one reader, so it alone decides what counts as a code.
 */
describe('refusalCodeOf', () => {
    // Built the way a real frame arrives, through classifyControl, so the cast
    // under test is the one production code sees.
    function frame(code: unknown): Incompatible {
        const text = JSON.stringify({
            type: 'incompatible',
            reason: 'receiver could not finish writing a file',
            pv: PROTOCOL_VERSION,
            pvMin: MIN_PROTOCOL_VERSION,
            code,
            saved: 1,
        });
        return classifyControl(toUint8(text)) as Incompatible;
    }

    // The literal RefusalCodes pins in cli/engine/transfer/refusal.go
    // (TestRefusalCodeListMatchesTS), in the byte order of the wire values, so
    // the two lists are compared whole and in order, never sorted first.
    const TWELVE = [
        'declined',
        'disk-full',
        'expired',
        'file-too-large-for-folder',
        'hash-mismatch',
        'over-approved',
        'path-too-long',
        'relay-cap',
        'save-blocked',
        'stopped',
        'time-limit',
        'write-failed',
    ];

    it('REFUSAL_CODES pins the twelve codes in the same order as refusal.go', () => {
        expect([...REFUSAL_CODES]).toEqual(TWELVE);
        expect([...TWELVE].sort()).toEqual(TWELVE);
    });

    it('refusalCodeOf allowlists and returns null for anything else', () => {
        for (const code of TWELVE) {
            expect(refusalCodeOf(frame(code))).toBe(code);
        }

        const hostile: unknown[] = [
            'too-slow', // never a code: the throughput floor was cut (E-24)
            'WRITE-FAILED',
            'write-failed ',
            '',
            7,
            true,
            null,
            {},
            { code: 'write-failed' },
            ['write-failed'],
            '__proto__',
            'constructor',
            'toString',
            'hasOwnProperty',
        ];
        for (const code of hostile) {
            expect(refusalCodeOf(frame(code))).toBeNull();
        }
        // Absent: the shape every peer that predates the field sends.
        expect(refusalCodeOf({ type: 'incompatible', reason: 'x', pv: 1, pvMin: 1 })).toBeNull();
        // A parsed "__proto__" KEY must not smuggle a code in through the prototype.
        const protoKey = classifyControl(
            toUint8('{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"__proto__":{"code":"write-failed"}}')
        ) as Incompatible;
        expect(refusalCodeOf(protoKey)).toBeNull();
    });
});

/**
 * pv and pvMin arrive from the peer with no more type safety than fileSize had
 * before normalizeFileSize. They reach an error banner and, through
 * peerCompatErrorMessage, the wire, so they need the same treatment reason and
 * ver already get.
 */
describe('peer-supplied protocol numbers are display-safe', () => {
    // A string pv makes checkCompat compute NaN, so the ranges "miss" and the
    // rebuild path runs. Before the coercion that path printed the string.
    const hostile = {
        type: 'incompatible' as const,
        reason: '',
        pvMin: 1,
        pv: '‮' + 'A'.repeat(400),
    };

    it('never prints a peer-supplied protocol number verbatim', () => {
        const msg = compatErrorFromIncompatible(hostile as unknown as Incompatible);
        expect(msg).not.toContain('‮');
        expect(msg).not.toContain('AAAA');
    });

    it('keeps the banner inside the cap every other peer string respects', () => {
        const msg = compatErrorFromIncompatible(hostile as unknown as Incompatible);
        expect(msg.length).toBeLessThanOrEqual(300);
    });

    it('does not reflect a hostile protocol number back onto the wire', () => {
        // peerCompatErrorMessage builds the reason a browser receiver sends, and
        // incompatibleMessage only trims when the frame passes 1000 bytes, so a
        // short hostile value would ride out untouched.
        const wire = peerCompatErrorMessage(
            false, '', 'v2.0.0',
            MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
            'x‮' as unknown as number, 2
        );
        expect(wire).not.toContain('‮');
        expect(wire).toContain('protocol');
    });

    it('falls back to 1, the same value a missing number already means', () => {
        // checkCompat treats 0 and undefined as the legacy protocol 1, so the
        // display agrees rather than inventing a second convention.
        for (const bad of [0, -3, 1.5, NaN, Infinity, null, undefined, '2', {}]) {
            const msg = compatErrorMessage(
                false, '', '',
                MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
                bad as unknown as number, bad as unknown as number
            );
            expect(msg).toContain('Peer: protocol 1');
        }
    });

    it('still prints a legitimate protocol number', () => {
        const msg = compatErrorMessage(false, '', '', 1, 1, 2, 7);
        expect(msg).toContain('Peer: protocol 2-7');
    });
});

describe('classifyControl', () => {
    it('classifies metadata', () => {
        const raw = metadataMessage('id1', 'a.txt', 100, 1, 1, 100);
        const result = classifyControl(toUint8(raw));
        expect(result?.type).toBe('metadata');
    });

    it('classifies ack', () => {
        const result = classifyControl(toUint8(ackMessage('id2', 0)));
        expect(result?.type).toBe('ack');
    });

    it('classifies end', () => {
        const result = classifyControl(toUint8(endMessage()));
        expect(result?.type).toBe('end');
    });

    it('returns null for binary data > CONTROL_MSG_MAX', () => {
        const big = new Uint8Array(CONTROL_MSG_MAX + 1).fill(65);
        expect(classifyControl(big)).toBeNull();
    });

    it('returns null for binary data that does not start with {', () => {
        const data = toUint8('hello world');
        expect(classifyControl(data)).toBeNull();
    });

    it('returns null for valid JSON but unknown type', () => {
        const data = toUint8(JSON.stringify({ type: 'unknown' }));
        expect(classifyControl(data)).toBeNull();
    });

    it('returns null for invalid JSON starting with {', () => {
        const data = toUint8('{not valid json');
        expect(classifyControl(data)).toBeNull();
    });

    it('returns null for exactly 1001 bytes of JSON-looking data', () => {
        // Pad to 1001 bytes — over the limit even if it looks like JSON
        const base = '{"type":"metadata","id":"' + 'x'.repeat(980) + '"}';
        const padded = toUint8(base.slice(0, CONTROL_MSG_MAX + 1));
        expect(classifyControl(padded)).toBeNull();
    });

    it('treats a small binary chunk that happens to look like JSON as file data (null)', () => {
        // A 999-byte payload that is valid JSON but has type "data" — should be null
        const payload = JSON.stringify({ type: 'data', bytes: 'x'.repeat(900) });
        expect(classifyControl(toUint8(payload.slice(0, 999)))).toBeNull();
    });

    it('accepts an ArrayBuffer as well as Uint8Array', () => {
        const buf = toArrayBuffer(endMessage());
        expect(classifyControl(buf)?.type).toBe('end');
    });
});

describe('per-file SHA-256 fields', () => {
    const good = '0123456789abcdef'.repeat(4);

    it('normalizeSha256 accepts only 64 lowercase hex', () => {
        expect(normalizeSha256(good)).toBe(good);
        // JSON escapes are undone by the parse, as in the Go engine.
        expect(normalizeSha256((JSON.parse('{"sha256":"\\u0030' + good.slice(1) + '"}') as { sha256: unknown }).sha256)).toBe(good);
        for (const bad of [good.toUpperCase(), good.slice(0, 63), good + '0', good.slice(0, 63) + 'g', '', ' ' + good, 3, null, undefined, true, {}, [good]]) {
            expect(normalizeSha256(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it('endMessage omits sha256 without a valid digest', () => {
        for (const bad of [undefined, null, good.toUpperCase(), good.slice(0, 63)]) {
            expect(endMessage(bad)).toBe('{"type":"end"}');
        }
        const hashed = endMessage(good);
        // type first: the transfer audit's hashbad cells match this prefix.
        expect(hashed.startsWith('{"type":"end","sha256":"')).toBe(true);
        expect(JSON.parse(hashed)).toEqual({ type: 'end', sha256: good });
        expect(enc.encode(hashed).byteLength).toBe(90);
    });

    it('verifiedCountOf rejects non-integers and out-of-range', () => {
        const of = (v: unknown) => verifiedCountOf({ type: 'received', verified: v } as Received, 3);
        expect(of(0)).toBe(0);
        expect(of(3)).toBe(3);
        for (const bad of [-1, 4, 3.5, '3', 2 ** 53, Infinity, NaN, null, true, [3], undefined]) {
            expect(of(bad), String(bad)).toBeNull();
        }
    });
});

describe('classifyControl and JSON whitespace', () => {
    it('classifyControl accepts leading JSON whitespace', () => {
        for (const lead of [' ', '\t', '\r\n', '\n  ']) {
            expect(classifyControl(lead + '{"type":"end"}')?.type, JSON.stringify(lead)).toBe('end');
        }
        // Only the four JSON whitespace characters count, as in the Go engine.
        expect(classifyControl(' {"type":"end"}')).toBeNull();
        expect(classifyControl('x{"type":"end"}')).toBeNull();
        expect(classifyControl('   ')).toBeNull();
    });
});
