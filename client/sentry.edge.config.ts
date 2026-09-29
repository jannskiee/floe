import * as Sentry from '@sentry/nextjs';
import { scrubServerErrorEvent, scrubServerTransactionEvent } from './lib/scrubUrl';
import { tracesSampler } from './lib/traceSampling';

Sentry.init({
    // Set SENTRY_DSN in your environment to enable edge-side error tracking.
    // Leave empty (or omit) to disable Sentry.
    dsn: process.env.SENTRY_DSN || '',
    // The same 10% sampler as sentry.server.config.ts. See lib/traceSampling.ts.
    tracesSampler,
    debug: false,

    // Scrub any room secret out of request URLs (covers old ?room= links).
    sendDefaultPii: false,
    // The same server scrub as sentry.server.config.ts: request headers but the
    // user agent, the query string and contexts.nextjs.request_path as well as
    // request.url. See lib/scrubUrl.ts.
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
