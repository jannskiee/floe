// The incremental SHA-256 loop behind hashBlob, kept free of Worker and DOM
// types so Node can test it against its own crypto. WebCrypto's digest takes
// one buffer and cannot hash a stream, so a multi-gigabyte file is read and
// hashed slab by slab with hash-wasm instead.
import { createSHA256 } from 'hash-wasm';

/**
 * The lowercase hex SHA-256 of `size` bytes, read in slabs of at most `slab`
 * bytes through `read(start, end)`. Rejects when a read or the hasher fails;
 * hashBlob turns that into null.
 */
export async function digestSlices(
    read: (start: number, end: number) => Promise<ArrayBuffer | Uint8Array>,
    size: number,
    slab: number,
): Promise<string> {
    // A slab of 0 would never advance the loop below.
    if (!(slab > 0)) throw new RangeError('slab must be a positive byte count');
    const hasher = await createSHA256();
    hasher.init();
    for (let start = 0; start < size; start += slab) {
        const end = Math.min(start + slab, size);
        const chunk = await read(start, end);
        hasher.update(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    return hasher.digest('hex');
}
