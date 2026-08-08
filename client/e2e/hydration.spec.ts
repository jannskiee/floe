/**
 * Hydration guard.
 *
 * React reconciles the server-rendered DOM against the client tree on first
 * paint. A mismatch is a *recoverable* error, so the page still renders and
 * nothing in this suite noticed until now: no other spec attaches a pageerror
 * or console listener, so a hydration mismatch on any route was invisible.
 *
 * In production React strips the message and emits
 *   "Minified React error #418; visit https://react.dev/errors/418?args[]=text..."
 * where #418 is the mismatch itself (args[]=text for a text diff, args[]=HTML
 * for a structural one) and #422/#423 are the "threw while hydrating" variants.
 * Locally the suite runs against `next dev`, which emits the full prose
 * instead, so both wordings are matched (see the webServer block in
 * playwright.config.ts for the dev/prod split).
 *
 * Next routes recoverable errors through its own onRecoverableError, which is
 * module-private and cannot be replaced from userland, so we listen on the two
 * sinks it ends up in: window.reportError (which surfaces as an uncaught error,
 * hence page.on('pageerror')) and console.error.
 *
 * Only hydration signatures fail this test. The homepage's Socket.IO and
 * /api/turn-credentials traffic emits unrelated console noise that must never
 * redden it.
 *
 * What this does NOT cover, deliberately: a browser auto-translate extension
 * rewriting text before hydration also produces #418, and it does so on server
 * components and client components alike (measured). That is caused by the
 * user's browser, not by this app, so asserting against it would be a
 * permanently-red test for something React does not promise.
 */
import { test, expect, type Page } from '@playwright/test';

const ROUTES = ['/', '/download', '/how-it-works', '/privacy', '/terms'] as const;

const HYDRATION_ERROR =
    /react\.dev\/errors\/(418|422|423|425)\b|Minified React error #(418|422|423|425)\b|Hydration failed because the server rendered|(did not match|didn't match) the client|Text content does not match/i;

function collectHydrationErrors(page: Page): string[] {
    const hits: string[] = [];
    page.on('pageerror', (e) => {
        if (HYDRATION_ERROR.test(e.message)) hits.push(`pageerror: ${e.message}`);
    });
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (HYDRATION_ERROR.test(text)) hits.push(`console: ${text}`);
    });
    return hits;
}

for (const route of ROUTES) {
    test(`${route}: hydrates without a React hydration error`, async ({ page }) => {
        const hits = collectHydrationErrors(page);

        await page.goto(route);

        // Hydration has to actually happen or "no errors" is vacuous. React
        // stamps __reactContainer$<rand> on the hydrateRoot container (which is
        // `document` in the App Router) and __reactFiber$<rand> on every host
        // node it hydrates. Waiting on these rather than on visible text keeps
        // the spec independent of page content.
        await page.waitForFunction(
            () => Object.keys(document).some((k) => k.startsWith('__reactContainer$')),
            null,
            { timeout: 30_000 }
        );
        await page.waitForFunction(
            () => {
                const el = document.body.firstElementChild;
                return !!el && Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
            },
            null,
            { timeout: 30_000 }
        );

        // Recoverable errors are flushed during commit, just after the
        // hydration render.
        await page.waitForTimeout(500);

        expect(hits, `hydration error(s) on ${route}:\n  ${hits.join('\n  ')}`).toEqual([]);
    });
}
