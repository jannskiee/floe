import { describe, it, expect } from 'vitest';
import {
    FIRST_MAX_MS,
    FIRST_MIN_MS,
    MAX_DELAY_MS,
    createReconnectBackoff,
    nextDelay,
} from './reconnectBackoff';

// Injected random sources. 1 is outside Math.random's range on purpose: the
// helper must still never exceed its bound.
const lowest = () => 0;
const highest = () => 1;
const middle = () => 0.5;

describe('reconnect backoff', () => {
    it('first delay stays between 2 and 10 seconds', () => {
        expect(nextDelay(0, lowest)).toBe(2_000);
        expect(nextDelay(0, highest)).toBe(10_000);
        expect(nextDelay(0, middle)).toBe(6_000);
        for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999999]) {
            const d = nextDelay(0, () => r);
            expect(d).toBeGreaterThanOrEqual(FIRST_MIN_MS);
            expect(d).toBeLessThanOrEqual(FIRST_MAX_MS);
        }
        // A random source that misbehaves is clamped, never trusted.
        expect(nextDelay(0, () => -3)).toBe(2_000);
        expect(nextDelay(0, () => 7)).toBe(10_000);
        expect(nextDelay(0, () => Number.NaN)).toBe(2_000);
        expect(createReconnectBackoff(highest).next()).toBe(10_000);
    });

    it('upper bound doubles to the 60 second cap', () => {
        const uppers = [0, 1, 2, 3, 4, 5].map((attempt) => nextDelay(attempt, highest));
        expect(uppers).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
        // The floor never moves, so every retry keeps its jitter.
        expect([0, 1, 2, 3, 4, 5].map((attempt) => nextDelay(attempt, lowest))).toEqual(
            [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
        );
        // A tab left refused for hours must not overflow into Infinity or NaN.
        expect(nextDelay(10_000, highest)).toBe(MAX_DELAY_MS);

        const backoff = createReconnectBackoff(highest);
        expect([backoff.next(), backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual(
            [10_000, 20_000, 40_000, 60_000, 60_000],
        );
    });

    it('reset returns to the first range', () => {
        const backoff = createReconnectBackoff(highest);
        backoff.next();
        backoff.next();
        expect(backoff.next()).toBe(40_000);
        backoff.reset();
        expect(backoff.next()).toBe(10_000);
        expect(backoff.next()).toBe(20_000);
    });
});
