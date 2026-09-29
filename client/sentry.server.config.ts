import * as Sentry from '@sentry/nextjs';
import { scrubServerErrorEvent, scrubServerTransactionEvent } from './lib/scrubUrl';
import { tracesSampler } from './lib/traceSampling';

Sentry.init({
    // Set SENTRY_DSN in your environment to enable server-side error tracking.
    // Leave empty (or omit) to disable Sentry.
    dsn: process.env.SENTRY_DSN || '',
    // 10% of traces, with the browser's sampler. It was 1.0, and /r's
    // pageloads inherited that decision (CP-QA F3-04). A sampler rather than
    // tracesSampleRate, so no incoming sentry-trace header can raise the rate.
    // See lib/traceSampling.ts.
    tracesSampler,
    debug: false,

    // The server never sees the URL fragment, but an old-style ?room= link can
    // still land in a request URL. Scrub it (and disable default PII) so the
    // room secret never reaches Sentry.
    sendDefaultPii: false,
    // Everything the client scrub does, plus what only a server event carries:
    // request headers (all but the user agent go; an RSC request from /r names
    // /r/<linkId> in two of them), the query string and, on an error from
    // captureRequestError, contexts.nextjs.request_path. See lib/scrubUrl.ts.
    beforeSend(event) {
        return scrubServerErrorEvent(event);
    },
    // Transactions skip beforeSend, and a traced request carries its URL in
    // the trace context and span attributes just as an error carries it in
    // request.url. Same scrub, same reason.
    beforeSendTransaction(event) {
        return scrubServerTransactionEvent(event);
    },
});
