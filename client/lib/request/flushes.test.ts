import { describe, it, expect } from 'vitest';
import { createFlushTracker } from './flushes';

// WP-W1 review R2-3: a fragment change within the up-to-2 s flush of the
// visitor's Cancel reason reloaded the page and cut the flush, so the host saw
// a close instead of the fixed "The sender stopped." The page now reloads only
// once the tracked flushes have settled, with a cap.

function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('flush tracker', () => {
    it('settles at once with nothing in flight', async () => {
        const t = createFlushTracker();
        let done = false;
        void t.settled(10_000).then(() => (done = true));
        await tick();
        expect(done).toBe(true);
    });

    it('a reload waits for a pending cancel flush', async () => {
        const t = createFlushTracker();
        const flush = deferred();
        t.add(flush.promise);
        let done = false;
        void t.settled(10_000).then(() => (done = true));
        await tick();
        expect(done).toBe(false);
        flush.resolve();
        await tick();
        expect(done).toBe(true);
    });

    it('a failed flush counts as settled, and a finished one is forgotten', async () => {
        const t = createFlushTracker();
        const flush = deferred();
        t.add(flush.promise);
        flush.reject(new Error('channel gone'));
        await tick();
        let done = false;
        void t.settled(10_000).then(() => (done = true));
        await tick();
        expect(done).toBe(true);
    });

    it('a flush that never settles is capped', async () => {
        const t = createFlushTracker();
        t.add(new Promise(() => {}));
        let done = false;
        void t.settled(20).then(() => (done = true));
        await tick();
        expect(done).toBe(false);
        await new Promise((r) => setTimeout(r, 40));
        expect(done).toBe(true);
    });
});
