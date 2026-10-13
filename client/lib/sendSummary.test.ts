import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendProgressLabel, sendRowMark, shareStatusComplete, type SendEnd } from './sendSummary';

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

    // The label was not the only thing on that row. The speed and the time
    // remaining stayed beside a send that had stopped ("4.2 MB/s · 1m 12s" at
    // 37%, for as long as the page was open), and the file that stopped kept
    // the white name of a file on its way.
    it('a sender shows a speed, a time and a moving name only while a send is open', () => {
        const list = read('../components/SelectedFilesList.tsx');
        const bar = read('../components/TransferProgressBar.tsx');
        expect(bar).toContain("(!isSender || sendEnd === 'open')");
        expect(list).toContain("marks[i] === 'sending' && progress < 100");
        expect(list).not.toContain('i === currentFileIndex && progress > 0 && progress < 100');
    });

    // Where a sender session begins is the one place that knows the last send
    // is over. Everything that send left on screen goes there: its marks, its
    // readout, and its banner, which used to stay ("The connection closed
    // before the transfer finished." above "All Files Sent!" once a recipient
    // had come back and the resend had finished) and, because the close
    // handler keeps a banner that is already up, hid the next failure's own.
    it('a new recipient starts with nothing of the last send on screen', () => {
        const page = read('../components/P2PTransfer.tsx');
        const from = page.indexOf("setSendEnd('open');");
        const to = page.indexOf("setStatus('Peer joined. Starting transfer');", from);
        expect(from).toBeGreaterThan(0);
        expect(to).toBeGreaterThan(from);
        const block = page.slice(from, to);
        for (const reset of ["setCurrentFileIndex(0);", "setProgress(0);", "setError('');", "setTransferSpeed('');", "setEstimatedTime('');"]) {
            expect(block, reset).toContain(reset);
        }
    });

    // A session that was replaced while it waited for an answer still reports
    // its end. That report is about a connection the page has moved on from.
    it('a replaced session cannot report over the one that replaced it', () => {
        const page = read('../components/P2PTransfer.tsx');
        const at = page.indexOf('onError: (msg) => {');
        expect(at).toBeGreaterThan(0);
        const body = page.slice(at, page.indexOf('},', at));
        expect(body.indexOf('if (peerRef.current !== peer) return;')).toBeGreaterThan(0);
        // The banner call it guards (the message goes through peerBanner).
        const sets = body.indexOf('setError(peerBanner(msg, ');
        expect(sets).toBeGreaterThan(0);
        expect(body.indexOf('if (peerRef.current !== peer) return;')).toBeLessThan(sets);
    });
});

// The check mark beside the share link. The status line is not only the
// page's own sentences: while a file moves it reads "Sending: <name>", with
// the sender's own file name in it. The panel asked whether the line
// CONTAINED "Transfer complete", so a file of that name earned the green
// check, and lost its spinner, while it was still being sent.
describe('the share panel reads the status whole', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

    it('is complete for the two sentences that say so, and for nothing that only contains them', () => {
        expect(shareStatusComplete('All Files Sent!')).toBe(true);
        expect(shareStatusComplete('Transfer complete')).toBe(true);
        for (const status of [
            '',
            'Sending: Transfer complete.txt',
            'Sending: All Files Sent!',
            'Sending: notes on Transfer complete',
            'Transfer complete.',
            'transfer complete',
            'Transfer failed',
            'Connection interrupted',
            'Peer disconnected. Waiting for reconnection',
        ]) {
            expect(shareStatusComplete(status), status).toBe(false);
        }
    });

    it('is the only way the panel decides, and the panel never searches the line', () => {
        const panel = read('../components/ShareLinkPanel.tsx');
        expect(panel).toContain('const isComplete = shareStatusComplete(status);');
        expect(panel).not.toMatch(/\bstatus\.(?:includes|startsWith|endsWith|indexOf|search|match)\(/);
    });
});
