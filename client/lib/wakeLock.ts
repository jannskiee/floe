// The screen wake lock's bookkeeping, for useWakeLock (the main page and /r).
//
// Pure over an injected request, so the two races it closes are tested:
//
// - A release that runs while the request is still pending (a Cancel in the
//   few milliseconds before navigator.wakeLock.request resolves) used to find
//   nothing to release, and the lock then landed and stayed held until the
//   tab was hidden. The holder remembers that the lock is no longer wanted and
//   releases it as it lands (WP-W1 review F6).
// - The browser releases a screen lock by itself whenever the tab is hidden.
//   Only that sentinel's own release event clears the holder, so a later
//   re-acquire sees there is nothing held, and a stale event never clears a
//   newer lock (S1-WEB-04, spec 07 4.14.1).
//
// The wish to hold the lock is kept even where the page may not ask. A sender
// whose recipient joins while the tab is hidden gets the lock from resume()
// when the tab comes back, and a page that wants no lock, idle or finished,
// asks for nothing on its return (#730).
//
// Best effort throughout: a request that fails holds nothing and says nothing.

export interface SentinelLike {
    release(): Promise<void>;
    addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockHolder {
    /** Ask for the lock; a no-op while one is held or where the page may not
     *  ask (no API, or the page is not visible). The wish is kept even where
     *  the page may not ask, so resume() can pick it up. */
    acquire(): Promise<void>;
    /** Ask again for a lock the page still wants; a no-op when nothing wants
     *  one. For coming back to a visible tab. */
    resume(): Promise<void>;
    /** Let go of the lock, including one still being requested. */
    release(): void;
    held(): SentinelLike | null;
}

export function createWakeLockHolder(deps: {
    request: () => Promise<SentinelLike>;
    canRequest: () => boolean;
}): WakeLockHolder {
    let held: SentinelLike | null = null;
    let wanted = false;
    let requesting = false;
    // The wish is recorded before the canRequest() check, so a request made
    // from a hidden tab (the usual case: the recipient opens the link while
    // the sender is still in the chat app) is remembered for resume().
    const acquire = async () => {
        wanted = true;
        if (!deps.canRequest()) return;
        // Wanted again even when a request is already on its way, so that
        // request keeps the lock it lands with.
        if (held || requesting) return;
        requesting = true;
        let sentinel: SentinelLike;
        try {
            sentinel = await deps.request();
        } catch {
            return;
        } finally {
            requesting = false;
        }
        if (!wanted) {
            // Released while the request was pending.
            sentinel.release().catch(() => {});
            return;
        }
        held = sentinel;
        sentinel.addEventListener('release', () => {
            if (held === sentinel) held = null;
        });
    };
    return {
        acquire,
        async resume() {
            if (wanted) await acquire();
        },
        release() {
            wanted = false;
            const s = held;
            held = null;
            if (s) s.release().catch(() => {});
        },
        held: () => held,
    };
}
