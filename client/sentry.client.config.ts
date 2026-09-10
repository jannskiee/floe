import * as Sentry from '@sentry/nextjs';
import { BROWSER_EXTENSION_URL_PATTERNS } from './lib/browserExtensions';
import { IGNORED_ERROR_PATTERNS } from './lib/ignoredErrors';
import { isInjectedScriptError } from './lib/injectedScripts';
import { isStaleBundleError } from './lib/staleBundle';
import { scrubSpanJson, scrubTransactionEvent, scrubUrl } from './lib/scrubUrl';

Sentry.init({
    // Set NEXT_PUBLIC_SENTRY_DSN in your environment to enable error tracking.
    // Leave empty (or omit) to disable Sentry — safe for local development and forks.
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || '',

    // Never attach cookies/headers/user IP by default. The room secret travels
    // in the URL, which we additionally scrub below.
    sendDefaultPii: false,

    // Filter out non-actionable errors caused by browser extensions and
    // restricted environments. The list lives in lib/ignoredErrors.ts, which
    // also records how EventFilters matches it: this file cannot be imported by
    // vitest, so an inline array is untestable.
    ignoreErrors: IGNORED_ERROR_PATTERNS,

    // Drop errors thrown by browser extensions' injected content scripts: not
    // Floe code, never actionable. Matched on the frame's URL scheme rather
    // than its message, so this covers every extension without needing a
    // per-wording entry above. It has to be denyUrls and not beforeSend:
    // EventFilters runs first, before @sentry/nextjs rewrites every frame
    // origin to "app://" (see lib/browserExtensions.ts). Fixes FLOE-E,
    // MetaMask's inpage.js rejecting with "Failed to connect to MetaMask".
    denyUrls: BROWSER_EXTENSION_URL_PATTERNS,

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
        // An extension's injected script throwing on our page is reported as
        // ours, because Sentry's own setTimeout/addEventListener wrapper sits in
        // our bundle and supplies the only app:/// frame. Neither ignoreErrors
        // (the messages are generic) nor denyUrls (it skips <anonymous> frames
        // by design) can see it. Fixes FLOE-F. See lib/injectedScripts.ts.
        if (isInjectedScriptError(event)) return null;

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

    // Transactions never pass through beforeSend: the SDK routes them here
    // instead, and the HttpContext integration stamps the full page URL,
    // fragment included, onto every event's request.url and onto the segment
    // span's url.full. On a receiver page that is the whole share link, so
    // until this hook existed one trace-sampled page load in ten sent it.
    beforeSendTransaction(event) {
        return scrubTransactionEvent(event);
    },

    // Standalone spans (the span-streaming lifecycle) bypass
    // beforeSendTransaction. Scrub their URL attributes the same way so a
    // future SDK default cannot reopen the gap.
    beforeSendSpan(span) {
        return scrubSpanJson(span);
    },

    // Session Replay is deliberately absent, and must not be added back.
    //
    // A replay envelope reports the page URL in `request.url`, and on a receiver
    // page that is the whole /?s=<nonce>#room=<id> link. The room id is the only
    // thing protecting a transfer: anyone holding it can join as the receiver.
    // Captured envelopes confirmed it, so this was a live leak, not a theory.
    //
    // It cannot be scrubbed. Replay does not send through the client, so none of
    // the hooks reach it: beforeSend is bypassed (replay uses prepareEvent and
    // never enters _processEvent), an event processor had no effect, and
    // beforeEnvelope is only emitted inside Client.sendEnvelope while
    // @sentry/replay calls transport.send(envelope) directly. maskAllText does
    // not help either, because the URL is envelope metadata rather than DOM.
    //
    // Omitting both `replays*SampleRate` options and the integration is
    // sufficient and complete. Replay is NOT one of @sentry/nextjs's default
    // client integrations (those are the browser set plus browserTracing and
    // nextjsClientStackFrameNormalization), and nothing auto-enables it from the
    // sample rates. Independently, the integration hard-gates itself: with both
    // rates at 0 or absent, initializeSampling() returns before attaching any
    // listener.
    //
    // Error reports keep their scrubbing through beforeSend and
    // beforeBreadcrumb above; performance traces get theirs through
    // beforeSendTransaction and beforeSendSpan.

    debug: false,
});
