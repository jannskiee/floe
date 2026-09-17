/**
 * The browser half of the Request link pairing proof (09 2.3 layer B).
 *
 * A Go host (cli/internal/e2ehost, built by global-setup) joins a room first,
 * makes the WebRTC offer and RECEIVES; a Chromium page runs a simple-peer
 * initiator:false peer, answers, and SENDS with the real sendFiles engine.
 * No shipped surface pairs this way yet, which is the point: the direction is
 * proven before any UI depends on it.
 *
 * The page is a page.route fulfilment and the sender is an esbuild bundle in
 * the e2e temp directory, so client/app gains nothing and the spec runs the
 * same against `next dev` locally and `next start` in CI. Neither test asserts
 * a role name: today's server calls the first joiner "sender".
 *
 * The Playwright server's MAX_CONNECTIONS_PER_IP: '1000' (playwright.config.ts)
 * must stay: at the default 30 per minute a looping run is refused.
 */

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, readdirSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { LOOPBACK_BUNDLE } from './cli-binary';
import { SERVER_URL, WEB_URL, createFixture, sha256OfFile } from './helpers';

const FIXTURE_DIR = join(tmpdir(), 'floe-loopback-host');
const PAGE_URL = `${WEB_URL}/__floe-loopback`;
const requireFromClient = createRequire(join(__dirname, '..', 'package.json'));

test.afterAll(() => {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function hostBinary(): string {
    const bin = process.env.FLOE_E2E_HOST_BINARY;
    if (!bin) {
        throw new Error('FLOE_E2E_HOST_BINARY is not set; run this spec through `pnpm exec playwright test`.');
    }
    return bin;
}

type HostEvent = { event: string; [key: string]: unknown };

interface Host {
    proc: ChildProcess;
    events: HostEvent[];
    /** Resolves with the first event of that name; rejects on exit or error first. */
    waitFor(name: string, timeoutMs: number): Promise<HostEvent>;
    /** Resolves with the exit code. */
    exited: Promise<number | null>;
}

/**
 * Spawn the harness in host mode. Every stdout line must parse as JSON: the
 * harness contract is fixed words only, so a stray line fails the test.
 */
function spawnHost(roomId: string, outDir: string, extra: string[] = []): Host {
    const proc = spawn(hostBinary(), [
        'host', '-server', SERVER_URL, '-room', roomId, '-out', outDir, ...extra,
    ]);
    const events: HostEvent[] = [];
    const waiters: Array<() => void> = [];
    let buffered = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        let nl: number;
        while ((nl = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, nl).trim();
            buffered = buffered.slice(nl + 1);
            if (!line) continue;
            let parsed: HostEvent;
            try {
                parsed = JSON.parse(line) as HostEvent;
            } catch {
                parsed = { event: 'unparsed-line' };
            }
            events.push(parsed);
            waiters.splice(0).forEach((w) => w());
        }
    });
    const exited = new Promise<number | null>((resolve) => {
        proc.on('close', (code) => {
            waiters.splice(0).forEach((w) => w());
            resolve(code);
        });
        proc.on('error', () => resolve(-1));
    });
    let closed = false;
    exited.then(() => { closed = true; });

    const waitFor = (name: string, timeoutMs: number) =>
        new Promise<HostEvent>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`harness did not emit "${name}" within ${timeoutMs} ms: ${JSON.stringify(events)}`)),
                timeoutMs,
            );
            const check = () => {
                const hit = events.find((e) => e.event === name);
                const failed = events.find((e) => e.event === 'error');
                if (hit) { clearTimeout(timer); resolve(hit); return; }
                if (failed || closed) {
                    clearTimeout(timer);
                    reject(new Error(`harness ended before "${name}": ${JSON.stringify(events)}`));
                    return;
                }
                waiters.push(check);
            };
            check();
        });

    return { proc, events, waitFor, exited };
}

/**
 * Open the routed page, load simple-peer, Socket.IO and the sender bundle, pick
 * the files, then join the room as the non-initiator and send. Resolves with
 * the page-side outcome and how long sendFiles took.
 */
async function browserSend(
    page: Page,
    roomId: string,
    files: string[],
    ackTimeoutMs?: number,
): Promise<{ ok: boolean; error: string | null; elapsedMs: number }> {
    // A page.route fulfilment has no network address of its own, so Chromium's
    // Local Network Access check treats the document as public and refuses its
    // Socket.IO polling to localhost:3001 ("Permission was denied for this request
    // to access the `loopback` address space", measured on Chromium 151). The app
    // itself is served from loopback, and production is public to public, so only
    // this test-made page needs the permission.
    await page.context().grantPermissions(['local-network-access'], { origin: WEB_URL });
    await page.route(PAGE_URL, (route) => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>loopback</title><input type="file" id="files" multiple>',
    }));
    await page.goto(PAGE_URL);
    await page.addScriptTag({ path: requireFromClient.resolve('simple-peer/simplepeer.min.js') });
    await page.addScriptTag({ path: requireFromClient.resolve('socket.io-client/dist/socket.io.js') });
    await page.addScriptTag({ path: LOOPBACK_BUNDLE });
    await page.setInputFiles('#files', files);

    return page.evaluate(
        ({ roomId, serverUrl, ackTimeoutMs }) => new Promise<{ ok: boolean; error: string | null; elapsedMs: number }>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            const input = document.getElementById('files') as HTMLInputElement;
            const entries = Array.from(input.files ?? []).map((file) => ({ id: crypto.randomUUID(), file }));
            const socket = w.io(serverUrl);
            const peer = new w.SimplePeer({
                initiator: false,
                trickle: true,
                readableObjectMode: true,
                config: { iceServers: [] },
            });
            let settled = false;
            const finish = (ok: boolean, error: string | null, elapsedMs: number) => {
                if (settled) return;
                settled = true;
                resolve({ ok, error, elapsedMs });
            };
            peer.on('signal', (signal: unknown) => socket.emit('signal', { target: null, roomId, signal }));
            socket.on('signal', (d: { signal: unknown }) => peer.signal(d.signal));
            peer.on('error', (e: Error) => finish(false, `peer: ${e.message}`, 0));
            peer.on('connect', () => {
                const started = performance.now();
                w.floeLoopback.sendFiles(
                    {
                        send: (d: string | Uint8Array) => peer.send(d),
                        onData: (h: (d: unknown) => void) => { peer.on('data', h); return () => peer.off('data', h); },
                        channel: peer._channel,
                        sctpMaxMessageSize: peer._pc?.sctp?.maxMessageSize,
                    },
                    entries,
                    {
                        onError: (msg: string) => finish(false, msg, performance.now() - started),
                        onAllSent: () => finish(true, null, performance.now() - started),
                    },
                    ackTimeoutMs === undefined ? undefined : { ackTimeoutMs },
                ).catch((e: unknown) => finish(false, `sendFiles threw: ${String(e)}`, performance.now() - started));
            });
            socket.on('connect', () => socket.emit('join-room', roomId));
        }),
        { roomId, serverUrl: SERVER_URL, ackTimeoutMs },
    );
}

/**
 * The page result, or a failure carrying the harness events as soon as the
 * harness ends without finishing, instead of a blind page.evaluate timeout.
 */
async function sendWhileHostRuns(host: Host, send: Promise<{ ok: boolean; error: string | null; elapsedMs: number }>) {
    const hostEnded = host.exited.then((code) => {
        if (code === 0 && host.events.some((e) => e.event === 'done')) return new Promise<never>(() => {});
        throw new Error(`harness exited ${code} before the page finished: ${JSON.stringify(host.events)}`);
    });
    return Promise.race([send, hostEnded]);
}

function expectNoPart(outDir: string): void {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(join(dir, d.name)) : [d.name]);
    expect(walk(outDir).filter((n) => n.endsWith('.part'))).toEqual([]);
}

test('browser non-initiator sends to a Go host that offered', async ({ page }) => {
    const fixtures = [1024, 262_157, 12 * 1024 * 1024].map((size) => createFixture(FIXTURE_DIR, size));
    const outDir = join(FIXTURE_DIR, `out-${randomUUID()}`);
    mkdirSync(outDir, { recursive: true });
    const roomId = randomUUID();

    const host = spawnHost(roomId, outDir);
    try {
        // The host must hold seat 0 before the page joins.
        await host.waitFor('joined', 15_000);

        const result = await sendWhileHostRuns(host, browserSend(page, roomId, fixtures.map((f) => f.path)));
        expect(result).toMatchObject({ ok: true, error: null });

        expect(await host.exited).toBe(0);
        const names = host.events.map((e) => e.event);
        expect(names).not.toContain('unparsed-line');
        expect(names).toEqual(['joined', 'offer-sent', 'incoming', 'done']);
        expect(host.events.find((e) => e.event === 'incoming')).toMatchObject({ files: 3 });

        for (const f of fixtures) {
            expect(sha256OfFile(join(outDir, basename(f.path)))).toBe(f.sha256);
        }
        expectNoPart(outDir);
    } finally {
        host.proc.kill();
    }
});

test('Go host holds the ack 20 seconds and the browser waits', async ({ page }) => {
    test.setTimeout(120_000);
    const fixture = createFixture(FIXTURE_DIR, 64 * 1024);
    const outDir = join(FIXTURE_DIR, `out-${randomUUID()}`);
    mkdirSync(outDir, { recursive: true });
    const roomId = randomUUID();

    const host = spawnHost(roomId, outDir, ['-hold', '20s']);
    try {
        await host.waitFor('joined', 15_000);

        const result = await sendWhileHostRuns(host, browserSend(page, roomId, [fixture.path], 60_000));
        expect(result).toMatchObject({ ok: true, error: null });
        // The ack cannot arrive before the hold ends.
        expect(result.elapsedMs).toBeGreaterThanOrEqual(20_000);

        expect(await host.exited).toBe(0);
        expect(host.events.map((e) => e.event)).toEqual(['joined', 'offer-sent', 'incoming', 'done']);
        expect(sha256OfFile(join(outDir, basename(fixture.path)))).toBe(fixture.sha256);
        expectNoPart(outDir);
    } finally {
        host.proc.kill();
    }
});
