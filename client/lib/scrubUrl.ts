// Removes the transfer's room secret from a URL before it reaches telemetry.
//
// The room id is the only thing protecting a transfer: anyone holding it can
// join as the receiver. New links carry it in the URL fragment (#room=<id>);
// older links used the ?room=<id> query param. Strip both (and any other
// fragment) so error reports, breadcrumbs, request URLs, span attributes and
// span descriptions sent to Sentry can never be replayed to hijack a transfer.
//
// Accepts absolute or relative URLs and never throws.
export function scrubUrl(url: string | undefined | null): string | undefined {
    if (!url) return url ?? undefined;

    // A dummy base lets relative URLs ("/path?room=x") parse too; we strip it
    // back off afterwards.
    const BASE = 'http://scrub.invalid';
    try {
        const u = new URL(url, BASE);
        if (u.searchParams.has('room')) u.searchParams.set('room', 'redacted');
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
        return url
            .replace(/#.*$/, '')
            .replace(/([?&])room=[^&]*/i, '$1room=redacted');
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
    description?: string;
    data?: Record<string, unknown>;
}

export interface ScrubbableTransaction {
    transaction?: string;
    request?: { url?: string };
    contexts?: { trace?: { data?: Record<string, unknown> } };
    spans?: ScrubbableSpan[];
}

// Scrubs the room secret out of one span, in place: its description, its URL
// attributes and every other string in its data. Standalone spans reach
// beforeSendSpan; spans inside a transaction event go through
// scrubTransactionEvent below.
export function scrubSpanJson<T extends ScrubbableSpan>(span: T): T {
    if (typeof span.description === 'string') span.description = scrubDescription(span.description);
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
// url.full, and browserTracing names its navigation-timing spans after the
// document URL (see scrubDescription). On a receiver page that is the whole
// share link, and with tracesSampleRate 0.1 one page load in ten was sending
// it. The transaction name is the segment span's description, so it gets the
// same rule as every other span's.
export function scrubTransactionEvent<T extends ScrubbableTransaction>(event: T): T {
    if (typeof event.transaction === 'string') event.transaction = scrubDescription(event.transaction);
    if (event.request?.url) event.request.url = scrubUrl(event.request.url);
    scrubAttributes(event.contexts?.trace?.data);
    for (const span of event.spans ?? []) scrubSpanJson(span);
    return event;
}

// A query parameter or fragment key named room, the legacy and the current
// link shapes alike. "bathroom=3" is not one.
const ROOM_PARAM = /[?&#]room=/i;

// An absolute URL with an authority (scheme://), or a path, query or fragment
// on its own. An element selector ("div#main", "a:nth-child(2)") is neither.
const URL_TOKEN = /^(?:[a-z][a-z0-9+.-]*:\/\/|[/?#])/i;

// A URL inside a token that does not start as one: a scheme's "://" somewhere
// before a '#', as in "(https://floe.one/r/x#<id>)" or "url=http://a/#<id>".
// The bare #<id> fragment carries no room= to catch it otherwise. Anchored on
// "://" rather than any '/': an element selector can hold a '/' and then a '#'
// (div.w-1/2.bg-[#fff], img[alt="a/b#c"]) and must come back as it was. No
// SDK producer writes a page URL without its scheme.
const EMBEDDED_URL = /:\/\/[^#]*#/;

// Scrubs the room secret out of a span description or a transaction name.
//
// browserTracing names its navigation-timing spans (ops
// browser.domContentLoadedEvent, browser.loadEvent, browser.connect,
// browser.cache, browser.DNS, browser.request and their siblings) after the
// PerformanceNavigationTiming entry, whose name is the document URL with its
// fragment. The fix that covered request.url and url.full left these
// descriptions carrying the whole receiver link.
//
// Fail-closed but exact: a string with no '#' and no room= parameter cannot
// hold the secret in any link shape, so it comes back byte for byte (mark and
// paint names, resource paths, selectors, free text; the URL parser would
// otherwise normalize a path like /a/../b). Anything else is split on
// whitespace, and every token that is URL-shaped, holds a URL, or carries a
// room= parameter goes through scrubUrl, which drops the fragment whatever it
// holds (a bare #<id> included) and redacts ?room=.
function scrubDescription(description: string): string {
    if (!description.includes('#') && !ROOM_PARAM.test(description)) return description;
    return description
        .split(/(\s+)/)
        .map((token) =>
            URL_TOKEN.test(token) || EMBEDDED_URL.test(token) || ROOM_PARAM.test(token)
                ? (scrubUrl(token) ?? '')
                : token
        )
        .join('');
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
    // Any other string attribute can still hold the page URL. A
    // long-animation-frame span copies its first script's invoker and
    // sourceURL into browser.script.invoker and code.filepath, and for an
    // inline classic script or an inline onclick Chromium fills both with the
    // document URL, fragment included. The description rule leaves everything
    // without a '#' or a room= parameter byte for byte, and a handler name
    // like BUTTON#b.onclick or a selector in lcp.element is not URL-shaped.
    for (const [key, value] of Object.entries(data)) {
        if ((URL_ATTRIBUTES as readonly string[]).includes(key)) continue;
        if (typeof value === 'string') {
            data[key] = scrubDescription(value);
        } else if (Array.isArray(value)) {
            data[key] = value.map((item) => (typeof item === 'string' ? scrubDescription(item) : item));
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
