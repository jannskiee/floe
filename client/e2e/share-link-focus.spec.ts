import { test, expect, type Page } from '@playwright/test';
import { SHARE_LINK_TEXT } from './helpers';

// Pressing Create secure link removes the button that holds focus, and the
// link panel mounts above the place it held. With nothing to move focus, it
// fell to the page body: Chrome's next Tab went past the panel to the page
// below the card, and a screen reader heard nothing about the link.
//
// Focus moves only for the person whose control went away. A create made
// while Create did not hold focus moves nothing, and a mouse click on Create
// draws no focus ring.

const FILE = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') };

const shareLink = (page: Page) => page.locator('code').filter({ hasText: SHARE_LINK_TEXT });
const createButton = (page: Page) => page.getByRole('button', { name: /create secure link/i });

/** Whether the page body holds focus, which is where it lands when the focused
 *  control is removed and nothing moves it. */
const bodyHasFocus = (page: Page) => page.evaluate(() => document.activeElement === document.body);

/** Lets the render that showed the link run its effects before focus is read,
 *  so a test that expects no move cannot pass ahead of one. */
const settle = (page: Page) =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));

/** Whether the focused element draws its focus ring. */
const focusRingShown = (page: Page) =>
    page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

test('Enter on Create secure link moves focus to Copy link', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(FILE);
    await createButton(page).focus();
    await page.keyboard.press('Enter');

    await expect(shareLink(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeFocused({ timeout: 2_000 });
    expect(await focusRingShown(page)).toBe(true);
});

test('Create pressed while it does not hold focus moves no focus', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(FILE);
    // A click event with no focus change, as a Safari mouse click gives.
    await createButton(page).dispatchEvent('click');

    await expect(shareLink(page)).toBeVisible({ timeout: 10_000 });
    await settle(page);
    expect(await bodyHasFocus(page)).toBe(true);
});

test('focus taken elsewhere while the link is made stays there', async ({ page }) => {
    // No Socket.IO, so the link waits for the 3 s fallback (e2e/pending-link.spec.ts).
    await page.route('**/socket.io/**', (route) => route.abort());
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(FILE);
    await createButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Creating secure link...')).toBeVisible({ timeout: 2_000 });

    await page.keyboard.press('Tab');
    expect(await bodyHasFocus(page)).toBe(false);
    await page.evaluate(() => document.activeElement?.setAttribute('data-focus-away', ''));

    await expect(shareLink(page)).toBeVisible({ timeout: 10_000 });
    await settle(page);
    await expect(page.locator('[data-focus-away]')).toBeFocused({ timeout: 2_000 });
});

test('a mouse click on Create draws no focus ring', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(FILE);
    await createButton(page).click();

    await expect(shareLink(page)).toBeVisible({ timeout: 10_000 });
    await settle(page);
    expect(await focusRingShown(page)).toBe(false);
});
