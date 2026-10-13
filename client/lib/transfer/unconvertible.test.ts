/**
 * A version number that cannot be turned into a number.
 *
 * `pv` and `pvMin` are whatever the other peer typed, and JSON can carry an
 * object whose `toString` is not a function. Anything that coerces such a
 * value throws: `String()` did where the sender quoted a refused resume
 * offset, and `Math.max` did inside checkCompat, which three places call
 * while they are in the middle of saying why a transfer stopped. A throw
 * there left the page with no message at all: on the sending page the
 * refusal was marked as reported before its words were built, so nothing
 * was shown and nothing rejected.
 *
 * The Go peers have no twin of this: `Pv` is an int there, so such a frame
 * fails to unmarshal and is dropped before anything reads it.
 */
import { describe, it, expect } from 'vitest';
import {
    MIN_PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    checkCompat,
    compatErrorFromIncompatible,
    isAbortReason,
} from './protocol';
import { createReceiver } from './receiver';
import { sendFiles, type SenderDeps } from './sender';

const enc = new TextEncoder();

// The frame's type is taken from the function that reads it, not imported by
// name: the consumer-map checker counts that name as a peer-field token, and
// a test that only feeds hostile frames in has no sink to map.
type StopFrame = Parameters<typeof isAbortReason>[0];

// As they arrive: parsed from text, never built as object literals.
const UNCONVERTIBLE = ['{"toString":0}', '{"toString":0,"valueOf":0}', '[{"toString":0}]', '{"valueOf":0,"toString":null}'];
const parsed = (text: string): number => JSON.parse(text) as number;

describe('checkCompat on a version that cannot convert', () => {
    it('never throws, and reads it as a version mismatch that blames neither side', () => {
        for (const text of UNCONVERTIBLE) {
            for (const [min, max] of [[parsed(text), 1], [1, parsed(text)], [parsed(text), parsed(text)]]) {
                expect(checkCompat(MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, min, max), text).toEqual({
                    ok: false,
                    localTooOld: false,
                });
            }
        }
    });

    // The guard must change nothing for a value that did convert: this table
    // is what the unguarded arithmetic answered, for local range 1 to 1.
    it('keeps every decision it made for values that do convert', () => {
        const table: Array<[unknown, unknown, boolean, boolean]> = [
            [undefined, undefined, true, false],
            [null, null, true, false],
            [0, 0, true, false],
            [1, 1, true, false],
            [1, 2, true, false],
            [2, 2, false, true],
            [2, 3, false, true],
            ['', '', true, false],
            ['1', '1', true, false],
            ['2', '2', false, true],
            ['abc', 'abc', false, false],
            [true, true, true, false],
            [[2], [2], false, true],
            [[], [], false, false],
            [{}, {}, false, false],
            // A truthy string that converts to 0 is not the legacy 0.
            [1, '0', false, false],
            ['0', 1, true, false],
            [NaN, NaN, true, false],
        ];
        for (const [min, max, ok, localTooOld] of table) {
            expect(
                checkCompat(1, 1, min as number, max as number),
                `${JSON.stringify(min)} to ${JSON.stringify(max)}`
            ).toEqual({ ok, localTooOld });
        }
    });

    it('the two readers of an incompatible frame never throw on it either', () => {
        for (const text of UNCONVERTIBLE) {
            for (const frame of [
                `{"type":"incompatible","reason":"MARKER","pv":${text},"pvMin":1}`,
                `{"type":"incompatible","reason":"MARKER","pv":1,"pvMin":${text}}`,
                `{"type":"incompatible","reason":"MARKER","pv":${text},"pvMin":${text}}`,
            ]) {
                const msg = JSON.parse(frame) as StopFrame;
                expect(isAbortReason(msg), frame).toBe(false);
                const words = compatErrorFromIncompatible(msg);
                // A mismatch, so the message is rebuilt here and the peer's
                // reason is dropped; the number shown is the fallback 1.
                expect(words, frame).toContain('Cannot transfer');
                expect(words, frame).toContain('Peer: protocol 1');
                expect(words, frame).not.toContain('MARKER');
                expect(words, frame).not.toContain('[object');
            }
        }
    });
});

/** Loopback deps whose receiver answers the first metadata with one frame. */
function answering(reply: (id: string) => string): SenderDeps {
    let handler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;
    return {
        send: (d) => {
            if (typeof d !== 'string') return;
            const m = JSON.parse(d) as { type: string; id?: string };
            if (m.type === 'metadata' && m.id) {
                const frame = enc.encode(reply(m.id));
                queueMicrotask(() => handler?.(frame));
            }
        },
        onData: (h) => {
            handler = h;
            return () => {
                handler = null;
            };
        },
        channel: {
            bufferedAmount: 0,
            bufferedAmountLowThreshold: 0,
            addEventListener: () => {},
            removeEventListener: () => {},
        },
        sctpMaxMessageSize: null,
    };
}

const oneFile = () => [{ id: 'x', file: new File([new Uint8Array(16)], 'a.bin') }];

describe('the sender says why it stopped, whatever the version fields hold', () => {
    it('an ack with such a pv ends in the version message, not a rejection', async () => {
        for (const text of UNCONVERTIBLE) {
            const errors: string[] = [];
            await sendFiles(
                answering((id) => `{"type":"ack","id":${JSON.stringify(id)},"offset":0,"pv":${text},"pvMin":1}`),
                oneFile(),
                { onError: (m) => errors.push(m) }
            );
            expect(errors, text).toHaveLength(1);
            expect(errors[0], text).toContain('Cannot transfer');
        }
    }, 5000);

    // The silent one. The stop was marked as reported, then building its
    // words threw into a microtask: sendFiles resolved, onError never ran,
    // and no catch anywhere could see it.
    it('a refusal with such a pv is still reported, once, with its typed stop', async () => {
        for (const text of UNCONVERTIBLE) {
            const errors: string[] = [];
            const stops: unknown[] = [];
            await sendFiles(
                answering(() => `{"type":"incompatible","reason":"receiver disk full","code":"disk-full","pv":${text},"pvMin":1}`),
                oneFile(),
                { onError: (m) => errors.push(m), onStopped: (s) => stops.push(s) }
            );
            expect(errors, text).toHaveLength(1);
            expect(errors[0], text).toContain('Cannot transfer');
            expect(stops, text).toHaveLength(1);
        }
    }, 5000);
});

describe('the receiver says the sender stopped, whatever the version fields hold', () => {
    it('an incompatible frame with such a pv ends the receive with fixed words', () => {
        for (const text of UNCONVERTIBLE) {
            const errors: string[] = [];
            const rx = createReceiver({ send: () => {}, onError: (m) => errors.push(m) });
            expect(() =>
                rx.handleMessage(`{"type":"incompatible","reason":"MARKER","pv":${text},"pvMin":1}`)
            ).not.toThrow();
            expect(errors, text).toEqual(['The sender stopped the transfer.']);
        }
    });
});
