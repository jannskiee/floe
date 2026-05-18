import * as Sentry from '@sentry/nextjs';

Sentry.init({
    dsn: 'https://9b833210196a72eee96c035c0926ed09@o4511410609192960.ingest.us.sentry.io/4511410652708864',

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

// TEMPORARY: verify Sentry pipeline is working — remove after first event is confirmed
Sentry.captureMessage('Sentry is alive on floe.one ✓', 'info');
