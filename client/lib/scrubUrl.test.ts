import { describe, it, expect } from 'vitest';
import { scrubUrl } from './scrubUrl';

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
});
