/**
 * The heavy request-link cells, local only (S1-WEB-06's automated half, D-109
 * FT-18): M-07, a 1,000-file folder, and M-08, one file of 4 GiB + 1 B, each
 * sent from the /r visitor page to the Go host harness in request mode with
 * the receiver's request limits on (-max-files, so layer 2 runs).
 *
 * Each test skips unless FLOE_E2E_HEAVY=1, so no CI leg ever runs them:
 *   FLOE_E2E_HEAVY=1 corepack pnpm exec playwright test e2e/request-heavy.spec.ts --retries=0
 * The fixtures are generated at test time under one temp folder that the
 * afterEach removes with everything the host received.
 *
 * Privacy, as in request-link.spec.ts: a STUN-only ICE list (every cell is
 * direct) and stats attempts counted, which must be 0. Contents are compared
 * only through deliveredMismatch, whose failure names a path and never a
 * digest. A failed harness wait reports event names and counts only: the
 * harness's own failure text redacts the link and the room id, but here it
 * would also list up to 1,000 file-committed events.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { countLine, sendLabel, visitorCopy } from '../lib/request/visitorCopy';
import { MAX_REQUEST_FILES } from '../lib/request/constants';
import { MAX_CHUNK, READ_SLAB } from '../lib/transfer/protocol';
import {
    countStatsAttempts,
    deliveredMismatch,
    requestLink,
    sha256Manifest,
    startRequestHost,
    stunOnlyIce,
    waitForHostEvent,
    type RequestHost,
    type RequestHostEvent,
    type RequestHostOptions,
} from './request-helpers';

const HEAVY_SKIP = 'heavy local-only cell (S1-WEB-06, FT-18); never on CI';
const KiB = 1024;
const MiB = 1024 * KiB;
const MINUTE = 60_000;

/** M-07: the folder the visitor picks, and how many files it holds. */
const M07_ROOT = 'm07-tree';
const M07_FILES = 1000;
/** M-08: 4 GiB + 1 B, one byte past what a 32-bit unsigned size can hold. */
const M08_NAME = 'm08-4gib-plus-1.bin';
const M08_SIZE = 4 * 1024 * MiB + 1;

interface Scratch {
    root: string;
    sendDir: string;
    outDir: string;
    hosts: RequestHost[];
}

let scratch: Scratch;

test.beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'floe-request-heavy-'));
    const sendDir = join(root, 'send');
    const outDir = join(root, 'out');
    mkdirSync(sendDir);
    mkdirSync(outDir);
    scratch = { root, sendDir, outDir, hosts: [] };
});

test.afterEach(async () => {
    for (const h of scratch.hosts) h.stop();
    await Promise.all(scratch.hosts.map((h) => h.exited));
    rmSync(scratch.root, { recursive: true, force: true });
});

function host(opts: Omit<RequestHostOptions, 'outDir'>): RequestHost {
    const h = startRequestHost({ outDir: scratch.outDir, ...opts });
    scratch.hosts.push(h);
    return h;
}

/** Event names and counts, plus the error stage word: never an event's fields. */
function eventSummary(h: RequestHost): string {
    const counts = new Map<string, number>();
    for (const e of h.events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    const stage = h.events.find((e) => e.event === 'error')?.stage;
    const tail = typeof stage === 'string' && /^[a-z-]{1,32}$/.test(stage) ? `; error stage ${stage}` : '';
    return [...counts].map(([name, n]) => `${name} x${n}`).join(', ') + tail;
}

async function hostEvent(h: RequestHost, name: string, timeoutMs: number): Promise<RequestHostEvent> {
    try {
        return await waitForHostEvent(h, name, timeoutMs);
    } catch {
        throw new Error(`harness: no "${name}" within ${timeoutMs} ms (events: ${eventSummary(h)})`);
    }
}

/** Load the harness's link without its text reaching a failure message. */
async function openLink(page: Page, h: RequestHost): Promise<void> {
    let link: string;
    try {
        link = await requestLink(h);
    } catch {
        throw new Error(`harness printed no link (events: ${eventSummary(h)})`);
    }
    try {
        await page.goto(link);
    } catch (e) {
        const name = e instanceof Error ? e.name : 'unknown';
        throw new Error(`the /r page did not load (${name}; the link is withheld)`);
    }
}

async function guard(context: BrowserContext) {
    await stunOnlyIce(context);
    return countStatsAttempts(context);
}

/** A small seeded generator (mulberry32), so the tree's shape and sizes are
 *  the same on every run; the contents are fresh random bytes each time. */
function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * M-07's tree: 1,000 files at 0 to 5 folders below the root, three folder
 * names per level. Mixed sizes: the chunk and read-slab boundaries first, four
 * empty files, then about 60% up to 4 KiB, 30% up to 256 KiB and 10% up to
 * 2 MiB. Every file name is unique, so a path can only match itself.
 */
function m07Layout(): Array<{ rel: string; size: number; depth: number }> {
    const rand = seeded(7);
    const edges = [MAX_CHUNK - 1, MAX_CHUNK, MAX_CHUNK + 1, READ_SLAB - 1, READ_SLAB, READ_SLAB + 1];
    const out: Array<{ rel: string; size: number; depth: number }> = [];
    for (let i = 0; i < M07_FILES; i++) {
        const depth = Math.floor(rand() * 6);
        const dirs: string[] = [];
        for (let level = 1; level <= depth; level++) dirs.push(`l${level}${'abc'[Math.floor(rand() * 3)]}`);
        let size: number;
        const r = rand();
        if (i < edges.length) size = edges[i];
        else if (i % 250 === 7) size = 0;
        else if (r < 0.6) size = 1 + Math.floor(rand() * 4 * KiB);
        else if (r < 0.9) size = 4 * KiB + Math.floor(rand() * 252 * KiB);
        else size = 256 * KiB + Math.floor(rand() * 1792 * KiB);
        out.push({ rel: [M07_ROOT, ...dirs, `f${String(i).padStart(4, '0')}.bin`].join('/'), size, depth });
    }
    return out;
}

/**
 * M-08's file, made in seconds: sparse on NTFS (fsutil; on failure NTFS just
 * zero-fills it), extended to its size with ftruncate, then random blocks
 * written where an offset bug would show: every 256 MiB, across 2 GiB (a
 * signed 32-bit offset) and across 4 GiB (an unsigned one), through the last
 * byte. About 3 MiB of it is random; the rest reads as zeros.
 */
function makeLargeFile(path: string): void {
    writeFileSync(path, '');
    if (process.platform === 'win32') {
        try {
            execFileSync('fsutil', ['sparse', 'setflag', path], { stdio: 'ignore' });
        } catch {
            // Not sparse: correct, only slower to make and larger on disk.
        }
    }
    const fd = openSync(path, 'r+');
    try {
        ftruncateSync(fd, M08_SIZE);
        const marks: Array<[number, number]> = [];
        for (let at = 0; at + 64 * KiB <= M08_SIZE; at += 256 * MiB) marks.push([at, 64 * KiB]);
        marks.push([2 ** 31 - 512 * KiB, MiB], [2 ** 32 - 512 * KiB, M08_SIZE - (2 ** 32 - 512 * KiB)]);
        for (const [at, len] of marks) writeSync(fd, randomBytes(len), 0, len, at);
    } finally {
        closeSync(fd);
    }
}

/**
 * The received paths with the drop folder the host puts in front of every one
 * removed, or null when the files do not share one prefix. The prefix is read
 * off the file whose name is unique, so any other layout fails the compare.
 */
function receivedRelativePaths(anchor: string): string[] | null {
    const got = Object.keys(sha256Manifest(scratch.outDir));
    const hit = got.find((k) => k === anchor || k.endsWith('/' + anchor));
    if (!hit) return null;
    const prefix = hit.slice(0, hit.length - anchor.length);
    if (prefix !== '' && !/^[^/]+\/$/.test(prefix)) return null;
    if (!got.every((k) => k.startsWith(prefix))) return null;
    return got.map((k) => k.slice(prefix.length)).sort();
}

test.describe('request-heavy', () => {
    test('request-heavy: M-07 a 1,000-file folder arrives intact with the limits on', async ({ page, context }, testInfo) => {
        test.skip(process.env.FLOE_E2E_HEAVY !== '1', HEAVY_SKIP);
        test.setTimeout(20 * MINUTE);
        const stats = await guard(context);

        const layout = m07Layout();
        for (const f of layout) {
            const full = join(scratch.sendDir, ...f.rel.split('/'));
            mkdirSync(join(full, '..'), { recursive: true });
            writeFileSync(full, randomBytes(f.size));
        }
        expect(Math.max(...layout.map((f) => f.depth))).toBe(5);
        const sent = sha256Manifest(scratch.sendDir);
        const sentPaths = Object.keys(sent).sort();
        expect(sentPaths).toHaveLength(M07_FILES);
        const totalBytes = layout.reduce((n, f) => n + f.size, 0);

        // The cap is the file count itself: the last file's metadata frame is
        // the MaxFiles-th (E-37), so a count off by one refuses the drop.
        const h = host({ decide: 'accept', maxFiles: M07_FILES, timeout: '18m' });
        await openLink(page, h);
        await page.locator('input[webkitdirectory]').setInputFiles(join(scratch.sendDir, M07_ROOT));
        await expect(page.getByText(countLine(M07_FILES, totalBytes))).toBeVisible();
        const sendButton = page.getByRole('button', { name: sendLabel(M07_FILES) });
        const sentAt = Date.now();
        await sendButton.click();

        await expect(page.getByRole('heading', { name: `ALL ${M07_FILES} FILES ARRIVED` })).toBeVisible({
            timeout: 15 * MINUTE,
        });
        const done = await hostEvent(h, 'done', MINUTE);
        testInfo.annotations.push({ type: 'M-07 duration ms', description: String((done.receivedAt ?? Date.now()) - sentAt) });
        expect(done.files).toBe(M07_FILES);
        expect(done.verified).toBe(M07_FILES);
        await expect(page.getByText(visitorCopy.shaMatched)).toBeVisible();

        expect(deliveredMismatch(scratch.outDir, sent)).toBeNull();
        const got = receivedRelativePaths(sentPaths[0]);
        expect(got, 'the received files share no single drop folder').not.toBeNull();
        expect(got).toHaveLength(M07_FILES);
        expect(got).toEqual(sentPaths);
        expect(await stats()).toBe(0);
    });

    test('request-heavy: M-08 one 4 GiB + 1 B file arrives intact over a direct route', async ({ page, context }, testInfo) => {
        test.skip(process.env.FLOE_E2E_HEAVY !== '1', HEAVY_SKIP);
        test.setTimeout(45 * MINUTE);
        const stats = await guard(context);

        const file = join(scratch.sendDir, M08_NAME);
        makeLargeFile(file);
        expect(statSync(file).size).toBe(M08_SIZE);
        const sent = sha256Manifest(scratch.sendDir);

        const h = host({ decide: 'accept', maxFiles: MAX_REQUEST_FILES, timeout: '40m' });
        await openLink(page, h);
        await page.locator('input[type=file]:not([webkitdirectory])').first().setInputFiles(file);
        await expect(page.getByText(countLine(1, M08_SIZE))).toBeVisible();
        // Direct only: Hide my IP stays off, so the 2 GB relay cap is not in play.
        await expect(page.getByLabel(visitorCopy.hideIp)).not.toBeChecked();
        const sentAt = Date.now();
        await page.getByRole('button', { name: sendLabel(1) }).click();

        await expect(page.getByRole('heading', { name: '1 FILE ARRIVED' })).toBeVisible({ timeout: 40 * MINUTE });
        const done = await hostEvent(h, 'done', 5 * MINUTE);
        testInfo.annotations.push({ type: 'M-08 duration ms', description: String((done.receivedAt ?? Date.now()) - sentAt) });
        expect(done.files).toBe(1);
        expect(done.verified).toBe(1);
        expect(h.events.find((e) => e.event === 'route')?.path).toBe('direct');
        await expect(page.getByText(/, direct\.( |$)/)).toBeVisible();

        expect(deliveredMismatch(scratch.outDir, sent)).toBeNull();
        const got = receivedRelativePaths(M08_NAME);
        expect(got).toEqual([M08_NAME]);
        expect(await stats()).toBe(0);
    });
});
