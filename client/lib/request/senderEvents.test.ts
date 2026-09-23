import { describe, it, expect } from 'vitest';
import { senderEvents } from './senderEvents';
import type { SenderCallbacks } from '../transfer/sender';
import type { VisitorEvent } from './visitorState';

// WP-W1 review F2: the carried rules pinned at the mapping, not only at the
// reducer. A mutation that wired onDelivered to Delivered used to leave every
// test green.

function harness() {
    const log: string[] = [];
    const events: VisitorEvent[] = [];
    const cb = senderEvents({
        dispatch: (e) => {
            log.push(`emit:${e.type}`);
            events.push(e);
        },
        now: () => 42,
        isDestroyed: () => false,
        onWireVerdict: () => log.push('latch'),
    });
    return { cb, log, events };
}

/** Call every callback the sender has with plausible arguments. */
function fireAll(cb: SenderCallbacks) {
    cb.onFileStart?.(0, 3, 'a.bin');
    cb.onProgress?.(50);
    cb.onSpeed?.(1000, 30);
    cb.onSpeedReset?.();
    cb.onError?.('text a peer may have chosen');
    cb.onAck?.(1);
    cb.onReceived?.();
    cb.onDelivered?.({ files: 3, verified: 3, allVerified: true });
    cb.onStopped?.({ code: 'disk-full', saved: 1, rangeOverlaps: true });
    cb.onFailed?.({ kind: 'closed', index: 3 });
    cb.onAllSent?.();
}

describe('sender callbacks to visitor events', () => {
    it('onDelivered only reports the verified count and never ends the drop', () => {
        const { cb, events } = harness();
        cb.onDelivered?.({ files: 3, verified: 3, allVerified: true });
        expect(events).toEqual([{ type: 'VERIFIED_COUNT', verifiedCount: 3 }]);
        cb.onDelivered?.({ files: 3, verified: null, allVerified: false });
        expect(events[1]).toEqual({ type: 'VERIFIED_COUNT', verifiedCount: null });
    });

    it('onReceived, onError and onFileStart are not mapped', () => {
        const { cb } = harness();
        expect(cb.onReceived).toBeUndefined();
        expect(cb.onError).toBeUndefined();
        expect(cb.onFileStart).toBeUndefined();
    });

    it('Delivered (RECEIVED) comes from onAllSent and from nothing else', () => {
        const { cb, events } = harness();
        fireAll(cb);
        const received = events.filter((e) => e.type === 'RECEIVED');
        expect(received).toEqual([{ type: 'RECEIVED', now: 42 }]);
        // And it is the last thing fireAll called, so nothing before it made one.
        expect(events[events.length - 1].type).toBe('RECEIVED');
        const { cb: again, events: none } = harness();
        again.onDelivered?.({ files: 3, verified: 3, allVerified: true });
        again.onAck?.(3);
        again.onProgress?.(100);
        expect(none.some((e) => e.type === 'RECEIVED')).toBe(false);
    });

    it('a refusal sets the wire latch before its event', () => {
        const { cb, log, events } = harness();
        cb.onStopped?.({ code: 'time-limit', saved: 2, rangeOverlaps: true });
        expect(log).toEqual(['latch', 'emit:INCOMPATIBLE']);
        expect(events[0]).toEqual({ type: 'INCOMPATIBLE', refusal: 'time-limit', savedCount: 2, rangeOverlaps: true });
    });

    it('onFailed maps its three kinds, with the sender\'s own index', () => {
        const { cb, events } = harness();
        cb.onFailed?.({ kind: 'ack-timeout', index: 1 });
        cb.onFailed?.({ kind: 'unreadable', index: 2 });
        cb.onFailed?.({ kind: 'closed', index: 3 });
        expect(events).toEqual([
            { type: 'ACK_TIMEOUT', index: 1 },
            { type: 'UNREADABLE', index: 2 },
            { type: 'CHANNEL_CLOSED' },
        ]);
    });

    it('acks, progress and speed carry only the sender\'s own numbers', () => {
        const { cb, events } = harness();
        cb.onAck?.(2);
        cb.onProgress?.(48);
        cb.onSpeed?.(1000, 30);
        expect(events).toEqual([
            { type: 'ACK', index: 2, now: 42 },
            { type: 'PROGRESS', percent: 48 },
            { type: 'PROGRESS', bytesPerSec: 1000, etaSeconds: 30 },
        ]);
    });

    it('isDestroyed is the page\'s own, passed through', () => {
        let dead = false;
        const cb = senderEvents({ dispatch: () => {}, now: () => 0, isDestroyed: () => dead, onWireVerdict: () => {} });
        expect(cb.isDestroyed?.()).toBe(false);
        dead = true;
        expect(cb.isDestroyed?.()).toBe(true);
    });
});
