import { describe, it, expect } from 'vitest';
import { sendFiles, type SenderDeps, type FileEntry } from './sender';
import { createReceiver } from './receiver';

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
