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
import { mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import {
    createFixture,
    fixtureDir,
    removeFixtureDir,
    sha256OfFile,
    sha256OfBlobUrl,
    browserSenderSetup,
    spawnSend,
    spawnReceive,
    collectStdout,
    waitForExit,
    CLI_TIMEOUT_MS,
} from './helpers';

const FIXTURE_DIR = fixtureDir('floe-cli-interop');
// File size: large enough to exercise the 8 MB backpressure loop (~12 MB).
const FIXTURE_SIZE = 12 * 1024 * 1024;

test.afterAll(() => {
    removeFixtureDir(FIXTURE_DIR);
});

test('Direction 1: CLI send → browser receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    // Start the CLI sender first so the room exists before the browser joins.
    const { linkPromise, proc } = spawnSend(fixturePath);
    const senderOut = collectStdout(proc);
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
        // completion line carries the green check, with the words for screen
        // readers only. The transient "Verifying file 1 of 1" is deliberately
        // not asserted; for a 12 MB file the check is milliseconds and the
        // assertion would flake.
        await expect(page.locator('[data-mark="verified"]')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('[data-mark="plain"]')).toHaveCount(0);
        await expect(page.locator('main')).toContainText('SHA-256 matched');

        // The page's acks promise `received` (SG-01), so the CLI waits for
        // that word, not a drained buffer, and ends on it in success with the
        // page's count of matched files, while the page is still open. Before,
        // it ended at the drain, and a refusal the page sent after the last
        // byte never reached it. This used to kill the CLI unawaited.
        expect(await waitForExit(proc, CLI_TIMEOUT_MS)).toBe(0);
        // Polled: waitForExit can answer from the exit code before the pipe
        // has handed over the summary the CLI printed just before it exited.
        await expect.poll(senderOut).toMatch(/Verified\s+SHA-256 matched/);
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

        // A delivered send reads one of three sentences once the CLI has left,
        // and which one is a race this test does not own. The CLI exits right
        // after its `received`, and two things then reach the page: the
        // server's word that the peer left its room (onPeerDisconnected:
        // 'All Files Sent!' becomes 'Transfer complete') and the connection
        // going away under it (the peer's error handler: 'Connection
        // interrupted', which a delivered send keeps its rows under). The
        // last one to arrive is the sentence that stays. This asked for the
        // first two only, and a macOS runner where the connection error came
        // last failed it twice in one job (2026-10-13); reconnect.spec.ts
        // already takes either ending.
        await expect(page.locator('body')).toContainText(
            /All Files Sent!|Transfer complete|Connection interrupted/
        );
        // Under any of them the file left this browser, and the rows say
        // so. They used to follow the status sentence, so the CLI's exit put
        // "Sending file 1 of 1..." back under "Transfer complete".
        await expect(page.getByText('Sent 1 file', { exact: true })).toBeVisible();
        await expect(page.getByText(/Sending file [0-9]+ of [0-9]+/)).toHaveCount(0);
        // The CLI receiver's `received` frame carries verified=1 and now
        // reaches the page, because the session listener outlives onAllSent
        // (F-SHA-4). Before this the finally closed the channel first. The
        // words follow the delivered send, not the status sentence, so they
        // are there (for screen readers) under all three endings. They used
        // to be gated on the two sentences that say the send is complete,
        // and under 'Connection interrupted' they went away while the rows
        // above still read sent.
        await expect(page.getByText('SHA-256 matched', { exact: true })).toBeVisible({ timeout: 15_000 });
        // A verified send never shows the gray check, whichever ending
        // stayed. The green one sits beside the two endings that say the
        // send is complete; 'Connection interrupted' has no mark of its own.
        await expect(page.locator('[data-mark="plain"]')).toHaveCount(0);
        await expect
            .poll(async () => {
                if (/Connection interrupted/.test(await page.locator('main').innerText())) return 'interrupted';
                return (await page.locator('[data-mark="verified"]').count()) === 1 ? 'verified' : 'none';
            })
            .not.toBe('none');
        const ending = (await page.locator('body').innerText()).match(
            /All Files Sent!|Transfer complete|Connection interrupted/
        );
        test.info().annotations.push({ type: 'sender-ending', description: ending ? ending[0] : 'none read' });

        // Verify the file landed on disk with correct content.
        const expectedName = basename(fixturePath);
        const receivedPath = join(outputDir, expectedName);
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);
    } finally {
        await ctx.close();
    }
});
