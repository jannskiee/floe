// Pure helpers for the Clear control on the send view. They live outside
// App.tsx for the same reason settings.ts and reset.ts do: so they can be
// tested without a DOM or the Wails runtime bindings, which do not exist
// outside the WebView.

/** What Clear took away, held only long enough to put it back. `kind` is the
 *  send tab it came from, so an undo can never restore a note into the file
 *  list or the other way round. Text is kept raw, not trimmed: undo has to
 *  return the box exactly as it was, whitespace and all. */
export type Cleared =
    | {kind: 'files'; files: string[]}
    | {kind: 'text'; text: string};

/** How long the undo BAR stays on screen. Ten seconds rather than the five or
 *  six a plain notification gets, because this one carries an action: Shopify's
 *  Polaris warns in the console below 10s for exactly that reason, Material's
 *  own Long duration is 10s, and VS Code gives an actionable notice 10 to 15.
 *  Pointing at the bar or reaching it with the keyboard holds it open past this,
 *  and a dialog opening over it stops the clock.
 *
 *  It does NOT govern the offer. The snapshot stands until something stages or
 *  changes the send view, so Ctrl+Z works long after the bar has gone. Nothing
 *  the user can lose is on a countdown; only the message about it is. */
export const UNDO_WINDOW_MS = 10000;

/**
 * stagedSnapshot describes what the send tab is currently holding, or null
 * when there is nothing to clear.
 *
 * The emptiness test matches the Send button's own disabled rule, so Clear
 * appears exactly when Send has something to act on: a file list is empty at
 * zero entries, and a note is empty when it is only whitespace.
 */
export function stagedSnapshot(kind: 'files' | 'text', files: string[], text: string): Cleared | null {
    if (kind === 'text') return text.trim() === '' ? null : {kind: 'text', text};
    return files.length === 0 ? null : {kind: 'files', files};
}

/** restorable says whether an offer can be put back into the tab now on screen.
 *  An offer belongs to the tab it was taken from: restoring a note into the file
 *  list, or a file list into a note, would be worse than not restoring at all.
 *  Every path that changes the tab retires the offer, so a mismatch means one of
 *  them was missed; this is the check that makes the miss harmless. There is
 *  deliberately no clock in here. Nothing is persisted anywhere, so an offer
 *  never outlives the process that made it. */
export function restorable(c: Cleared, kind: 'files' | 'text'): boolean {
    return c.kind === kind;
}

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/** clearedLabel is the line the undo bar shows. It says what went, in the same
 *  words the Send button and the history entries use ("items"), so the count
 *  reads as the one the user just saw. No full stop: the row is a label paired
 *  with a control, not prose, and a period mid-row punctuates a thought the
 *  button beside it has not finished. The app's text-only status lines keep
 *  theirs. */
export function clearedLabel(c: Cleared): string {
    return c.kind === 'text' ? 'Cleared the text' : `Cleared ${items(c.files.length)}`;
}

/** clearLabel is the Clear button's accessible name. The visible word stays
 *  "Clear" because its object is right there in the Send label beside it, but a
 *  name has to carry that object itself. It contains the visible word, so
 *  speech control still matches "click Clear". */
export function clearLabel(c: Cleared): string {
    return c.kind === 'text' ? 'Clear the text' : `Clear ${items(c.files.length)}`;
}

/** undoLabel is the Undo button's accessible name. Focus lands here the moment
 *  a clear happens, so this is the first thing a screen reader says about it,
 *  and "Undo" alone would not say undo what. */
export function undoLabel(c: Cleared): string {
    return c.kind === 'text' ? 'Undo clearing the text' : `Undo clearing ${items(c.files.length)}`;
}

/** clearedAnnouncement is what the always-mounted live region says: the visible
 *  sentence plus the one thing that row shows rather than states. Built FROM
 *  clearedLabel so the words on screen and the words in speech cannot drift.
 *  No number of seconds, because promising seconds in speech costs some of
 *  them to say, and the window is a constant that should stay tunable. */
export function clearedAnnouncement(c: Cleared): string {
    // The full stop the visible line drops goes back in here, at the seam:
    // punctuation is what makes a screen reader pause, and without it this is
    // one run-on breath.
    return `${clearedLabel(c)}. Undo is available.`;
}
