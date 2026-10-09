// hashBlob: the one hashing interface both browser surfaces use. Small on
// purpose, so a native streaming WebCrypto digest can replace the hash-wasm
// Worker later without touching a caller.

import { READ_SLAB } from './protocol';

export type WorkerFactory = () => Worker;

interface Hub {
    worker: Worker;
    pending: Map<number, (hex: string | null) => void>;
}

// One lazily created Worker per factory, reused across calls. Keyed by factory
// so a test's fake never shares state with the real one.
const hubs = new WeakMap<WorkerFactory, Hub>();
let nextId = 1;

// The literal new Worker(new URL(...)) form is what the bundler recognizes and
// emits as a separate chunk, so hash-wasm never lands in a page bundle. A classic
// worker, not { type: 'module' }: Turbopack's worker runtime loads the chunk's
// own chunks with importScripts, which a module worker refuses, and because
// hashBlob fails open that break would be silent.
const hashWorker: WorkerFactory = () => new Worker(new URL('./fileHash.worker.ts', import.meta.url));

// The worker's own output, checked before it is trusted: a digest is exactly
// 64 lowercase hex characters, the wire format a receiver accepts.
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function hubFor(factory: WorkerFactory): Hub {
    const existing = hubs.get(factory);
    if (existing) return existing;
    const worker = factory();
    const hub: Hub = { worker, pending: new Map() };
    worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { id?: unknown; hex?: unknown } | null;
        const done = typeof data?.id === 'number' ? hub.pending.get(data.id) : undefined;
        done?.(typeof data?.hex === 'string' && HEX_DIGEST.test(data.hex) ? data.hex : null);
    });
    // A worker that errors is dropped with everything it held; the next call
    // starts a fresh one.
    const fail = () => {
        if (hubs.get(factory) === hub) hubs.delete(factory);
        try {
            worker.terminate();
        } catch { }
        for (const done of [...hub.pending.values()]) done(null);
    };
    worker.addEventListener('error', fail);
    worker.addEventListener('messageerror', fail);
    hubs.set(factory, hub);
    return hub;
}

/**
 * The lowercase hex SHA-256 of a File or Blob, computed in a Worker, or null on
 * any failure: no Worker support, a Worker that cannot start or errors, a
 * malformed reply, or an abort. It never rejects. Fail-open is safe because a
 * missing digest never claims a match anywhere: the sender omits the field and
 * the receiver keeps the byte-count check. It settles only on a reply, a worker
 * failure or the signal, so a caller that needs a bound passes a signal.
 */
export function hashBlob(blob: Blob, signal?: AbortSignal, createWorker: WorkerFactory = hashWorker): Promise<string | null> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }
        let hub: Hub;
        try {
            if (createWorker === hashWorker && typeof Worker === 'undefined') {
                resolve(null);
                return;
            }
            hub = hubFor(createWorker);
        } catch {
            resolve(null);
            return;
        }
        const id = nextId++;
        // An abort settles the wait at once and tells the worker, which stops the
        // request at its next slab boundary; a reply already on its way finds no
        // pending entry.
        const onAbort = () => {
            finish(null);
            try {
                hub.worker.postMessage({ id, abort: true });
            } catch { }
        };
        function finish(hex: string | null) {
            if (!hub.pending.delete(id)) return;
            signal?.removeEventListener('abort', onAbort);
            resolve(hex);
        }
        hub.pending.set(id, finish);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            hub.worker.postMessage({ id, blob, slab: READ_SLAB });
        } catch {
            finish(null);
        }
    });
}
