/**
 * Released-CLI ↔ HEAD back-compat tests.
 *
 * floe.one ships the browser client the moment a PR merges, but installed
 * CLIs only change when a user runs brew/scoop/winget or `floe update`, so
 * the latest RELEASED binary keeps talking to freshly deployed code for
 * weeks. The e2e matrix proves HEAD against HEAD; this spec proves the
 * released binary against HEAD in all four pairings, so a PR that breaks
 * the wire protocol for already-installed CLIs goes red before merge
 * instead of after deploy.
 *
 * Gating: the released binary's path arrives via FLOE_RELEASED_CLI, set by
 * the back-compat CI job (which downloads the latest GitHub Release and
 * verifies it against checksums.txt) or by a local opt-in. Everywhere else
 * this whole file reports as skipped, leaving the 3-OS e2e matrix legs
 * untouched.
 *
 * The HEAD CLI still comes from e2e/global-setup.ts via helpers.cliBinary().
 * --no-relay keeps every pairing on host/loopback candidates (hermetic).
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
    CLI_TIMEOUT_MS,
    createFixture,
    sha256OfFile,
    sha256OfBlobUrl,
    browserSenderSetup,
    spawnSend,
    spawnReceive,
    waitForExit,
} from './helpers';

// Spawned CLIs inherit this process's env. v1.7.5 only phones GitHub from
// `floe version`, but a future released binary under test might check on
// send/receive startup too; suppress up front so no pairing ever leaves
// localhost. (Stats need no gate: the CLI reports them to --server, which
// is the local test server here.)
process.env.FLOE_NO_UPDATE_CHECK = '1';

// Runs only where the back-compat CI job (or a local opt-in) provides a
// released binary; everywhere else the file reports as skipped.
test.skip(!process.env.FLOE_RELEASED_CLI, 'FLOE_RELEASED_CLI is not set (back-compat CI job only)');

const FIXTURE_DIR = join(tmpdir(), 'floe-back-compat');
// Same 12 MB as cli-interop: large enough to exercise the 8 MB backpressure loop.
const FIXTURE_SIZE = 12 * 1024 * 1024;

/**
 * Path of the released CLI downloaded by the back-compat CI job. Throws so
 * a half-configured environment names the fix instead of failing on ENOENT.
 */
function releasedCli(): string {
    const bin = process.env.FLOE_RELEASED_CLI;
    if (!bin) {
        throw new Error(
            'FLOE_RELEASED_CLI is not set. The back-compat CI job exports it ' +
            'after downloading the latest GitHub Release; without it this ' +
            'spec should have been skipped.',
        );
    }
    return bin;
}

test.beforeAll(() => {
    // Pin down which release this run actually exercised.
    console.log(`Released tag: ${process.env.FLOE_RELEASED_VERSION ?? 'unknown'}`);
});

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('released CLI send → HEAD CLI receive (SHA-256 integrity)', async () => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    // HEAD floe receive creates the output directory itself.
    const outputDir = join(FIXTURE_DIR, 'received-released-to-head');

    const { linkPromise, proc: sender } = spawnSend(fixturePath, releasedCli());
    try {
        const roomLink = await linkPromise;
        expect(roomLink).toContain('#room=');

        await spawnReceive(roomLink, outputDir);

        const receivedPath = join(outputDir, basename(fixturePath));
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);

        // The released sender's drain loop waits for the receiver's
        // {"type":"received"} confirmation; a HEAD receiver that stops
        // sending it strands every deployed sender, so assert exit 0.
        expect(await waitForExit(sender, CLI_TIMEOUT_MS)).toBe(0);
    } finally {
        sender.kill();
    }
});

test('HEAD CLI send → released CLI receive (SHA-256 integrity)', async () => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    // Pre-create: only HEAD's receive is known to create --output itself.
    const outputDir = join(FIXTURE_DIR, 'received-head-to-released');
    mkdirSync(outputDir, { recursive: true });

    const { linkPromise, proc: sender } = spawnSend(fixturePath);
    try {
        const roomLink = await linkPromise;
        expect(roomLink).toContain('#room=');

        await spawnReceive(roomLink, outputDir, releasedCli());

        const receivedPath = join(outputDir, basename(fixturePath));
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);

        // Mirror image of the previous test: the HEAD sender must still
        // drain and exit 0 on the released receiver's confirmation.
        expect(await waitForExit(sender, CLI_TIMEOUT_MS)).toBe(0);
    } finally {
        sender.kill();
    }
});

test('released CLI send → HEAD browser receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    // Start the released sender first so the room exists before the browser joins.
    const { linkPromise, proc } = spawnSend(fixturePath, releasedCli());
    const roomLink = await linkPromise;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
        // v1.7.5 prints a #room= fragment link and the current client reads
        // the fragment first, so the link is handed over exactly as printed.
        await page.goto(roomLink);

        // Wait for the download button, meaning the file fully arrived.
        const downloadLink = page.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 90_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        const receivedHash = await sha256OfBlobUrl(page, blobUrl);
        expect(receivedHash).toBe(expectedHash);
    } finally {
        await ctx.close();
        proc.kill();
    }
});

test('HEAD browser send → released CLI receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    // Pre-create: only HEAD's receive is known to create --output itself.
    const outputDir = join(FIXTURE_DIR, 'received-browser-to-released');
    mkdirSync(outputDir, { recursive: true });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
        // The client renders a #room= fragment link; v1.7.5's resolver
        // parses both ?room= and #room=, so it is handed over as-is.
        const roomLink = await browserSenderSetup(page, fixturePath);

        await spawnReceive(roomLink, outputDir, releasedCli());

        const receivedPath = join(outputDir, basename(fixturePath));
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);
    } finally {
        await ctx.close();
    }
});
