import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
    createReceiver,
    STORAGE_FULL_MESSAGE,
    SPILL_BYTES,
    type ReceivedFile,
    type ReceiverDeps,
} from './receiver';
import { metadataMessage, endMessage, ackConfirmsOf, RECEIVER_CONFIRMS, type Ack } from './protocol';

// The browser receiver's half of FT-GO-CONFIRMS (SG-01): its acks promise a
// `received` frame, and it keeps the promise once every file of a batch is
// handed over and every part of it has read back. A Go sender (1.11.0 and
// later) that reads the promise waits for that frame instead of a drained
// buffer, so a refusal this side sends after the last byte (a SHA-256 that
// did not match, a part the browser could not keep) reaches it, and the
// close no longer races it. The sender's side is requirereceived_test.go.
describe('receiver: confirms delivery to the sender', () => {
    const RealBlob = Blob;
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const nodeHash = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
    const digestOf = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

    function payload(n: number, seed = 1): Uint8Array {
        const b = new Uint8Array(n);
        for (let i = 0; i < n; i++) b[i] = ((i * 7 + seed) % 250) + 1; // never starts with '{'
        return b;
    }

    function harness(deps: ReceiverDeps = { hashBlob: nodeHash }, send?: (d: string | Uint8Array) => void) {
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const completed: ReceivedFile[] = [];
        const allComplete: Array<[number, number]> = [];
        const rx = createReceiver(
            {
                send: send ?? ((d) => sent.push(d)),
                onFileComplete: (f) => completed.push(f),
                onAllComplete: (b, c) => allComplete.push([b, c]),
                onError: (m) => errors.push(m),
            },
            deps
        );
        const decode = (d: string | Uint8Array) =>
            JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)) as Record<string, unknown>;
        const frames = () => sent.map(decode);
        const received = () => frames().filter((f) => f.type === 'received');
        const acks = () => frames().filter((f) => f.type === 'ack');
        return { rx, sent, errors, completed, allComplete, frames, received, acks };
    }

    function feed(h: ReturnType<typeof harness>, id: string, data: Uint8Array, index: number, total: number, end = endMessage()) {
        h.rx.handleMessage(metadataMessage(id, `${id}.bin`, data.byteLength, index, total, 0));
        for (let off = 0; off < data.byteLength; off += 256 * 1024) h.rx.handleMessage(data.subarray(off, off + 256 * 1024));
        h.rx.handleMessage(end);
    }

    it('is on in this build', () => {
        // The rollback lever. A change to it is a change to what every Go
        // sender does against this page, so it is pinned.
        expect(RECEIVER_CONFIRMS).toBe(true);
    });

    it('promises received on every ack', async () => {
        const h = harness();
        feed(h, 'a', payload(10), 1, 2);
        await h.rx.settled();
        feed(h, 'b', payload(20), 2, 2);
        await h.rx.settled();
        const acks = h.acks();
        expect(acks).toHaveLength(2);
        for (const ack of acks) {
            expect(ack.confirms).toBe(true);
            expect(ackConfirmsOf(ack as unknown as Ack)).toBe(true);
        }
    });

    it('sends received once, as the last frame, after the last file of a batch', async () => {
        const h = harness();
        feed(h, 'a', payload(100), 1, 3);
        await h.rx.settled();
        feed(h, 'b', payload(200), 2, 3);
        await h.rx.settled();
        expect(h.received()).toEqual([]);
        feed(h, 'c', payload(300), 3, 3);
        await h.rx.settled();
        expect(h.completed).toHaveLength(3);
        expect(h.received()).toEqual([{ type: 'received', verified: 0 }]);
        // Binary, as a Go receiver sends it, and the exact bytes Go marshals.
        const last = h.sent[h.sent.length - 1];
        expect(typeof last).not.toBe('string');
        expect(new TextDecoder().decode(last as Uint8Array)).toBe('{"type":"received","verified":0}');
        expect(h.errors).toEqual([]);
    });

    it('counts this batch\'s matched files, and 0 is sent', async () => {
        const h = harness();
        const a = payload(4000, 1);
        const b = payload(5000, 2);
        feed(h, 'a', a, 1, 3, endMessage(digestOf(a)));
        await h.rx.settled();
        feed(h, 'b', b, 2, 3); // no digest: kept, not counted
        await h.rx.settled();
        feed(h, 'c', payload(10, 3), 3, 3, endMessage(digestOf(payload(10, 3))));
        await h.rx.settled();
        expect(h.received()).toEqual([{ type: 'received', verified: 2 }]);

        // The count starts again with the next batch.
        feed(h, 'd', payload(7), 1, 1);
        await h.rx.settled();
        expect(h.received()).toEqual([
            { type: 'received', verified: 2 },
            { type: 'received', verified: 0 },
        ]);
    });

    it('goes by its own count, never by the index the sender typed', async () => {
        // One file announced as the last of three is not the end of a batch:
        // a Go receiver waits for its own count to reach total the same way.
        const h = harness();
        feed(h, 'x', payload(64), 3, 3);
        await h.rx.settled();
        expect(h.completed).toHaveLength(1);
        expect(h.received()).toEqual([]);
        expect(h.allComplete).toEqual([]);
        feed(h, 'y', payload(64, 2), 3, 3);
        await h.rx.settled();
        feed(h, 'z', payload(64, 3), 3, 3);
        await h.rx.settled();
        expect(h.received()).toEqual([{ type: 'received', verified: 0 }]);
        expect(h.allComplete).toEqual([[192, 3]]);
    });

    it('sends nothing for a file that was refused', async () => {
        const h = harness();
        const a = payload(300);
        feed(h, 'a', a, 1, 1, endMessage(digestOf(payload(300, 9))));
        await h.rx.settled();
        expect(h.completed).toEqual([]);
        expect(h.received()).toEqual([]);
        expect(h.frames().map((f) => f.type)).toEqual(['ack', 'incompatible']);
    });

    it('has nobody to tell once the connection closed during the check', async () => {
        let release: (v: string | null) => void = () => {};
        const h = harness({ hashBlob: () => new Promise((r) => { release = r; }) });
        const a = payload(100);
        feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
        const done = h.rx.settled();
        await new Promise((r) => setTimeout(r, 0)); // the check has started
        h.rx.dispose();
        release(digestOf(a));
        await done;
        // The file still arrived (see dispose), and no frame chases the close.
        expect(h.completed).toHaveLength(1);
        expect(h.received()).toEqual([]);
    });

    it('swallows a send that throws, after everything else has run', async () => {
        // A Go sender older than 1.11.0 closes about 50 ms after its last end
        // frame, so this send can land on a closing channel. The files are
        // already handed over and counted: the throw must not turn that into
        // a failure, or skip the per-transfer callback.
        const sent: string[] = [];
        const h = harness({ hashBlob: nodeHash }, (d) => {
            if (typeof d !== 'string') throw new Error('channel closing');
            sent.push(d);
        });
        feed(h, 'a', payload(100), 1, 1);
        await h.rx.settled();
        expect(h.errors).toEqual([]);
        expect(h.completed).toHaveLength(1);
        expect(h.allComplete).toEqual([[100, 1]]);
    });

    it('stays off when the rollback lever is off', async () => {
        const h = harness({ hashBlob: nodeHash, confirms: false });
        const a = payload(100);
        feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
        await h.rx.settled();
        expect(h.completed).toHaveLength(1);
        expect(h.acks()).toHaveLength(1);
        expect(Object.prototype.hasOwnProperty.call(h.acks()[0], 'confirms')).toBe(false);
        expect(h.received()).toEqual([]);
    });

    // A part whose read-back fails late, after the newest part's has settled:
    // the shape of a browser whose blob storage filled partway through a file.
    function earlierPartBrokenLate(): void {
        vi.stubGlobal(
            'Blob',
            class extends RealBlob {
                slice(start?: number, end?: number, type?: string): Blob {
                    if (this.size !== SPILL_BYTES) return super.slice(start, end, type);
                    return {
                        arrayBuffer: () =>
                            new Promise((_, reject) => setTimeout(() => reject(new DOMException('', 'NotReadableError')), 30)),
                    } as unknown as Blob;
                }
            }
        );
    }

    it('waits for every part to read back before the file is handed over and confirmed', async () => {
        earlierPartBrokenLate();
        const a = payload(SPILL_BYTES + 100);
        const want = digestOf(a);
        // A digest that answers at once, so the verdict is ready long before
        // the earlier part's read-back fails.
        const h = harness({ hashBlob: async () => want });
        feed(h, 'a', a, 1, 1, endMessage(want));
        await h.rx.settled();
        expect(h.completed).toEqual([]);
        expect(h.errors).toEqual([STORAGE_FULL_MESSAGE]);
        expect(h.received()).toEqual([]);
        expect(h.frames().map((f) => [f.type, f.code])).toEqual([['ack', undefined], ['incompatible', 'write-failed']]);
    });

    it('waits for them on a file with no SHA-256 too', async () => {
        // An older sender, or a digest that missed its bound, sends no
        // sha256: the file used to be handed over before its read-back, and
        // a broken part then stopped the transfer after the person had it.
        earlierPartBrokenLate();
        const h = harness();
        feed(h, 'a', payload(SPILL_BYTES + 100), 1, 1);
        expect(h.completed).toEqual([]);
        await h.rx.settled();
        expect(h.completed).toEqual([]);
        expect(h.errors).toEqual([STORAGE_FULL_MESSAGE]);
        expect(h.received()).toEqual([]);
        expect(h.allComplete).toEqual([]);
    });
});
