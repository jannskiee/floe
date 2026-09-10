/**
 * The global stats odometer must never be able to take down the homepage.
 *
 * @number-flow/react renders a <number-flow-react> custom element and, one
 * value change later, calls this.el.willUpdate() from getSnapshotBeforeUpdate.
 * The optional chain there is a null check only: when the element was created
 * but never UPGRADED, the method does not exist and the commit phase throws
 *
 *   TypeError: this.el?.willUpdate is not a function
 *
 * There is no error.tsx on '/', so before components/AnimatedByteCount.tsx that
 * reached app/global-error.tsx and the whole page became the default Next.js
 * error page. FLOE-G is exactly that, reported with handled:yes and
 * mechanism:generic, i.e. through global-error's own captureException, from a
 * runtime whose custom elements never upgrade.
 *
 * number-flow's define() fails SILENTLY in several different ways
 * (number-flow/dist/lite.mjs), so each is driven here rather than letting one
 * stand in for the others, and the last case bypasses the pre-check entirely so
 * the error boundary itself is exercised.
 *
 * These specs start no transfer and need nothing from the signaling server, so
 * they cannot reach the public byte counter. The report guard below is belt and
 * braces, in the shape e2e/docs-screenshots.mjs already uses.
 */
import { test, expect, type Page } from '@playwright/test';

// Pinned so the expected string is exact: NumberFlow formats with
// Intl.NumberFormat(undefined, ...), i.e. the context's locale, and the static
// fallback has to match it character for character.
test.use({ locale: 'en-US' });

// 1181116006 bytes is 1.10 GB. Chosen because the trailing zero is produced
// only by minimumFractionDigits: 2 - splitBytes() returns 1.1, so a fallback
// built with a bare template literal would render "1.1 GB" and fail here.
const STUB_TOTAL_BYTES = 1181116006;
const EXPECTED = '1.10 GB';
const ELEMENT = 'number-flow-react';
const A_WHILE = 15_000;

// GlobalStats fetches `${resolveSocketUrl()}/api/stats`, which under Playwright
// is http://localhost:3001, CROSS-ORIGIN from the http://localhost:3000
// baseURL. The allow-origin header is mandatory, not tidiness: without it the
// browser blocks the fulfilled response, GlobalStats swallows it in its own
// `catch {}`, the counter stays at "0.00 Bytes" and every assertion below would
// pass or fail for the wrong reason.
async function stubStats(page: Page) {
    await page.route('**/api/stats', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ totalBytes: STUB_TOTAL_BYTES }),
        })
    );
}

function collectPageErrors(page: Page): string[] {
    const seen: string[] = [];
    page.on('pageerror', (error) => seen.push(error.message));
    return seen;
}

async function guardStatsReport(page: Page, attempts: { n: number }) {
    await page.route('**/api/stats/report', (route) => {
        attempts.n += 1;
        return route.abort();
    });
}

// What every degraded case has to show: the hero is still there, the counter
// reads the stubbed value rather than 0.00 Bytes (so the value change that used
// to crash really did happen), the animated element gave way to the fallback,
// and nothing escaped to global-error.
// The counter is asserted FIRST on purpose. The crash does not happen on load,
// it happens a moment later when the stats fetch resolves and the value changes,
// so a hero assertion that ran before that would pass even on a page that is
// about to be replaced. Waiting for the stubbed value first means the hero check
// below is a statement about surviving the transition.
async function expectDegradedButAlive(page: Page, errors: string[], reports: { n: number }) {
    await expect(page.getByRole('img', { name: EXPECTED })).toBeVisible({ timeout: A_WHILE });
    await expect(page.getByRole('heading', { level: 1, name: 'Floe' })).toBeVisible({
        timeout: A_WHILE,
    });
    await expect(page.getByText('transferred globally')).toBeVisible({ timeout: A_WHILE });
    await expect(page.locator(ELEMENT)).toHaveCount(0, { timeout: A_WHILE });
    expect(errors.filter((message) => message.includes('willUpdate'))).toEqual([]);
    expect(reports.n).toBe(0);
}

test('leaves the animated counter alone when number-flow is healthy', async ({ page }) => {
    const reports = { n: 0 };
    await guardStatsReport(page, reports);
    await stubStats(page);
    await page.goto('/');

    await expect(page.locator(ELEMENT)).toHaveCount(1, { timeout: A_WHILE });
    // Pins the tag name that AnimatedByteCount's pre-check hardcodes. If a
    // future number-flow release renames it, the probe would otherwise report
    // "not registered" forever and silently degrade every visitor to a static
    // number. This assertion turns that into a CI failure instead.
    expect(await page.evaluate(() => !!window.customElements.get('number-flow-react'))).toBe(true);
    // And the fallback is not in play: NumberFlowElement publishes its role and
    // label through ElementInternals, which Playwright's role engine does not
    // read, so an img role here could only be the fallback span.
    await expect(page.getByRole('img', { name: EXPECTED })).toHaveCount(0);
    expect(reports.n).toBe(0);
});

test('survives number-flow-react never being defined', async ({ page }) => {
    // The exact production shape: React creates the element, nothing upgrades
    // it, and the first value change calls a method that is not there.
    const errors = collectPageErrors(page);
    const reports = { n: 0 };
    await guardStatsReport(page, reports);
    await stubStats(page);
    await page.addInitScript(() => {
        const define = window.customElements.define.bind(window.customElements);
        window.customElements.define = (
            name: string,
            ctor: CustomElementConstructor,
            options?: ElementDefinitionOptions
        ) => {
            if (name === 'number-flow-react') return;
            return define(name, ctor, options);
        };
    });

    await page.goto('/');
    await expectDegradedButAlive(page, errors, reports);
});

test('survives an environment with no custom element registry', async ({ page }) => {
    // A different guard inside number-flow's define(), which bails at
    // `typeof customElements < "u"` before it ever reaches define. A stub
    // rather than a delete, so nothing unrelated trips over a missing global.
    const errors = collectPageErrors(page);
    const reports = { n: 0 };
    await guardStatsReport(page, reports);
    await stubStats(page);
    await page.addInitScript(() => {
        Object.defineProperty(window, 'customElements', {
            value: { get: () => undefined, define: () => {} },
            configurable: true,
        });
    });

    await page.goto('/');
    await expectDegradedButAlive(page, errors, reports);
});

test('survives number-flow-react upgrading to a foreign element', async ({ page }) => {
    // The one case the pre-check cannot see: the tag IS registered, so
    // customElements.get() answers truthfully, but it upgrades to a class with
    // no willUpdate. Only getDerivedStateFromError can save the page here.
    const errors = collectPageErrors(page);
    const reports = { n: 0 };
    await guardStatsReport(page, reports);
    await stubStats(page);
    await page.addInitScript(() => {
        const define = window.customElements.define.bind(window.customElements);
        window.customElements.define = (
            name: string,
            ctor: CustomElementConstructor,
            options?: ElementDefinitionOptions
        ) => {
            if (name === 'number-flow-react') {
                return define(name, class extends HTMLElement {}, options);
            }
            return define(name, ctor, options);
        };
    });

    await page.goto('/');
    await expectDegradedButAlive(page, errors, reports);
});
