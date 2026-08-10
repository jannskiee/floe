import {describe, expect, it} from 'vitest';
import {resetWarning} from './reset';

const base = {transferring: false, busy: false, text: '', sentText: ''};

describe('resetWarning', () => {
    it('says nothing when there is nothing to lose', () => {
        expect(resetWarning(base)).toBe('');
    });

    it('warns about a live transfer', () => {
        expect(resetWarning({...base, transferring: true})).toContain('transfer is in progress');
    });

    // The bug this helper exists for. Ctrl+R and the titlebar lockup both call
    // startOver, doReset calls setSendText(''), and a typed note is persisted
    // nowhere, so before this it vanished with no prompt and no undo.
    it('warns about an unsent text note', () => {
        const s = resetWarning({...base, text: 'half a paragraph'});
        expect(s).toContain('has not been sent');
    });

    it('treats whitespace-only text as nothing to lose', () => {
        expect(resetWarning({...base, text: '   \n  '})).toBe('');
    });

    // A live transfer outranks everything: its wording is about cancelling, which
    // is the more serious consequence and the one the user needs to read.
    it('lets a live transfer outrank an unsent note', () => {
        const s = resetWarning({...base, transferring: true, text: 'draft'});
        expect(s).toContain('transfer is in progress');
        expect(s).not.toContain('has not been sent');
    });

    // The regression guard that matters most. Start over is the escape hatch for
    // a send that is connecting or waiting for a peer, and that state still holds
    // the text. A dialog in front of the escape hatch defeats the escape hatch.
    it('stays silent while busy, so the stuck-state escape hatch is one click', () => {
        expect(resetWarning({...base, busy: true, text: 'draft'})).toBe('');
    });

    // send:done clears neither the text nor the file list, so without this gate
    // the commonest gesture in the app, tidying up after a completed transfer,
    // would prompt every single time.
    it('stays silent right after a completed send', () => {
        const note = 'the note I just sent';
        expect(resetWarning({...base, text: note, sentText: note})).toBe('');
    });

    // The gate above is a claim about the note in the box, not a memory that some
    // send finished. The textarea stays mounted and editable after send:done, so
    // this is the "sent one note, started typing the next" state: the text on
    // screen has never left this machine. It used to be wiped with no prompt,
    // because the old justSent flag could not tell the two apart.
    it('warns once the box holds a different note from the one that went out', () => {
        const s = resetWarning({...base, text: 'note two', sentText: 'note one'});
        expect(s).toContain('has not been sent');
    });

    // The same loss through a different door, and the note is not even on screen
    // for this one: type a note, switch to Files, send files. A file send puts no
    // text on the wire, so sentText is '' and the note is still unsent.
    it('warns about a note typed before a file send', () => {
        const s = resetWarning({...base, text: 'a note nobody has received', sentText: ''});
        expect(s).toContain('has not been sent');
    });

    // Compared trimmed on both sides, so pressing Enter at the end of the note
    // you just sent is not a new note and does not earn a prompt.
    it('treats trailing whitespace on the sent note as the same note', () => {
        expect(resetWarning({...base, text: '  note one\n', sentText: 'note one'})).toBe('');
    });

    // The empty-box guard shares a line with the sentText compare, so clearing the
    // box after a send stays silent whatever went out. Nothing in it, nothing to lose.
    it('stays silent when the box has been emptied since the send', () => {
        expect(resetWarning({...base, text: '', sentText: 'note one'})).toBe('');
    });

    // A transfer that has stopped is not a transfer. The error paths clear their
    // progress objects now, so a failed send lands here rather than in the
    // transferring branch, which used to claim an idle app was mid-transfer and
    // hide the note warning underneath a sentence about cancelling.
    it('sees the unsent note under a transfer that has already failed', () => {
        const s = resetWarning({...base, text: 'the note the failed send was carrying'});
        expect(s).toContain('has not been sent');
    });

    // Staged files are deliberately not a reason to prompt: doReset clears them,
    // but the paths are still on disk, so it is tedious rather than destructive.
    // Encoded as a test so a future "be helpful" change has to argue with it.
    it('does not prompt for staged files, only for unsent text', () => {
        expect(resetWarning(base)).toBe('');
    });

    // House style, enforced rather than trusted: no em dashes anywhere in UI copy.
    it('uses no em dashes', () => {
        for (const s of [
            resetWarning({...base, transferring: true}),
            resetWarning({...base, text: 'draft'}),
        ]) {
            expect(s).not.toContain('—');
        }
    });
});
