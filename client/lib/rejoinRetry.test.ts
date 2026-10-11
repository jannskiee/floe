import { describe, it, expect } from 'vitest';
import { REJOIN_DELAYS_MS, rejoinDelay } from './rejoinRetry';

// A socket that died without saying so holds its seat until the server's
// heartbeat gives up on it: pingInterval 25 s plus pingTimeout 20 s, the
// socket.io defaults the signaling server runs with.
const GHOST_SEAT_MS = 45_000;

describe('rejoinDelay', () => {
    it('follows the schedule, then gives up', () => {
        expect(REJOIN_DELAYS_MS.map((_, i) => rejoinDelay(i))).toEqual([2000, 4000, 8000, 15000, 15000, 15000]);
        expect(rejoinDelay(6)).toBe(null);
        expect(rejoinDelay(60)).toBe(null);
    });

    it('keeps trying for longer than a dead socket can hold the seat', () => {
        const total = REJOIN_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
        expect(total).toBeGreaterThan(GHOST_SEAT_MS);
        // And not for minutes: a link that is really taken should say so.
        expect(total).toBeLessThanOrEqual(60_000);
    });

    it('has no delay for a count that is not a retry number', () => {
        expect(rejoinDelay(-1)).toBe(null);
        expect(rejoinDelay(1.5)).toBe(null);
        expect(rejoinDelay(Number.NaN)).toBe(null);
    });
});
