// Helpers for the History view. They live outside App.tsx so they can be
// tested without a DOM or the Wails runtime bindings, which do not exist
// outside the WebView (the same arrangement as settings.ts).

/** One completed transfer, persisted locally in localStorage['floe:history']. */
export interface HistEntry {
    kind: 'send' | 'recv';
    names: string[];
    count: number;
    dir?: string;
    at: number;
    bytes?: number; // total transferred size; absent on entries from older builds
}

export const HISTORY_CAP = 50;

/** loadHistory parses the persisted list. The raw string is INJECTED rather
 *  than read from localStorage here, because every *.test.ts runs under
 *  vitest's `node` environment, where localStorage does not exist. The call
 *  site passes `() => localStorage.getItem('floe:history')`.
 *
 *  A corrupted store must never break the app, and must never be overwritten
 *  either: this returns empty, and the caller's persist effect is guarded so
 *  the unreadable bytes stay on disk for a human to look at. */
export function loadHistory(read: () => string | null): HistEntry[] {
    try {
        const raw = JSON.parse(read() || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

/** fmtWhen renders a history timestamp as "Today, 19:55", "Yesterday, 09:12",
 *  or "Jul 19, 19:55", comparing calendar days (not 24h windows).
 *
 *  NOT pure: it formats in the local zone and locale. `now` is injectable so
 *  the Today/Yesterday branch is deterministic in a test; the hh:mm half stays
 *  local-time, so a test must build its timestamps from local components
 *  (new Date(y, m, d, h, min)) rather than from an epoch or a UTC string. */
export function fmtWhen(ts: number, now: Date = new Date()): string {
    const d = new Date(ts);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const day =
        d.toDateString() === now.toDateString() ? 'Today' :
        d.toDateString() === yesterday.toDateString() ? 'Yesterday' :
        `${d.toLocaleString('en', {month: 'short'})} ${d.getDate()}`;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day}, ${hh}:${mm}`;
}

/** histKey identifies a history entry independently of its list position, so
 *  removing an entry above an expanded row cannot shift which row is open.
 *  `at` alone is near-unique (transfers are busy-gated, one at a time), but
 *  localStorage['floe:history'] is loaded verbatim and user-editable, so the
 *  first name and the count are folded in as free tiebreakers. Byte-identical
 *  entries still collide; that is accepted for a 50-entry local list. */
export function histKey(h: {at: number; names: string[]; count: number}): string {
    return `${h.at}-${h.names[0] ?? ''}-${h.count}`;
}
