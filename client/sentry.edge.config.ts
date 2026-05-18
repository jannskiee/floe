import * as Sentry from '@sentry/nextjs';

Sentry.init({
    dsn: 'https://9b833210196a72eee96c035c0926ed09@o4511410609192960.ingest.us.sentry.io/4511410652708864',
    tracesSampleRate: 1.0,
    debug: false,
});
