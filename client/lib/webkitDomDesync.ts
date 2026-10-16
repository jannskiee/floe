/**
 * WebKit's wording of the DOM desync a translator or an extension causes.
 *
 * When something outside React (a browser's page translation, an extension)
 * moves or replaces a node React rendered, React's next removeChild or
 * insertBefore on it throws a DOMException named NotFoundError. Chromium words
 * that "Failed to execute 'removeChild' on 'Node': ...", which ignoredErrors.ts
 * already drops. WebKit says only "The object can not be found here.", its
 * sentence for every NotFoundError, so a message entry would also hide a
 * NotFoundError our own code threw. FLOE-P is this shape: two events from
 * Mobile Safari 17.4.1 on 2026-10-05, thrown from [native code] removeChild
 * under React's reconciler (the deep-QA re-check QA-04, 2026-10-16).
 *
 * So this matches the shape instead: the root exception is a NotFoundError and
 * the frame that threw is the native removeChild or insertBefore. Floe's own
 * code calls removeChild only on a download link it appended one line before
 * (hooks/useDownloadManager.ts), which cannot meet this error, and never calls
 * insertBefore.
 */

// Declared structurally, following lib/injectedScripts.ts, so this module and
// its vitest never load the SDK.
type CheckableFrame = { filename?: string; function?: string };
type CheckableException = {
    type?: string;
    mechanism?: { parent_id?: number };
    stacktrace?: { frames?: CheckableFrame[] };
};
export type CheckableEvent = { exception?: { values?: CheckableException[] } };

const DOM_METHODS = new Set(['removeChild', 'insertBefore']);

export function isWebKitDomDesync(event: CheckableEvent): boolean {
    const values = event.exception?.values;
    if (!values?.length) return false;

    // The same root-exception rule injectedScripts.ts uses: the last value that
    // is not a linked cause and actually carries frames.
    const root = [...values]
        .reverse()
        .find((value) => value.mechanism?.parent_id === undefined && value.stacktrace?.frames?.length);
    if (root?.type !== 'NotFoundError') return false;

    // Sentry stores frames oldest-first, so the throwing frame is the last one.
    const frames = root.stacktrace?.frames ?? [];
    const threw = frames[frames.length - 1];
    return threw?.filename === '[native code]' && DOM_METHODS.has(threw.function ?? '');
}
