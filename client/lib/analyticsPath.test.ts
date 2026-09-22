import { describe, it, expect } from 'vitest';
import { loadsUmami } from './analyticsPath';

const LINK_ID = 'Ab3dE_f9-xY';

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
