import * as Sentry from '@sentry/nextjs';
import { isStaleBundleError } from './lib/staleBundle';
import { scrubUrl } from './lib/scrubUrl';

Sentry.init({
    // Set NEXT_PUBLIC_SENTRY_DSN in your environment to enable error tracking.
    // Leave empty (or omit) to disable Sentry — safe for local development and forks.
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || '',

    // Never attach cookies/headers/user IP by default. The room secret travels
    // in the URL, which we additionally scrub below.
    sendDefaultPii: false,

    // Filter out non-actionable errors caused by browser extensions and restricted environments
    ignoreErrors: [
        // Browser extensions (Google Translate, Grammarly, ad blockers) modify the DOM
        // directly, causing React's virtual DOM to desync. Not actionable.
        "Failed to execute 'removeChild' on 'Node'",
        "Failed to execute 'insertBefore' on 'Node'",
        "The node to be removed is not a child of this node",
        // Privacy/anti-fingerprint extensions bridge to native desktop software and
        // reject a promise with a plain object when that bridge is not ready. Surfaces
        // as "Object Not Found Matching Id:N, MethodName:..., ParamCount:N". Not our code.
        'Object Not Found Matching Id',
        // Clipboard blocked in restricted browsers (already handled with fallback)
        'Write permission denied',
        // Safari/iOS ResizeObserver noise
        'ResizeObserver loop',
    ],

    // Sample 10% of transactions. Tracing every page load (1.0) flooded the
    // performance detectors with low-signal "Degraded HTTP Operation" issues on
    // slow first/cold loads and added per-session overhead. 10% keeps enough
    // signal to spot real regressions without the noise.
    tracesSampleRate: 0.1,

    // Stale-bundle/chunk-load errors are expected deploy churn, not bugs: an old
    // tab requests chunks a new deploy removed. The browser auto-reloads onto the
    // current bundle (see lib/staleBundle.ts). Collapse every wording variant into
    // one warning-level issue instead of a flood of distinct, non-actionable errors.
    beforeSend(event, hint) {
        const message =
            (hint?.originalException as Error | undefined)?.message ??
            event.exception?.values?.[0]?.value;

        if (isStaleBundleError(message)) {
            event.level = 'warning';
            event.fingerprint = ['stale-bundle-chunk-load'];
            event.tags = { ...event.tags, stale_bundle: true, auto_recovered: true };
        }

        // Strip the room secret from the request URL before the event is sent.
        if (event.request?.url) {
            event.request.url = scrubUrl(event.request.url);
        }

        return event;
    },

    // Breadcrumbs (navigation, fetch, xhr) record URLs as they happen; scrub the
    // room secret out of each one before it's attached to any event.
    beforeBreadcrumb(breadcrumb) {
        const data = breadcrumb.data;
        if (data) {
            if (typeof data.url === 'string') data.url = scrubUrl(data.url);
            if (typeof data.to === 'string') data.to = scrubUrl(data.to);
            if (typeof data.from === 'string') data.from = scrubUrl(data.from);
        }
        return breadcrumb;
    },

    // Session replay: capture 10% of sessions, 100% of sessions with errors
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    integrations: [
        Sentry.replayIntegration({
            // Mask all text and block media so replays never capture file names,
            // on-screen content, or previews. This upholds the Privacy Policy
            // (Section 5): file names and file contents are never captured.
            maskAllText: true,
            blockAllMedia: true,
        }),
    ],

    debug: false,
});
