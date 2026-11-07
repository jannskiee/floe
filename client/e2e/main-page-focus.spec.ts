import { test, expect, type Locator } from '@playwright/test';
import { randomUUID } from 'crypto';

type Rgb = [number, number, number];

interface Seen {
    /** The label color as drawn, composited over the background. */
    text: Rgb;
    /** The element's own background, composited over everything behind it. */
    background: Rgb;
    /** What is behind the element, without its own background. */
    surround: Rgb;
    /** The focus ring as drawn over the surround, or null when none is. */
    ring: Rgb | null;
}

/** The colors the eye gets at an element. getComputedStyle hands back oklch,
 *  oklab and color-mix values as written, so each one is drawn on a 1x1
 *  canvas and read back as sRGB, then the partly transparent backgrounds are
 *  stacked from the nearest opaque ancestor up. */
async function seen(locator: Locator): Promise<Seen> {
    return locator.evaluate((el) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no 2d context');
        const SENTINEL = '#010203';
        const rgba = (css: string): [number, number, number, number] => {
            ctx.fillStyle = SENTINEL;
            ctx.fillStyle = css;
            if (ctx.fillStyle === SENTINEL) throw new Error(`the canvas cannot read the color ${JSON.stringify(css)}`);
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b, a / 255];
        };
        const over = (top: [number, number, number, number], under: [number, number, number]) =>
            [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])) as [number, number, number];
        const behind = (from: Element | null): [number, number, number] => {
            const layers: [number, number, number, number][] = [];
            for (let node = from; node; node = node.parentElement) {
                const layer = rgba(getComputedStyle(node).backgroundColor);
                layers.push(layer);
                if (layer[3] >= 1) break;
            }
            let color: [number, number, number] = [255, 255, 255];
            for (const layer of layers.reverse()) color = over(layer, color);
            return color;
        };
        const background = behind(el);
        const surround = behind(el.parentElement);
        const shadows: string[] = [];
        let depth = 0;
        let current = '';
        for (const ch of getComputedStyle(el).boxShadow) {
            if (ch === '(') depth++;
            if (ch === ')') depth--;
            if (ch === ',' && depth === 0) {
                shadows.push(current.trim());
                current = '';
            } else current += ch;
        }
        shadows.push(current.trim());
        let ring: [number, number, number] | null = null;
        let widest = 0;
        for (const shadow of shadows) {
            const m = /^(.*\S)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px$/.exec(shadow);
            if (!m || +m[2] !== 0 || +m[3] !== 0 || +m[4] !== 0 || +m[5] <= widest) continue;
            const color = rgba(m[1]);
            if (color[3] === 0) continue;
            widest = +m[5];
            ring = over(color, surround);
        }
        return {
            text: over(rgba(getComputedStyle(el).color), background),
            background,
            surround,
            ring,
        };
    });
}

/** WCAG 2 contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
    const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

test('empty-state drop zone draws a focus ring when the keyboard reaches it', async ({ page }) => {
    await page.goto('/');
    const input = page.getByLabel('Choose files to send');
    await expect(input).toBeAttached();
    for (let i = 0; i < 20 && !(await input.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
    }
    expect(await input.evaluate((el) => el === document.activeElement && el.matches(':focus-visible'))).toBe(true);

    const zone = input.locator('..');
    await expect
        .poll(
            async () => {
                const { ring, surround } = await seen(zone);
                return ring ? contrast(ring, surround) : 0;
            },
            { message: 'empty drop zone focus ring against the card', timeout: 5_000 }
        )
        .toBeGreaterThanOrEqual(3);
});

test('Add more files strip and Network relay fallback checkbox draw focus rings when keyboard reaches them', async ({ page }) => {
    await page.goto('/');
    await page
        .locator('input[type=file]:not([webkitdirectory])')
        .first()
        .setInputFiles({ name: 'focus.txt', mimeType: 'text/plain', buffer: Buffer.from('focus') });

    const addMoreInput = page.getByLabel('Add more files to send');
    await expect(addMoreInput).toBeAttached();
    for (let i = 0; i < 20 && !(await addMoreInput.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
    }
    expect(await addMoreInput.evaluate((el) => el === document.activeElement && el.matches(':focus-visible'))).toBe(true);

    const strip = addMoreInput.locator('..');
    await expect
        .poll(
            async () => {
                const { ring, surround } = await seen(strip);
                return ring ? contrast(ring, surround) : 0;
            },
            { message: 'Add more files strip focus ring against the card', timeout: 5_000 }
        )
        .toBeGreaterThanOrEqual(3);

    const relayCheckbox = page.getByRole('checkbox', { name: 'Network relay fallback' });
    await expect(relayCheckbox).toBeAttached();
    for (let i = 0; i < 20 && !(await relayCheckbox.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
    }
    expect(await relayCheckbox.evaluate((el) => el === document.activeElement && el.matches(':focus-visible'))).toBe(true);

    const relayBox = relayCheckbox.locator('xpath=following-sibling::div[1]');
    await expect
        .poll(
            async () => {
                const { ring, surround } = await seen(relayBox);
                return ring ? contrast(ring, surround) : 0;
            },
            { message: 'Network relay fallback box focus ring against the card', timeout: 5_000 }
        )
        .toBeGreaterThanOrEqual(3);
});

test('Contribute to global stats checkbox draws a focus ring when keyboard reaches it', async ({ page }) => {
    await page.goto(`/#room=${randomUUID()}`);
    const statsCheckbox = page.getByRole('checkbox', { name: 'Contribute to global stats' });
    await expect(statsCheckbox).toBeAttached();
    for (let i = 0; i < 20 && !(await statsCheckbox.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
    }
    expect(await statsCheckbox.evaluate((el) => el === document.activeElement && el.matches(':focus-visible'))).toBe(true);

    const statsBox = statsCheckbox.locator('xpath=following-sibling::div[1]');
    await expect
        .poll(
            async () => {
                const { ring, surround } = await seen(statsBox);
                return ring ? contrast(ring, surround) : 0;
            },
            { message: 'Contribute to global stats box focus ring against the card', timeout: 5_000 }
        )
        .toBeGreaterThanOrEqual(3);
});

test('mouse click on checkbox draws no focus ring', async ({ page }) => {
    await page.goto(`/#room=${randomUUID()}`);
    const label = page.getByText('Contribute to global stats', { exact: true });
    await expect(label).toBeVisible();
    await label.click();
    await page.waitForTimeout(300);

    const checkbox = page.getByRole('checkbox', { name: 'Contribute to global stats' });
    const box = checkbox.locator('xpath=following-sibling::div[1]');
    const { ring } = await seen(box);
    expect(ring, 'no focus ring on checkbox after mouse click').toBeNull();
});

