import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards the response-header policy in next.config.mjs.
 *
 * Read as TEXT, not imported, for the same reason lib/serviceWorker.test.ts
 * reads public/sw.js as text: importing next.config.mjs would pull in
 * withSentryConfig and the whole Next SDK inside a vitest that runs with
 * environment: 'node', and client/vitest.config.ts collects only lib/ and app/
 * route handlers precisely because nothing here may load Next.
 *
 * What this file can and cannot prove: it proves the SHAPE of the config Next
 * freezes into routes-manifest.json at build time (which entries exist, in what
 * order, carrying which keys). It cannot prove what a server puts on the wire.
 * That is what the Playwright assertion in e2e/request-privacy.spec.ts and the
 * curl check against `next start` are for, and neither replaces the other: the
 * order below is the whole mechanism by which the served value comes out right.
 */
const CONFIG = readFileSync(
    fileURLToPath(new URL('../next.config.mjs', import.meta.url)),
    'utf8'
);

// Everything below concerns headers() alone. redirects() further down the file
// declares a second `source: '/:path*'` for the docs.floe.one host, and the big
// comment above headers() names connect-src and worker-src in prose, so both a
// naive indexOf and a naive "the file must not contain worker-src" would be
// reading the wrong text.
const HEADERS_BLOCK = (() => {
    const start = CONFIG.indexOf('async headers()');
    const end = CONFIG.indexOf('async rewrites()');
    if (start < 0 || end <= start) {
        throw new Error('next.config.mjs no longer has a headers() block before rewrites()');
    }
    return CONFIG.slice(start, end);
})();

/** The text of one headers() entry: from its `source:` line up to the next one
 *  (or the end of the block), which is enough to say what keys it sets. */
function entry(source: string): string {
    const marker = `source: '${source}'`;
    const i = HEADERS_BLOCK.indexOf(marker);
    if (i < 0) throw new Error(`no headers() entry for ${source}`);
    const rest = HEADERS_BLOCK.slice(i + marker.length);
    const next = rest.indexOf('source:');
    return next === -1 ? rest : rest.slice(0, next);
}

function indexOfSource(source: string): number {
    return HEADERS_BLOCK.indexOf(`source: '${source}'`);
}

describe('next.config.mjs headers()', () => {
    it('the /r no-referrer entries come after the /:path* entry', () => {
        // Next applies matching entries in order and the LAST one wins for a
        // repeated key, so this ordering is not cosmetic: reversed, /r would
        // keep the site-wide strict-origin-when-cross-origin and the link id in
        // the path would travel to every origin the visitor clicks through to.
        const sitewide = indexOfSource('/:path*');
        const bare = indexOfSource('/r');
        const under = indexOfSource('/r/:path*');

        expect(sitewide).toBeGreaterThan(-1);
        expect(bare).toBeGreaterThan(sitewide);
        expect(under).toBeGreaterThan(sitewide);

        // Both /r entries, and both carrying only the one key. The site-wide
        // entry above still supplies the CSP, X-Frame-Options, nosniff and the
        // permissions policy for /r.
        for (const source of ['/r', '/r/:path*']) {
            const text = entry(source);
            expect(text).toContain("key: 'Referrer-Policy'");
            expect(text).toContain("value: 'no-referrer'");
            expect(text).not.toContain('Content-Security-Policy');
            expect(text).not.toContain('X-Frame-Options');
            expect(text).not.toContain('Permissions-Policy');
        }

        // And the site-wide entry still declares the policy it always did, so
        // "the last one wins" has something to win against.
        expect(entry('/:path*')).toContain("value: 'strict-origin-when-cross-origin'");

        // Both live in the unconditional part of the array, before the
        // development-only spread, or production would not send them at all.
        const devSpread = HEADERS_BLOCK.indexOf("process.env.NODE_ENV === 'development'");
        expect(devSpread).toBeGreaterThan(-1);
        expect(bare).toBeLessThan(devSpread);
        expect(under).toBeLessThan(devSpread);
    });

    it('the site CSP value is unchanged and has no worker-src or connect-src', () => {
        // Adding either directive here would have to allow blob:, or the fflate
        // ZIP worker and the ZIP download stop working. The /r page must not
        // tempt anyone into tightening it: there is exactly one CSP on the site,
        // it applies to /r through the /:path* entry, and this is its value.
        const csps = [
            ...HEADERS_BLOCK.matchAll(
                /key:\s*'Content-Security-Policy',\s*value:\s*"([^"]*)"/g
            ),
        ];
        expect(csps).toHaveLength(1);

        const value = csps[0][1];
        expect(value).toBe(
            "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
        );
        expect(value).not.toContain('worker-src');
        expect(value).not.toContain('connect-src');
        expect(value).not.toContain('script-src');
    });
});
