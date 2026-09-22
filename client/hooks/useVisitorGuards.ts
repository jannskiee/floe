import { useEffect, useRef } from 'react';
import { guardsFor } from '@/lib/request/guards';
import { visitorTitle, VISIBLE_TITLE, type TitleProgress } from '@/lib/request/titleProgress';
import { sleptWhileHidden } from '@/lib/request/sleepCheck';
import type { VisitorState } from '@/lib/request/visitorState';

/** The hidden-tab title is refreshed at most this often (spec 07 4.14.3). */
export const TITLE_UPDATE_MS = 5_000;

/**
 * The request link visitor's tab durability guards (spec 07 4.14), keyed on the
 * visitor STATE through guardsFor, never on the socket's connected flag: the
 * socket is allowed to drop and come back once the data channel is open, and
 * none of that may release a guard mid-drop.
 *
 * - beforeunload is registered while an attempt is live (V6, V7, V10) and
 *   removed otherwise. Browsers show their own generic prompt.
 * - The wake lock, requested at Send, is released the moment the state stops
 *   holding it, and re-acquired on becoming visible while it still does (the
 *   browser drops a screen lock whenever the tab is hidden).
 * - While hidden, from Waiting on, the tab title shows progress, refreshed at
 *   most every 5 s, and the page's own title comes back on visible.
 * - Back from hidden in Sending, a wall-clock jump over the monotonic clock
 *   reports a sleep, once.
 *
 * All of it is best effort (E-50): nothing here promises the tab survives.
 * Its own hook, and not inside the visitor component's other effects, so a
 * change there cannot quietly move a guard.
 */
export function useVisitorGuards(input: {
    state: VisitorState;
    progress: TitleProgress;
    requestWakeLock: () => void;
    releaseWakeLock: () => void;
    onSlept: () => void;
}) {
    const { state, progress, requestWakeLock, releaseWakeLock, onSlept } = input;
    const guards = guardsFor(state);

    // The latest state and progress, for listeners registered once.
    const latest = useRef({ state, progress });
    useEffect(() => {
        latest.current = { state, progress };
    });

    useEffect(() => {
        if (!guards.beforeUnload) return;
        const hold = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            // Chrome and Edge still need returnValue set to show the prompt.
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', hold);
        return () => window.removeEventListener('beforeunload', hold);
    }, [guards.beforeUnload]);

    useEffect(() => {
        if (!guards.wakeLock) releaseWakeLock();
    }, [guards.wakeLock, releaseWakeLock]);

    // A state change while hidden shows at once (Delivered, Stopped), rather
    // than on the next refresh.
    useEffect(() => {
        if (document.hidden) document.title = visitorTitle(state, latest.current.progress, true);
    }, [state]);

    useEffect(() => {
        let hiddenAt: { date: number; perf: number } | null = null;
        let refresh: ReturnType<typeof setInterval> | null = null;
        const apply = () => {
            document.title = visitorTitle(latest.current.state, latest.current.progress, document.hidden);
        };
        const stopRefresh = () => {
            if (refresh) clearInterval(refresh);
            refresh = null;
        };
        const onVisibility = () => {
            if (document.hidden) {
                hiddenAt = { date: Date.now(), perf: performance.now() };
                apply();
                stopRefresh();
                refresh = setInterval(apply, TITLE_UPDATE_MS);
                return;
            }
            stopRefresh();
            apply();
            const now = latest.current.state;
            if (guardsFor(now).wakeLock) requestWakeLock();
            if (now === 'V10' && hiddenAt) {
                const slept = sleptWhileHidden({
                    dateDeltaMs: Date.now() - hiddenAt.date,
                    perfDeltaMs: performance.now() - hiddenAt.perf,
                });
                if (slept) onSlept();
            }
            hiddenAt = null;
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            stopRefresh();
            document.title = VISIBLE_TITLE;
        };
    }, [requestWakeLock, onSlept]);
}
