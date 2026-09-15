/**
 * Errors reported by a JavaScript runtime that is not a browser.
 *
 * FLOE-G and FLOE-J are the same client twice: Obscura, a headless scraping
 * browser that runs page scripts on V8 through deno_core, over a DOM of its own.
 * Its registry never upgraded the number-flow-react element, so the odometer
 * threw. FLOE-G reached global-error before components/AnimatedByteCount.tsx
 * existed; FLOE-J is that component catching the same throw after its
 * customElements.get() pre-check passed. No visitor's browser was involved.
 *
 * The marker is deno_core's module scheme. Its own modules are named
 * ext:core/01_core.js and so on, and work that enters through its eventLoopTick
 * or queueMicrotask leaves those frames at the bottom of the stack. FLOE-J, in
 * the order Sentry stores it (oldest first):
 *
 *   ext:core/01_core.js:178:7 (eventLoopTick)
 *   ext:core/01_core.js:294:9
 *   <script>:1:100633
 *   <script>:1:98865 (xm)
 *   <obscura:bootstrap>:346:75
 *   ...
 *   <script>:1:16028 (F.getSnapshotBeforeUpdate)   <- threw
 *
 * No browser or extension scheme begins with "ext:" (chrome-extension:,
 * moz-extension:, safari-web-extension:). A script gets such a name only by
 * declaring one with //# sourceURL, and nothing we ship does.
 *
 * Any frame decides, not just the one that threw. <script> and
 * <obscura:bootstrap> belong to the build that visited. Obscura's current code
 * names page scripts by their URL instead, so its throwing frame would be one of
 * our chunks and only the ext: frames beneath it would give the runtime away.
 * For the same reason this cannot be a denyUrls pattern, which tests the newest
 * frame with a usable URL.
 *
 * It runs in beforeSend, after NextjsClientStackFrameNormalization, and the name
 * survives that for a different reason than lib/injectedScripts.ts relies on:
 * new URL('ext:core/01_core.js') does NOT throw. It parses with the opaque
 * origin "null", and replacing "null" with "app://" changes nothing. The stored
 * FLOE-G and FLOE-J events show the name intact.
 *
 * What it cannot see: a throw during synchronous script evaluation, or in a
 * microtask deno_core drains from Rust, carries no ext: frame. And those frames
 * are the OLDEST ones, kept only because Sentry's globalHandlers integration
 * raises Error.stackTraceLimit to 50.
 */

// Declared structurally, following lib/injectedScripts.ts, so this module and its
// vitest never load the SDK.
type CheckableFrame = { filename?: string };
type CheckableException = { stacktrace?: { frames?: CheckableFrame[] } };
export type CheckableEvent = { exception?: { values?: CheckableException[] } };

// Case-sensitive and ending in the colon, so Chrome's internal "extensions::"
// script names, or a path that merely contains "ext", can never match.
const DENO_CORE_SCHEME = 'ext:';

export function isNonBrowserRuntimeError(event: CheckableEvent): boolean {
    // Every exception value, linked causes included: a cause thrown inside the
    // same runtime is no more ours than the error that wraps it.
    return (event.exception?.values ?? []).some((value) =>
        (value.stacktrace?.frames ?? []).some(
            (frame) => typeof frame.filename === 'string' && frame.filename.startsWith(DENO_CORE_SCHEME)
        )
    );
}
