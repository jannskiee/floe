import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// The home page header follows the reader: the section button for the part of
// the page in view is drawn filled (the scroll-spy in
// components/layout/Navbar.tsx). It must say so to assistive technology as
// well, with aria-current="location", the token the legal pages' "On this
// page" list uses for the same job (components/legal/LegalToc.tsx).
// ---------------------------------------------------------------------------

test('the home page header marks the section in view with aria-current', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    const about = nav.getByRole('button', { name: 'About', exact: true });
    const faq = nav.getByRole('button', { name: 'FAQ', exact: true });

    // /#faq is where the header's FAQ link lands from every other page. The
    // scroll-spy starts only after hydration, so once FAQ is marked the page
    // is live and the click below is handled.
    await page.goto('/#faq');
    await expect(faq).toHaveAttribute('aria-current', 'location');
    await expect(nav.locator('[aria-current]')).toHaveCount(1);

    // The mark moves with the reader and is never left on the old section.
    await about.click();
    await expect(about).toHaveAttribute('aria-current', 'location');
    await expect(faq).not.toHaveAttribute('aria-current');
    await expect(nav.locator('[aria-current]')).toHaveCount(1);

    // Back at the top the hero fills the band the scroll-spy reads, so no
    // section is current and nothing is marked.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(nav.locator('[aria-current]')).toHaveCount(0);
});

test.describe('a section button', () => {
    const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

    const scrollBehavior = (page: Page) =>
        page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);

    test.beforeEach(async ({ page }) => {
        await page.goto('/#faq');
        await expect(button(page, 'FAQ')).toHaveAttribute('aria-current', 'location');
    });

    test('moves keyboard focus to its section', async ({ page }) => {
        await button(page, 'About').focus();
        await page.keyboard.press('Enter');

        const heading = page.getByRole('heading', { level: 2, name: 'Your files never make a stop.' });

        await expect(heading).toBeFocused();
        await expect(heading).toHaveCSS('outline-style', 'none');

        await page.keyboard.press('Tab');
        await expect(page.getByRole('link', { name: 'Read the overview' })).toBeFocused();
    });

    test('jumps under reduced motion', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(await scrollBehavior(page)).toBe('auto');

        // Read in the click's own task, when a smooth scroll has hardly moved.
        const top = await button(page, 'About').evaluate((el: HTMLElement) => {
            el.click();
            return document.getElementById('about')!.getBoundingClientRect().top;
        });
        expect(top).toBeCloseTo(112, -1); // scroll-mt-28
    });

    test('otherwise scrolls smoothly and lands on its section', async ({ page }) => {
        expect(await scrollBehavior(page)).toBe('smooth');
        await button(page, 'About').click();
        await expect
            .poll(() => page.evaluate(() => document.getElementById('about')!.getBoundingClientRect().top))
            .toBeCloseTo(112, -1);
    });
});
