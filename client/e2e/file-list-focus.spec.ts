import { test, expect, type Page } from '@playwright/test';

// The Send page's file list and its two drop zones each take away the control
// that holds focus. Remove takes its own row, and with it the button that was
// pressed. The first pick swaps the empty drop zone's "Choose files to send"
// for the "Add more files to send" strip, and removing the last file swaps
// them back. With nothing to move focus, it fell to the page body: until the
// next Tab, Enter and Space did nothing and a screen reader had no control.
//
// Focus moves only for the person whose control went away. A Remove pressed
// while it did not hold focus, a pick made while Choose files did not hold it,
// and a drop move nothing, focus held somewhere else stays there, and a mouse
// user gets no focus ring.

const file = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
const THREE = [file('a.txt'), file('b.txt'), file('c.txt')];

const chooseFiles = (page: Page) => page.getByLabel('Choose files to send');
const addMore = (page: Page) => page.getByLabel('Add more files to send');
const remove = (page: Page, name: string) => page.getByRole('button', { name: `Remove ${name}` });
const removeButtons = (page: Page) => page.getByRole('button', { name: /^Remove / });

/** Whether the page body holds focus, which is where it lands when the focused
 *  control is removed and nothing moves it. */
const bodyHasFocus = (page: Page) => page.evaluate(() => document.activeElement === document.body);

/** Waits for focus to land on a control, and fails with "focus fell to the page"
 *  while the page body keeps it. */
const focusNotOnPage = (page: Page) =>
    expect.poll(() => bodyHasFocus(page), { message: 'focus fell to the page', timeout: 2_000 }).toBe(false);

/** Lets the render that changed the list run its effects before focus is read,
 *  so a test that expects no move cannot pass ahead of one. */
const settle = (page: Page) =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));

/** Whether the focused element draws its focus ring. */
const focusRingShown = (page: Page) =>
    page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

/** Drops one file on the empty drop zone, as a drag from the desktop does. */
const dropOneFile = (page: Page) =>
    page.getByText('Drop files or click to browse').evaluate((el) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

test('Enter on Remove moves focus to the Remove of the row that took its place', async ({ page }) => {
    await page.goto('/');
    await chooseFiles(page).setInputFiles(THREE);
    await remove(page, 'b.txt').focus();
    await page.keyboard.press('Enter');

    await expect(removeButtons(page)).toHaveCount(2);
    await focusNotOnPage(page);
    await expect(remove(page, 'c.txt')).toBeFocused({ timeout: 2_000 });
    expect(await focusRingShown(page)).toBe(true);
});

test('Enter on the last row\'s Remove moves focus to the Remove above it', async ({ page }) => {
    await page.goto('/');
    await chooseFiles(page).setInputFiles(THREE);
    await remove(page, 'c.txt').focus();
    await page.keyboard.press('Enter');

    await expect(removeButtons(page)).toHaveCount(2);
    await focusNotOnPage(page);
    await expect(remove(page, 'b.txt')).toBeFocused({ timeout: 2_000 });
});

test('Enter on the only file\'s Remove moves focus to Choose files to send', async ({ page }) => {
    await page.goto('/');
    await chooseFiles(page).setInputFiles(file('a.txt'));
    await remove(page, 'a.txt').focus();
    await page.keyboard.press('Enter');

    await focusNotOnPage(page);
    await expect(chooseFiles(page)).toBeFocused({ timeout: 2_000 });
});

test('a keyboard pick from the empty drop zone moves focus to Add more files', async ({ page }) => {
    // Waited for from before the page loads: Playwright turns on its file
    // dialog interception without waiting, and a press made right after the
    // wait started opened the dialog before it was on in 1 run of 8.
    const chooser = page.waitForEvent('filechooser');
    await page.goto('/');
    await chooseFiles(page).focus();
    // Space: Chromium opens a file input's chooser on Space, not on Enter.
    await page.keyboard.press('Space');
    await (await chooser).setFiles(file('a.txt'));

    await expect(remove(page, 'a.txt')).toBeVisible();
    await focusNotOnPage(page);
    await expect(addMore(page)).toBeFocused({ timeout: 2_000 });
    expect(await focusRingShown(page)).toBe(true);
});

test('a pick made while Choose files does not hold focus moves no focus', async ({ page }) => {
    await page.goto('/');
    await chooseFiles(page).setInputFiles(file('a.txt'));

    await expect(remove(page, 'a.txt')).toBeVisible();
    await settle(page);
    expect(await bodyHasFocus(page)).toBe(true);
});

test('a drop on the empty drop zone moves no focus', async ({ page }) => {
    await page.goto('/');
    await dropOneFile(page);

    await expect(remove(page, 'dropped.txt')).toBeVisible();
    await settle(page);
    expect(await bodyHasFocus(page)).toBe(true);
});

test('Remove pressed while it does not hold focus moves no focus', async ({ page }) => {
    await page.goto('/');
    await chooseFiles(page).setInputFiles(THREE);
    // A click event with no focus change, as a Safari mouse click gives.
    await remove(page, 'b.txt').dispatchEvent('click');

    await expect(removeButtons(page)).toHaveCount(2);
    await settle(page);
    expect(await bodyHasFocus(page)).toBe(true);
});

test('focus held elsewhere when the last file is removed stays there', async ({ page }) => {
    await page.goto('/');
    await chooseFiles(page).setInputFiles(file('a.txt'));
    await page.getByRole('button', { name: 'Floe home' }).focus();
    await remove(page, 'a.txt').dispatchEvent('click');

    await expect(chooseFiles(page)).toBeAttached();
    await settle(page);
    await expect(page.getByRole('button', { name: 'Floe home' })).toBeFocused({ timeout: 2_000 });
});

test('a mouse pick and mouse clicks on Remove draw no focus ring', async ({ page }) => {
    // From before the page loads, as in the keyboard pick above.
    const chooser = page.waitForEvent('filechooser');
    await page.goto('/');
    await chooseFiles(page).click();
    await (await chooser).setFiles([file('a.txt'), file('b.txt')]);
    await expect(removeButtons(page)).toHaveCount(2);
    await settle(page);
    expect(await focusRingShown(page)).toBe(false);

    await remove(page, 'a.txt').click();
    await expect(removeButtons(page)).toHaveCount(1);
    await settle(page);
    expect(await focusRingShown(page)).toBe(false);

    await remove(page, 'b.txt').click();
    await expect(chooseFiles(page)).toBeAttached();
    await settle(page);
    expect(await focusRingShown(page)).toBe(false);
});
