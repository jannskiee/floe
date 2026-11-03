import { describe, it, expect } from 'vitest';
import { guardsFor } from './guards';
import { EVERY_VISITOR_STATE as ALL } from './everyVisitorState';
import type { VisitorState } from './visitorState';

// The contract columns of spec 07 4.12.1: wake lock and beforeunload are held
// while an attempt is live (V6, with its limiter-retry sub-state V6c, V7 and
// V10) and nowhere else; the hidden-tab title applies from Waiting on.

describe('visitor guards', () => {
    it('wake lock and beforeunload are held only in V6, V7 and V10', () => {
        const held = ALL.filter((s) => guardsFor(s).wakeLock);
        expect(held).toEqual(['V6', 'V6c', 'V7', 'V10']);
        for (const s of ALL) {
            // The two always travel together: a page that asks to stay awake
            // is a page whose close would lose a drop.
            expect(guardsFor(s).beforeUnload, s).toBe(guardsFor(s).wakeLock);
        }
        // Every attempt-ending state lets both go, including the three that
        // render Ready again.
        for (const s of ['V1', 'V6a', 'V6b', 'V6d', 'V6e', 'V6f', 'V6g', 'V4', 'V13'] as VisitorState[]) {
            expect(guardsFor(s)).toMatchObject({ wakeLock: false, beforeUnload: false });
        }
    });

    it('title while hidden applies in V7, V10, V11, V12 and V13', () => {
        const titled = ALL.filter((s) => guardsFor(s).titleWhileHidden);
        expect(titled).toEqual(['V7', 'V10', 'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13']);
    });
});
