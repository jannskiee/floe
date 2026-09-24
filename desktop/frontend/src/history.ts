// Helpers for the History view. They live outside App.tsx so they can be
// tested without a DOM or the Wails runtime bindings, which do not exist
// outside the WebView (the same arrangement as settings.ts).

import type {RequestLinkSnapshot} from './requestLink';

/** One completed transfer, persisted locally in localStorage['floe:history']. */
export interface HistEntry {
    kind: 'send' | 'recv';
    names: string[];
    count: number;
    dir?: string;
    at: number;
    bytes?: number; // total transferred size; absent on entries from older builds

    // A request drop (spec 06 4.11). Every field optional, so rows written by
    // older builds load unchanged. Nothing link-shaped is ever stored: no link,
    // link id or room id, because this store outlives the link and sits in the
    // WebView2 profile.
    via?: 'request';
    label?: string; // the owner's own label, which never left this PC
    verified?: number; // files whose SHA-256 matched
    renamed?: number; // files renamed to .floe-blocked; keeps the Show in folder question alive
    stopped?: string; // the stop code, when the drop ended early with files saved
    offered?: number; // files the visitor offered, for the stop sentence's "4 of 12"
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

/** REQUEST_NAMES_CAP bounds the names one request row stores: a drop can hold
 *  10,000 files, and this store is one localStorage value shared by the whole
 *  profile. count keeps the real number. */
export const REQUEST_NAMES_CAP = 200;

/** requestHistoryEntry is the one History row a finished request drop adds
 *  (S1-DSK-09): a done drop, or a stopped one that saved at least one file
 *  (OD-31 O4: the files exist on disk), or a save-blocked one whatever it
 *  saved (D-128: the engine kept the file it could not move into place as a
 *  verified .part in the drop folder, and the row says so through
 *  keptPartLine). Anything else adds nothing. Built only from the snapshot's
 *  result, the owner's label and the stop code; the link and the room id never
 *  reach it. The names are the engine's display-safe saved names, so the kept
 *  .part, saved under none, adds no name. */
export function requestHistoryEntry(snap: RequestLinkSnapshot, now: number = Date.now()): HistEntry | null {
    const r = snap.result;
    if (!r) return null;
    const stopped = snap.state === 'stopped' && (r.saved > 0 || snap.code === 'save-blocked');
    if (snap.state !== 'done' && !stopped) return null;
    const entry: HistEntry = {
        kind: 'recv',
        names: r.names.slice(0, REQUEST_NAMES_CAP),
        count: r.saved,
        at: now,
        via: 'request',
        verified: r.verified,
        renamed: r.renamed,
        offered: r.files,
    };
    if (r.folder) entry.dir = r.folder;
    if (r.bytes > 0) entry.bytes = r.bytes;
    if (snap.label) entry.label = snap.label;
    if (snap.state === 'stopped') entry.stopped = snap.code || 'unknown';
    return entry;
}
