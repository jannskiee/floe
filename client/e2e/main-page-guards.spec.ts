/**
 * What the main page does with a careless click or a stray drop: the leave
 * prompt while something depends on the tab, the window's own drop guard, a
 * dropped folder refused at the drop, and the in-app browser card when its
 * Copy cannot reach the clipboard.
 *
 * A browser shows a beforeunload prompt only after a person has used the
 * page, so every prompt cell clicks something first, as a person would have.
 * Receivers stay out of the stats counter with their toggle stored off.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { browserSenderSetup, createFixture, sha256OfBlobUrl } from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-main-page-guards');

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function optedOutContext(ctx: BrowserContext): Promise<BrowserContext> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    return ctx;
}

/** Clicks `target` and reports whether the page asked first. The prompt is
 *  dismissed, so a page that asks stays where it is. */
async function clickAsks(page: Page, target: Locator): Promise<boolean> {
    let asked = false;
    const onDialog = (dialog: import('@playwright/test').Dialog) => {
        if (dialog.type() === 'beforeunload') asked = true;
        void dialog.dismiss();
    };
    page.on('dialog', onDialog);
    try {
        await target.click({ noWaitAfter: true });
        await page.waitForTimeout(1_500);
    } finally {
        page.off('dialog', onDialog);
    }
    return asked;
}

/** Runs a history traversal and reports whether the page asked first. The
 *  prompt is dismissed, which cancels the traversal, so `go` never settles
 *  and its timeout is expected. */
async function traversalAsks(page: Page, go: () => Promise<unknown>): Promise<boolean> {
    let asked = false;
    const onDialog = (dialog: import('@playwright/test').Dialog) => {
        if (dialog.type() === 'beforeunload') asked = true;
        void dialog.dismiss();
    };
    page.on('dialog', onDialog);
    try {
        await go().catch(() => null);
        await page.waitForTimeout(1_000);
    } finally {
        page.off('dialog', onDialog);
    }
    return asked;
}

/** The Floe wordmark, a full reload by design. */
async function wordmarkAsks(page: Page): Promise<boolean> {
    return clickAsks(page, page.getByRole('button', { name: 'Floe home' }));
}

/** The navbar's Download pill, a next/link: an in-app navigation, which
 *  unloads nothing unless the page turns it into a full load (W2-01). */
async function downloadPillAsks(page: Page): Promise<boolean> {
    return clickAsks(page, page.locator('a[data-umami-event="nav-download"]'));
}

/** Drops one file on the page outside any drop zone and reports whether the
 *  page refused it (the browser's default is to open the file in the tab). */
async function strayDropRefused(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['stray'], 'stray.txt', { type: 'text/plain' }));
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
        document.body.dispatchEvent(over);
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        document.body.dispatchEvent(drop);
        return over.defaultPrevented && drop.defaultPrevented;
    });
}

test('the page asks before it is left while a link is out or files are unsaved', async ({ browser }) => {
    const { path: fixturePath, sha256 } = createFixture(FIXTURE_DIR, 64 * 1024);
    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, fixturePath);

        // A link is out and nobody has it yet: leaving cancels it, by a reload
        // or by an in-app link alike.
        expect(await wordmarkAsks(senderPage)).toBe(true);
        await expect(senderPage.locator('code').filter({ hasText: '#room=' })).toBeVisible();
        expect(await downloadPillAsks(senderPage)).toBe(true);
        await expect(senderPage).not.toHaveURL(/\/download/);
        await expect(senderPage.locator('code').filter({ hasText: '#room=' })).toBeVisible();
        expect(await strayDropRefused(senderPage)).toBe(true);

        await receiverPage.goto(link);
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });
        expect(await sha256OfBlobUrl(receiverPage, (await downloadLink.getAttribute('href'))!)).toBe(sha256);
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });

        // The received file lives in the tab until it is saved.
        await receiverPage.getByText('Receive', { exact: true }).click();
        expect(await wordmarkAsks(receiverPage)).toBe(true);
        await expect(downloadLink).toBeVisible();
        expect(await strayDropRefused(receiverPage)).toBe(true);

        // Delivered: nothing on the sending side depends on the tab now.
        expect(await wordmarkAsks(senderPage)).toBe(false);

        // Saved from its own link, with nothing more coming: the receiving
        // page lets go too (W2-02).
        const [download] = await Promise.all([receiverPage.waitForEvent('download'), downloadLink.click()]);
        await download.delete();
        expect(await wordmarkAsks(receiverPage)).toBe(false);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('Back still asks when the page was reached by an in-app link', async ({ page }) => {
    // A next/link into the main page made it a soft hop inside one document,
    // so Back left it the same way and beforeunload never ran: a link that
    // was out vanished with no question. The links into the main page are
    // plain anchors now (opensMainPage in lib/pageGuards.ts), so Back unloads.
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 16 * 1024);
    await page.goto('/how-it-works');
    await page.locator('footer').getByRole('link', { name: 'Floe', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.locator('button', { hasText: /create secure link/i }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });

    expect(await traversalAsks(page, () => page.goBack({ timeout: 3_000 }))).toBe(true);
    await expect(linkEl).toBeVisible();
});

test('Forward still asks after a hop back to the page', async ({ page }) => {
    // A link out of the main page was a soft hop while nothing was held, so
    // after Back the main page had a same-document entry after it, and
    // Forward from a page holding a link left the same way (review N1). Every
    // in-app link out of the main page now loads in full.
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 16 * 1024);
    await page.goto('/');
    await page.locator('footer').getByRole('link', { name: 'How It Works', exact: true }).click();
    await expect(page).toHaveURL(/\/how-it-works$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.locator('button', { hasText: /create secure link/i }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });

    expect(await traversalAsks(page, () => page.goForward({ timeout: 3_000 }))).toBe(true);
    await expect(linkEl).toBeVisible();
});

test("the footer's Floe link on the main page keeps files not yet sent", async ({ page }) => {
    // A next/link to the page you are on kept the page and went to the top.
    // As a plain anchor it would reload and drop the files, with no prompt
    // before Create (review N2), so the main page keeps the old behavior.
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 16 * 1024);
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    const listed = page.getByText(basename(fixturePath)).first();
    await expect(listed).toBeVisible();
    await page.evaluate(() => {
        (window as unknown as { floeSameDocument?: boolean }).floeSameDocument = true;
    });

    await page.locator('footer').getByRole('link', { name: 'Floe', exact: true }).click();
    await page.waitForTimeout(1_000);
    expect(await page.evaluate(() => (window as unknown as { floeSameDocument?: boolean }).floeSameDocument)).toBe(true);
    await expect(listed).toBeVisible();
    // The site scrolls smoothly, so the top is reached a moment after the click.
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBe(0);
});

test('a folder dropped on the Send page is refused at the drop', async ({ page }) => {
    await page.goto('/');
    const zone = page.getByText('Drop files or click to browse');
    await expect(zone).toBeVisible();

    // What Chromium hands a page for a dropped folder: an entry that is a
    // directory, and in the file list a pseudo-file whose read fails later.
    await zone.evaluate((el) => {
        const folder = new File([new Uint8Array(4096)], 'photos');
        const dataTransfer = {
            types: ['Files'],
            files: [folder],
            items: [{
                kind: 'file',
                type: '',
                getAsFile: () => folder,
                webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name: 'photos' }),
            }],
            dropEffect: 'none',
        };
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
        el.dispatchEvent(drop);
    });

    await expect(page.getByText('Folders cannot be sent from this page. Add the files inside it, or zip it first.')).toBeVisible();
    await expect(page.locator('button', { hasText: /create secure link/i })).toHaveCount(0);
});

test('the in-app browser card shows the link and says when Copy fails', async ({ browser }) => {
    const ctx = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 309.0.0.40.113',
        viewport: { width: 390, height: 844 },
    });
    // A webview that blocks both ways of copying.
    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: () => Promise.reject(new Error('blocked')) },
            configurable: true,
        });
        document.execCommand = () => false;
    });
    const page = await ctx.newPage();

    try {
        await page.goto('/?s=e2e#room=00000000-0000-4000-8000-000000000000');
        await expect(page.getByRole('heading', { name: 'Open in your browser' })).toBeVisible();

        // The address is on the card for a manual copy.
        const shown = page.getByText(page.url(), { exact: true });
        await expect(shown).toBeVisible();

        await page.getByRole('button', { name: /Copy link/ }).click();
        await expect(page.getByText('Couldn’t copy. Press and hold the link above to copy it.')).toBeVisible();
        await expect(page.getByText('Link copied')).toHaveCount(0);
    } finally {
        await ctx.close();
    }
});
