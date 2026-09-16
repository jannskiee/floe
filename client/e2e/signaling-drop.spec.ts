/**
 * Signaling drop mid-transfer (E2E-08).
 *
 * The server sends `peer-disconnected` whenever the other side's signaling
 * socket goes away. That says nothing about the WebRTC connection, which never
 * touches the server, yet the web app used to destroy a connected peer on the
 * notice, so a blip on the far side's signaling socket ended a healthy
 * transfer mid-file.
 *
 * The CLI peer reaches the signaling server through a TCP proxy this spec
 * owns. Once bytes are flowing, the spec destroys every proxied connection,
 * the server's handleDisconnect sends `peer-disconnected` to the browser, and
 * the transfer must still complete byte for byte.
 *
 * The proxy listens on an ephemeral port, so nothing beyond the 3000 and 3001
 * servers from playwright.config.ts has to be free. --no-relay keeps both
 * peers on host candidates, as in cli-interop.spec.ts. Receivers stay out of
 * the stats counter: the CLI with --no-report and FLOE_NO_STATS=1, the browser
 * with its "Contribute to global stats" toggle stored off.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer, connect, type AddressInfo } from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { rmSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
    CLI_TIMEOUT_MS,
    WEB_URL,
    cliBinary,
    createFixture,
    sha256OfFile,
    sha256OfBlobUrl,
    browserSenderSetup,
    waitForExit,
} from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-signaling-drop');
// Large enough that the cut lands well before the last byte on loopback.
const FIXTURE_SIZE = 64 * 1024 * 1024;
const SIGNALING_PORT = 3001;

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Signaling proxy
// ---------------------------------------------------------------------------

interface SignalingProxy {
    /** Server URL to hand the CLI (`--server`). */
    url: string;
    /** Destroys both legs of every proxied connection; returns how many were /ws. */
    cut: () => number;
    close: () => Promise<void>;
}

async function startSignalingProxy(): Promise<SignalingProxy> {
    const live = new Map<() => void, { ws: boolean }>();
    const server = createServer((client) => {
        const upstream = connect(SIGNALING_PORT, '127.0.0.1');
        const info = { ws: false };
        const drop = () => {
            live.delete(drop);
            client.destroy();
            upstream.destroy();
        };
        live.set(drop, info);
        // The first bytes of a connection are its request line, which is
        // enough to tell the /ws upgrade from the plain HTTP calls.
        client.once('data', (chunk: Buffer) => {
            info.ws = chunk.toString('latin1').startsWith('GET /ws');
        });
        client.on('error', drop);
        upstream.on('error', drop);
        client.on('close', drop);
        upstream.on('close', drop);
        client.pipe(upstream);
        upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const cut = () => {
        let ws = 0;
        for (const [drop, info] of [...live]) {
            if (info.ws) ws++;
            drop();
        }
        return ws;
    };
    return {
        url: `http://127.0.0.1:${port}`,
        cut,
        close: () => new Promise<void>((resolve) => {
            cut();
            server.close(() => resolve());
        }),
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CliRun {
    proc: ChildProcess;
    /** Resolves with the first stdout match, rejects on exit or timeout. */
    waitForStdout: (pattern: RegExp) => Promise<string>;
    /** Attaches the timestamped transcript to the test report. */
    attachTranscript: (name: string) => Promise<void>;
}

function spawnCli(args: string[]): CliRun {
    const proc = spawn(cliBinary(), args, {
        env: { ...process.env, FLOE_NO_STATS: '1', FLOE_NO_UPDATE_CHECK: '1' },
    });
    const t0 = Date.now();
    let stdout = '';
    let transcript = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        transcript += `[+${Date.now() - t0}ms out] ${chunk.toString()}`;
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
        transcript += `[+${Date.now() - t0}ms err] ${chunk.toString()}`;
    });

    const waitForStdout = (pattern: RegExp) => new Promise<string>((resolve, reject) => {
        const check = () => {
            const match = stdout.match(pattern);
            if (!match) return false;
            cleanup();
            resolve(match[0].trim());
            return true;
        };
        const onExit = (code: number | null) => {
            cleanup();
            reject(new Error(`floe exited with code ${code} before printing ${pattern}\n${transcript.slice(-800)}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`floe did not print ${pattern} within ${CLI_TIMEOUT_MS} ms\n${transcript.slice(-800)}`));
        }, CLI_TIMEOUT_MS);
        const cleanup = () => {
            clearTimeout(timer);
            proc.stdout?.off('data', check);
            proc.off('close', onExit);
        };
        if (check()) return;
        proc.stdout?.on('data', check);
        proc.on('close', onExit);
    });

    const attachTranscript = async (name: string) => {
        try {
            await test.info().attach(name, { body: transcript, contentType: 'text/plain' });
        } catch { /* evidence only, never a failure */ }
    };

    return { proc, waitForStdout, attachTranscript };
}

/**
 * A page whose "Contribute to global stats" toggle is stored off before any
 * script runs, plus a count of the stats reports it attempted anyway.
 */
async function optedOutPage(ctx: BrowserContext): Promise<{ page: Page; statsReports: () => number }> {
    await ctx.addInitScript(() => {
        try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
    });
    const page = await ctx.newPage();
    let reports = 0;
    page.on('request', (req) => {
        if (req.url().includes('/api/stats/report')) reports++;
    });
    return { page, statsReports: () => reports };
}

/**
 * Waits until bytes are flowing on `page`, then cuts the CLI's signaling.
 * The progress bar renders only once progress is above zero, so the data
 * channel is open by then. waitFor polls inside the page, which reacts far
 * sooner than expect's back-off, and a transfer that finished before the cut
 * would prove nothing, so that case fails loudly instead of passing.
 */
async function cutSignalingMidTransfer(page: Page, proxy: SignalingProxy): Promise<void> {
    const bar = page.getByRole('progressbar');
    await bar.waitFor({ state: 'visible', timeout: CLI_TIMEOUT_MS });
    const wsCut = proxy.cut();
    const progressAfterCut = Number(await bar.getAttribute('aria-valuenow'));
    expect(wsCut, 'the CLI had no live /ws connection to cut').toBeGreaterThan(0);
    expect(progressAfterCut, 'the transfer finished before the cut').toBeLessThan(100);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('CLI sender loses signaling mid-transfer and the browser receiver completes', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    const proxy = await startSignalingProxy();
    const sender = spawnCli([
        'send', fixturePath,
        '--server', proxy.url,
        '--web', WEB_URL,
        '--no-relay',
    ]);
    const ctx = await browser.newContext();

    try {
        const link = await sender.waitForStdout(/https?:\/\/\S*#room=\S+/);
        const { page, statsReports } = await optedOutPage(ctx);
        await page.goto(link);

        await cutSignalingMidTransfer(page, proxy);

        const downloadLink = page.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: CLI_TIMEOUT_MS });
        const blobUrl = (await downloadLink.getAttribute('href'))!;
        expect(await sha256OfBlobUrl(page, blobUrl)).toBe(expectedHash);
        expect(statsReports(), 'the browser receiver reported stats').toBe(0);
    } finally {
        await ctx.close();
        sender.proc.kill();
        await sender.attachTranscript('floe send transcript');
        await proxy.close();
    }
});

test('CLI receiver loses signaling mid-transfer and the browser sender completes', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    // floe receive creates the output directory itself.
    const outputDir = join(FIXTURE_DIR, 'received');
    const proxy = await startSignalingProxy();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let receiver: CliRun | null = null;

    try {
        const link = await browserSenderSetup(page, fixturePath);
        receiver = spawnCli([
            'receive', link,
            '--server', proxy.url,
            '--output', outputDir,
            '--yes',
            '--no-relay',
            '--no-report',
        ]);

        await cutSignalingMidTransfer(page, proxy);

        // Exit 0 is tied to every byte being on disk (the receiver's integrity guard).
        expect(await waitForExit(receiver.proc, CLI_TIMEOUT_MS)).toBe(0);
        const receivedPath = join(outputDir, basename(fixturePath));
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);
        // No 'All Files Sent!' check. The CLI receiver exits the moment its
        // last byte is on disk, and on the first run of this spec its close
        // beat the browser sender's final drain: the sender page read 100% and
        // 'Connection interrupted' although every byte had arrived.
    } finally {
        await ctx.close();
        receiver?.proc.kill();
        await receiver?.attachTranscript('floe receive transcript');
        await proxy.close();
    }
});
