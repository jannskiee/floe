import { describe, it, expect } from 'vitest';
import { sleptWhileHidden } from './sleepCheck';

// Wall clock against the monotonic clock across a hidden stretch: the gap is
// time the machine spent asleep (spec 07 4.14.4, C-98). Strictly over 30 s.

describe('sleep check', () => {
    it('a 29 s gap is not sleep', () => {
        expect(sleptWhileHidden({ dateDeltaMs: 60_000 + 29_000, perfDeltaMs: 60_000 })).toBe(false);
        expect(sleptWhileHidden({ dateDeltaMs: 30_000, perfDeltaMs: 0 })).toBe(false);
    });

    it('a 31 s gap is sleep', () => {
        expect(sleptWhileHidden({ dateDeltaMs: 60_000 + 31_000, perfDeltaMs: 60_000 })).toBe(true);
        expect(sleptWhileHidden({ dateDeltaMs: 30_001, perfDeltaMs: 0 })).toBe(true);
    });

    it('a clock set backwards or a bad reading is not sleep', () => {
        expect(sleptWhileHidden({ dateDeltaMs: -3_600_000, perfDeltaMs: 1000 })).toBe(false);
        expect(sleptWhileHidden({ dateDeltaMs: Number.NaN, perfDeltaMs: 0 })).toBe(false);
        expect(sleptWhileHidden({ dateDeltaMs: 100_000, perfDeltaMs: Number.NaN })).toBe(false);
    });
});
