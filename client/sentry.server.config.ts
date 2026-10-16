import * as Sentry from '@sentry/nextjs';
import { failClosedHooks } from './lib/failClosed';
import { withoutLocation } from './lib/noLocation';
import { scrubServerErrorEvent, scrubServerTransactionEvent } from './lib/scrubUrl';
import { withoutServerSessions } from './lib/sentryIntegrations';
import { tracesSampler } from './lib/traceSampling';

// Both send hooks fail closed, as in the browser. See lib/failClosed.ts.
Sentry.init(failClosedHooks({
    // Set SENTRY_DSN in your environment to enable server-side error tracking.
    // Leave empty (or omit) to disable Sentry.
    dsn: process.env.SENTRY_DSN || '',
    // 10% of traces, with the browser's sampler. It was 1.0, and /r's
    // pageloads inherited that decision (CP-QA F3-04). A sampler rather than
    // tracesSampleRate, so no incoming sentry-trace header can raise the rate.
    // See lib/traceSampling.ts.
    tracesSampler,
    debug: false,

    // No session data from the server. Two of the Node SDK's defaults feed
    // Sentry's Release Health screens, which Floe does not use: one starts a
    // session with the server process, and the Http integration counts every
    // incoming request into a per-minute total unless it is told not to. The
    // privacy page lists what Sentry is sent and names no such thing, so this
    // option and that list move together.
    //
    // The Http integration is replaced, not configured in place, because
    // @sentry/nextjs builds its own. Its one option is repeated here (Next.js
    // makes the incoming request spans itself) and request sessions are
    // turned off. A test reads both from the installed SDK, so an upgrade
    // that changes either fails there. See lib/sentryIntegrations.ts.
    integrations: (defaults) =>
        withoutServerSessions(defaults, () =>
            Sentry.httpIntegration({ disableIncomingRequestSpans: true, trackIncomingRequestsAsSessions: false }),
        ),

    // The server never sees the URL fragment, but an old-style ?room= link can
    // still land in a request URL. Scrub it (and disable default PII) so the
    // room secret never reaches Sentry.
    sendDefaultPii: false,
    // No client reports: the Node SDK would otherwise post, about once a
    // minute while the server is up, a count of the events it did not send, and nine requests in ten are an
    // unsampled trace, so that count is the request total the integrations
    // above stop sending, in another form. See sentry.client.config.ts.
    sendClientReports: false,
    // Everything the client scrub does, plus what only a server event carries:
    // request headers (all but the user agent go; an RSC request from /r names
    // /r/<linkId> in two of them), the query string and, on an error from
    // captureRequestError, contexts.nextjs.request_path. See lib/scrubUrl.ts.
    //
    // And no location, as from the browser. A server report arrives from the
    // hosting provider's address, so the location Sentry worked out for it
    // was a data center's and named no visitor. It leaves empty all the same,
    // so that a location anywhere in the project is a regression and never a
    // question of whose it is. See lib/noLocation.ts.
    beforeSend(event) {
        return withoutLocation(scrubServerErrorEvent(event));
    },
    // Transactions skip beforeSend, and a traced request carries its URL in
    // the trace context and span attributes just as an error carries it in
    // request.url. Same scrub, same reason.
    beforeSendTransaction(event) {
        return withoutLocation(scrubServerTransactionEvent(event));
    },
}));
