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
];
