/**
 * CLI↔CLI transfer tests.
 *
 * cli-interop.spec.ts proves each Go side against the browser; this spec
 * closes the triangle by running BOTH ends on the Go implementation. It also
 * asserts something the browser tests structurally cannot: the sender process
 * terminates with exit 0 on its own after delivery (its drain loop waits for
 * the receiver's {"type":"received"} confirmation, with a buffer-flushed
 * fallback), so a regression that strands the sender after a complete
 * transfer fails here and nowhere else.
 *
 * The CLI binary comes from e2e/global-setup.ts via helpers.cliBinary().
 * --no-relay keeps both peers on host/loopback candidates (hermetic).
 */

import { test, expect } from '@playwright/test';
import { rmSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
    CLI_TIMEOUT_MS,
    createFixture,
    writeRandomFile,
    sha256OfFile,
    spawnSend,
    spawnReceive,
    waitForExit,
} from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-cli-cli');
// Same 12 MB as cli-interop: large enough to exercise the 8 MB backpressure loop.
const FIXTURE_SIZE = 12 * 1024 * 1024;

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('CLI to CLI: 12 MB file transfer with SHA-256 integrity', async () => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(FIXTURE_DIR, FIXTURE_SIZE);
    // floe receive creates the output directory itself.
    const outputDir = join(FIXTURE_DIR, 'received-file');

    const { linkPromise, proc: sender } = spawnSend(fixturePath);
    try {
        const roomLink = await linkPromise;
        expect(roomLink).toContain('#room=');

        // Resolves only when the receiver exits 0, which its integrity guard
        // ties to every byte of every file being written to disk.
        await spawnReceive(roomLink, outputDir);

        const receivedPath = join(outputDir, basename(fixturePath));
        expect(existsSync(receivedPath)).toBe(true);
        expect(sha256OfFile(receivedPath)).toBe(expectedHash);

        // The assertion browser interop cannot make: after the receiver's
        // "received" confirmation the sender must terminate cleanly on its own.
        expect(await waitForExit(sender, CLI_TIMEOUT_MS)).toBe(0);
    } finally {
        sender.kill();
    }
});

test('CLI to CLI: folder transfer preserves structure', async () => {
    // ASCII-only names, and no empty directories: the sender walks FILES only,
    // so an empty directory would never be recreated on the receiving side.
    const sendRoot = join(FIXTURE_DIR, 'send-root');
    const files = [
        { rel: ['a.txt'], size: 1024 },
        { rel: ['b.bin'], size: 256 * 1024 + 13 },
        { rel: ['nested', 'c.bin'], size: 1024 * 1024 },
    ].map((f) => ({
        ...f,
        sha256: writeRandomFile(join(sendRoot, ...f.rel), f.size),
    }));

    const outputDir = join(FIXTURE_DIR, 'received-folder');

    const { linkPromise, proc: sender } = spawnSend(sendRoot);
    try {
        const roomLink = await linkPromise;
        await spawnReceive(roomLink, outputDir);

        // The sender names each file relative to the PARENT of the sent folder
        // and the receiver re-joins that name under the output dir, so the
        // received layout is <outputDir>/send-root/<relative path>.
        for (const f of files) {
            const receivedPath = join(outputDir, 'send-root', ...f.rel);
            expect(existsSync(receivedPath), `${f.rel.join('/')} should exist`).toBe(true);
            expect(sha256OfFile(receivedPath), `${f.rel.join('/')} content hash`).toBe(f.sha256);
        }

        expect(await waitForExit(sender, CLI_TIMEOUT_MS)).toBe(0);
    } finally {
        sender.kill();
    }
});
