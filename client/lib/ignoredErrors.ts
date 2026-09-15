/**
 * Non-actionable error messages, fed to Sentry's `ignoreErrors`.
 *
 * Extracted from sentry.client.config.ts so it can be tested at all: that file
 * calls Sentry.init() at module scope, so vitest cannot import it. Same reason
 * browserExtensions.ts holds the denyUrls patterns rather than the config.
 *
 * EventFilters tests every entry against three strings per event, produced by
 * getPossibleEventMessages in @sentry/core: the top-level `event.message`, the
 * LAST exception value, and `"<type>: <value>"` for that same last value. A
 * plain string entry is a case-sensitive SUBSTRING test (`value.includes(pattern)`
 * in isMatchingPattern), so these are fragments rather than whole messages, and
 * they have to keep the wording's original casing.
 *
 * Two properties are worth knowing before adding an entry:
 *
 *   - `ignoreErrors` is the FIRST check in _shouldDropEvent, ahead of
 *     _isUselessError, ahead of _isDeniedUrl, and ahead of `beforeSend`
 *     entirely. Anything matched here never reaches the stale-bundle
 *     re-levelling in sentry.client.config.ts, so the chunk-load wordings in
 *     lib/staleBundle.ts must never become a substring of an entry below.
 *   - Unlike `denyUrls`, this is message-only: _isIgnoredError never reads a
 *     stacktrace. So it is immune to the "app://" frame rewrite that forces
 *     BROWSER_EXTENSION_URL_PATTERNS to run before
 *     NextjsClientStackFrameNormalization (see lib/browserExtensions.ts).
 *
 * Only the LAST exception value is ever tested, so a LinkedErrors cause
 * appended after the matching one would silently disable an entry.
 */
export const IGNORED_ERROR_PATTERNS: (string | RegExp)[] = [
    // Browser extensions (Google Translate, Grammarly, ad blockers) modify the DOM
    // directly, causing React's virtual DOM to desync. Not actionable.
    "Failed to execute 'removeChild' on 'Node'",
    "Failed to execute 'insertBefore' on 'Node'",
    "The node to be removed is not a child of this node",
    // Privacy/anti-fingerprint extensions bridge to native desktop software and
    // reject a promise with a plain object when that bridge is not ready. Surfaces
    // as "Object Not Found Matching Id:N, MethodName:..., ParamCount:N". Not our code.
    'Object Not Found Matching Id',
    // Clipboard blocked in restricted browsers (already handled with fallback)
    'Write permission denied',
    // Safari/iOS ResizeObserver noise
    'ResizeObserver loop',
    // The Facebook in-app browser on Android runs the page inside a WebView
    // whose JS-to-Java bridge is torn down before the page is. Its own injected
    // navigation_performance_logger_android script then posts an INP report
    // from a beforeunload listener, and the bridge answers "Error invoking
    // postMessage: Java object is gone" (FLOE-H). Not our listener and not our
    // code: nothing in this repo calls postMessage at all.
    //
    // denyUrls cannot reach it. @sentry/nextjs had already rewritten every
    // frame, the injected script's included, to app://, and
    // browserExtensions.test.ts deliberately asserts that no denyUrls pattern
    // may match an app:// prefix. A message entry is the only lever left.
    //
    // Sentry ships the sibling wording /^Java exception was raised during
    // method invocation$/ in DEFAULT_IGNORE_ERRORS, credited to the same
    // Facebook mobile browser (sentry-javascript#15065); this one is simply not
    // on that list yet. Matched on the bridge's own words rather than on
    // "Error invoking postMessage", so it also covers the other bridge methods.
    'Java object is gone',
    // A FontFace that failed to load (FLOE-K). Chromium rejects load() with a
    // DOMException carrying the bare NetworkError default text, and a search of
    // Blink finds FontFace to be the only API that rejects with that default and
    // no message of its own. The rejection has no stack, so there is no frame
    // for denyUrls or beforeSend to judge: the words are all there is.
    //
    // Nothing we ship calls FontFace.load() or document.fonts.load(). next/font
    // is build-time CSS, and a CSS @font-face that fails never creates a promise
    // at all. FLOE-K's page logged three FontFace objects to the console just
    // before the rejection, which no code of ours does either.
    //
    // Anchored to the whole message, unlike the fragments above, so text that
    // merely contains it keeps reaching us, such as our own Error wrapping a
    // stringified DOMException. Both shapes Sentry builds from such a rejection
    // still offer this exact string: as the message and value when the
    // DOMException has no stack, as FLOE-K's did, or as "<type>: <value>" when
    // it has one. No g or y flag: Sentry calls .test() on this same instance
    // for every event.
    //
    // This entry is tied to fonts. If we ever call FontFace.load() ourselves, its
    // failures will vanish here too. Safari is deliberately not covered: WebKit's
    // default text starts with a space, so its version reads
    // "NetworkError:  A network error occurred." with two, and none has arrived.
    /^NetworkError: A network error occurred\.$/,
];
