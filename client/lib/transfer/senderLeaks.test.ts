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
    return {
        deps,
        deliverAck: (id: string) => handler?.(enc.encode(ackMessage(id, 0))),
        // Any receiver-to-sender frame, encoded the way a Go receiver sends it
        // (binary). A raw string rather than a typed wire interface, because
        // the consumer-map checker counts those names as peer-field tokens.
        deliverFrame: (raw: string) => handler?.(enc.encode(raw)),
    };
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
        const { deps, deliverAck, deliverFrame } = makeDeps(channel);

        const file = new File([new Uint8Array(8)], 'x.bin');
        const p = sendFiles(deps, [{ id: 'id-ack', file }], {});
        await vi.advanceTimersByTimeAsync(0);

        deliverAck('id-ack');
        await vi.advanceTimersByTimeAsync(0);
        await p;

        // The session now outlives sendFiles (F-SHA-4), so its 200 ms poll is
        // live here until the peer confirms delivery. Close the window the way
        // a real receiver does before counting timers.
        deliverFrame('{"type":"received"}');
        await vi.advanceTimersByTimeAsync(0);

        // Nothing may be left waiting to fire. Before the fix the 120s deadline
        // sat here for every file in the batch.
        expect(vi.getTimerCount()).toBe(0);
    });

    // A channel that counts its close listeners, plus an onData wrapper that
    // counts subscriptions. Shared by the two tests below, which pull the same
    // session apart from its two ends.
    function countingDeps() {
        const listeners = new Map<string, number>();
        const channel = {
            bufferedAmount: 0,
            bufferedAmountLowThreshold: 0,
            addEventListener: (type: string) => { listeners.set(type, (listeners.get(type) ?? 0) + 1); },
            removeEventListener: (type: string) => { listeners.set(type, (listeners.get(type) ?? 0) - 1); },
        };
        const made = makeDeps(channel);
        let subscribed = 0;
        const onData = made.deps.onData;
        made.deps.onData = (h) => {
            subscribed += 1;
            const off = onData(h);
            return () => { subscribed -= 1; off(); };
        };
        return { ...made, listeners, subscribed: () => subscribed };
    }

    // The session registers one data listener and one channel close listener
    // before the first metadata. On every exit that is NOT the success path
    // both must go when sendFiles returns, or a finished session keeps
    // answering frames meant for the next one.
    it('the session listener is removed when sendFiles returns on a failure path', async () => {
        vi.useFakeTimers();
        const { deps, deliverFrame, listeners, subscribed } = countingDeps();

        const p = sendFiles(deps, [{ id: 'id-leak', file: new File([new Uint8Array(8)], 'x.bin') }], {
            onError: () => {},
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(subscribed()).toBe(1);
        expect(listeners.get('close')).toBe(1);

        // A refusal instead of the ack, so the send never reaches onAllSent and
        // the finally is what closes the session.
        deliverFrame(JSON.stringify({ type: 'incompatible', reason: 'receiver stopped', pv: 1, pvMin: 1 }));
        await vi.advanceTimersByTimeAsync(0);
        await p;

        expect(subscribed()).toBe(0);
        expect(listeners.get('close')).toBe(0);
    });

    // The success path is the opposite contract (F-SHA-4): the listener stays
    // attached past onAllSent, because a CLI receiver's hash refusal lands
    // about CONTROL_FLUSH_MS after the last byte and closing here dropped it.
    it('after onAllSent the listener stays until received, close or destroy', async () => {
        vi.useFakeTimers();
        const { deps, deliverAck, deliverFrame, listeners, subscribed } = countingDeps();

        const p = sendFiles(deps, [{ id: 'id-linger', file: new File([new Uint8Array(8)], 'x.bin') }], {});
        await vi.advanceTimersByTimeAsync(0);
        deliverAck('id-linger');
        await vi.advanceTimersByTimeAsync(0);
        await p;

        expect(subscribed()).toBe(1);
        expect(listeners.get('close')).toBe(1);

        deliverFrame('{"type":"received"}');
        await vi.advanceTimersByTimeAsync(0);

        expect(subscribed()).toBe(0);
        expect(listeners.get('close')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
