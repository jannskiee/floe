// The record a discarded /r tab comes back to (FT-R-DISCARD, finding
// F-G4-M01, D-142).
//
// Chrome can discard a background tab to save memory (Memory Saver, or an
// urgent discard under pressure) in the middle of a drop. No unload event
// fires, the data channel dies with the page, and when the visitor returns
// Chrome reloads the tab at its address. Without a record the page opens on
// Ready with no word that a drop ran; with one, that reload shows the Lost card
// the drop ended on, C-110 and C-111 with the counts (spec 07 4.14.5).
//
// The record is two integers and nothing else, in the tab's own
// sessionStorage under one key: {"v":1,"arrived":n,"total":m}. Never a file
// name, a path, the link id or the room id. sessionStorage belongs to the tab
// and the origin, and a discard's reload keeps it. The Arrived list is not
// kept, since no name is ever stored, so the restored card shows the counts
// alone (spec 07 5.6: the Stage 1 list is lost on reload).
//
// The page writes the record while a drop is past Accept (V10) and clears it
// in every other state (visitorState.ts lostRecordOf). takeLost reads it once
// per load and always removes it, and hands the counts back only when the
// browser reports the load as a discard's (document.wasDiscarded), so a normal
// reload, a Back into /r or a duplicated tab, which copies sessionStorage,
// opens on Ready.
//
// Every storage call is best effort, as in staleBundle.ts: sessionStorage
// throws where storage is blocked or full, and a record that cannot be written
// or read only means the page opens on Ready, as it did before the record.

import { MAX_REQUEST_FILES } from './constants';

/** The one key /r writes. */
export const LOST_KEY = 'floe:r-lost';

/** A drop past Accept: the files that arrived, and the drop's file count. */
export interface LostCounts {
    arrived: number;
    total: number;
}

/** The part of Storage the record needs: the tab's sessionStorage in the page,
 *  a stub in the tests. */
export type LostStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A pair the Lost card can show: integers, at least one file still to send
 *  (a drop whose every file arrived is Delivered, never Lost), and no more
 *  files than a drop may hold. */
export function isLostPair(arrived: unknown, total: unknown): boolean {
    if (!Number.isInteger(arrived) || !Number.isInteger(total)) return false;
    const a = arrived as number;
    const t = total as number;
    return a >= 0 && a < t && t <= MAX_REQUEST_FILES;
}

/** The tab's sessionStorage, or null with no window or where reading it
 *  throws (storage blocked by the browser or a policy). */
export function sessionStore(): LostStore | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

/** Write the counts of a drop past Accept. A pair the card could not show is
 *  never written, and the key is cleared instead, so no older pair stays. */
export function recordLost(store: LostStore | null, arrived: number, total: number): void {
    if (!store) return;
    if (!isLostPair(arrived, total)) {
        clearLost(store);
        return;
    }
    try {
        store.setItem(LOST_KEY, JSON.stringify({ v: 1, arrived, total }));
    } catch {
        // Full or blocked: a discard then reloads to Ready, as before.
    }
}

/** What the page does to the record after a dispatch (RequestVisitor.tsx
 *  syncLost), with the key it keeps of the last write. */
export type LostSync =
    | { op: 'keep'; written: string | null }
    | { op: 'write'; written: string; counts: LostCounts }
    | { op: 'clear'; written: null };

/** One step of the page's record keeping, pure: from the key the page last
 *  wrote ("arrived/total", or null while it holds none) and the counts the
 *  model calls for now (lostRecordOf), what to do to storage. Storage changes
 *  only when the record does: a progress tick keeps it, each later ack
 *  rewrites it, and an ending, or a fragment naming another room, clears it. */
export function lostSyncStep(written: string | null, counts: LostCounts | null): LostSync {
    if (!counts) return written === null ? { op: 'keep', written } : { op: 'clear', written: null };
    const next = `${counts.arrived}/${counts.total}`;
    return next === written ? { op: 'keep', written } : { op: 'write', written: next, counts };
}

/** Remove the record. */
export function clearLost(store: LostStore | null): void {
    if (!store) return;
    try {
        store.removeItem(LOST_KEY);
    } catch {
        // Best effort: the next load's takeLost removes it or reads nothing.
    }
}

/** Read the record once and remove it, whatever it held. The counts come back
 *  only to a load the browser reports as a discard's, and only from a record
 *  of exactly the shape recordLost writes, with a pair the card can show. */
export function takeLost(store: LostStore | null, wasDiscarded: boolean): LostCounts | null {
    if (!store) return null;
    let raw: string | null = null;
    try {
        raw = store.getItem(LOST_KEY);
    } catch {
        raw = null;
    }
    clearLost(store);
    if (wasDiscarded !== true || raw === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const fields = parsed as Record<string, unknown>;
    if (Object.keys(fields).length !== 3 || fields.v !== 1) return null;
    if (!isLostPair(fields.arrived, fields.total)) return null;
    return { arrived: fields.arrived as number, total: fields.total as number };
}
