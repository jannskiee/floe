import { test, expect, type Browser, type Page } from '@playwright/test';
import { SHARE_LINK_TEXT } from './helpers';

// Download All and Download ZIP run for a while: 300 ms a file, or the whole
// archive. While one runs, neither may start a second run, and the one the
// keyboard pressed keeps focus: a focused button that turns disabled drops
// focus to the page. They read as unavailable and ignore a press instead.

const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
const all = (page: Page) => page.getByRole('button', { name: /^(Download All|Downloading\.\.\.)$/ });
const zip = (page: Page) => page.getByRole('button', { name: /^(Download ZIP|Zipping\.\.\.)$/ });

type Probe = { focusName: () => string; seen: string[] };
const focusOn = (page: Page) => page.evaluate(() => (window as unknown as Probe).focusName());
/** Restarts the record of each change of what holds focus. The page samples
 *  it every 10 ms: a focused button that turns disabled keeps focus until the
 *  next rendering update, so one look can miss the fall. */
const watchFocus = (page: Page) =>
    page.evaluate(() => {
        const w = window as unknown as Probe;
        w.seen = [w.focusName()];
    });
const focusSeen = (page: Page) => page.evaluate(() => (window as unknown as Probe).seen);

/** Lets a render and its effects run before focus is read. */
const settle = (page: Page) =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));

/** Holds Download ZIP open: every read of a received file waits 300 ms. */
const slowReads = (page: Page) =>
    page.evaluate(() => {
        const read = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function (this: Blob) {
            return new Promise<ArrayBuffer>((done) => setTimeout(() => done(read.call(this)), 300));
        };
    });

/** A receiving page, opted out of stats, holding NAMES, and the downloads it starts. */
async function received(browser: Browser) {
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    await receiverCtx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
        const w = window as unknown as Probe;
        w.focusName = () => {
            const el = document.activeElement;
            if (!el || el === document.body) return 'BODY';
            return el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName;
        };
        w.seen = [];
        setInterval(() => {
            if (w.seen[w.seen.length - 1] !== w.focusName()) w.seen.push(w.focusName());
        }, 10);
    });
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();
    await sender.goto('/');
    await sender
        .getByLabel('Choose files to send')
        .setInputFiles(NAMES.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
    await sender.getByRole('button', { name: /create secure link/i }).click();
    const link = sender.locator('code').filter({ hasText: SHARE_LINK_TEXT });
    await expect(link).toBeVisible({ timeout: 10_000 });
    await receiver.goto((await link.textContent())!.trim());
    await expect(receiver.locator('a[download]')).toHaveCount(NAMES.length, { timeout: 60_000 });
    await expect(all(receiver)).toHaveText('Download All');
    const downloads: string[] = [];
    receiver.on('download', (d) => downloads.push(d.suggestedFilename()));
    const close = () => Promise.all([senderCtx.close(), receiverCtx.close()]);
    return { receiver, downloads, close };
}

for (const [idle, busy, button, saved] of [
    ['Download All', 'Downloading...', all, NAMES],
    ['Download ZIP', 'Zipping...', zip, [expect.stringMatching(/^floe_transfer_\d+\.zip$/)]],
] as const) {
    test(`${idle} keeps keyboard focus while it runs, and Enter twice starts one run`, async ({ browser }) => {
        const { receiver, downloads, close } = await received(browser);
        try {
            await slowReads(receiver);
            await button(receiver).focus();
            await watchFocus(receiver);
            await receiver.keyboard.press('Enter');
            await receiver.keyboard.press('Enter');
            await expect(button(receiver)).toHaveText(busy);
            await settle(receiver);
            expect(await focusSeen(receiver), `while ${idle} runs`).toEqual([idle, busy]);
            // Unavailable while it runs, as before: announced, and drawn dimmed.
            for (const either of [all(receiver), zip(receiver)]) {
                expect(await either.getAttribute('aria-disabled')).toBe('true');
                await expect(either).toHaveCSS('opacity', '0.5', { timeout: 1_000 });
            }
            await expect(button(receiver)).toHaveText(idle, { timeout: 10_000 });
            await settle(receiver);
            expect(await focusSeen(receiver), `after ${idle}`).toEqual([idle, busy, idle]);
            expect(await button(receiver).evaluate((el) => el.matches(':focus-visible'))).toBe(true);
            expect(await button(receiver).getAttribute('aria-disabled')).not.toBe('true');
            await receiver.waitForTimeout(1_500); // a second run would still be saving
            expect(downloads.sort()).toEqual(saved);
        } finally {
            await close();
        }
    });
}

test('a press on the other button starts nothing, and focus moved away during a run stays there', async ({ browser }) => {
    const { receiver, downloads, close } = await received(browser);
    try {
        await all(receiver).focus();
        await receiver.keyboard.press('Enter');
        await expect(all(receiver)).toHaveText('Downloading...');
        await receiver.keyboard.press('Tab');
        expect(await focusOn(receiver), 'Tab during Download All').toBe('Download ZIP');
        await receiver.keyboard.press('Enter');
        await expect(all(receiver)).toHaveText('Download All', { timeout: 10_000 });
        await settle(receiver);
        expect(await focusOn(receiver), 'after Download All').toBe('Download ZIP');
        await receiver.waitForTimeout(1_500);
        expect(downloads.sort()).toEqual(NAMES);

        await slowReads(receiver);
        await zip(receiver).focus();
        await receiver.keyboard.press('Enter');
        await expect(zip(receiver)).toHaveText('Zipping...');
        await receiver.keyboard.press('Tab');
        expect(await focusOn(receiver), 'Tab during Download ZIP').toBe('Download a.txt');
        await expect(zip(receiver)).toHaveText('Download ZIP', { timeout: 10_000 });
        await settle(receiver);
        expect(await focusOn(receiver), 'after Download ZIP').toBe('Download a.txt');
    } finally {
        await close();
    }
});

test('a ZIP that fails ends the run: focus stays, and Download All works after it', async ({ browser }) => {
    const { receiver, downloads, close } = await received(browser);
    try {
        await receiver.evaluate(() => {
            Blob.prototype.arrayBuffer = () => Promise.reject(new Error('unreadable'));
        });
        await zip(receiver).focus();
        await receiver.keyboard.press('Enter');
        await expect(receiver.getByText('ZIP creation failed. Try "Download All" instead.')).toBeVisible();
        await expect(zip(receiver)).toHaveText('Download ZIP');
        await settle(receiver);
        expect(await focusOn(receiver), 'after a failed ZIP').toBe('Download ZIP');

        await all(receiver).focus();
        await receiver.keyboard.press('Enter');
        await expect.poll(() => downloads.length, { message: 'Download All after a failed ZIP', timeout: 5_000 }).toBe(NAMES.length);
    } finally {
        await close();
    }
});

test('a ZIP with no file it can read ends the run too', async ({ browser }) => {
    const { receiver, downloads, close } = await received(browser);
    try {
        // Every received file's read fails and the archive's own 1-byte read-back
        // works, so writeZip skips all four and the hook takes its "no file readable" end.
        await receiver.evaluate(() => {
            const read = Blob.prototype.arrayBuffer;
            Blob.prototype.arrayBuffer = function (this: Blob) {
                return this.size === 1 ? read.call(this) : Promise.reject(new Error('unreadable'));
            };
        });
        await zip(receiver).focus();
        await receiver.keyboard.press('Enter');
        await expect(receiver.getByText('Could not prepare files for ZIP. Try "Download All" instead.')).toBeVisible();
        await expect(zip(receiver)).toHaveText('Download ZIP');
        await settle(receiver);
        expect(await focusOn(receiver), 'after a ZIP with nothing readable').toBe('Download ZIP');

        await all(receiver).focus();
        await receiver.keyboard.press('Enter');
        await expect.poll(() => downloads.length, { message: 'Download All after a ZIP with nothing readable', timeout: 5_000 }).toBe(NAMES.length);
    } finally {
        await close();
    }
});

// Each run of Download ZIP still takes down the sentence the last run put up,
// once it is no longer true: after a run that works, the card holds no banner.
test('a ZIP that works takes down what the last ZIP put up, each of its three sentences', async ({ browser }) => {
    const { receiver, downloads, close } = await received(browser);
    try {
        // In <main>: Next.js's route announcer is an alert too.
        const banner = receiver.getByRole('main').getByRole('alert');
        await receiver.evaluate(() => {
            (window as unknown as { realRead: typeof Blob.prototype.arrayBuffer }).realRead = Blob.prototype.arrayBuffer;
        });
        const zipThatWorks = async (after: string) => {
            await receiver.evaluate(() => {
                Blob.prototype.arrayBuffer = (window as unknown as { realRead: typeof Blob.prototype.arrayBuffer }).realRead;
            });
            const before = downloads.length;
            await zip(receiver).click();
            await expect.poll(() => downloads.length, { message: `the ZIP after ${after}`, timeout: 5_000 }).toBe(before + 1);
            await expect(zip(receiver)).toHaveText('Download ZIP');
            await expect(banner, `after ${after}, then a ZIP that works`).toHaveCount(0);
        };

        // The first read fails, so one file is left out of an archive that is saved.
        await receiver.evaluate(() => {
            const read = Blob.prototype.arrayBuffer;
            let first = true;
            Blob.prototype.arrayBuffer = function (this: Blob) {
                if (!first) return read.call(this);
                first = false;
                return Promise.reject(new Error('unreadable'));
            };
        });
        await zip(receiver).click();
        await expect(banner).toHaveText('1 file(s) could not be included in ZIP.');
        await zipThatWorks('a ZIP that left a file out');

        // No received file can be read; the archive's own 1-byte read-back can.
        await receiver.evaluate(() => {
            const read = Blob.prototype.arrayBuffer;
            Blob.prototype.arrayBuffer = function (this: Blob) {
                return this.size === 1 ? read.call(this) : Promise.reject(new Error('unreadable'));
            };
        });
        await zip(receiver).click();
        await expect(banner).toHaveText('Could not prepare files for ZIP. Try "Download All" instead.');
        await zipThatWorks('a ZIP with no file it could read');

        await receiver.evaluate(() => {
            Blob.prototype.arrayBuffer = () => Promise.reject(new Error('unreadable'));
        });
        await zip(receiver).click();
        await expect(banner).toHaveText('ZIP creation failed. Try "Download All" instead.');
        await zipThatWorks('a ZIP that failed');
    } finally {
        await close();
    }
});
