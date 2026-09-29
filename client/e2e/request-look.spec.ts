import { test, expect, type Locator, type Page } from '@playwright/test';
import { sendLabel, visitorCopy } from '../lib/request/visitorCopy';

// ---------------------------------------------------------------------------
// The /r visitor page's colors, measured in the browser.
//
// Every other /r spec finds a button by its accessible name, which ignores
// color, so a page whose buttons could not be read passed them all. That page
// shipped to CP-UI: nothing on /r set .dark, so the shadcn Button read the
// light :root tokens. Choose files and every other outline button were
// near-white slabs under the shell's near-white text (about 1.03:1), Send was
// near-black on the near-black card, and the Hide my IP checkbox was a bright
// white square (R4 F1 and F2, 01-visitor-open.png).
//
// No host is needed: Ready, with and without a picked file, is reachable from
// the link alone. The other outline buttons (Try again, Back to files, Cancel,
// Keep sending, Stop) share the variant measured here, and
// lib/request/requestShell.test.ts pins the class that themes all of them.
// ---------------------------------------------------------------------------

const LINK = '/r/AAAAAAAAAAA#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

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
        // fillStyle ignores a color it cannot parse and keeps the old one, so
        // an unreadable value would be measured as whatever was set before,
        // opaque black at first, and a check could pass on a color nobody
        // read. It is set to a sentinel no /r surface uses first, and a value
        // that leaves the sentinel in place fails the test.
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
            // A page with no opaque background shows the canvas, which is white.
            let color: [number, number, number] = [255, 255, 255];
            for (const layer of layers.reverse()) color = over(layer, color);
            return color;
        };
        const background = behind(el);
        const surround = behind(el.parentElement);
        // Tailwind draws the ring as a box-shadow spread around the border box,
        // so it lies on the surround. The computed value lists each shadow as
        // its color, then x, y, blur and spread; the ring is the widest spread
        // with no offset and no blur that has any alpha.
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

async function expectReadable(page: Page, name: string | RegExp) {
    const button = page.getByRole('button', { name, exact: typeof name === 'string' });
    await expect(button).toBeVisible();
    const { text, background } = await seen(button);
    // WCAG 1.4.3 AA for body-size text.
    expect(contrast(text, background), `${name}: label on its background`).toBeGreaterThanOrEqual(4.5);
}

test.describe('request look', () => {
    test('every Ready button label is readable, and Send stands out from the card', async ({ page }) => {
        await page.goto(LINK);
        await expect(page.getByText('SEND FILES THROUGH THIS LINK')).toBeVisible();
        // The pointer stays off the buttons: an outline label used to become
        // readable only on hover.
        await page.mouse.move(0, 0);

        await expectReadable(page, visitorCopy.chooseFiles);
        await expectReadable(page, visitorCopy.chooseFolder);

        await page
            .locator('input[type=file]:not([webkitdirectory])')
            .first()
            .setInputFiles({ name: 'look.txt', mimeType: 'text/plain', buffer: Buffer.from('look') });
        await expectReadable(page, sendLabel(1));
        await expectReadable(page, visitorCopy.clear);

        // The primary is a filled button. On the dark card it must read as
        // one: WCAG 1.4.11 asks 3:1 of a component against what is around it.
        const send = await seen(page.getByRole('button', { name: sendLabel(1), exact: true }));
        expect(contrast(send.background, send.surround), 'Send against the card').toBeGreaterThanOrEqual(3);
    });

    test('the keyboard focus ring stands out from the card', async ({ page }) => {
        await page.goto(LINK);
        const button = page.getByRole('button', { name: visitorCopy.chooseFiles, exact: true });
        await expect(button).toBeVisible();
        // Keyboard focus, so :focus-visible, and with it the ring, applies.
        for (let i = 0; i < 20 && !(await button.evaluate((el) => el === document.activeElement)); i++) {
            await page.keyboard.press('Tab');
        }
        expect(await button.evaluate((el) => el.matches(':focus-visible')), 'Choose files has keyboard focus').toBe(true);
        // WCAG 1.4.11: 3:1 against what is around it. The Button's
        // transition-all animates the ring in over 150 ms, so a read right
        // after Tab sees no ring or a faint one: the contrast is polled until
        // it settles. The dark ring token settled at 1.88:1 and never reaches
        // 3; the ice ring RequestShell sets computes to 3.99:1. No ring at all
        // counts as 0.
        await expect
            .poll(
                async () => {
                    const { ring, surround } = await seen(button);
                    return ring ? contrast(ring, surround) : 0;
                },
                { message: 'focus ring against the card', timeout: 5_000 }
            )
            .toBeGreaterThanOrEqual(3);
    });

    test('the Hide my IP checkbox draws in the dark scheme', async ({ page }) => {
        await page.goto(LINK);
        const box = page.getByRole('checkbox', { name: visitorCopy.hideIp });
        await expect(box).toBeVisible();
        // A native control follows color-scheme; with none set, Chromium
        // draws the unchecked box white on this page.
        expect(await box.evaluate((el) => getComputedStyle(el).colorScheme)).toContain('dark');
    });
});
