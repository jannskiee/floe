/**
 * The light on the /how-it-works route figure.
 *
 * The specs that look at this figure force reduced motion, which is the right
 * setting for an overflow sweep and the reason the figure's motion was never
 * checked by CI (hydration.spec.ts opens the route with motion on but never
 * looks at the drawing): the scaled-dash truncation that shipped in #423 lived
 * exactly there. This spec is the one place the draw-in and the hover loop
 * are watched. Nothing here reads a wall clock: a test either waits for every
 * animation to end or pauses them all on first paint, then seeks a paused
 * animation to a chosen time, screenshots the drawing's box with animations
 * allowed, and decodes the baseline rows in-page, so a slow runner changes
 * nothing.
 *
 * Geometry comes from the DOM (the direct path's own `d`), not from a copy of
 * routeFigure.ts, so a retuned drawing cannot desynchronize the test.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// The ice line is about rgb(177, 221, 235), luminance 213 on the 0.2126 /
// 0.7152 / 0.0722 scale. The light's head is whiter than the line, so a pixel
// on the baseline above this threshold can only be the light.
const HEAD_LUMINANCE = 228;

interface Figure {
    box: Locator;
    rect: { x: number; y: number; width: number; height: number };
    /** CSS pixels per viewBox unit. */
    scale: number;
    /** Screenshot pixels per CSS pixel: 1 under the chromium project, read from
     *  the page so a DPR-2 profile (a local WebKit run) also works. */
    dpr: number;
    youX: number;
    themX: number;
    baseY: number;
    apexY: number;
}

async function figure(page: Page): Promise<Figure> {
    const box = page.locator('.hiw-box:visible');
    await expect(box).toHaveCount(1);
    const rect = (await box.boundingBox())!;
    const g = await box.evaluate((el) => {
        const svg = el.querySelector('svg')!;
        const vb = svg.viewBox.baseVal;
        const d = svg
            .querySelector('.hiw-direct')!
            .getAttribute('d')!
            .match(/M ([\d.]+) ([\d.]+) H ([\d.]+)/)!;
        // The server tick is the topmost tick, whatever order the JSX draws
        // them in.
        const apex = Math.min(
            ...[...svg.querySelectorAll('.hiw-tick:not(.hiw-relay-tick)')].map(
                (t) => Number(t.getAttribute('y1'))
            )
        );
        return {
            vbW: vb.width,
            dpr: window.devicePixelRatio,
            youX: Number(d[1]),
            baseY: Number(d[2]),
            themX: Number(d[3]),
            apexY: apex,
        };
    });
    expect(g.apexY, 'the apex sits above the baseline').toBeLessThan(g.baseY);
    return {
        box,
        rect,
        scale: rect.width / g.vbW,
        dpr: g.dpr,
        youX: g.youX,
        themX: g.themX,
        baseY: g.baseY,
        apexY: g.apexY,
    };
}

/** Pause every animation on the page, seek it to `t` milliseconds, and let a frame paint. */
async function seekAll(page: Page, t: number): Promise<void> {
    await page.evaluate(async (t) => {
        for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = t;
        }
        // Two frames, not none: WebKit screenshots the last painted frame, and a
        // seek alone has not painted yet.
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
    }, t);
}

async function animationNames(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        document
            .getAnimations()
            .map((a) => (a as CSSAnimation).animationName)
            .sort()
    );
}

interface RowScan {
    maxL: number;
    maxX: number;
    iceCount: number;
}

/** Decode a PNG of the box in-page and scan one pixel row for ice-hued ink and the brightest pixel. */
async function scanRows(
    page: Page,
    png: Buffer,
    ys: number[]
): Promise<Record<number, RowScan>> {
    return page.evaluate(
        async ({ b64, ys }) => {
            const bmp = await createImageBitmap(
                await (await fetch('data:image/png;base64,' + b64)).blob()
            );
            // A DOM canvas, not OffscreenCanvas, which Playwright's WebKit lacks;
            // it is never attached, so nothing on the page changes.
            const canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(bmp, 0, 0);
            const out: Record<
                number,
                { maxL: number; maxX: number; iceCount: number }
            > = {};
            for (const y of ys) {
                if (y < 0 || y >= bmp.height) continue;
                const d = ctx.getImageData(0, y, bmp.width, 1).data;
                let maxL = 0;
                let maxX = -1;
                let iceCount = 0;
                for (let x = 0; x < bmp.width; x++) {
                    const r = d[x * 4];
                    const g = d[x * 4 + 1];
                    const b = d[x * 4 + 2];
                    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    if (b > r + 6 && g > r + 4 && L > 40) iceCount++;
                    if (L > maxL) {
                        maxL = L;
                        maxX = x;
                    }
                }
                out[y] = { maxL, maxX, iceCount };
            }
            return out;
        },
        { b64: png.toString('base64'), ys }
    );
}

/** The brightest pixel across the baseline's device rows: where the head is (in CSS px), and how bright. */
async function head(page: Page, f: Figure): Promise<RowScan> {
    const png = await f.box.screenshot({ animations: 'allow' });
    const y = Math.round(f.baseY * f.scale * f.dpr);
    const rows = await scanRows(page, png, [y - 1, y, y + 1]);
    const best = Object.values(rows).reduce((a, r) =>
        r.maxL > a.maxL ? r : a
    );
    return { ...best, maxX: best.maxX / f.dpr };
}

/** Ice-hued pixels on the apex row, where the signaling server's tick sits. */
async function apexIce(page: Page, f: Figure): Promise<number> {
    const png = await f.box.screenshot({ animations: 'allow' });
    const y = Math.round(f.apexY * f.scale * f.dpr);
    const rows = await scanRows(page, png, [y - 1, y, y + 1]);
    return Object.values(rows).reduce((n, r) => n + r.iceCount, 0);
}

/** Every once-only animation, the light's crossing included, has run out. */
async function waitForStill(page: Page): Promise<void> {
    await page.waitForFunction(
        () => document.getAnimations().length === 0,
        null,
        { timeout: 15_000 }
    );
}

/**
 * Open the route and pause every animation on first paint, before any of them
 * can finish and drop out of getAnimations(). A paused animation can then be
 * seeked to any figure time, however slow the runner was to get here.
 */
async function freezeOnPaint(page: Page): Promise<void> {
    await page.goto('/how-it-works', { waitUntil: 'commit' });
    await page.waitForFunction(
        () =>
            document
                .getAnimations()
                .some(
                    (a) =>
                        (a as CSSAnimation).animationName === 'hiw-comet-once'
                ),
        null,
        { timeout: 30_000 }
    );
    await page.evaluate(() => {
        for (const a of document.getAnimations()) a.pause();
    });
}

// The loop's timeline, read from the CSS at globals.css: 80ms delay, then 1800ms
// of travel inside a 3400ms period. Seeks below are offsets into that travel.
const LOOP_DELAY = 80;
const TRAVEL = 1800;

test.describe('desktop, fine pointer', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test('hovering the drawing runs one light left to right along the direct line only', async ({
        page,
    }) => {
        await page.goto('/how-it-works');
        await waitForStill(page);
        const f = await figure(page);
        expect(
            f.scale,
            'the wide variant at its 1024px cap renders at scale 1'
        ).toBeCloseTo(1, 2);

        const still = await head(page, f);
        expect(still.maxL, 'no light on the line before hover').toBeLessThan(
            HEAD_LUMINANCE
        );

        await f.box.hover();
        await expect
            .poll(
                async () =>
                    (await animationNames(page)).filter(
                        (n) => n === 'hiw-comet-loop'
                    ).length,
                {
                    message: 'three comet layers loop while hovered',
                }
            )
            .toBe(3);
        expect(await animationNames(page)).toContain('hiw-ring-halo-loop');
        // Every running animation targets an SVG child of the drawing: nothing
        // animates the labels overlay or the box itself, which would promote a
        // layer and gray the 11px labels.
        expect(
            await page.evaluate(() =>
                document.getAnimations().every((a) => {
                    const el =
                        a.effect && 'target' in a.effect
                            ? (a.effect as KeyframeEffect).target
                            : null;
                    return (
                        !!el && !!el.closest('svg') && !!el.closest('.hiw-box')
                    );
                })
            )
        ).toBe(true);

        const xs: number[] = [];
        for (const fraction of [0.1, 0.5, 0.8]) {
            await seekAll(page, LOOP_DELAY + TRAVEL * fraction);
            const h = await head(page, f);
            expect(
                h.maxL,
                `head visible at ${fraction} of the travel`
            ).toBeGreaterThan(HEAD_LUMINANCE);
            expect(h.maxX).toBeGreaterThanOrEqual(f.youX * f.scale - 2);
            expect(h.maxX).toBeLessThanOrEqual(f.themX * f.scale + 2);
            xs.push(h.maxX);
            expect(
                await apexIce(page, f),
                'nothing ice-colored ever rides the arch'
            ).toBe(0);
        }
        expect(xs[0]).toBeLessThan(xs[1]);
        expect(xs[1]).toBeLessThan(xs[2]);

        // Past the travel the loop rests: the line is quiet again.
        await seekAll(page, LOOP_DELAY + TRAVEL + 200);
        expect((await head(page, f)).maxL).toBeLessThan(HEAD_LUMINANCE);

        // Leaving the drawing stops the loop and leaves the finished drawing.
        await page.mouse.move(2, 2);
        await expect.poll(() => animationNames(page)).toEqual([]);
        expect((await head(page, f)).maxL).toBeLessThan(HEAD_LUMINANCE);
    });

    test('the ring blooms as the head lands', async ({ page }) => {
        await page.goto('/how-it-works');
        await waitForStill(page);
        const f = await figure(page);
        await f.box.hover();
        await expect
            .poll(() => animationNames(page))
            .toContain('hiw-ring-halo-loop');
        const halo = f.box.locator('.hiw-ring-halo');
        // stroke-opacity, never opacity: an opacity animation composites and
        // grays the labels (see the .hiw-ring-halo note in globals.css).
        const bloom = () =>
            halo.evaluate((el) => Number(getComputedStyle(el).strokeOpacity));
        await seekAll(page, LOOP_DELAY + TRAVEL * 0.5);
        expect(await bloom()).toBe(0);
        // The head reaches THEM at 86% of the sweep; the bloom peaks there.
        await seekAll(page, LOOP_DELAY + TRAVEL * 0.86);
        expect(await bloom()).toBeGreaterThan(0.3);
        await seekAll(page, LOOP_DELAY + TRAVEL * 0.86 + 700);
        expect(await bloom()).toBe(0);
    });

    test('the light waits for the map: the pointer is ignored until the finale has played', async ({
        page,
    }) => {
        await freezeOnPaint(page);
        const f = await figure(page);
        const pointerEvents = () =>
            f.box.evaluate((el) => getComputedStyle(el).pointerEvents);
        // Mid draw-in: the box does not take the pointer, so a pointer parked
        // on it hovers nothing and the line carries no light. mouse.move, not
        // locator.hover, which waits for the box to become hit-testable.
        const box = (await f.box.boundingBox())!;
        await seekAll(page, 1200);
        expect(await pointerEvents()).toBe('none');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(200);
        expect(await f.box.evaluate((el) => el.matches(':hover'))).toBe(false);
        expect(await animationNames(page)).not.toContain('hiw-comet-loop');
        expect((await head(page, f)).maxL).toBeLessThan(HEAD_LUMINANCE);
        // Mid finale: still ignored, and the once-only light is the one on the
        // line, a third of the way across.
        await seekAll(page, 3100);
        expect(await pointerEvents()).toBe('none');
        expect(await animationNames(page)).not.toContain('hiw-comet-loop');
        const h = await head(page, f);
        expect(h.maxL).toBeGreaterThan(HEAD_LUMINANCE);
        expect(h.maxX).toBeGreaterThan(
            (f.youX + 0.2 * (f.themX - f.youX)) * f.scale
        );
        expect(h.maxX).toBeLessThan(
            (f.youX + 0.5 * (f.themX - f.youX)) * f.scale
        );
        // After the finale the box arms itself; the next pointer move starts the
        // loop fresh from YOU.
        await seekAll(page, 4400);
        expect(await pointerEvents()).toBe('auto');
        await page.mouse.move(
            box.x + box.width / 2 + 1,
            box.y + box.height / 2
        );
        await expect
            .poll(() => animationNames(page))
            .toContain('hiw-comet-loop');
    });

    test('reduced motion: no crossing, no loop, the finished drawing', async ({
        page,
    }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/how-it-works');
        const f = await figure(page);
        expect(await animationNames(page)).toEqual([]);
        await f.box.hover();
        await page.waitForTimeout(200);
        expect(await animationNames(page)).toEqual([]);
        expect((await head(page, f)).maxL).toBeLessThan(HEAD_LUMINANCE);
    });

    test('forced colors: the light takes the system highlight color', async ({
        page,
    }) => {
        await page.emulateMedia({ forcedColors: 'active' });
        await page.goto('/how-it-works');
        const f = await figure(page);
        const [stroke, highlight, canvasText, haloStroke] =
            await f.box.evaluate((el) => {
                const probe = document.createElement('span');
                probe.style.color = 'Highlight';
                document.body.append(probe);
                const highlight = getComputedStyle(probe).color;
                probe.style.color = 'CanvasText';
                const canvasText = getComputedStyle(probe).color;
                probe.remove();
                return [
                    getComputedStyle(el.querySelector('.hiw-comet-core')!)
                        .stroke,
                    highlight,
                    canvasText,
                    getComputedStyle(el.querySelector('.hiw-ring-halo')!)
                        .stroke,
                ];
            });
        expect(stroke).toBe(highlight);
        expect(haloStroke).toBe(canvasText);
    });
});

test.describe('narrow variant at its largest scale', () => {
    // 640 wide: the phone drawing at its 480px cap, scale 1.333, the exact
    // scale at which a non-scaling dash once stopped 98.8px short of THEM.
    test.use({ viewport: { width: 640, height: 900 } });

    test('the head reaches THEM', async ({ page }) => {
        await page.goto('/how-it-works');
        await waitForStill(page);
        const f = await figure(page);
        expect(f.scale).toBeGreaterThan(1.3);
        await f.box.hover();
        await expect
            .poll(() => animationNames(page))
            .toContain('hiw-comet-loop');
        // Just before the head lands: it must be in the last tenth of the line.
        await seekAll(page, LOOP_DELAY + TRAVEL * 0.8);
        const h = await head(page, f);
        expect(h.maxL).toBeGreaterThan(HEAD_LUMINANCE);
        expect(h.maxX).toBeGreaterThan(
            (f.youX + 0.85 * (f.themX - f.youX)) * f.scale
        );
        expect(h.maxX).toBeLessThanOrEqual(f.themX * f.scale + 2);
    });
});

test.describe('touch', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });

    test('the crossing plays once on paint and a tap starts nothing', async ({
        page,
    }) => {
        await page.goto('/how-it-works');
        // The precondition, or the test passes vacuously on a desktop context.
        expect(
            await page.evaluate(() => matchMedia('(hover: none)').matches)
        ).toBe(true);
        await waitForStill(page);
        const f = await figure(page);
        // The once-only crossing is scheduled for touch readers too: read from
        // the computed style, which outlives the animation, not from the live
        // list, which a slow load would have emptied already.
        expect(
            await f.box
                .locator('.hiw-comet-core')
                .evaluate((el) => getComputedStyle(el).animationName)
        ).toBe('hiw-comet-once');
        await f.box.tap();
        await page.waitForTimeout(300);
        expect(await animationNames(page)).toEqual([]);
        expect((await head(page, f)).maxL).toBeLessThan(HEAD_LUMINANCE);
    });
});
