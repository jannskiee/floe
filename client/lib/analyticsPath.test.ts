import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UMAMI_BEFORE_SEND, loadsUmami, umamiBeforeSend, umamiPayloadAllowed } from './analyticsPath';

const LINK_ID = 'Ab3dE_f9-xY';
const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

/** A pageview as the live cloud.umami.is script builds it: url is the absolute
 *  page URL with the hash and search already stripped (the two exclude flags),
 *  referrer is the previous page's path on the same origin, or the whole URL
 *  from another one, or '' on a direct visit. */
function pageview(url: string, referrer = '') {
    return {
        website: '00000000-0000-4000-8000-000000000000',
        screen: '1280x720',
        language: 'en-US',
        title: 'Send files - Floe',
        hostname: 'floe.one',
        url,
        referrer,
    };
}

describe('umamiPayloadAllowed', () => {
    it('lets ordinary pageviews through', () => {
        expect(umamiPayloadAllowed(pageview('https://floe.one/'))).toBe(true);
        expect(umamiPayloadAllowed(pageview('https://floe.one/privacy', '/'))).toBe(true);
        expect(umamiPayloadAllowed(pageview('https://floe.one/download', 'https://t.co/x1'))).toBe(true);
        expect(umamiPayloadAllowed({ ...pageview('https://floe.one/'), name: 'nav-download' })).toBe(true);
    });

    it('drops the Back pageview the CP-QA audit captured (F3-02)', () => {
        // /r, Privacy, Back with a soft navigation: the tracker loaded by
        // /privacy reported the /r page and then used it as the referrer.
        expect(umamiPayloadAllowed(pageview(`http://127.0.0.1:64805/r/${LINK_ID}`, '/privacy'))).toBe(false);
        expect(umamiPayloadAllowed(pageview('http://127.0.0.1:64805/terms', `/r/${LINK_ID}`))).toBe(false);
    });

    it('drops every shape of a /r url or referrer', () => {
        for (const path of [
            `/r/${LINK_ID}`,
            `/r/${LINK_ID}/`,
            `/r/${LINK_ID}#${ROOM_ID}`,
            `/r/${LINK_ID}?x=1`,
            `/R/${LINK_ID}`,
            `/%72/${LINK_ID}`,
            `/r%2F${LINK_ID}`,
            '/r',
            '/r/',
        ]) {
            expect(umamiPayloadAllowed(pageview(`https://floe.one${path}`)), `url ${path}`).toBe(false);
            expect(umamiPayloadAllowed(pageview('https://floe.one/', path)), `referrer ${path}`).toBe(false);
            expect(
                umamiPayloadAllowed(pageview('https://floe.one/', `https://www.floe.one${path}`)),
                `absolute referrer ${path}`
            ).toBe(false);
        }
    });

    it('judges a referrer only from a Floe host, and a page url from anywhere', () => {
        // A link id can only be a same-site referrer: after a soft navigation
        // Umami's referrer is the previous in-app URL, a same-origin path, and
        // /r sends no referrer at all (Referrer-Policy no-referrer). A /r path
        // on another site is that site's page.
        for (const referrer of [
            'https://www.reddit.com/r/programming/comments/1abc/floe/',
            'https://old.reddit.com/r/selfhosted',
            'https://example.com/%72/x',
        ]) {
            expect(umamiPayloadAllowed(pageview('https://floe.one/', referrer)), referrer).toBe(true);
        }
        // floe.one, apex and www, from either one.
        for (const [page, referrer] of [
            ['https://floe.one/download', `https://floe.one/r/${LINK_ID}`],
            ['https://floe.one/download', `https://www.floe.one/r/${LINK_ID}`],
            ['https://www.floe.one/download', `https://floe.one/r/${LINK_ID}`],
            ['https://floe.one/download', `http://WWW.FLOE.ONE/r/${LINK_ID}`],
        ]) {
            expect(umamiPayloadAllowed(pageview(page, referrer)), `${page} from ${referrer}`).toBe(false);
        }
        // A self-hosted Floe: the page's own host, from its url or its hostname.
        const selfHosted = { ...pageview('https://send.example.org/', `https://send.example.org/r/${LINK_ID}`) };
        expect(umamiPayloadAllowed({ ...selfHosted, hostname: 'send.example.org' })).toBe(false);
        expect(umamiPayloadAllowed({ ...selfHosted, hostname: undefined })).toBe(false);
        expect(
            umamiPayloadAllowed({ ...pageview('/', `https://send.example.org/r/${LINK_ID}`), hostname: 'send.example.org' })
        ).toBe(false);
        // The page url itself is judged from any origin, as before.
        expect(umamiPayloadAllowed(pageview(`https://mirror.example/r/${LINK_ID}`))).toBe(false);
    });

    it('lets /rx, /relay and /robots.txt through, as loadsUmami does', () => {
        for (const path of ['/rx/abc', '/relay', '/robots.txt', '/r-archive']) {
            expect(umamiPayloadAllowed(pageview(`https://floe.one${path}`, path)), path).toBe(true);
        }
    });

    it('drops what it cannot read', () => {
        // Failing closed, as loadsUmami does: a dropped pageview costs
        // nothing, a link id in an analytics record cannot be taken back.
        expect(umamiPayloadAllowed(undefined)).toBe(false);
        expect(umamiPayloadAllowed(null)).toBe(false);
        expect(umamiPayloadAllowed('https://floe.one/')).toBe(false);
        expect(umamiPayloadAllowed({ ...pageview('https://floe.one/'), url: 42 })).toBe(false);
        expect(umamiPayloadAllowed({ ...pageview('https://floe.one/'), referrer: ['/r/x'] })).toBe(false);
        expect(umamiPayloadAllowed(pageview('https://floe.one/%E0%A4%A'))).toBe(false);
        // A referrer whose host cannot be read cannot be ruled out as Floe's.
        expect(umamiPayloadAllowed(pageview('https://floe.one/', `http://[floe.one/r/${LINK_ID}`))).toBe(false);
    });
});

describe('umamiBeforeSend', () => {
    it('returns the payload itself to send it and false to drop it', () => {
        const kept = pageview('https://floe.one/privacy');
        expect(umamiBeforeSend('event', kept)).toBe(kept);
        expect(umamiBeforeSend('event', pageview(`https://floe.one/r/${LINK_ID}`))).toBe(false);
        expect(umamiBeforeSend('identify', pageview('https://floe.one/', `/r/${LINK_ID}`))).toBe(false);
    });

    it('is the hook UmamiScript names, installed under that name', () => {
        // The tracker looks the hook up on window by the data-before-send name
        // before every send, and sends everything when there is no function
        // there, so a renamed global would switch the filter off silently.
        const src = readFileSync(
            fileURLToPath(new URL('../components/UmamiScript.tsx', import.meta.url)),
            'utf8'
        );
        // Whole code lines, so a line commented out with // fails; substring
        // checks passed with both lines commented out.
        expect(src).toMatch(/^\s+data-before-send=\{UMAMI_BEFORE_SEND\}\r?$/m);
        const install =
            /^\s+\(window as unknown as Record<string, unknown>\)\[UMAMI_BEFORE_SEND\] = umamiBeforeSend;\r?$/m.exec(src);
        expect(install, 'the window install').not.toBeNull();
        // At module scope, ahead of the component: it runs when the module
        // loads, before any render can append the script.
        expect(install?.index ?? Infinity).toBeLessThan(src.indexOf('export function UmamiScript'));
        expect(UMAMI_BEFORE_SEND).toMatch(/^[A-Za-z_$][\w$]*$/);
    });
});

describe('loadsUmami', () => {
    it('loads on /, /download and /privacy', () => {
        expect(loadsUmami('/')).toBe(true);
        expect(loadsUmami('/download')).toBe(true);
        expect(loadsUmami('/privacy')).toBe(true);
        expect(loadsUmami('/how-it-works')).toBe(true);
    });

    it('does not load on /r, /r/ and /r/<linkId>', () => {
        expect(loadsUmami('/r')).toBe(false);
        expect(loadsUmami('/r/')).toBe(false);
        expect(loadsUmami(`/r/${LINK_ID}`)).toBe(false);
        expect(loadsUmami(`/r/${LINK_ID}/`)).toBe(false);
    });

    it('does not load on /R/<linkId>', () => {
        // Next routes are case-sensitive, so this path does not reach the page.
        // The guard still folds case: its job is to keep the tracker off a
        // family of URLs, whatever reached it with one.
        expect(loadsUmami(`/R/${LINK_ID}`)).toBe(false);
        expect(loadsUmami('/R')).toBe(false);
    });

    it('loads on /rx and /robots.txt', () => {
        expect(loadsUmami('/rx')).toBe(true);
        expect(loadsUmami('/rx/abc')).toBe(true);
        expect(loadsUmami('/robots.txt')).toBe(true);
        expect(loadsUmami('/relay')).toBe(true);
        expect(loadsUmami('/r-archive')).toBe(true);
    });

    it('does not load when there is no pathname', () => {
        // Failing closed: a missing pageview costs nothing, a link id in an
        // analytics record cannot be taken back.
        expect(loadsUmami(null)).toBe(false);
        expect(loadsUmami(undefined)).toBe(false);
        expect(loadsUmami('')).toBe(false);
    });
});
