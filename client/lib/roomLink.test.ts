import { describe, expect, it } from 'vitest';
import { LINK_KEY_RE, linkKeyText, parseLinkKey, readShareFragment, type LinkKey } from './linkKey';
import { buildShareLink, getRoomFromUrl, isValidRoomId } from './roomLink';

const UUID = '3f2b9c1e-7a4d-4c2e-9b1f-8e6d5c4b3a21';

describe('getRoomFromUrl', () => {
    it('reads the fragment, which is where the secret belongs', () => {
        expect(getRoomFromUrl(`#room=${UUID}`, '')).toBe(UUID);
    });

    it('tolerates a fragment with no leading hash', () => {
        expect(getRoomFromUrl(`room=${UUID}`, '')).toBe(UUID);
    });

    it('still reads the legacy query param', () => {
        // Older links used ?room=<id>, which leaked the secret into the
        // Referer header and into analytics. Read for compatibility only.
        expect(getRoomFromUrl('', `?room=${UUID}`)).toBe(UUID);
    });

    it('prefers the fragment when both are present', () => {
        const legacy = '00000000-0000-0000-0000-000000000000';
        expect(getRoomFromUrl(`#room=${UUID}`, `?room=${legacy}`)).toBe(UUID);
    });

    it('returns null when neither carries a room', () => {
        expect(getRoomFromUrl('', '')).toBeNull();
        expect(getRoomFromUrl('#s=abcd1234', '?s=abcd1234')).toBeNull();
    });

    it('ignores the nonce that shares the query string', () => {
        expect(getRoomFromUrl(`#room=${UUID}`, '?s=abcd1234')).toBe(UUID);
    });
});

describe('isValidRoomId', () => {
    it('accepts a well-formed id in either case', () => {
        expect(isValidRoomId(UUID)).toBe(true);
        expect(isValidRoomId(UUID.toUpperCase())).toBe(true);
    });

    it('rejects the shapes a malformed link produces', () => {
        for (const bad of [
            '',
            'not-a-uuid',
            UUID.slice(0, -1), // one char short
            `${UUID}x`, // one char long
            `  ${UUID}  `, // untrimmed
            '3f2b9c1e7a4d4c2e9b1f8e6d5c4b3a21', // no hyphens
            '3f2b9c1g-7a4d-4c2e-9b1f-8e6d5c4b3a21', // g is not hex
        ]) {
            expect(isValidRoomId(bad), bad).toBe(false);
        }
    });

    it('is a format check, not a version-strict UUID check', () => {
        // Deliberately loose, and it must stay that way: the server applies the
        // same loose regex, and a stricter client would reject ids the server
        // accepts. Version nibble 9 and variant nibble 1 are both non-standard.
        expect(isValidRoomId('3f2b9c1e-7a4d-9c2e-1b1f-8e6d5c4b3a21')).toBe(true);
    });
});

describe('buildShareLink', () => {
    it('puts the room in the fragment and the nonce in the query', () => {
        // The split is the whole design: the fragment never reaches the server,
        // and the nonce makes each link a distinct document so a phone with
        // Floe already open cannot reuse a stale tab for a new QR.
        expect(buildShareLink('https://www.floe.one', UUID, 'abcd1234', null)).toBe(
            `https://www.floe.one/?s=abcd1234#room=${UUID}`
        );
    });

    it('works for a self-hosted origin with a port', () => {
        expect(buildShareLink('http://localhost:3000', UUID, 'ff00ff00', null)).toBe(
            `http://localhost:3000/?s=ff00ff00#room=${UUID}`
        );
    });

    it('round-trips through getRoomFromUrl', () => {
        const link = buildShareLink('https://www.floe.one', UUID, 'abcd1234', null);
        const { hash, search } = new URL(link);
        expect(getRoomFromUrl(hash, search)).toBe(UUID);
        expect(isValidRoomId(getRoomFromUrl(hash, search)!)).toBe(true);
    });

    describe('with a link key', () => {
        const KEY_TEXT = 'AAECAwQFBgcICQoLDA0ODw';
        const KEY = parseLinkKey(KEY_TEXT) as LinkKey;

        // The spec's order: k first, so a link cut at the & is cut before the room
        // and reads as incomplete, never as a keyless link into the same room.
        it('puts the key first in the fragment, and nothing of it before the #', () => {
            const link = buildShareLink('https://www.floe.one', UUID, 'abcd1234', KEY);
            expect(link).toBe(`https://www.floe.one/?s=abcd1234#k=${KEY_TEXT}&room=${UUID}`);
            expect(link.slice(0, link.indexOf('#'))).not.toContain(KEY_TEXT);
        });

        it('makes the shape the other surfaces parse', () => {
            const link = buildShareLink('http://localhost:3000', UUID, 'ff00ff00', KEY);
            expect(link).toMatch(/\/\?s=[^#]+#k=[A-Za-z0-9_-]{21}[AQgw]&room=[0-9a-f-]{36}$/);
        });

        it('round-trips through readShareFragment, room and key alike', () => {
            const { hash, search } = new URL(buildShareLink('https://www.floe.one', UUID, 'abcd1234', KEY));
            const read = readShareFragment(hash, search);
            expect(read.incomplete).toBe(false);
            expect(read.room).toBe(UUID);
            expect(LINK_KEY_RE.test(linkKeyText(read.key as LinkKey))).toBe(true);
            expect(linkKeyText(read.key as LinkKey)).toBe(KEY_TEXT);
        });

        // The placeholder is what a key's toString gives, so this is the test that the
        // builder asked for its text and did not interpolate the object.
        it('holds the key itself, never its placeholder', () => {
            const link = buildShareLink('https://www.floe.one', UUID, 'abcd1234', KEY);
            expect(link).not.toContain('[link key]');
        });
    });
});
