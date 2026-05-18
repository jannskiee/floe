import * as Sentry from '@sentry/nextjs';

export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        await import('./sentry.server.config');
    }

    if (process.env.NEXT_RUNTIME === 'edge') {
        await import('./sentry.edge.config');
    }
}

// Required by @sentry/nextjs v9+ for Next.js App Router server-side error capture
export const onRequestError = Sentry.captureRequestError;
