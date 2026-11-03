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
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { ENFORCE_SHARE_LINK_KEY, MAKE_LINK_KEYS } from '../lib/transfer/protocol';
import {
    CLI_TIMEOUT_MS,
    KEYED_SHARE_LINK,
    WEB_URL,
    cliBinary,
    createFixture,
    fixtureDir,
    removeFixtureDir,
    sha256OfFile,
    sha256OfBlobUrl,
    browserSenderSetup,
    spawnSend,
    spawnReceive,
    waitForExit,
    collectStdout,
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

const FIXTURE_DIR = fixtureDir('floe-back-compat');
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
    removeFixtureDir(FIXTURE_DIR);
});

test('released CLI send → HEAD CLI receive (SHA-256 integrity)', async () => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    // HEAD floe receive creates the output directory itself.
    const outputDir = join(FIXTURE_DIR, 'received-released-to-head');

    const { linkPromise, proc: sender } = spawnSend(fixturePath, releasedCli());
    try {
        const roomLink = await linkPromise;
        // A released floe prints #room= today and #k=...&room= from v1.12.0 on, and this
        // job reads whichever release is the latest.
        expect(roomLink).toMatch(/[#&]room=/);

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
        // HEAD's link leads with its key. The released receiver reads only room=
        // out of it, and drops the kc that comes ahead of the metadata.
        expect(roomLink).toContain('#k=');
        expect(roomLink).toContain('&room=');

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

// What a floe from before the link key does with one. That stops being true the day
// v1.12.0 is the latest release, which is what this job downloads, so these stand aside
// then and do not go red on every pull request (review 20, findings 1 and 7).
function releasedPredatesTheKey(): boolean {
    const m = /^v(\d+)\.(\d+)\./.exec(process.env.FLOE_RELEASED_VERSION ?? '');
    return m !== null && (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 12));
}

// Its parser takes the whole fragment for a room id and finds none. No network: the
// server named here answers nothing, and the line is the one a cut link has always had.
test('released floe send --to a keyed request link: the incomplete line, before any network', async () => {
    test.skip(!releasedPredatesTheKey(), 'a floe from v1.12.0 on reads the key');
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 4096);
    const key = 'AAECAwQFBgcICQoLDA0ODw';
    const link = `${WEB_URL}/r/AAAAAAAAAAA#${randomUUID()}.${key}`;
    const proc = spawn(releasedCli(), ['send', fixturePath, '--to', link, '--server', 'http://127.0.0.1:9']);
    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    try {
        expect(await waitForExit(proc, CLI_TIMEOUT_MS)).toBe(1);
        expect(out).toContain('This link looks incomplete. Copy the whole link again, including everything after the # sign.');
        expect(out).not.toContain(key);
    } finally {
        proc.kill();
    }
});

// HEAD waits for a proof a released receiver never sends, then stops with a range only a
// floe that speaks the key overlaps, so the released one prints its own update remedy
// (1.10.8 and later; review 20 finding 6).
test('HEAD floe send --link-only → released floe receive: its update remedy, and nothing saved', async () => {
    test.skip(!releasedPredatesTheKey(), 'a floe from v1.12.0 on proves the key');
    const { path: fixturePath } = createFixture(FIXTURE_DIR, 4096);
    const outputDir = join(FIXTURE_DIR, 'received-link-only');
    mkdirSync(outputDir, { recursive: true });
    const { linkPromise, proc: sender } = spawnSend(fixturePath, cliBinary(), ['--link-only']);
    try {
        const roomLink = await linkPromise;
        await expect(spawnReceive(roomLink, outputDir, releasedCli())).rejects.toThrow(/Cannot transfer[\s\S]*floe update/);
        expect(readdirSync(outputDir)).toEqual([]);
        expect(await waitForExit(sender, CLI_TIMEOUT_MS)).not.toBe(0);
    } finally {
        sender.kill();
    }
});

test('released CLI send → HEAD browser receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);

    // Start the released sender first so the room exists before the browser joins.
    const { linkPromise, proc } = spawnSend(fixturePath, releasedCli());
    const senderOut = collectStdout(proc);
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

        // A released sender since 1.11.0 reads the confirms the HEAD page now
        // puts on its acks (SG-01) and waits for the page's `received`
        // instead of a drained buffer: it must still finish, in success, with
        // the page's count of matched files, while the page is open. This is
        // what proves an installed CLI keeps working once the page deploys.
        expect(await waitForExit(proc, CLI_TIMEOUT_MS)).toBe(0);
        // Polled: waitForExit can answer from the exit code before the pipe
        // has handed over the summary the CLI printed just before it exited.
        await expect.poll(senderOut).toMatch(/Verified\s+SHA-256 matched/);
    } finally {
        await ctx.close();
        proc.kill();
    }
});

test('HEAD browser send → released CLI receive (SHA-256 integrity)', async ({ browser }) => {
    test.skip(ENFORCE_SHARE_LINK_KEY, 'from the cutover a sending page refuses a floe older than 1.12, which is what the cutover is for');
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    // Pre-create: only HEAD's receive is known to create --output itself.
    const outputDir = join(FIXTURE_DIR, 'received-browser-to-released');
    mkdirSync(outputDir, { recursive: true });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
        // The client renders a keyed link, #k=<k>&room=<id>. A released resolver
        // reads the fragment's room by name and has never heard of k, so the
        // link is handed over as-is, and the page's kc is a frame it drops.
        const roomLink = await browserSenderSetup(page, fixturePath);
        if (MAKE_LINK_KEYS) expect(roomLink).toMatch(KEYED_SHARE_LINK);

        await spawnReceive(roomLink, outputDir, releasedCli());

        const receivedPath = join(outputDir, basename(fixturePath));
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);

        // It sends no proof back, and until the cutover a page only detects, so
        // the send ends as it always has and the page has nothing to say about it.
        await expect(page.getByText(/couldn't confirm|can't check/i)).toHaveCount(0);
    } finally {
        await ctx.close();
    }
});
