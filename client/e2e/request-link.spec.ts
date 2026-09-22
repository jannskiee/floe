/**
 * The request link visitor (/r) against the Go host harness and the local
 * server with request links on (S1-WEB-05; spec 07 4.19; 09 2.6).
 *
 * The server is Playwright's own webServer, which runs with the committed
 * policy fixture (POLICY_FILE, playwright.config.ts) and the sentinel Upstash
 * pair. The host is cli/internal/e2ehost in request mode (built by
 * global-setup.ts), which makes its own token and link and never reports
 * stats. Every test counts stats attempts and expects 0 (E2E-14), and every
 * test but the local relay cell serves a STUN-only ICE list, so the cells stay
 * direct as on the egress-only CI runners.
 *
 * S1-WEB-09 is folded in (D-109 FT-19): there is no gate guard here, so these
 * run in every gated e2e leg. Test 16 keeps its own local-only guard.
 *
 * Three cells need harness pieces that do not exist yet. They are test.fixme
 * with the missing flag named, so none of them can pass silently.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { visitorCopy, refusalCopy } from '../lib/request/visitorCopy';
import { metadataFrameBytes } from '../lib/request/metadataBudget';
import { CONTROL_MSG_MAX, REQUEST_ACK_TIMEOUT_MS, REQUEST_ACK_GRACE_MS } from '../lib/transfer/protocol';
import {
    countStatsAttempts,
    deliveredMismatch,
    directoriesUnder,
    forwardSocketFrames,
    framesFor,
    outgoingCandidateTypes,
    requestLink,
    sha256Manifest,
    startRequestHost,
    stunOnlyIce,
    waitForHostEvent,
    type RequestHost,
    type RequestHostOptions,
} from './request-helpers';

const DELIVERED = /^ALL \d+ FILES ARRIVED$/;
const SEND = /^Send \d+ files?$/;

interface Scratch {
    root: string;
    sendDir: string;
    outDir: string;
    hosts: RequestHost[];
}

let scratch: Scratch;

test.beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'floe-request-link-'));
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

function host(opts: Omit<RequestHostOptions, 'outDir'> = {}): RequestHost {
    const h = startRequestHost({ outDir: scratch.outDir, ...opts });
    scratch.hosts.push(h);
    return h;
}

/** Random files under sendDir at these relative paths; returns path to SHA-256. */
function makeFiles(spec: Record<string, number>): Record<string, string> {
    const manifest: Record<string, string> = {};
    for (const [rel, size] of Object.entries(spec)) {
        const full = join(scratch.sendDir, ...rel.split('/'));
        mkdirSync(join(full, '..'), { recursive: true });
        const bytes = randomBytes(size);
        writeFileSync(full, bytes);
        manifest[rel] = createHash('sha256').update(bytes).digest('hex');
    }
    return manifest;
}

/** Everything a request-link test sets up on its context before the first load. */
async function guard(context: BrowserContext, opts: { stunOnly?: boolean } = {}) {
    if (opts.stunOnly !== false) await stunOnlyIce(context);
    return countStatsAttempts(context);
}

async function pickFiles(page: Page, rels: string[]) {
    await page
        .locator('input[type=file]:not([webkitdirectory])')
        .first()
        .setInputFiles(rels.map((r) => join(scratch.sendDir, ...r.split('/'))));
}

async function send(page: Page) {
    await page.getByRole('button', { name: SEND }).click();
}

async function expectDelivered(page: Page, h: RequestHost, sent: Record<string, string>) {
    await expect(page.getByRole('heading', { name: DELIVERED })).toBeVisible({ timeout: 60_000 });
    await waitForHostEvent(h, 'done', 60_000);
    expect(deliveredMismatch(scratch.outDir, sent)).toBeNull();
}

/** A link of the right shape that no host holds. */
function strayLink(): string {
    return `/r/AAAAAAAAAAA#${randomUUID()}`;
}

test.describe('request-link', () => {
    test('request-link: host absent, then back', async () => {
        test.fixme(
            true,
            'needs a harness way to know the link before the host joins: floe-e2ehost request makes a fresh host token, ' +
                'so the room exists only after it starts. Missing flag: -token <hex> (or -join-after <ms>, printing the link first)'
        );
        // Flow once the flag exists: load the link, pick, Send (C-40, C-41, Try again), start the harness with
        // -decide accept, Try again, delivered, manifests equal, stats 0.
    });

    test('request-link: used link answers room-full while sealed and host-absent after close', async ({ page, context, browser }) => {
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ decide: 'delay:15000' });
        const link = await requestLink(h);

        await page.goto(link);
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.waitingTitle })).toBeVisible();

        // Visitor B while A holds the sealed room.
        const b = await browser.newContext();
        const statsB = await guard(b);
        const pageB = await b.newPage();
        await pageB.goto(link);
        await pickFiles(pageB, ['a.bin']);
        await send(pageB);
        await expect(pageB.getByRole('heading', { name: visitorCopy.usedTitle })).toBeVisible();
        await expect(pageB.getByText(visitorCopy.usedBody)).toBeVisible();

        await expectDelivered(page, h, sent);
        await h.exited;

        // Visitor C after the harness closed the link: the room is gone (OD-28).
        const c = await browser.newContext();
        const statsC = await guard(c);
        const pageC = await c.newPage();
        await pageC.goto(link);
        await pickFiles(pageC, ['a.bin']);
        await send(pageC);
        await expect(pageC.getByRole('heading', { name: visitorCopy.hostAbsentTitle })).toBeVisible();

        expect(await stats([page])).toBe(0);
        expect(await statsB([pageB])).toBe(0);
        expect(await statsC([pageC])).toBe(0);
        await b.close();
        await c.close();
    });

    test('request-link: decline, then keep waiting accepts a second visit', async ({ page, context }) => {
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ decide: 'decline,accept', keepWaiting: true });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);

        await waitForHostEvent(h, 'refused', 60_000);
        await expect(page.getByRole('heading', { name: visitorCopy.declined })).toBeVisible({ timeout: 2_000 });
        expect(Object.keys(sha256Manifest(scratch.outDir))).toEqual([]);

        await waitForHostEvent(h, 'reopened', 30_000);
        await page.getByRole('button', { name: visitorCopy.backToFiles }).click();
        await send(page);
        await expectDelivered(page, h, sent);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: host expired answer times out with nothing sent', async ({ page, context }) => {
        // decide-deadline:3000 in the card; -fast-timers answers expired at 5 s,
        // which is the same cell (the host's own expired answer).
        const stats = await guard(context);
        makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ decide: 'never', fastTimers: true });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.timedOut })).toBeVisible({ timeout: 30_000 });
        expect(Object.keys(sha256Manifest(scratch.outDir))).toEqual([]);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: local first-ack timer times out under clock control', async ({ page, context }) => {
        const stats = await guard(context);
        makeFiles({ 'a.bin': 64 * 1024 });
        // No deadline of the host's own inside this test: the 9 min 45 s window.
        const h = host({ decide: 'never', timeout: '15m' });
        await page.clock.install();
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.waitingTitle })).toBeVisible();
        // Just past the visitor's first-ack clock (FIRST_ACK_TIMEOUT_MS, 10:15),
        // derived from the pair rather than a literal (critic M-04).
        await page.clock.fastForward(REQUEST_ACK_TIMEOUT_MS + REQUEST_ACK_GRACE_MS + 5_000);
        await expect(page.getByRole('heading', { name: visitorCopy.timedOut })).toBeVisible({ timeout: 30_000 });
        expect(await stats([page])).toBe(0);
    });

    test('request-link: a 20 s held ack still delivers', async ({ page, context }) => {
        test.setTimeout(120_000);
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 256 * 1024 });
        const h = host({ decide: 'delay:20000' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);
        const waiting = page.getByRole('heading', { name: visitorCopy.waitingTitle });
        await expect(waiting).toBeVisible();
        await waitForHostEvent(h, 'deciding', 30_000);
        await page.waitForTimeout(19_000);
        await expect(waiting).toBeVisible();
        await expectDelivered(page, h, sent);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: over-approved refusal shows fixed copy and never the reason', async () => {
        test.fixme(
            true,
            'needs the harness limit flags -max-bytes and -max-files (transfer.ReceiveLimits, after WP-A1) and the ' +
                'reason:<text> cue that writes its own refusal frame with a hostile reason'
        );
        // Flow once they exist: a limit below the payload, reason
        // `<img src=x onerror=alert(1)> $(calc)` plus U+202E; the over-approved
        // copy shows; page.content() contains none of the reason; no dialog; no .part; stats 0.
    });

    test('request-link: folder delivered intact with SHA-256', async ({ page, context }) => {
        const stats = await guard(context);
        const sent = makeFiles({
            'send-root/a.txt': 1024,
            'send-root/b.bin': 262157,
            'send-root/nested/c.bin': 1024 * 1024,
        });
        mkdirSync(join(scratch.sendDir, 'send-root', 'empty'));
        const h = host({ decide: 'accept' });
        await page.goto(await requestLink(h));
        await page.locator('input[webkitdirectory]').setInputFiles(join(scratch.sendDir, 'send-root'));
        await send(page);
        await expectDelivered(page, h, sent);
        expect(directoriesUnder(scratch.outDir).some((d) => d.endsWith('empty'))).toBe(false);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: socket loss after the channel opens causes no teardown', async ({ page, context }) => {
        const stats = await guard(context);
        const frames = await forwardSocketFrames(page);
        const sent = makeFiles({ 'big.bin': 16 * 1024 * 1024 });
        const h = host({ decide: 'accept', blipAfter: 'accepted' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['big.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: /^SENDING \d+ OF \d+$/ })).toBeVisible();
        await frames.closePageSockets();
        await waitForHostEvent(h, 'blip', 30_000);
        await expectDelivered(page, h, sent);
        expect(framesFor(frames.outgoing, 'request-join')).toHaveLength(1);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: reopen evicts a stalled visitor and the next visit delivers', async () => {
        test.fixme(true, 'needs the harness decide cues offer:skip (join, never offer) and reopen-after:<ms> (request-reopen while seat 1 is held)');
        // Flow once they exist: offer:skip plus reopen-after:3000; C-52 with Try
        // again within 6 s; the harness switches to accept; Try again delivers.
    });

    test('request-link: hash lines follow verified, and a corrupt hash deletes the file', async ({ page, context }) => {
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 128 * 1024 });
        const good = host({ decide: 'accept' });
        await page.goto(await requestLink(good));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expectDelivered(page, good, sent);
        await expect(page.getByText(visitorCopy.shaMatched)).toBeVisible();
        await good.exited;

        // A second link whose host corrupts every digest: the engine's own
        // compare refuses the file and nothing final is left.
        rmSync(scratch.outDir, { recursive: true, force: true });
        mkdirSync(scratch.outDir);
        const bad = host({ decide: 'accept', corruptHash: true });
        await page.goto(await requestLink(bad));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: refusalCopy('hash-mismatch', 0, 1).title })).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByText(visitorCopy.shaMatched)).toHaveCount(0);
        expect(Object.keys(sha256Manifest(scratch.outDir))).toEqual([]);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: no socket and no turn-credentials request before Send', async ({ page, context }) => {
        const stats = await guard(context);
        const seen: string[] = [];
        page.on('request', (r) => {
            if (/socket\.io|turn-credentials/.test(r.url())) seen.push(r.url());
        });
        page.on('websocket', (ws) => {
            if (/socket\.io/.test(ws.url())) seen.push(ws.url());
        });
        makeFiles({ 'a.bin': 1024 });
        await page.goto(strayLink());
        await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
        await pickFiles(page, ['a.bin']);
        await expect(page.getByRole('button', { name: SEND })).toBeEnabled();
        expect(seen).toEqual([]);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: Hide my IP without a relay stops before joining', async ({ page, context }) => {
        const stats = await guard(context);
        const frames = await forwardSocketFrames(page);
        makeFiles({ 'a.bin': 1024 });
        await page.goto(strayLink());
        await pickFiles(page, ['a.bin']);
        await page.getByLabel(visitorCopy.hideIp).check();
        await send(page);
        await expect(page.getByText(visitorCopy.hideIpNeedsRelay)).toBeVisible();
        expect(framesFor(frames.outgoing, 'request-join')).toHaveLength(0);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: metadata over the cap is refused at pick time', async ({ page, context }) => {
        const stats = await guard(context);
        // A name whose metadata frame, measured the page's own way, is exactly
        // one byte over CONTROL_MSG_MAX.
        let name = 'x';
        while (metadataFrameBytes(name, 1, 1, 1) < CONTROL_MSG_MAX + 1) name += 'x';
        expect(metadataFrameBytes(name, 1, 1, 1)).toBe(CONTROL_MSG_MAX + 1);
        await page.goto(strayLink());
        await page
            .locator('input[type=file]:not([webkitdirectory])')
            .first()
            .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('a') });
        await expect(page.getByText(visitorCopy.pathTooLong)).toBeVisible();
        await expect(page.getByRole('button', { name: SEND })).toHaveCount(0);
        expect(await stats([page])).toBe(0);
    });

    test('request-link: beforeunload guards Waiting for accept', async ({ page, context }) => {
        const stats = await guard(context);
        makeFiles({ 'a.bin': 1024 });
        const h = host({ decide: 'delay:60000' });
        const dialogs: string[] = [];

        // Ready: no prompt.
        const ready = await context.newPage();
        ready.on('dialog', (d) => {
            dialogs.push(`ready:${d.type()}`);
            void d.dismiss();
        });
        await ready.goto(strayLink());
        await expect(ready.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
        await ready.close({ runBeforeUnload: true });

        // Waiting (V7): the browser's own prompt.
        page.on('dialog', (d) => {
            dialogs.push(`waiting:${d.type()}`);
            void d.dismiss();
        });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.waitingTitle })).toBeVisible();
        const stillOpen = page.waitForEvent('dialog');
        await page.close({ runBeforeUnload: true });
        await stillOpen;
        expect(dialogs).toEqual(['waiting:beforeunload']);
        expect(await stats([])).toBe(0);
    });

    test('request-link: Hide my IP delivers over the local relay with relay-only candidates', async ({ page, context }) => {
        test.skip(process.env.FLOE_E2E_LOCAL_TURN !== '1', 'needs the SETUP-04 local coturn; never on CI');
        // No stunOnlyIce here: this cell needs the relay the local server serves.
        const stats = await guard(context, { stunOnly: false });
        const frames = await forwardSocketFrames(page);
        const sent = makeFiles({ 'relay.bin': 4 * 1024 * 1024 });
        const h = host({ decide: 'accept' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['relay.bin']);
        await page.getByLabel(visitorCopy.hideIp).check();
        await send(page);
        await expectDelivered(page, h, sent);
        await expect(
            page.getByText(visitorCopy.hideIpNeedsRelay),
            'no turn: URL was served; check the SETUP-04 coturn and its session variables'
        ).toHaveCount(0);
        const types = outgoingCandidateTypes(frames.outgoing);
        expect(types.length).toBeGreaterThan(0);
        expect(types.every((t) => t === 'relay')).toBe(true);
        const route = await waitForHostEvent(h, 'route', 5_000);
        expect(route.path).toBe('relay');
        await expect(page.getByText(/, relay\.( |$)/)).toBeVisible();
        expect(await stats([page])).toBe(0);
    });
});
