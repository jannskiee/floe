import { describe, it, expect } from 'vitest';
import { reportMailto, reportMailtoFromLocation, REQUEST_REPORT_ADDRESS } from './report';

// "Report this link" carries the link id and the origin, never the room id or
// the fragment (spec 07 4.16, 08 13.1 item 2). The visitor's mail provider sees
// the link id, which is not secret; the room id is the capability and stays in
// the page.

const LINK = 'Ab3dE_f9-xY';
const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

function parts(mailto: string) {
    const [to, query] = mailto.slice('mailto:'.length).split('?');
    const params = new URLSearchParams(query);
    return { to, subject: params.get('subject'), body: params.get('body') };
}

describe('report this link', () => {
    it('mailto carries the linkId only', () => {
        const m = reportMailto('https://floe.one', LINK);
        expect(m).not.toBeNull();
        const { to, subject, body } = parts(m as string);
        expect(to).toBe(REQUEST_REPORT_ADDRESS);
        expect(subject).toBe(`Report Floe request link ${LINK}`);
        expect(body).toBe(`Link: https://floe.one/r/${LINK}`);
        // Exactly the two keys, nothing else riding along.
        expect([...new URLSearchParams((m as string).split('?')[1]).keys()]).toEqual(['subject', 'body']);
    });

    it('mailto never contains a fragment or the room id', () => {
        // Built from a location whose hash and href would leak the room if
        // they were ever read: both throw, so reading either fails the test.
        const loc = {
            origin: 'https://floe.one',
            pathname: `/r/${LINK}`,
            get hash(): string {
                throw new Error('hash read');
            },
            get href(): string {
                throw new Error('href read');
            },
        };
        const m = reportMailtoFromLocation(loc);
        expect(m).not.toBeNull();
        const text = decodeURIComponent(m as string);
        expect(text).not.toContain(ROOM);
        expect(text).not.toContain('#');
        expect(m).not.toContain('%23');
        expect(m).not.toContain(ROOM);
        // A path that is not a link produces no report link at all.
        expect(reportMailtoFromLocation({ origin: 'https://floe.one', pathname: '/r/short' })).toBeNull();
        expect(reportMailtoFromLocation({ origin: 'https://floe.one', pathname: `/r/${LINK}/extra` })).toBeNull();
        // A link id is never taken from anywhere but the path shape.
        expect(reportMailto('https://floe.one', `${LINK}#${ROOM}`)).toBeNull();
        // An origin that is not a plain http origin is refused.
        expect(reportMailto('null', LINK)).toBeNull();
        expect(reportMailto(`https://floe.one/r/${LINK}#${ROOM}`, LINK)).toBeNull();
    });

    it('the subject is fixed text plus the linkId', () => {
        for (const id of [LINK, 'AAAAAAAAAAA', '___________']) {
            const { subject } = parts(reportMailto('http://localhost:3000', id) as string);
            expect(subject).toBe('Report Floe request link ' + id);
        }
        // A self-hosted origin is carried as is.
        const { body } = parts(reportMailto('https://files.example.org', LINK) as string);
        expect(body).toBe(`Link: https://files.example.org/r/${LINK}`);
    });

    it('the address is the placeholder until the owner supplies one', () => {
        // OD-23: replaced at Phase F by the release checklist row part 06 owns.
        expect(REQUEST_REPORT_ADDRESS).toBe('request-link-reports@example.invalid');
    });
});
