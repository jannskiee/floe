/**
 * Browser-extension stack frames.
 *
 * Extensions inject content scripts into every page they run on, so an
 * unhandled rejection thrown inside one is captured by Sentry's global
 * handlers and reported as if it came from Floe. MetaMask does exactly this
 * (FLOE-E) on a site with no web3 code at all:
 *
 *   chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js
 *
 * The message wording is useless as a filter - every extension words its
 * failures differently, and Sentry's `ignoreErrors` only ever tests the LAST
 * exception value anyway. The frame's URL scheme is the one reliable signal
 * that the code is not ours, so that is what we match on.
 *
 * These patterns feed `denyUrls`, which the EventFilters integration evaluates
 * FIRST in the event pipeline. That ordering is the whole point, and it is why
 * this check cannot live in `beforeSend`: @sentry/nextjs's
 * NextjsClientStackFrameNormalization integration runs later and rewrites every
 * frame's origin to "app://", so by the time `beforeSend` sees the event the
 * scheme is gone and the extension frame reads `app:///scripts/inpage.js` -
 * indistinguishable from our own code. Verified in a real browser: the same
 * event carries the chrome-extension:// filename before the processors run and
 * app:/// by the time it reaches the transport. See
 * browserExtensions.pipeline.test.ts.
 *
 * That same rewrite is why Sentry's server-side "browser extensions" inbound
 * filter cannot help here: Relay matches stack-frame abs_path against
 * `^chrome(-extension)?://` and the SDK has already erased it client-side.
 *
 * The list mirrors Relay's own EXTENSION_EXC_SOURCES minus `webkit-masked-url`,
 * which Safari also uses for blob and eval'd first-party scripts and so is not
 * an unambiguous signal.
 *
 * Deliberately no `g` or `y` flags: Sentry calls `.test()` on these same
 * instances for every event, and a sticky flag would advance `lastIndex` and
 * make the filter fire on only every other event.
 */
export const BROWSER_EXTENSION_URL_PATTERNS: RegExp[] = [
    // Chrome, Edge, Brave, Opera. The optional group also denies bare
    // chrome:// internal pages, which are equally unfixable from app code.
    /^chrome(-extension)?:\/\//i,
    // Firefox
    /^moz-extension:\/\//i,
    // Safari. Deliberately no "//": extractSafariExtensionDetails in
    // @sentry/browser's stack parser string-prepends `safari-extension:` onto
    // whatever path its regex captured, so an authority is not guaranteed.
    /^safari(-web)?-extension:/i,
];
