/**
 * A cap on how many error events one page load may send to Sentry.
 *
 * FLOE-M is why. A receiver tab ran out of memory, and the same uncaught
 * RangeError was raised once per incoming chunk, about ten a second, for six
 * minutes: 3,871 events from one visitor in one page load (and 401 more the day
 * before). The receiver now stops on the first one (lib/transfer/receiver.ts),
 * but any future error that fires per frame, per tick or per render would do
 * the same to the event quota.
 *
 * Sentry's own Dedupe integration cannot stop that here. It keeps the previous
 * event by reference, and @sentry/nextjs's frame normalization later rewrites
 * that event's frames in place to app:///, so the next raw event never compares
 * equal. Measured: a production build sent 40 of 40 identical throws to a local
 * sink before this budget, 5 after.
 *
 * Two limits, both per page load (the budget lives in module scope and resets
 * with the page):
 *  - per key: once PER_KEY events with one key have gone out, the rest are
 *    dropped, and the last one sent carries an event_budget_exhausted tag so
 *    the issue shows that more happened.
 *  - per page: past PER_PAGE events of any kind, everything is dropped. No page
 *    load produces thirty distinct real errors; one that does is broken in a
 *    way the first thirty already describe. This also bounds the key map.
 *
 * Only error events reach beforeSend; transactions and spans have their own
 * hooks and are not counted.
 */

// Declared structurally, following lib/injectedScripts.ts, so this module and
// its vitest never load the SDK.
type BudgetFrame = { filename?: string; function?: string; lineno?: number; colno?: number };
type BudgetException = { type?: string; value?: string; stacktrace?: { frames?: BudgetFrame[] } };
export type BudgetEvent = {
    message?: string;
    level?: string;
    fingerprint?: string[];
    exception?: { values?: BudgetException[] };
};

export const PER_KEY = 5;
export const PER_PAGE = 30;

// How many of the newest frames with a real file name go into a key. The
// deepest frame alone is often a builtin: FLOE-M's is
// arrayBufferConstructor_DoNotInitialize in <anonymous>, which every
// allocation failure anywhere would share.
const KEY_FRAMES = 3;

function isRealFrame(frame: BudgetFrame): boolean {
    const name = frame.filename;
    return !!name && !name.startsWith('<') && name !== '[native code]';
}

/**
 * Two events share a key when they are the same error from the same place:
 * the fingerprint when one is set (it already says "these are one issue"),
 * otherwise the thrown exception's type, its value with numbers folded (an
 * offset or a count that changes per call is still the same error), and the
 * newest real frames, otherwise the message and level.
 */
export function eventKey(event: BudgetEvent): string {
    if (event.fingerprint?.length) return `fingerprint:${event.fingerprint.join('\n')}`;

    // The thrown exception is the last value; linked causes come before it.
    const values = event.exception?.values;
    const thrown = values?.[values.length - 1];
    if (thrown) {
        // Sentry stores frames oldest-first, so the newest are at the end.
        const where = (thrown.stacktrace?.frames ?? [])
            .filter(isRealFrame)
            .slice(-KEY_FRAMES)
            .map((f) => `${f.filename}:${f.function ?? ''}:${f.lineno ?? ''}:${f.colno ?? ''}`)
            .join('|');
        const value = (thrown.value ?? '').replace(/\d+/g, '#');
        return `exception:${thrown.type ?? ''}:${value}@${where}`;
    }
    return `message:${event.level ?? ''}:${event.message ?? ''}`;
}

export type BudgetVerdict = 'send' | 'last' | 'drop';

/**
 * Returns a function that says what to do with an event and counts it if it
 * goes: 'send', 'last' (send it, and nothing more with this key will), or
 * 'drop'.
 */
export function createEventBudget(perKey = PER_KEY, perPage = PER_PAGE): (event: BudgetEvent) => BudgetVerdict {
    const sent = new Map<string, number>();
    let total = 0;
    return (event) => {
        if (total >= perPage) return 'drop';
        const key = eventKey(event);
        const count = sent.get(key) ?? 0;
        if (count >= perKey) return 'drop';
        sent.set(key, count + 1);
        total += 1;
        return count + 1 === perKey || total === perPage ? 'last' : 'send';
    };
}
