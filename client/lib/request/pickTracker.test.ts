import { describe, it, expect } from 'vitest';
import { createPickTracker } from './pickTracker';

// WP-W1 review F5: `reading` was one boolean, so the first of two overlapping
// drops turned Send back on while the second was still being walked, and a
// Clear during a walk was undone when the walk landed.

describe('pick tracker', () => {
    it('overlapping walks keep reading on until the last one settles', () => {
        const t = createPickTracker();
        expect(t.reading()).toBe(false);
        t.begin();
        t.begin();
        expect(t.reading()).toBe(true);
        t.end();
        expect(t.reading()).toBe(true);
        t.end();
        expect(t.reading()).toBe(false);
        // An extra end never drives the count below zero.
        t.end();
        t.begin();
        expect(t.reading()).toBe(true);
    });

    it('a walk that started before Clear is dropped when it lands', () => {
        const t = createPickTracker();
        const before = t.begin();
        t.clear();
        const after = t.begin();
        expect(t.current(before)).toBe(false);
        expect(t.current(after)).toBe(true);
        t.end();
        t.end();
        expect(t.reading()).toBe(false);
    });
});
