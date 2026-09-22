import { describe, it, expect } from 'vitest';
import { parseRequestLink, linkIdFromPath, LINK_ID_RE } from './requestLink';

const LINK_ID = 'Ab3dE_f9-xY';
const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

describe('parseRequestLink', () => {
    it('accepts a valid link', () => {
        expect(parseRequestLink(`/r/${LINK_ID}`, `#${ROOM_ID}`)).toEqual({
            linkId: LINK_ID,
            roomId: ROOM_ID,
        });
        // The alphabet is base64url: both of its non-alphanumeric characters
        // have to survive, or one link in a few hundred is unopenable.
        expect(LINK_ID_RE.test(LINK_ID)).toBe(true);
    });

    it('accepts one trailing slash after the linkId', () => {
        expect(parseRequestLink(`/r/${LINK_ID}/`, `#${ROOM_ID}`)).toEqual({
            linkId: LINK_ID,
            roomId: ROOM_ID,
        });
        // ...but only one segment. A second one is a different URL.
        expect(parseRequestLink(`/r/${LINK_ID}/x`, `#${ROOM_ID}`)).toEqual({
            error: 'incomplete',
        });
    });

    it('rejects a linkId of 10 characters', () => {
        expect(parseRequestLink(`/r/${LINK_ID.slice(0, 10)}`, `#${ROOM_ID}`)).toEqual({
            error: 'incomplete',
        });
    });

    it('rejects a linkId of 12 characters', () => {
        expect(parseRequestLink(`/r/${LINK_ID}z`, `#${ROOM_ID}`)).toEqual({
            error: 'incomplete',
        });
    });

    it('rejects illegal linkId characters', () => {
        // Anything outside base64url, including the characters that would make
        // a link id interesting if it ever reached a sink: a dot, a plus (the
        // base64 alphabet the url variant replaces), a percent escape and an
        // angle bracket.
        for (const bad of ['Ab3dE.f9-xY', 'Ab3dE+f9/xY', 'Ab3dE%20f9x', 'Ab3d<f9-xY']) {
            expect(parseRequestLink(`/r/${bad}`, `#${ROOM_ID}`)).toEqual({
                error: 'incomplete',
            });
        }
    });

    it('rejects a missing fragment', () => {
        // The room id is the capability. A link pasted without everything after
        // the # is the single most likely way to arrive here, and it is exactly
        // what the V1 copy addresses.
        expect(parseRequestLink(`/r/${LINK_ID}`, '')).toEqual({ error: 'incomplete' });
        expect(parseRequestLink(`/r/${LINK_ID}`, '#')).toEqual({ error: 'incomplete' });
    });

    it('rejects the #room=<uuid> form', () => {
        // That is today's share-link shape for "/", a different page. The
        // fragment here is a bare uuid and nothing else.
        expect(parseRequestLink(`/r/${LINK_ID}`, `#room=${ROOM_ID}`)).toEqual({
            error: 'incomplete',
        });
    });

    it('accepts an uppercase UUID', () => {
        const upper = ROOM_ID.toUpperCase();
        expect(parseRequestLink(`/r/${LINK_ID}`, `#${upper}`)).toEqual({
            linkId: LINK_ID,
            roomId: upper,
        });
    });

    it('rejects trailing punctuation after the UUID', () => {
        // Mail clients and chat apps swallow a trailing period or bracket into
        // the link. The room id regex is anchored, so these are rejections
        // rather than a silently truncated room.
        for (const tail of ['.', ')', '>', ' ', '/']) {
            expect(parseRequestLink(`/r/${LINK_ID}`, `#${ROOM_ID}${tail}`)).toEqual({
                error: 'incomplete',
            });
        }
    });
});

describe('linkIdFromPath', () => {
    it('reads the id from a request path and nothing else', () => {
        expect(linkIdFromPath(`/r/${LINK_ID}`)).toBe(LINK_ID);
        expect(linkIdFromPath(`/r/${LINK_ID}/`)).toBe(LINK_ID);
        expect(linkIdFromPath('/r')).toBeNull();
        expect(linkIdFromPath('/r/')).toBeNull();
        expect(linkIdFromPath('/rx/abc')).toBeNull();
        expect(linkIdFromPath(`/R/${LINK_ID}`)).toBeNull();
    });
});
