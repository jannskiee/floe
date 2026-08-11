import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Multi-viewport layout guard: every route must render without horizontal
// overflow from small phones through ultra-wide desktops. body has
// overflow-x-hidden, which hides an overflowing layout but does not fix it —
// scrollWidth still exceeds the viewport, so that is what we assert on.
// ---------------------------------------------------------------------------

const VIEWPORTS = [
    { width: 320, height: 568 },   // iPhone SE (1st gen), smallest supported
    { width: 360, height: 800 },   // small Android
    { width: 375, height: 667 },   // iPhone SE (2nd/3rd gen), iPhone 8
    { width: 390, height: 844 },   // iPhone 12-15
    { width: 414, height: 896 },   // iPhone XR / 11
    { width: 430, height: 932 },   // iPhone Pro Max
    { width: 568, height: 320 },   // iPhone SE landscape (short height)
    { width: 639, height: 900 },   // one below the sm tier boundary
    { width: 640, height: 960 },   // sm tier boundary: Windows 11 3-column snap on 1920
    { width: 844, height: 390 },   // iPhone 12-15 landscape
    { width: 768, height: 1024 },  // iPad portrait
    { width: 820, height: 1180 },  // iPad Air portrait
    { width: 1023, height: 768 },  // one below the lg tier boundary
    { width: 1024, height: 768 },  // lg tier boundary / iPad landscape
    { width: 1280, height: 800 },  // small laptop
    { width: 1366, height: 768 },  // most common laptop
    { width: 1440, height: 900 },  // laptop
    { width: 1536, height: 864 },  // FHD at 125% scale
    { width: 1920, height: 1080 }, // desktop FHD
    { width: 2560, height: 1440 }, // desktop QHD / ultra-wide half
];

interface OverflowReport {
    innerWidth: number;
    docScrollWidth: number;
    bodyScrollWidth: number;
    offenders: string[];
}

/**
 * Reads the page's horizontal overflow state. When the document or body is
 * wider than the viewport, it also walks the DOM for the elements poking past
 * the right edge (skipping anything inside an intentional overflow-x
 * scroller/clipper) so the failure message names the culprits.
 */
async function overflowReport(page: Page): Promise<OverflowReport> {
    return page.evaluate(() => {
        const innerWidth = window.innerWidth;
        const doc = document.documentElement;
        const body = document.body;
        const limit = innerWidth + 1;
        const offenders: string[] = [];
        if (doc.scrollWidth > limit || body.scrollWidth > limit) {
            const isInsideScroller = (el: Element): boolean => {
                for (let a = el.parentElement; a && a !== body; a = a.parentElement) {
                    const ox = getComputedStyle(a).overflowX;
                    if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
                }
                return false;
            };
            for (const el of Array.from(body.querySelectorAll('*'))) {
                const r = el.getBoundingClientRect();
                if (r.width > 1 && r.right > limit && !isInsideScroller(el)) {
                    const cls =
                        typeof el.className === 'string'
                            ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).join('.')
                            : '';
                    offenders.push(
                        `<${el.tagName.toLowerCase()}${cls ? ` class~=${cls}` : ''}> right=${Math.round(r.right)}`,
                    );
                    if (offenders.length >= 12) break;
                }
            }
        }
        return {
            innerWidth,
            docScrollWidth: doc.scrollWidth,
            bodyScrollWidth: body.scrollWidth,
            offenders,
        };
    });
}

/** Soft-asserts so a single run reports every failing viewport, not just the first. */
async function assertNoHorizontalOverflow(page: Page, label: string) {
    const r = await overflowReport(page);
    const detail =
        `[${label}] innerWidth=${r.innerWidth} doc=${r.docScrollWidth} body=${r.bodyScrollWidth}` +
        (r.offenders.length ? `\n  overflowing elements:\n  ${r.offenders.join('\n  ')}` : '');
    expect.soft(r.docScrollWidth, detail).toBeLessThanOrEqual(r.innerWidth + 1);
    expect.soft(r.bodyScrollWidth, detail).toBeLessThanOrEqual(r.innerWidth + 1);
}

/**
 * The navbar is position:fixed, so an overflowing pill never shows up in
 * document scrollWidth — measure it directly instead.
 *
 * The pill caps itself with max-width and scrolls internally rather than poking
 * off-screen, which makes its bounding box incapable of exceeding the viewport.
 * The edge assertions below are therefore kept only as a cheap sanity net; the
 * assertion that can actually still fail is scrollWidth vs clientWidth, i.e.
 * "did the content outgrow the cap". Anything that widens the tiers past the
 * viewport shows up there and nowhere else.
 *
 * Callers pass expectPill so a missing pill is a hard failure on routes that
 * must have one. The old version returned early on null, so any change to the
 * pill's selector or element type silently retired this whole guard.
 */
async function assertNavbarFits(page: Page, label: string, expectPill: boolean) {
    const r = await page.evaluate(() => {
        const pill = document.querySelector('[data-nav-pill]');
        if (!pill) return null;
        const rect = pill.getBoundingClientRect();
        return {
            left: rect.left,
            right: rect.right,
            innerWidth: window.innerWidth,
            scrollWidth: pill.scrollWidth,
            clientWidth: pill.clientWidth,
            navChildren: pill.parentElement?.childElementCount ?? -1,
            parentIsMainNav:
                pill.parentElement?.tagName === 'NAV' &&
                pill.parentElement.getAttribute('aria-label') === 'Main',
        };
    });
    if (!r) {
        if (expectPill) {
            expect(r, `[${label}] expected a [data-nav-pill] element and found none`).not.toBeNull();
        }
        return;
    }
    expect.soft(r.left, `[${label}] navbar pill left edge`).toBeGreaterThanOrEqual(-1);
    expect
        .soft(r.right, `[${label}] navbar pill right edge (innerWidth=${r.innerWidth})`)
        .toBeLessThanOrEqual(r.innerWidth + 1);
    expect
        .soft(
            r.scrollWidth,
            `[${label}] navbar pill content overflows its own box (scrollWidth=${r.scrollWidth} clientWidth=${r.clientWidth}, innerWidth=${r.innerWidth})`
        )
        .toBeLessThanOrEqual(r.clientWidth + 1);
    // The pill must remain the direct, only child of nav[aria-label="Main"].
    // Both halves matter and neither is about the selector: [data-nav-pill] finds
    // the right element regardless. What breaks is the geometry. <nav> is
    // `flex justify-center` with `pointer-events-none`, so a sibling would push
    // the capsule off centre, and a wrapper would silently move the centring one
    // level away from the thing being measured. Asserting the parent's identity
    // as well as its child count is what makes the wrapper case fail: a count of
    // 1 alone is satisfied by any container.
    expect
        .soft(r.parentIsMainNav, `[${label}] pill's parent should be nav[aria-label="Main"]`)
        .toBe(true);
    expect
        .soft(r.navChildren, `[${label}] nav[aria-label="Main"] should have exactly one element child`)
        .toBe(1);
}

async function sweepViewports(page: Page, route: string, checkNavbar = false) {
    for (const vp of VIEWPORTS) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(150); // let reflow + transitions settle
        const label = `${route} @ ${vp.width}x${vp.height}`;
        await assertNoHorizontalOverflow(page, label);
        if (checkNavbar) await assertNavbarFits(page, label, true);
    }
}

// ---------------------------------------------------------------------------
// Static routes
// ---------------------------------------------------------------------------

test('home: no horizontal overflow at any viewport', async ({ page }) => {
    // Reduced motion renders the CLI terminal's completed session statically,
    // which is its widest state — exactly what the overflow check must see.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByText('Drop files or click to browse')).toBeVisible();
    await expect(page.getByText('floe send vacation-photos/')).toBeVisible(); // terminal hydrated
    await sweepViewports(page, '/', true);
});

test('download: no horizontal overflow at any viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/download');
    await expect(page.getByRole('heading', { name: 'Floe Desktop' })).toBeVisible();
    await sweepViewports(page, '/download', true);
});

test('how-it-works: no horizontal overflow at any viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/how-it-works');
    await expect(page.getByRole('heading', { name: 'How Floe Works' })).toBeVisible();
    await sweepViewports(page, '/how-it-works');
});

test('privacy: no horizontal overflow at any viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
    await sweepViewports(page, '/privacy');
});

test('terms: no horizontal overflow at any viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/terms');
    await expect(page.getByRole('heading', { name: /terms/i }).first()).toBeVisible();
    await sweepViewports(page, '/terms');
});

// ---------------------------------------------------------------------------
// Receiver view (needs the signaling server: joining the room renders the
// handshake pipeline card)
// ---------------------------------------------------------------------------

test('receiver view: no horizontal overflow at any viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/#room=${randomUUID()}`);
    await expect(page.getByText('Receive', { exact: true })).toBeVisible();
    await expect(page.getByText('Secure room joined')).toBeVisible({ timeout: 15_000 });
    await sweepViewports(page, 'receiver', true);
});

// ---------------------------------------------------------------------------
// Interactive sender flow at the two most important phone widths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-responsive');

test.afterAll(() => {
    try {
        rmSync(FIXTURE_DIR, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
});

test('sender flow stays inside the viewport at 320 and 390 wide', async ({ page }) => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const fixturePath = join(FIXTURE_DIR, 'fixture-1k.bin');
    writeFileSync(fixturePath, randomBytes(1024));

    for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(vp);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/');
        await expect(page.getByText('Drop files or click to browse')).toBeVisible();

        // The file input is absolutely positioned (opacity:0) over the drop zone.
        await page.locator('input[type="file"]').setInputFiles(fixturePath);
        await page.locator('button', { hasText: /create secure link/i }).click();

        const linkEl = page.locator('code').filter({ hasText: '#room=' });
        await expect(linkEl).toBeVisible({ timeout: 10_000 });
        await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();

        const label = `sender flow @ ${vp.width}x${vp.height}`;
        await assertNoHorizontalOverflow(page, label);
        await assertNavbarFits(page, label, true);

        // QR panel open is the share card's widest state.
        await page.getByRole('button', { name: 'Toggle QR code' }).click();
        await expect(page.getByText('Scan to receive files')).toBeVisible();
        await assertNoHorizontalOverflow(page, `${label} (QR open)`);

        if (vp.width === 320) {
            // The longest FAQ answer must render fully now that the accordion
            // tracks true content height instead of a fixed max-h cap.
            await page.getByRole('button', { name: /how do i use floe/i }).click();
            await expect(page.getByText(/no accounts needed, no waiting/i)).toBeVisible();
            await assertNoHorizontalOverflow(page, `${label} (FAQ open)`);
        }
    }
});
