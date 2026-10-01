import { describe, it, expect } from 'vitest';
import { createEventBudget, eventKey, PER_KEY, PER_PAGE, type BudgetEvent, type BudgetVerdict } from './eventBudget';

// FLOE-M as Sentry stored it: oldest frame first, the throwing one last.
const FLOE_M: BudgetEvent = {
    exception: {
        values: [
            {
                type: 'RangeError',
                value: 'Array buffer allocation failed',
                stacktrace: {
                    frames: [
                        { filename: 'app:///_next/static/immutable/chunks/12fvq96f7udy9.js', function: '_channel.onmessage', lineno: 14, colno: 147664 },
                        { filename: 'app:///_next/static/immutable/chunks/12fvq96f7udy9.js', function: 'u._onChannelMessage', lineno: 14, colno: 154997 },
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

function verdicts(budget: (e: BudgetEvent) => BudgetVerdict, event: BudgetEvent, n: number): BudgetVerdict[] {
    return Array.from({ length: n }, () => budget(event));
}

describe('createEventBudget', () => {
    it('lets the FLOE-M flood through only PER_KEY times, the last one marked', () => {
        const got = verdicts(createEventBudget(), FLOE_M, 3871);
        expect(got.filter((v) => v !== 'drop')).toHaveLength(PER_KEY);
        expect(got[PER_KEY - 1]).toBe('last');
        expect(got.slice(0, PER_KEY - 1).every((v) => v === 'send')).toBe(true);
    });

    it('keeps a separate budget for a different error', () => {
        const budget = createEventBudget();
        verdicts(budget, FLOE_M, 100);
        expect(budget(thrown('TypeError', 'x is undefined'))).toBe('send');
    });

    it('stops everything past PER_PAGE events in one page load', () => {
        const budget = createEventBudget();
        const got = Array.from({ length: PER_PAGE * 2 }, (_, i) => budget(thrown('Error', 'distinct', `fn${i}`)));
        expect(got.filter((v) => v !== 'drop')).toHaveLength(PER_PAGE);
        expect(got[PER_PAGE - 1]).toBe('last');
    });

    it('starts over with a new budget, as a new page load does', () => {
        verdicts(createEventBudget(), FLOE_M, 10);
        expect(createEventBudget()(FLOE_M)).toBe('send');
    });
});

describe('eventKey', () => {
    it('keys on the newest real frames, not on a builtin every allocation shares', () => {
        const elsewhere: BudgetEvent = {
            exception: {
                values: [
                    {
                        type: 'RangeError',
                        value: 'Array buffer allocation failed',
                        stacktrace: {
                            frames: [
                                { filename: 'app:///_next/static/chunks/other.js', function: 'zipAll', lineno: 3, colno: 9 },
                                { filename: '<anonymous>', function: 'new Uint8Array' },
                                { filename: '<anonymous>', function: 'arrayBufferConstructor_DoNotInitialize' },
                            ],
                        },
                    },
                ],
            },
        };
        expect(eventKey(elsewhere)).not.toBe(eventKey(FLOE_M));
    });

    it('does not merge two bugs that share a message but throw in different places', () => {
        expect(eventKey(thrown('TypeError', 'x is undefined', 'a'))).not.toBe(eventKey(thrown('TypeError', 'x is undefined', 'b')));
    });

    it('folds numbers, so an offset that changes per call is still one error', () => {
        expect(eventKey(thrown('RangeError', 'offset 4096 is out of bounds'))).toBe(
            eventKey(thrown('RangeError', 'offset 8192 is out of bounds'))
        );
    });

    it('uses the fingerprint when one is set, so a grouped issue shares one budget', () => {
        const a = { ...thrown('ChunkLoadError', 'Loading chunk app failed'), fingerprint: ['stale-bundle-chunk-load'] };
        const b = { ...thrown('ChunkLoadError', 'Loading chunk page failed', 'g'), fingerprint: ['stale-bundle-chunk-load'] };
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

    it('keys a captureMessage event on its message and level', () => {
        expect(eventKey({ message: 'Receiver ran out of memory', level: 'warning' })).toBe(
            'message:warning:Receiver ran out of memory'
        );
    });
});
