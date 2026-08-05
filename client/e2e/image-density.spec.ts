import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// HiDPI guard.
//
// next/image caps every srcset candidate at the source image's width
// (sharp resizes withoutEnlargement), but it still advertises the larger
// candidates in the srcset. A master that is too small therefore produces no
// error anywhere: the browser picks a 2048w candidate, receives far fewer
// pixels, and silently stretches them. That is exactly how the app-window
// screenshots shipped at 1x and looked blurry on every retina display while
// passing all of our 1x visual review.
//
// So assert the thing that actually matters: every rendered image carries at
// least as many real pixels as the display asks for.
// ---------------------------------------------------------------------------

interface ImageReport {
    src: string;
    cssWidth: number;
    realWidth: number;
    ratio: number;
    broken: boolean;
}

/**
 * Decodes each rendered image to count its REAL pixels.
 *
 * `naturalWidth` cannot be used here: when a w-descriptor srcset is in play the
 * HTML spec divides the intrinsic size by the selected candidate's density, so a
 * genuine 2048px file chosen for a 1024px slot reports naturalWidth 1024 and a
 * 1x master reports exactly the same number. The two cases are indistinguishable
 * through that property, which is the whole failure mode this guard exists to
 * catch, so decode the bytes instead.
 */
async function measureImages(page: Page): Promise<ImageReport[]> {
    return page.evaluate(async () => {
        const out: ImageReport[] = [];
        for (const img of Array.from(document.querySelectorAll('img'))) {
            const rect = img.getBoundingClientRect();
            const src = img.currentSrc || img.src;
            // Zero-width (never laid out) and SVGs (resolution independent) are exempt.
            if (rect.width <= 1 || !src || /\.svg(\?|$)/.test(src)) continue;

            // The optimizer serves everything from /_next/image and carries the real
            // file in its `url` param, so read that. Taking the last path segment
            // instead labels every single row "image", which makes the failure
            // message below unable to name the file it is telling you to re-capture.
            const parsed = new URL(src, location.href);
            const label = decodeURIComponent(parsed.searchParams.get('url') ?? parsed.pathname)
                .split('/')
                .filter(Boolean)
                .pop() as string;

            // `complete` also goes true for a 404, so it cannot tell loaded from
            // broken; naturalWidth 0 on a complete image is the broken case. Report
            // it rather than skipping, otherwise all three screenshots could 404 and
            // this guard would still pass on the footer mark alone.
            if (img.complete && img.naturalWidth === 0) {
                out.push({ src: label, cssWidth: rect.width, realWidth: 0, ratio: 0, broken: true });
                continue;
            }

            let realWidth = 0;
            try {
                const bmp = await createImageBitmap(await (await fetch(src)).blob());
                realWidth = bmp.width;
                bmp.close();
            } catch {
                continue; // undecodable here (e.g. cross-origin); not this guard's business
            }
            out.push({
                src: label,
                cssWidth: rect.width,
                realWidth,
                ratio: realWidth / rect.width,
                broken: false,
            });
        }
        return out;
    });
}

/**
 * Makes every image on the page actually load, then waits for all of them.
 *
 * Chromium only starts a lazy image once it is within roughly 1250px of the
 * viewport, and both routes here sit close to that line: on /download the
 * footer mark is about 1200px below the fold, and on / the app-window frames
 * end up a similar distance above it, because prefers-reduced-motion turns the
 * scroll into an instant jump that never passes them. Either way the image
 * never loads, `complete` never turns true, and this would fail as a timeout
 * rather than as a density report. Forcing eager is what screenshot-matrix.mjs
 * already does for the same reason.
 */
async function settleImages(page: Page) {
    await page.evaluate(() => {
        for (const img of Array.from(document.querySelectorAll('img'))) {
            img.loading = 'eager';
        }
    });
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('img')).every((i) => i.complete),
        undefined,
        { timeout: 15_000 }
    );
}

async function assertDensity(page: Page, route: string, dpr: number) {
    const images = await measureImages(page);
    expect(images.length, `[${route} @ dpr${dpr}] expected at least one rendered image`).toBeGreaterThan(0);
    expect(
        images.filter((i) => i.broken).map((i) => i.src),
        `[${route} @ dpr${dpr}] image(s) rendered but failed to load at all`
    ).toEqual([]);
    for (const img of images) {
        // Allow a 2% tolerance for fractional layout boxes.
        expect
            .soft(
                img.ratio,
                `[${route} @ dpr${dpr}] ${img.src} renders at ${Math.round(img.cssWidth)} CSS px ` +
                    `but decodes only ${img.realWidth} px (needs >= ${Math.round(img.cssWidth * dpr)}). ` +
                    `Re-capture the master at ${dpr}x; raising quality cannot recover missing pixels.`
            )
            .toBeGreaterThanOrEqual(dpr * 0.98);
    }
}

// dpr 2 is the meaningful case: it is where a 1x master visibly fails, and it
// covers essentially every modern laptop and phone.
for (const dpr of [1, 2]) {
    test.describe(`device pixel ratio ${dpr}`, () => {
        test.use({ deviceScaleFactor: dpr, viewport: { width: 1440, height: 900 } });

        test(`home: images carry enough pixels`, async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto('/');
            await expect(page.getByText('Drop files or click to browse')).toBeVisible();
            // The app-window frame is below the fold and lazily decoded.
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await settleImages(page);
            await assertDensity(page, '/', dpr);
        });

        test(`download: images carry enough pixels`, async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto('/download');
            await expect(page.getByRole('heading', { name: 'Floe Desktop' })).toBeVisible();
            await settleImages(page);
            await assertDensity(page, '/download', dpr);
        });
    });
}
