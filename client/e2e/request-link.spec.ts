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
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { visitorCopy, refusalCopy, sendingHeader, statusCopy } from '../lib/request/visitorCopy';
import { initialModel, reduce } from '../lib/request/visitorState';
import { LOST_KEY } from '../lib/request/lostRecord';
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
    traceRecords,
    waitForHostEvent,
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

/** C-111 as the page words it after a discard's reload with these counts,
 *  from the reducer and the copy module the page itself uses. */
function restoredLostLine(arrived: number, total: number): string {
    const ready = reduce(initialModel, { type: 'LINK_OK', roomId: randomUUID() }).model;
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

test.describe('request-link', () => {
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
        const url = new URL(link);
        const linkId = url.pathname.split('/').pop() ?? '';
        const room = url.hash.slice(1);
        expect(linkId.length > 0 && room.length > 0).toBe(true);
        await page.goto(link);
        await pickFiles(page, ['a.bin', 'b.bin']);
        await send(page);
        await waitForHostEvent(h, 'holding', 60_000);
        await expect(page.getByRole('heading', { name: sendingHeader(1, 2) })).toBeVisible();
        const stored = await storedPairs(page);
        // Checked before any value can be printed: a failure message must never
        // carry the link id or the room (describeHarness's rule).
        for (const [key, value] of stored) {
            expect(key.includes(linkId) || value.includes(linkId), 'a stored key or value holds the link id').toBe(false);
            expect(key.includes(room) || value.includes(room), 'a stored key or value holds the room').toBe(false);
            const named = ['a.bin', 'b.bin'].some((n) => key.includes(n) || value.includes(n));
            expect(named, 'a stored key or value holds a picked file name').toBe(false);
        }
        expect(stored.filter(([key]) => key.startsWith('floe:'))).toEqual([[LOST_KEY, '{"v":1,"arrived":0,"total":2}']]);

        // A fragment naming another room mid-drop: the drop stays in the room
        // it joined (E29), but Chrome would reload a discarded tab at the
        // address it shows, so the record goes; back at the drop's room, the
        // counts return (review 1 F1).
        const readRecord = () => page.evaluate((key) => sessionStorage.getItem(key), LOST_KEY);
        await page.evaluate((r) => {
            location.hash = r;
        }, randomUUID());
        await expect.poll(readRecord, { timeout: 10_000 }).toBeNull();
        await expect(page.getByRole('heading', { name: sendingHeader(1, 2) })).toBeVisible();
        await page.evaluate((r) => {
            location.hash = r;
        }, room);
        await expect.poll(readRecord, { timeout: 10_000 }).toBe('{"v":1,"arrived":0,"total":2}');

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
        await expect(page.getByText(visitorCopy.hideIpNeedsRelay)).toBeVisible();
        // A socket started beside the ICE fetch would show within this window
        // (the privacy spec's settle).
        await page.waitForTimeout(1_000);
        expect(signaling).toEqual([]);
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
        await expect(page.getByText(visitorCopy.pathTooLong)).toBeVisible();
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
        const leave = startRequestHost({ outDir: outLeave, decide: 'accept', holdAfterFile: 10_000 });
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
});
