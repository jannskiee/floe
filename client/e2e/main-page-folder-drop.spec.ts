/**
 * A folder dropped on the Send page is walked and sent with its structure
 * (#795). Playwright cannot drop a real folder, so each test hands the drop
 * zone the entries Chromium gives a page for one: a directory entry whose
 * reader lists files and folders, as the request page's specs do.
 */

import { test, expect, type Locator } from '@playwright/test';
import { createHash } from 'crypto';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sha256OfFile, spawnReceive } from './helpers';

const OUT_ROOT = join(tmpdir(), 'floe-main-folder-drop');

test.afterAll(() => {
    try { rmSync(OUT_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

const TREE = { 'a.txt': 'alpha\n', 'day1/b.txt': 'bravo, day one\n' };

/** Drops a fake `photos` folder holding TREE. With `hold`, its top folder
 *  lists nothing until `window.releaseFolder()` is called. */
async function dropPhotos(zone: Locator, hold = false) {
    await zone.evaluate((el, { tree, hold }) => {
        type Entry = Record<string, unknown>;
        const fileEntry = (path: string, text: string): Entry => ({
            isFile: true,
            isDirectory: false,
            name: path.split('/').pop(),
            fullPath: `/${path}`,
            file: (ok: (f: File) => void) => ok(new File([text], path.split('/').pop()!)),
        });
        const dirEntry = (path: string, children: Entry[], held: boolean): Entry => ({
            isFile: false,
            isDirectory: true,
            name: path.split('/').pop(),
            fullPath: `/${path}`,
            createReader: () => {
                let done = false;
                return {
                    readEntries: (ok: (e: Entry[]) => void) => {
                        const answer = () => { ok(done ? [] : children); done = true; };
                        if (held && !done) {
                            (window as unknown as { releaseFolder: () => void }).releaseFolder = answer;
                        } else answer();
                    },
                };
            },
        });
        const day1 = dirEntry('photos/day1', [fileEntry('photos/day1/b.txt', tree['day1/b.txt'])], false);
        const photos = dirEntry('photos', [fileEntry('photos/a.txt', tree['a.txt']), day1], hold);
        const pseudo = new File([new Uint8Array(4096)], 'photos');
        const dataTransfer = {
            types: ['Files'],
            files: [pseudo],
            items: [{ kind: 'file', type: '', getAsFile: () => pseudo, webkitGetAsEntry: () => photos }],
            dropEffect: 'none',
        };
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
        el.dispatchEvent(drop);
    }, { tree: TREE, hold });
}

test('a folder dropped on the Send page arrives with its structure', async ({ page }) => {
    await page.goto('/');
    await dropPhotos(page.getByText('Drop files or click to browse'));

    await expect(page.getByText('photos/a.txt', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('photos/day1/b.txt', { exact: true }).first()).toBeVisible();
    await page.locator('button', { hasText: 'Create secure link (2 files)' }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    const link = (await linkEl.textContent())!.trim();

    const outDir = join(OUT_ROOT, `out-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    await spawnReceive(link, outDir);

    for (const [path, text] of Object.entries(TREE)) {
        const saved = join(outDir, 'photos', path);
        expect(existsSync(saved), `${path} saved under photos/`).toBe(true);
        expect(sha256OfFile(saved)).toBe(createHash('sha256').update(text).digest('hex'));
    }
});

test('Create stays off while a dropped folder is still being read', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({
        name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes'),
    });
    const create = page.locator('button', { hasText: /create secure link/i });
    await expect(create).toBeEnabled();

    const zone = page.getByText('Add more files', { exact: true });
    await dropPhotos(zone, true);
    await expect(create).toBeDisabled();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(1);

    await page.evaluate(() => (window as unknown as { releaseFolder: () => void }).releaseFolder());
    await expect(create).toHaveText(/Create secure link \(3 files\)/);
    await expect(create).toBeEnabled();
    await expect(page.getByText('photos/day1/b.txt', { exact: true }).first()).toBeVisible();
});
