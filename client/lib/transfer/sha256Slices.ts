// The hashing worker's logic, kept free of Worker and DOM types so Node can
// test it against its own crypto. WebCrypto's digest takes one buffer and
// cannot hash a stream, so a multi-gigabyte file is read and hashed slab by
// slab with hash-wasm instead.
import { createSHA256 } from 'hash-wasm';

/**
 * The lowercase hex SHA-256 of `size` bytes, read in slabs of at most `slab`
 * bytes through `read(start, end)`. Rejects when a read or the hasher fails, or
 * when `cancelled` says so before a read; hashBlob turns any of that into null.
 */
export async function digestSlices(
    read: (start: number, end: number) => Promise<ArrayBuffer | Uint8Array>,
    size: number,
    slab: number,
    cancelled?: () => boolean,
): Promise<string> {
    // A slab of 0 would never advance the loop below.
    if (!(slab > 0)) throw new RangeError('slab must be a positive byte count');
    const hasher = await createSHA256();
    hasher.init();
    for (let start = 0; start < size; start += slab) {
        if (cancelled?.()) throw new Error('hash cancelled');
        const end = Math.min(start + slab, size);
        const chunk = await read(start, end);
        hasher.update(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    return hasher.digest('hex');
}

export type HashRequest = { id: number; blob: Blob; slab: number } | { id: number; abort: true };
export type HashReply = { id: number; hex: string | null };

/**
 * The worker's message handler. Requests run one at a time, so the worker never
 * holds more than one slab and one hasher however many callers are waiting. An
 * abort for a request that is queued or running ends it at the next slab
 * boundary with a null reply, so a cancelled multi-gigabyte send stops reading
 * the file; an abort for anything else is ignored.
 */
export function createHashHandler(post: (reply: HashReply) => void): (request: HashRequest) => void {
    let queue: Promise<void> = Promise.resolve();
    const live = new Set<number>();
    const cancelled = new Set<number>();
    return (request) => {
        if ('abort' in request) {
            if (live.has(request.id)) cancelled.add(request.id);
            return;
        }
        const { id, blob, slab } = request;
        live.add(id);
        queue = queue.then(() =>
            digestSlices((start, end) => blob.slice(start, end).arrayBuffer(), blob.size, slab, () => cancelled.has(id))
                .then(
                    (hex) => post({ id, hex }),
                    () => post({ id, hex: null }),
                )
                .finally(() => {
                    live.delete(id);
                    cancelled.delete(id);
                }),
        );
    };
}
