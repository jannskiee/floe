import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createHashHandler, digestSlices, type HashReply } from './sha256Slices';

const readFrom = (bytes: Uint8Array) => async (start: number, end: number) => bytes.subarray(start, end);

describe('digestSlices', () => {
    it('digest equals node crypto for chunk-boundary sizes', async () => {
        const sizes = [0, 1, 16383, 16384, 16385, 262143, 262144, 262145];
        const inputs = sizes.map((n) => new Uint8Array(randomBytes(n)));
        inputs.push(new Uint8Array(randomBytes(10 * 1024 * 1024)));
        for (const bytes of inputs) {
            const want = createHash('sha256').update(bytes).digest('hex');
            for (const slab of [16 * 1024, 256 * 1024]) {
                const got = await digestSlices(readFrom(bytes), bytes.length, slab);
                expect(got, `${bytes.length} bytes in ${slab}-byte slices`).toBe(want);
                expect(got).toMatch(/^[0-9a-f]{64}$/);
            }
        }
    });

    it('accepts ArrayBuffer slices as a Blob hands them over', async () => {
        const bytes = new Uint8Array(randomBytes(70000));
        const read = async (start: number, end: number) => bytes.slice(start, end).buffer as ArrayBuffer;
        expect(await digestSlices(read, bytes.length, 16 * 1024)).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('rejects a slab that would never advance', async () => {
        await expect(digestSlices(readFrom(new Uint8Array(4)), 4, 0)).rejects.toThrow(RangeError);
    });
});

// A Blob stand-in whose reads are logged and can be held open, so a test can
// see ordering and stop a request mid-file.
function loggedBlob(tag: string, size: number, log: string[], onRead?: (n: number) => void) {
    let reads = 0;
    return {
        size,
        slice: (start: number, end: number) => ({
            arrayBuffer: async () => {
                reads += 1;
                log.push(`${tag}:${start}`);
                onRead?.(reads);
                await new Promise((r) => setTimeout(r, 1));
                return new Uint8Array(end - start).buffer;
            },
        }),
    } as unknown as Blob;
}

describe('createHashHandler', () => {
    it('requests run one at a time', async () => {
        const log: string[] = [];
        const replies: HashReply[] = [];
        const settled = new Promise<void>((done) => {
            const handle = createHashHandler((r) => {
                replies.push(r);
                if (replies.length === 2) done();
            });
            handle({ id: 1, blob: loggedBlob('a', 3 * 1024, log), slab: 1024 });
            handle({ id: 2, blob: loggedBlob('b', 2 * 1024, log), slab: 1024 });
        });
        await settled;
        expect(log).toEqual(['a:0', 'a:1024', 'a:2048', 'b:0', 'b:1024']);
        expect(replies.map((r) => r.id)).toEqual([1, 2]);
        expect(replies.every((r) => /^[0-9a-f]{64}$/.test(r.hex ?? ''))).toBe(true);
    });

    it('an aborted request stops the slab loop in the worker', async () => {
        const log: string[] = [];
        let handle: ReturnType<typeof createHashHandler> = () => { };
        const reply = new Promise<HashReply>((done) => {
            handle = createHashHandler(done);
            handle({ id: 7, blob: loggedBlob('big', 100 * 1024, log, (n) => { if (n === 2) handle({ id: 7, abort: true }); }), slab: 1024 });
        });
        expect(await reply).toEqual({ id: 7, hex: null });
        expect(log.length).toBeLessThan(5);
    });

    it('ignores an abort for a request it does not hold', async () => {
        const reply = new Promise<HashReply>((done) => {
            const handle = createHashHandler(done);
            handle({ id: 99, abort: true });
            handle({ id: 3, blob: loggedBlob('c', 1024, []), slab: 1024 });
        });
        expect((await reply).hex).toMatch(/^[0-9a-f]{64}$/);
    });
});
