/**
 * Errors thrown by code that was evaluated from a string.
 *
 * A browser extension's content script can schedule work on our page, and when
 * that work throws, Sentry's browserApiErrors integration reports it as ours:
 * the wrapper it installs around setTimeout and addEventListener lives inside
 * our own bundle, so the event carries an app:///_next/... frame and looks
 * first-party. FLOE-F is exactly that, eight events of
 *
 *   TypeError: Cannot read properties of null (reading 'querySelector')
 *     app:///_next/static/chunks/354mhlwzyb0pq.js:5:1818 (n)   <- Sentry's wrapper
 *     <anonymous>:13:28                                        <- the actual throw
 *
 * Neither existing filter can see it. The message is far too generic for
 * ignoreErrors: our own code could legitimately produce that wording one day,
 * and hiding it would be worse than the noise. And denyUrls is structurally
 * blind here, because _getLastValidUrl in @sentry/core skips <anonymous> and
 * [native code] frames on purpose and falls back to the previous one, which is
 * our chunk. That is the gap the FLOE-E fix (lib/browserExtensions.ts) left.
 *
 * So this matches on the shape instead: the frame that actually threw is
 * <anonymous>, meaning eval, new Function, or a script injected with no
 * sourceURL. Nothing we ship evaluates code from a string in a production
 * build, so such a frame is never ours. (Turbopack uses eval in dev only, and
 * fflate's zip worker is a blob: URL, not <anonymous>.)
 *
 * The lineno half of the test is load-bearing, not belt and braces. V8 also
 * emits POSITIONLESS pseudo-frames such as `at new Promise (<anonymous>)`, and
 * one of those really can be the deepest frame of a genuine error: see the
 * fixture at browserExtensions.pipeline.test.ts, which is a real observed
 * stack. Requiring a source position keeps those out.
 *
 * This runs in beforeSend rather than as a filter option, which is safe for the
 * reason lib/browserExtensions.ts:16-25 explains it would NOT be safe there:
 * NextjsClientStackFrameNormalization rewrites frame origins to app:// before
 * beforeSend sees them, but it does that by parsing the filename as a URL, and
 * new URL('<anonymous>') throws, so the frame is left exactly as it was.
 */

// Declared structurally, following lib/scrubUrl.ts, so this module and its
// vitest never load the SDK.
type CheckableFrame = { filename?: string; lineno?: number };
type CheckableException = {
    mechanism?: { parent_id?: number };
    stacktrace?: { frames?: CheckableFrame[] };
};
export type CheckableEvent = { exception?: { values?: CheckableException[] } };

export function isInjectedScriptError(event: CheckableEvent): boolean {
    const values = event.exception?.values;
    if (!values?.length) return false;

    // The same root-exception rule _getEventFilterUrl applies for denyUrls: the
    // last value that is not a linked cause and actually carries frames.
    const root = [...values]
        .reverse()
        .find((value) => value.mechanism?.parent_id === undefined && value.stacktrace?.frames?.length);

    const frames = root?.stacktrace?.frames;
    if (!frames?.length) return false;

    // Sentry stores frames oldest-first, so the throwing frame is the last one.
    const threw = frames[frames.length - 1];
    return threw?.filename === '<anonymous>' && typeof threw.lineno === 'number';
}
