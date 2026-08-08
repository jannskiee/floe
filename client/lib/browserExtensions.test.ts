import { describe, it, expect } from 'vitest';
import { BROWSER_EXTENSION_URL_PATTERNS } from './browserExtensions';

// Sentry applies `denyUrls` by testing every pattern against ONE frame filename
// (`_isDeniedUrl` -> `stringMatchesSomePattern` in @sentry/core), so the unit
// under test is "does any pattern match this string", not any single regex.
const isExtensionUrl = (url: string): boolean =>
    BROWSER_EXTENSION_URL_PATTERNS.some((pattern) => pattern.test(url));

// The exact filename from FLOE-E. `nkbihfbeogaeaoehlefnkodbefgpgknn` is
// MetaMask's extension id and `scripts/inpage.js` is the script it injects into
// every page, including pages that never touch a wallet.
const METAMASK_INPAGE_URL = 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js';

describe('BROWSER_EXTENSION_URL_PATTERNS', () => {
    it("matches MetaMask's injected content script (FLOE-E)", () => {
        expect(isExtensionUrl(METAMASK_INPAGE_URL)).toBe(true);
    });

    it('matches Chromium extension and internal-page schemes', () => {
        expect(isExtensionUrl('chrome-extension://gighmmpiobklfepjocnamgkkbiglidom/adblock.js')).toBe(true);
        expect(isExtensionUrl('chrome://newtab/')).toBe(true);
    });

    it('matches Firefox moz-extension frames', () => {
        expect(isExtensionUrl('moz-extension://d0a2b1c3-4e5f-6789-abcd-ef0123456789/content.js')).toBe(true);
    });

    it('matches both Safari forms the SDK re-prefixes frames with', () => {
        // extractSafariExtensionDetails in @sentry/browser's stack parser
        // prepends the scheme onto whatever path its regex captured, so the
        // "//authority" part is not guaranteed to be present. That is why this
        // pattern anchors on the colon rather than on "://".
        expect(isExtensionUrl('safari-web-extension://ABC12345-1234-1234-1234-1234567890AB/content.js')).toBe(true);
        expect(isExtensionUrl('safari-extension://com.apple.Safari.Extension-ABC123/js/inject.js')).toBe(true);
        expect(isExtensionUrl('safari-extension:/js/inject.js')).toBe(true);
    });

    it('matches regardless of scheme casing', () => {
        expect(isExtensionUrl('Chrome-Extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js')).toBe(true);
        expect(isExtensionUrl('MOZ-EXTENSION://d0a2b1c3/content.js')).toBe(true);
    });

    it('never matches Floe production or Vercel preview bundles', () => {
        expect(isExtensionUrl('https://www.floe.one/_next/static/chunks/page-abc.js')).toBe(false);
        expect(isExtensionUrl('https://floe.one/_next/static/chunks/main-app-9f2c1b8e.js')).toBe(false);
        expect(
            isExtensionUrl('https://p2p-file-share-git-fix-abc123-floe.vercel.app/_next/static/chunks/layout.js')
        ).toBe(false);
        expect(isExtensionUrl('http://localhost:3000/_next/static/chunks/page.js')).toBe(false);
    });

    it('never matches normalized app:/// frames', () => {
        // app:/// is what NextjsClientStackFrameNormalization rewrites our OWN
        // frames to. If any pattern matched that prefix we would silently stop
        // reporting every production error. `app:///scripts/inpage.js` is here
        // on purpose: it is what the MetaMask frame becomes AFTER the rewrite,
        // and it must not match - which is exactly why the filter has to run
        // before the rewrite. See browserExtensions.pipeline.test.ts.
        expect(isExtensionUrl('app:///_next/static/chunks/page-9f2c1b8e4d.js')).toBe(false);
        expect(isExtensionUrl('app:///scripts/inpage.js')).toBe(false);
    });

    it('never matches blob: or data: frames', () => {
        // fflate's `zip` (hooks/useDownloadManager.ts) boots a worker from a
        // blob: URL, so genuine in-app errors really can carry blob frames.
        expect(isExtensionUrl('blob:https://www.floe.one/2f8a5f6c-1b7d-4a3e-9c2f-8d1e5a6b7c90')).toBe(false);
        expect(isExtensionUrl('data:text/javascript;base64,Y29uc29sZS5sb2coMSk=')).toBe(false);
    });

    it('never matches an extension scheme appearing later in the URL', () => {
        // Proves the ^ anchor. /docs is reverse-proxied to Mintlify
        // (next.config.mjs), so arbitrary paths do reach frame filenames.
        expect(isExtensionUrl('https://www.floe.one/docs/chrome-extension://guide')).toBe(false);
        expect(isExtensionUrl('https://www.floe.one/blog/moz-extension://x')).toBe(false);
    });

    it('carries no stateful regex flags (Sentry reuses these instances)', () => {
        for (const pattern of BROWSER_EXTENSION_URL_PATTERNS) {
            expect(pattern.global).toBe(false);
            expect(pattern.sticky).toBe(false);
        }
        // Same instances, tested twice, must agree.
        expect(isExtensionUrl(METAMASK_INPAGE_URL)).toBe(true);
        expect(isExtensionUrl(METAMASK_INPAGE_URL)).toBe(true);
    });
});
