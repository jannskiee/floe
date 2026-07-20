import * as Sentry from '@sentry/nextjs';
import { scrubUrl } from './lib/scrubUrl';

Sentry.init({
    // Set SENTRY_DSN in your environment to enable server-side error tracking.
    // Leave empty (or omit) to disable Sentry.
    dsn: process.env.SENTRY_DSN || '',
    tracesSampleRate: 1.0,
    debug: false,

    // The server never sees the URL fragment, but an old-style ?room= link can
    // still land in a request URL. Scrub it (and disable default PII) so the
    // room secret never reaches Sentry.
    sendDefaultPii: false,
    beforeSend(event) {
        if (event.request?.url) {
            event.request.url = scrubUrl(event.request.url);
        }
        return event;
    },
});
