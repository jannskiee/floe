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
