import * as Sentry from '@sentry/nextjs';
import { failClosedHooks } from './lib/failClosed';
import { withoutLocation } from './lib/noLocation';
import { scrubServerErrorEvent, scrubServerTransactionEvent } from './lib/scrubUrl';
import { DATA_COLLECTION } from './lib/sentryDataCollection';
import { tracesSampler } from './lib/traceSampling';

// Both send hooks fail closed, as in the browser. See lib/failClosed.ts.
Sentry.init(failClosedHooks({
    // Set SENTRY_DSN in your environment to enable edge-side error tracking.
    // Leave empty (or omit) to disable Sentry.
    dsn: process.env.SENTRY_DSN || '',
    // The same 10% sampler as sentry.server.config.ts. See lib/traceSampling.ts.
    tracesSampler,
    debug: false,

    // No IP address collected and transactions rather than streamed spans, as
    // in the other two configs; the room secret is scrubbed out of request
    // URLs below (covers old ?room= links). See lib/sentryDataCollection.ts.
    dataCollection: DATA_COLLECTION,
    traceLifecycle: 'static',
    // No client reports, as in the other two configs. The edge SDK has no
    // default for this today, so the line guards against one arriving.
    sendClientReports: false,
    // The same server scrub as sentry.server.config.ts: request headers but the
    // user agent, the query string and contexts.nextjs.request_path as well as
    // request.url. See lib/scrubUrl.ts. No location either, as in
    // sentry.server.config.ts.
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
