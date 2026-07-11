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
 * The CLI binary is built once in a globalSetup-style beforeAll and cached in
 * a temp path for the duration of the suite.
 *
 * --no-relay keeps both peers on host/loopback candidates so the tests run
 * hermetically without a TURN server or real network.
 */

import { test, expect, type Page } from '@playwright/test';
import {
    createHash,
    randomBytes,
} from 'crypto';
import {
    writeFileSync,
    mkdirSync,
    rmSync,
    readFileSync,
    existsSync,
} from 'fs';
import { join, basename } from 'path';
import { tmpdir, platform } from 'os';
import { execSync, spawn, type ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_URL = 'http://localhost:3001';
const WEB_URL = 'http://localhost:3000';
const FIXTURE_DIR = join(tmpdir(), 'floe-cli-interop');
// File size: large enough to exercise the 8 MB backpressure loop (~12 MB).
const FIXTURE_SIZE = 12 * 1024 * 1024;
// Max time to wait for CLI process output / completion.
const CLI_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Build the CLI binary once for the whole suite
// ---------------------------------------------------------------------------

const CLI_BINARY = join(
    tmpdir(),
    platform() === 'win32' ? 'floe-test.exe' : 'floe-test',
);

/** Build the floe binary into a temp path and return the path. */
function buildCLI(): string {
    const repoRoot = join(__dirname, '..', '..');
    execSync(
        `go build -o "${CLI_BINARY}" ./cmd/floe`,
        { cwd: join(repoRoot, 'cli'), stdio: 'inherit' },
    );
    return CLI_BINARY;
}

// ---------------------------------------------------------------------------
// Helpers: fixtures
// ---------------------------------------------------------------------------

function createFixture(size: number): { path: string; sha256: string } {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const data = size > 0 ? randomBytes(size) : Buffer.alloc(0);
    const filePath = join(FIXTURE_DIR, `fixture-${size}.bin`);
    writeFileSync(filePath, data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    return { path: filePath, sha256 };
}

function sha256OfFile(filePath: string): string {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// ---------------------------------------------------------------------------
// Helpers: browser
// ---------------------------------------------------------------------------

async function sha256OfBlobUrl(page: Page, blobUrl: string): Promise<string> {
    return page.evaluate(async (url) => {
        const buf = await fetch(url).then((r) => r.arrayBuffer());
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }, blobUrl);
}

/** Load the browser sender page, pick a file, and return the room URL. */
async function browserSenderSetup(page: Page, fixturePath: string): Promise<string> {
    await page.goto('/');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);
    await page.locator('button', { hasText: /create secure link/i }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    return (await linkEl.textContent())!.trim();
}

// ---------------------------------------------------------------------------
// Helpers: CLI process
// ---------------------------------------------------------------------------

/**
 * Spawn `floe send` and return a promise that resolves to the room link once
 * it appears in stdout, and a cleanup function that kills the process.
 */
function spawnSend(fixturePath: string): {
    linkPromise: Promise<string>;
    proc: ChildProcess;
} {
    const proc = spawn(CLI_BINARY, [
        'send', fixturePath,
        '--server', SERVER_URL,
        '--web', WEB_URL,
        '--no-relay',
    ]);

    const linkPromise = new Promise<string>((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(
            () => reject(new Error(`CLI send did not emit a room link within ${CLI_TIMEOUT_MS} ms`)),
            CLI_TIMEOUT_MS,
        );

        proc.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            // Room link always contains #room=
            const match = stdout.match(/https?:\/\/\S*#room=[^\s]+/);
            if (match) {
                clearTimeout(timer);
                resolve(match[0].trim());
            }
        });

        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
            if (code !== 0 && code !== null) {
                clearTimeout(timer);
                reject(new Error(`floe send exited with code ${code}`));
            }
        });
    });

    return { linkPromise, proc };
}

/**
 * Spawn `floe receive` and return a promise that resolves once the process
 * exits successfully.
 */
function spawnReceive(link: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(CLI_BINARY, [
            'receive', link,
            '--server', SERVER_URL,
            '--output', outputDir,
            '--yes',       // auto-accept
            '--no-relay',
        ]);

        const timer = setTimeout(
            () => { proc.kill(); reject(new Error(`floe receive timed out after ${CLI_TIMEOUT_MS} ms`)); },
            CLI_TIMEOUT_MS,
        );

        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`floe receive exited with code ${code}`));
        });
    });
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

let cliBinary: string;

test.beforeAll(() => {
    cliBinary = buildCLI();
    mkdirSync(FIXTURE_DIR, { recursive: true });
});

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (existsSync(CLI_BINARY)) rmSync(CLI_BINARY); } catch { /* ignore */ }
    void cliBinary; // satisfy no-unused-vars
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Direction 1: CLI send → browser receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_SIZE);

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
    } finally {
        await ctx.close();
        proc.kill();
    }
});

test('Direction 2: browser send → CLI receive (SHA-256 integrity)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_SIZE);
    const outputDir = join(FIXTURE_DIR, 'received');
    mkdirSync(outputDir, { recursive: true });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
        // Start the browser sender and get the room link.
        const roomLink = await browserSenderSetup(page, fixturePath);

        // Spawn CLI receiver pointing at the room link.
        await spawnReceive(roomLink, outputDir);

        // Verify the file landed on disk with correct content.
        const expectedName = basename(fixturePath);
        const receivedPath = join(outputDir, expectedName);
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);
    } finally {
        await ctx.close();
    }
});
