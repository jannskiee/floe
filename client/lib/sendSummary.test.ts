import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendProgressLabel, sendRowMark, type SendEnd } from './sendSummary';

const marks = (files: number, currentFileIndex: number, progress: number, end: SendEnd) =>
    Array.from({ length: files }, (_, index) => sendRowMark({ index, currentFileIndex, progress, end }));

describe('sendRowMark', () => {
    // The bug this module exists for: the last file is the current one and its
    // progress is 100, so any rule that reads the status line draws a spinner
    // the moment that line changes from "All Files Sent!" to anything else.
    it('checks every row once the send was delivered, the last one included', () => {
        expect(sendRowMark({ index: 2, currentFileIndex: 2, progress: 100, end: 'delivered' })).toBe('sent');
        for (let files = 1; files <= 12; files++) {
            expect(marks(files, files - 1, 100, 'delivered')).toEqual(Array(files).fill('sent'));
        }
    });

    it('keeps the rule the page had while a send is open', () => {
        // Before anything moves: no marks.
        expect(marks(3, 0, 0, 'open')).toEqual(['none', 'none', 'none']);
        // File 2 of 3 on its way.
        expect(marks(3, 1, 40, 'open')).toEqual(['sent', 'sending', 'none']);
        // Between files: the next one has been announced and has sent nothing.
        expect(marks(3, 2, 0, 'open')).toEqual(['sent', 'sent', 'none']);
    });

    // A check on an earlier row means that file left this browser. The page
    // cannot know which file a receiver refused, so the row that was moving
    // loses its spinner and gains nothing.
    it('never spins and never checks the current row after a failure', () => {
        expect(marks(3, 1, 40, 'failed')).toEqual(['sent', 'none', 'none']);
        expect(marks(3, 2, 100, 'failed')).toEqual(['sent', 'sent', 'none']);
        expect(marks(1, 0, 100, 'failed')).toEqual(['none']);
    });

    it('never shows every row checked after a failure, for any number of files', () => {
        for (let files = 1; files <= 12; files++) {
            for (let current = 0; current < files; current++) {
                const row = marks(files, current, 100, 'failed');
                expect(row).not.toContain('sending');
                expect(row.every((m) => m === 'sent')).toBe(false);
            }
        }
    });
});

describe('sendProgressLabel', () => {
    it('counts the files once the send was delivered', () => {
        expect(sendProgressLabel({ end: 'delivered', currentFileIndex: 0, filesCount: 1 })).toBe('Sent 1 file');
        expect(sendProgressLabel({ end: 'delivered', currentFileIndex: 2, filesCount: 3 })).toBe('Sent 3 files');
    });

    it('names the file on its way while a send is open', () => {
        expect(sendProgressLabel({ end: 'open', currentFileIndex: 0, filesCount: 3 })).toBe('Sending file 1 of 3...');
        expect(sendProgressLabel({ end: 'open', currentFileIndex: 2, filesCount: 3 })).toBe('Sending file 3 of 3...');
    });

    // "Sending file 3 of 3..." beside a transfer that stopped is a false
    // claim, and the banner above the row already says what happened.
    it('says nothing after a failure', () => {
        expect(sendProgressLabel({ end: 'failed', currentFileIndex: 2, filesCount: 3 })).toBe('');
    });
});

// Neither component can be mounted here (vitest runs in node, with no DOM), so
// the wiring is read as text. e2e/reconnect.spec.ts drives the real thing.
describe('how the two components use it', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

    // The status line is rewritten by three handlers after a finished send
    // (the peer left, this page's own socket dropped, the peer errored). Any
    // comparison against one of its sentences goes wrong when it changes.
    it('neither reads the status sentence to decide what a sender sees', () => {
        const list = read('../components/SelectedFilesList.tsx');
        const bar = read('../components/TransferProgressBar.tsx');
        for (const src of [list, bar]) {
            expect(src).not.toContain("'All Files Sent!'");
            expect(src).not.toContain("'Transfer failed'");
        }
        expect(list).toContain('sendRowMark(');
        expect(bar).toContain('sendProgressLabel(');
    });
});
