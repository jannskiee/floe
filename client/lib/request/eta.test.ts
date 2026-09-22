import { describe, it, expect } from 'vitest';
import { dropEtaSeconds, etaAdvice, deliveredBytes, dropPercent } from './eta';
import { adviceLines } from './visitorCopy';

// Whole-drop ETA advice (spec 07 4.14.4): computed only after 60 s of sending,
// and every threshold is strictly greater. The time format is the app's
// existing formatETA (D-091 Q-C12, O11), so 3 days reads "72h 0m".

const PLUGGED = 'Keep this computer plugged in and awake. Pin this tab so Chrome does not put it to sleep.';
const STARTS_OVER = 'If the connection drops, the file that was moving starts over.';
const SLEPT = 'This computer may have slept. If the connection drops, the file that was moving starts over.';

describe('whole-drop ETA', () => {
    it('no ETA line before 60 s of sending', () => {
        const base = { dropBytes: 10_000_000, deliveredBytes: 1_000_000, bytesPerSec: 1000 };
        expect(dropEtaSeconds({ ...base, sendingForMs: 0 })).toBeNull();
        expect(dropEtaSeconds({ ...base, sendingForMs: 59_999 })).toBeNull();
        expect(dropEtaSeconds({ ...base, sendingForMs: 60_000 })).toBe(9000);
        // No measured rate yet is no estimate, not an infinite one.
        expect(dropEtaSeconds({ ...base, bytesPerSec: 0, sendingForMs: 120_000 })).toBeNull();
        expect(dropEtaSeconds({ ...base, bytesPerSec: Number.NaN, sendingForMs: 120_000 })).toBeNull();
        // Delivered past the total (a rounding edge) is zero left, not negative.
        expect(dropEtaSeconds({ ...base, deliveredBytes: 20_000_000, sendingForMs: 120_000 })).toBe(0);
    });

    it('exactly 20 minutes adds nothing', () => {
        expect(etaAdvice(20 * 60)).toEqual([]);
        expect(etaAdvice(null)).toEqual([]);
        expect(adviceLines(etaAdvice(20 * 60), false)).toEqual([]);
    });

    it('over 20 minutes adds the plugged-in line', () => {
        expect(etaAdvice(20 * 60 + 1)).toEqual([{ key: 'plugged-in' }]);
        expect(adviceLines(etaAdvice(20 * 60 + 1), false)).toEqual([PLUGGED]);
        // Exactly 2 hours is still only the first line.
        expect(adviceLines(etaAdvice(2 * 3600), false)).toEqual([PLUGGED]);
    });

    it('over 2 hours adds the starts-over line', () => {
        expect(adviceLines(etaAdvice(2 * 3600 + 1), false)).toEqual([PLUGGED, STARTS_OVER]);
        // Exactly 24 hours does not add the will-stop line.
        expect(adviceLines(etaAdvice(24 * 3600), false)).toEqual([PLUGGED, STARTS_OVER]);
    });

    it('over 24 hours adds the will-stop line with the computed duration', () => {
        const threeDays = 3 * 24 * 3600;
        expect(etaAdvice(threeDays)).toEqual([
            { key: 'plugged-in' },
            { key: 'starts-over' },
            { key: 'will-stop', seconds: threeDays },
        ]);
        expect(adviceLines(etaAdvice(threeDays), false)).toEqual([
            PLUGGED,
            STARTS_OVER,
            'This drop would take about 72h 0m on this connection and will stop at 24 hours. Send fewer files.',
        ]);
    });

    it('a time jump replaces the starts-over line for the session', () => {
        expect(adviceLines(etaAdvice(3 * 3600), true)).toEqual([PLUGGED, SLEPT]);
        // And it shows even when the drop is short: the machine slept either way.
        expect(adviceLines(etaAdvice(60), true)).toEqual([SLEPT]);
    });

    it('delivered bytes and the whole-drop percent come from the visitor\'s own sizes', () => {
        const sizes = [100, 200, 700];
        // Before the first ack nothing is delivered.
        expect(deliveredBytes(sizes, 0, 50)).toBe(0);
        // File 2 at 50%: all of file 1 plus half of file 2.
        expect(deliveredBytes(sizes, 2, 50)).toBe(200);
        expect(dropPercent(sizes, 2, 50)).toBe(20);
        // File 3 done.
        expect(deliveredBytes(sizes, 3, 100)).toBe(1000);
        expect(dropPercent(sizes, 3, 100)).toBe(100);
        // Out-of-range inputs stay inside the drop.
        expect(deliveredBytes(sizes, 9, 400)).toBe(1000);
        expect(dropPercent([], 0, 0)).toBe(0);
    });
});
