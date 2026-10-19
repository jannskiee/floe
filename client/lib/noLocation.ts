// Keeps Sentry from working out a location for a report.
//
// No line of Floe sends a location, and the SDK is told to attach no IP
// address (userInfo false in lib/sentryDataCollection.ts, which also sends
// sdk.settings.infer_ip "never"). Sentry's servers still see the address a report arrives from, as
// any server does, and looked it up: stored page-load traces and error reports
// held a country, a region and a city (measured in Sentry on 2026-10-12).
//
// The lookup is skipped when a report already carries a location. Relay's
// normalize_user_geoinfo (relay-event-normalization/src/event.rs) returns
// before it when user.geo holds a value, "the event was already populated
// with geo information", and an empty object is a value. An empty location is
// then stored as nothing. Measured against the real ingest on 2026-10-12 with
// four copies of one page-load report that differed only in this field: the
// copy sent as the page built it came back with a country, a region, a city
// and a subdivision, and the copies sent with `geo: {}` or with every field
// null came back with none.
//
// That early return is in Relay's source and not in Sentry's documentation, so
// the privacy page's list and this file move together: if a later check finds
// a location on a browser report again, the item goes back on that list (see
// the comment above the table of contents in app/privacy/page.tsx).
//
// Every runtime: the browser's two hooks, and the server's and the edge's.
// A report from the site's server arrives from the hosting provider's
// address, so a location on one was the data center's and named no visitor
// (measured in Sentry on 2026-10-13: every server span since the browser
// change held the same city). It is emptied all the same, so that a location
// anywhere in the project is a regression to look into, not a question of
// whose it is.
//
// A standalone span has no user field and does not pass through here. None is
// sent: the only ones the SDK made were interaction timings, which are off
// (enableInp false, lib/sentryIntegrations.ts).

// A structural shape for Sentry's ErrorEvent and TransactionEvent, declared
// here rather than imported so this module and its vitest never load the SDK.
export interface LocationBearing {
    user?: Record<string, unknown> | null;
}

/** Sets the event's location to an empty object, in place, and returns the
 *  same event. Whatever else the user field holds is kept.
 *
 *  It never throws, whatever it is handed. A send hook that throws does not
 *  just lose its report: the SDK reports the throw as an error event of its
 *  own, and that event skips beforeSend, so it would leave with the page
 *  address unscrubbed. An event that cannot be changed is returned as it is. */
export function withoutLocation<T extends LocationBearing>(event: T): T {
    try {
        const user: unknown = event.user;
        event.user = user !== null && typeof user === 'object' ? { ...user, geo: {} } : { geo: {} };
    } catch {
        // A frozen event, or something that is not an event at all.
    }
    return event;
}
