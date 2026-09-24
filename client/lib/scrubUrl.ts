// Removes the transfer's room secret from a URL before it reaches telemetry.
//
// The room id is the only thing protecting a transfer: anyone holding it can
// join as the receiver. New links carry it in the URL fragment (#room=<id>);
// older links used the ?room=<id> query param. Strip both (and any other
// fragment) so error reports, breadcrumbs, request URLs, span attributes and
// span descriptions sent to Sentry can never be replayed to hijack a transfer.
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
    description?: string;
    data?: Record<string, unknown>;
}

export interface ScrubbableTransaction {
    request?: { url?: string };
    /** The transaction NAME, which Sentry indexes and shows in every list. */
    transaction?: string;
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
// same rule as every other span's, and then the /r rule below, unconditionally.
//
// Today a /r pageload is already named /r/:linkId rather than /r/<id>, because
// the Next SDK parameterizes it from the route manifest it injects into the
// client bundle. That is an SDK DEFAULT, not something this repo pins: if it
// ever flips, or a future SDK stops injecting the manifest, the name becomes
// the raw path and the id lands in the one field Sentry indexes and lists.
//
// So this does not try to tell an id from a placeholder. Both /r/<id> and
// /r/:linkId collapse to /r/redacted, deliberately: there is exactly one /r
// route, so one name is all the grouping anyone can want from it, and a rule
// that redacted only strings matching today's 11-character id shape would
// silently stop covering an id of any other length. Fail closed, and it costs
// a bucket name nobody reads.
export function scrubTransactionEvent<T extends ScrubbableTransaction>(event: T): T {
    if (typeof event.transaction === 'string') event.transaction = scrubTransactionName(event.transaction);
    if (event.request?.url) event.request.url = scrubUrl(event.request.url);
    scrubAttributes(event.contexts?.trace?.data);
    for (const span of event.spans ?? []) scrubSpanJson(span);
    return event;
}

export interface ScrubbableErrorEvent {
    request?: { url?: string };
    transaction?: string;
    exception?: { values?: { stacktrace?: { frames?: { filename?: string; abs_path?: string }[] } }[] };
}

// Scrubs the room secret and the request-link id out of an error event, in
// place, for beforeSend.
//
// request.url was the only field beforeSend scrubbed. On /r an error event's
// transaction is the raw /r/<linkId> path (captured on a production build),
// not the parameterized name a pageload gets, so it takes the transaction-name
// rule. V8 names an inline script's frames after the document URL without its
// fragment, so a frame thrown from one on /r carries the path too; frames from
// bundle chunks hold no /r segment and come back as they were.
export function scrubErrorEvent<T extends ScrubbableErrorEvent>(event: T): T {
    if (event.request?.url) event.request.url = scrubUrl(event.request.url);
    if (typeof event.transaction === 'string') event.transaction = scrubTransactionName(event.transaction);
    for (const value of event.exception?.values ?? []) {
        for (const frame of value.stacktrace?.frames ?? []) {
            if (typeof frame.filename === 'string') frame.filename = scrubDescription(frame.filename);
            if (typeof frame.abs_path === 'string') frame.abs_path = scrubDescription(frame.abs_path);
        }
    }
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
//
// A request link adds a third shape, the /r/<linkId> path, and that one needs
// no '#' or room= at all: url.path on every pageload and navigation span is
// the bare path, and so is the url of a fetch. The check is made per token as
// well as per string, so a string that qualifies because of one token never
// has its other URL tokens normalized.
function scrubDescription(description: string): string {
    if (!mayHoldSecret(description)) return description;
    return description
        .split(/(\s+)/)
        .map((token) =>
            mayHoldSecret(token) &&
            (URL_TOKEN.test(token) || EMBEDDED_URL.test(token) || ROOM_PARAM.test(token))
                ? (scrubUrl(token) ?? '')
                : token
        )
        .join('');
}

// A /r/<something> path segment where a segment can begin. REQUEST_PATH's
// shape, without /g so it keeps no lastIndex between calls. Only a URL-shaped
// token is ever rewritten for it, so free text such as "r/abc" stays.
const REQUEST_PATH_SHAPE = /(^|\/)r\/[^/]/i;

// Whether a string can hold the room id (a fragment or a room= parameter) or a
// request-link id (a /r/<linkId> path). Nothing else is touched.
function mayHoldSecret(value: string): boolean {
    return value.includes('#') || ROOM_PARAM.test(value) || REQUEST_PATH_SHAPE.test(value);
}

// A transaction name, on a transaction or on an error event: the description
// rule, then the /r rule unconditionally (see scrubTransactionEvent for why a
// parameterized /r/:linkId collapses too).
function scrubTransactionName(name: string): string {
    return redactRequestPath(scrubDescription(name));
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
