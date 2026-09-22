/**
 * CLI↔Browser interop tests.
 *
 * These tests are the cross-implementation deployment guard for Floe — they
 * prove that the Go CLI and the JS browser client share a working wire protocol
 * in both transfer directions.
 *
 * Prerequisites (handled by playwright.config.ts webServer entries):
 *   - signaling server on :3001
 *   - Next.js client on :3000
 *
 * The CLI binary is built once for the whole run by e2e/global-setup.ts;
 * process/fixture plumbing shared with cli-cli.spec.ts lives in e2e/helpers.ts.
 *
 * --no-relay keeps both peers on host/loopback candidates so the tests run
 * hermetically without a TURN server or real network.
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
    createFixture,
    sha256OfFile,
    sha256OfBlobUrl,
    browserSenderSetup,
    spawnSend,
    spawnReceive,
} from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-cli-interop');
// File size: large enough to exercise the 8 MB backpressure loop (~12 MB).
const FIXTURE_SIZE = 12 * 1024 * 1024;

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('Direction 1: CLI send → browser receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    // Start the CLI sender first so the room exists before the browser joins.
    const { linkPromise, proc } = spawnSend(fixturePath);
    const roomLink = await linkPromise;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
        await page.goto(roomLink);

        // Wait for the download button — file fully received in browser.
        const downloadLink = page.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 90_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        const receivedHash = await sha256OfBlobUrl(page, blobUrl);
        expect(receivedHash).toBe(expectedHash);

        // The CLI sender now puts the file's SHA-256 on its end frame, so the
        // browser receiver checked it before offering the download. A mismatch
        // discards the file and shows one of the fixed sentences, so the absence
        // of any of them is the assertion that the check passed rather than
        // never ran (the download link above proves it ran to completion).
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/did not match what was sent|could not be read/i);

        // And the page now says so: every handed-over file verified, so the
        // success line shows under the completion line. The transient
        // "Verifying file 1 of 1" is deliberately not asserted; for a 12 MB
        // file the check is milliseconds and the assertion would flake.
        await expect(page.locator('body')).toContainText('SHA-256 matched', { timeout: 15_000 });
    } finally {
        await ctx.close();
        proc.kill();
    }
});

test('Direction 2: browser send → CLI receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    const outputDir = join(FIXTURE_DIR, 'received');
    mkdirSync(outputDir, { recursive: true });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
        // Start the browser sender and get the room link.
        const roomLink = await browserSenderSetup(page, fixturePath);

        // Spawn CLI receiver pointing at the room link.
        const stdout = await spawnReceive(roomLink, outputDir);

        // The browser sender put the file's SHA-256 on its end frame and the Go
        // receiver matched it against the bytes it wrote.
        expect(stdout).toMatch(/Verified\s+SHA-256 matched/);

        // The CLI receiver's `received` frame carries verified=1 and now
        // reaches the page, because the session listener outlives onAllSent
        // (F-SHA-4). Before this the finally closed the channel first.
        await expect(page.locator('body')).toContainText('SHA-256 matched', { timeout: 15_000 });
        await expect(page.locator('body')).toContainText('All Files Sent!');

        // Verify the file landed on disk with correct content.
        const expectedName = basename(fixturePath);
        const receivedPath = join(outputDir, expectedName);
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);
    } finally {
        await ctx.close();
    }
});
