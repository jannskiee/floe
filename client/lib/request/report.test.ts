import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    configuredReportAddress,
    reportAddressFor,
    reportMailto,
    reportMailtoFromLocation,
    REQUEST_REPORT_ADDRESS,
} from './report';
import { E2E_REPORT_EMAIL } from '../../e2e/report-email';

// "Report this link" carries the link id and the origin, never the room id or
// the fragment (spec 07 4.16, 08 13.1 item 2). The visitor's mail provider sees
// the link id, which is not secret; the room id is the capability and stays in
// the page.
//
// Where the report goes depends on whose page it is (the owner's decision of
// 2026-10-14). floe.one's own origins write to the built-in address. Any other
// origin is someone else's server, whose links the maintainer cannot act on:
// it writes to the address its operator set in REQUEST_REPORT_EMAIL, and with
// none set, or one that is not a single plain address, the page has no link.

const LINK = 'Ab3dE_f9-xY';
const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const OPERATOR = 'reports@example.org';
const SELF_HOSTED = 'https://files.example.org';
const FLOE_ORIGINS = ['https://www.floe.one', 'https://floe.one'];

/** Values an operator could set that are one plain address. */
const PLAIN_ADDRESSES = [
    OPERATOR,
    'abuse+floe@files.example.org',
    'First.Last_2-x@mail.example.co.uk',
    'a@b.c',
    // Exactly the 254 characters an address may have.
    `${'a'.repeat(64)}@${'b'.repeat(185)}.org`,
];

/** Values that are not one plain address. Each one is refused whole: nothing
 *  is trimmed or repaired, so none of these characters can reach a mailto. */
const NOT_AN_ADDRESS: Array<[string, string]> = [
    ['an empty string', ''],
    ['only spaces', '   '],
    ['a second address after a comma', 'a@example.org,b@example.org'],
    ['a second address after a semicolon', 'a@example.org;b@example.org'],
    ['a second address after a space', 'a@example.org b@example.org'],
    ['a trailing newline', 'a@example.org\n'],
    ['a leading newline', '\na@example.org'],
    ['a second line', 'a@example.org\r\nBcc: b@example.org'],
    ['an encoded line break', 'a@example.org%0ABcc:b@example.org'],
    ['an encoded line break in lower case', 'a@example.org%0d%0abcc:b@example.org'],
    ['a cc field', 'a@example.org?cc=b@example.org'],
    ['a second field', 'a@example.org&cc=b@example.org'],
    ['a subject of its own', 'a@example.org?subject=x'],
    ['a percent sign', 'a%40b@example.org'],
    ['a script tag', '<script>alert(1)</script>@example.org'],
    ['an attribute break', '"><img src=x onerror=alert(1)>@example.org'],
    ['a name with angle brackets', 'Reports <a@example.org>'],
    ['a leading space', ' a@example.org'],
    ['a trailing space', 'a@example.org '],
    ['a tab', 'a@example.org\t'],
    ['a mailto scheme', 'mailto:a@example.org'],
    ['a fragment', 'a@example.org#x'],
    ['a path', 'a@example.org/x'],
    ['no @', 'reports.example.org'],
    ['two @', 'a@b@example.org'],
    ['nothing before the @', '@example.org'],
    ['nothing after the @', 'a@'],
    ['a host with no dot', 'a@localhost'],
    ['a host that starts with a dot', 'a@.example.org'],
    ['a host that ends with a dot', 'a@example.org.'],
    ['an empty host label', 'a@example..org'],
    ['an underscore in the host', 'a@exa_mple.org'],
    ['a letter outside ASCII', 'r\u00e9ports@example.org'],
    ['a quoted name', '"a b"@example.org'],
    ['300 characters', `${'a'.repeat(288)}@example.org`],
    ['255 characters', `${'a'.repeat(64)}@${'b'.repeat(186)}.org`],
];

function parts(mailto: string) {
    const [to, query] = mailto.slice('mailto:'.length).split('?');
    const params = new URLSearchParams(query);
    return { to, subject: params.get('subject'), body: params.get('body') };
}

describe('report this link', () => {
    it('mailto carries the linkId only', () => {
        const m = reportMailto('https://floe.one', LINK, null);
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
        // On floe.one and on another server alike.
        for (const [origin, configured] of [
            ['https://floe.one', null],
            [SELF_HOSTED, OPERATOR],
        ] as const) {
            const loc = {
                origin,
                pathname: `/r/${LINK}`,
                get hash(): string {
                    throw new Error('hash read');
                },
                get href(): string {
                    throw new Error('href read');
                },
            };
            const m = reportMailtoFromLocation(loc, configured);
            expect(m, origin).not.toBeNull();
            const text = decodeURIComponent(m as string);
            expect(text).not.toContain(ROOM);
            expect(text).not.toContain('#');
            expect(m).not.toContain('%23');
            expect(m).not.toContain(ROOM);
            // A path that is not a link produces no report link at all.
            expect(reportMailtoFromLocation({ origin, pathname: '/r/short' }, configured)).toBeNull();
            expect(reportMailtoFromLocation({ origin, pathname: `/r/${LINK}/extra` }, configured)).toBeNull();
            // A link id is never taken from anywhere but the path shape.
            expect(reportMailto(origin, `${LINK}#${ROOM}`, configured)).toBeNull();
            // An origin that is not a plain http origin is refused.
            expect(reportMailto('null', LINK, configured)).toBeNull();
            expect(reportMailto(`${origin}/r/${LINK}#${ROOM}`, LINK, configured)).toBeNull();
        }
    });

    it('the subject is fixed text plus the linkId', () => {
        for (const id of [LINK, 'AAAAAAAAAAA', '___________']) {
            const { subject } = parts(reportMailto('http://localhost:3000', id, OPERATOR) as string);
            expect(subject).toBe('Report Floe request link ' + id);
        }
        // A self-hosted origin is carried as is.
        const { body } = parts(reportMailto(SELF_HOSTED, LINK, OPERATOR) as string);
        expect(body).toBe(`Link: ${SELF_HOSTED}/r/${LINK}`);
    });

    it('the address is the one SECURITY.md and CODE_OF_CONDUCT.md publish', () => {
        // OD-23, D-152: the owner chose the address the repository already
        // publishes for security and conduct reports. Pinned against both
        // files, so the three cannot drift apart.
        expect(REQUEST_REPORT_ADDRESS).toBe('paredesjancarlo99@gmail.com');
        const security = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8');
        expect(security).toContain(`Send the details to ${REQUEST_REPORT_ADDRESS}.`);
        const conduct = readFileSync(new URL('../../../CODE_OF_CONDUCT.md', import.meta.url), 'utf8');
        expect(conduct).toContain(REQUEST_REPORT_ADDRESS);
    });
});

describe('where a report goes', () => {
    it('floe.one writes to the built-in address, whatever is configured', () => {
        const configured = [undefined, null, '', OPERATOR, ...NOT_AN_ADDRESS.map(([, value]) => value)];
        for (const origin of FLOE_ORIGINS) {
            for (const value of configured) {
                const m = reportMailto(origin, LINK, value);
                expect(m, `${origin} with ${JSON.stringify(value)}`).not.toBeNull();
                expect(parts(m as string).to).toBe(REQUEST_REPORT_ADDRESS);
                expect(reportAddressFor(origin, value), `${origin} with ${JSON.stringify(value)}`).toBe(
                    REQUEST_REPORT_ADDRESS,
                );
            }
        }
    });

    it('another origin writes to the address its operator configured', () => {
        for (const origin of [SELF_HOSTED, 'http://localhost:3000', 'http://192.168.1.10:3000']) {
            for (const address of PLAIN_ADDRESSES) {
                const m = reportMailto(origin, LINK, address) as string;
                expect(m.startsWith(`mailto:${address}?subject=`), `${origin} with ${address}`).toBe(true);
                // The address is the whole recipient, and it added no field.
                expect(parts(m).to).toBe(address);
                expect([...new URLSearchParams(m.split('?')[1]).keys()]).toEqual(['subject', 'body']);
                expect(m.split('?')).toHaveLength(2);
                expect(m).not.toContain(REQUEST_REPORT_ADDRESS);
                expect(reportAddressFor(origin, address)).toBe(address);
            }
        }
        // The same answer from the page's own location.
        const m = reportMailtoFromLocation({ origin: SELF_HOSTED, pathname: `/r/${LINK}` }, OPERATOR);
        expect(parts(m as string).to).toBe(OPERATOR);
    });

    it('another origin with no address configured has no report link', () => {
        for (const origin of [SELF_HOSTED, 'http://localhost:3000']) {
            for (const none of [undefined, null, '']) {
                expect(reportMailto(origin, LINK, none)).toBeNull();
                expect(reportMailtoFromLocation({ origin, pathname: `/r/${LINK}` }, none)).toBeNull();
                expect(reportAddressFor(origin, none)).toBeNull();
            }
        }
    });

    it('a configured value that is not one plain address counts as not configured', () => {
        for (const [what, value] of NOT_AN_ADDRESS) {
            expect(reportMailto(SELF_HOSTED, LINK, value), what).toBeNull();
            expect(reportMailtoFromLocation({ origin: SELF_HOSTED, pathname: `/r/${LINK}` }, value), what).toBeNull();
            expect(reportAddressFor(SELF_HOSTED, value), what).toBeNull();
            expect(configuredReportAddress(value), what).toBeNull();
        }
        // A value that is not a string at all, which the prop's type rules out
        // and nothing else does.
        for (const value of [42, true, {}, [OPERATOR], { toString: () => OPERATOR }]) {
            expect(reportMailto(SELF_HOSTED, LINK, value as never), JSON.stringify(value)).toBeNull();
            expect(configuredReportAddress(value as never), JSON.stringify(value)).toBeNull();
        }
    });

    it('a plain address is handed back unchanged', () => {
        for (const address of PLAIN_ADDRESSES) expect(configuredReportAddress(address)).toBe(address);
        expect(PLAIN_ADDRESSES[PLAIN_ADDRESSES.length - 1]).toHaveLength(254);
    });

    it('only the two floe.one origins get the built-in address', () => {
        // Exact matches of location.origin. Anything near them is another
        // server and answers with its own setting, or with no link.
        for (const origin of [
            'http://floe.one',
            'http://www.floe.one',
            'https://floe.one:8443',
            'https://api.floe.one',
            'https://docs.floe.one',
            'https://floe.one.example.org',
            'https://www.floe.one.example.org',
            'https://notfloe.one',
            'https://floe.one@example.org',
            'https://WWW.FLOE.ONE',
        ]) {
            expect(reportMailto(origin, LINK, null), origin).toBeNull();
            expect(reportAddressFor(origin, null), origin).toBeNull();
            expect(reportAddressFor(origin, OPERATOR), origin).toBe(OPERATOR);
        }
    });
});

describe('the e2e report address', () => {
    // e2e/report-email.ts. The suite's pages are on localhost, so the link two
    // specs look for is drawn only while the client Playwright starts is given
    // an address that passes the check above. It lives here because vitest
    // reads lib/ and app/ only (see lib/e2eSocketUrl.test.ts).
    it('is one plain address on a reserved domain, and is what the config starts the client with', () => {
        expect(configuredReportAddress(E2E_REPORT_EMAIL)).toBe(E2E_REPORT_EMAIL);
        // example.org has no mailbox behind it (RFC 2606).
        expect(E2E_REPORT_EMAIL.endsWith('@example.org')).toBe(true);
        expect(E2E_REPORT_EMAIL).not.toBe(REQUEST_REPORT_ADDRESS);
        const config = readFileSync(new URL('../../playwright.config.ts', import.meta.url), 'utf8');
        expect(config).toContain('REQUEST_REPORT_EMAIL: E2E_REPORT_EMAIL,');
    });
});
