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
            let realWidth = 0;
            try {
                const bmp = await createImageBitmap(await (await fetch(src)).blob());
                realWidth = bmp.width;
                bmp.close();
            } catch {
                continue; // undecodable here (e.g. cross-origin); not this guard's business
            }
            out.push({
                // File name only: the optimizer URL carries a query string.
                src: decodeURIComponent(src).replace(/[?&].*$/, '').split('/').pop() as string,
                cssWidth: rect.width,
                realWidth,
                ratio: realWidth / rect.width,
            });
        }
        return out;
    });
}

async function assertDensity(page: Page, route: string, dpr: number) {
    const images = await measureImages(page);
    expect(images.length, `[${route} @ dpr${dpr}] expected at least one rendered image`).toBeGreaterThan(0);
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
            await page.waitForFunction(
                () => Array.from(document.querySelectorAll('img')).every((i) => i.complete),
                undefined,
                { timeout: 15_000 }
            );
            await assertDensity(page, '/', dpr);
        });

        test(`download: images carry enough pixels`, async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto('/download');
            await expect(page.getByRole('heading', { name: 'Floe Desktop' })).toBeVisible();
            await page.waitForFunction(
                () => Array.from(document.querySelectorAll('img')).every((i) => i.complete),
                undefined,
                { timeout: 15_000 }
            );
            await assertDensity(page, '/download', dpr);
        });
    });
}
