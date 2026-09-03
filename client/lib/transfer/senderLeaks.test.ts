import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFiles, type SenderDeps } from './sender';
import { ackMessage, HIGH_WATER } from './protocol';
// HIGH_WATER is 8 MB; the fixture below must exceed it or the send loop finishes
// without ever reaching waitForBuffer, and the test passes against the bug.
const OVER_HIGH_WATER = HIGH_WATER + 4 * 1024 * 1024;

const enc = new TextEncoder();

/**
 * A channel that starts empty, fills as the sender writes, and never drains.
 * That is what a receiver whose tab has closed looks like from this side: the
 * buffer climbs past HIGH_WATER and bufferedamountlow never fires again.
 *
 * Starting empty matters. Starting it already full parks the metadata
 * drainBelow instead, which has always had a destroyed() escape, so the test
 * would pass against the unfixed code without ever reaching the chunk loop.
 */
function makeFillingChannel() {
    return {
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

function makeDeps(channel: { bufferedAmount: number } & SenderDeps['channel'], fill = false) {
    let handler: ((d: Uint8Array | ArrayBuffer) => void) | null = null;
    const deps: SenderDeps = {
        send: (d) => {
            if (fill) channel.bufferedAmount += (d as Uint8Array).byteLength ?? 0;
        },
        onData: (h) => {
            handler = h;
            return () => {
                handler = null;
            };
        },
        channel,
        sctpMaxMessageSize: null,
    };
    return { deps, deliverAck: (id: string) => handler?.(enc.encode(ackMessage(id, 0))) };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('sender teardown', () => {
    // A receiver that closes its tab while the buffer sits above HIGH_WATER used
    // to strand the send for the life of the page: waitForBuffer awaited a
    // bufferedamountlow that a closed channel never fires, so sendSingleFile
    // never returned, sendFiles never reached its finally, and the 500ms
    // progress ticker plus the 4 MB read slab stayed reachable. emitView
    // early-returns on isDestroyed, so nothing showed.
    it('resolves the buffer wait when the peer is destroyed above the high-water mark', async () => {
        vi.useFakeTimers();
        const channel = makeFillingChannel();
        const { deps, deliverAck } = makeDeps(channel, true);

        let destroyed = false;
        const onAllSent = vi.fn();
        const file = new File([new Uint8Array(OVER_HIGH_WATER)], 'big.bin');

        let settled = false;
        const p = sendFiles(deps, [{ id: 'id-stuck', file }], {
            isDestroyed: () => destroyed,
            onAllSent,
        }).then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(0);
        deliverAck('id-stuck');
        // Let the loop reach the point where the buffer is over the mark.
        await vi.advanceTimersByTimeAsync(1000);
        expect(settled).toBe(false);

        destroyed = true;
        // The poll is what notices; the event never fires on a dead channel.
        await vi.advanceTimersByTimeAsync(500);
        await p;

        expect(settled).toBe(true);
        // And it must not claim success for a file that stopped short.
        expect(onAllSent).not.toHaveBeenCalled();
    });

    // The ack path used to leave its 120s timer pending, so an N-file transfer
    // held N timers each retaining its closure. Timer count is the only
    // observable: the leak has no user-visible symptom, which is why it lasted.
    it('clears the ack deadline once the ack wins the race', async () => {
        vi.useFakeTimers();
        const channel = {
            bufferedAmount: 0,
            bufferedAmountLowThreshold: 0,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        const { deps, deliverAck } = makeDeps(channel);

        const file = new File([new Uint8Array(8)], 'x.bin');
        const p = sendFiles(deps, [{ id: 'id-ack', file }], {});
        await vi.advanceTimersByTimeAsync(0);

        deliverAck('id-ack');
        await vi.advanceTimersByTimeAsync(0);
        await p;

        // Nothing may be left waiting to fire. Before the fix the 120s deadline
        // sat here for every file in the batch.
        expect(vi.getTimerCount()).toBe(0);
    });
});
