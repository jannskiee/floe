import { describe, it, expect } from 'vitest';
import { receiveSummary } from './receiveSummary';

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
