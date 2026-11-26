import { test, expect, type Locator, type Page } from '@playwright/test';

// The terminal demo on the home page (components/landing/CliTerminal.tsx) and
// the Floe Desktop demo on the home page and /download
// (components/landing/AppWindow.tsx) show Replay once a run has finished.
// Pressing it starts a new run, and the button hid at once with keyboard focus
// still on it: invisible, aria-hidden and out of the tab order for the whole
// run, about 7 s for the terminal and 3.5 s for the desktop demo. A Replay
// button that holds keyboard focus now stays shown (and in the accessibility
// tree) until focus leaves. Otherwise it hides as before: until a run has
// ended, once focus leaves during a run, and always under reduced motion. A
// mouse click fades it for the run, but it is not aria-hidden while focused.

const DEMOS = [
    // key: Enter on one demo and Space on the other, the two keys that press a
    // button. lastFrame: words that only the demo's last frame draws.
    { path: '/', name: 'Replay the transfer demo', key: 'Enter', lastFrame: 'avg 1.3 MB/s' },
    { path: '/download', name: 'Replay the desktop demo', key: 'Space', lastFrame: 'room open' },
];

// Replay is aria-hidden while it is hidden, so it is found by its label, not
// by its role.
const replayButton = (page: Page, name: string) => page.locator(`button[aria-label="${name}"]`);

/** Everything the tests read of Replay, in one go. */
const look = (replay: Locator) =>
    replay.evaluate((el: HTMLElement) => ({
        focused: el === document.activeElement,
        focusVisible: el.matches(':focus-visible'),
        // Hidden from assistive technology, by its own aria-hidden or a wrapper's.
        ariaHidden: el.closest('[aria-hidden="true"]') !== null,
        tabIndex: el.tabIndex,
        opacity: getComputedStyle(el).opacity,
    }));

const HIDDEN = { ariaHidden: true, tabIndex: -1, opacity: '0' };
const SHOWN = { ariaHidden: false, tabIndex: 0, opacity: '1' };

/** The first run starts once most of the demo is in view, and Replay shows
 *  at its end. Replay sits on the demo's top edge, so centering it brings the
 *  demo into view. */
async function firstRunEnds(replay: Locator) {
    await replay.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect.poll(() => look(replay), { message: 'the first run ends', timeout: 20_000 }).toMatchObject(SHOWN);
}

/** From here on the page's timers fire only when the test plays them on, so
 *  a run that starts now stays at its first frame while the test looks at it. */
async function holdTheClock(page: Page) {
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
}

/** Longer than Replay's 150 ms fade. The held run does not move meanwhile. */
const settle = (page: Page) => page.waitForTimeout(400);

for (const demo of DEMOS) {
    test.describe(`Replay on ${demo.path} (${demo.name})`, () => {
        test('pressed from the keyboard, it stays shown until focus leaves it', async ({ page }) => {
            await page.clock.install();
            await page.goto(demo.path);
            const replay = replayButton(page, demo.name);
            // Until a run has ended there is nothing to replay.
            expect(await look(replay), 'before the first run ends').toMatchObject(HIDDEN);
            await firstRunEnds(replay);
            await holdTheClock(page);

            // Reached with Tab, as a keyboard user reaches it.
            await replay.focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await expect(replay).toBeFocused();
            await page.keyboard.press(demo.key);
            await settle(page);
            expect(await look(replay), 'pressed, inside the new run').toMatchObject({
                focused: true,
                focusVisible: true,
                ariaHidden: false,
                opacity: '1',
            });

            // Once focus leaves, it hides for the rest of the run.
            await page.keyboard.press('Tab');
            await settle(page);
            expect(await look(replay), 'after Tab, inside the run').toMatchObject({ focused: false, ...HIDDEN });

            // The run's end shows it again.
            await page.clock.runFor(10_000);
            await expect.poll(() => look(replay), { message: 'after the run' }).toMatchObject(SHOWN);
        });

        // A click focuses the button too, with no focus ring, and a pointer
        // needs no button over the demo while it plays.
        test('clicked with the mouse, it still fades for the run', async ({ page }) => {
            await page.clock.install();
            await page.goto(demo.path);
            const replay = replayButton(page, demo.name);
            await firstRunEnds(replay);
            await holdTheClock(page);

            await replay.click();
            await settle(page);
            expect(await look(replay), 'clicked, inside the new run').toMatchObject({
                focused: true,
                focusVisible: false,
                opacity: '0',
            });
        });

        test('under reduced motion, it never shows', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto(demo.path);
            // The finished demo is drawn at once, with no run.
            await expect(page.getByText(demo.lastFrame)).toBeVisible();
            expect(await look(replayButton(page, demo.name))).toMatchObject({ focused: false, ...HIDDEN });
        });
    });
}
