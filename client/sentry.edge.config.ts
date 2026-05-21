import * as Sentry from '@sentry/nextjs';

Sentry.init({
    // Set SENTRY_DSN in your environment to enable edge-side error tracking.
    // Leave empty (or omit) to disable Sentry.
    dsn: process.env.SENTRY_DSN || '',
    tracesSampleRate: 1.0,
    debug: false,
});
