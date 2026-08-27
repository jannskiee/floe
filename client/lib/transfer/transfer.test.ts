import { describe, it, expect } from 'vitest';
import { sendFiles, type SenderDeps, type FileEntry } from './sender';
import { createReceiver } from './receiver';
import { metadataMessage, endMessage, ackMessage, incompatibleMessage, CONTROL_MSG_MAX } from './protocol';

const enc = new TextEncoder();

// Minimal no-op buffer channel — backpressure never engaged in tests.
function makeBufferChannel() {
    return {
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener: () => { },
        removeEventListener: () => { },
    };
}

// Creates a File with known random bytes of given size.
function makeFile(sizeBytes: number, name = 'test.bin'): File {
    const buf = new Uint8Array(sizeBytes);
    if (sizeBytes > 0) {
        // Pseudo-random but deterministic content
        for (let i = 0; i < sizeBytes; i++) {
            buf[i] = (i * 31 + 7) % 256;
        }
    }
    return new File([buf], name, { type: 'application/octet-stream' });
}

// Wires sender and receiver together in-process.
// Returns the received file bytes as a Uint8Array.
async function loopback(
    files: FileEntry[],
    opts: { chunkOverride?: number } = {}
): Promise<{ name: string; bytes: Uint8Array }[]> {
    const received: { name: string; bytes: Uint8Array }[] = [];

    // Queue of data handlers the sender registers for acks
    let senderDataHandler: ((d: Uint8Array | ArrayBuffer) => void) | null = null;

    const rx = createReceiver({
        send: (d) => {
            // Defer so the sender's waitForAck handler is registered before the ack fires.
            // In production there is a real network round-trip; queueMicrotask reproduces
            // that "not yet registered" gap in the synchronous loopback.
            const data = typeof d === 'string' ? enc.encode(d) : d;
            queueMicrotask(() => senderDataHandler?.(data));
        },
        onFileComplete: (file) => {
            file.blob.arrayBuffer().then((ab) => {
                received.push({ name: file.fileName, bytes: new Uint8Array(ab) });
            });
        },
    });

    const deps: SenderDeps = {
        send: (d) => {
            // Sender output → receiver input
            const data = typeof d === 'string' ? enc.encode(d) : d;
            rx.handleMessage(data);
        },
        onData: (handler) => {
            senderDataHandler = handler;
            return () => { senderDataHandler = null; };
        },
        channel: makeBufferChannel(),
        sctpMaxMessageSize: opts.chunkOverride ?? null,
    };

    await sendFiles(deps, files, {});

    // Allow blob.arrayBuffer() promises to settle
    await new Promise((r) => setTimeout(r, 50));

    return received;
}

describe('loopback: single small file', () => {
    it('transfers a 512-byte file intact', async () => {
        const file = makeFile(512);
        const result = await loopback([{ id: 'id1', file }]);

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('test.bin');
        expect(result[0].bytes.byteLength).toBe(512);

        // Content integrity
        const expected = new Uint8Array(512);
        for (let i = 0; i < 512; i++) expected[i] = (i * 31 + 7) % 256;
        expect(result[0].bytes).toEqual(expected);
    });
});

describe('loopback: empty file', () => {
    it('transfers a 0-byte file and completes', async () => {
        const file = makeFile(0, 'empty.txt');
        const result = await loopback([{ id: 'id-empty', file }]);
        expect(result).toHaveLength(1);
        expect(result[0].bytes.byteLength).toBe(0);
    });
});

describe('loopback: multi-file', () => {
    it('transfers three files in order', async () => {
        const files: FileEntry[] = [
            { id: 'a', file: makeFile(100, 'a.txt') },
            { id: 'b', file: makeFile(200, 'b.txt') },
            { id: 'c', file: makeFile(300, 'c.txt') },
        ];
        const result = await loopback(files);

        expect(result).toHaveLength(3);
        expect(result[0].name).toBe('a.txt');
        expect(result[1].name).toBe('b.txt');
        expect(result[2].name).toBe('c.txt');
        expect(result[0].bytes.byteLength).toBe(100);
        expect(result[1].bytes.byteLength).toBe(200);
        expect(result[2].bytes.byteLength).toBe(300);
    });
});

describe('loopback: chunked transfer', () => {
    it('reassembles a 200 KB file sent in 16 KB chunks', async () => {
        const SIZE = 200 * 1024;
        const file = makeFile(SIZE, 'big.bin');
        // Force 16 KB chunks via sctpMaxMessageSize
        const result = await loopback([{ id: 'big', file }], { chunkOverride: 16 * 1024 });

        expect(result).toHaveLength(1);
        expect(result[0].bytes.byteLength).toBe(SIZE);

        // Spot-check a few byte positions
        const expected = new Uint8Array(SIZE);
        for (let i = 0; i < SIZE; i++) expected[i] = (i * 31 + 7) % 256;
        // Check first and last 512 bytes
        expect(result[0].bytes.slice(0, 512)).toEqual(expected.slice(0, 512));
        expect(result[0].bytes.slice(SIZE - 512)).toEqual(expected.slice(SIZE - 512));
    });
});

describe('receiver: stores tight copies of chunk bytes', () => {
    // Regression guard: simple-peer delivers data channel chunks as a Node Buffer,
    // whose `.slice()` is a non-copying VIEW over the (often larger/shared) backing
    // buffer. The receiver must copy out exactly each chunk's bytes, not retain the
    // whole backing buffer. This test feeds Buffer subarray views — exactly the
    // browser-runtime shape — which the old `buf.slice().buffer` code mishandled.
    it('reassembles chunks delivered as Buffer subarray views over a larger buffer', async () => {
        let completedBlob: Blob | null = null;
        const rx = createReceiver({
            send: () => { /* ack — ignored here */ },
            onFileComplete: (f) => { completedBlob = f.blob; },
        });

        const SIZE = 48;
        const fileBytes = new Uint8Array(SIZE);
        for (let i = 0; i < SIZE; i++) fileBytes[i] = i + 1; // never 0x7B at index 0

        // Metadata first so the receiver opens a partial download.
        rx.handleMessage(enc.encode(metadataMessage('rid', 'r.bin', SIZE, 1, 1, SIZE)));

        // Place the payload inside a larger backing Buffer at a non-zero offset and
        // hand the receiver subarray VIEWS (16 bytes each) — sharing one backing AB.
        const backing = Buffer.alloc(200);
        for (let i = 0; i < SIZE; i++) backing[20 + i] = fileBytes[i];
        rx.handleMessage(backing.subarray(20, 36));
        rx.handleMessage(backing.subarray(36, 52));
        rx.handleMessage(backing.subarray(52, 68));

        rx.handleMessage(enc.encode(endMessage()));

        expect(completedBlob).not.toBeNull();
        const got = new Uint8Array(await completedBlob!.arrayBuffer());
        expect(got.byteLength).toBe(SIZE);
        expect(got).toEqual(fileBytes);
    });
});

describe('receiver: onAllComplete fires once per transfer', () => {
    // Guards the global-counter fix: per-transfer side effects (stats report,
    // analytics, optimistic footer bump) must run exactly once with the summed
    // bytes — never once per file — so multi-file transfers are counted correctly
    // and are not partially dropped by the server's per-IP report rate limit.
    function feedFile(
        rx: { handleMessage: (d: Uint8Array | ArrayBuffer) => void },
        id: string,
        size: number,
        index: number,
        total: number,
    ) {
        rx.handleMessage(enc.encode(metadataMessage(id, `${id}.bin`, size, index, total, 0)));
        const chunk = new Uint8Array(size);
        for (let i = 0; i < size; i++) chunk[i] = (i + 1) % 256; // never starts with '{'
        if (size > 0) rx.handleMessage(chunk);
        rx.handleMessage(enc.encode(endMessage()));
    }

    it('fires a single time with the total bytes and file count for a 3-file transfer', () => {
        const calls: { totalBytes: number; fileCount: number }[] = [];
        const rx = createReceiver({
            send: () => { /* ack — ignored */ },
            onAllComplete: (totalBytes, fileCount) => calls.push({ totalBytes, fileCount }),
        });

        feedFile(rx, 'a', 100, 1, 3);
        expect(calls).toHaveLength(0); // not after the first file
        feedFile(rx, 'b', 200, 2, 3);
        expect(calls).toHaveLength(0); // not after the second file
        feedFile(rx, 'c', 300, 3, 3);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ totalBytes: 600, fileCount: 3 });
    });

    it('fires once for a single-file transfer (index === total === 1)', () => {
        const calls: { totalBytes: number; fileCount: number }[] = [];
        const rx = createReceiver({
            send: () => {},
            onAllComplete: (totalBytes, fileCount) => calls.push({ totalBytes, fileCount }),
        });

        feedFile(rx, 'only', 512, 1, 1);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ totalBytes: 512, fileCount: 1 });
    });
});

describe('loopback: small binary framing guard', () => {
    it('does not misclassify a 999-byte binary chunk starting with 0x7B ({) as a control message', async () => {
        // Build a file whose first 999 bytes start with '{' — the byteLength guard must
        // keep it out of control-message parsing.
        // Our protocol wraps the content as raw binary (no JSON), so a '{'-starting
        // chunk that is not a real control message must be treated as file data.
        // This test checks end-to-end framing: the file arrives intact even though
        // its first byte is the ASCII '{' character.
        const SIZE = 999;
        const buf = new Uint8Array(SIZE);
        buf[0] = 0x7b; // '{'
        for (let i = 1; i < SIZE; i++) buf[i] = i % 256;

        const file = new File([buf], 'tricky.bin');
        // Force 999-byte chunk so the single chunk IS <= 1000 but classifyControl
        // returns null because JSON.parse fails on arbitrary bytes after '{'.
        const result = await loopback([{ id: 'tricky', file }], { chunkOverride: 1024 });
        expect(result).toHaveLength(1);
        expect(result[0].bytes.byteLength).toBe(SIZE);
        expect(result[0].bytes[0]).toBe(0x7b);
    });
});

/**
 * The receiver must refuse a file whose byte count does not match the size the
 * sender announced, matching cli/engine/transfer/receiver.go. Before this it
 * labelled the file with however many bytes arrived, so announced and actual
 * could never disagree and a truncated file was handed over as complete.
 */
describe('receiver: truncation guard', () => {
    // Feeds metadata announcing `announced` bytes but only delivers `actual`.
    function feedTruncated(
        rx: { handleMessage: (d: Uint8Array | ArrayBuffer) => void },
        id: string,
        announced: number,
        actual: number,
        index = 1,
        total = 1,
    ) {
        rx.handleMessage(enc.encode(metadataMessage(id, `${id}.bin`, announced, index, total, 0)));
        if (actual > 0) {
            const chunk = new Uint8Array(actual);
            for (let i = 0; i < actual; i++) chunk[i] = (i + 1) % 256; // never starts with '{'
            rx.handleMessage(chunk);
        }
        rx.handleMessage(enc.encode(endMessage()));
    }

    function harness() {
        const completed: string[] = [];
        const errors: string[] = [];
        const allComplete: number[] = [];
        const rx = createReceiver({
            send: () => {},
            onFileComplete: (f) => completed.push(f.fileName),
            onAllComplete: (bytes) => allComplete.push(bytes),
            onError: (m) => errors.push(m),
        });
        return { rx, completed, errors, allComplete };
    }

    it('refuses a file that arrived short', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60);
        expect(h.completed).toEqual([]);
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain('60');
        expect(h.errors[0]).toContain('100');
    });

    it('refuses a file that arrived long, so the guard is equality not a floor', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 50, 80);
        expect(h.completed).toEqual([]);
        expect(h.errors).toHaveLength(1);
        // Over-count is a frame-boundary problem, not a truncation, so the
        // message must not tell the user the transfer was cut short.
        expect(h.errors[0]).toContain('More data arrived');
        expect(h.errors[0]).not.toContain('cut short');
    });

    it('says the file was cut short only when it actually was', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60);
        expect(h.errors[0]).toContain('cut short');
    });

    it('does not report truncated bytes to the global counter', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60, 1, 1);
        expect(h.allComplete).toEqual([]);
    });

    it('stops the transfer instead of moving on to the next file', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60, 1, 3);
        feedTruncated(h.rx, 'b', 10, 10, 2, 3);
        feedTruncated(h.rx, 'c', 10, 10, 3, 3);
        expect(h.completed).toEqual([]);
        expect(h.errors).toHaveLength(1);
        expect(h.allComplete).toEqual([]);
    });

    it('accepts a file whose count matches exactly', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 100);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('accepts a zero byte file announced as zero', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 0, 0);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('accepts a peer that announces no size at all', () => {
        // metadataMessage always writes a fileSize, so build the frame by hand.
        const h = harness();
        h.rx.handleMessage(
            enc.encode(JSON.stringify({
                type: 'metadata', id: 'a', fileName: 'a.bin', index: 1, total: 1, totalBytes: 0,
            }))
        );
        const chunk = new Uint8Array(50);
        for (let i = 0; i < 50; i++) chunk[i] = (i + 1) % 256;
        h.rx.handleMessage(chunk);
        h.rx.handleMessage(enc.encode(endMessage()));
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('treats an unusable announced size as unknown rather than failing', () => {
        for (const bad of ['100', -1, 1.5, null, Number.MAX_SAFE_INTEGER + 2]) {
            const h = harness();
            h.rx.handleMessage(
                enc.encode(JSON.stringify({
                    type: 'metadata', id: 'a', fileName: 'a.bin',
                    fileSize: bad, index: 1, total: 1, totalBytes: 0,
                }))
            );
            const chunk = new Uint8Array(10);
            for (let i = 0; i < 10; i++) chunk[i] = (i + 1) % 256;
            h.rx.handleMessage(chunk);
            h.rx.handleMessage(enc.encode(endMessage()));
            expect(h.completed).toEqual(['a.bin']);
            expect(h.errors).toEqual([]);
        }
    });

    it('accepts a resumed file that reaches the announced size', () => {
        // Metadata for the same id arrives twice; the receiver acks the bytes it
        // already has and the sender continues from there. The sum is against
        // the full announced size, so equality still holds.
        const h = harness();
        const acks: string[] = [];
        const rx = createReceiver({
            send: (d) => acks.push(typeof d === 'string' ? d : new TextDecoder().decode(d)),
            onFileComplete: (f) => h.completed.push(f.fileName),
            onError: (m) => h.errors.push(m),
        });
        const part = (n: number) => {
            const c = new Uint8Array(n);
            for (let i = 0; i < n; i++) c[i] = (i + 1) % 256;
            return c;
        };
        rx.handleMessage(enc.encode(metadataMessage('a', 'a.bin', 100, 1, 1, 0)));
        rx.handleMessage(part(40));
        rx.handleMessage(enc.encode(metadataMessage('a', 'a.bin', 100, 1, 1, 0)));
        rx.handleMessage(part(60));
        rx.handleMessage(enc.encode(endMessage()));

        expect(JSON.parse(acks[1]).offset).toBe(40);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('shows a display-safe name in the incomplete-file error', () => {
        // A bidi override in the announced name would reorder the words of
        // the banner around it exactly as it does in a file manager, so the
        // error carries the display form of the name, not the wire string.
        const h = harness();
        h.rx.handleMessage(
            enc.encode(JSON.stringify({
                type: 'metadata', id: 'a', fileName: 'photo\u202egnp.exe',
                fileSize: 100, index: 1, total: 1, totalBytes: 100,
            }))
        );
        const chunk = new Uint8Array(60);
        for (let i = 0; i < 60; i++) chunk[i] = (i + 1) % 256;
        h.rx.handleMessage(chunk);
        h.rx.handleMessage(enc.encode(endMessage()));
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain('Incomplete file "photognp.exe"');
        expect(h.errors[0]).not.toContain('\u202e');
    });
});

/**
 * The rejection reason and the version string in an ack are peer-supplied and
 * used to land in the error banner verbatim. React escapes HTML, not control
 * characters or bidi marks, so the sender cleans and caps them first.
 */
// Loopback deps whose receiver side is scripted: `reply` builds the frame that
// answers the sender's metadata, delivered on a microtask like the loopback
// harness above so waitForAck is registered before it fires. `sent` collects
// every string frame the sender emits, for "never announced the file as done"
// assertions.
function scriptedDeps(reply: (metadataId: string) => string, sent: string[] = []): SenderDeps {
    let senderDataHandler: ((d: Uint8Array | ArrayBuffer) => void) | null = null;
    return {
        send: (d) => {
            if (typeof d !== 'string') return;
            sent.push(d);
            const parsed = JSON.parse(d) as { type: string; id?: string };
            if (parsed.type === 'metadata' && parsed.id) {
                const frame = enc.encode(reply(parsed.id));
                // A fixture past the control cap is dropped by classifyControl
                // and the sender waits out the ack timeout, so pin the size.
                expect(frame.byteLength).toBeLessThanOrEqual(CONTROL_MSG_MAX);
                queueMicrotask(() => senderDataHandler?.(frame));
            }
        },
        onData: (handler) => {
            senderDataHandler = handler;
            return () => { senderDataHandler = null; };
        },
        channel: makeBufferChannel(),
        sctpMaxMessageSize: null,
    };
}

describe('sender: rejection text is display-safe', () => {
    it('cleans and caps an incompatible reason', async () => {
        // 70 lines of an erase-line escape: 910 bytes once JSON-escaped, and
        // 350 characters after the invisible ones go, so the cap is exercised.
        const reason = '\u001b[2Kxx\n'.repeat(70);
        const errors: string[] = [];
        await sendFiles(scriptedDeps(() => incompatibleMessage(reason)),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0].length).toBeLessThanOrEqual(300);
        expect(errors[0].endsWith('…')).toBe(true);
        expect(errors[0]).not.toContain('\u001b');
        expect(errors[0]).not.toContain('\n');
    });

    it('cleans the version string in an ack that fails the compat check', async () => {
        const ver = 'v\u202e' + 'x'.repeat(850);
        const errors: string[] = [];
        await sendFiles(
            scriptedDeps((id) => JSON.stringify({ type: 'ack', id, offset: 0, pv: 2, pvMin: 2, ver })),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Cannot transfer');
        expect(errors[0]).not.toContain('\u202e');
    });
});

/**
 * The ack's offset is the receiver's word for how much of the file it already
 * has, cast straight off the wire. A negative one used to make the chunk loop
 * spin forever on empty slabs, and one past the end sent an end marker after
 * zero bytes. Each test carries a 5 s timeout because the failure mode is a hang.
 */
describe('sender: resume offset from the receiver', () => {
    it('refuses a negative offset instead of spinning forever', async () => {
        const errors: string[] = [];
        const sent: string[] = [];
        await sendFiles(
            scriptedDeps((id) => ackMessage(id, -1e9), sent),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('-1000000000');
        expect(sent.some((f) => f.includes('"end"'))).toBe(false);
    }, 5000);

    it('refuses an offset past the end of the file', async () => {
        const errors: string[] = [];
        const sent: string[] = [];
        await sendFiles(
            scriptedDeps((id) => ackMessage(id, 17), sent),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('17');
        expect(sent.some((f) => f.includes('"end"'))).toBe(false);
    }, 5000);

    it('still accepts a resume from inside the file', async () => {
        const errors: string[] = [];
        const sent: string[] = [];
        await sendFiles(
            scriptedDeps((id) => ackMessage(id, 8), sent),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toEqual([]);
        expect(sent.some((f) => f.includes('"end"'))).toBe(true);
    }, 5000);
});

/**
 * A file that becomes unreadable mid-send used to `break` out of the read loop
 * and fall through to the unconditional end marker, so the sender announced a
 * finished file after a short byte count and both sides showed success.
 */
describe('sender: unreadable file', () => {
    it('reports an error and never announces the file as done', async () => {
        let sawEnd = false;
        const errors: string[] = [];
        let allSent = false;

        // Rejects on the first slab read, the way a moved file, an unplugged
        // drive, or an evicted cloud placeholder does.
        const bad = {
            name: 'gone.bin',
            size: 4096,
            slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
        } as unknown as File;

        // The sender blocks on the ack before it reads anything, so the harness
        // has to answer it or the test just waits out the ack timeout.
        let senderDataHandler: ((d: Uint8Array | ArrayBuffer) => void) | null = null;

        const deps: SenderDeps = {
            send: (d) => {
                if (typeof d !== 'string') return;
                if (d.includes('"end"')) sawEnd = true;
                const parsed = JSON.parse(d) as { type: string; id?: string };
                if (parsed.type === 'metadata' && parsed.id) {
                    const ack = enc.encode(ackMessage(parsed.id, 0));
                    queueMicrotask(() => senderDataHandler?.(ack));
                }
            },
            onData: (handler) => {
                senderDataHandler = handler;
                return () => { senderDataHandler = null; };
            },
            channel: makeBufferChannel(),
            sctpMaxMessageSize: null,
        };

        await sendFiles(deps, [{ file: bad, id: 'x' }], {
            onError: (m) => errors.push(m),
            onAllSent: () => { allSent = true; },
        });

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('gone.bin');
        // The bug: this used to be true, so the receiver was told the file was
        // finished after a short byte count.
        expect(sawEnd).toBe(false);
        expect(allSent).toBe(false);
    });
});
