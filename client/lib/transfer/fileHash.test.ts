import { describe, it, expect } from 'vitest';
import { hashBlob, type WorkerFactory } from './fileHash';

type Listener = (event: { data?: unknown }) => void;

// A stand-in for a module Worker: records what it was asked and lets a test
// answer, error or stay silent. Only the members hashBlob touches exist.
function fakeWorker() {
    const listeners = new Map<string, Listener[]>();
    const posted: Array<{ id: number; blob?: Blob; slab?: number; abort?: true }> = [];
    let terminated = false;
    const worker = {
        addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
        removeEventListener: () => { },
        postMessage: (message: { id: number; blob?: Blob; slab?: number; abort?: true }) => { posted.push(message); },
        terminate: () => { terminated = true; },
    };
    const emit = (type: string, data?: unknown) => (listeners.get(type) ?? []).forEach((fn) => fn({ data }));
    let created = 0;
    const factory: WorkerFactory = () => {
        created += 1;
        return worker as unknown as Worker;
    };
    return { factory, posted, emit, isTerminated: () => terminated, created: () => created };
}

const HEX = 'ab'.repeat(32);

describe('hashBlob', () => {
    it('resolves null when Worker is unavailable', async () => {
        // vitest runs in Node, which has no global Worker.
        expect(typeof Worker).toBe('undefined');
        await expect(hashBlob(new Blob(['data']))).resolves.toBeNull();
    });

    it('resolves the digest the worker posts, and reuses one worker', async () => {
        const w = fakeWorker();
        const first = hashBlob(new Blob(['a']), undefined, w.factory);
        const second = hashBlob(new Blob(['b']), undefined, w.factory);
        expect(w.posted).toHaveLength(2);
        expect(w.created()).toBe(1);
        expect(w.posted[0].slab).toBeGreaterThan(0);
        w.emit('message', { id: w.posted[1].id, hex: HEX });
        w.emit('message', { id: w.posted[0].id, hex: 'NOT-A-DIGEST' });
        await expect(second).resolves.toBe(HEX);
        // A reply that is not 64 lowercase hex characters is never trusted.
        await expect(first).resolves.toBeNull();
    });

    it('resolves null when the worker errors', async () => {
        const w = fakeWorker();
        const pending = hashBlob(new Blob(['data']), undefined, w.factory);
        w.emit('error');
        await expect(pending).resolves.toBeNull();
        expect(w.isTerminated()).toBe(true);
    });

    it('resolves null when the worker cannot start', async () => {
        const factory: WorkerFactory = () => {
            throw new Error('blocked by policy');
        };
        await expect(hashBlob(new Blob(['data']), undefined, factory)).resolves.toBeNull();
    });

    it('resolves null when aborted', async () => {
        const w = fakeWorker();
        const controller = new AbortController();
        const pending = hashBlob(new Blob(['data']), controller.signal, w.factory);
        controller.abort();
        await expect(pending).resolves.toBeNull();
        // A late reply after the abort changes nothing.
        w.emit('message', { id: w.posted[0].id, hex: HEX });
        await expect(pending).resolves.toBeNull();
        const already = new AbortController();
        already.abort();
        await expect(hashBlob(new Blob(['data']), already.signal, w.factory)).resolves.toBeNull();
    });

    it('resolves null when the message cannot be sent', async () => {
        const factory: WorkerFactory = () =>
            ({
                addEventListener: () => { },
                removeEventListener: () => { },
                postMessage: () => {
                    throw new Error('DataCloneError');
                },
                terminate: () => { },
            }) as unknown as Worker;
        await expect(hashBlob(new Blob(['data']), undefined, factory)).resolves.toBeNull();
    });

    it('resolves null on messageerror', async () => {
        const w = fakeWorker();
        const pending = hashBlob(new Blob(['data']), undefined, w.factory);
        w.emit('messageerror');
        await expect(pending).resolves.toBeNull();
    });

    it('tells the worker about an abort and removes its listener once settled', async () => {
        const w = fakeWorker();
        const controller = new AbortController();
        const pending = hashBlob(new Blob(['data']), controller.signal, w.factory);
        controller.abort();
        await pending;
        expect(w.posted[1]).toEqual({ id: w.posted[0].id, abort: true });

        let added = 0;
        let removed = 0;
        const signal = {
            aborted: false,
            addEventListener: () => { added += 1; },
            removeEventListener: () => { removed += 1; },
        } as unknown as AbortSignal;
        const replied = hashBlob(new Blob(['data']), signal, w.factory);
        w.emit('message', { id: (w.posted[w.posted.length - 1] as { id: number }).id, hex: HEX });
        await expect(replied).resolves.toBe(HEX);
        expect([added, removed]).toEqual([1, 1]);
    });
});