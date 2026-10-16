// The reloads a page makes by itself never end a transfer unasked.
//
// Two of them could: the stale-bundle recovery (staleBundle.ts), which reloads
// after a deploy, and the main page's reload for a new room link opened in the
// same tab (P2PTransfer.tsx). Both went through the browser's leave prompt,
// and browsers show that prompt only once the person has used the page: a
// receiving tab opened from a link and never clicked lost its transfer to
// either one (prevention pack items 2 and 3, owner answer 12 B, 2026-10-16).
//
// A page holds the gate exactly while it holds the leave prompt, through
// useLeavePrompt (hooks/usePageGuards.ts): the main page while
// mainPageHoldsTab says so, the request page while guardsFor says so. A
// request made while nothing holds the tab reloads at once, as both reloads
// always did. While the tab is held, the two kinds part ways:
//
// - A stale-bundle request is dropped. The page keeps the bundle it has, which
//   ran the transfer, and the next chunk that fails to load after the hold
//   lets go reloads it as before. Reloading the moment the hold let go took
//   the outcome screen away a second after it appeared, and could unload a
//   receiving page while the browser still asked whether to allow its
//   downloads (the review of this change, 2026-10-16).
// - A room-link request is the person's own navigation. On a page they have
//   used, the reload goes ahead and the browser's leave prompt asks them, as
//   it always did. On a page they never used, where the browser cannot ask,
//   it waits and runs once the last hold lets go.
//
// A waiting request is kept by its kind, the latest one, and asked again at
// that moment whether the reload is still wanted: the room link may have been
// changed back. One reload serves every request.

/** How long after the last hold lets go a waiting reload runs. A receiving
 *  page lets go at the click that hands its last file to the browser, and the
 *  download should be under way before the page unloads. It also lets the
 *  same commit remove the leave prompt's listener, so the page's own reload
 *  never meets its own prompt. */
export const RELEASE_SETTLE_MS = 1_000;

export type ReloadKind = 'stale-bundle' | 'room-link';

export interface ReloadGate {
    /** Holds the tab until the returned function is called. Calling it
     *  more than once lets go once. */
    hold(): () => void;
    /** Reloads now if nothing holds the tab; otherwise see the header for
     *  each kind. `wanted` is asked right before a reload, never earlier. */
    request(kind: ReloadKind, wanted?: () => boolean): void;
}

export function createReloadGate(deps: {
    reload: () => void;
    schedule: (fn: () => void, ms: number) => void;
    /** Whether the browser would ask before this page unloads: it shows the
     *  leave prompt only once the person has used the page. */
    canAsk: () => boolean;
}): ReloadGate {
    const holders = new Set<symbol>();
    const waiting = new Map<ReloadKind, () => boolean>();

    const reloadIfFree = () => {
        if (holders.size > 0 || waiting.size === 0) return;
        // Every request is asked, not only the first that says yes.
        const answers = [...waiting.values()].map((wanted) => wanted());
        waiting.clear();
        if (answers.some(Boolean)) deps.reload();
    };

    return {
        hold() {
            const token = Symbol('hold');
            holders.add(token);
            return () => {
                if (!holders.delete(token)) return;
                if (holders.size === 0 && waiting.size > 0) deps.schedule(reloadIfFree, RELEASE_SETTLE_MS);
            };
        },
        request(kind, wanted = () => true) {
            if (holders.size > 0) {
                if (kind === 'stale-bundle') return;
                if (deps.canAsk()) {
                    if (wanted()) deps.reload();
                    return;
                }
            }
            waiting.set(kind, wanted);
            reloadIfFree();
        },
    };
}

/** The page's one gate. Never touches window or navigator until a request
 *  comes in, so the module is safe to import during a server render. */
export const reloadGate: ReloadGate = createReloadGate({
    reload: () => window.location.reload(),
    schedule: (fn, ms) => {
        setTimeout(fn, ms);
    },
    // A browser without navigator.userActivation counts as one that cannot
    // ask, so the reload waits: waiting never ends a transfer.
    canAsk: () => navigator.userActivation?.hasBeenActive === true,
});
