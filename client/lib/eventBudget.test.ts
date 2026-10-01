import { describe, it, expect } from 'vitest';
import { createEventBudget, eventKey, PER_KEY, PER_PAGE, type BudgetEvent } from './eventBudget';

// FLOE-M as Sentry stored it: oldest frame first, the throwing one last.
const FLOE_M: BudgetEvent = {
    exception: {
        values: [
            {
                type: 'RangeError',
                value: 'Array buffer allocation failed',
                stacktrace: {
                    frames: [
                        { filename: 'app:///_next/static/immutable/chunks/12fvq96f7udy9.js', function: 'u.handleMessage', lineno: 14, colno: 1577 },
                        { filename: '<anonymous>', function: 'new Uint8Array' },
                        { filename: '<anonymous>', function: 'arrayBufferConstructor_DoNotInitialize' },
                    ],
                },
            },
        ],
    },
};

function thrown(type: string, value: string, fn = 'f'): BudgetEvent {
    return {
        exception: {
            values: [{ type, value, stacktrace: { frames: [{ filename: 'app:///a.js', function: fn, lineno: 1, colno: 2 }] } }],
        },
    };
}

function sendMany(allow: (e: BudgetEvent) => boolean, event: BudgetEvent, n: number): number {
    let sent = 0;
    for (let i = 0; i < n; i++) if (allow(event)) sent++;
    return sent;
}

describe('createEventBudget', () => {
    it('lets the FLOE-M flood through only PER_KEY times', () => {
        const allow = createEventBudget();
        expect(sendMany(allow, FLOE_M, 3871)).toBe(PER_KEY);
    });

    it('keeps a separate budget for a different error', () => {
        const allow = createEventBudget();
        sendMany(allow, FLOE_M, 100);
        expect(allow(thrown('TypeError', 'x is undefined'))).toBe(true);
    });

    it('does not merge two bugs that share a message but throw in different places', () => {
        const allow = createEventBudget(1);
        expect(allow(thrown('TypeError', 'x is undefined', 'a'))).toBe(true);
        expect(allow(thrown('TypeError', 'x is undefined', 'b'))).toBe(true);
        expect(allow(thrown('TypeError', 'x is undefined', 'a'))).toBe(false);
    });

    it('stops everything past PER_PAGE events in one page load', () => {
        const allow = createEventBudget();
        let sent = 0;
        for (let i = 0; i < PER_PAGE * 2; i++) if (allow(thrown('Error', `distinct ${i}`))) sent++;
        expect(sent).toBe(PER_PAGE);
    });

    it('starts over with a new budget, as a new page load does', () => {
        sendMany(createEventBudget(), FLOE_M, 10);
        expect(createEventBudget()(FLOE_M)).toBe(true);
    });
});

describe('eventKey', () => {
    it('uses the fingerprint when one is set, so a grouped issue shares one budget', () => {
        const a = { ...thrown('ChunkLoadError', 'Loading chunk 1 failed'), fingerprint: ['stale-bundle-chunk-load'] };
        const b = { ...thrown('ChunkLoadError', 'Loading chunk 2 failed'), fingerprint: ['stale-bundle-chunk-load'] };
        expect(eventKey(a)).toBe(eventKey(b));
    });

    it('reads the thrown exception, which is the last value, not a linked cause', () => {
        const withCause: BudgetEvent = {
            exception: {
                values: [
                    { type: 'Error', value: 'the cause' },
                    { type: 'TypeError', value: 'the throw' },
                ],
            },
        };
        expect(eventKey(withCause)).toContain('the throw');
    });

    it('falls back to the message for a captureMessage event', () => {
        expect(eventKey({ message: 'Receiver ran out of memory' })).toBe('message:Receiver ran out of memory');
    });
});
