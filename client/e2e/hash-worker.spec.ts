/**
 * E2E-15: a browser send hashes its file in a dedicated Worker, and a Go
 * receiver matches that SHA-256 against the bytes it wrote.
 *
 * The page's hashBlob runs the digest in a worker started with
 * new Worker(new URL(...)). Turbopack names the emitted chunk differently in the
 * two modes this suite runs in (next dev locally, next start on CI), and only
 * the dev name carries `fileHash`, so the assertion is that a worker started
 * from this origin's own chunk directory; the URL itself is attached. The
 * main-thread long-task bar is not asserted here (runner noise); the throughput
 * measurement on a fixed machine owns it.
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { createFixture, sha256OfFile, browserSenderSetup, cliBinary, SERVER_URL, WEB_URL } from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-hash-worker');
const FIXTURE_SIZE = 64 * 1024 * 1024;

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a 64 MiB browser send hashes in a dedicated Worker and the CLI reports SHA-256 matched', async ({ browser }) => {
    test.setTimeout(180_000);
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    const outputDir = join(FIXTURE_DIR, 'received');
    mkdirSync(outputDir, { recursive: true });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const workerUrls: string[] = [];
    page.on('worker', (worker) => workerUrls.push(worker.url()));

    try {
        const roomLink = await browserSenderSetup(page, fixturePath);

        // The receiver never reports to the stats counter: the flag and the
        // environment variable both say so.
        const proc = spawn(cliBinary(), [
            'receive', roomLink,
            '--server', SERVER_URL,
            '--output', outputDir,
            '--yes',
            '--no-relay',
            '--no-report',
        ], { env: { ...process.env, FLOE_NO_STATS: '1' } });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        const code = await new Promise<number | null>((resolve) => {
            const timer = setTimeout(() => { proc.kill(); resolve(null); }, 150_000);
            proc.on('close', (c) => { clearTimeout(timer); resolve(c); });
        });
        await test.info().attach('floe receive stdout and worker urls', {
            body: `exit=${code}\nworkers=${JSON.stringify(workerUrls)}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
            contentType: 'text/plain',
        });

        expect(code).toBe(0);
        expect(stdout).toMatch(/Verified\s+SHA-256 matched/);
        expect(workerUrls.some((url) => url.startsWith(`${WEB_URL}/_next/static/`))).toBe(true);

        const receivedPath = join(outputDir, basename(fixturePath));
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);
    } finally {
        await ctx.close();
    }
});
