/**
 * Shared helpers for the e2e specs that drive the Go CLI and the browser
 * client. Extracted from cli-interop.spec.ts so cli-cli.spec.ts can reuse
 * them without duplicating process/fixture plumbing.
 *
 * The CLI binary is built ONCE per run by e2e/global-setup.ts, which
 * publishes its path via the FLOE_E2E_CLI_BINARY environment variable;
 * cliBinary() reads it back here.
 *
 * spawnSend/spawnReceive default to that HEAD build but accept an explicit
 * binary path, so back-compat.spec.ts can drive a downloaded released CLI
 * through the same process plumbing.
 *
 * --no-relay keeps both peers on host/loopback candidates so CLI tests run
 * hermetically without a TURN server or real network.
 */

import { expect, test, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { spawn, type ChildProcess } from 'child_process';

export { CLI_BUILD_DIR, CLI_BUILD_BINARY } from './cli-binary';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SERVER_URL = 'http://localhost:3001';
export const WEB_URL = 'http://localhost:3000';
/** Max time to wait for CLI process output / completion. */
export const CLI_TIMEOUT_MS = 60_000;

/**
 * Path of the CLI binary built by global-setup. Throws when the suite runs
 * without global setup so the failure names the fix instead of ENOENT.
 */
export function cliBinary(): string {
    const bin = process.env.FLOE_E2E_CLI_BINARY;
    if (!bin) {
        throw new Error(
            'FLOE_E2E_CLI_BINARY is not set. The CLI binary is built by ' +
            'e2e/global-setup.ts; run this spec via `pnpm exec playwright test` ' +
            '(which runs globalSetup), not by importing it directly.',
        );
    }
    return bin;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Write `size` random bytes to `filePath` (creating parent directories) and
 * return the SHA-256 of what was written.
 */
export function writeRandomFile(filePath: string, size: number): string {
    mkdirSync(dirname(filePath), { recursive: true });
    const data = size > 0 ? randomBytes(size) : Buffer.alloc(0);
    writeFileSync(filePath, data);
    return createHash('sha256').update(data).digest('hex');
}

/**
 * Create `fixture-<size>.bin` with random content inside `dir`.
 * Every spec passes its own dir (e.g. join(tmpdir(), 'floe-cli-interop')) so
 * one spec's afterAll rmSync can never race another spec's fixtures.
 */
export function createFixture(dir: string, size: number): { path: string; sha256: string } {
    const filePath = join(dir, `fixture-${size}.bin`);
    const sha256 = writeRandomFile(filePath, size);
    return { path: filePath, sha256 };
}

export function sha256OfFile(filePath: string): string {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

export async function sha256OfBlobUrl(page: Page, blobUrl: string): Promise<string> {
    return page.evaluate(async (url) => {
        const buf = await fetch(url).then((r) => r.arrayBuffer());
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }, blobUrl);
}

/** Load the browser sender page, pick a file, and return the room URL. */
export async function browserSenderSetup(page: Page, fixturePath: string): Promise<string> {
    await page.goto('/');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);
    await page.locator('button', { hasText: /create secure link/i }).click();
    const linkEl = page.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    return (await linkEl.textContent())!.trim();
}

// ---------------------------------------------------------------------------
// CLI process helpers
// ---------------------------------------------------------------------------

/**
 * Mirror a spawned CLI's stdout/stderr into a transcript, each data event
 * prefixed with the milliseconds since spawn, and attach it to the current
 * test's report when the process ends. Runs alongside the callers' own
 * stream handlers (Node supports multiple 'data' listeners) so the existing
 * link-matching and error-tail logic stays untouched.
 *
 * The attachment survives retry-passes: a flaky first attempt leaves the
 * CLI's own timeline in the report artifact, alignable against the browser
 * trace, instead of vanishing behind the green retry. Best-effort on
 * purpose: attaching evidence must never fail a test, and a process that
 * outlives its test (test.info() then throws) just drops the transcript.
 */
function captureTranscript(proc: ChildProcess, name: string): void {
    const t0 = Date.now();
    let transcript = '';
    let attached = false;
    const record = (stream: 'out' | 'err') => (chunk: Buffer) => {
        transcript += `[+${Date.now() - t0}ms ${stream}] ${chunk.toString()}`;
    };
    const attach = () => {
        if (attached) return;
        attached = true;
        try {
            test.info().attach(name, { body: transcript, contentType: 'text/plain' }).catch(() => { });
        } catch { }
    };
    proc.stdout?.on('data', record('out'));
    proc.stderr?.on('data', record('err'));
    proc.on('close', attach);
    proc.on('error', attach);
}

/**
 * Spawn `floe send` and return a promise that resolves to the room link once
 * it appears in stdout, plus the process so the caller can await/kill it.
 * The caller owns the process and must kill it in a finally block.
 *
 * `binary` defaults to the HEAD build. The default is evaluated per call and
 * only when the argument is omitted, so existing call sites keep cliBinary()'s
 * fail-loud contract and back-compat callers can pass a released binary.
 */
export function spawnSend(path: string, binary: string = cliBinary()): {
    linkPromise: Promise<string>;
    proc: ChildProcess;
} {
    const proc = spawn(binary, [
        'send', path,
        '--server', SERVER_URL,
        '--web', WEB_URL,
        '--no-relay',
    ]);
    captureTranscript(proc, 'floe send transcript');

    const linkPromise = new Promise<string>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(
            () => reject(new Error(
                `CLI send did not emit a room link within ${CLI_TIMEOUT_MS} ms${tail(stdout, stderr)}`,
            )),
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
        proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
            if (code !== 0 && code !== null) {
                clearTimeout(timer);
                reject(new Error(`floe send exited with code ${code}${tail(stdout, stderr)}`));
            }
        });
    });

    return { linkPromise, proc };
}

/**
 * Spawn `floe receive` and return a promise that resolves once the process
 * exits successfully (its integrity guard ties exit 0 to every byte of every
 * file being on disk), and rejects on nonzero exit or after CLI_TIMEOUT_MS.
 *
 * `binary` defaults to the HEAD build, same contract as spawnSend.
 */
export function spawnReceive(link: string, outputDir: string, binary: string = cliBinary()): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(binary, [
            'receive', link,
            '--server', SERVER_URL,
            '--output', outputDir,
            '--yes',       // auto-accept
            '--no-relay',
        ]);
        captureTranscript(proc, 'floe receive transcript');

        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        const timer = setTimeout(
            () => {
                proc.kill();
                reject(new Error(`floe receive timed out after ${CLI_TIMEOUT_MS} ms${tail(stdout, stderr)}`));
            },
            CLI_TIMEOUT_MS,
        );

        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`floe receive exited with code ${code}${tail(stdout, stderr)}`));
        });
    });
}

/**
 * Format the tail of a CLI process's output for an error message, so a
 * failed or timed-out spawn carries the binary's own words instead of just
 * an exit code. Vital for back-compat runs, where the failing binary may be
 * a released version whose failure cannot be reproduced from HEAD sources.
 */
function tail(stdout: string, stderr: string): string {
    const clip = (s: string) => s.trim().slice(-500);
    let out = '';
    if (stderr.trim()) out += `\nstderr: ${clip(stderr)}`;
    if (stdout.trim()) out += `\nstdout: ${clip(stdout)}`;
    return out;
}

/**
 * Wait for a spawned process to exit; resolves with its exit code, or null if
 * it is still running after timeoutMs. Never kills the process; the caller's
 * finally-block kill stays responsible for cleanup, and an exited process
 * makes that kill a no-op.
 */
export function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
        if (proc.exitCode !== null) {
            resolve(proc.exitCode);
            return;
        }
        const timer = setTimeout(() => resolve(null), timeoutMs);
        proc.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
}
