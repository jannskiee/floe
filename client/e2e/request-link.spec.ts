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
 * The over-approved refusal cell (F5-03) has the harness send that refusal
 * frame itself (-stop-after-file), with a hostile reason: an honest browser
 * can never make a host say over-approved.
 *
 * The flow's cells run twice, on a keyed link, the one Floe Desktop 1.1 makes, so the whole
 * flow runs behind the visitor's check of the key, and on a bare one, every link Desktop 1.0.x
 * makes. Each cell after them runs with a keyed host unless it says bare (key: false). Each
 * host comes through its own door to the server (signalingDoor in request-helpers.ts),
 * because the server allows 20 new links per network address a day.
 */

import { test, expect, firefox, type Browser, type BrowserContext, type Dialog, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { visitorCopy, refusalCopy, sendingHeader, statusCopy } from '../lib/request/visitorCopy';
import { initialModel, reduce } from '../lib/request/visitorState';
import { LOST_KEY } from '../lib/request/lostRecord';
import { metadataFrameBytes } from '../lib/request/metadataBudget';
import { RELAY_BLOCK_REASON, RELAY_PROBE_DELAY_MS } from '../lib/request/constants';
import {
    CONTROL_MSG_MAX,
    ENFORCE_LINK_KEYS,
    KEY_CHECK_WAIT_MS,
    REQUEST_ACK_TIMEOUT_MS,
    REQUEST_ACK_GRACE_MS,
    SENDER_UNVERIFIED_REASON,
} from '../lib/transfer/protocol';
import { WEB_URL } from './helpers';
import { startScriptedHost, type ScriptedHost, type ScriptedHostOptions } from './request-scripted-host';
import {
    channelSent,
    channelText,
    countStatsAttempts,
    deliveredMismatch,
    directoriesUnder,
    forwardSocketFrames,
    framesFor,
    outgoingCandidateTypes,
    partsOfRequestLink,
    requestLink,
    sha256Manifest,
    startRequestHost,
    stunOnlyIce,
    traceRecords,
    waitForHostEvent,
    watchChannel,
    type RequestHost,
    type RequestHostOptions,
} from './request-helpers';

// One file reads in the singular (D-123): "1 FILE ARRIVED", never "ALL 1 FILES ARRIVED".
const DELIVERED = /^(ALL \d+ FILES|1 FILE) ARRIVED$/;
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

// Set for the whole of one describe block, below: its hosts make bare links.
let bareHosts = false;

function host(opts: Omit<RequestHostOptions, 'outDir'> = {}): RequestHost {
    const h = startRequestHost({ outDir: scratch.outDir, key: !bareHosts, ...opts });
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

/** C-111 as the page words it after a discard's reload with these counts,
 *  from the reducer and the copy module the page itself uses. */
function restoredLostLine(arrived: number, total: number): string {
    const ready = reduce(initialModel, { type: 'LINK_OK', roomId: randomUUID(), keyed: false }).model;
    const lost = reduce(ready, { type: 'RESTORE_LOST', arrived, total }).model;
    const copy = statusCopy(lost, { pathAt: () => undefined, route: null, now: 0 });
    if (copy?.lines.length !== 1) throw new Error(`no Lost card for ${arrived} of ${total}`);
    return copy.lines[0];
}

/** The document.wasDiscarded a discard's reload reads. No CDP command discards
 *  a tab, and chrome://discards refuses while DevTools is attached, so the flag
 *  is stubbed; the record the page reads is the one it wrote, or a seed. */
function stubDiscard(): void {
    Object.defineProperty(Document.prototype, 'wasDiscarded', { configurable: true, get: () => true });
}

/** Every key and value in the page's sessionStorage and localStorage. */
async function storedPairs(page: Page): Promise<Array<[string, string]>> {
    return page.evaluate(() => {
        const out: Array<[string, string]> = [];
        for (const store of [sessionStorage, localStorage]) {
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i) ?? '';
                out.push([key, store.getItem(key) ?? '']);
            }
        }
        return out;
    });
}

const everyLink = () => {
    test('request-link: host absent, then back', async ({ page, context }) => {
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024 });
        // The harness prints the link and claims the room only when this
        // side says so, after the page has shown host-absent: no fixed window
        // that a cold compile of /r could outrun (review 1, F3).
        const h = host({ decide: 'accept', joinOnStdin: true });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.hostAbsentTitle })).toBeVisible();
        await expect(page.getByText(visitorCopy.hostAbsentBody)).toBeVisible();
        const tryAgain = page.getByRole('button', { name: visitorCopy.tryAgain });
        await expect(tryAgain).toBeVisible();
        expect(h.events.some((e) => e.event === 'joined')).toBe(false);

        h.join();
        await waitForHostEvent(h, 'joined', 30_000);
        await tryAgain.click();
        await expectDelivered(page, h, sent);
        expect(await stats()).toBe(0);
    });

    test('request-link: keyboard focus follows the card, and the Stop question takes it and gives it back', async ({ page, context }) => {
        test.setTimeout(120_000);
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 256 * 1024, 'b.bin': 256 * 1024 });
        // Host absent first (the room is claimed on join()), then a hold after
        // file 1, so the page sits in Sending with Cancel to press.
        const h = host({ decide: 'accept', joinOnStdin: true, holdAfterFile: 15_000 });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin', 'b.bin']);
        const heading = () =>
            page.evaluate(() => (document.activeElement?.matches('h1[data-card-heading]') ? document.activeElement.textContent : null));
        const focused = () => page.evaluate(() => document.activeElement?.textContent ?? null);

        // The pressed Send is gone with its card: focus is on the new card's
        // heading, not <body>.
        await page.getByRole('button', { name: /^Send / }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', { name: visitorCopy.hostAbsentTitle })).toBeVisible();
        await expect.poll(heading).toBe(visitorCopy.hostAbsentTitle);

        h.join();
        await waitForHostEvent(h, 'joined', 30_000);
        await page.getByRole('button', { name: visitorCopy.tryAgain }).focus();
        await page.keyboard.press('Enter');
        await waitForHostEvent(h, 'holding', 60_000);
        await expect(page.getByRole('heading', { name: sendingHeader(1, 2) })).toBeVisible();

        // Cancel opens the question and hands focus to Keep sending; Keep
        // sending closes it and hands focus back to Cancel.
        await page.getByRole('button', { name: visitorCopy.cancel, exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('group', { name: visitorCopy.stopTitle })).toBeVisible();
        await expect.poll(focused).toBe(visitorCopy.keepSending);
        await page.keyboard.press('Enter');
        await expect.poll(focused).toBe(visitorCopy.cancel);

        await expectDelivered(page, h, sent);
        await expect.poll(heading).not.toBeNull();
        expect(await stats()).toBe(0);
    });

    test('request-link: used link answers room-full while sealed and after close', async ({ page, context, browser }) => {
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024 });
        // A's hold must outlast B's whole visit (a new context, a load, a
        // pick, a Send and the room-full answer). 30 s, not 15 s, leaves
        // about 25 s of margin on a loaded CI leg (review 1, F4).
        const h = host({ decide: 'delay:30000' });
        const link = await requestLink(h);

        await page.goto(link);
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.waitingTitle })).toBeVisible();

        // Closed on failure too (review 1, N7): they are not Playwright's own.
        const extra: BrowserContext[] = [];
        try {
            // Visitor B while A holds the sealed room.
            const b = await browser.newContext();
            extra.push(b);
            const statsB = await guard(b);
            const pageB = await b.newPage();
            await pageB.goto(link);
            await pickFiles(pageB, ['a.bin']);
            await send(pageB);
            await expect(pageB.getByRole('heading', { name: visitorCopy.usedTitle })).toBeVisible();
            await expect(pageB.getByText(visitorCopy.usedBody)).toBeVisible();

            await expectDelivered(page, h, sent);
            await h.exited;

            // Visitor C after the harness closed the link: the room is gone,
            // and the server's used marker still says so (D-130).
            const c = await browser.newContext();
            extra.push(c);
            const statsC = await guard(c);
            const pageC = await c.newPage();
            await pageC.goto(link);
            await pickFiles(pageC, ['a.bin']);
            await send(pageC);
            await expect(pageC.getByRole('heading', { name: visitorCopy.usedTitle })).toBeVisible();
            await expect(pageC.getByText(visitorCopy.usedBody)).toBeVisible();

            expect(await stats()).toBe(0);
            expect(await statsB()).toBe(0);
            expect(await statsC()).toBe(0);
        } finally {
            for (const x of extra) await x.close();
        }
    });

    // The ended page, read for real. A link its host closed while it waited,
    // with nobody seated, is forgotten by the server, which answers every
    // later request-join link-ended for a day. An expired link gets the same
    // answer (server/server.test.js pins both), so this is the page a visitor
    // reads on either. Until now the card was reached only through the
    // reducer's own tests: no browser had opened a link that had really ended.
    test('request-link: a link closed before anyone used it reads "This link has ended"', async ({ page, context }) => {
        const stats = await guard(context);
        makeFiles({ 'a.bin': 1024 });
        const h = host({ closeBeforeVisit: true });
        const link = await requestLink(h);
        await waitForHostEvent(h, 'closed');
        expect(await h.exited).toBe(0);

        await page.goto(link);
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.endedTitle })).toBeVisible();
        await expect(page.getByText(visitorCopy.endedBody)).toBeVisible();
        // Not the host-absent card, which offers a retry, and not the used one.
        await expect(page.getByRole('button', { name: visitorCopy.tryAgain })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: visitorCopy.hostAbsentTitle })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: visitorCopy.usedTitle })).toHaveCount(0);
        // Nothing was sent anywhere: no file arrived, no report was tried.
        expect(directoriesUnder(scratch.outDir)).toEqual([]);
        expect(await stats()).toBe(0);
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
        expect(await stats()).toBe(0);
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
        expect(await stats()).toBe(0);
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
        expect(await stats()).toBe(0);
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
        const deciding = await waitForHostEvent(h, 'deciding', 30_000);
        // Waiting is checked 15 s into the hold, not 19 s: 5 s of margin
        // before the 20 s accept may end it on a loaded runner (review 1,
        // F4). The full 20 s is proven by the harness's own gap below.
        await page.waitForTimeout(Math.max(0, (deciding.receivedAt ?? 0) + 15_000 - Date.now()));
        await expect(waiting).toBeVisible();
        const accepted = await waitForHostEvent(h, 'accepted', 30_000);
        // Both lines cross the same pipe; 250 ms covers this side's event
        // loop reading them late.
        expect((accepted.receivedAt ?? 0) - (deciding.receivedAt ?? 0)).toBeGreaterThanOrEqual(20_000 - 250);
        // A terminal state before the accept could not end in a delivery.
        await expectDelivered(page, h, sent);
        expect(await stats()).toBe(0);
    });

    test('request-link: over-approved refusal shows fixed copy and never the reason', async ({ page, context }) => {
        // F5-03: the host stops the drop after its first committed file with
        // over-approved and saved 1, as a receiver that refused it would. An
        // honest browser can never make a host say over-approved, so the
        // harness sends the frame itself, with a reason no page may show: a
        // tag with a handler, a shell expansion and U+202E.
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024, 'b.bin': 64 * 1024 });
        const reason = '<img src=x onerror=alert(1)> $(calc)\u202e';
        const dialogs: string[] = [];
        page.on('dialog', (d) => {
            dialogs.push(d.type());
            void d.dismiss();
        });
        const h = host({ decide: 'accept', stopAfterFile: 'over-approved', stopReason: reason });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin', 'b.bin']);
        await send(page);
        const copy = refusalCopy('over-approved', 1, 2);
        await expect(page.getByRole('heading', { name: copy.title })).toBeVisible({ timeout: 60_000 });
        for (const line of copy.lines) await expect(page.getByText(line, { exact: true })).toBeVisible();
        // The refusal (V11) clears the counts the tab kept in Sending
        // (FT-R-DISCARD): a discard from here must not reload to Lost.
        expect(await page.evaluate((key) => sessionStorage.getItem(key), LOST_KEY)).toBeNull();
        expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'over-approved' });
        await waitForHostEvent(h, 'done', 30_000);
        // Nothing of the reason reaches the page, as markup or as text.
        const html = await page.content();
        for (const piece of ['onerror', 'alert(1)', '$(calc)', 'src=x', '\u202e']) {
            expect(html.includes(piece), `the page carries ${JSON.stringify(piece)} from the reason`).toBe(false);
        }
        expect(dialogs).toEqual([]);
        // File 1 was saved; file 2 never landed, not even as a .part.
        const got = sha256Manifest(scratch.outDir);
        expect(Object.keys(got).some((k) => k.endsWith('.part'))).toBe(false);
        expect(Object.values(got)).toEqual([sent['a.bin']]);
        expect(await stats()).toBe(0);
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
        // Weak by construction (review 1, N4): setInputFiles on a
        // webkitdirectory input hands the page a FileList, which never
        // carries an empty folder, so the page cannot see this one. The drop
        // walk that does see empty folders (C-35) is pinned in
        // lib/request/folderWalk.test.ts ("skips and counts empty folders").
        expect(directoriesUnder(scratch.outDir).some((d) => d.endsWith('empty'))).toBe(false);
        expect(await stats()).toBe(0);
    });

    test('request-link: socket loss after the channel opens causes no teardown', async ({ page, context }) => {
        const stats = await guard(context);
        const frames = await forwardSocketFrames(page);
        const sent = makeFiles({ 'a.bin': 256 * 1024, 'b.bin': 256 * 1024 });
        // Timed off the harness, never off a heading a fast machine skips
        // (the first run's failure): the host's own socket blips at file 1's
        // commit (FM6), and then the harness holds its receive loop for 10 s,
        // so the page sits in Sending with the channel open on any machine.
        const h = host({ decide: 'accept', blipAfter: 'file-committed', holdAfterFile: 10_000 });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin', 'b.bin']);
        await send(page);
        await waitForHostEvent(h, 'holding', 60_000);
        const names = h.events.map((e) => e.event);
        expect(names.indexOf('rejoined')).toBeGreaterThan(-1);
        expect(names.indexOf('rejoined')).toBeLessThan(names.indexOf('holding'));
        const sending = page.getByRole('heading', {
            name: new RegExp(`^(${sendingHeader(1, 2)}|${sendingHeader(2, 2)})$`),
        });
        await expect(sending).toBeVisible({ timeout: 5_000 });

        const opened = frames.socketsOpened();
        expect(opened).toBeGreaterThan(0);
        await frames.closePageSockets();
        // Non-vacuity: the page really lost its socket and opened a new one
        // (reconnectionDelay 500 ms, at most 3 s), all inside the hold.
        await expect.poll(() => frames.socketsOpened(), { timeout: 8_000 }).toBeGreaterThan(opened);
        await expect(sending).toBeVisible();
        expect(h.events.some((e) => e.event === 'released')).toBe(false);

        await waitForHostEvent(h, 'released', 20_000);
        await expectDelivered(page, h, sent);
        // Both transports: the join rode polling, and the reconnect re-joined
        // nothing.
        expect(framesFor(frames.outgoing, 'request-join')).toHaveLength(1);
        expect(await stats()).toBe(0);
    });

    test('request-link: reopen evicts a stalled visitor and the next visit delivers', async ({ page, context }) => {
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024 });
        // First visit: seated, never offered to, evicted by the harness's own
        // request-reopen after 3 s (E-03); every later visit is accepted.
        const h = host({ decide: 'reopen-after:3000,accept' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        const sentAt = Date.now();
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.couldNotConnect })).toBeVisible({ timeout: 6_000 });
        // Well inside the 75 s setup timer: the eviction, not the timer, ended it.
        expect(Date.now() - sentAt).toBeLessThan(6_000);
        await waitForHostEvent(h, 'reopened', 5_000);
        await page.getByRole('button', { name: visitorCopy.tryAgain }).click();
        await expectDelivered(page, h, sent);
        expect(await stats()).toBe(0);
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
        expect(await stats()).toBe(0);
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
        expect(await stats()).toBe(0);
    });

    test('request-link: a discarded tab comes back to the Lost copy with its count', async ({ page, context }) => {
        // FT-R-DISCARD: Chrome reloads a tab it discarded mid-drop. The seed is
        // the record the tab keeps in Sending (counts only); the page reads it
        // once, shows C-110 and C-111, and starts nothing.
        const stats = await guard(context);
        // What request-privacy.spec.ts's watchSignaling counts: a socket, a
        // TURN fetch, or /api/config, the first sign of resolving a server.
        const seen: string[] = [];
        const signaling = (u: string) =>
            u.includes('socket.io') || u.includes('turn-credentials') || u.includes('/api/config');
        page.on('request', (r) => {
            if (signaling(r.url())) seen.push(r.url());
        });
        page.on('websocket', (ws) => {
            if (signaling(ws.url())) seen.push(ws.url());
        });
        const record = JSON.stringify({ v: 1, arrived: 1, total: 2 });
        const seed = ([key, value]: readonly [string, string]) => sessionStorage.setItem(key, value);
        await page.addInitScript(stubDiscard);
        await page.addInitScript(seed, [LOST_KEY, record] as const);
        await page.goto(strayLink());
        await expect(page.getByRole('heading', { name: visitorCopy.lostTitle })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText(restoredLostLine(1, 2))).toBeVisible();
        // No name was kept, so no Arrived list; the card has no button.
        await expect(page.getByText(visitorCopy.arrivedHeading, { exact: true })).toHaveCount(0);
        await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
        // Read once: the record is gone.
        expect(await page.evaluate((key) => sessionStorage.getItem(key), LOST_KEY)).toBeNull();
        // Nothing starts: the privacy spec's settle, then no socket and no TURN.
        await page.waitForTimeout(1_000);
        expect(seen).toEqual([]);

        // Any other load: the same record without the flag opens on Ready, and
        // the record is removed all the same.
        const plain = await context.newPage();
        await plain.addInitScript(seed, [LOST_KEY, record] as const);
        await plain.goto(strayLink());
        await expect(plain.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
        await expect(plain.getByRole('heading', { name: visitorCopy.lostTitle })).toHaveCount(0);
        expect(await plain.evaluate((key) => sessionStorage.getItem(key), LOST_KEY)).toBeNull();
        expect(await stats()).toBe(0);
    });

    test('request-link: in Sending the tab keeps counts only, and a discard reload shows them', async ({ page, context }) => {
        test.setTimeout(120_000);
        const stats = await guard(context);
        makeFiles({ 'a.bin': 256 * 1024, 'b.bin': 256 * 1024 });
        // The harness holds its receive loop after file 1, so the page sits in
        // Sending (file 1's ack landed, file 2's has not) with its record
        // written by the page itself.
        const h = host({ decide: 'accept', holdAfterFile: 20_000 });
        const link = await requestLink(h);
        const { linkId, room, key } = partsOfRequestLink(link);
        expect(linkId.length > 0 && room.length > 0 && (bareHosts || !!key)).toBe(true);
        await page.goto(link);
        await pickFiles(page, ['a.bin', 'b.bin']);
        await send(page);
        await waitForHostEvent(h, 'holding', 60_000);
        await expect(page.getByRole('heading', { name: sendingHeader(1, 2) })).toBeVisible();
        const stored = await storedPairs(page);
        // Checked before any value can be printed: a failure message must never
        // carry the link id or the room (describeHarness's rule).
        for (const [name, value] of stored) {
            expect(name.includes(linkId) || value.includes(linkId), 'a stored key or value holds the link id').toBe(false);
            expect(name.includes(room) || value.includes(room), 'a stored key or value holds the room').toBe(false);
            if (key) expect(name.includes(key) || value.includes(key), 'a stored key or value holds the link key').toBe(false);
            const named = ['a.bin', 'b.bin'].some((n) => name.includes(n) || value.includes(n));
            expect(named, 'a stored key or value holds a picked file name').toBe(false);
        }
        expect(stored.filter(([name]) => name.startsWith('floe:'))).toEqual([[LOST_KEY, '{"v":1,"arrived":0,"total":2}']]);

        // A fragment naming another room mid-drop: the drop stays in the room
        // it joined (E29), but Chrome would reload a discarded tab at the
        // address it shows, so the record goes; back at the drop's room, the
        // counts return (review 1 F1). The record is read by a hashchange
        // listener added after the page's own, so it runs in the same dispatch
        // right after it: what the page's handler did, before the sender's
        // 500 ms progress tick could sync the record for it.
        const hashThenRead = (next: string) =>
            page.evaluate(
                ([key, hash]) =>
                    new Promise<string | null>((resolve) => {
                        window.addEventListener('hashchange', () => resolve(sessionStorage.getItem(key)), {
                            once: true,
                        });
                        location.hash = hash;
                    }),
                [LOST_KEY, next] as const
            );
        expect(await hashThenRead(randomUUID())).toBeNull();
        await expect(page.getByRole('heading', { name: sendingHeader(1, 2) })).toBeVisible();
        expect(await hashThenRead(key ? `${room}.${key}` : room)).toBe('{"v":1,"arrived":0,"total":2}');

        // The discard: Chrome reloads the tab at its address with
        // document.wasDiscarded true. The drop is live, so the leave-page
        // prompt is accepted first, or Playwright's auto-dismiss would cancel
        // the reload.
        await page.addInitScript(stubDiscard);
        page.on('dialog', (d) => void d.accept());
        await page.reload();
        await expect(page.getByRole('heading', { name: visitorCopy.lostTitle })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText(restoredLostLine(0, 2))).toBeVisible();
        expect(await page.evaluate((key) => sessionStorage.getItem(key), LOST_KEY)).toBeNull();
        expect(await stats()).toBe(0);
    });

    test('request-link: Hide my IP without a relay stops before joining', async ({ page, context }) => {
        const stats = await guard(context);
        const frames = await forwardSocketFrames(page);
        // The design never opens a socket here: ICE comes first, and V6b ends
        // the attempt before connectSocket. So the proof is "no socket at
        // all", not only "no request-join", which a join riding a socket
        // opened in parallel could slip past.
        const signaling: string[] = [];
        page.on('request', (r) => {
            if (/socket\.io/.test(r.url())) signaling.push(r.url());
        });
        page.on('websocket', (ws) => {
            if (/socket\.io/.test(ws.url())) signaling.push(ws.url());
        });
        makeFiles({ 'a.bin': 1024 });
        await page.goto(strayLink());
        await pickFiles(page, ['a.bin']);
        await page.getByLabel(visitorCopy.hideIp).check();
        await send(page);
        await expect(page.locator('main section').getByText(visitorCopy.hideIpNeedsRelay)).toBeVisible();
        await expect(page.getByRole('status')).toHaveText(visitorCopy.hideIpNeedsRelay);
        // A socket started beside the ICE fetch would show within this window
        // (the privacy spec's settle).
        await page.waitForTimeout(1_000);
        expect(signaling).toEqual([]);
        expect(frames.socketsOpened()).toBe(0);
        expect(framesFor(frames.outgoing, 'request-join')).toHaveLength(0);
        expect(await stats()).toBe(0);
    });

    test('request-link: Hide my IP with an unread relay list says so, and Send reads it again', async ({ page, context }) => {
        // No stunOnlyIce here: this cell answers the ICE request itself, first
        // the way a server limiting the visitor's network does, then with a
        // list that has no relay in it. The real response is never fetched.
        const stats = await guard(context, { stunOnly: false });
        const frames = await forwardSocketFrames(page);
        let asked = 0;
        await context.route('**/api/turn-credentials', (route) => {
            asked += 1;
            return asked === 1
                ? route.fulfill({ status: 429, json: { error: 'Too many requests' } })
                : route.fulfill({ json: [{ urls: 'stun:stun.l.google.com:19302' }] });
        });
        makeFiles({ 'a.bin': 1024 });
        await page.goto(strayLink());
        await pickFiles(page, ['a.bin']);
        await page.getByLabel(visitorCopy.hideIp).check();
        await send(page);
        // The page does not know whether the server has a relay, so it does
        // not say the server has none.
        await expect(page.locator('main section').getByText(visitorCopy.relayUnchecked)).toBeVisible();
        await expect(page.getByRole('status')).toHaveText(visitorCopy.relayUnchecked);
        await expect(page.getByText(visitorCopy.hideIpNeedsRelay)).toHaveCount(0);
        expect(frames.socketsOpened()).toBe(0);
        // Send is the "Try again": the files stay selected and the next
        // attempt asks the server again. This time the list is read and has no
        // relay in it, which is the server's own answer.
        await send(page);
        await expect(page.locator('main section').getByText(visitorCopy.hideIpNeedsRelay)).toBeVisible();
        await expect(page.getByText(visitorCopy.relayUnchecked)).toHaveCount(0);
        expect(asked).toBe(2);
        expect(frames.socketsOpened()).toBe(0);
        expect(framesFor(frames.outgoing, 'request-join')).toHaveLength(0);
        expect(await stats()).toBe(0);
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
        await expect(page.locator('main section').getByText(visitorCopy.pathTooLong)).toBeVisible();
        await expect(page.getByRole('status')).toHaveText(visitorCopy.pathTooLong);
        await expect(page.getByRole('button', { name: SEND })).toHaveCount(0);
        expect(await stats()).toBe(0);
    });

    test('request-link: beforeunload guards Waiting for accept', async ({ page, context }) => {
        const stats = await guard(context);
        makeFiles({ 'a.bin': 1024 });
        const h = host({ decide: 'delay:60000' });
        const dialogs: string[] = [];

        // Ready: no prompt. Chromium raises beforeunload only after sticky
        // user activation, so Ready gets a selection and a real click first;
        // without them this half could never fail (review 1, F5). A prompt
        // here is accepted, so the page closes either way and the list below
        // decides.
        const ready = await context.newPage();
        ready.on('dialog', (d) => {
            dialogs.push(`ready:${d.type()}`);
            void d.accept();
        });
        await ready.goto(strayLink());
        await expect(ready.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
        await pickFiles(ready, ['a.bin']);
        await expect(ready.getByRole('button', { name: SEND })).toBeEnabled();
        await ready.getByRole('heading', { name: visitorCopy.readyEyebrow }).click();
        const readyClosed = ready.waitForEvent('close');
        await ready.close({ runBeforeUnload: true });
        await readyClosed;
        expect(dialogs).toEqual([]);

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
        expect(await stats()).toBe(0);
    });

    test('request-link: a footer link mid-drop raises the leave-page prompt', async ({ page, context }) => {
        // F5-02: the /r footer links are plain anchors, so leaving by one
        // mid-drop is a page load and raises the browser's own leave-page
        // prompt from useVisitorGuards, as closing the tab does (spec 07
        // 4.14). Dismissed, the drop runs on to delivery; accepted, the page
        // leaves and the host's drop stops there.
        test.setTimeout(240_000);
        const stats = await guard(context);
        const sent = makeFiles({ 'a.bin': 256 * 1024, 'b.bin': 256 * 1024 });
        const dialogs: string[] = [];
        let answer: 'dismiss' | 'accept' = 'dismiss';
        page.on('dialog', (d) => {
            dialogs.push(`${answer}:${d.type()}`);
            void (answer === 'accept' ? d.accept() : d.dismiss());
        });
        const sending = page.getByRole('heading', { name: sendingHeader(1, 2) });
        const privacy = page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' });

        // Dismiss. The harness holds its receive loop after file 1, so the
        // click lands in Sending (V10) on any machine.
        const stay = host({ decide: 'accept', holdAfterFile: 10_000 });
        await page.goto(await requestLink(stay));
        await pickFiles(page, ['a.bin', 'b.bin']);
        await send(page);
        await waitForHostEvent(stay, 'holding', 60_000);
        await expect(sending).toBeVisible();
        let prompt = page.waitForEvent('dialog', { timeout: 15_000 });
        await privacy.click();
        await prompt;
        expect(dialogs).toEqual(['dismiss:beforeunload']);
        expect(new URL(page.url()).pathname.startsWith('/r/')).toBe(true);
        await expectDelivered(page, stay, sent);
        // Delivered (V13) clears the counts the tab kept in Sending
        // (FT-R-DISCARD): a finished tab that Chrome discards later must reload
        // to Ready, never to "Connection lost".
        expect(await page.evaluate((key) => sessionStorage.getItem(key), LOST_KEY)).toBeNull();

        // Accept. The page leaves for /privacy, and the host's drop stops at
        // file 1: the harness has no copy of its own, so what it shows is its
        // receive ending before a second file (the error event's receive
        // stage), with no .part left and no done.
        answer = 'accept';
        const outLeave = join(scratch.root, 'out-leave');
        mkdirSync(outLeave);
        const leave = startRequestHost({ outDir: outLeave, key: true, decide: 'accept', holdAfterFile: 10_000 });
        scratch.hosts.push(leave);
        await page.goto(await requestLink(leave));
        await pickFiles(page, ['a.bin', 'b.bin']);
        await send(page);
        await waitForHostEvent(leave, 'holding', 60_000);
        await expect(sending).toBeVisible();
        prompt = page.waitForEvent('dialog', { timeout: 15_000 });
        await privacy.click();
        await prompt;
        await page.waitForURL('**/privacy');
        expect(dialogs).toEqual(['dismiss:beforeunload', 'accept:beforeunload']);
        expect(await leave.exited).toBe(1);
        const events = leave.events.map((e) => e.event);
        expect(events.filter((e) => e === 'file-committed')).toHaveLength(1);
        expect(events).not.toContain('done');
        expect(leave.events[leave.events.length - 1]).toMatchObject({ event: 'error', stage: 'receive' });
        const got = sha256Manifest(outLeave);
        expect(Object.keys(got).some((k) => k.endsWith('.part'))).toBe(false);
        expect(Object.values(got)).toEqual([sent['a.bin']]);
        expect(await stats()).toBe(0);
    });

    test('request-link: Hide my IP delivers over the local relay with relay-only candidates', async ({ page, context, trace }, testInfo) => {
        test.skip(process.env.FLOE_E2E_LOCAL_TURN !== '1', 'needs the SETUP-04 local coturn; never on CI');
        // The real /api/turn-credentials answer carries coturn credentials,
        // and a trace keeps every response body, so this cell never runs
        // while a trace records (review 1, F7). trace is a worker option,
        // which Playwright refuses to set in a describe group, so the guard
        // is here, before the first request: run it without --trace and with
        // --retries=0.
        expect(traceRecords(trace, testInfo.retry), 'run the local relay cell without --trace').toBe(false);
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
        // Every signal the page sent, over both transports, so a candidate
        // sent before the WebSocket upgrade is read too.
        expect(framesFor(frames.outgoing, 'signal').length).toBeGreaterThan(0);
        const types = outgoingCandidateTypes(frames.outgoing);
        expect(types.length).toBeGreaterThan(0);
        expect(types.every((t) => t === 'relay')).toBe(true);
        const route = await waitForHostEvent(h, 'route', 5_000);
        expect(route.path).toBe('relay');
        await expect(page.getByText(/, relay\.( |$)/)).toBeVisible();
        expect(await stats()).toBe(0);
    });
};

test.describe('request-link', everyLink);

// The same cells on a bare link. Every link floe.one sees until Floe Desktop 1.1, and every
// one Desktop 1.0.x still makes after it, and the keyed run cannot see a regression that
// only hits a page with no key (review 24 F1).
test.describe('request-link: a bare link', () => {
    test.beforeEach(() => {
        bareHosts = true;
    });
    test.afterEach(() => {
        bareHosts = false;
    });
    everyLink();
});

// ---------------------------------------------------------------------------
// The link key on /r. The cells above run on both kinds of link, keyed as Floe Desktop 1.1
// makes. These are about the check: the visitor names no file until the host has proved
// the key, and a failed check, bad or silent, sends nothing and says so.
// ---------------------------------------------------------------------------

const KEYED_REQUEST_LINK = /\/r\/[A-Za-z0-9_-]{11}#[0-9a-f-]{36}\.[A-Za-z0-9_-]{21}[AQgw]$/;
const newKey = () => randomBytes(16).toString('base64url');

/** V6f, whole: the card, the line, the announcement, and nothing to press. */
async function expectCheckFailed(page: Page, timeout = 30_000) {
    await expect(page.getByRole('heading', { name: visitorCopy.keyFailedTitle })).toBeVisible({ timeout });
    await expect(page.getByText(visitorCopy.keyFailedBody, { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(visitorCopy.keyFailedTitle);
    await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
}

/** V6g, whole: this browser could not check, so the card says that, and a person is not
 *  sent to the host for a new link that would not help (D17). */
async function expectCannotCheck(page: Page, timeout = 30_000) {
    await expect(page.getByRole('heading', { name: "This browser can't check this link" })).toBeVisible({ timeout });
    await expect(
        page.getByText('Nothing was sent. Open this link in a current version of Chrome, Edge, Firefox or Safari.', { exact: true })
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveText("This browser can't check this link");
    await expect(page.getByText(visitorCopy.keyFailedTitle)).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
}

/** Whether leaving by the footer raises the leave prompt, which is the page holding the
 *  tab. It navigates away otherwise, so this is a test's last question to its page. */
async function leaveAsks(page: Page): Promise<boolean> {
    let asked = false;
    const onDialog = (dialog: Dialog) => {
        if (dialog.type() === 'beforeunload') asked = true;
        void dialog.dismiss();
    };
    page.on('dialog', onDialog);
    try {
        await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click({ noWaitAfter: true });
        await page.waitForTimeout(1_500);
    } finally {
        page.off('dialog', onDialog);
    }
    return asked;
}

/** What a host event list says about a visit that must never have reached a decision. */
function expectNoDecision(h: RequestHost) {
    const names = h.events.map((e) => e.event);
    expect(names).not.toContain('deciding');
    expect(names).not.toContain('accepted');
    expect(names).not.toContain('file-committed');
}

/** Selects every local candidate as a relay in what getStats reports, which is all the
 *  page's probe reads: the transfer itself stays direct, on any machine. */
function relayRoute(context: BrowserContext) {
    return context.addInitScript(() => {
        const real = RTCPeerConnection.prototype.getStats;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        RTCPeerConnection.prototype.getStats = async function (this: RTCPeerConnection, ...args: any[]) {
            const stats = await real.apply(this, args as []);
            const out = new Map();
            stats.forEach((value: { type: string }, id: string) =>
                out.set(id, value.type === 'local-candidate' ? { ...value, candidateType: 'relay' } : value),
            );
            return out as unknown as RTCStatsReport;
        };
    });
}

/** Every pick reads as over the 2 GB relay cap. No file that size has to exist, because
 *  the cap stops it before a byte of it is read. */
function overTheCap(context: BrowserContext) {
    return context.addInitScript(() => {
        Object.defineProperty(File.prototype, 'size', { configurable: true, get: () => 3 * 1024 ** 3 });
    });
}

test.describe('request-link: the link key', () => {
    // These describe enforcing pages. The rollback lever's own cells are below, and a flip
    // must not have to fight this file to merge.
    test.skip(!ENFORCE_LINK_KEYS, 'ENFORCE_LINK_KEYS is off');

    test('a keyed link delivers, its proof ahead of the first file name, and nothing new shows', async ({ page, context }) => {
        const stats = await guard(context);
        await watchChannel(context);
        const sent = makeFiles({ 'a.bin': 256 * 1024 });
        const h = host({ decide: 'accept' });
        const link = await requestLink(h);
        expect(link).toMatch(KEYED_REQUEST_LINK);
        await page.goto(link);
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expectDelivered(page, h, sent);
        await expect(page.getByText(visitorCopy.shaMatched)).toBeVisible();
        const frames = await channelSent(page);
        expect(frames[0]).toBe('kc');
        expect(frames[1]).toBe('metadata');
        expect(frames.filter((f) => f === 'kc')).toHaveLength(1);
        expect(h.events.map((e) => e.event)).toContain('deciding');
        await expect(page.getByText(visitorCopy.keyFailedTitle)).toHaveCount(0);
        expect(await stats()).toBe(0);
    });

    test('a host under another key: V6f at once, no file named, and the host refuses too', async ({ page, context }) => {
        const stats = await guard(context);
        await watchChannel(context);
        makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ kc: 'bad', decide: 'accept' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expectCheckFailed(page);
        expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });
        await waitForHostEvent(h, 'done', 30_000);
        expectNoDecision(h);
        expect(Object.keys(sha256Manifest(scratch.outDir))).toEqual([]);
        await expect.poll(() => channelSent(page)).toEqual(['kc', 'incompatible']);
        const [, abort] = await channelText(page);
        expect(JSON.parse(abort)).toMatchObject({ type: 'incompatible', code: 'unverified', pv: 2, pvMin: 2 });

        // The host's own refusal and the close behind it have landed by now, and neither
        // talks over the card.
        await page.waitForTimeout(3_000);
        await expectCheckFailed(page);
        await expect(page.getByText(visitorCopy.couldNotConnect)).toHaveCount(0);
        await expect(page.getByText(visitorCopy.lostTitle)).toHaveCount(0);
        expect(await channelSent(page)).toEqual(['kc', 'incompatible']);
        expect(await leaveAsks(page), 'V6f still holds the tab').toBe(false);
        expect(await stats()).toBe(0);
    });

    test('a host that shows no proof: V6f after the wait, no file named, and the stop is the code', async ({ page, context }) => {
        test.setTimeout(KEY_CHECK_WAIT_MS + 60_000);
        const stats = await guard(context);
        await watchChannel(context);
        makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ kc: 'none', decide: 'accept' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        const clicked = Date.now();
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.connecting })).toBeVisible();
        await expectCheckFailed(page, KEY_CHECK_WAIT_MS + 30_000);
        expect(Date.now() - clicked).toBeGreaterThanOrEqual(KEY_CHECK_WAIT_MS);
        expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });
        expectNoDecision(h);
        expect(Object.keys(sha256Manifest(scratch.outDir))).toEqual([]);
        await expect.poll(() => channelSent(page)).toEqual(['kc', 'incompatible']);
        expect(await stats()).toBe(0);
    });

    test('a bare link, as Floe Desktop 1.0 makes: no key, no proof, no wait, as it always was', async ({ page, context }) => {
        const stats = await guard(context);
        await watchChannel(context);
        const sent = makeFiles({ 'a.bin': 256 * 1024 });
        const h = host({ key: false, decide: 'accept' });
        const link = await requestLink(h);
        expect(partsOfRequestLink(link).key).toBeNull();
        await page.goto(link);
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expectDelivered(page, h, sent);
        const frames = await channelSent(page);
        expect(frames).not.toContain('kc');
        expect(frames[0]).toBe('metadata');
        await expect(page.getByText(visitorCopy.keyFailedTitle)).toHaveCount(0);
        expect(await stats()).toBe(0);
    });

    test('a bare link is declined as it always was', async ({ page, context }) => {
        const stats = await guard(context);
        makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ key: false, decide: 'decline' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expect(page.getByRole('heading', { name: visitorCopy.declined })).toBeVisible({ timeout: 30_000 });
        expect(await stats()).toBe(0);
    });

    test('a link cut before its key: the incomplete card once the host refuses, and the whole link then works', async ({ page, context }) => {
        const stats = await guard(context);
        await watchChannel(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ decide: 'accept', keepWaiting: true });
        const link = await requestLink(h);
        const { room } = partsOfRequestLink(link);
        await page.goto(link.slice(0, link.lastIndexOf('.')));
        await pickFiles(page, ['a.bin']);
        await send(page);

        await expect(page.getByRole('heading', { name: visitorCopy.incompleteTitle })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(visitorCopy.incompleteBody, { exact: true })).toBeVisible();
        await expect(page.getByRole('status')).toHaveText(visitorCopy.incompleteTitle);
        await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
        expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });
        expectNoDecision(h);
        expect(Object.keys(sha256Manifest(scratch.outDir))).toEqual([]);
        // A visitor with no key has no proof to give: this is the gap DV1 names.
        expect(await channelSent(page)).not.toContain('kc');
        expect(await channelSent(page)).not.toContain('incompatible');

        // What the card says to do, done in this same tab.
        await waitForHostEvent(h, 'reopened', 30_000);
        expect(partsOfRequestLink(page.url()).room).toBe(room);
        await page.evaluate((hash) => {
            location.hash = hash;
        }, new URL(link).hash);
        await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible({ timeout: 20_000 });
        await pickFiles(page, ['a.bin']);
        await send(page);
        await expectDelivered(page, h, sent);
        expect((await channelSent(page))[0]).toBe('kc');
        expect(await stats()).toBe(0);
    });

    test.describe('a fragment that changes while the page is open', () => {
        const loadsOf = (page: Page) => {
            let loads = 0;
            page.on('load', () => {
                loads += 1;
            });
            return () => loads;
        };
        const setHash = (page: Page, hash: string) =>
            page.evaluate((next) => {
                location.hash = next;
            }, hash);

        test('another key under the same room reloads, and the page then holds the new one', async ({ page, context }) => {
            const stats = await guard(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = host({ decide: 'accept' });
            const link = await requestLink(h);
            const { room, key } = partsOfRequestLink(link);
            await page.goto(link);
            await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
            const loads = loadsOf(page);

            let other = newKey();
            while (other === key) other = newKey();
            await setHash(page, `${room}.${other}`);
            await expect.poll(loads, { timeout: 10_000 }).toBeGreaterThan(0);
            await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();

            // The host holds the link's own key, so a page on the new one fails its check.
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectCheckFailed(page);
            expectNoDecision(h);
            expect(await stats()).toBe(0);
        });

        test('the key going away reloads, and the page holds none', async ({ page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = host({ decide: 'accept' });
            const link = await requestLink(h);
            const { room } = partsOfRequestLink(link);
            await page.goto(link);
            await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
            const loads = loadsOf(page);
            await setHash(page, room);
            await expect.poll(loads, { timeout: 10_000 }).toBeGreaterThan(0);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: visitorCopy.incompleteTitle })).toBeVisible({ timeout: 30_000 });
            expect(await channelSent(page)).not.toContain('kc');
            expect(await stats()).toBe(0);
        });

        test('a key that came reloads too, and a key cut short lands on the card', async ({ page, context }) => {
            const stats = await guard(context);
            const room = randomUUID();
            await page.goto(`/r/AAAAAAAAAAA#${room}`);
            await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
            const loads = loadsOf(page);
            await setHash(page, `${room}.${newKey()}`);
            await expect.poll(loads, { timeout: 10_000 }).toBe(1);
            await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
            await setHash(page, `${room}.AAAA`);
            await expect.poll(loads, { timeout: 10_000 }).toBe(2);
            await expect(page.getByRole('heading', { name: visitorCopy.incompleteTitle })).toBeVisible();
            expect(await stats()).toBe(0);
        });

        test('the same fragment asks nothing', async ({ page, context }) => {
            await guard(context);
            const room = randomUUID();
            const key = newKey();
            await page.goto(`/r/AAAAAAAAAAA#${room}.${key}`);
            await expect(page.getByRole('heading', { name: visitorCopy.readyEyebrow })).toBeVisible();
            const loads = loadsOf(page);
            // Through another fragment that is not a change of link would be nothing either,
            // and there is none on this page, so the event is raised by hand.
            await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
            await page.waitForTimeout(1_500);
            expect(loads()).toBe(0);
        });

        test('a live drop stays in the link it joined: no reload, and the file arrives', async ({ page, context }) => {
            test.setTimeout(120_000);
            const stats = await guard(context);
            const sent = makeFiles({ 'a.bin': 256 * 1024 });
            const h = host({ decide: 'delay:6000' });
            const link = await requestLink(h);
            const { room } = partsOfRequestLink(link);
            await page.goto(link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: visitorCopy.waitingTitle })).toBeVisible();
            const loads = loadsOf(page);
            await setHash(page, `${room}.${newKey()}`);
            await expectDelivered(page, h, sent);
            expect(loads()).toBe(0);
            expect(await stats()).toBe(0);
        });
    });

    test.describe('a retry from a state that allows one keeps the key', () => {
        // Keyless on the second attempt, this page would name the file and meet the host's
        // refusal on the V1 card.
        test('Try again after host absent: V6f, not a keyless send', async ({ page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = host({ kc: 'bad', decide: 'accept', joinOnStdin: true });
            await page.goto(await requestLink(h));
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: visitorCopy.hostAbsentTitle })).toBeVisible();
            h.join();
            await waitForHostEvent(h, 'joined', 30_000);
            await page.getByRole('button', { name: visitorCopy.tryAgain }).click();
            await expectCheckFailed(page);
            await expect.poll(() => channelSent(page)).toEqual(['kc', 'incompatible']);
            expectNoDecision(h);
            expect(await stats()).toBe(0);
        });

        test('Send again after a Cancel: a new proof on the new connection, and the file arrives', async ({ page, context }) => {
            test.setTimeout(120_000);
            const stats = await guard(context);
            await watchChannel(context);
            const sent = makeFiles({ 'a.bin': 128 * 1024 });
            const h = host({ decide: 'never,accept', keepWaiting: true });
            await page.goto(await requestLink(h));
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: visitorCopy.waitingTitle })).toBeVisible();
            await page.getByRole('button', { name: visitorCopy.cancel, exact: true }).click();
            await expect(page.getByRole('button', { name: SEND })).toBeVisible();
            await waitForHostEvent(h, 'reopened', 30_000);
            await send(page);
            await expectDelivered(page, h, sent);
            const frames = await channelSent(page);
            expect(frames.slice(0, 2)).toEqual(['kc', 'metadata']);
            // Each connection's proof leads it.
            expect(frames.filter((f) => f === 'kc')).toHaveLength(2);
            const second = frames.indexOf('kc', 1);
            expect(frames[second + 1]).toBe('metadata');
            expect(frames[second - 1]).toBe('incompatible');
            expect(await stats()).toBe(0);
        });
    });

    test.describe('a browser that cannot read the certificate', () => {
        test('the SDP fallback carries a whole drop against a Go host', async ({ page, context }) => {
            const stats = await guard(context);
            await context.addInitScript(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (RTCDtlsTransport.prototype as any).getRemoteCertificates;
            });
            const sent = makeFiles({ 'a.bin': 256 * 1024 });
            const h = host({ decide: 'accept' });
            await page.goto(await requestLink(h));
            expect(await page.evaluate(() => typeof RTCDtlsTransport.prototype.getRemoteCertificates)).toBe('undefined');
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectDelivered(page, h, sent);
            await expect(page.getByText(visitorCopy.keyFailedTitle)).toHaveCount(0);
            await expect(page.getByText(visitorCopy.cantCheckTitle)).toHaveCount(0);
            expect(await stats()).toBe(0);
        });

        // The API is gone and the description fails the fallback's strict shape, since a
        // second m= line is the trick that shape is there to refuse.
        test('with no way to check, it stops with no proof and no file named', async ({ page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            await context.addInitScript(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (RTCDtlsTransport.prototype as any).getRemoteCertificates;
                const real = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'remoteDescription')?.get;
                Object.defineProperty(RTCPeerConnection.prototype, 'remoteDescription', {
                    configurable: true,
                    get(this: RTCPeerConnection) {
                        const held = real?.call(this);
                        return held ? { type: held.type, sdp: `${held.sdp}m=text 9 UDP/TLS 0\r\n` } : held;
                    },
                });
            });
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = host({ decide: 'accept' });
            await page.goto(await requestLink(h));
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectCannotCheck(page);
            expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });
            expectNoDecision(h);
            // A side that cannot prove anything sends no kc at all (DV1, D7).
            await expect.poll(() => channelSent(page)).toEqual(['incompatible']);
            expect(await stats()).toBe(0);
        });
    });

    test.describe('the relay cap on a keyed link', () => {
        test('over the cap on a relay: the reason goes behind the proof, to a host that proved the key', async ({ page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            await relayRoute(context);
            await overTheCap(context);
            makeFiles({ 'a.bin': 1024 });
            const h = host({ decide: 'accept' });
            await page.goto(await requestLink(h));
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: visitorCopy.relayLimitTitle })).toBeVisible({ timeout: 30_000 });
            await expect.poll(() => channelSent(page)).toEqual(['kc', 'incompatible']);
            expect((await channelText(page))[1]).toContain(RELAY_BLOCK_REASON);
            expectNoDecision(h);
            expect(await stats()).toBe(0);
        });

        // The reason says the drop is over 2 GB, so it is not for a host that proved nothing.
        // The probe's 2 s is long gone when the wait ends, and the card is V6f, not V9.
        test('over the cap with a silent host: V6f after the wait, and nothing of the size went', async ({ page, context }) => {
            test.setTimeout(KEY_CHECK_WAIT_MS + 60_000);
            const stats = await guard(context);
            await watchChannel(context);
            await relayRoute(context);
            await overTheCap(context);
            makeFiles({ 'a.bin': 1024 });
            const h = host({ kc: 'none', decide: 'accept' });
            await page.goto(await requestLink(h));
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectCheckFailed(page, KEY_CHECK_WAIT_MS + 30_000);
            await expect(page.getByRole('heading', { name: visitorCopy.relayLimitTitle })).toHaveCount(0);
            expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });
            await expect.poll(() => channelSent(page)).toEqual(['kc', 'incompatible']);
            const words = (await channelText(page)).join('\n');
            expect(words).not.toContain('2 GB');
            expect(await stats()).toBe(0);
        });

        test('over the cap on a bare link: V9, as it always was', async ({ page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            await relayRoute(context);
            await overTheCap(context);
            makeFiles({ 'a.bin': 1024 });
            const h = host({ key: false, decide: 'accept' });
            await page.goto(await requestLink(h));
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: visitorCopy.relayLimitTitle })).toBeVisible({ timeout: 30_000 });
            await expect.poll(() => channelSent(page)).toEqual(['incompatible']);
            expect(await stats()).toBe(0);
        });
    });

    // The moves no honest engine makes, played by a page of the test's own.
    test.describe('against a scripted host', () => {
        // Far under the 75 s setup timer a page with no answer would sit behind.
        const FAST = 30_000;
        const MIB = 1024 * 1024;
        let hosts: ScriptedHost[] = [];
        test.afterEach(async () => {
            await Promise.all(hosts.map((h) => h.close()));
            hosts = [];
        });
        const scripted = async (browser: Browser, o: ScriptedHostOptions) => {
            const h = await startScriptedHost(browser, o);
            hosts.push(h);
            return h;
        };
        const typesFrom = async (h: ScriptedHost) => (await h.state()).frames.map((f) => f.type);

        test('agrees with a third implementation of the tag, both ways', async ({ browser, page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'good', then: 'ack' });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: DELIVERED })).toBeVisible({ timeout: 30_000 });
            await expect.poll(async () => (await h.state()).pageProofGood).toBe(true);
            const types = await typesFrom(h);
            expect(types.slice(0, 2)).toEqual(['kc', 'metadata']);
            expect(types.filter((t) => t === 'kc')).toHaveLength(1);
            expect(await stats()).toBe(0);
        });

        // The other order: the relay verdict is in, and the check is not. Nothing is named
        // until it is. A page that started on the verdict alone fails here on any machine.
        test('holds the file name for a proof that comes after the relay verdict', async ({ browser, page, context }) => {
            const stats = await guard(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'good', then: 'ack', holdProof: true });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            // Its own proof goes at connect, with no frame from the host to prompt it.
            await expect.poll(() => typesFrom(h), { timeout: 30_000 }).toEqual(['kc']);
            await page.waitForTimeout(RELAY_PROBE_DELAY_MS + 2_000);
            expect(await typesFrom(h)).toEqual(['kc']);
            await expect(page.getByRole('heading', { name: visitorCopy.connecting })).toBeVisible();
            await h.releaseProof();
            await expect(page.getByRole('heading', { name: DELIVERED })).toBeVisible({ timeout: 30_000 });
            expect((await typesFrom(h)).slice(0, 2)).toEqual(['kc', 'metadata']);
            expect(await stats()).toBe(0);
        });

        // The other half of that order. The relay verdict is in and the check then fails, so
        // nothing has been named: V6f, and not a send the engine has to stop on its own.
        test('a bad proof that comes after the relay verdict is V6f all the same', async ({ browser, page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'bad', then: 'hold', holdProof: true });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect.poll(() => typesFrom(h), { timeout: 30_000 }).toEqual(['kc']);
            await page.waitForTimeout(RELAY_PROBE_DELAY_MS + 2_000);
            await h.releaseProof();
            await expectCheckFailed(page);
            await expect.poll(() => channelSent(page)).toEqual(['kc', 'incompatible']);
            expect(await stats()).toBe(0);
        });

        // A frame the session kept until the send's first subscribe, which replays it inside
        // the subscribe, before that call returns: nothing it reaches may be declared later.
        test('a stop that came ahead of the send is read as the send starts', async ({ browser, page, context }) => {
            const stats = await guard(context);
            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(e.name));
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'good', then: 'refuse', code: 'stopped' });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            const copy = refusalCopy('stopped', 0, 1);
            await expect(page.getByRole('heading', { name: copy.title })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('FLOEPEERTEXT', { exact: false })).toHaveCount(0);
            expect(errors, 'an uncaught error on the page').toEqual([]);
            expect(await stats()).toBe(0);
        });

        test('over the cap with a proof held back: the reason waits for it, and then goes', async ({ browser, page, context }) => {
            const stats = await guard(context);
            await watchChannel(context);
            await relayRoute(context);
            await overTheCap(context);
            makeFiles({ 'a.bin': 1024 });
            const h = await scripted(browser, { proof: 'good', then: 'hold', holdProof: true });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect.poll(() => typesFrom(h), { timeout: 30_000 }).toEqual(['kc']);
            await page.waitForTimeout(RELAY_PROBE_DELAY_MS + 2_000);
            expect(await typesFrom(h)).toEqual(['kc']);
            await h.releaseProof();
            await expect(page.getByRole('heading', { name: visitorCopy.relayLimitTitle })).toBeVisible({ timeout: FAST });
            await expect.poll(() => typesFrom(h)).toEqual(['kc', 'incompatible']);
            expect(await stats()).toBe(0);
        });

        for (const [name, proof] of [['a bad proof', 'bad'], ['a malformed proof', 'malformed']] as const) {
            test(`${name}: V6f, one abort with the code, nothing behind it, and the connection closes`, async ({ browser, page, context }) => {
                const stats = await guard(context);
                await watchChannel(context);
                makeFiles({ 'a.bin': 64 * 1024 });
                const h = await scripted(browser, { proof, then: 'hold' });
                await page.goto(h.link);
                await pickFiles(page, ['a.bin']);
                await send(page);
                await expectCheckFailed(page);
                await expect.poll(async () => (await h.state()).closed, { timeout: FAST }).toBe(true);
                const { frames } = await h.state();
                expect(frames.map((f) => f.type)).toEqual(['kc', 'incompatible']);
                expect(frames[1]).toMatchObject({ code: 'unverified', pv: 2, pvMin: 2 });
                // Its words are the sender's own, and name no file.
                expect(frames[1].reason).toBe(SENDER_UNVERIFIED_REASON);
                expect(await channelSent(page)).toEqual(['kc', 'incompatible']);
                expect(await stats()).toBe(0);
            });
        }

        test('a bad proof and a close right behind it: V6f stands', async ({ browser, page, context }) => {
            const stats = await guard(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'bad', then: 'close' });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectCheckFailed(page);
            await page.waitForTimeout(3_000);
            await expectCheckFailed(page);
            await expect(page.getByText(visitorCopy.couldNotConnect)).toHaveCount(0);
            expect(await stats()).toBe(0);
        });

        test('silence: V6f after the wait, one abort with the code', async ({ browser, page, context }) => {
            test.setTimeout(KEY_CHECK_WAIT_MS + 60_000);
            const stats = await guard(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'none', then: 'hold' });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectCheckFailed(page, KEY_CHECK_WAIT_MS + 30_000);
            await expect.poll(async () => (await h.state()).closed, { timeout: FAST }).toBe(true);
            expect(await typesFrom(h)).toEqual(['kc', 'incompatible']);
            expect(await stats()).toBe(0);
        });

        // A host judges a proof as it lands, and the close behind its refusal can beat this
        // page's first metadata, and even simple-peer's connect. Then no send is there to read
        // the frame, and the page would sit on Connecting until its setup timer said it could
        // not connect. So fast, and in the words of the row that names it.
        test('a good proof, then a refusal and a close: the refusal card, at once, with no file named', async ({ browser, page, context }) => {
            const stats = await guard(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'good', then: 'refuse-close' });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            const copy = refusalCopy('unverified', 0, 1);
            await expect(page.getByRole('heading', { name: copy.title })).toBeVisible({ timeout: FAST });
            for (const line of copy.lines) await expect(page.getByText(line, { exact: true })).toBeVisible();
            await expect(page.getByText(visitorCopy.nothingSent, { exact: true })).toBeVisible();
            await expect(page.getByText(visitorCopy.askForNewLink, { exact: true })).toBeVisible();
            await expect(page.getByText('FLOEPEERTEXT', { exact: false })).toHaveCount(0);
            await page.waitForTimeout(3_000);
            await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
            expect(await typesFrom(h)).toEqual(['kc']);
            expect(await stats()).toBe(0);
        });

        test('a refusal with no proof at all: the same card, not a wait', async ({ browser, page, context }) => {
            const stats = await guard(context);
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'none', then: 'refuse' });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            const copy = refusalCopy('unverified', 0, 1);
            await expect(page.getByRole('heading', { name: copy.title })).toBeVisible({ timeout: FAST });
            await expect(page.getByText('FLOEPEERTEXT', { exact: false })).toHaveCount(0);
            expect((await typesFrom(h)).filter((t) => t === 'metadata')).toEqual([]);
            expect(await stats()).toBe(0);
        });

        // A hostile host that holds the key acks, reads some of the file, and only then says
        // the check failed, saved 0. The first byte goes right behind the ack, so "Nothing was
        // sent" is false from there, and it is what such a host would want said.
        test('a refusal after some of the file never says nothing was sent', async ({ browser, page, context }) => {
            test.setTimeout(120_000);
            const stats = await guard(context);
            makeFiles({ 'big.bin': 32 * MIB });
            const h = await scripted(browser, { proof: 'good', then: 'read-then-refuse', after: MIB });
            await page.goto(h.link);
            await pickFiles(page, ['big.bin']);
            await send(page);
            const copy = refusalCopy('unverified', 0, 1, true);
            await expect(page.getByRole('heading', { name: copy.title })).toBeVisible({ timeout: 60_000 });
            await expect(page.getByText(visitorCopy.askForNewLink, { exact: true })).toBeVisible();
            await expect(page.getByText(/nothing was sent/i)).toHaveCount(0);
            await expect(page.getByText('FLOEPEERTEXT', { exact: false })).toHaveCount(0);
            expect((await h.state()).fileBytes).toBeGreaterThanOrEqual(MIB);
            expect(await stats()).toBe(0);
        });

        // D17: an honest host reaches this too. A disk that fills during file 1 stops the drop
        // with a count of 0, and by then the bytes it read have gone.
        test('a host out of space during file 1: its title, and nothing saying nothing was sent', async ({ browser, page, context }) => {
            test.setTimeout(120_000);
            const stats = await guard(context);
            makeFiles({ 'big.bin': 32 * MIB });
            const h = await scripted(browser, { proof: 'good', then: 'read-then-refuse', after: MIB, code: 'disk-full' });
            await page.goto(h.link);
            await pickFiles(page, ['big.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: 'Their computer ran out of space' })).toBeVisible({ timeout: 60_000 });
            await expect(page.getByText(/nothing was sent/i)).toHaveCount(0);
            await expect(page.getByText('FLOEPEERTEXT', { exact: false })).toHaveCount(0);
            expect((await h.state()).fileBytes).toBeGreaterThanOrEqual(MIB);
            expect(await stats()).toBe(0);
        });

        test('a host that declines past its first answer: the unknown row, not the sentence', async ({ browser, page, context }) => {
            test.setTimeout(120_000);
            const stats = await guard(context);
            makeFiles({ 'big.bin': 32 * MIB });
            const h = await scripted(browser, { proof: 'good', then: 'read-then-refuse', after: MIB, code: 'declined' });
            await page.goto(h.link);
            await pickFiles(page, ['big.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: 'The drop stopped on their computer.' })).toBeVisible({ timeout: 60_000 });
            await expect(page.getByText(/nothing was sent/i)).toHaveCount(0);
            expect(await stats()).toBe(0);
        });

        // The gate between the server and simple-peer. A signal with no field it knows
        // destroys the peer, an answer to nothing fails it, and a second description is what
        // the certificate fallback relies on never seeing.
        test('drops what the server has no business sending it, and the drop goes on', async ({ browser, page, context }) => {
            const stats = await guard(context);
            await context.addInitScript(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                w.__remoteDescriptions = 0;
                const real = RTCPeerConnection.prototype.setRemoteDescription;
                RTCPeerConnection.prototype.setRemoteDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
                    w.__remoteDescriptions += 1;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (real as any).apply(this, args);
                } as typeof RTCPeerConnection.prototype.setRemoteDescription;
            });
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = await scripted(browser, { proof: 'good', then: 'ack', noise: true });
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: DELIVERED })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText(visitorCopy.couldNotConnect)).toHaveCount(0);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(await page.evaluate(() => (window as any).__remoteDescriptions)).toBe(1);
            expect(await stats()).toBe(0);
        });
    });
});

// ENFORCE_LINK_KEYS is a one-line deploy for a production problem: the page still proves
// and checks and reports, and stops nothing. These wake up with the flip, and were run
// against it for the record of this PR.
test.describe('request-link: with ENFORCE_LINK_KEYS off', () => {
    test.skip(ENFORCE_LINK_KEYS, 'ENFORCE_LINK_KEYS is on');

    test('a host with no proof gets the file, with no wait, and the page still sent its own', async ({ page, context }) => {
        const stats = await guard(context);
        await watchChannel(context);
        const sent = makeFiles({ 'a.bin': 64 * 1024 });
        const h = host({ kc: 'none', decide: 'accept' });
        await page.goto(await requestLink(h));
        await pickFiles(page, ['a.bin']);
        const clicked = Date.now();
        await send(page);
        await expectDelivered(page, h, sent);
        expect(Date.now() - clicked).toBeLessThan(KEY_CHECK_WAIT_MS);
        expect((await channelSent(page))[0]).toBe('kc');
        await expect(page.getByText(visitorCopy.keyFailedTitle)).toHaveCount(0);
        expect(await stats()).toBe(0);
    });

    test('a bad proof stops nothing on this page: the file name goes, and it is the host that refuses', async ({ browser, page, context }) => {
        const stats = await guard(context);
        await watchChannel(context);
        makeFiles({ 'a.bin': 64 * 1024 });
        const h = await startScriptedHost(browser, { proof: 'bad', then: 'hold' });
        try {
            await page.goto(h.link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expect(page.getByRole('heading', { name: visitorCopy.waitingTitle })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText(visitorCopy.keyFailedTitle)).toHaveCount(0);
            expect((await channelSent(page)).slice(0, 2)).toEqual(['kc', 'metadata']);
        } finally {
            await h.close();
        }
        expect(await stats()).toBe(0);
    });
});

test.describe('request-link: a discarded tab and the link key', () => {
    // The tab's record names a link by its room, and a key that changed under that room is
    // another link: Chrome would reload a discarded tab at the address it shows.
    test('a key that changes mid-drop takes the record, and coming back returns it', async ({ page, context }) => {
        test.setTimeout(120_000);
        const stats = await guard(context);
        makeFiles({ 'a.bin': 256 * 1024, 'b.bin': 256 * 1024 });
        const h = host({ decide: 'accept', holdAfterFile: 20_000 });
        const link = await requestLink(h);
        const { room, key } = partsOfRequestLink(link);
        await page.goto(link);
        await pickFiles(page, ['a.bin', 'b.bin']);
        await send(page);
        await waitForHostEvent(h, 'holding', 60_000);
        await expect(page.getByRole('heading', { name: sendingHeader(1, 2) })).toBeVisible();
        const hashThenRead = (next: string) =>
            page.evaluate(
                ([k, hash]) =>
                    new Promise<string | null>((resolve) => {
                        window.addEventListener('hashchange', () => resolve(sessionStorage.getItem(k)), { once: true });
                        location.hash = hash;
                    }),
                [LOST_KEY, next] as const
            );
        expect(await hashThenRead(`${room}.${newKey()}`)).toBeNull();
        await expect(page.getByRole('heading', { name: sendingHeader(1, 2) })).toBeVisible();
        expect(await hashThenRead(`${room}.${key}`)).toBe('{"v":1,"arrived":0,"total":2}');
        // The key stays out of the record.
        for (const [k, value] of await storedPairs(page)) {
            expect(k.includes(key as string) || value.includes(key as string), 'a stored key or value holds the link key').toBe(false);
        }
        expect(await stats()).toBe(0);
    });
});

// Local only, FLOE_E2E_FIREFOX=1, as in link-key.spec.ts: CI installs Chromium alone. The
// visitor's first proof that Go and Gecko agree on the DER, in the direction Desktop 1.1's
// links run: the Go host's proof checked by Gecko, and Gecko's proof checked by Go.
test.describe('request-link: across engines', () => {
    test.skip(!process.env.FLOE_E2E_FIREFOX, 'set FLOE_E2E_FIREFOX=1 to run the Firefox cells (no CI leg does)');

    let gecko: Browser;

    test.beforeAll(async () => {
        // The config's project settings do not reach this. Real host addresses, as the
        // certificate capture ran: Go cannot resolve Gecko's mDNS names on every machine.
        gecko = await firefox.launch({
            firefoxUserPrefs: {
                'media.peerconnection.ice.obfuscate_host_addresses': false,
                'media.peerconnection.ice.proxy_only_if_behind_proxy': false,
            },
        });
    });

    test.afterAll(async () => {
        await gecko?.close();
    });

    const openOnGecko = async () => {
        const ctx = await gecko.newContext({ baseURL: WEB_URL });
        const stats = await guard(ctx);
        return { ctx, stats, page: await ctx.newPage() };
    };

    test('a keyed link from a Go host delivers to Firefox and back', async () => {
        const { ctx, stats, page } = await openOnGecko();
        try {
            const sent = makeFiles({ 'a.bin': 3 * 1024 * 1024 });
            const h = host({ decide: 'accept' });
            const link = await requestLink(h);
            expect(link).toMatch(KEYED_REQUEST_LINK);
            await page.goto(link);
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectDelivered(page, h, sent);
            await expect(page.getByText(visitorCopy.keyFailedTitle)).toHaveCount(0);
            expect(await stats()).toBe(0);
        } finally {
            await ctx.close();
        }
    });

    test('a host under another key ends on Firefox too, with no file named', async () => {
        const { ctx, stats, page } = await openOnGecko();
        try {
            makeFiles({ 'a.bin': 64 * 1024 });
            const h = host({ kc: 'bad', decide: 'accept' });
            await page.goto(await requestLink(h));
            await pickFiles(page, ['a.bin']);
            await send(page);
            await expectCheckFailed(page);
            expect(await waitForHostEvent(h, 'refused', 30_000)).toMatchObject({ code: 'unverified' });
            expectNoDecision(h);
            expect(await stats()).toBe(0);
        } finally {
            await ctx.close();
        }
    });
});
