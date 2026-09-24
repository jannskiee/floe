import { describe, it, expect } from 'vitest';
import { scrubErrorEvent, scrubSpanJson, scrubTransactionEvent, scrubUrl } from './scrubUrl';
import type { ScrubbableErrorEvent } from './scrubUrl';

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

describe('scrubUrl on a request link', () => {
    // A request link is /r/<linkId>#<roomId>. The room id in the fragment is a
    // capability and goes with every other fragment; the link id in the path is
    // not a secret, but it names one link and one person's request and has no
    // place in telemetry.
    const LINK_ID = 'Ab3dE_f9-xY';
    const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const REQUEST_LINK = `https://floe.one/r/${LINK_ID}#${ROOM_ID}`;

    it('redacts an absolute /r/<linkId> URL and drops its fragment', () => {
        const out = scrubUrl(REQUEST_LINK);
        expect(out).toBe('https://floe.one/r/redacted');
        expect(out).not.toContain(LINK_ID);
        expect(out).not.toContain(ROOM_ID);
        expect(out).not.toContain('#');
    });

    it('redacts a relative /r/<linkId> path', () => {
        expect(scrubUrl(`/r/${LINK_ID}`)).toBe('/r/redacted');
        expect(scrubUrl(`/r/${LINK_ID}/`)).toBe('/r/redacted/');
        expect(scrubUrl(`/r/${LINK_ID}#${ROOM_ID}`)).toBe('/r/redacted');
    });

    it('redacts /R/<linkId> case-insensitively', () => {
        // Next routes are case-sensitive, so this URL never reaches the page.
        // The scrub still folds case: it runs over strings that arrived from
        // somewhere else, and a redaction that a capital letter defeats is not
        // a redaction.
        expect(scrubUrl(`https://floe.one/R/${LINK_ID}`)).toBe('https://floe.one/r/redacted');
    });

    it('leaves /r alone', () => {
        // There is no id in a bare /r to redact, and rewriting it would make
        // two different pages look like one in telemetry.
        expect(scrubUrl('https://floe.one/r')).toBe('https://floe.one/r');
        expect(scrubUrl('/r')).toBe('/r');
        expect(scrubUrl('/r/')).toBe('/r/');
    });

    it('leaves /rx/abc and /robots.txt alone', () => {
        expect(scrubUrl('https://floe.one/rx/abc')).toBe('https://floe.one/rx/abc');
        expect(scrubUrl('/rx/abc')).toBe('/rx/abc');
        expect(scrubUrl('/robots.txt')).toBe('/robots.txt');
        expect(scrubUrl('/relay')).toBe('/relay');
        expect(scrubUrl('/r-archive')).toBe('/r-archive');
    });

    it('still redacts ?room=', () => {
        // The path redaction must not have displaced the one that was already
        // here: both run, on their own halves of the URL.
        expect(scrubUrl(`/r/${LINK_ID}?room=${ROOM_ID}`)).toBe('/r/redacted?room=redacted');
        expect(scrubUrl(`https://floe.one/?room=${ROOM_ID}`)).toBe(
            'https://floe.one/?room=redacted'
        );
    });

    it('the fallback branch redacts /r/<linkId>', () => {
        // An unterminated IPv6 host makes `new URL` throw even with a base, so
        // this input can only come out of the catch arm. The room redaction has
        // to stay on the query side there and the path redaction on the path
        // side, because that branch has no parsed URL to ask.
        const broken = `https://[/r/${LINK_ID}?room=${ROOM_ID}#${ROOM_ID}`;
        expect(() => new URL(broken, 'http://scrub.invalid')).toThrow();
        const out = scrubUrl(broken);
        expect(out).toBe('https://[/r/redacted?room=redacted');
        expect(out).not.toContain(LINK_ID);
        expect(out).not.toContain(ROOM_ID);
    });

    it('span url.full and http.url on /r are redacted', () => {
        // The browser SDK's HttpContext integration stamps location.href onto
        // the segment span's url.full, so on a visitor page that is the whole
        // request link.
        const event = {
            request: { url: REQUEST_LINK },
            contexts: { trace: { data: { 'url.full': REQUEST_LINK } } },
            spans: [{ data: { 'url.full': REQUEST_LINK, 'http.url': REQUEST_LINK } }],
        };
        const out = scrubTransactionEvent(event);
        const json = JSON.stringify(out);
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(ROOM_ID);
        expect(out.request.url).toBe('https://floe.one/r/redacted');
        expect(out.contexts.trace.data['url.full']).toBe('https://floe.one/r/redacted');
        expect(out.spans[0].data['url.full']).toBe('https://floe.one/r/redacted');
        expect(out.spans[0].data['http.url']).toBe('https://floe.one/r/redacted');
        // The standalone-span path reaches the same scrub.
        const span = { data: { 'url.full': REQUEST_LINK } };
        expect(scrubSpanJson(span).data['url.full']).toBe('https://floe.one/r/redacted');
    });

    it('the transaction name is redacted, parameterized or not', () => {
        // The name is the field Sentry indexes and lists, and it is the one
        // place the id would survive every URL scrub above.
        expect(scrubTransactionEvent({ transaction: `/r/${LINK_ID}` }).transaction).toBe(
            '/r/redacted'
        );

        // Both parameterized forms collapse to the same bucket, deliberately.
        // The Next SDK names a /r pageload /r/:linkId today, from a route
        // manifest it injects by default; this does not depend on that default
        // holding, and it does not try to tell a placeholder from an id. There
        // is one /r route, so one bucket is all the grouping it can offer, and
        // a rule that redacted only today's 11-character id shape would stop
        // covering an id of any other length without anyone noticing.
        expect(scrubTransactionEvent({ transaction: '/r/:linkId' }).transaction).toBe(
            '/r/redacted'
        );
        expect(scrubTransactionEvent({ transaction: '/r/[linkId]' }).transaction).toBe(
            '/r/redacted'
        );

        // Every other route keeps its name, including the bare /r that has no
        // id in it to hide.
        expect(scrubTransactionEvent({ transaction: '/download' }).transaction).toBe('/download');
        expect(scrubTransactionEvent({ transaction: '/r' }).transaction).toBe('/r');
        expect(scrubTransactionEvent({ transaction: '/robots.txt' }).transaction).toBe(
            '/robots.txt'
        );

        // A transaction with no name is left alone rather than coerced into
        // one. Typed rather than a bare {}, so the generic has the field to
        // infer and tsc can see the assertion.
        const nameless: { transaction?: string } = {};
        expect(scrubTransactionEvent(nameless).transaction).toBeUndefined();
    });

    it('breadcrumb from and to on /r are redacted', () => {
        // beforeBreadcrumb in sentry.client.config.ts runs scrubUrl over
        // data.url, data.to and data.from; navigation breadcrumbs carry the
        // last two as paths rather than absolute URLs.
        const data: Record<string, string> = {
            from: `/r/${LINK_ID}`,
            to: `/r/${LINK_ID}#${ROOM_ID}`,
            url: REQUEST_LINK,
        };
        for (const key of ['from', 'to', 'url'] as const) {
            data[key] = scrubUrl(data[key]) ?? '';
        }
        expect(data.from).toBe('/r/redacted');
        expect(data.to).toBe('/r/redacted');
        expect(data.url).toBe('https://floe.one/r/redacted');
        expect(JSON.stringify(data)).not.toContain(LINK_ID);
        expect(JSON.stringify(data)).not.toContain(ROOM_ID);
    });

    it('a /r pageload shaped like the capture carries no link id anywhere', () => {
        // Captured on a production build (CP-UI forced-r-diag.txt): the segment's
        // url.path is the bare /r/<linkId> path, with no '#' and no room=, so
        // neither the URL attributes nor the description rule reached it.
        // browserTracing and the Next router instrumentation write url.path on
        // every pageload and navigation span, and an http.client span names
        // and records any fetch of a /r path the same way.
        const out = scrubTransactionEvent(requestPageload());
        const json = JSON.stringify(out);
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(ROOM_ID);
        expect(out.transaction).toBe('/r/redacted');
        expect(out.request.url).toBe('http://localhost:3000/r/redacted');
        expect(out.contexts.trace.data).toEqual({
            'sentry.op': 'pageload',
            'sentry.source': 'route',
            'url.full': 'http://localhost:3000/r/redacted',
            'url.path': '/r/redacted',
            'url.template': '/r/redacted',
        });
        const fetchSpan = out.spans.find((s) => s.op === 'http.client');
        expect(fetchSpan?.description).toBe('GET /r/redacted?_rsc=1x2y3');
        expect(fetchSpan?.data).toEqual({
            type: 'fetch',
            url: '/r/redacted?_rsc=1x2y3',
            'url.path': '/r/redacted',
            'http.query': '?_rsc=1x2y3',
        });
        for (const span of out.spans.filter((s) => s.op.startsWith('browser.'))) {
            expect(span.description).toBe('http://localhost:3000/r/redacted');
        }
        // A standalone span reaches the same rule.
        const standalone = { description: `GET /r/${LINK_ID}`, data: { 'url.path': `/r/${LINK_ID}` } };
        expect(JSON.stringify(scrubSpanJson(standalone))).not.toContain(LINK_ID);
    });

    it('a pageload anywhere else keeps its paths byte for byte', () => {
        const event = () => ({
            transaction: '/how-it-works',
            request: { url: 'https://www.floe.one/how-it-works' },
            contexts: {
                trace: {
                    data: {
                        'url.full': 'https://www.floe.one/how-it-works',
                        'url.path': '/how-it-works',
                        'url.template': '/how-it-works',
                    },
                },
            },
            spans: [
                {
                    op: 'http.client',
                    description: 'GET /api/stats',
                    data: { url: '/api/stats', 'url.path': '/api/stats' },
                },
                { op: 'resource.other', description: '/robots.txt', data: { 'url.path': '/robots.txt' } },
                { op: 'resource.other', description: '/rx/abc', data: { 'url.path': '/r' } },
                { op: 'custom', description: 'r/abc is not a path', data: { note: 'div.w-1/2 r/x' } },
            ],
        });
        expect(scrubTransactionEvent(event())).toEqual(event());
    });

    it('an error event from /r carries no link id anywhere', () => {
        // Captured on a production build: an error thrown on /r reports its
        // transaction as the raw /r/<linkId> path, and beforeSend scrubbed
        // request.url only. V8 names an inline script's frames after the
        // document URL without its fragment, so a frame on /r carries the path.
        const out = scrubErrorEvent(requestError(`/r/${LINK_ID}`, `http://localhost:3000/r/${LINK_ID}#${ROOM_ID}`));
        const json = JSON.stringify(out);
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(ROOM_ID);
        expect(out.transaction).toBe('/r/redacted');
        expect(out.request.url).toBe('http://localhost:3000/r/redacted');
        const frames = out.exception.values[0].stacktrace.frames;
        expect(frames[0]).toEqual({ ...INLINE_FRAME, filename: 'app:///r/redacted', abs_path: 'app:///r/redacted' });
        expect(frames[1]).toEqual(CHUNK_FRAME);
        // A parameterized name collapses to the same bucket as on a transaction.
        expect(scrubErrorEvent({ transaction: '/r/:linkId' }).transaction).toBe('/r/redacted');
    });

    it('an error event anywhere else is left byte for byte', () => {
        const home = () => requestError('/how-it-works', 'https://www.floe.one/how-it-works', 'app:///how-it-works');
        expect(scrubErrorEvent(home())).toEqual(home());
        const bare = {};
        expect(scrubErrorEvent(bare)).toBe(bare);
        const nameless: { transaction?: string } = {};
        expect(scrubErrorEvent(nameless).transaction).toBeUndefined();
    });

    it('never throws on an odd error event and returns it unchanged', () => {
        // beforeSend drops an event whose hook throws, so a throw would fail
        // closed, but a scrub has no business losing an error report. The SDK
        // does not emit these shapes; anything else that reaches beforeSend
        // (a third-party event processor, a future SDK) might.
        const shapes: unknown[] = [
            { exception: null },
            { exception: { values: null } },
            { exception: { values: 'nope' } },
            { exception: { values: [null] } },
            { exception: { values: [undefined, 42, 'x', true] } },
            { exception: { values: [{ stacktrace: null }] } },
            { exception: { values: [{ stacktrace: 'nope' }] } },
            { exception: { values: [{ stacktrace: { frames: null } }] } },
            { exception: { values: [{ stacktrace: { frames: 'nope' } }] } },
            { exception: { values: [{ stacktrace: { frames: { 0: { filename: `/r/${LINK_ID}` } } } }] } },
            { exception: { values: [{ stacktrace: { frames: [null, 7, 'x', { filename: 42, abs_path: null }] } }] } },
            { request: null },
            { request: { url: 42 } },
            { transaction: null },
            { transaction: 42 },
        ];
        for (const shape of shapes) {
            const event = shape as ScrubbableErrorEvent;
            const before = structuredClone(shape);
            expect(() => scrubErrorEvent(event), JSON.stringify(shape)).not.toThrow();
            expect(event, JSON.stringify(shape)).toEqual(before);
        }
    });

    // A /r pageload transaction as the capture shows it (ids replaced), plus an
    // http.client span for a fetch of a /r path and one resource span that must
    // stay as it is.
    function requestPageload() {
        const href = `http://localhost:3000/r/${LINK_ID}#${ROOM_ID}`;
        return {
            type: 'transaction',
            transaction: '/r/:linkId',
            request: { url: href, headers: { 'User-Agent': 'Mozilla/5.0' } },
            contexts: {
                trace: {
                    data: {
                        'sentry.op': 'pageload',
                        'sentry.source': 'route',
                        'url.full': href,
                        'url.path': `/r/${LINK_ID}`,
                        'url.template': '/r/:linkId',
                    },
                },
            },
            spans: [
                ...['browser.domContentLoadedEvent', 'browser.loadEvent', 'browser.request', 'browser.response'].map(
                    (op) => ({ op, description: href, data: { 'sentry.op': op } })
                ),
                {
                    op: 'http.client',
                    description: `GET /r/${LINK_ID}?_rsc=1x2y3`,
                    data: {
                        type: 'fetch',
                        url: `/r/${LINK_ID}?_rsc=1x2y3`,
                        'url.path': `/r/${LINK_ID}`,
                        'http.query': '?_rsc=1x2y3',
                    },
                },
                {
                    op: 'resource.script',
                    description: '/_next/static/chunks/0a1b.js',
                    data: { 'sentry.op': 'resource.script' },
                },
            ],
        };
    }

    // An error event as beforeSend receives it, with one frame from an inline
    // script on the page and one from a bundle chunk.
    function requestError(transaction: string, url: string, inlineFrame = `app:///r/${LINK_ID}`) {
        return {
            level: 'error',
            transaction,
            request: { url, headers: { 'User-Agent': 'Mozilla/5.0' } },
            contexts: { trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' } },
            exception: {
                values: [
                    {
                        type: 'Error',
                        value: 'boom',
                        stacktrace: {
                            frames: [
                                { ...INLINE_FRAME, filename: inlineFrame, abs_path: inlineFrame },
                                { ...CHUNK_FRAME },
                            ],
                        },
                    },
                ],
            },
        };
    }
});

const INLINE_FRAME = { function: '?', lineno: 5, colno: 15, in_app: true };

const CHUNK_FRAME = {
    filename: 'app:///_next/static/chunks/0a1b.js',
    abs_path: 'app:///_next/static/chunks/0a1b.js',
    function: 'onClick',
    lineno: 1,
    colno: 2048,
    in_app: true,
};

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
    'div.w-1/2.bg-[#fff]',
    'div#x.w-1/2.bg-[#fff]',
    'img[alt="a/b#c"]',
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
    // On the feature branch scrubUrl also redacts the /r link id (the request-link path rule).
    [`https://www.floe.one/r/Zq1a2b3c4d#${ROOM}`, 'https://www.floe.one/r/redacted'],
    [`https://www.floe.one/?room=${ROOM}&x=1`, 'https://www.floe.one/?room=redacted&x=1'],
    [`/?room=${ROOM}`, '/?room=redacted'],
    [`#room=${ROOM}`, '/'],
    [`#${ROOM}`, '/'],
    [`GET /?s=b7Kq2xZp9w#room=${ROOM}`, 'GET /?s=b7Kq2xZp9w'],
    [`navigate to http://localhost:3000/#room=${ROOM} now`, 'navigate to http://localhost:3000/ now'],
    [`www.floe.one/#room=${ROOM}`, '/www.floe.one/'],
    [`(https://www.floe.one/r/Zq1a2b3c4d#${ROOM})`, '/(https://www.floe.one/r/redacted'],
    [`url=https://www.floe.one/r/Zq1a2b3c4d#${ROOM}`, '/url=https://www.floe.one/r/redacted'],
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
