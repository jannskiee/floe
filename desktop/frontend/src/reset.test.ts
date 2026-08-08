import {describe, expect, it} from 'vitest';
import {resetWarning} from './reset';

const base = {transferring: false, busy: false, justSent: false, text: ''};

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
        expect(resetWarning({...base, justSent: true, text: 'the note I just sent'})).toBe('');
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
