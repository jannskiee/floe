import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LinkKey, linkKeyBytes, linkKeyText } from '../linkKey';
import { parseRequestLink, linkIdFromPath, LINK_ID_RE } from './requestLink';

const LINK_ID = 'Ab3dE_f9-xY';
const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const KEY = 'AAECAwQFBgcICQoLDA0ODw';

/** The parts of a parse a test can compare. A LinkKey keeps its bytes out of reach of
 *  toEqual on purpose, so two different keys would otherwise compare equal. */
function read(pathname: string, hash: string, search = '') {
    const link = parseRequestLink(pathname, hash, search);
    if ('error' in link) return link;
    return { linkId: link.linkId, roomId: link.roomId, key: link.key ? linkKeyText(link.key) : null };
}

describe('parseRequestLink', () => {
    it('accepts a valid link', () => {
        expect(parseRequestLink(`/r/${LINK_ID}`, `#${ROOM_ID}`, '')).toEqual({
            linkId: LINK_ID,
            roomId: ROOM_ID,
            key: null,
        });
        // The alphabet is base64url: both of its non-alphanumeric characters
        // have to survive, or one link in a few hundred is unopenable.
        expect(LINK_ID_RE.test(LINK_ID)).toBe(true);
    });

    it('accepts one trailing slash after the linkId', () => {
        expect(parseRequestLink(`/r/${LINK_ID}/`, `#${ROOM_ID}`, '')).toEqual({
            linkId: LINK_ID,
            roomId: ROOM_ID,
            key: null,
        });
        // ...but only one segment. A second one is a different URL.
        expect(parseRequestLink(`/r/${LINK_ID}/x`, `#${ROOM_ID}`, '')).toEqual({
            error: 'incomplete',
        });
    });

    it('rejects a linkId of 10 characters', () => {
        expect(parseRequestLink(`/r/${LINK_ID.slice(0, 10)}`, `#${ROOM_ID}`, '')).toEqual({
            error: 'incomplete',
        });
    });

    it('rejects a linkId of 12 characters', () => {
        expect(parseRequestLink(`/r/${LINK_ID}z`, `#${ROOM_ID}`, '')).toEqual({
            error: 'incomplete',
        });
    });

    it('rejects illegal linkId characters', () => {
        // Anything outside base64url, including the characters that would make
        // a link id interesting if it ever reached a sink: a dot, a plus (the
        // base64 alphabet the url variant replaces), a percent escape and an
        // angle bracket.
        for (const bad of ['Ab3dE.f9-xY', 'Ab3dE+f9/xY', 'Ab3dE%20f9x', 'Ab3d<f9-xY']) {
            expect(parseRequestLink(`/r/${bad}`, `#${ROOM_ID}`, '')).toEqual({
                error: 'incomplete',
            });
        }
    });

    it('rejects a missing fragment', () => {
        // The room id is the capability. A link pasted without everything after
        // the # is the single most likely way to arrive here, and it is exactly
        // what the V1 copy addresses.
        expect(parseRequestLink(`/r/${LINK_ID}`, '', '')).toEqual({ error: 'incomplete' });
        expect(parseRequestLink(`/r/${LINK_ID}`, '#', '')).toEqual({ error: 'incomplete' });
    });

    it('rejects the #room=<uuid> form', () => {
        // That is today's share-link shape for "/", a different page. The
        // fragment here is a bare uuid and nothing else.
        expect(parseRequestLink(`/r/${LINK_ID}`, `#room=${ROOM_ID}`, '')).toEqual({
            error: 'incomplete',
        });
    });

    it('accepts an uppercase UUID', () => {
        const upper = ROOM_ID.toUpperCase();
        expect(parseRequestLink(`/r/${LINK_ID}`, `#${upper}`, '')).toEqual({
            linkId: LINK_ID,
            roomId: upper,
            key: null,
        });
    });

    it('rejects trailing punctuation after the UUID', () => {
        // Mail clients and chat apps swallow a trailing period or bracket into
        // the link. The room id regex is anchored, so these are rejections
        // rather than a silently truncated room.
        for (const tail of ['.', ')', '>', ' ', '/']) {
            expect(parseRequestLink(`/r/${LINK_ID}`, `#${ROOM_ID}${tail}`, '')).toEqual({
                error: 'incomplete',
            });
        }
    });
});

describe('parseRequestLink with a link key', () => {
    it('reads the key out of the fragment, and hands it over as a LinkKey', () => {
        const link = parseRequestLink(`/r/${LINK_ID}`, `#${ROOM_ID}.${KEY}`, '');
        if ('error' in link) throw new Error('a whole keyed link was refused');
        expect(link.linkId).toBe(LINK_ID);
        expect(link.roomId).toBe(ROOM_ID);
        expect(link.key).toBeInstanceOf(LinkKey);
        expect(linkKeyText(link.key as LinkKey)).toBe(KEY);
        expect([...linkKeyBytes(link.key as LinkKey)]).toEqual([...Array(16).keys()]);
    });

    it('a bare link holds no key, as a value the caller has to read', () => {
        expect(read(`/r/${LINK_ID}`, `#${ROOM_ID}`)).toEqual({ linkId: LINK_ID, roomId: ROOM_ID, key: null });
    });

    it('the key never serializes, so a key that strays into a log says nothing', () => {
        const link = parseRequestLink(`/r/${LINK_ID}`, `#${ROOM_ID}.${KEY}`, '');
        expect(JSON.stringify(link)).not.toContain(KEY);
        expect(String((link as { key: LinkKey }).key)).toBe('[link key]');
    });

    it('a room is read as it is held, its letter case kept', () => {
        const upper = ROOM_ID.toUpperCase();
        expect(read(`/r/${LINK_ID}`, `#${upper}.${KEY}`)).toEqual({ linkId: LINK_ID, roomId: upper, key: KEY });
    });

    it('a key that is cut or damaged is an incomplete link, never a bare one into the same room', () => {
        for (const tail of [
            '.',
            `.${KEY.slice(0, 21)}`,
            `.${KEY}A`,
            '.AAECAwQFBgcICQoLDA0ODx',
            `.${KEY}.${KEY}`,
            `.${KEY}.`,
            `.%41${KEY.slice(1)}`,
            `.${KEY.slice(0, 20)}=w`,
            `.${KEY.slice(0, 20)}+w`,
        ]) {
            expect(read(`/r/${LINK_ID}`, `#${ROOM_ID}${tail}`), tail).toEqual({ error: 'incomplete' });
        }
    });

    it('a keyed fragment holding any % is incomplete, the raw hash being what it reads', () => {
        expect(read(`/r/${LINK_ID}`, `#%36${ROOM_ID.slice(1)}.${KEY}`)).toEqual({ error: 'incomplete' });
        expect(read(`/r/${LINK_ID}`, `#${ROOM_ID}%2E${KEY}`)).toEqual({ error: 'incomplete' });
    });

    it('the key alone, or a key where the room goes, is incomplete', () => {
        expect(read(`/r/${LINK_ID}`, `#${KEY}`)).toEqual({ error: 'incomplete' });
        expect(read(`/r/${LINK_ID}`, `#.${KEY}`)).toEqual({ error: 'incomplete' });
        expect(read(`/r/${LINK_ID}`, `#${KEY}.${ROOM_ID}`)).toEqual({ error: 'incomplete' });
    });

    it("a share link's fragment stays out, keyed or not", () => {
        expect(read(`/r/${LINK_ID}`, `#k=${KEY}&room=${ROOM_ID}`)).toEqual({ error: 'incomplete' });
    });

    // A key moved into the query cannot be read, and the fragment beside it must not then
    // pass as a bare link. Twin of the same rule in ParseRequestLink, cli/engine/code.
    it('a k in the query refuses the link, whatever the fragment holds', () => {
        for (const search of [`?k=${KEY}`, `?s=1&k=${KEY}`, '?k=', '?K=1', '?%6B=1', '?%20k=1', '?+k=1']) {
            expect(read(`/r/${LINK_ID}`, `#${ROOM_ID}`, search), search).toEqual({ error: 'incomplete' });
            expect(read(`/r/${LINK_ID}`, `#${ROOM_ID}.${KEY}`, search), search).toEqual({ error: 'incomplete' });
        }
    });

    it('a query with no k changes nothing, and a longer name is not k', () => {
        for (const search of ['', '?', '?s=deadbeef', '?kk=1', '?room=x']) {
            expect(read(`/r/${LINK_ID}`, `#${ROOM_ID}.${KEY}`, search), search).toEqual({
                linkId: LINK_ID,
                roomId: ROOM_ID,
                key: KEY,
            });
        }
    });
});

// The Go parser and this one over one file, cli/engine/code/testdata/link-shapes.json. A
// row where the two differ names its finding, which Go's test requires. This reader takes
// the raw hash and search of new URL(input), as a page reads its own location.
describe('link-shapes.json: what this reader makes of a pasted request link', () => {
    const SHAPES = JSON.parse(
        readFileSync(new URL('../../../cli/engine/code/testdata/link-shapes.json', import.meta.url), 'utf8'),
    ) as {
        rows: Array<{
            name: string;
            kind: string;
            input: string;
            outcome: string;
            room?: string;
            key?: string;
            linkId?: string;
            tsOutcome?: string;
        }>;
    };
    const rows = SHAPES.rows.filter((row) => row.kind === 'request');

    it('holds the rows', () => expect(rows.length).toBeGreaterThan(20));

    for (const row of rows) {
        it(row.name, () => {
            const url = new URL(row.input);
            const want = row.tsOutcome ?? row.outcome;
            const got = read(url.pathname, url.hash, url.search);
            if (want === 'ok') {
                expect(got).toEqual({ linkId: row.linkId, roomId: row.room, key: row.key ?? null });
            } else {
                expect(got).toEqual({ error: 'incomplete' });
            }
        });
    }
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
