// Which tab durability guards a visitor state holds (spec 07 4.12.1's contract
// columns, 4.14).
//
// Wake lock and beforeunload are held while an attempt is live: Connecting
// (V6, and V6c, its limiter retry), Waiting for accept (V7) and Sending (V10).
// Every other state lets both go, including the attempt-ending sub-states of
// V6 that render Ready again. Both are best effort: the wake lock is a screen
// lock released whenever the tab is hidden, and beforeunload is a browser's
// generic prompt. No copy promises the tab survives (E-50).
//
// The hidden-tab title applies from Waiting on, through the endings, so a
// visitor who switched away can see from the tab strip that something changed.

import type { VisitorState } from './visitorState';

export interface VisitorGuards {
    wakeLock: boolean;
    beforeUnload: boolean;
    titleWhileHidden: boolean;
}

const LIVE: ReadonlySet<VisitorState> = new Set(['V6', 'V6c', 'V7', 'V10']);
const TITLED: ReadonlySet<VisitorState> = new Set(['V7', 'V10', 'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13']);

export function guardsFor(state: VisitorState): VisitorGuards {
    const live = LIVE.has(state);
    return { wakeLock: live, beforeUnload: live, titleWhileHidden: TITLED.has(state) };
}
