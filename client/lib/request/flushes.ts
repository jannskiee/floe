// Frames still on their way to the host when the page wants to go away.
//
// The visitor's Cancel sends the fixed "The sender stopped." and waits up to
// CONTROL_FLUSH_MS for it to reach the wire before destroying the peer. The
// page is already back in Ready (V6d) or Stopped (V11a) during that wait, and
// a fragment change there reloads the page, which used to cut the flush: the
// host saw a close instead of the reason (WP-W1 review R2-3). The page adds
// each flush here and reloads only once they have settled, never later than
// the cap.

export interface FlushTracker {
    /** A flush has started; it counts until it settles, either way. */
    add(flush: Promise<unknown>): void;
    /** Resolves when every tracked flush has settled, or after `capMs`. */
    settled(capMs: number): Promise<void>;
}

export function createFlushTracker(): FlushTracker {
    const pending = new Set<Promise<void>>();
    return {
        add(flush) {
            const settledFlush: Promise<void> = flush
                .then(
                    () => undefined,
                    () => undefined
                )
                .finally(() => {
                    pending.delete(settledFlush);
                });
            pending.add(settledFlush);
        },
        settled(capMs) {
            if (pending.size === 0) return Promise.resolve();
            return new Promise<void>((resolve) => {
                const cap = setTimeout(resolve, capMs);
                void Promise.all([...pending]).then(() => {
                    clearTimeout(cap);
                    resolve();
                });
            });
        },
    };
}
