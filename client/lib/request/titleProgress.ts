// document.title while the visitor's tab is hidden (spec 07 4.14.3, T-01 to
// T-05 of the frozen copy).
//
// Why at all: current Chromium spares a tab that updated its title in the
// background from proactive and suggested discards (not urgent ones). A mild
// positive against Memory Saver, never relied on (E-50); the keep-in-front and
// pin lines are the real advice.
//
// Counts and a whole percentage only. A hidden tab's title shows in the tab
// strip and the window switcher, so no name or path ever goes into it. The
// separator is the root template's " - ", never a dash character.

import type { VisitorState } from './visitorState';
import { guardsFor } from './guards';

/** T-05: the page's own title, from its metadata and the root template. */
export const VISIBLE_TITLE = 'Send files - Floe';

export interface TitleProgress {
    /** The whole drop's percent. */
    percent: number;
    /** The file being sent, 1-based, from the sender's own index. */
    index: number;
    total: number;
}

export function visitorTitle(state: VisitorState, progress: TitleProgress, hidden: boolean): string {
    if (!hidden || !guardsFor(state).titleWhileHidden) return VISIBLE_TITLE;
    switch (state) {
        case 'V7':
            // T-01.
            return 'Waiting for them to accept - Floe';
        case 'V10': {
            // T-02, singular when N is 1 (D-123).
            const pct = Number.isFinite(progress.percent)
                ? Math.min(100, Math.max(0, Math.floor(progress.percent)))
                : 0;
            return progress.total === 1
                ? `${pct}% sent, ${progress.index} of 1 file - Floe`
                : `${pct}% sent, ${progress.index} of ${progress.total} files - Floe`;
        }
        case 'V13':
            // T-03, until the tab is visible again; singular when N is 1 (D-123).
            return progress.total === 1 ? '1 file arrived - Floe' : `All ${progress.total} files arrived - Floe`;
        default:
            // T-04: V11 and V12 with their sub-states, until visible.
            return 'Drop stopped - Floe';
    }
}
