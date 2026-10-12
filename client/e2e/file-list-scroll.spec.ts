import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Each row of the two file lists carries a tooltip with the whole file name,
// placed under the name. While it was only transparent it still counted toward
// its list's scrollable height, so a list that fit had something to scroll:
// measured with one file, scrollHeight 89 against clientHeight 66 on the
// receiving page and 83 against 58 on the sending page. The receiving page
// scrolls its list to the bottom after each file lands, so its first row lost
// 23 px off the top, and both lists drew a scrollbar beside a single row.

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-list-scroll');
const FILE_NAME = 'list-scroll.bin';

test.afterAll(() => {
    try {
        rmSync(FIXTURE_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
});

async function senderSetup(page: Page, fixturePath: string): Promise<string> {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.locator('button', { hasText: /create secure link/i }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    return (await linkEl.textContent())!.trim();
}

/** How far the list can scroll: 0 when everything in it fits. */
const scrollRange = (list: Locator) => list.evaluate((el) => el.scrollHeight - el.clientHeight);

/** The scrolling list that holds the file rows, found from a row's name:
 *  other boxes on the page share its scrollbar class. */
const fileList = (page: Page) =>
    page
        .getByText(FILE_NAME, { exact: true })
        .first()
        .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " overflow-y-auto ")][1]');

test('a file list that fits has nothing to scroll, and the name tooltip still shows on hover', async ({ browser }) => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const fixturePath = join(FIXTURE_DIR, FILE_NAME);
    writeFileSync(fixturePath, randomBytes(2048));

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    try {
        const link = await senderSetup(sender, fixturePath);

        // The name is in each row twice: the visible line, then its tooltip.
        const senderList = fileList(sender);
        const senderName = senderList.getByText(FILE_NAME, { exact: true });
        await expect(senderName).toHaveCount(2);
        expect(await scrollRange(senderList), 'sending page: scroll range of a one-row list').toBe(0);
        await expect(senderName.nth(1)).toBeHidden();
        await senderName.first().hover();
        await expect(senderName.nth(1)).toBeVisible();

        await receiver.goto(link);
        await expect(receiver.locator('a[download]')).toHaveCount(1, { timeout: 30_000 });

        const receiverList = fileList(receiver);
        const receiverName = receiverList.getByText(FILE_NAME, { exact: true });
        await expect(receiverName).toHaveCount(2);
        // With nothing to scroll, the scroll to the bottom that follows each
        // file cannot move the first row out of view.
        expect(await scrollRange(receiverList), 'receiving page: scroll range of a one-row list').toBe(0);
        expect(await receiverList.evaluate((el) => el.scrollTop)).toBe(0);
        await expect(receiverName.nth(1)).toBeHidden();
        await receiverName.first().hover();
        await expect(receiverName.nth(1)).toBeVisible();
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
