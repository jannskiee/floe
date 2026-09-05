import { describe, it, expect } from 'vitest';
import { pickActiveSection, ACTIVE_LINE_PX } from './legalToc';

const tops = (values: number[]) => values.map((top, i) => ({ id: `s${i + 1}`, top }));

describe('pickActiveSection', () => {
    it('returns null for an empty list', () => {
        expect(pickActiveSection([], false)).toBeNull();
    });

    it('marks the topmost section before any of them reaches the line', () => {
        // Top of the page: the intro fills the viewport and every section is
        // still below the line.
        expect(pickActiveSection(tops([600, 1100, 1700]), false)).toBe('s1');
    });

    it('marks the lowest section whose top has crossed the line', () => {
        expect(pickActiveSection(tops([-500, 60, 320, 900]), false)).toBe('s2');
    });

    it('treats a top exactly on the line as crossed', () => {
        expect(pickActiveSection(tops([-200, ACTIVE_LINE_PX, 800]), false)).toBe('s2');
    });

    it('lands on the section a TOC click scrolls to, even when the next one is short', () => {
        // scroll-mt leaves the clicked section 40px from the top. On the terms
        // page the section after it can start only ~110px further down.
        expect(pickActiveSection(tops([-300, 40, 150, 260]), false)).toBe('s2');
    });

    it('marks the lowest section at the bottom of the page whatever the geometry', () => {
        // A short closing section that never reaches the line.
        expect(pickActiveSection(tops([-1200, -600, 500]), true)).toBe('s3');
    });

    it('does not depend on the order the sections are passed in', () => {
        const shuffled = [
            { id: 'c', top: 320 },
            { id: 'a', top: -500 },
            { id: 'd', top: 900 },
            { id: 'b', top: 60 },
        ];
        expect(pickActiveSection(shuffled, false)).toBe('b');
        expect(pickActiveSection(shuffled, true)).toBe('d');
        expect(pickActiveSection(shuffled.map((s) => ({ ...s, top: s.top + 1000 })), false)).toBe('a');
    });
});
