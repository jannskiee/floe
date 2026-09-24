import { describe, it, expect } from 'vitest';
import { scrubSpanJson, scrubTransactionEvent, scrubUrl } from './scrubUrl';

describe('scrubUrl', () => {
    it('strips the room id from a fragment (new-style links)', () => {
        const out = scrubUrl('https://floe.one/#room=secret-uuid');
        expect(out).not.toContain('secret-uuid');
        expect(out).not.toContain('#');
        expect(out).toBe('https://floe.one/');
    });

    it('redacts the room id from a query param (old-style links)', () => {
        expect(scrubUrl('https://floe.one/?room=secret-uuid')).toBe(
            'https://floe.one/?room=redacted'
        );
    });

    it('keeps other query params while redacting room', () => {
        const out = scrubUrl('https://floe.one/?room=secret-uuid&foo=1');
        expect(out).not.toContain('secret-uuid');
        expect(out).toContain('foo=1');
    });

    it('handles relative URLs from breadcrumbs', () => {
        expect(scrubUrl('/#room=secret-uuid')).toBe('/');
        expect(scrubUrl('/path?room=secret-uuid')).toBe('/path?room=redacted');
    });

    it('leaves URLs without a room secret untouched', () => {
        expect(scrubUrl('https://floe.one/how-it-works')).toBe(
            'https://floe.one/how-it-works'
        );
    });

    it('passes through nullish values', () => {
        expect(scrubUrl(undefined)).toBeUndefined();
        expect(scrubUrl(null)).toBeUndefined();
    });

    it('never mistakes a host starting with the dummy base for the base itself', () => {
        // The base-strip must match "http://scrub.invalid/", not the bare
        // prefix: this host merely starts with the same characters and must
        // come back intact (still room-scrubbed), not sliced into garbage.
        expect(scrubUrl('http://scrub.invalid.evil.com/path?room=secret-uuid')).toBe(
            'http://scrub.invalid.evil.com/path?room=redacted'
        );
        // The dummy-base strip itself still works for relative inputs.
        expect(scrubUrl('/path?room=secret-uuid')).toBe('/path?room=redacted');
    });
});

describe('scrubTransactionEvent', () => {
    const LINK = 'https://www.floe.one/?s=abcd1234#room=secret-uuid';

    it('strips the room id from the transaction request url', () => {
        const event = { type: 'transaction', request: { url: LINK } };
        expect(scrubTransactionEvent(event).request.url).toBe('https://www.floe.one/?s=abcd1234');
    });

    it('scrubs the trace context and every span attribute the SDK writes', () => {
        const event = {
            contexts: { trace: { data: { 'url.full': LINK, 'sentry.op': 'pageload' } } },
            spans: [
                {
                    data: {
                        'url.full': LINK,
                        'http.url': LINK,
                        'http.query': '?room=secret-uuid&x=1',
                        'http.fragment': '#room=secret-uuid',
                    },
                },
                { data: { 'sentry.op': 'ui.react.render', 'http.query': '' } },
            ],
        };
        const out = scrubTransactionEvent(event);
        expect(JSON.stringify(out)).not.toContain('secret-uuid');
        expect(out.contexts.trace.data['url.full']).toBe('https://www.floe.one/?s=abcd1234');
        expect(out.contexts.trace.data['sentry.op']).toBe('pageload');
        expect(out.spans[0].data['http.url']).toBe('https://www.floe.one/?s=abcd1234');
        expect(out.spans[0].data['http.query']).toBe('?room=redacted&x=1');
        expect(out.spans[0].data).not.toHaveProperty('http.fragment');
        expect(out.spans[1].data).toEqual({ 'sentry.op': 'ui.react.render', 'http.query': '' });
    });

    it('returns the same object, tolerates a bare event, and leaves non-strings alone', () => {
        const bare = {};
        expect(scrubTransactionEvent(bare)).toBe(bare);
        const odd = { spans: [{ data: { 'url.full': 42 } }] };
        expect(scrubTransactionEvent(odd).spans[0].data['url.full']).toBe(42);
    });

    it('scrubs the receiver link out of the navigation-timing span descriptions', () => {
        // The shape of a captured pageload on a receiver page: browserTracing
        // names each navigation-timing span after the PerformanceNavigationTiming
        // entry, which is the document URL with its fragment.
        const out = scrubTransactionEvent(pageloadEvent());
        const json = JSON.stringify(out);
        expect(json).not.toContain(ROOM);
        expect(json).not.toContain('#');
        const nav = out.spans.filter((s) => NAV_OPS.includes(s.op));
        expect(nav).toHaveLength(NAV_OPS.length);
        for (const span of nav) expect(span.description).toBe(RECEIVER_SCRUBBED);
        expect(out.transaction).toBe('/');
        expect(out.contexts.trace.data['url.full']).toBe(RECEIVER_SCRUBBED);
        expect(out.request.url).toBe(RECEIVER_SCRUBBED);
        expect(out.measurements).toEqual(pageloadEvent().measurements);
        const loaf = out.spans.find((s) => s.op === 'ui.long-animation-frame');
        expect(loaf?.data).toEqual({ ...LOAF_DATA, ...LOAF_URLS(RECEIVER_SCRUBBED) });
    });

    it('scrubs the page URL out of every other string in span data', () => {
        // Beyond the four URL attributes: a long-animation-frame span's script
        // attributes on a child span, a legacy ?room= referer on the segment
        // (contexts.trace.data), and a string inside an array value.
        const event = {
            contexts: {
                trace: {
                    data: {
                        'sentry.op': 'pageload',
                        'http.request.header.referer': `https://www.floe.one/?room=${ROOM}`,
                    },
                },
            },
            spans: [
                { data: { ...LOAF_DATA, ...LOAF_URLS(RECEIVER) } },
                { data: { 'custom.list': ['plain', RECEIVER, 7] } },
            ],
        };
        const out = scrubTransactionEvent(event);
        expect(JSON.stringify(out)).not.toContain(ROOM);
        expect(out.contexts.trace.data).toEqual({
            'sentry.op': 'pageload',
            'http.request.header.referer': 'https://www.floe.one/?room=redacted',
        });
        expect(out.spans[0].data).toEqual({ ...LOAF_DATA, ...LOAF_URLS(RECEIVER_SCRUBBED) });
        expect(out.spans[1].data).toEqual({ 'custom.list': ['plain', RECEIVER_SCRUBBED, 7] });
    });

    it('leaves span data strings that are not URLs exactly as they were', () => {
        const data = () => ({
            ...LOAF_DATA,
            'browser.script.invoker': 'BUTTON#b.onclick',
            'code.filepath': 'https://cloud.umami.is/script.js',
            'lcp.element': 'body > div#main > img.hero',
            'cls.source.1': 'div#app > section',
            'custom.list': ['TimerHandler:setTimeout', 'bathroom=3', 7],
            ...Object.fromEntries(UNTOUCHED.map((d, i) => [`untouched.${i}`, d])),
        });
        const event = { contexts: { trace: { data: data() } }, spans: [{ data: data() }] };
        const out = scrubTransactionEvent(event);
        expect(out.contexts.trace.data).toEqual(data());
        expect(out.spans[0].data).toEqual(data());
    });

    it('leaves a span description that is not a URL exactly as it was', () => {
        const event = { transaction: '/', spans: UNTOUCHED.map((d) => ({ description: d })) };
        const out = scrubTransactionEvent(event);
        expect(out.spans.map((s) => s.description)).toEqual(UNTOUCHED);
        expect(out.transaction).toBe('/');
        const empty = { spans: [{ data: {} }, { description: '' }] };
        expect(scrubTransactionEvent(empty).spans).toEqual([{ data: {} }, { description: '' }]);
    });

    it('fails closed on a description carrying a fragment or a room query', () => {
        const out = scrubTransactionEvent({ spans: FAIL_CLOSED.map(([d]) => ({ description: d })) });
        expect(out.spans.map((s) => s.description)).toEqual(FAIL_CLOSED.map(([, want]) => want));
        expect(JSON.stringify(out)).not.toContain(ROOM);
    });

    it('scrubs a transaction name that carries the room', () => {
        expect(scrubTransactionEvent({ transaction: RECEIVER }).transaction).toBe(RECEIVER_SCRUBBED);
    });

    it('is idempotent, because beforeSendSpan and beforeSendTransaction both run on a transaction', () => {
        const once = scrubTransactionEvent(pageloadEvent());
        const snapshot = JSON.stringify(once);
        expect(JSON.stringify(scrubTransactionEvent(once))).toBe(snapshot);
        for (const [, want] of FAIL_CLOSED) {
            expect(scrubSpanJson({ description: want, data: { 'code.filepath': want } })).toEqual({
                description: want,
                data: { 'code.filepath': want },
            });
        }
    });
});

describe('scrubSpanJson', () => {
    it('scrubs a standalone span in place', () => {
        const span = { data: { 'url.full': 'https://www.floe.one/#room=secret-uuid' } };
        expect(scrubSpanJson(span)).toBe(span);
        expect(span.data['url.full']).toBe('https://www.floe.one/');
    });

    it('scrubs the receiver link out of a standalone span description', () => {
        for (const op of NAV_OPS) {
            const span = { op, description: RECEIVER, data: { 'sentry.op': op } };
            expect(scrubSpanJson(span)).toBe(span);
            expect(span.description).toBe(RECEIVER_SCRUBBED);
        }
        // A transaction's root span as beforeSendSpan sees it: its description
        // is the transaction name, and HttpContext writes url.full onto it.
        const segment = { is_segment: true, description: RECEIVER, data: { 'url.full': RECEIVER } };
        const json = JSON.stringify(scrubSpanJson(segment));
        expect(json).not.toContain(ROOM);
        expect(json).not.toContain('#');
    });

    it("scrubs the page URL out of a standalone span's other data strings", () => {
        const span = { op: 'ui.long-animation-frame', data: { ...LOAF_DATA, ...LOAF_URLS(RECEIVER) } };
        expect(scrubSpanJson(span).data).toEqual({ ...LOAF_DATA, ...LOAF_URLS(RECEIVER_SCRUBBED) });
        const selector = { data: { ...LOAF_DATA, 'browser.script.invoker': 'BUTTON#b.onclick' } };
        expect(scrubSpanJson(selector).data['browser.script.invoker']).toBe('BUTTON#b.onclick');
    });

    it('leaves a standalone span description that is not a URL exactly as it was', () => {
        for (const description of UNTOUCHED) {
            expect(scrubSpanJson({ description, data: {} }).description).toBe(description);
        }
    });

    it('fails closed on a standalone span description carrying a fragment or a room query', () => {
        for (const [description, want] of FAIL_CLOSED) {
            expect(scrubSpanJson({ description, data: {} }).description).toBe(want);
        }
    });
});

// A receiver link as the browser reports it: ?s= is the per-link nonce, which
// carries nothing and stays; the fragment holds the room id, the transfer secret.
const ROOM = '3f6c1a2e-8b4d-4e7f-9a01-5c2d7e8f9b3a';
const RECEIVER = `http://localhost:3000/?s=b7Kq2xZp9w#room=${ROOM}`;
const RECEIVER_SCRUBBED = 'http://localhost:3000/?s=b7Kq2xZp9w';

// The navigation-timing ops browserTracing names after the document URL. The
// first seven are the ones a captured receiver pageload carried; the rest come
// from the same SDK function when their timings are non-zero.
const NAV_OPS = [
    'browser.domContentLoadedEvent',
    'browser.loadEvent',
    'browser.connect',
    'browser.cache',
    'browser.DNS',
    'browser.request',
    'browser.response',
    'browser.unloadEvent',
    'browser.redirect',
    'browser.TLS/SSL',
];

// Descriptions the SDK writes that hold no secret: resource names (same-origin
// paths and a cross-origin URL), mark and paint names, free text, element
// selectors (one with an id), an http.client name, and paths the URL parser
// would normalize if it were ever run on them.
const UNTOUCHED = [
    '/_next/static/chunks/0a1b2c3d.js',
    '/_next/image?url=%2Flogo.png&w=64&q=75',
    'https://cloud.umami.is/script.js',
    'Next.js-before-hydration',
    'first-contentful-paint',
    'Main UI thread blocked',
    'body > div#main > button.send',
    'div#main > a:nth-child(2)',
    'div#main.w-1/2',
    'bathroom=3',
    'GET /api/turn-credentials',
    '/a/../b',
    '/',
];

// [description, what it must become]. A fragment on anything URL-shaped is
// dropped whatever it holds (a bare #<id> too), and a room= parameter is
// redacted wherever it sits, URL-shaped or not.
const FAIL_CLOSED: [string, string][] = [
    [RECEIVER, RECEIVER_SCRUBBED],
    [`/?s=b7Kq2xZp9w#room=${ROOM}`, '/?s=b7Kq2xZp9w'],
    [`https://www.floe.one/r/Zq1a2b3c4d#${ROOM}`, 'https://www.floe.one/r/Zq1a2b3c4d'],
    [`https://www.floe.one/?room=${ROOM}&x=1`, 'https://www.floe.one/?room=redacted&x=1'],
    [`/?room=${ROOM}`, '/?room=redacted'],
    [`#room=${ROOM}`, '/'],
    [`#${ROOM}`, '/'],
    [`GET /?s=b7Kq2xZp9w#room=${ROOM}`, 'GET /?s=b7Kq2xZp9w'],
    [`navigate to http://localhost:3000/#room=${ROOM} now`, 'navigate to http://localhost:3000/ now'],
    [`www.floe.one/#room=${ROOM}`, '/www.floe.one/'],
    [`(https://www.floe.one/r/Zq1a2b3c4d#${ROOM})`, '/(https://www.floe.one/r/Zq1a2b3c4d'],
    [`floe.one/?s=b7Kq2xZp9w#${ROOM}`, '/floe.one/?s=b7Kq2xZp9w'],
];

// A long-animation-frame span's data, as browserTracing copies it from the
// frame's first script. For an inline classic script, or an inline onclick,
// Chromium reports the document URL, fragment included, as both the invoker
// and the sourceURL; for a handler it reports names like BUTTON#b.onclick.
const LOAF_DATA = {
    'sentry.op': 'ui.long-animation-frame',
    'sentry.origin': 'auto.ui.browser.metrics',
    'browser.script.invoker_type': 'classic-script',
    'browser.script.source_char_position': 0,
};
const LOAF_URLS = (url: string) => ({ 'browser.script.invoker': url, 'code.filepath': url });

function pageloadEvent() {
    return {
        type: 'transaction',
        transaction: '/',
        request: { url: RECEIVER, headers: { 'User-Agent': 'Mozilla/5.0' } },
        contexts: {
            trace: {
                op: 'pageload',
                origin: 'auto.pageload.nextjs.app_router_instrumentation',
                data: { 'sentry.op': 'pageload', 'sentry.source': 'url', 'url.full': RECEIVER },
            },
        },
        measurements: { fcp: { value: 120, unit: 'millisecond' }, ttfb: { value: 30, unit: 'millisecond' } },
        spans: [
            {
                op: 'ui.long-animation-frame',
                description: 'Main UI thread blocked',
                data: { ...LOAF_DATA, ...LOAF_URLS(RECEIVER) },
            },
            { op: 'mark', description: 'Next.js-before-hydration', data: { 'sentry.op': 'mark' } },
            { op: 'paint', description: 'first-contentful-paint', data: { 'sentry.op': 'paint' } },
            {
                op: 'resource.script',
                description: '/_next/static/chunks/0a1b2c3d.js',
                data: { 'url.full': 'http://localhost:3000/_next/static/chunks/0a1b2c3d.js' },
            },
            ...NAV_OPS.map((op) => ({
                op,
                description: RECEIVER,
                data: { 'sentry.op': op, 'sentry.origin': 'auto.ui.browser.metrics' },
            })),
        ],
    };
}
