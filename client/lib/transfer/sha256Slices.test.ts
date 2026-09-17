import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { digestSlices } from './sha256Slices';

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
