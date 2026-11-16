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
    /** The outline as drawn over the surround, or null when none is. A
     *  control with no focus style of its own (a text link, a bare icon
     *  button) shows focus through the browser's outline, colored by the base
     *  outline-ring/50 in globals.css. */
    outline: Rgb | null;
    /** The --color-ice token, opaque, as sRGB. */
    ice: Rgb;
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
        let outline: [number, number, number] | null = null;
        const style = getComputedStyle(el);
        if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) {
            const color = rgba(style.outlineColor);
            if (color[3] > 0) outline = over(color, surround);
        }
        const ice = rgba(getComputedStyle(document.documentElement).getPropertyValue('--color-ice').trim());
        return {
            text: over(rgba(style.color), background),
            background,
            surround,
            ring,
            outline,
            ice: [ice[0], ice[1], ice[2]] as [number, number, number],
        };
    });
}

/** Presses Tab until the target holds keyboard focus, and checks that it
 *  draws as keyboard focus. */
async function tabTo(locator: Locator): Promise<void> {
    await expect(locator).toBeAttached();
    for (let i = 0; i < 40 && !(await locator.evaluate((el) => el === document.activeElement)); i++) {
        await locator.page().keyboard.press('Tab');
    }
    expect(await locator.evaluate((el) => el === document.activeElement && el.matches(':focus-visible'))).toBe(true);
}

/** Whether a drawn color is the ice token at the given strength over the
 *  surround, within 8 per channel for rounding. The gray ring token at 50%
 *  misses ice at 50% by about 30 in green and in blue. */
const isIce = (drawn: Rgb, { ice, surround }: Seen, alpha: number) =>
    drawn.every((v, i) => Math.abs(v - (ice[i] * alpha + surround[i] * (1 - alpha))) <= 8);

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

test('Create secure link draws an ice focus ring at 3:1 or more when the keyboard reaches it', async ({ page }) => {
    // The shared Button draws ring-ice/50 since #942; the gray ring it drew
    // before was about 2.7:1 against the card.
    await page.goto('/');
    await page
        .locator('input[type=file]:not([webkitdirectory])')
        .first()
        .setInputFiles({ name: 'focus.txt', mimeType: 'text/plain', buffer: Buffer.from('focus') });

    const create = page.getByRole('button', { name: /create secure link/i });
    await tabTo(create);
    await expect
        .poll(
            async () => {
                const s = await seen(create);
                return s.ring && isIce(s.ring, s, 0.5) ? contrast(s.ring, s.surround) : 0;
            },
            { message: 'Create secure link focus ring, in ice, against the card', timeout: 5_000 }
        )
        .toBeGreaterThanOrEqual(3);
});

/** Whether an element draws an outline 2 px or wider. Windows contrast themes
 *  (forced colors) remove every box-shadow, so a ring alone shows nothing there. */
const outlined = (locator: Locator) =>
    locator.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
    });

/** With keyboard focus held, the control draws no outline outside a contrast
 *  theme, and one at least 2 px wide inside it. Leaves forced colors on. */
async function outlinedOnlyInContrastTheme(drawn: Locator, name: string) {
    const page = drawn.page();
    await page.emulateMedia({ forcedColors: 'none' });
    expect(await outlined(drawn), `${name}, outside a contrast theme`).toBe(false);
    await page.emulateMedia({ forcedColors: 'active' });
    await expect.poll(() => outlined(drawn), { message: name, timeout: 5_000 }).toBe(true);
}

test('in a Windows contrast theme, the drop zones, the relay checkbox and Create secure link still show keyboard focus', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');

    const input = page.getByLabel('Choose files to send');
    await tabTo(input);
    await outlinedOnlyInContrastTheme(input.locator('..'), 'empty drop zone');

    await page
        .locator('input[type=file]:not([webkitdirectory])')
        .first()
        .setInputFiles({ name: 'focus.txt', mimeType: 'text/plain', buffer: Buffer.from('focus') });
    const addMore = page.getByLabel('Add more files to send');
    await tabTo(addMore);
    await outlinedOnlyInContrastTheme(addMore.locator('..'), 'Add more files strip');

    const relay = page.getByRole('checkbox', { name: 'Network relay fallback' });
    await tabTo(relay);
    await outlinedOnlyInContrastTheme(relay.locator('xpath=following-sibling::div[1]'), 'relay checkbox box');

    const create = page.getByRole('button', { name: /create secure link/i });
    await tabTo(create);
    await outlinedOnlyInContrastTheme(create, 'Create secure link');
    // Only keyboard focus draws it: the button shows no outline once focus leaves.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => outlined(create), { message: 'Create secure link without focus', timeout: 5_000 }).toBe(false);
});

test('in a Windows contrast theme, the Contribute to global stats checkbox still shows keyboard focus', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto(`/#room=${randomUUID()}`);
    const stats = page.getByRole('checkbox', { name: 'Contribute to global stats' });
    await tabTo(stats);
    await outlinedOnlyInContrastTheme(stats.locator('xpath=following-sibling::div[1]'), 'stats checkbox box');
});

test('a file\'s Remove and the relay Learn more link draw ice focus outlines at 3:1 or more', async ({ page }) => {
    // Neither has a focus style of its own: the browser's focus outline takes
    // the base outline-ring/50, and the page sets --ring to ice on its
    // children (app/page.tsx). With the gray :root token the outline color
    // was about 2.7:1. Chromium draws this outline (style auto) with a white
    // outer ring of its own as well, which this reads nothing of: what is
    // checked is the color the page chose. Firefox paints auto outlines in
    // its own accent color, so this holds for Chromium (the CI project).
    await page.goto('/');
    await page
        .locator('input[type=file]:not([webkitdirectory])')
        .first()
        .setInputFiles({ name: 'focus.txt', mimeType: 'text/plain', buffer: Buffer.from('focus') });

    for (const [name, control] of [
        ['Remove focus.txt', page.getByRole('button', { name: 'Remove focus.txt' })],
        ['Network relay fallback Learn more', page.locator('a[href="/how-it-works#relay"]', { hasText: 'Learn more' })],
    ] as const) {
        await tabTo(control);
        await expect
            .poll(
                async () => {
                    const s = await seen(control);
                    return s.outline && isIce(s.outline, s, 0.5) ? contrast(s.outline, s.surround) : 0;
                },
                { message: `${name} focus outline, in ice, against what surrounds it`, timeout: 5_000 }
            )
            .toBeGreaterThanOrEqual(3);
    }
});

test('the in-app browser card\'s Copy link draws a solid ice focus outline clear of the button', async ({ browser }) => {
    // A white button: an auto outline's tinted band falls on the white face
    // and barely shows there (1.2:1 in ice). Its own outline, 2 px outside the
    // button, as the Navbar's white pill draws it, sits on the card instead.
    const ctx = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 309.0.0.40.113',
        viewport: { width: 390, height: 844 },
    });
    const page = await ctx.newPage();
    try {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Open in your browser' })).toBeVisible();
        const copy = page.getByRole('button', { name: /Copy link/ });
        await tabTo(copy);
        await expect
            .poll(
                async () => {
                    const s = await seen(copy);
                    const style = await copy.evaluate((el) => {
                        const cs = getComputedStyle(el);
                        return { style: cs.outlineStyle, offset: parseFloat(cs.outlineOffset) };
                    });
                    const solidOutside = style.style === 'solid' && style.offset >= 2;
                    return solidOutside && s.outline && isIce(s.outline, s, 1) ? contrast(s.outline, s.surround) : 0;
                },
                { message: 'Copy link focus outline, solid ice outside the button, against the card', timeout: 5_000 }
            )
            .toBeGreaterThanOrEqual(3);
    } finally {
        await ctx.close();
    }
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

