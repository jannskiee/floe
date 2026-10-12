import { describe, it, expect } from 'vitest';
import {
    REJOIN_DELAYS_MS,
    REJOIN_FAILED_STATUS,
    REJOINING_STATUS,
    rejoinAllowed,
    rejoinDelay,
    statusOnceSeated,
} from './rejoinRetry';

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

describe('rejoinAllowed', () => {
    it('allows a retry while nothing is connected and nothing has finished', () => {
        expect(rejoinAllowed({ peerConnected: false, transferComplete: false })).toBe(true);
    });

    // The join that was refused went out while the two devices were still
    // connecting. If that connection then comes up by itself, the transfer is
    // running or done, and a retry would write 'Reconnecting to your link'
    // over 'All Files Sent!', or end in the give-up banner over a transfer
    // that worked.
    it('allows none once the peer is connected or the transfer is complete', () => {
        expect(rejoinAllowed({ peerConnected: true, transferComplete: false })).toBe(false);
        expect(rejoinAllowed({ peerConnected: false, transferComplete: true })).toBe(false);
        expect(rejoinAllowed({ peerConnected: true, transferComplete: true })).toBe(false);
    });
});

describe('statusOnceSeated', () => {
    // A second reconnect can seat the page with no retry in between, so the
    // status is restored on what it says, not on a retry counter the reconnect
    // handler has already reset.
    it('takes both retry statuses back to waiting', () => {
        expect(REJOINING_STATUS).toBe('Reconnecting to your link');
        expect(REJOIN_FAILED_STATUS).toBe('Link stopped working');
        expect(statusOnceSeated(REJOINING_STATUS)).toBe('Waiting for peer');
        expect(statusOnceSeated(REJOIN_FAILED_STATUS)).toBe('Waiting for peer');
    });

    it('leaves every other status alone', () => {
        for (const status of ['Waiting for peer', 'Peer joined. Starting transfer', 'All Files Sent!', 'Connection failed', '']) {
            expect(statusOnceSeated(status)).toBe(status);
        }
    });
});
