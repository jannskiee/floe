import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bulkDownloadShown, joinStepsShown, receiveSummary, receiverTabMatters } from './receiveSummary';

// The transfer audit reads the receiver page with this expression and takes a
// match as "every file arrived" (.claude/skills/transfer-audit/scripts/lib/
// web.mjs). It is not anchored, so a partial line that merely contains the
// words would be read as a finished transfer with the wrong count.
const AUDIT_COMPLETE = /(\d+) files? received/;

describe('receiveSummary', () => {
    it('says nothing before a file has arrived', () => {
        expect(receiveSummary({ received: 0, expected: 0, ended: false })).toEqual({ kind: 'none' });
        expect(receiveSummary({ received: 0, expected: 3, ended: false })).toEqual({ kind: 'none' });
        // A transfer that ended with nothing is the error banner's to explain.
        expect(receiveSummary({ received: 0, expected: 3, ended: true })).toEqual({ kind: 'none' });
    });

    it('counts a full receive in the words the page has always used', () => {
        expect(receiveSummary({ received: 1, expected: 1, ended: false })).toEqual({
            kind: 'complete',
            text: '1 file received',
        });
        expect(receiveSummary({ received: 3, expected: 3, ended: false })).toEqual({
            kind: 'complete',
            text: '3 files received',
        });
        // The connection closing after the last file changes nothing: a Go
        // sender closes about 50 ms after its last end marker.
        expect(receiveSummary({ received: 3, expected: 3, ended: true })).toEqual({
            kind: 'complete',
            text: '3 files received',
        });
    });

    it('treats a sender that announced no count as complete, as before', () => {
        expect(receiveSummary({ received: 2, expected: 0, ended: true })).toEqual({
            kind: 'complete',
            text: '2 files received',
        });
    });

    it('is complete at or past the announced count, never short', () => {
        // A second batch on the same connection adds to the list while the
        // announced count is the new batch's.
        expect(receiveSummary({ received: 4, expected: 3, ended: false }).kind).toBe('complete');
    });

    // "The rest", not "the next file": this line can be on screen while the
    // next file is already arriving. When the page's own signaling socket
    // drops mid-file the status is rewritten, the line shows, and the progress
    // row under it is still moving.
    it('says how far a transfer still running has got', () => {
        expect(receiveSummary({ received: 1, expected: 3, ended: false })).toEqual({
            kind: 'waiting',
            text: 'Received 1 of 3 files. Waiting for the rest',
        });
        expect(JSON.stringify(receiveSummary({ received: 2, expected: 3, ended: false }))).not.toContain('next file');
    });

    it('says a transfer that ended early is not complete', () => {
        expect(receiveSummary({ received: 1, expected: 3, ended: true })).toEqual({
            kind: 'short',
            text: 'Received 1 of 3 files. The transfer ended before the rest arrived.',
        });
        expect(receiveSummary({ received: 2, expected: 3, ended: true })).toEqual({
            kind: 'short',
            text: 'Received 2 of 3 files. The transfer ended before the rest arrived.',
        });
    });

    it('never lets a partial line read as a finished transfer', () => {
        for (const ended of [false, true]) {
            for (let expected = 2; expected <= 12; expected++) {
                for (let received = 1; received < expected; received++) {
                    const summary = receiveSummary({ received, expected, ended });
                    expect(summary.kind).toBe(ended ? 'short' : 'waiting');
                    expect('text' in summary && summary.text).not.toMatch(AUDIT_COMPLETE);
                }
            }
        }
    });

    it('keeps the complete line alone and anchored', () => {
        for (const received of [1, 2, 10]) {
            const summary = receiveSummary({ received, expected: received, ended: true });
            expect('text' in summary && summary.text).toMatch(/^(\d+) files? received$/);
        }
    });
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// The three joining steps ("Secure room joined", "Waiting for the sender to
// start", "Files stream in below") describe an attempt that is under way. Once
// the attempt had ended with nothing received, the connected flag went false
// and the first step drew its spinner again, under a red banner, as if the
// page were joining. Nothing was retrying.
describe('joinStepsShown', () => {
    it('draws the steps while an attempt is under way and nothing has arrived', () => {
        expect(joinStepsShown({ received: 0, busy: false, ended: false })).toBe(true);
    });

    it('stops drawing them once the attempt has ended with nothing', () => {
        expect(joinStepsShown({ received: 0, busy: false, ended: true })).toBe(false);
    });

    it('keeps them away while a file is arriving or being checked, and once one is here', () => {
        expect(joinStepsShown({ received: 0, busy: true, ended: false })).toBe(false);
        expect(joinStepsShown({ received: 1, busy: false, ended: false })).toBe(false);
        expect(joinStepsShown({ received: 1, busy: false, ended: true })).toBe(false);
    });

    it('is how the card decides', () => {
        expect(read('../components/ReceiverPanel.tsx')).toContain('joinStepsShown({ received: receivedFiles.length, busy, ended })');
    });
});

// "Keep this tab open. Closing it interrupts the download." is for a tab that
// something depends on.
describe('receiverTabMatters', () => {
    const base = { linkInvalid: false, senderAbsent: false, ended: false, received: 0 };

    it('matters while the page is waiting for a sender that is there', () => {
        expect(receiverTabMatters(base)).toBe(true);
    });

    it('matters whenever files are in the tab, because closing it loses them', () => {
        expect(receiverTabMatters({ ...base, received: 2 })).toBe(true);
        expect(receiverTabMatters({ ...base, received: 2, senderAbsent: true })).toBe(true);
        expect(receiverTabMatters({ ...base, received: 2, ended: true })).toBe(true);
    });

    it('does not matter under the Link Invalid card, whatever else is true', () => {
        expect(receiverTabMatters({ ...base, linkInvalid: true })).toBe(false);
        expect(receiverTabMatters({ ...base, linkInvalid: true, received: 2 })).toBe(false);
    });

    it('does not matter while nobody is on the sending side and nothing has arrived', () => {
        expect(receiverTabMatters({ ...base, senderAbsent: true })).toBe(false);
    });

    it('does not matter after an attempt that ended with nothing: there is no download to interrupt', () => {
        expect(receiverTabMatters({ ...base, ended: true })).toBe(false);
    });

    it('is how the page picks the line under the card', () => {
        const page = read('../components/P2PTransfer.tsx');
        expect(page).toContain('receiverTabMatters({');
        expect(page).not.toContain('(senderAbsent && receivedFiles.length === 0)');
    });
});

// The iOS tip says to use "Download ZIP". That button exists only for two or
// more files and is hidden while one is arriving, so the tip follows it.
describe('bulkDownloadShown', () => {
    it('is the two bulk buttons: two or more files, and nothing arriving', () => {
        expect(bulkDownloadShown({ received: 0, busy: false })).toBe(false);
        expect(bulkDownloadShown({ received: 1, busy: false })).toBe(false);
        expect(bulkDownloadShown({ received: 2, busy: false })).toBe(true);
        expect(bulkDownloadShown({ received: 5, busy: true })).toBe(false);
    });

    it('gates the buttons and the tip that names one of them, and nothing else gates the tip', () => {
        const card = read('../components/ReceiverPanel.tsx');
        expect(card).toContain('const showBulk = bulkDownloadShown({ received: receivedFiles.length, busy });');
        const tipAt = card.indexOf('Tip: Use');
        const tip = card.slice(card.lastIndexOf('{typeof navigator', tipAt), tipAt);
        expect(tip.length).toBeGreaterThan(20);
        expect(tip).toContain('showBulk');
        expect(tip).not.toContain('receivedFiles.length > 0');
    });
});
