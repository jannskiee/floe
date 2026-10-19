// Which of the Sentry SDK's default integrations the browser does without.
// Kept apart from sentry.client.config.ts because that file imports the SDK
// and cannot be loaded by vitest, and structurally typed so this one never
// loads it either.

// The browser SDK's session integration. It is in the default set, so with no
// `integrations` option it runs: it starts a session on every page load and
// again on every route change and sends Sentry a record of it (a random
// session id, the time, the release and environment, the user agent) for
// every visit, with or without an error. That is Sentry's Release Health
// feed, which Floe does not use, and no line of config ever asked for it
// (WEB-20). Errors and the trace sample do not depend on it.
export const BROWSER_SESSION_INTEGRATION = 'BrowserSession';

// For Sentry.init's `integrations` option in its function form, which is
// handed the defaults and returns the list to set up. The array form is added
// to the defaults instead, so it cannot remove one. Order is kept: EventFilters
// has to stay ahead of the integrations that rewrite frames (see
// lib/browserExtensions.ts).
export function withoutBrowserSession<T extends { name: string }>(defaults: T[]): T[] {
    return defaults.filter((integration) => integration.name !== BROWSER_SESSION_INTEGRATION);
}

// The browser SDK's tracing integration, which @sentry/nextjs adds to the
// default set with no options. With its defaults it also times each click and
// key press (INP) and sends every timing as a span of its own, outside any
// page-load trace. Sentry's servers treat those standalone spans differently
// from everything else the page sends: they store the address the span arrives
// from on it, as client.address, although the configs collect no address
// (lib/sentryDataCollection.ts) and the SDK sends none. Measured in Sentry on 2026-10-12: all 24 stored interaction
// spans of the last 30 days held one, and no error report or page-load trace
// did. So the integration is rebuilt with those timings off.
export const BROWSER_TRACING_INTEGRATION = 'BrowserTracing';

// For the browser's `integrations` option, in its function form, after
// withoutBrowserSession. Puts the caller's tracing integration where the
// default one stood, and builds none when tracing is not in the set. The
// caller builds it, so this file never loads the SDK.
export function withoutInteractionSpans<T extends { name: string }>(defaults: T[], makeTracing: () => T): T[] {
    return defaults.map((integration) => (integration.name === BROWSER_TRACING_INTEGRATION ? makeTracing() : integration));
}

// The server side of the same feed. Two of the Node SDK's defaults send
// session data when SENTRY_DSN is set, which it is on floe.one:
//
//   - ProcessSession starts a session when the server process starts.
//   - Http counts every incoming request into a per-minute total (how many
//     ended, errored or crashed, with the release and environment; no address,
//     no user agent) and sends it about a minute later, unless it is built
//     with sessions false.
//
// Measured on a local production build with a loopback DSN before this was
// added: 120 page requests produced session items; after, none. The edge
// runtime's SDK has no session code at all, so sentry.edge.config.ts needs
// nothing.
export const PROCESS_SESSION_INTEGRATION = 'ProcessSession';
export const HTTP_INTEGRATION = 'Http';

// For the server's `integrations` option, in its function form. Drops
// ProcessSession and puts the caller's Http integration where the default one
// stood. The caller builds it, so this file never loads the SDK, and it has to
// repeat the options @sentry/nextjs gives its own (see sentry.server.config.ts).
export function withoutServerSessions<T extends { name: string }>(defaults: T[], makeHttp: () => T): T[] {
    return defaults
        .filter((integration) => integration.name !== PROCESS_SESSION_INTEGRATION)
        .map((integration) => (integration.name === HTTP_INTEGRATION ? makeHttp() : integration));
}
