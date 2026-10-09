import { describe, it, expect, afterEach } from 'vitest';
import {
    LOST_KEY,
    clearLost,
    isLostPair,
    lostSyncStep,
    recordLost,
    sessionStore,
    takeLost,
    type LostStore,
} from './lostRecord';
import { MAX_REQUEST_FILES } from './constants';

// The discarded tab's record (FT-R-DISCARD, F-G4-M01, D-142): two integers
// under one sessionStorage key, written in Sending, read once per load, and
// handed back only to the reload the browser reports as a discard's.

/** An in-memory Storage, as the tab's own sessionStorage behaves. */
function memoryStore(seed: Record<string, string> = {}) {
    const data = new Map(Object.entries(seed));
    const store: LostStore = {
        getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
        setItem: (k, v) => {
            data.set(k, String(v));
        },
        removeItem: (k) => {
            data.delete(k);
        },
    };
    return { store, data };
}

/** A Storage whose every call throws, as a blocked or a full one does. */
const throwing: LostStore = {
    getItem: () => {
        throw new Error('SecurityError');
    },
    setItem: () => {
        throw new Error('QuotaExceededError');
    },
    removeItem: () => {
        throw new Error('SecurityError');
    },
};

describe('the discard record', () => {
    it('is one fixed key', () => {
        expect(LOST_KEY).toBe('floe:r-lost');
    });

    it("a record written in Sending comes back to a discard's reload, once", () => {
        const { store, data } = memoryStore();
        recordLost(store, 1, 2);
        expect(takeLost(store, true)).toEqual({ arrived: 1, total: 2 });
        // Taken: the key is gone, and a second load gets nothing.
        expect(data.has(LOST_KEY)).toBe(false);
        expect(takeLost(store, true)).toBeNull();
    });

    it('any other load gets nothing back, and the record is removed all the same', () => {
        const { store, data } = memoryStore();
        recordLost(store, 1, 2);
        expect(takeLost(store, false)).toBeNull();
        expect(data.has(LOST_KEY)).toBe(false);
        // Only the boolean true counts as a discard.
        for (const flag of [undefined, null, 1, 'true', {}]) {
            recordLost(store, 1, 2);
            expect(takeLost(store, flag as unknown as boolean), String(flag)).toBeNull();
            expect(data.has(LOST_KEY)).toBe(false);
        }
    });

    it('stores two integers under the one key and nothing else', () => {
        const { store, data } = memoryStore();
        recordLost(store, 0, 1);
        expect(data.get(LOST_KEY)).toBe('{"v":1,"arrived":0,"total":1}');
        recordLost(store, 4, 12);
        expect(data.get(LOST_KEY)).toBe('{"v":1,"arrived":4,"total":12}');
        const stored = JSON.parse(data.get(LOST_KEY) as string) as Record<string, unknown>;
        expect(Object.keys(stored)).toEqual(['v', 'arrived', 'total']);
        expect(Object.values(stored).every((n) => Number.isInteger(n))).toBe(true);
        expect([...data.keys()]).toEqual([LOST_KEY]);
    });

    it('a pair the Lost card cannot show is never written, and clears what was there', () => {
        const bad: Array<[number, number]> = [
            [1.5, 2],
            [-1, 2],
            [2, 2],
            [3, 2],
            [0, 0],
            [0, MAX_REQUEST_FILES + 1],
            [Number.NaN, 2],
            [0, Number.POSITIVE_INFINITY],
        ];
        for (const [arrived, total] of bad) {
            const { store, data } = memoryStore({ [LOST_KEY]: '{"v":1,"arrived":0,"total":2}' });
            recordLost(store, arrived, total);
            expect(data.has(LOST_KEY), `${arrived} of ${total}`).toBe(false);
        }
    });

    it('a malformed or out-of-range record gives null, and is removed', () => {
        const bad = [
            'not json',
            '',
            'null',
            '[]',
            '1',
            '"1 of 2"',
            '{"arrived":1,"total":2}',
            '{"v":2,"arrived":1,"total":2}',
            '{"v":"1","arrived":1,"total":2}',
            '{"v":1,"arrived":2,"total":2}',
            '{"v":1,"arrived":3,"total":2}',
            '{"v":1,"arrived":-1,"total":2}',
            '{"v":1,"arrived":1.5,"total":2}',
            '{"v":1,"arrived":"1","total":2}',
            '{"v":1,"arrived":0,"total":0}',
            '{"v":1,"arrived":0,"total":1e400}',
            `{"v":1,"arrived":0,"total":${MAX_REQUEST_FILES + 1}}`,
            // A record the page never writes: anything beside the two counts.
            '{"v":1,"arrived":1,"total":2,"name":"a.txt"}',
        ];
        for (const raw of bad) {
            const { store, data } = memoryStore({ [LOST_KEY]: raw });
            expect(takeLost(store, true), raw).toBeNull();
            expect(data.has(LOST_KEY), raw).toBe(false);
        }
        // The edges the card can show.
        for (const [raw, want] of [
            ['{"v":1,"arrived":0,"total":1}', { arrived: 0, total: 1 }],
            [`{"v":1,"arrived":${MAX_REQUEST_FILES - 1},"total":${MAX_REQUEST_FILES}}`, {
                arrived: MAX_REQUEST_FILES - 1,
                total: MAX_REQUEST_FILES,
            }],
        ] as const) {
            const { store } = memoryStore({ [LOST_KEY]: raw });
            expect(takeLost(store, true), raw).toEqual(want);
        }
    });

    it('isLostPair holds integers with at least one file left, up to the per-drop cap', () => {
        expect(isLostPair(0, 1)).toBe(true);
        expect(isLostPair(MAX_REQUEST_FILES - 1, MAX_REQUEST_FILES)).toBe(true);
        for (const [a, t] of [[1, 1], [0, 0], [-1, 1], [0.5, 1], ['0', 1], [0, '1'], [null, 1], [0, MAX_REQUEST_FILES + 1]]) {
            expect(isLostPair(a, t), `${String(a)} of ${String(t)}`).toBe(false);
        }
    });

    it('a Storage that throws, or none at all, never throws', () => {
        expect(() => recordLost(throwing, 1, 2)).not.toThrow();
        expect(() => clearLost(throwing)).not.toThrow();
        expect(takeLost(throwing, true)).toBeNull();
        expect(() => recordLost(null, 1, 2)).not.toThrow();
        expect(() => clearLost(null)).not.toThrow();
        expect(takeLost(null, true)).toBeNull();
        // A store whose removal throws hands nothing back, even to a discard:
        // a record that stays would answer a later discard again (review 1 F6).
        const { store } = memoryStore({ [LOST_KEY]: '{"v":1,"arrived":1,"total":2}' });
        const stuck: LostStore = { ...store, removeItem: throwing.removeItem };
        expect(takeLost(stuck, false)).toBeNull();
        expect(takeLost(stuck, true)).toBeNull();
    });

    it("reads only the record's own three keys, never the prototype chain", () => {
        // review 1 F5: a polluted Object.prototype must not complete a record.
        Object.defineProperty(Object.prototype, 'total', { value: 2, configurable: true, writable: true });
        try {
            const { store } = memoryStore({ [LOST_KEY]: '{"v":1,"arrived":1,"zz":0}' });
            expect(takeLost(store, true)).toBeNull();
        } finally {
            delete (Object.prototype as { total?: unknown }).total;
        }
        // The key order does not matter; the set of keys does.
        const { store } = memoryStore({ [LOST_KEY]: '{"total":2,"arrived":1,"v":1}' });
        expect(takeLost(store, true)).toEqual({ arrived: 1, total: 2 });
    });

    it('takes a key with a comma in it for no key of the record', () => {
        // review T5 N1: keys joined with commas made {"arrived,total":0,"v":1}
        // look like the record's three, and a polluted prototype then filled in
        // arrived and total.
        Object.defineProperty(Object.prototype, 'arrived', { value: 1, configurable: true, writable: true });
        Object.defineProperty(Object.prototype, 'total', { value: 2, configurable: true, writable: true });
        try {
            const { store, data } = memoryStore({ [LOST_KEY]: '{"arrived,total":0,"v":1}' });
            expect(takeLost(store, true)).toBeNull();
            expect(data.has(LOST_KEY)).toBe(false);
        } finally {
            delete (Object.prototype as { arrived?: unknown }).arrived;
            delete (Object.prototype as { total?: unknown }).total;
        }
    });
});

describe('lostSyncStep', () => {
    it('writes a new pair, keeps the same pair, and clears when the model calls for none', () => {
        expect(lostSyncStep(null, { arrived: 0, total: 3 })).toEqual({
            op: 'write',
            written: '0/3',
            counts: { arrived: 0, total: 3 },
        });
        expect(lostSyncStep('0/3', { arrived: 0, total: 3 })).toEqual({ op: 'keep', written: '0/3' });
        // A later ack rewrites the counts: the written key follows them.
        expect(lostSyncStep('0/3', { arrived: 1, total: 3 })).toEqual({
            op: 'write',
            written: '1/3',
            counts: { arrived: 1, total: 3 },
        });
        expect(lostSyncStep('1/3', null)).toEqual({ op: 'clear', written: null });
        // Nothing written and nothing called for: storage is not touched.
        expect(lostSyncStep(null, null)).toEqual({ op: 'keep', written: null });
    });
});

describe('sessionStore', () => {
    const g = globalThis as { window?: unknown };
    afterEach(() => {
        delete g.window;
    });

    it('is null where there is no window', () => {
        expect(g.window).toBeUndefined();
        expect(sessionStore()).toBeNull();
    });

    it("is null where reading the page's sessionStorage throws", () => {
        g.window = {
            get sessionStorage(): Storage {
                throw new Error('SecurityError');
            },
        };
        expect(sessionStore()).toBeNull();
    });

    it("is the page's sessionStorage otherwise", () => {
        const { store } = memoryStore();
        g.window = { sessionStorage: store };
        expect(sessionStore()).toBe(store);
    });
});
