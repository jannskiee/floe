import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Each row of the two file lists carries a tooltip with the whole file name,
// placed under the name and transparent until hover. While the lists were
// always scroll boxes, that transparent box counted toward the scrollable
// height, so a list that fit had something to scroll: measured with one file,
// scrollHeight 89 against clientHeight 66 on the receiving page and 83 against
// 58 on the sending page. The receiving page scrolls its list to the bottom
// after each file lands, so its first row lost 23 px off the top, and both
// lists drew a scrollbar beside a single row. See lib/fileListScroll.ts.

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-list-scroll');

test.afterAll(() => {
    try {
        rmSync(FIXTURE_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
});

function fixtures(count: number): string[] {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    return Array.from({ length: count }, (_, i) => {
        const path = join(FIXTURE_DIR, `list-scroll-${count}-${i + 1}.bin`);
        writeFileSync(path, randomBytes(2048));
        return path;
    });
}

async function senderSetup(page: Page, paths: string[]): Promise<string> {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(paths);
    await page.locator('button', { hasText: /create secure link/i }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    return (await linkEl.textContent())!.trim();
}

/** The box that holds the file rows: the innermost spaced box around a name. */
const fileList = (page: Page, name: string) =>
    page.locator('.space-y-3', { has: page.getByText(name, { exact: true }) }).last();

/**
 * How far the list can really be scrolled: 0 when it cannot. Asked of the
 * browser by trying, because scrollHeight counts the tooltip under the last
 * row whether or not the box scrolls, so it cannot answer the question.
 */
const maxScroll = (list: Locator) =>
    list.evaluate((el) => {
        const before = el.scrollTop;
        el.scrollTop = 1_000_000;
        const max = el.scrollTop;
        el.scrollTop = before;
        return max;
    });

/**
 * Every ancestor that cuts into the element's box. toBeVisible() cannot say
 * this: a box clipped to a sliver by a scroll container still counts as visible.
 */
const clippedBy = (el: Locator) =>
    el.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const clippers: string[] = [];
        for (let a = node.parentElement; a && a !== document.body; a = a.parentElement) {
            const style = getComputedStyle(a);
            if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
            const within = a.getBoundingClientRect();
            if (
                box.top < within.top - 0.5 ||
                box.bottom > within.bottom + 0.5 ||
                box.left < within.left - 0.5 ||
                box.right > within.right + 0.5
            ) {
                clippers.push(a.className.toString().slice(0, 80) || a.tagName);
            }
        }
        return clippers;
    });

test('a file list that fits has nothing to scroll, and the name tooltip shows whole on hover', async ({ browser }) => {
    const [fixturePath] = fixtures(1);
    const name = 'list-scroll-1-1.bin';

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    try {
        const link = await senderSetup(sender, [fixturePath]);

        for (const [who, page] of [['sending', sender], ['receiving', receiver]] as const) {
            if (page === receiver) {
                await receiver.goto(link);
                await expect(receiver.locator('a[download]')).toHaveCount(1, { timeout: 30_000 });
            }
            // The name is in each row twice: the visible line, then its tooltip.
            const list = fileList(page, name);
            const names = list.getByText(name, { exact: true });
            await expect(names).toHaveCount(2);
            const tooltip = names.nth(1);

            // With nothing to scroll, the scroll to the bottom that follows
            // each received file cannot move the first row out of place.
            expect(await maxScroll(list), `${who} page: how far a one-row list scrolls`).toBe(0);
            expect(await list.evaluate((el) => el.scrollTop)).toBe(0);

            await expect(tooltip).toHaveCSS('opacity', '0');
            await names.first().hover();
            await expect(tooltip).toHaveCSS('opacity', '1');
            expect(await clippedBy(tooltip), `${who} page: what clips the tooltip of the only row`).toEqual([]);
            // And showing it gives the list nothing to scroll either.
            expect(await maxScroll(list), `${who} page: how far the list scrolls while the tooltip shows`).toBe(0);
        }
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('a received list too long to fit still scrolls, and follows the newest file', async ({ browser }) => {
    const paths = fixtures(6);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    try {
        const link = await senderSetup(sender, paths);
        await receiver.goto(link);
        await expect(receiver.locator('a[download]')).toHaveCount(6, { timeout: 30_000 });

        const list = fileList(receiver, 'list-scroll-6-1.bin');
        // The page scrolls to the bottom 100 ms after each file lands, smoothly.
        // Read first and probed after: setting scrollTop would cancel that scroll.
        await expect
            .poll(() => list.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)))
            .toBeLessThanOrEqual(1);
        expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(await maxScroll(list)).toBeGreaterThan(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
