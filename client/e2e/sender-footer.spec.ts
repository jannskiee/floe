/**
 * The line at the foot of a sending page's card. "Keep this tab open and in
 * front. Closing it cancels the transfer." is for a tab a send still depends
 * on, so it holds while the leave prompt does (senderTabMatters in
 * lib/sendSummary.ts). Once the send is over, the line reads "End-to-end
 * encrypted. Files are never stored on a server." again. A send that failed
 * is in send-status.spec.ts.
 */

import { test, expect } from '@playwright/test';
import { browserSenderSetup } from './helpers';

const KEEP_OPEN = 'Keep this tab open and in front. Closing it cancels the transfer.';
const ENCRYPTED = 'End-to-end encrypted. Files are never stored on a server.';

test('the keep-open line shows while the link waits and lets go once the send is delivered', async ({ browser }) => {
    const senderCtx = await browser.newContext();
    // "Contribute to global stats" off, as every receiving page in the suite.
    const receiverCtx = await browser.newContext();
    await receiverCtx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await browserSenderSetup(senderPage, {
            name: 'small-file.bin',
            mimeType: 'application/octet-stream',
            buffer: Buffer.alloc(1024, 7),
        });
        // The link is out and nobody has taken it yet: closing the tab would
        // cancel the transfer.
        await expect(senderPage.getByText(KEEP_OPEN)).toBeVisible();
        await expect(senderPage.getByText(ENCRYPTED)).toHaveCount(0);

        await receiverPage.goto(link);
        await expect(receiverPage.locator('a[download]').first()).toBeVisible({ timeout: 30_000 });
        await expect(senderPage.getByText('All Files Sent!').first()).toBeVisible({ timeout: 10_000 });

        // Delivered: nothing depends on the tab any more.
        await expect(senderPage.getByText(ENCRYPTED)).toBeVisible({ timeout: 5_000 });
        await expect(senderPage.getByText(KEEP_OPEN)).toHaveCount(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
