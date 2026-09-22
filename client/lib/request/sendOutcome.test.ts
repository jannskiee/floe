import { describe, it, expect } from 'vitest';
import { watchSend, firstStringFrame } from './sendOutcome';
import { sendFiles, type SenderDeps } from '../transfer/sender';
import { ackMessage } from '../transfer/protocol';

// The S1-WEB-07 review's M-1, as a property of the page: three sender exits
// report through onError alone and then resolve the send normally, and two of
// them are driven by values the host controls on its ack. The page reads a
// settlement with no onAllSent, onStopped or onFailed as Lost (E31), and it
// learns that from watchSend. These tests drive the REAL sendFiles into those
// exits, so the detector is proved against the thing it detects.

const enc = new TextEncoder();

/** A loopback host that answers the first metadata frame with `answer(id)`. */
function hostThatAnswers(answer: (id: string) => string) {
    let handler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;
    const strings: string[] = [];
    const deps: SenderDeps = {
        send: (d) => {
            if (typeof d !== 'string') return;
            strings.push(d);
            const parsed = JSON.parse(d) as { type: string; id?: string };
            if (parsed.type === 'metadata' && parsed.id) {
                const id = parsed.id;
                queueMicrotask(() => handler?.(enc.encode(answer(id))));
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
        hashBlob: async () => null,
    };
    return { deps, strings };
}

const files = () => [{ id: 'f1', file: new File([new Uint8Array(8)], 'a.bin'), relativePath: 'dir/a.bin' }];

describe('watchSend', () => {
    it('a range-miss ack settles the send silently, and the page reads it as silent', async () => {
        const { deps } = hostThatAnswers((id) => JSON.stringify({ type: 'ack', id, offset: 0, pv: 99, pvMin: 99 }));
        const errors: string[] = [];
        const acks: number[] = [];
        const watch = watchSend({ onError: (m) => errors.push(m), onAck: (i) => acks.push(i) });
        await sendFiles(deps, files(), watch.callbacks, { requireReceived: true, sendHashes: false });
        // The ack was matched, so onAck fired, and then the version check
        // stopped the send with onError only.
        expect(acks).toEqual([1]);
        expect(errors).toHaveLength(1);
        expect(watch.reported()).toBe(false);
    });

    it('an unusable resume offset settles the send silently too', async () => {
        const { deps } = hostThatAnswers((id) => JSON.stringify({ type: 'ack', id, offset: -1 }));
        const watch = watchSend({});
        await sendFiles(deps, files(), watch.callbacks, { requireReceived: true, sendHashes: false });
        expect(watch.reported()).toBe(false);
    });

    it('onAllSent, onStopped and onFailed each count as reported, and pass through', async () => {
        const seen: string[] = [];
        const a = watchSend({ onAllSent: () => seen.push('all') });
        a.callbacks.onAllSent?.();
        expect(a.reported()).toBe(true);

        const b = watchSend({ onStopped: () => seen.push('stopped') });
        b.callbacks.onStopped?.({ code: null, saved: 0, rangeOverlaps: true });
        expect(b.reported()).toBe(true);

        const c = watchSend({ onFailed: () => seen.push('failed') });
        c.callbacks.onFailed?.({ kind: 'closed', index: 1 });
        expect(c.reported()).toBe(true);

        expect(seen).toEqual(['all', 'stopped', 'failed']);
    });

    it('a refusal from the real sender counts as reported', async () => {
        const { deps } = hostThatAnswers(() =>
            JSON.stringify({ type: 'incompatible', reason: 'x', pv: 1, pvMin: 1, code: 'declined' })
        );
        const watch = watchSend({});
        await sendFiles(deps, files(), watch.callbacks, { requireReceived: true, sendHashes: false });
        expect(watch.reported()).toBe(true);
    });

    it('onReceived and onDelivered are claims, not endings', () => {
        const watch = watchSend({});
        watch.callbacks.onReceived?.();
        watch.callbacks.onDelivered?.({ files: 1, verified: 1, allVerified: true });
        expect(watch.reported()).toBe(false);
    });
});

describe('firstStringFrame', () => {
    it('reports the first metadata frame once, after it was handed to the channel', async () => {
        const { deps, strings } = hostThatAnswers((id) => ackMessage(id, 0));
        let firstAt = -1;
        let calls = 0;
        const send = firstStringFrame(deps.send, () => {
            calls++;
            firstAt = strings.length;
        });
        const received = sendFiles({ ...deps, send }, files(), {}, { sendHashes: false });
        await received;
        expect(calls).toBe(1);
        // Called after the frame reached the channel, never before it.
        expect(firstAt).toBe(1);
        expect(JSON.parse(strings[0]).type).toBe('metadata');
    });

    it('a send that throws reports nothing', () => {
        let calls = 0;
        const send = firstStringFrame(() => {
            throw new Error('closed');
        }, () => calls++);
        expect(() => send('{"type":"metadata"}')).toThrow('closed');
        expect(calls).toBe(0);
        // Binary frames are file data and never the first metadata.
        const send2 = firstStringFrame(() => {}, () => calls++);
        send2(new Uint8Array(1));
        expect(calls).toBe(0);
        send2('{}');
        send2('{}');
        expect(calls).toBe(1);
    });
});
