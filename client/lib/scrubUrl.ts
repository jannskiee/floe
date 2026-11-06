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
// A request to the signaling server carries a third value: the engine.io
// session id of the page's own connection (?sid=<id> on every polling
// request). For as long as that connection lives the id is all a request needs
// to speak as that socket, and the SDK copies the request URL onto every
// http.client span and XHR breadcrumb, so it is redacted like the room id.
//
// A link can also carry a link key: #k=<k>&room=<id> on a share link, #<id>.<k>
// on a request link. It proves a peer holds the link, so it goes wherever the
// room id goes: with the fragment, and by the same rules where text holds it
// with the '#' gone or behind a quote.
//
// Accepts absolute or relative URLs and never throws.

// One request-link path segment, matched case-insensitively and only where a
// path segment can begin (string start, or after a slash). The captured
// boundary is put back, so "/r/x" and "r/x" each stay their own shape, and it
// is what keeps /rx/abc and /robots.txt out of the match. A bare /r has no id
// to redact and is left alone. The r and either slash may also be
// percent-encoded (%72, %2F): a serialized pathname keeps them encoded, and
// /%72/<id> or /r%2F<id> still names the same link.
const REQUEST_PATH = /(^|\/|%2f)(?:r|%72)(?:\/|%2f)[^/]+/gi;

// The same shape as a plain test: no /g, so it keeps no lastIndex between
// calls, and only one character after the separator, since it only asks
// whether there is a segment to redact.
const REQUEST_PATH_SHAPE = /(^|\/|%2f)(?:r|%72)(?:\/|%2f)[^/]/i;

function redactRequestPath(path: string): string {
    // lastIndex is reset per call: the regex is module-level and /g is stateful,
    // so a shared one would skip the next caller's match.
    REQUEST_PATH.lastIndex = 0;
    return path.replace(REQUEST_PATH, '$1r/redacted');
}

// A /r path can also ride in a query value (?next=/r/<id>). URLSearchParams
// hands each value back decoded, so %2F and %72 are caught by the same test.
// A whole link can too, which is how a script reports the page it is on:
// fetch('https://collector.example/hit?u=' + encodeURIComponent(location.href)).
// The SDK then writes that URL onto a breadcrumb and a span, and decoded it holds
// everything a link holds, so it takes a link's own rule. A value that holds none
// of a link's marks, such as ?color=%23fff, stays.
// The query is rebuilt only when a value changes, so every other URL keeps its
// query byte for byte.
function redactRequestQuery(u: URL): void {
    const params = [...u.searchParams];
    const redacted = params.map(([key, value]) => [key, redactQueryValue(value)]);
    if (redacted.every(([, value], i) => value === params[i][1])) return;
    u.search = new URLSearchParams(redacted).toString();
}

function redactQueryValue(value: string): string {
    if (REQUEST_PATH_SHAPE.test(value)) return redactRequestPath(value);
    if (LINK_PARAM_START.test(value) || KEYED_ROOM_SHAPE.test(value) || FRAGMENT_ROOM_ID_SHAPE.test(value)) {
        return scrubUrl(value) ?? '';
    }
    return value;
}

// A link's two parameters, as text can hold them where no URL parser finds them.
// With the '#' lost, "k=<k>&room=<id>" parses as a path: new URL makes it
// "/k=<k>&room=<id>", both secrets intact. So this rule runs on the raw string,
// ahead of any parser. A name counts as a parameter when nothing word-like sits
// in front of it, which takes in the start of a token, the URL delimiters, a
// quote, a bracket, a colon and a slash, and leaves "bank=1", "x-k=1", "a.k=1"
// and "bathroom=3" alone. Its value runs to the next delimiter.
const LINK_PARAM = /(^|[^\w%.-])(k|room)=[^&#\s"'<>()]*/gi;

// The same start as a plain test: no /g, so it keeps no lastIndex between calls.
const LINK_PARAM_START = /(^|[^\w%.-])(?:k|room)=/i;

// The other link's fragment with the same '#' gone, as location.hash.slice(1)
// hands it on: a room id, a dot and a key. The key's exact shape, so that
// "<id>.png" stays. A bare room id with no mark at all cannot be told from any
// other UUID, so it stays too, as it always has.
const KEYED_ROOM = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{21}[AQgw](?![A-Za-z0-9_-])/gi;

// The same shape as a plain test, as above.
const KEYED_ROOM_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{21}[AQgw](?![A-Za-z0-9_-])/i;

// A room id right after a '#', the mark of a request link's fragment.
const FRAGMENT_ROOM_ID_SHAPE = /#[0-9a-f]{8}-[0-9a-f]{4}-/i;

// A link percent-encoded inside a URL, as a query value holds one: %23k%3D, k%3D,
// room%3D or %23<id>. Only says a string is worth parsing: scrubUrl decodes the
// value and redactQueryValue judges it. An encoded link in text no URL rule applies
// to stays, since nothing the SDK writes has that shape.
const ENCODED_LINK_HINT = /(?:^|[^\w%.-]|%[0-9a-f]{2})(?:k|room)%3d|%23[0-9a-f]{8}-[0-9a-f]{4}-/i;

function redactLinkParams(text: string): string {
    return text.replace(LINK_PARAM, '$1$2=redacted').replace(KEYED_ROOM, 'redacted');
}

export function scrubUrl(url: string | undefined | null): string | undefined {
    if (!url) return url ?? undefined;

    // A dummy base lets relative URLs ("/path?room=x") parse too; we strip it
    // back off afterwards.
    const BASE = 'http://scrub.invalid';
    // String(): this header's "never throws" is for a value the SDK did not type.
    const text = redactLinkParams(String(url));
    try {
        const u = new URL(text, BASE);
        if (u.searchParams.has('room')) u.searchParams.set('room', 'redacted');
        if (u.searchParams.has('k')) u.searchParams.set('k', 'redacted');
        if (u.searchParams.has('sid')) u.searchParams.set('sid', 'redacted');
        redactRequestQuery(u);
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
        const withoutHash = text.replace(/#[\s\S]*$/, '');
        const q = withoutHash.indexOf('?');
        const path = q >= 0 ? withoutHash.slice(0, q) : withoutHash;
        const query = q >= 0 ? withoutHash.slice(q) : '';
        return redactRequestPath(path) + query.replace(/([?&])(room|k|sid)=[^&]*/gi, '$1$2=redacted');
    }
}

// The URL-bearing attributes the SDK writes onto spans: url.full and http.url
// on http.client spans and on the segment span (the HttpContext integration
// backfills url.full there from location.href), plus the query and the
// fragment the fetch, XHR and server instrumentation split out of a request
// URL. SDK 10 wrote them as http.query and http.fragment, which keep their '?'
// and '#'. SDK 11 writes the OpenTelemetry url.query and url.fragment, which
// keep neither ("sid=<id>", "room=<id>"), so the rule for every other
// attribute below cannot see either secret in them. url.path is the bare
// path, /r/<linkId> included.
const URL_ATTRIBUTES = [
    'url.full',
    'http.url',
    'http.query',
    'http.fragment',
    'url.query',
    'url.fragment',
    'url.path',
] as const;

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
    breadcrumbs?: unknown;
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
    scrubRequestReferer(event.request);
    scrubAttributes(event.contexts?.trace?.data);
    for (const span of event.spans ?? []) scrubSpanJson(span);
    // A transaction carries the scope's breadcrumbs as an error does
    // (applyScopeDataToEvent), and the browser hook no longer walks a logged
    // object (W3 R5-01): what is in one is scrubbed here, on the SDK's copy.
    if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map((crumb: unknown) => scrubEventBreadcrumb(crumb));
    return event;
}

export interface ScrubbableErrorEvent {
    request?: { url?: string };
    transaction?: string;
    message?: string;
    logentry?: unknown;
    extra?: unknown;
    exception?: { values?: { value?: string; stacktrace?: { frames?: { filename?: string; abs_path?: string }[] } }[] };
    breadcrumbs?: unknown;
}

// Scrubs the room secret and the request-link id out of an error event, in
// place, for beforeSend.
//
// request.url was the only field beforeSend scrubbed. On /r an error event's
// transaction is the raw /r/<linkId> path (captured on a production build),
// not the parameterized name a pageload gets, so it takes the transaction-name
// rule. V8 names an inline script's frames after the document URL without its
// fragment, so a frame thrown from one on /r carries the path too; frames from
// bundle chunks hold no /r segment and come back as they were. An exception's
// value and the event's breadcrumbs are text anything on the page can write (a
// third-party or extension script that logs location.href or the link), so the
// value takes the free-text rule and each breadcrumb scrubEventBreadcrumb's
// (deep QA A4-06, W3 R5-04). The same goes for what a throw of anything but an
// Error becomes: the SDK writes a thrown string to event.message and a thrown
// object to event.extra.__serialized__ (eventbuilder.js, @sentry/browser 11.8.0),
// and an Error's name is its exception's type.
//
// It never throws, whatever the shape. A hook that throws loses its event, and
// worse: the SDK reports the throw as an error event of its own, which skips
// beforeSend and so leaves with the page address as the browser had it. A value, a
// stacktrace, a frame list or a frame that is not what the SDK writes is
// skipped and left as it is.
export function scrubErrorEvent<T extends ScrubbableErrorEvent>(event: T): T {
    if (typeof event.request?.url === 'string') event.request.url = scrubUrl(event.request.url);
    scrubRequestReferer(event.request);
    if (typeof event.transaction === 'string') event.transaction = scrubTransactionName(event.transaction);
    if (typeof event.message === 'string') event.message = scrubText(event.message);
    if (isObject(event.logentry)) event.logentry = scrubCopy(event.logentry, 0);
    if (isObject(event.extra)) event.extra = scrubCopy(event.extra, 0);
    if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map((crumb: unknown) => scrubEventBreadcrumb(crumb));
    const values: unknown = event.exception?.values;
    if (!Array.isArray(values)) return event;
    for (const value of values) {
        if (!isObject(value)) continue;
        if (typeof value.value === 'string') value.value = scrubText(value.value);
        if (typeof value.type === 'string') value.type = scrubText(value.type);
        if (!isObject(value.stacktrace)) continue;
        const frames = value.stacktrace.frames;
        if (!Array.isArray(frames)) continue;
        for (const frame of frames) {
            if (!isObject(frame)) continue;
            if (typeof frame.filename === 'string') frame.filename = scrubDescription(frame.filename);
            if (typeof frame.abs_path === 'string') frame.abs_path = scrubDescription(frame.abs_path);
        }
    }
    return event;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

// The Referer header on a browser event, scrubbed in place.
//
// The browser SDK copies document.referrer into request.headers.Referer
// (getHttpRequestData in @sentry/browser), and both hooks above rewrote
// request.url only. A browser never puts a fragment in a referrer, so a
// share link of today's #room= shape cannot get there, and /r sends no
// referrer at all (next.config.mjs). A legacy ?room=<id> link can: after a
// full navigation away from one, such as the Link Invalid card's Back to
// Home, the next page's errors and sampled traces carried the room id in this
// header (WEB-21).
//
// Scrubbed, not deleted: the privacy page says a report carries the referring
// page, and the address without its secret is what makes "the user came from
// a share link" readable in an issue. The server-side scrub below does delete
// it, with every other header but the user agent, because a server event's
// headers are the visitor's own request. The header is matched in any letter
// case, and anything that is not the shape the SDK writes is left alone.
function scrubRequestReferer(request: unknown): void {
    if (!isObject(request) || !isObject(request.headers)) return;
    const headers = request.headers;
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== 'referer') continue;
        const value = headers[key];
        if (typeof value === 'string' && mayHoldSecret(value)) headers[key] = scrubUrl(value);
    }
}

// Server and edge events carry what a browser event never does: the request's
// headers and query string, and on an error from captureRequestError,
// contexts.nextjs.request_path, the raw path and query. The SDK's own filter
// (lib/sentryDataCollection.ts) only blanks, by name, the headers, cookies and
// query keys that can carry an address or a credential. Every other header
// stays, and @sentry/core 11.8.0 also parses the Cookie header into
// request.cookies and attaches any body the scope holds as request.data
// (integrations/requestdata.js). Next's RSC requests name the page they were made from in
// Next-Url and Next-Router-State-Tree, so from /r they name /r/<linkId>: five
// prefetch transactions per /r view on a production build (CP-QA F3-01), and a
// render fault on /r sent the path in request_path (F3-03). A legacy ?room=
// page sends its whole URL, room id included, as the Referer of every
// same-origin request and as the query string of its own (skeptic S2, O-2).
//
// So a server event keeps one header, the user agent (Sentry reads the browser
// and OS from it, and the privacy page says each report carries it), and its
// query string and request path take request.url's rules. Of the request
// block it keeps the url, method, query string and headers: cookies, the body
// and anything the SDK adds later go. Allowlists rather than denylists: Next
// can add a header and the SDK a field, and a new one must arrive dropped.
const KEPT_REQUEST_HEADERS = new Set(['user-agent']);
const KEPT_REQUEST_FIELDS = new Set(['url', 'method', 'query_string', 'headers']);

export interface ScrubbableServerRequest {
    request?: { url?: string; headers?: Record<string, string>; query_string?: unknown };
    // A record, not { nextjs?: ... }: Sentry's Contexts declares no nextjs key,
    // so a shape naming only that one is a weak type Contexts fails to match.
    contexts?: Record<string, unknown>;
    breadcrumbs?: unknown;
}

/** beforeSend on the server and edge runtimes: scrubErrorEvent, plus the
 *  request block, contexts.nextjs.request_path and the breadcrumbs. */
export function scrubServerErrorEvent<T extends ScrubbableErrorEvent & ScrubbableServerRequest>(event: T): T {
    scrubErrorEvent(event);
    scrubServerRequest(event);
    scrubBreadcrumbs(event);
    return event;
}

/** beforeSendTransaction on the server and edge runtimes: scrubTransactionEvent,
 *  plus the same request fields and breadcrumbs. */
export function scrubServerTransactionEvent<T extends ScrubbableTransaction & ScrubbableServerRequest>(
    event: T
): T {
    scrubTransactionEvent(event);
    scrubServerRequest(event);
    scrubBreadcrumbs(event);
    return event;
}

// Never throws, like scrubErrorEvent. Unlike it, a header list, query string
// or request path of a shape the SDK does not write is deleted rather than
// left as it is: these fields exist to carry URLs.
function scrubServerRequest(event: ScrubbableServerRequest): void {
    const request: unknown = event.request;
    if (isObject(request)) {
        for (const field of Object.keys(request)) {
            if (!KEPT_REQUEST_FIELDS.has(field)) delete request[field];
        }
        const headers = request.headers;
        if (isObject(headers)) {
            for (const name of Object.keys(headers)) {
                if (!KEPT_REQUEST_HEADERS.has(name.toLowerCase())) delete headers[name];
            }
        } else if (headers !== undefined) {
            delete request.headers;
        }
        if (typeof request.query_string === 'string') {
            request.query_string = scrubQuery(request.query_string).replace(/^\?/, '');
        } else if (request.query_string !== undefined) {
            delete request.query_string;
        }
    }
    const contexts: unknown = event.contexts;
    const nextjs = isObject(contexts) ? contexts.nextjs : undefined;
    if (isObject(nextjs) && nextjs.request_path !== undefined) {
        if (typeof nextjs.request_path === 'string') nextjs.request_path = scrubUrl(nextjs.request_path);
        else delete nextjs.request_path;
    }
}

// A console breadcrumb holds whatever was logged, a Next render fault's stack
// included, and the SDK's own sentry.event breadcrumb holds "Type: value" of an
// earlier error: neither went through any rule before deep QA A4-06. Two
// passes now cover them, because the two places a breadcrumb is seen hold
// different things.
//
// beforeBreadcrumb (the browser) gets the breadcrumb as it is made, and the
// Console integration (@sentry/core 11.8.0, a browser default since 11; the
// Breadcrumbs integration made it in 10.x) puts the page's own console
// arguments in its data, live, before the real console call: a logged object
// there is the app's own
// state. Walking it took a share link in state down to its path and a deep
// object's leaves to undefined, threw on a frozen object or a getter, and in a
// probe left the page's React tree dead after one console.log(button) (W3
// R5-01). So scrubBreadcrumb touches only what the SDK made: the message, url,
// to and from, and each logged string, in a new arguments array.
//
// An event about to be sent carries a normalized copy of every breadcrumb's
// data (prepareEvent's normalizeEvent, before beforeSend and
// beforeSendTransaction), so there every string at any depth is scrubbed, by
// copying: scrubEventBreadcrumb, used by the browser's and the server's event
// hooks alike. A breadcrumb list of a shape the SDK does not write is deleted
// on the server, and a value nested deeper than the SDK's own normalization
// leaves one is dropped rather than walked.
const BREADCRUMB_URL_KEYS = ['url', 'to', 'from'] as const;
const MAX_BREADCRUMB_DEPTH = 8;

/** One breadcrumb as beforeBreadcrumb sees it: its message and every logged
 *  string take the free-text rule, and url, to and from in data request.url's.
 *  A logged object is never walked or written to. Never throws. */
export function scrubBreadcrumb<T>(crumb: T): T {
    if (!isObject(crumb)) return crumb;
    const c: Record<string, unknown> = crumb;
    try {
        if (typeof c.message === 'string') c.message = scrubText(c.message);
        const data = c.data;
        if (isObject(data) && !Array.isArray(data)) {
            scrubBreadcrumbUrls(data, data);
            const args = data.arguments;
            if (Array.isArray(args)) {
                data.arguments = args.map((arg: unknown) => (typeof arg === 'string' ? scrubText(arg) : arg));
            }
        }
    } catch {
        // A breadcrumb the SDK did not shape is left as it is.
    }
    return crumb;
}

/** One breadcrumb of an event about to be sent: a copy in which url, to and
 *  from in data take request.url's rule and every other string, at any depth,
 *  the free-text rule. Never throws, and writes into nothing it did not make. */
function scrubEventBreadcrumb(crumb: unknown): unknown {
    const out = scrubCopy(crumb, 0);
    const data = isObject(crumb) ? crumb.data : undefined;
    const copied = isObject(out) ? out.data : undefined;
    if (isObject(data) && !Array.isArray(data) && isObject(copied) && !Array.isArray(copied)) {
        scrubBreadcrumbUrls(data, copied);
    }
    return out;
}

// The URLs of a breadcrumb's data, read from data and written into into (the
// same object, or the event hook's copy): url, to and from take request.url's
// rule, and the url.query and url.fragment that SDK 11's Node and edge request
// breadcrumbs write beside url, with no leading '?' or '#', the span
// attributes' rule.
function scrubBreadcrumbUrls(data: Record<string, unknown>, into: Record<string, unknown>): void {
    for (const key of BREADCRUMB_URL_KEYS) {
        const value = data[key];
        if (typeof value === 'string') into[key] = scrubUrl(value);
    }
    if (typeof data['url.fragment'] === 'string') delete into['url.fragment'];
    const query = data['url.query'];
    if (typeof query === 'string' && query !== '') into['url.query'] = scrubQueryKeepingShape(query);
}

function scrubBreadcrumbs(event: ScrubbableServerRequest): void {
    const crumbs: unknown = event.breadcrumbs;
    if (crumbs === undefined) return;
    if (!Array.isArray(crumbs)) {
        delete event.breadcrumbs;
        return;
    }
    event.breadcrumbs = crumbs.map((crumb: unknown) => scrubEventBreadcrumb(crumb));
}

// A copy of value with every string scrubbed by the free-text rule, a key's name
// included, since {[location.href]: 1} is an object anything on a page can throw. A
// property that throws when read, or anything past MAX_BREADCRUMB_DEPTH, is left out.
function scrubCopy(value: unknown, depth: number): unknown {
    if (typeof value === 'string') return scrubText(value);
    if (!isObject(value)) return value;
    if (depth >= MAX_BREADCRUMB_DEPTH) return undefined;
    try {
        if (Array.isArray(value)) return value.map((item: unknown) => scrubCopy(item, depth + 1));
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) out[scrubText(key)] = scrubCopy(value[key], depth + 1);
        return out;
    } catch {
        return undefined;
    }
}

// An element's own words in a selector. The SDK writes an element's aria-label,
// title and alt into the selector it makes (htmlTreeAsString in
// @sentry/browser-utils 11.8.0) with no escaping: a click breadcrumb's message,
// lcp.element and cls.source.N on a page load, a standalone web-vital span's
// name, [HTMLElement: ...] for a logged node. Floe's Remove button names a file
// the sender picked, and its Download button names one the other peer chose. So
// the words go wherever text can hold them, and the attribute's bare name stays,
// which still says what kind of thing was clicked.
//
// A value can hold '"]' and anything shaped like the next element after it, so
// nothing from the first such attribute to the last '"]' can be told from a
// name, and all of it goes. Past the last '"]' there is no value to hide in, only
// the page's own structure, so that stays. With no '"]' after it, the rest of the
// string goes. type and name are not on the list: neither is ever a person's
// words in Floe's markup.
const SELECTOR_WORDS_OPEN = /\[(aria-label|title|alt)="/;

function dropSelectorWords(text: string): string {
    const open = SELECTOR_WORDS_OPEN.exec(text);
    if (!open) return text;
    const close = text.lastIndexOf('"]');
    const rest = close > open.index ? text.slice(close + 2) : '';
    return `${text.slice(0, open.index)}[${open[1]}]${dropSelectorWords(rest)}`;
}

// A query parameter or fragment key named room, the legacy and the current
// link shapes alike. "bathroom=3" is not one.
const ROOM_PARAM = /[?&#]room=/i;

// A query parameter named sid: the engine.io session id on a request to the
// signaling server. "acid=1" is not one, and neither is the bare text "sid=x".
const SESSION_PARAM = /[?&]sid=/i;

// An absolute URL with an authority (scheme://), or a path, query or fragment
// on its own. An element selector ("div#main", "a:nth-child(2)") is neither.
const URL_TOKEN = /^(?:[a-z][a-z0-9+.-]*:\/\/|[/?#])/i;

// A URL inside a token that does not start as one: a scheme's "://" anywhere,
// as in "(https://floe.one/r/x#<id>)", "url=http://a/#<id>" or, with no
// fragment at all, "(https://floe.one/r/<id>)". Such a token is only rewritten
// when it also holds a fragment, a room= parameter or a /r segment. Anchored
// on "://" rather than any '/': an element selector can hold a '/' and then a
// '#' (div.w-1/2.bg-[#fff], input[name="a/b#c"]) and must come back as it was.
// No SDK producer writes a page URL without its scheme.
const EMBEDDED_URL = /:\/\//;

// Scrubs the room secret out of a span description or a transaction name.
//
// browserTracing names its navigation-timing spans (ops
// browser.domContentLoadedEvent, browser.loadEvent, browser.connect,
// browser.cache, browser.DNS, browser.request and their siblings) after the
// PerformanceNavigationTiming entry, whose name is the document URL with its
// fragment. The fix that covered request.url and url.full left these
// descriptions carrying the whole receiver link.
//
// Fail-closed but exact: a string with no '#' and no room= or k= parameter
// cannot hold the secret in any link shape, so it comes back byte for byte (mark
// and paint names, resource paths, selectors, free text; the URL parser would
// otherwise normalize a path like /a/../b), but for the words of an element in a
// selector (dropSelectorWords), which go first. Anything else is split on
// whitespace, and every token that is URL-shaped, holds a URL, or carries a
// room= parameter goes through scrubUrl, which drops the fragment whatever it
// holds (a bare #<id> included) and redacts ?room=.
//
// A request link adds a third shape, the /r/<linkId> path, and that one needs
// no '#' or room= at all: url.path on every pageload and navigation span is
// the bare path, and so is the url of a fetch. The check is made per token as
// well as per string, so a string that qualifies because of one token never
// has its other URL tokens normalized.
//
// A token that holds a link parameter or a room id but is not URL-shaped keeps
// everything else, as in free text below.
function scrubDescription(description: string): string {
    const clean = dropSelectorWords(description);
    if (!mayHoldSecret(clean)) return clean;
    return clean
        .split(/(\s+)/)
        .map((token) => {
            if (!mayHoldSecret(token)) return token;
            return URL_TOKEN.test(token) || EMBEDDED_URL.test(token) || ROOM_PARAM.test(token) || SESSION_PARAM.test(token)
                ? (scrubUrl(token) ?? '')
                : scrubUnshapedToken(token);
        })
        .join('');
}

// Free text (an exception's value, a breadcrumb's message, a logged string):
// the description rule, except that a token that is only URL-shaped because
// it starts with '#' is rewritten only when it is a fragment parameter
// (#room=, #k=), a room id (W3 R5-04) or a /r path, as a hash route writes a
// request link (#/r/<linkId>, C1-05). "React error #418", "member #peer" and
// "token # in JSON" are not link fragments, and the description rule turned
// each into "/".
const FRAGMENT_SECRET = /^#(?:[a-z][a-z0-9_]*=|[0-9a-f]{8}-[0-9a-f]{4}-|(?:\/|%2f)?(?:r|%72)(?:\/|%2f))/i;

// A room id after a '#' inside a token that is not URL-shaped, as in
// Chromium's "'#<id>' is not a valid selector" when a script hands a /r
// fragment, a bare room id, to querySelector (C1-04). A keyed request link's
// fragment goes on past a dot (#<id>.<k>), and whatever follows that dot goes
// with the id, of any length, so a damaged key is covered too. The quotes and
// the rest of the message stay.
const FRAGMENT_ROOM_ID = /#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[^\s'"`<>()]*)?/gi;

// A token no URL rule applies to: only its link parameters and its room id go.
function scrubUnshapedToken(token: string): string {
    return redactLinkParams(token.replace(FRAGMENT_ROOM_ID, '#redacted'));
}

function scrubText(text: string): string {
    const clean = dropSelectorWords(text);
    if (!mayHoldSecret(clean)) return clean;
    return clean
        .split(/(\s+)/)
        .map((token) => {
            if (!mayHoldSecret(token)) return token;
            const urlish =
                EMBEDDED_URL.test(token) ||
                ROOM_PARAM.test(token) ||
                SESSION_PARAM.test(token) ||
                (URL_TOKEN.test(token) && (!token.startsWith('#') || FRAGMENT_SECRET.test(token)));
            return urlish ? (scrubUrl(token) ?? '') : scrubUnshapedToken(token);
        })
        .join('');
}

// REQUEST_PATH_SHAPE on a raw, still-encoded string, where a /r path can also
// open a query value (?next=r%2F<id>) right after its '='.
const REQUEST_PATH_HINT = /(^|[/=]|%2f)(?:r|%72)(?:\/|%2f)[^/]/i;

// Whether a string can hold the room id or the link key (a fragment, a room= or
// k= parameter, <id>.<k> on its own, or a link percent-encoded inside a URL), a
// signaling session id (a sid= parameter) or a request-link id (a /r/<linkId>
// path). Nothing else is touched, and only a URL-shaped token is ever rewritten for
// a /r segment, so free text such as "r/abc" stays.
function mayHoldSecret(value: string): boolean {
    return (
        value.includes('#') ||
        ROOM_PARAM.test(value) ||
        LINK_PARAM_START.test(value) ||
        KEYED_ROOM_SHAPE.test(value) ||
        ENCODED_LINK_HINT.test(value) ||
        SESSION_PARAM.test(value) ||
        REQUEST_PATH_HINT.test(value)
    );
}

// A transaction name, on a transaction or on an error event: the description
// rule, then the /r rule unconditionally (see scrubTransactionEvent for why a
// parameterized /r/:linkId collapses too).
function scrubTransactionName(name: string): string {
    return redactRequestPath(scrubDescription(name));
}

// The span attributes the SDK's httpHeadersToSpanAttributes writes, one per
// header it keeps: http.request.header.next_url and its siblings on every
// server span of a request. Dropped whole rather than scrubbed: a header can
// carry any URL, and Next-Router-State-Tree is URL-encoded JSON that holds
// the link id where no string rule here can see it (CP-QA F3-01).
const HEADER_ATTRIBUTE = /^http\.(?:request|response)\.header\./;

function scrubAttributes(data: Record<string, unknown> | undefined): void {
    if (!data) return;
    for (const key of Object.keys(data)) {
        if (HEADER_ATTRIBUTE.test(key)) delete data[key];
    }
    for (const key of URL_ATTRIBUTES) {
        const value = data[key];
        if (typeof value !== 'string' || value === '') continue;
        if (key === 'http.fragment' || key === 'url.fragment') {
            // A fragment is never useful telemetry, and it is where every
            // current link keeps the room id.
            delete data[key];
        } else if (key === 'http.query') {
            data[key] = scrubQuery(value);
        } else if (key === 'url.query') {
            data[key] = scrubQueryKeepingShape(value);
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

// url.query, scrubbed and handed back as it came: with no leading '?' when it
// had none.
function scrubQueryKeepingShape(query: string): string {
    const scrubbed = scrubQuery(query);
    return query.startsWith('?') ? scrubbed : scrubbed.replace(/^\?/, '');
}
