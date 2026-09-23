import { describe, it, expect } from 'vitest';
import { createAttemptGate } from './attempt';

// Every await on /r (the TURN fetch, the socket, getStats, the abort flush,
// sendFiles itself) can come back after the attempt it belonged to has ended.
// The gate is what every continuation asks before it writes state.

describe('attempt gate', () => {
    it('nothing is live before the first attempt', () => {
        const gate = createAttemptGate();
        expect(gate.isLive(0)).toBe(false);
        expect(gate.isLive(1)).toBe(false);
    });

    it('an attempt is live from begin until end', () => {
        const gate = createAttemptGate();
        const a = gate.begin();
        expect(gate.isLive(a)).toBe(true);
        gate.end();
        expect(gate.isLive(a)).toBe(false);
    });

    it('a callback from an earlier attempt is dropped after Try again', () => {
        const gate = createAttemptGate();
        const first = gate.begin();
        gate.end();
        const second = gate.begin();
        expect(second).not.toBe(first);
        expect(gate.isLive(first)).toBe(false);
        expect(gate.isLive(second)).toBe(true);
    });

    it('guard runs the write only while the attempt is live', () => {
        const gate = createAttemptGate();
        const a = gate.begin();
        const writes: string[] = [];
        gate.guard(a, () => writes.push('live'));
        gate.end();
        gate.guard(a, () => writes.push('stale'));
        expect(writes).toEqual(['live']);
    });
});
