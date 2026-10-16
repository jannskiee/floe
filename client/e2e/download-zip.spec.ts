/**
 * Download ZIP on the receiving page, end to end: the archive the browser
 * saves holds every received file byte for byte, under the names the page
 * gives them (a second `.env` is `.env (1)`, #615), and a file larger than
 * one 4 MiB read goes in whole (lib/zipWriter.ts reads in slices).
 *
 * Small on purpose. The multi-gigabyte run is a hand cell in a persistent
 * context: a fresh browser.newContext() keeps every Blob in memory (about
 * 2 GiB, the FLOE-Q limit), so it would only measure the out-of-memory stop.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { unzipSync } from 'fflate';
import { writeRandomFile } from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-download-zip');

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function optedOutContext(ctx: BrowserContext): Promise<BrowserContext> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    return ctx;
}

async function senderSetup(page: Page, paths: string[]): Promise<string> {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(paths);
    await page.locator('button', { hasText: /create secure link/i }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    return (await linkEl.textContent())!.trim();
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('Download ZIP saves every file whole, a second .env numbered at its end', async ({ browser }) => {
    // Two files named .env from two folders: the sending page sends both
    // under that one name, as a person picking them would.
    mkdirSync(join(FIXTURE_DIR, 'a'), { recursive: true });
    mkdirSync(join(FIXTURE_DIR, 'b'), { recursive: true });
    const sent = [
        { path: join(FIXTURE_DIR, 'a', '.env'), size: 300 },
        { path: join(FIXTURE_DIR, 'b', '.env'), size: 301 },
        { path: join(FIXTURE_DIR, 'a', 'photo.bin'), size: 6 * 1024 * 1024 + 7 },
    ].map((f) => ({ ...f, sha256: writeRandomFile(f.path, f.size) }));

    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    try {
        const link = await senderSetup(sender, sent.map((f) => f.path));
        await receiver.goto(link);
        await expect(receiver.locator('a[download]')).toHaveCount(3, { timeout: 60_000 });
        await expect(sender.getByText('All Files Sent!').first()).toBeVisible({ timeout: 30_000 });

        const zipButton = receiver.getByRole('button', { name: /^Download ZIP$/ });
        await expect(zipButton).toBeEnabled();
        const [download] = await Promise.all([receiver.waitForEvent('download'), zipButton.click()]);
        expect(download.suggestedFilename()).toMatch(/^floe_transfer_\d+\.zip$/);
        const zipPath = join(FIXTURE_DIR, 'saved.zip');
        await download.saveAs(zipPath);

        const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
        expect(Object.keys(entries).sort()).toEqual(['.env', '.env (1)', 'photo.bin']);
        expect(sha256(entries['.env'])).toBe(sent[0].sha256);
        expect(sha256(entries['.env (1)'])).toBe(sent[1].sha256);
        expect(sha256(entries['photo.bin'])).toBe(sent[2].sha256);

        await expect(receiver.getByText(/ZIP creation failed|could not be included in ZIP/)).toHaveCount(0);
        await expect(zipButton).toBeEnabled();
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
