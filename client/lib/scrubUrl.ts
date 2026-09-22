// Removes the transfer's room secret from a URL before it reaches telemetry.
//
// The room id is the only thing protecting a transfer: anyone holding it can
// join as the receiver. New links carry it in the URL fragment (#room=<id>);
// older links used the ?room=<id> query param. Strip both (and any other
// fragment) so error reports, breadcrumbs, and request URLs sent to Sentry can
// never be replayed to hijack a transfer.
//
// A request link (/r/<linkId>) carries an id in the PATH as well, and the two
// exclude flags that keep a room id out of telemetry only cover the query and
// the fragment. That id is not a secret and cannot be replayed into a transfer,
// but it names one link and one person's request, and telemetry has no use for
// it, so it is redacted here beside the room id.
//
// Accepts absolute or relative URLs and never throws.

// One request-link path segment, matched case-insensitively and only where a
// path segment can begin (string start, or after a slash). The captured
// boundary is put back, so "/r/x" and "r/x" each stay their own shape, and it
// is what keeps /rx/abc and /robots.txt out of the match. A bare /r has no id
// to redact and is left alone.
const REQUEST_PATH = /(^|\/)r\/[^/]+/gi;

function redactRequestPath(path: string): string {
    // lastIndex is reset per call: the regex is module-level and /g is stateful,
    // so a shared one would skip the next caller's match.
    REQUEST_PATH.lastIndex = 0;
    return path.replace(REQUEST_PATH, '$1r/redacted');
}

export function scrubUrl(url: string | undefined | null): string | undefined {
    if (!url) return url ?? undefined;

    // A dummy base lets relative URLs ("/path?room=x") parse too; we strip it
    // back off afterwards.
    const BASE = 'http://scrub.invalid';
    try {
        const u = new URL(url, BASE);
        if (u.searchParams.has('room')) u.searchParams.set('room', 'redacted');
        u.pathname = redactRequestPath(u.pathname);
        u.hash = '';
        const out = u.toString();
        // Match BASE plus the path separator, not BASE as a bare prefix: a
        // serialized URL always has '/' after the host, so this is only true
        // when the dummy base itself was used, never for an absolute URL on a
        // host that merely starts with "scrub.invalid" (for example
        // scrub.invalid.evil.com), which must pass through intact.
        return out.startsWith(BASE + '/') ? out.slice(BASE.length) || '/' : out;
    } catch {
        // Parsing failed (unusual breadcrumb value); fall back to a plain strip.
        // The path is split off by hand here because there is no parsed URL to
        // ask: the room redaction must stay on the query side and the request
        // redaction on the path side, or a ?room= value containing "/r/" would
        // rewrite itself.
        const withoutHash = url.replace(/#.*$/, '');
        const q = withoutHash.indexOf('?');
        const path = q >= 0 ? withoutHash.slice(0, q) : withoutHash;
        const query = q >= 0 ? withoutHash.slice(q) : '';
        return (
            redactRequestPath(path) + query.replace(/([?&])room=[^&]*/i, '$1room=redacted')
        );
    }
}

// The URL-bearing attributes the SDK writes onto spans: url.full and http.url
// on http.client spans and on the segment span (the HttpContext integration
// backfills url.full there from location.href), plus the http.query and
// http.fragment the fetch and XHR instrumentation split out of a request URL.
const URL_ATTRIBUTES = ['url.full', 'http.url', 'http.query', 'http.fragment'] as const;

// Structural shapes for Sentry's TransactionEvent and SpanJSON, declared here
// rather than imported so this module and its vitest never load the SDK.
export interface ScrubbableSpan {
    data?: Record<string, unknown>;
}

export interface ScrubbableTransaction {
    request?: { url?: string };
    contexts?: { trace?: { data?: Record<string, unknown> } };
    spans?: ScrubbableSpan[];
}

// Scrubs the room secret out of one span's URL attributes, in place. Standalone
// spans reach beforeSendSpan; spans inside a transaction event go through
// scrubTransactionEvent below.
export function scrubSpanJson<T extends ScrubbableSpan>(span: T): T {
    scrubAttributes(span.data);
    return span;
}

// Scrubs the room secret out of a performance transaction, in place.
//
// beforeSend never sees a transaction: the SDK routes error events through
// beforeSend and transaction events through beforeSendTransaction, so the
// scrubbing that protects error reports covered no trace. Meanwhile the
// browser SDK's HttpContext integration stamps location.href, fragment
// included, onto every event's request.url and onto the segment span's
// url.full. On a receiver page that is the whole share link, and with
// tracesSampleRate 0.1 one page load in ten was sending it.
export function scrubTransactionEvent<T extends ScrubbableTransaction>(event: T): T {
    if (event.request?.url) event.request.url = scrubUrl(event.request.url);
    scrubAttributes(event.contexts?.trace?.data);
    for (const span of event.spans ?? []) scrubAttributes(span.data);
    return event;
}

function scrubAttributes(data: Record<string, unknown> | undefined): void {
    if (!data) return;
    for (const key of URL_ATTRIBUTES) {
        const value = data[key];
        if (typeof value !== 'string' || value === '') continue;
        if (key === 'http.fragment') {
            // A fragment is never useful telemetry, and it is where every
            // current link keeps the room id.
            delete data[key];
        } else if (key === 'http.query') {
            data[key] = scrubQuery(value);
        } else {
            data[key] = scrubUrl(value);
        }
    }
}

// http.query holds the bare search string ("?room=x&foo=1"). Run it through
// scrubUrl on a dummy path and hand back only the search part.
function scrubQuery(query: string): string {
    const scrubbed = scrubUrl('/' + (query.startsWith('?') ? query : '?' + query)) ?? '';
    const i = scrubbed.indexOf('?');
    return i >= 0 ? scrubbed.slice(i) : '';
}
