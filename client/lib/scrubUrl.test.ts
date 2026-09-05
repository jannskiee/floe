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
});

describe('scrubSpanJson', () => {
    it('scrubs a standalone span in place', () => {
        const span = { data: { 'url.full': 'https://www.floe.one/#room=secret-uuid' } };
        expect(scrubSpanJson(span)).toBe(span);
        expect(span.data['url.full']).toBe('https://www.floe.one/');
    });
});
