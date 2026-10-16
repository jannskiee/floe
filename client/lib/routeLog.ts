// Which route each connection took, for the reports a transfer ends with:
// the transfer-complete and transfer-received analytics events and the
// connection type in an error report.
//
// Those reports read the route from a ref that followed the badge's state,
// and the badge goes back to null at every close. A receive whose sender had
// already closed was then recorded as "unknown": a Go sender closes about
// 50 ms after its last end frame, while the receiving page may still be
// checking that file's SHA-256, and onAllComplete runs only after that check.
// Measured on 2026-10-16 in headless Chromium 156, two connections in one
// page, 10 runs: a nominated pair is in the stats at the data channel's open
// on both sides every time, and never once this side has closed, so the
// reading taken at connect is the one to keep.
//
// Kept by connection, so a reading never outlives its own connection into
// the next one, and the error reports, whose handlers close over the state of
// the render that built the connection, see the route too.

export type Route = 'direct' | 'relay';

export interface RouteLog {
    /** Keeps a reading for this connection. A null reading changes nothing. */
    record(peer: object, reading: Route | null): void;
    /** The latest reading for this connection, or null if it has none. */
    of(peer: object): Route | null;
}

export function createRouteLog(): RouteLog {
    const routes = new WeakMap<object, Route>();
    return {
        record(peer, reading) {
            if (reading) routes.set(peer, reading);
        },
        of(peer) {
            return routes.get(peer) ?? null;
        },
    };
}

/** The route as the analytics events name it. */
export function routeLabel(route: Route | null): Route | 'unknown' {
    return route ?? 'unknown';
}
