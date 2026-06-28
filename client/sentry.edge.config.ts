import * as Sentry from '@sentry/nextjs';
import { scrubUrl } from './lib/scrubUrl';

Sentry.init({
    // Set SENTRY_DSN in your environment to enable edge-side error tracking.
    // Leave empty (or omit) to disable Sentry.
    dsn: process.env.SENTRY_DSN || '',
    tracesSampleRate: 1.0,
    debug: false,

    // Scrub any room secret out of request URLs (covers old ?room= links).
    sendDefaultPii: false,
    beforeSend(event) {
        if (event.request?.url) {
            event.request.url = scrubUrl(event.request.url);
        }
        return event;
    },
});
