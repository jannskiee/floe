import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFiles, type SenderDeps } from './sender';
import { createReceiver } from './receiver';
import { ackMessage, metadataMessage, endMessage } from './protocol';

const enc = new TextEncoder();

// Regression tests for progress truthfulness: the sender must report DELIVERED
// bytes (queued minus what still sits in the channel buffer), keep the bar
// moving while blocked on a slow drain, and switch the displayed file only
// when the receiver has acked it. The receiver must report progress on a byte
// threshold that works for any chunk size (the old exact-modulo check never
// fired with 256 KB chunks on files under 6.25 MB).

function makeFile(sizeBytes: number, name = 'test.bin'): File {
    const buf = new Uint8Array(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) buf[i] = (i * 31 + 7) % 256;
    return new File([buf], name, { type: 'application/octet-stream' });
}

// A buffer channel whose fill level the test controls: sent chunks pile up in
// bufferedAmount and only "reach the peer" when the test drains them.
function makeDrainableDeps() {
    const listeners = new Set<() => void>();
    const channel = {
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener: (_: 'bufferedamountlow', h: () => void) => { listeners.add(h); },
        removeEventListener: (_: 'bufferedamountlow', h: () => void) => { listeners.delete(h); },
    };
    let handler: ((d: Uint8Array | ArrayBuffer) => void) | null = null;
    const controls: string[] = [];
    const deps: SenderDeps = {
        send: (d) => {
            if (typeof d === 'string') controls.push(d);
            else channel.bufferedAmount += d.byteLength;
        },
        onData: (h) => {
            handler = h;
            return () => { handler = null; };
        },
        channel,
        sctpMaxMessageSize: 64 * 1024,
    };
    return {
        deps,
        controls,
        deliverAck: (id: string) => handler?.(enc.encode(ackMessage(id, 0))),
        drainTo: (amount: number) => {
            channel.bufferedAmount = amount;
            listeners.forEach((h) => h());
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('sender: delivered-bytes progress', () => {
    it('reports delivered bytes, keeps the bar moving during a slow drain, and completes only after the buffer empties', async () => {
        vi.useFakeTimers();
        const { deps, deliverAck, drainTo } = makeDrainableDeps();
        const progress: number[] = [];
        const onAllSent = vi.fn();
        const onFileStart = vi.fn();

        const SIZE = 1024 * 1024;
        const p = sendFiles(deps, [{ id: 'f1', file: makeFile(SIZE) }], {
            onProgress: (pct) => progress.push(pct),
            onFileStart,
            onAllSent,
        });

        // Metadata is out; no ack yet, so the displayed file must not switch.
        await vi.advanceTimersByTimeAsync(0);
        expect(onFileStart).not.toHaveBeenCalled();

        deliverAck('f1');
        await vi.advanceTimersByTimeAsync(0);
        expect(onFileStart).toHaveBeenCalledTimes(1);

        // The whole 1 MB is queued (below the 8 MB high-water mark) but nothing
        // has been delivered — the old queued-bytes accounting reported 100%
        // here; delivered-bytes accounting must report 0%.
        await vi.advanceTimersByTimeAsync(600);
        expect(progress[progress.length - 1]).toBe(0);
        expect(onAllSent).not.toHaveBeenCalled();

        // Half the buffer drains: the ticker must move the bar to 50% even
        // though the send loop is idle (this was the frozen-for-a-minute UI).
        drainTo(SIZE / 2);
        await vi.advanceTimersByTimeAsync(600);
        expect(progress[progress.length - 1]).toBe(50);
        expect(onAllSent).not.toHaveBeenCalled();

        // Full drain: 100% and only now "all sent".
        drainTo(0);
        await vi.advanceTimersByTimeAsync(600);
        await p;
        expect(progress[progress.length - 1]).toBe(100);
        expect(onAllSent).toHaveBeenCalledTimes(1);
    });

    it('switches the displayed file only after the receiver acks it', async () => {
        vi.useFakeTimers();
        const { deps, controls, deliverAck, drainTo } = makeDrainableDeps();
        const fileStarts: number[] = [];

        const p = sendFiles(
            deps,
            [
                { id: 'a', file: makeFile(256 * 1024, 'a.bin') },
                { id: 'b', file: makeFile(1024, 'b.bin') },
            ],
            { onFileStart: (i) => fileStarts.push(i) }
        );

        await vi.advanceTimersByTimeAsync(0);
        deliverAck('a');
        await vi.advanceTimersByTimeAsync(0);
        expect(fileStarts).toEqual([0]);

        // File a is fully queued but undelivered; b's metadata must wait for
        // the tail to drain, and b's onFileStart must wait for b's ack.
        await vi.advanceTimersByTimeAsync(1000);
        expect(controls.some((c) => c.includes('"b.bin"'))).toBe(false);
        expect(fileStarts).toEqual([0]);

        drainTo(0);
        await vi.advanceTimersByTimeAsync(300);
        expect(controls.some((c) => c.includes('"b.bin"'))).toBe(true);
        expect(fileStarts).toEqual([0]);

        deliverAck('b');
        await vi.advanceTimersByTimeAsync(0);
        expect(fileStarts).toEqual([0, 1]);

        drainTo(0);
        await vi.advanceTimersByTimeAsync(300);
        await p;
    });
});

describe('receiver: progress cadence', () => {
    it('reports progress at least every 1 MB with 256 KB chunks', () => {
        const reported: number[] = [];
        const rx = createReceiver({
            send: () => { },
            onProgress: (_pct, received) => reported.push(received),
        });

        const SIZE = 5 * 1024 * 1024;
        rx.handleMessage(enc.encode(metadataMessage('big', 'big.bin', SIZE, 1, 1, SIZE)));
        const chunk = new Uint8Array(256 * 1024); // > 1000 bytes, treated as file data
        for (let i = 0; i < 20; i++) rx.handleMessage(chunk);
        rx.handleMessage(enc.encode(endMessage()));

        // 1 MB steps plus completion, then the (0,0,0) reset on 'end'. The old
        // exact-modulo condition emitted nothing at all for this sequence.
        expect(reported).toEqual([
            1024 * 1024,
            2 * 1024 * 1024,
            3 * 1024 * 1024,
            4 * 1024 * 1024,
            5 * 1024 * 1024,
            0,
        ]);
    });
});
