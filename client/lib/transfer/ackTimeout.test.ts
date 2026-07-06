import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFiles, type SenderDeps } from './sender';
import { ackMessage, ACK_TIMEOUT_MS } from './protocol';

const enc = new TextEncoder();

// No-op buffer channel — backpressure is never engaged in these tests
// (bufferedAmount stays at 0, well below HIGH_WATER).
function makeBufferChannel() {
    return {
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

// Builds SenderDeps that capture the receiver-side data handler so the test can
// deliver (or withhold) the ack on its own schedule. `send` is a black hole:
// the file bytes go nowhere, which is fine because we only care about the ack
// handshake, not reassembly.
function makeDeps() {
    let handler: ((d: Uint8Array | ArrayBuffer) => void) | null = null;
    const deps: SenderDeps = {
        send: () => {},
        onData: (h) => {
            handler = h;
            return () => { handler = null; };
        },
        channel: makeBufferChannel(),
        sctpMaxMessageSize: null,
    };
    return { deps, deliverAck: (id: string) => handler?.(enc.encode(ackMessage(id, 0))) };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('sender ack timeout', () => {
    it('proceeds when the ack arrives after 30s (slow interactive CLI accept)', async () => {
        vi.useFakeTimers();
        const { deps, deliverAck } = makeDeps();
        const onError = vi.fn();

        const file = new File([new Uint8Array(8)], 'x.bin');
        const p = sendFiles(deps, [{ id: 'id-slow', file }], { onError });

        // Flush the synchronous setup so metadata is sent and the ack handler is
        // registered before any timers advance.
        await vi.advanceTimersByTimeAsync(0);

        // 30s elapses without an ack — under the 120s deadline, so no timeout yet.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(onError).not.toHaveBeenCalled();

        // Receiver finally accepts; the transfer should run to completion.
        deliverAck('id-slow');
        await vi.advanceTimersByTimeAsync(0);
        await p;

        expect(onError).not.toHaveBeenCalled();
    });

    it('times out with the expected message when no ack ever arrives', async () => {
        vi.useFakeTimers();
        const { deps } = makeDeps();
        const onError = vi.fn();

        const file = new File([new Uint8Array(8)], 'x.bin');
        const p = sendFiles(deps, [{ id: 'id-never', file }], { onError });

        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
        await p;

        expect(onError).toHaveBeenCalledWith(
            expect.stringContaining('timed out waiting for receiver')
        );
    });
});
