/**
 * The calm-copy rule (D-167): no line Floe Desktop shows ends in a period.
 * This walks every string the copy modules can produce, at the copy table's
 * mock values; the DOM walks in RequestLinkView.test.tsx, Toasts.test.tsx and
 * test/app.test.tsx cover what the views draw.
 */
import {describe, expect, it} from 'vitest';
import * as copy from './requestCopy';
import * as settings from './settings';
import {RULES, friendlyError} from './errors';
import {resetWarning} from './reset';
import {endsInPeriod} from './test/punctuation';

const GB = 1024 ** 3;
const END = new Date(2026, 8, 14, 14, 5).getTime();
const NOW = new Date(2026, 8, 14, 9, 30).getTime();
// Text only a screen reader hears keeps its punctuation (test/punctuation.ts).
const SCREEN_READER_ONLY = new Set(['ANNOUNCE_REQUEST', 'ANNOUNCE_GUARD_LIFTED']);
const STOP_CODES = ['disk-full', 'hash-mismatch', 'path-too-long', 'over-approved', 'relay-cap', 'file-too-large-for-folder',
    'write-failed', 'save-blocked', 'stopped', 'peer-abort', 'time-limit', 'unknown'];

function offenders(lines: string[]): string[] {
    return lines.filter(endsInPeriod);
}

describe('no line ends in a period (D-167)', () => {
    it('the rule itself: a period fails, an ellipsis and a question pass', () => {
        expect(endsInPeriod('Link closed.')).toBe(true);
        expect(endsInPeriod('Connecting...')).toBe(false);
        expect(endsInPeriod('Close this link?')).toBe(false);
        expect(endsInPeriod('kept with a .part ending')).toBe(false);
    });

    it('every string the Request link copy exports', () => {
        const lines = Object.entries(copy)
            .filter(([name, v]) => typeof v === 'string' && !SCREEN_READER_ONLY.has(name))
            .map(([, v]) => v as string);
        expect(lines.length).toBeGreaterThan(40);
        expect(offenders(lines)).toEqual([]);
    });

    it('every line the Request link builders make', () => {
        const lines = [
            ...['disabled', 'limited', 'unknown', 'no-relay', 'relay-unknown', 'already-open', 'denied'].map(copy.errorLine),
            copy.scopeLine(END, NOW), copy.scopeLine(END + 3 * 86400000, NOW), copy.scopeLine(END, NOW, true), copy.missedLine(END),
            copy.reopenLine({code: 'setup-failed', suggestClose: false}),
            copy.reopenLine({code: '', missedAt: END, suggestClose: false}),
            copy.reopenLine({code: '', suggestClose: true}),
            ...['expired', 'app-closed', 'closed'].map((c) => copy.endedLine(c, END)),
            copy.promptHeading(''), copy.promptHeading('Acme footage'), copy.promptSize(12, 38 * GB),
            ...['low-space', 'file-too-large-for-drive', 'relay-over-cap'].map((c) =>
                copy.warningLine(c, {freeBytes: 31 * GB, totalBytes: 38 * GB}, 'D:\\Footage\\Floe')),
            copy.countdown(NOW + 9 * 60000, NOW), copy.receivingHeading(4, 12, 'Acme footage'),
            copy.etaLongLine(86400), copy.etaLongLine(3 * 86400), copy.doneHeading(12, 38 * GB),
            copy.renamedLine(1), copy.renamedLine(3),
            ...[0, 1, 4].flatMap((saved) => STOP_CODES.flatMap((c) => [
                copy.stoppedCard(c, saved, 12), copy.stoppedFull(c, saved, 12), copy.keptPartLine(c),
            ])),
            copy.savedOf(1, 1),
        ].filter((s) => s !== '');
        expect(offenders(lines)).toEqual([]);
    });

    it('every Settings string', () => {
        const lines = [
            ...(Object.values(settings) as unknown[]).filter((v): v is string => typeof v === 'string'),
            settings.advancedSummary('https://files.example.com', ''),
            settings.advancedSummary('', 'https://app.example.com'),
            settings.advancedSummary('', ''),
        ];
        expect(offenders(lines)).toEqual([]);
    });

    it('every friendly error line, and an engine sentence passing through', () => {
        expect(offenders(RULES.map(([, friendly]) => friendly))).toEqual([]);
        // Engine text is shared with the CLI and keeps its period at the
        // source; the desktop drops the closing one.
        expect(friendlyError('transfer failed: They declined. Nothing was sent.')).toBe('Error: transfer failed: They declined. Nothing was sent');
        expect(friendlyError('some novel failure.')).toBe('Error: some novel failure');
        expect(friendlyError('still going...')).toBe('Error: still going...');
    });

    it('every Start over warning', () => {
        const base = {transferring: false, busy: false, text: '', sentText: '', clearedText: ''};
        const lines = [
            resetWarning({...base, transferring: true}),
            resetWarning({...base, text: 'hello'}),
            resetWarning({...base, clearedText: 'hello'}),
        ];
        expect(lines.every((s) => s !== '')).toBe(true);
        expect(offenders(lines)).toEqual([]);
    });
});
