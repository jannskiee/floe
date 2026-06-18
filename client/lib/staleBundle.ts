/**
 * Stale-bundle recovery.
 *
 * When a new version is deployed, a browser tab that loaded the previous
 * version still references the old JavaScript chunks. The moment that tab
 * tries to load a chunk on client-side navigation, the bundler throws because
 * the chunk (or the module factory inside it) no longer exists. With Turbopack
 * this surfaces as:
 *
 *   "Module 12345 was instantiated because it was required from module 67890,
 *    but the module factory is not available."
 *
 * Webpack throws the equivalent "Loading chunk N failed" / "ChunkLoadError",
 * and native ESM throws "Failed to fetch dynamically imported module". None of
 * these are application bugs - they are expected churn after a deploy, and the
 * fix is always the same: reload so the browser fetches the current bundle.
 */

const STALE_BUNDLE_PATTERNS: RegExp[] = [
    // Turbopack: stale module graph after a redeploy
    /module factory is not available/i,
    // Webpack: classic chunk-load failure
    /Loading chunk [\w-]+ failed/i,
    /ChunkLoadError/i,
    // Native ESM dynamic import (Safari / Firefox / Chrome wording variants)
    /Failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /Importing a module script failed/i,
];

/** True when an error message looks like a stale-deploy bundle/chunk failure. */
export function isStaleBundleError(message: string | undefined | null): boolean {
    if (!message) return false;
    return STALE_BUNDLE_PATTERNS.some((re) => re.test(message));
}

// sessionStorage key holding the timestamp of the last auto-reload. Used to
// break reload loops: if a fresh bundle *still* fails, the error is not stale
// and we must not keep reloading.
const RELOAD_KEY = 'floe:stale-bundle-reloaded-at';

// If a reload happened within this window and we hit another stale-bundle
// error, treat it as a genuine failure and stop reloading. Long enough to
// cover a full reload + hydrate, short enough that a *later* deploy still
// recovers.
const RELOAD_DEBOUNCE_MS = 10_000;

function messageOf(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    if (value && typeof value === 'object' && 'message' in value) {
        const m = (value as { message?: unknown }).message;
        if (typeof m === 'string') return m;
    }
    return undefined;
}

/**
 * Reload the page once if `message` is a stale-bundle error. Guarded against
 * reload loops via a sessionStorage debounce. Returns true if a reload was
 * triggered.
 */
export function reloadIfStaleBundle(message: string | undefined): boolean {
    if (typeof window === 'undefined') return false;
    if (!isStaleBundleError(message)) return false;

    let last = 0;
    try {
        last = Number(window.sessionStorage.getItem(RELOAD_KEY)) || 0;
    } catch {
        // sessionStorage can throw in private/restricted contexts - ignore.
    }
    if (Date.now() - last < RELOAD_DEBOUNCE_MS) return false;

    try {
        window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
        // Non-fatal: worst case we lose loop protection in a restricted context.
    }
    window.location.reload();
    return true;
}

/**
 * Register global listeners that auto-recover from stale-bundle errors.
 * Safe to call once at client startup (see instrumentation-client.ts).
 */
export function registerStaleBundleReload(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('error', (event: ErrorEvent) => {
        reloadIfStaleBundle(event.message || messageOf(event.error));
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        reloadIfStaleBundle(messageOf(event.reason));
    });
}
