import { describe, it, expect } from 'vitest';
import { visitorTitle, VISIBLE_TITLE } from './titleProgress';
import type { VisitorState } from './visitorState';

// document.title while the tab is hidden (spec 07 4.14.3). A mild positive
// against Memory Saver's proactive discards, never relied on (E-50). Counts
// and a percentage only: a hidden tab's title is visible in the tab strip and
// the window switcher, so no name or path ever goes into it.

const P = { percent: 48, index: 4, total: 12 };

describe('hidden tab titles', () => {
    it('each title in spec 07 4.14.3', () => {
        expect(visitorTitle('V7', P, true)).toBe('Waiting for them to accept - Floe');
        expect(visitorTitle('V10', P, true)).toBe('48% sent, 4 of 12 files - Floe');
        expect(visitorTitle('V13', P, true)).toBe('All 12 files arrived - Floe');
        for (const s of ['V11', 'V11a', 'V11b', 'V12', 'V12a'] as VisitorState[]) {
            expect(visitorTitle(s, P, true)).toBe('Drop stopped - Floe');
        }
        // States with no hidden title keep the page's own.
        for (const s of ['load', 'V3', 'V6', 'V6c', 'V4', 'V8a'] as VisitorState[]) {
            expect(visitorTitle(s, P, true)).toBe('Send files - Floe');
        }
    });

    it('visible restores Send files - Floe', () => {
        expect(VISIBLE_TITLE).toBe('Send files - Floe');
        for (const s of ['V7', 'V10', 'V11', 'V12', 'V13', 'V3'] as VisitorState[]) {
            expect(visitorTitle(s, P, false)).toBe('Send files - Floe');
        }
    });

    it('the progress title is clamped and whole', () => {
        expect(visitorTitle('V10', { percent: 48.7, index: 4, total: 12 }, true)).toBe('48% sent, 4 of 12 files - Floe');
        expect(visitorTitle('V10', { percent: 140, index: 12, total: 12 }, true)).toBe('100% sent, 12 of 12 files - Floe');
        expect(visitorTitle('V10', { percent: Number.NaN, index: 1, total: 12 }, true)).toBe('0% sent, 1 of 12 files - Floe');
    });

    it('a drop of one file says file (D-123, T-02 and T-03)', () => {
        // The approved drawn form of T-02 (index 0), the page's own 1-based
        // index, and T-03; each beside its nearest plural neighbor, N = 2.
        expect(visitorTitle('V10', { percent: 48, index: 0, total: 1 }, true)).toBe('48% sent, 0 of 1 file - Floe');
        expect(visitorTitle('V10', { percent: 48, index: 1, total: 1 }, true)).toBe('48% sent, 1 of 1 file - Floe');
        expect(visitorTitle('V13', { percent: 100, index: 1, total: 1 }, true)).toBe('1 file arrived - Floe');
        expect(visitorTitle('V10', { percent: 48, index: 1, total: 2 }, true)).toBe('48% sent, 1 of 2 files - Floe');
        expect(visitorTitle('V13', { percent: 100, index: 2, total: 2 }, true)).toBe('All 2 files arrived - Floe');
    });

    it('no title contains an em or en dash', () => {
        const dash = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
        const states: VisitorState[] = ['load', 'V3', 'V6', 'V7', 'V10', 'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13'];
        for (const s of states) {
            for (const hidden of [true, false]) {
                const t = visitorTitle(s, P, hidden);
                expect(t).not.toMatch(dash);
                // The root template's own separator, the one every page uses.
                expect(t.endsWith(' - Floe')).toBe(true);
            }
        }
    });
});
