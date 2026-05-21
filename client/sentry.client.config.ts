import * as Sentry from '@sentry/nextjs';

Sentry.init({
    // Set NEXT_PUBLIC_SENTRY_DSN in your environment to enable error tracking.
    // Leave empty (or omit) to disable Sentry — safe for local development and forks.
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || '',

    // Capture 100% of transactions in production — adjust to 0.1 at scale
    tracesSampleRate: 1.0,

    // Session replay: capture 10% of sessions, 100% of sessions with errors
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    integrations: [
        Sentry.replayIntegration({
            // Mask text and inputs to protect user privacy
            maskAllText: false,
            blockAllMedia: false,
        }),
    ],

    debug: false,
});
