// Pure helpers for the History view. They live outside App.tsx so they can be
// tested without a DOM or the Wails runtime bindings, which do not exist
// outside the WebView (the same arrangement as settings.ts).

/** histKey identifies a history entry independently of its list position, so
 *  removing an entry above an expanded row cannot shift which row is open.
 *  `at` alone is near-unique (transfers are busy-gated, one at a time), but
 *  localStorage['floe:history'] is loaded verbatim and user-editable, so the
 *  first name and the count are folded in as free tiebreakers. Byte-identical
 *  entries still collide; that is accepted for a 50-entry local list. */
export function histKey(h: {at: number; names: string[]; count: number}): string {
    return `${h.at}-${h.names[0] ?? ''}-${h.count}`;
}
