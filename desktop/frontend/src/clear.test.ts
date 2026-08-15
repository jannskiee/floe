import {describe, expect, it} from 'vitest';
import {UNDO_WINDOW_MS, clearLabel, clearedAnnouncement, clearedLabel, restorable, stagedSnapshot, undoLabel} from './clear';

describe('stagedSnapshot', () => {
    it('is null when there is nothing to clear', () => {
        expect(stagedSnapshot('files', [], 'ignored')).toBeNull();
        expect(stagedSnapshot('text', ['ignored.txt'], '')).toBeNull();
    });
    // The same rule the Send button uses: a note of only whitespace is not a note.
    it('treats a whitespace-only note as empty', () => {
        expect(stagedSnapshot('text', [], '   \n\t ')).toBeNull();
    });
    it('reads only the tab it was asked about', () => {
        expect(stagedSnapshot('files', ['a.txt'], '')).toEqual({kind: 'files', files: ['a.txt']});
        expect(stagedSnapshot('text', [], 'hello')).toEqual({kind: 'text', text: 'hello'});
    });
    // Undo has to hand the box back exactly as it was, so the snapshot keeps
    // the untrimmed string even though the emptiness test trims.
    it('keeps the note untrimmed', () => {
        expect(stagedSnapshot('text', [], '  hi  ')).toEqual({kind: 'text', text: '  hi  '});
    });
    it('keeps the file order it was given', () => {
        const files = ['b.txt', 'a.txt', 'c.txt'];
        expect(stagedSnapshot('files', files, '')).toEqual({kind: 'files', files});
    });
});

describe('clearedLabel', () => {
    it('counts items the way the Send button does', () => {
        expect(clearedLabel({kind: 'files', files: ['a.txt']})).toBe('Cleared 1 item');
        expect(clearedLabel({kind: 'files', files: ['a.txt', 'b.txt']})).toBe('Cleared 2 items');
    });
    it('names the note without counting it', () => {
        expect(clearedLabel({kind: 'text', text: 'hello'})).toBe('Cleared the text');
    });
    // The bar pairs this line with a button, so it is a label rather than
    // prose. The period belongs only in the spoken version, where it is what
    // makes a screen reader pause before "Undo is available".
    it('carries no full stop, while the announcement does', () => {
        expect(clearedLabel({kind: 'files', files: ['a.txt']})).not.toContain('.');
        expect(clearedAnnouncement({kind: 'files', files: ['a.txt']})).toContain('item. Undo');
    });
    // Folders stage into the same list as files, so the count has to be in
    // items. "Cleared 12 files." would be a lie about a folder pick.
    it('never counts in files', () => {
        expect(clearedLabel({kind: 'files', files: ['a.txt', 'b.txt']})).not.toContain('file');
    });
    it('uses no em dashes', () => {
        const all = [
            clearedLabel({kind: 'files', files: ['a.txt']}),
            clearedLabel({kind: 'files', files: ['a.txt', 'b.txt']}),
            clearedLabel({kind: 'text', text: 'hello'}),
        ];
        for (const s of all) {
            expect(s).not.toContain('—');
            expect(s).not.toContain('–');
        }
    });
});

// The two accessible names. Both have to contain their visible word, or speech
// control ("click Clear", "click Undo") stops matching the button: WCAG 2.5.3.
describe('the accessible names', () => {
    it('name what would go, and what would come back', () => {
        expect(clearLabel({kind: 'files', files: ['a', 'b']})).toBe('Clear 2 items');
        expect(clearLabel({kind: 'files', files: ['a']})).toBe('Clear 1 item');
        expect(clearLabel({kind: 'text', text: 'x'})).toBe('Clear the text');
        expect(undoLabel({kind: 'files', files: ['a', 'b', 'c']})).toBe('Undo clearing 3 items');
        expect(undoLabel({kind: 'text', text: 'x'})).toBe('Undo clearing the text');
    });
    it('contain their visible words', () => {
        expect(clearLabel({kind: 'files', files: ['a']})).toContain('Clear');
        expect(undoLabel({kind: 'files', files: ['a']})).toContain('Undo');
    });
    // The announcement is spoken, and a cleared note is exactly the thing the
    // user just decided nobody should be looking at.
    it('never repeat the text they cleared', () => {
        expect(clearedAnnouncement({kind: 'text', text: 'my bank code'})).not.toContain('bank');
        expect(undoLabel({kind: 'text', text: 'my bank code'})).not.toContain('bank');
    });
    it('carry the visible sentence into speech verbatim', () => {
        const c = {kind: 'files' as const, files: ['a', 'b']};
        expect(clearedAnnouncement(c)).toContain(clearedLabel(c));
        expect(clearedAnnouncement(c)).toContain('Undo');
    });
    // The window is a constant that should stay tunable without touching copy.
    it('promise no particular number of seconds', () => {
        expect(clearedAnnouncement({kind: 'text', text: 'x'})).not.toMatch(/\d/);
    });
});

// The guard that makes a missed retire harmless. Ctrl+O was the path that
// missed one: it switched to the Files tab without dropping a note's offer, so
// Undo would have pushed the note into a box that was not on screen, and a Clear
// on the new tab would have destroyed it silently. Every tab-changing path
// retires the offer now, and this is the check that survives the next one that
// forgets.
describe('restorable', () => {
    it('allows an undo only into the tab the offer came from', () => {
        expect(restorable({kind: 'files', files: ['a.txt']}, 'files')).toBe(true);
        expect(restorable({kind: 'text', text: 'hi'}, 'text')).toBe(true);
    });
    it('refuses a note into the file list, and a file list into the note', () => {
        expect(restorable({kind: 'text', text: 'hi'}, 'files')).toBe(false);
        expect(restorable({kind: 'files', files: ['a.txt']}, 'text')).toBe(false);
    });
    // No clock anywhere in the offer's life: the bar is what expires. An offer
    // taken an hour ago is still good if nothing has staged or switched since,
    // which is what makes Ctrl+Z a route that does not depend on the clock.
    it('does not depend on how long the offer has stood', () => {
        const c = {kind: 'files' as const, files: ['a.txt']};
        expect(restorable(c, 'files')).toBe(true);
        expect(Object.keys(c)).not.toContain('until');
    });
});

// Clear is offered exactly when Send is armed. Both read stagedSnapshot, and
// this table is what keeps the two from drifting apart if one is ever rewritten.
describe('the emptiness rule Send and Clear share', () => {
    const cases: Array<{kind: 'files' | 'text'; files: string[]; text: string; staged: boolean}> = [
        {kind: 'files', files: [], text: '', staged: false},
        {kind: 'files', files: [], text: 'a note', staged: false},
        {kind: 'files', files: ['a.txt'], text: '', staged: true},
        {kind: 'text', files: [], text: '', staged: false},
        {kind: 'text', files: [], text: '  ', staged: false},
        {kind: 'text', files: ['a.txt'], text: '', staged: false},
        {kind: 'text', files: [], text: 'a note', staged: true},
    ];
    for (const c of cases) {
        it(`${c.kind} tab, ${c.files.length} file(s), note ${JSON.stringify(c.text)}`, () => {
            const sendEnabled = c.kind === 'text' ? c.text.trim() !== '' : c.files.length > 0;
            expect(stagedSnapshot(c.kind, c.files, c.text) !== null).toBe(c.staged);
            expect(stagedSnapshot(c.kind, c.files, c.text) !== null).toBe(sendEnabled);
        });
    }
});

describe('UNDO_WINDOW_MS', () => {
    // Guards against a stray edit: a bar that shows for a blink or for a minute
    // is a different feature from the one that was designed. The floor is the
    // one every design system with an ACTION in its toast converges on (Polaris
    // warns below it, Material's Long is exactly it), so dropping back to the
    // five or six seconds a plain notice gets would be a regression. Note this
    // bounds the BAR only; the undo behind it is not on a clock at all.
    it('stands long enough for an offer that carries an action', () => {
        expect(UNDO_WINDOW_MS).toBeGreaterThanOrEqual(10000);
        expect(UNDO_WINDOW_MS).toBeLessThanOrEqual(20000);
    });
});
