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
});

describe('scrubSpanJson', () => {
    it('scrubs a standalone span in place', () => {
        const span = { data: { 'url.full': 'https://www.floe.one/#room=secret-uuid' } };
        expect(scrubSpanJson(span)).toBe(span);
        expect(span.data['url.full']).toBe('https://www.floe.one/');
    });
});
