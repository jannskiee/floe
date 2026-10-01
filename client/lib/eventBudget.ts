/**
 * A cap on how many error events one page load may send to Sentry.
 *
 * FLOE-M is why. A receiver tab ran out of memory, and the same uncaught
 * RangeError was raised once per incoming chunk, about ten a second, for six
 * minutes: 3,871 events from one visitor in one page load (and 401 more the day
 * before). The receiver now stops on the first one (lib/transfer/receiver.ts),
 * but any future error that fires per frame, per tick or per render would do
 * the same to the event quota. Sentry's Dedupe integration did not collapse
 * those identical events, so this does not rely on it.
 *
 * Two limits, both per page load (the budget lives in module scope and resets
 * with the page):
 *  - per key: an event whose key matches one already sent PER_KEY times is
 *    dropped. The key is the fingerprint when one is set, otherwise the thrown
 *    exception's type, value and throwing frame, otherwise the message, so
 *    two different bugs never share a budget.
 *  - per page: past PER_PAGE events of any kind, everything is dropped. No page
 *    load produces fifty distinct real errors; one that does is broken in a way
 *    the first fifty already describe.
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
    fingerprint?: string[];
    exception?: { values?: BudgetException[] };
};

export const PER_KEY = 5;
export const PER_PAGE = 50;

export function eventKey(event: BudgetEvent): string {
    if (event.fingerprint?.length) return `fingerprint:${event.fingerprint.join('\n')}`;

    // The thrown exception is the last value; linked causes come before it.
    const values = event.exception?.values;
    const thrown = values?.[values.length - 1];
    if (thrown) {
        // Sentry stores frames oldest-first, so the throwing frame is the last.
        const frames = thrown.stacktrace?.frames;
        const at = frames?.[frames.length - 1];
        const where = at ? `${at.filename ?? ''}:${at.lineno ?? ''}:${at.colno ?? ''}:${at.function ?? ''}` : '';
        return `exception:${thrown.type ?? ''}:${thrown.value ?? ''}@${where}`;
    }
    return `message:${event.message ?? ''}`;
}

/** Returns a predicate that says whether an event may still be sent, and counts it if so. */
export function createEventBudget(perKey = PER_KEY, perPage = PER_PAGE): (event: BudgetEvent) => boolean {
    const sent = new Map<string, number>();
    let total = 0;
    return (event) => {
        if (total >= perPage) return false;
        const key = eventKey(event);
        const count = sent.get(key) ?? 0;
        if (count >= perKey) return false;
        sent.set(key, count + 1);
        total += 1;
        return true;
    };
}
