/**
 * The browser sender's own stops, seen from the other side, and its relay
 * list when the first read of it failed.
 *
 * A file the sender can no longer read is the realistic case of a send that
 * stops on the sending side: picked, then moved or deleted before its turn.
 * Chromium keeps the picked File and fails its read once the file is gone from
 * disk, which is exactly what removing the fixture after Create does.
 *
 * Receivers stay out of the stats counter: the browser with its "Contribute to
 * global stats" toggle stored off.
 */

import { test, expect, type BrowserContext } from '@playwright/test';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFixture, sha256OfBlobUrl, writeRandomFile } from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-sender-stops');

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function optedOutContext(ctx: BrowserContext): Promise<BrowserContext> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    return ctx;
}

test('a sender that cannot read a file tells the receiver why and closes', async ({ browser }) => {
    const first = { path: join(FIXTURE_DIR, 'kept.bin'), sha256: '' };
    first.sha256 = writeRandomFile(first.path, 256 * 1024);
    const second = { path: join(FIXTURE_DIR, 'gone.bin') };
    writeRandomFile(second.path, 256 * 1024);

    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        await senderPage.goto('/');
        await senderPage.locator('input[type="file"]').first().setInputFiles([first.path, second.path]);
        await senderPage.locator('button', { hasText: /create secure link/i }).click();
        const linkEl = senderPage.locator('code').filter({ hasText: '#room=' });
        await expect(linkEl).toBeVisible({ timeout: 10_000 });
        const link = (await linkEl.textContent())!.trim();

        // Gone from disk before its turn: the read fails mid-batch.
        rmSync(second.path);

        await receiverPage.goto(link);
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });
        expect(await sha256OfBlobUrl(receiverPage, (await downloadLink.getAttribute('href'))!)).toBe(first.sha256);

        await expect(senderPage.getByText(/Could not read ".*"/)).toBeVisible({ timeout: 15_000 });
        // The receiver is told, in the sender's fixed words, instead of
        // waiting for the rest for as long as the sending tab stays open.
        await expect(
            receiverPage.getByText('The sender stopped: a file could not be read on their device. Ask them to check it and send again.'),
        ).toBeVisible({ timeout: 15_000 });
        await expect(receiverPage.getByText(/Waiting for the rest/)).toHaveCount(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('a sender whose first read of the relay list failed reads it again before it connects', async ({ browser }) => {
    const file = createFixture(join(FIXTURE_DIR, 'relay-list'), 64 * 1024);

    const senderCtx = await browser.newContext();
    const receiverCtx = await optedOutContext(await browser.newContext());
    let reads = 0;
    await senderCtx.route('**/api/turn-credentials', async (route) => {
        reads += 1;
        // The read at page load fails, as it does while the server is down.
        if (reads === 1) return route.fulfill({ status: 503, body: 'down' });
        return route.continue();
    });
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        await senderPage.goto('/');
        await expect.poll(() => reads, { timeout: 15_000 }).toBe(1);
        await senderPage.locator('input[type="file"]').first().setInputFiles(file.path);
        await senderPage.locator('button', { hasText: /create secure link/i }).click();
        const linkEl = senderPage.locator('code').filter({ hasText: '#room=' });
        await expect(linkEl).toBeVisible({ timeout: 10_000 });

        await receiverPage.goto((await linkEl.textContent())!.trim());
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });
        expect(await sha256OfBlobUrl(receiverPage, (await downloadLink.getAttribute('href'))!)).toBe(file.sha256);

        // The page asked again before it built the connection for this
        // receiver, instead of going on with the STUN-only defaults.
        expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
