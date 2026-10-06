// The request link runner (S1-REL-03a, WP-R2): what a request cell runs in
// place of the plain sender and receiver legs of lib/cell.mjs. The host is
// the desktop on the wailsdev lane (DesktopLeg plus the PlaywrightDriver
// request verbs in lib/desktop.mjs); the visitor is a fresh Chromium context
// on /r (lib/visitor.mjs). Every attempt makes its own link into its own
// folder, so a retry never reuses either.
//
// runRequestAttempt runs TA-10, TA-11 and TA-12 (flow accept), TA-13
// (blip-then-accept) and TA-15 (decline-then-accept) and returns the same
// attempt record runAttempt does, so runCell's verdicts, retry and report
// rows apply unchanged. TA-16 (flow accept, request.visitor 'cli') runs the
// same attempt with the CLI as the visitor: `floe send <files> --to <link>`
// through the CLI adapter's own leg (lib/cli.mjs, opts.requestLink), whose
// exit and printed lines stand in for the web visitor's status card.
// runOpenLinkAttempt runs TA-17: the quick cell's own attempt, with the host
// holding a link open beside it (runAttempt hooks).
//
// The link is a secret for its life: the full value goes to the visitor's
// page.goto and nowhere else. The record carries the redacted form, every
// message and note passes through redactRequestLinks before it is kept, and
// the host's captures, which can show the link on screen, go under the
// attempt's private/ folder (never quoted by audit.md or run.json).
import {
    mkdirSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
    attemptTimeout,
    describeError,
    runAttempt,
    statsProofCheck,
} from './cell.mjs';
import { REQUEST_STRINGS, desktopFmtBytes, safeCode, samePath } from './desktop.mjs';
import { compareOutputs, ensureFixture, walkOutputs } from './fixtures.mjs';
import { REQUEST_CADDY_RECONNECT_MS, isLoopbackUrl } from './matrix.mjs';
import { redactRequestLinks } from './report.mjs';
import { classifyPair } from './route.mjs';
import { PhaseError, SafetyError, sleep as defaultSleep } from './surfaces.mjs';
import { SIGNATURES, classifySignature } from './triage.mjs';
import { VISITOR_TEXT, arrivedTitle, openVisitor } from './visitor.mjs';

export const FLOW_KEY = 'request-flow';
export const MANIFEST_KEY = 'request-manifest';
/** How often the host's lane state is read while the runner waits on it. */
export const HOST_POLL_MS = 250;
/** How long the host has to reclaim its link after a blip ends. */
export const RECLAIM_MS = 60_000;
/**
 * An exe host (the Store build, a portable or a head wails build) is driven
 * through the UIA request verbs (FU-26), whose pattern calls activate its
 * window (G2-F1), so it runs only with --user-away; the wailsdev lane drives
 * a headless page and activates nothing.
 */
export const AWAY_ONLY = 'request-host-away-only';

// The lane states in which a link exists and can be closed (Close link),
// and the results that stay until Dismiss (requestLink.ts LINK_PHASES and
// HOLDS).
const LINK_OPEN = new Set([
    'waiting',
    'reconnecting',
    'connecting',
    'deciding',
    'declined',
]);
const RESULTS = new Set(['done', 'stopped']);
// A link or a drop that is live: Go refuses a second Make link
// (already-open, one link in the Beta) and the view shows no Save to field.
const LIVE = new Set([...LINK_OPEN, 'receiving', 'making']);

const scrub = (s) => redactRequestLinks(s);

/** `child` is `root` or a folder under it (Windows compares without case). */
export function insideDir(child, root) {
    if (typeof child !== 'string' || typeof root !== 'string' || !child || !root)
        return false;
    const rel = path.relative(path.resolve(root), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A copy of any value with every request link's room removed. */
export function scrubDeep(value) {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(scrubDeep);
    if (value && typeof value === 'object') {
        const p = Object.getPrototypeOf(value);
        if (p !== Object.prototype && p !== null) return value;
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
        return out;
    }
    return value;
}

function flow(phase, message, extra = {}) {
    return new PhaseError(phase, `${FLOW_KEY}: ${message}`, {
        signatureKey: FLOW_KEY,
        ...extra,
    });
}

/**
 * TA-13's host is not behind the blip proxy: no URL to point it at, a
 * server address that did not read back, or no socket through the proxy
 * before the cut. A harness ERROR, never a request-flow FAIL: the first
 * live run (2026-09-24) cut a proxy the host was never behind and read the
 * host's correct Waiting as a product defect.
 */
export const BLIP_KEY = 'blip-url';
function blipUnproven(phase, message) {
    return proxyUnproven(BLIP_KEY, phase, message);
}

/**
 * TA-14's twin of blip-url (FU-26): the host is not behind the Caddy proxy
 * (its server address did not read back, or it never read Reconnecting after
 * a reload), so a reload proved nothing. A harness ERROR, never a FAIL.
 */
export const CADDY_KEY = 'caddy-url';
/** TA-14's second reload never landed while the drop received. */
export const CADDY_MISSED_KEY = 'caddy-reload-missed';
function proxyUnproven(key, phase, message) {
    return new PhaseError(phase, `${key}: ${message}`, {
        harness: true,
        reason: key,
        signatureKey: key,
    });
}

/**
 * The host lane already holds a live link or drop when a cell starts, one
 * this run did not leave behind: a harness ERROR by name before any click.
 * It used to cost a 30 s Save to fill timeout on the waiting view, keyed
 * `unknown` (the first live run's C2D-reqopen, 2026-09-24).
 */
export const HOST_BUSY_KEY = 'host-busy';
function hostBusy(message) {
    return new PhaseError('host.start', `${HOST_BUSY_KEY}: ${message}`, {
        harness: true,
        reason: HOST_BUSY_KEY,
        signatureKey: HOST_BUSY_KEY,
    });
}

/**
 * Before Make link: a live link or drop on the host lane is either this
 * run's own leftover, which is closed (a drop canceled) and noted, or it is
 * refused as host-busy and left exactly as it is. Own means the lane saves
 * into a folder under this run's evidence root, which only this run's cells
 * create, so an owner's link is never touched. A result (done, stopped) or
 * an ended link is not live: Make link's own Make another link puts it away.
 */
async function clearLeftover(host, ctx, rec, st) {
    const s = await snapshotOf(host);
    if (!LIVE.has(s.state)) return;
    const gen = Number(s.gen) || 0;
    if (s.state === 'making' || !insideDir(s.saveDir, ctx.evidenceRoot))
        throw hostBusy(
            `the host lane already holds ${s.state} (gen ${gen}) from before this cell, and it is not this run's; nothing was made or closed`
        );
    const { now, nap } = st.clock;
    if (s.state === 'receiving') await host.driver.cancelRequestDrop({ now, nap });
    else await host.driver.closeRequestLink({ now, nap });
    const after = await snapshotOf(host);
    if (LIVE.has(after.state))
        throw hostBusy(
            `this run's leftover ${s.state} link (gen ${gen}) still reads ${after.state} after it was closed`
        );
    rec.request.swept = { state: s.state, gen };
    rec.notes.push(
        `host start: swept this run's leftover ${s.state} link (gen ${gen}) before Make link`
    );
}

function clockOf(ctx) {
    const c = ctx.clock || {};
    return {
        now: c.now || Date.now,
        nap: c.nap || ctx.sleep || defaultSleep,
    };
}

function safeEvidence(x) {
    try {
        return x ? x.evidence() : null;
    } catch (e) {
        return { error: e.message, notes: [] };
    }
}

// ------------------------------------------------------------- the host

async function snapshotOf(host) {
    const s = await host.driver.requestSnapshot();
    return s && typeof s === 'object' ? s : { state: 'unknown' };
}

/**
 * Poll the host's lane until `want` holds (a list of states, or a
 * predicate); a state in `fail` ends the wait at once, the clock running
 * out ends it with the last state seen.
 */
export async function awaitHostState(
    host,
    want,
    timeoutMs,
    { now, nap, fail = [], phase = 'request', what = null, live = null } = {}
) {
    const ok =
        typeof want === 'function' ? want : (s) => want.includes(s.state);
    const label = what || (Array.isArray(want) ? want.join(' or ') : 'the state asked for');
    const start = now();
    let last = null;
    for (;;) {
        if (live && !live.on) throw flow(phase, 'the attempt ended');
        last = await snapshotOf(host);
        if (ok(last)) return last;
        if (fail.includes(last.state))
            throw flow(
                phase,
                `the host went ${last.state}${last.code ? ` (${safeCode(last.code)})` : ''} while waiting for ${label}`
            );
        if (now() - start >= timeoutMs)
            throw flow(
                phase,
                `the host read ${last.state} ${timeoutMs} ms on, not ${label}`
            );
        await nap(HOST_POLL_MS);
    }
}

/**
 * Since H7 (D-160) there is no Settings > Beta switch: the REQUEST LINK
 * choice on Receive is always there, and the server's request-1 answer is the
 * only gate (a server without it ends Make link in E1, which the cell names).
 * The runner waits for the tab instead of toggling anything. A build that
 * never shows it, an older one with the switch off, is a finding at
 * host.start rather than a 30 s wait on a missing button.
 */
export const TAB_WAIT_MS = 10_000;
export async function awaitRequestTab(host, { now = Date.now, nap = defaultSleep } = {}) {
    const r = await host.driver.awaitRequestTab({ timeoutMs: TAB_WAIT_MS, now, nap });
    if (!r.shown)
        throw flow(
            'host.start',
            `the REQUEST LINK tab did not show within ${TAB_WAIT_MS} ms (Receive > Request link, beta); a build under test since H7 shows it without a Settings switch`
        );
    return { via: r.via, waitedMs: r.waitedMs };
}

/**
 * Launch the host, force its relay when the cell asks (TA-12), wait for the
 * REQUEST LINK tab, point it at the blip proxy (TA-13), make a link into
 * `outDir` and read it. Returns the full link; the record keeps its shown
 * form only.
 */
async function startHost(
    cell,
    ctx,
    rec,
    st,
    { outDir, relayOnly, blipUrl = null, proxyKey = BLIP_KEY }
) {
    const { now, nap } = st.clock;
    const mod = await ctx.getAdapter('desktop');
    const host = mod.createLeg({
        cellId: cell.id,
        attempt: rec.n,
        role: 'receiver',
        infra: ctx.infra,
        build: ctx.buildFor ? ctx.buildFor('desktop', 'receiver') : null,
        relayOnly: Boolean(relayOnly),
        noRelay: false,
        forcer: relayOnly ? 'hideIP' : 'none',
        input: 'request-link',
        outDir,
        statsOff: true,
        // Captures of the host can show the link on screen: private/.
        evidenceDir: path.join(rec.evidenceDir, 'private', 'host'),
        deadlineAt: rec.deadlineAt,
        ledger: ctx.ledger,
        label: 'host',
        monitor: ctx.monitor ?? 'secondary',
        userAway: Boolean(ctx.userAway),
        shared: ctx.shared || {},
        clientDir: ctx.shared?.clientDir ?? null,
        log: ctx.log,
    });
    const exe = host.mode !== 'wailsdev';
    if (exe) {
        // The matrix gate SKIPs this without --user-away; this is the
        // runner's own stop, before anything launches.
        if (!ctx.userAway)
            throw new PhaseError(
                'host.start',
                `the request link host is a ${host.mode} exe, driven through UIA pattern calls that activate its window (G2-F1); it runs only with --user-away`,
                { verdict: 'SKIP', reason: AWAY_ONLY }
            );
        // An exe has no bound SetSettings: a proxy's address is the server
        // in the desktop.json it launches with.
        if (blipUrl) host.opts.serverOverride = blipUrl;
    }
    st.host = host;
    // Whatever happens next, the leg's stop (the cell's teardown or the
    // audit's interrupt shutdown) closes the link and puts the address back.
    host.beforeClose = () => releaseHost(st, rec);
    await host.launch([]);
    // Every UIA pattern call from here on re-reads the input idle time first.
    if (exe && host.driver) host.driver.awayOnly = true;
    await clearLeftover(host, ctx, rec, st);
    await host.applyRelayForcer();
    rec.request.tab = await awaitRequestTab(host, st.clock);
    if (blipUrl && exe) {
        rec.request.addresses = { swapped: true, restored: null, via: 'desktop.json at launch' };
    } else if (blipUrl) {
        const before = await host.driver.settings();
        st.addresses = { server: before?.server ?? '', web: before?.web ?? '' };
        const web = ctx.infra?.web ?? '';
        const after = await host.driver.setAddresses(blipUrl, web);
        rec.request.addresses = { swapped: true, restored: null };
        if (!after || after.server !== blipUrl || after.web !== web)
            throw proxyUnproven(
                proxyKey,
                'host.start',
                `the host did not take the ${proxyKey === CADDY_KEY ? 'Caddy' : 'blip'} proxy as its server address (SetSettings read back something else)`
            );
    }
    // Only a link generation this cell made is ever closed or put away: the
    // lane numbers every Make link (gen), and a link the owner already had
    // open stays exactly as it was.
    st.genBefore = Number((await snapshotOf(host)).gen) || 0;
    st.makeTried = true;
    const made = await host.driver.makeRequestLink({
        lifetime: '24h',
        saveDir: outDir,
        now,
        nap,
    });
    const read = await host.driver.readRequestLink();
    st.link = read.link;
    rec.request.link = read.shown;
    rec.request.made = { lifetime: made.lifetime, onScreen: read.onScreen };
    host.startSampler();
    if (ctx.log) ctx.log(`${cell.id}: host made ${read.shown}`);
    return host;
}

/**
 * Leave the host as the cell found it: stop a running drop, close an open
 * link, put a result away and restore the addresses the blip swapped. Runs
 * from the host leg's stop, once. Each step
 * that fails is a note and a release failure (st.releaseFailures), which
 * markHostRelease turns into the attempt's verdict.
 */
async function releaseHost(st, rec) {
    if (st.released) return;
    st.released = true;
    const { host } = st;
    const { now, nap } = st.clock;
    const note = (l) => rec.notes.push(scrub(l));
    const fail = (l) => {
        note(l);
        st.releaseFailures.push(scrub(l));
    };
    try {
        let s = await snapshotOf(host);
        const ours = st.makeTried && Number(s.gen) > st.genBefore;
        if (st.makeTried && !ours)
            note(`host release: the lane holds ${s.state}, which this cell did not make; left alone`);
        if (ours) {
            if (s.state === 'receiving') {
                await host.driver.cancelRequestDrop({ now, nap });
                s = await snapshotOf(host);
            }
            if (LINK_OPEN.has(s.state))
                await host.driver.closeRequestLink({ now, nap });
            else if (RESULTS.has(s.state))
                await host.driver.dismissRequestResult({ now, nap });
            const left = (await snapshotOf(host)).state;
            rec.request.released = left;
            if (LIVE.has(left))
                fail(`host release: the link this cell made still reads ${left}`);
        }
    } catch (e) {
        fail(`host release: ${e.message}`);
    }
    if (st.addresses) {
        try {
            const back = await host.driver.setAddresses(
                st.addresses.server,
                st.addresses.web
            );
            const ok =
                back?.server === st.addresses.server &&
                back?.web === st.addresses.web;
            rec.request.addresses = { swapped: true, restored: ok };
            if (!ok) fail('host addresses: the old server address did not read back; set it again in the dev app');
        } catch (e) {
            rec.request.addresses = { swapped: true, restored: false };
            fail(`host addresses: ${e.message}`);
        }
    }
    st.releaseDone = true;
}

/**
 * What the release left undone: its failed steps, and a release that
 * started (or a link that was made) but never finished inside the teardown
 * budget. Empty when the host is as the cell found it.
 */
function releaseProblems(st) {
    if (!st.host) return [];
    const out = [...(st.releaseFailures || [])];
    if ((st.makeTried || st.released) && !st.releaseDone)
        out.push('host release: it did not finish within the teardown budget');
    return out;
}

/**
 * A host not left as found is a keyed harness ERROR on a cell that
 * otherwise passed, because the next desktop-host cell inherits it (the
 * first live run, 2026-09-24: D2C-reqopen PASSed with its link still open,
 * and C2D-reqopen after it could not make one). A cell that already failed
 * keeps its own finding and gets the same words as a note.
 */
export const HOST_RELEASE_KEY = 'host-release';
function markHostRelease(rec, problems) {
    if (!problems.length) return;
    const first = (s) => String(s).split(/\r?\n/)[0].trim();
    const text = scrub(
        `${HOST_RELEASE_KEY}: the host was not left as found (${problems.map(first).join('; ')}); the next desktop-host cell would inherit it`
    );
    if (!rec.ok) {
        rec.notes.push(text);
        return;
    }
    rec.ok = false;
    rec.outcome = 'fail';
    rec.harness = true;
    rec.failedPhase = 'teardown';
    rec.error = {
        name: 'PhaseError',
        message: text,
        phase: 'teardown',
        reason: HOST_RELEASE_KEY,
        signatureKey: HOST_RELEASE_KEY,
        harness: true,
        safety: false,
    };
    rec.signature = {
        key: HOST_RELEASE_KEY,
        retryable: false,
        triage: HOST_RELEASE_KEY,
        text,
    };
    rec.signatureKey = HOST_RELEASE_KEY;
}

// ----------------------------------------------------------- the visitor

async function newVisitor(ctx, rec, st, tag, relayOnly) {
    if (!st.browser) {
        const web = await ctx.getAdapter('web');
        st.browser = await web.getBrowser({
            clientDir: ctx.shared?.clientDir ?? null,
            headless: true,
        });
    }
    const v = await openVisitor({
        browser: st.browser,
        link: st.link,
        web: ctx.infra?.web,
        relayOnly,
        tag,
        log: ctx.log,
        evidenceDir: path.join(rec.evidenceDir, tag),
        ledger: ctx.ledger,
    });
    st.visitors.push(v);
    return v;
}

/**
 * Wait for the prompt a visitor's Send raises and check what it claims: the
 * visitor's own count and bytes, and no relay-over-cap warning for a drop
 * this small. Only numbers and lane keys are read (OD-04: there is no
 * visitor text on the prompt).
 */
async function awaitPrompt(host, rec, st, fixture, T) {
    const snap = await awaitHostState(
        host,
        (s) => s.state === 'deciding' && s.prompt,
        T.accept,
        {
            ...st.clock,
            fail: ['ended', 'error', 'stopped', 'done'],
            what: 'the Accept prompt',
            live: st.live,
        }
    );
    const p = snap.prompt || {};
    const prompt = {
        files: p.files,
        totalBytes: p.totalBytes,
        warnings: (Array.isArray(p.warnings) ? p.warnings : []).map(safeCode),
    };
    // The UIA lane reads the prompt off the screen, where P2 renders the
    // size (fmtBytes) and never the byte count: it is compared in that form.
    const shownOnly = typeof p.totalBytes !== 'number' && typeof p.sizeText === 'string';
    if (shownOnly) prompt.sizeText = p.sizeText;
    rec.request.prompts.push(prompt);
    const want = shownOnly ? desktopFmtBytes(fixture.totalBytes) : fixture.totalBytes;
    if (
        prompt.files !== fixture.files.length ||
        (shownOnly ? prompt.sizeText !== want : prompt.totalBytes !== want)
    )
        throw flow(
            'request',
            shownOnly
                ? `the prompt reads ${prompt.files} file(s) and ${prompt.sizeText}; the visitor offered ${fixture.files.length} and ${want}`
                : `the prompt reads ${prompt.files} file(s) and ${prompt.totalBytes} bytes; the visitor offered ${fixture.files.length} and ${fixture.totalBytes}`
        );
    // P6 is for a relayed drop over 2 GB; every request fixture is 64 MiB
    // or less, so the line showing is a wrong warning.
    if (prompt.warnings.includes('relay-over-cap'))
        throw flow('request', 'the prompt warns relay-over-cap for a drop under 2 GB');
    return snap;
}

async function accept(host, rec, st, T) {
    const r = await host.driver.acceptRequest({
        timeoutMs: T.accept,
        ...st.clock,
    });
    rec.request.answers.push({ answer: 'accept', waitedMs: r.waitedMs });
    st.acceptedAt = st.clock.now();
}

/**
 * TA-16's visitor: `floe send <files> --to <link> --server <s>`, the CLI
 * adapter's own leg in its request-visitor mode, started once the CLI prints
 * WAIT (joined, connected, waiting for the Accept). The link goes to its argv
 * only; the CLI never prints it back, and the leg's evidence, argv included,
 * passes through scrubDeep with every other.
 */
async function newCliVisitor(cell, ctx, rec, st, fixture) {
    const mod = await ctx.getAdapter('cli');
    const leg = mod.createLeg({
        cellId: cell.id,
        attempt: rec.n,
        role: 'sender',
        requestLink: st.link,
        files: fixture.paths,
        infra: ctx.infra,
        build: ctx.buildFor ? ctx.buildFor('cli', 'sender') : null,
        relayOnly: Boolean(cell.sender.relayOnly),
        noRelay: false,
        cliHasRelayOnly: Boolean(ctx.cliHasRelayOnly),
        deadlineAt: rec.deadlineAt,
        ledger: ctx.ledger,
        label: 'visitor-cli',
        evidenceDir: path.join(rec.evidenceDir, 'visitor-cli'),
        iface: ctx.iface || [],
        log: ctx.log,
    });
    st.cliVisitor = leg;
    await leg.start();
    if (ctx.onPid) ctx.onPid(leg.pid ?? leg.h?.pid ?? null, `${cell.id}:visitor-cli`);
    return leg;
}

/**
 * The CLI visitor's end: its exit, raced against the attempt ending. It
 * resolves with the leg's result either way, because the CLI exits the
 * moment the host refuses, and the host's own account (its stop code) must
 * still get to be the finding; cliVisitorFailed words a failed one.
 */
async function awaitCliVisitor(leg, timeoutMs, live, clock) {
    // The poll stops once the race is decided: on the tests' fake clock nap
    // resolves at once, and a poll left running would spin forever.
    let settled = false;
    const ended = (async () => {
        while (!settled) {
            if (live && !live.on) throw flow('done', 'the attempt ended');
            await clock.nap(HOST_POLL_MS);
        }
    })();
    ended.catch(() => {});
    try {
        return await Promise.race([leg.awaitDone(timeoutMs), ended]);
    } finally {
        settled = true;
    }
}

/**
 * A CLI visitor that did not end on exit 0 and TL-03's arrived line: FAIL
 * request-flow with the one fixed line it printed (approved copy, never a
 * peer's text).
 */
function cliVisitorFailed(r) {
    return flow(
        'done',
        `the CLI visitor exited ${r.exitCode} ${r.detail?.outcome ? `on "${r.detail.outcome}"` : 'with no arrived line'}`
    );
}

// ---------------------------------------------------------------- flows

/** The request phase of each flow; returns the visitor that delivers. */
async function runFlow(cell, ctx, rec, st, fixture, T) {
    const { host } = st;
    const req = cell.request;
    const visitorRelay = Boolean(cell.sender.relayOnly);
    const open = async (tag) => {
        const v = await newVisitor(ctx, rec, st, tag, visitorRelay);
        await v.addFiles(fixture.paths, st.clock);
        return v;
    };
    if (req.visitor === 'cli' && req.flow === 'accept') {
        // TA-16: the CLI joins and waits by itself; no Send to click.
        const v = await newCliVisitor(cell, ctx, rec, st, fixture);
        await awaitPrompt(host, rec, st, fixture, T);
        await accept(host, rec, st, T);
        return v;
    }
    if (req.flow === 'accept') {
        const v = await open('visitor-1');
        await v.send(st.clock);
        await awaitPrompt(host, rec, st, fixture, T);
        await accept(host, rec, st, T);
        return v;
    }
    if (req.flow === 'decline-then-accept') {
        const v1 = await open('visitor-1');
        await v1.send(st.clock);
        await awaitPrompt(host, rec, st, fixture, T);
        const d = await host.driver.declineRequest({
            timeoutMs: T.accept,
            ...st.clock,
        });
        rec.request.answers.push({ answer: 'decline', waitedMs: d.waitedMs });
        const seen = await v1.awaitTitle([VISITOR_TEXT.declined], {
            timeoutMs: T.accept,
            ...st.clock,
            live: st.live,
        });
        rec.request.declined = seen.title;
        if (dropFiles(st.outDir).length)
            throw flow('request', 'a file was saved after the host declined');
        await host.driver.keepWaiting(st.clock);
        await awaitHostState(host, ['waiting'], 10_000, {
            ...st.clock,
            fail: ['ended', 'error'],
            what: 'Waiting after Keep waiting (request-reopen)',
            live: st.live,
        });
        rec.request.reopened = true;
        await v1.close();
        const v2 = await open('visitor-2');
        await v2.send(st.clock);
        await awaitPrompt(host, rec, st, fixture, T);
        await accept(host, rec, st, T);
        return v2;
    }
    if (req.flow === 'blip-then-accept') {
        const ms = req.blipMs;
        const blip = {
            cutMs: ms,
            liveBefore: Number(st.blip.live) || 0,
            reconnecting: false,
            hostAbsent: false,
            reclaimed: false,
        };
        rec.request.blip = blip;
        // The host's /ws is the one socket that must run through the proxy
        // by now; with none, the cut would cut nothing.
        if (blip.liveBefore < 1)
            throw blipUnproven(
                'request',
                'no socket runs through the blip proxy before the cut, so the host is not behind it and the cut would cut nothing'
            );
        const v = await open('visitor-1');
        const cutting = st.blip.cut(ms, { wait: st.clock.nap });
        cutting.catch(() => {});
        await awaitHostState(host, ['reconnecting'], ms, {
            ...st.clock,
            fail: ['ended', 'error'],
            what: `Reconnecting during the ${ms} ms cut`,
            live: st.live,
        });
        blip.reconnecting = true;
        await v.send(st.clock);
        await v.awaitTitle([VISITOR_TEXT.hostAbsent], {
            timeoutMs: ms + 10_000,
            ...st.clock,
            live: st.live,
        });
        blip.hostAbsent = true;
        const cut = await cutting;
        blip.destroyed = cut?.destroyed ?? null;
        await awaitHostState(host, ['waiting'], RECLAIM_MS, {
            ...st.clock,
            fail: ['ended', 'error'],
            what: 'Waiting again after the cut (the reclaim)',
            live: st.live,
        });
        blip.reclaimed = true;
        await v.tryAgain(st.clock);
        await awaitPrompt(host, rec, st, fixture, T);
        await accept(host, rec, st, T);
        return v;
    }
    if (req.flow === 'caddy-reload') {
        // TA-14 (spec 09 2.7.2): Caddy closes every proxied WebSocket on a
        // reload. The host is behind it; the visitor's page talks to the
        // server directly, so at the second reload it stays connected and is
        // sent peer-disconnected, which it must ignore while its channel is
        // open. The first reload's Reconnecting is the proof that the host
        // is behind the proxy at all (caddy-url otherwise).
        const caddy = {
            reloads: [],
            reconnecting: false,
            reclaimed: false,
            receivingReload: false,
        };
        rec.request.caddy = caddy;
        const r1 = await st.caddy.reload();
        caddy.reloads.push({ while: 'waiting', at: r1.at });
        try {
            await awaitHostState(host, ['reconnecting'], REQUEST_CADDY_RECONNECT_MS, {
                ...st.clock,
                fail: ['ended', 'error'],
                what: 'Reconnecting after the reload',
                live: st.live,
            });
        } catch (e) {
            if (!/ms on, not Reconnecting after the reload$/.test(e.message)) throw e;
            throw proxyUnproven(
                CADDY_KEY,
                'request',
                `the host never read Reconnecting within ${REQUEST_CADDY_RECONNECT_MS} ms of the reload, so it may not be behind the Caddy proxy and the reload proved nothing`
            );
        }
        caddy.reconnecting = true;
        await awaitHostState(host, ['waiting'], RECLAIM_MS, {
            ...st.clock,
            fail: ['ended', 'error'],
            what: 'Waiting again after the reload (the reclaim)',
            live: st.live,
        });
        caddy.reclaimed = true;
        const v = await open('visitor-1');
        await v.send(st.clock);
        await awaitPrompt(host, rec, st, fixture, T);
        await accept(host, rec, st, T);
        const moving = await awaitHostState(
            host,
            (s) => ['receiving', 'done', 'stopped'].includes(s.state),
            T.firstBytes,
            {
                ...st.clock,
                fail: ['ended', 'error'],
                what: 'the drop to start',
                live: st.live,
            }
        );
        if (moving.state !== 'receiving')
            throw proxyUnproven(
                CADDY_MISSED_KEY,
                'request',
                `the drop read ${moving.state} before the reload while receiving could land, so that half of TA-14 was not exercised`
            );
        const r2 = await st.caddy.reload();
        caddy.reloads.push({ while: 'receiving', at: r2.at });
        caddy.receivingReload = true;
        return v;
    }
    throw new PhaseError('request', `unknown request flow ${req.flow}`, {
        harness: true,
    });
}

/** Every file (not folder) under dir, relative, sorted. */
function dropFiles(dir) {
    const out = [];
    const walk = (d, rel) => {
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), r);
            else out.push(r);
        }
    };
    walk(dir, '');
    return out.sort();
}

/**
 * The host's own end of the drop: done, or a stop whose code becomes the
 * signature. Records the route the lane reports while the drop moves.
 */
async function awaitHostDrop(host, rec, st, timeoutMs, live = st.live) {
    const snap = await awaitHostState(
        host,
        (s) => {
            if (s.route === 'direct' || s.route === 'relay')
                st.snapRoute = {
                    t: st.clock.now(),
                    source: 'request-snapshot',
                    local: null,
                    remote: null,
                    verdict: s.route,
                };
            return s.state === 'done' || s.state === 'stopped';
        },
        timeoutMs,
        {
            ...st.clock,
            fail: ['ended', 'error', 'waiting'],
            phase: 'done',
            what: 'the drop to finish',
            live,
        }
    );
    if (snap.state === 'stopped') {
        const code = safeCode(snap.code);
        throw new PhaseError(
            'done',
            `${code === 'hash-mismatch' ? 'hash-mismatch' : FLOW_KEY}: the host stopped the drop (${code})`,
            { signatureKey: code === 'hash-mismatch' ? 'hash-mismatch' : FLOW_KEY }
        );
    }
    return snap;
}

// --------------------------------------------------------------- verify

function visitorStats(visitors, rec) {
    let attempts = 0;
    for (const v of visitors) {
        const p = v.statsProof();
        attempts += p.attempts;
        if (p.bytesReportedEvents > 0)
            throw new SafetyError(
                `floe:bytes-reported fired on the ${v.tag}, a request link sender`,
                { cellId: rec.cellId }
            );
        if (p.attempts > 0)
            throw new PhaseError(
                'verify',
                `stats-attempt: the ${v.tag} tried to report ${p.attempts} time(s) (all aborted)`,
                { signatureKey: 'stats-attempt' }
            );
        if (p.localStorage !== 'false')
            throw new PhaseError(
                'verify',
                `stats-attempt: the ${v.tag}'s floe:report-stats reads ${JSON.stringify(p.localStorage)}, not "false"`,
                { signatureKey: 'stats-attempt' }
            );
    }
    return attempts;
}

/**
 * The received files against the fixture: exactly the manifest inside the
 * one exclusive subfolder the host reports, byte for byte, with nothing
 * loose beside it and no .part anywhere. An empty sibling folder (a prompt
 * that was declined) holds nothing and is allowed.
 */
async function manifestMatch(fixture, outDir, folder, rec) {
    const entries = readdirSync(outDir, { withFileTypes: true });
    const loose = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
    if (loose.length)
        throw new PhaseError(
            'verify',
            `${MANIFEST_KEY}: ${loose.join(', ')} landed beside the drop subfolder, not inside it`,
            { signatureKey: MANIFEST_KEY }
        );
    const sub = entries.find(
        (e) => e.isDirectory() && samePath(path.join(outDir, e.name), folder)
    );
    if (!sub)
        throw new PhaseError(
            'verify',
            `${MANIFEST_KEY}: the folder the host reports is not a subfolder of the link's save folder`,
            { signatureKey: MANIFEST_KEY }
        );
    const others = entries
        .filter((e) => e.isDirectory() && e !== sub)
        .filter((e) => dropFiles(path.join(outDir, e.name)).length);
    if (others.length)
        throw new PhaseError(
            'verify',
            `${MANIFEST_KEY}: files in ${others.map((e) => e.name).join(', ')} beside the drop subfolder`,
            { signatureKey: MANIFEST_KEY }
        );
    const outs = await walkOutputs(path.join(outDir, sub.name), { allowPart: true });
    rec.outputs = outs;
    const parts = outs.filter((o) => o.part);
    if (parts.length)
        throw new PhaseError(
            'verify',
            `stale-part: ${parts.map((p) => p.rel).join(', ')} left in the drop subfolder`,
            { signatureKey: 'stale-part' }
        );
    const cmp = compareOutputs(fixture.files, outs);
    rec.integrity = {
        ok: cmp.ok,
        files: cmp.files,
        missing: cmp.missing,
        extra: cmp.extra,
        mismatched: cmp.mismatched,
        subfolder: sub.name,
    };
    if (cmp.mismatched.length)
        throw new PhaseError(
            'verify',
            `hash-mismatch: ${cmp.mismatched.map((m) => m.rel).join(', ')}`,
            { signatureKey: 'hash-mismatch' }
        );
    if (cmp.missing.length || cmp.extra.length)
        throw new PhaseError(
            'verify',
            `${MANIFEST_KEY}: missing ${cmp.missing.join(', ') || 'none'}; extra ${cmp.extra.join(', ') || 'none'}`,
            { signatureKey: MANIFEST_KEY }
        );
}

async function verifyRequest(cell, ctx, rec, st, fixture, T) {
    const { host, deliverer, delivered, snap } = st;
    const N = fixture.files.length;
    const cli = cell.request.visitor === 'cli';

    // Route: the visitor's nominated pair and the host's pill (or the lane's
    // own route), read as a pair the way every other cell is.
    const pill = host.route();
    const hostRoute =
        pill && pill.verdict !== 'unknown' ? pill : (st.snapRoute ?? pill);
    rec.route = { sender: deliverer.route(delivered.lines), receiver: hostRoute };
    if (cell.forcer === 'initScript' && deliverer.policy().ok === false)
        throw new PhaseError(
            'verify',
            'init-script-not-applied: a relay-forced visitor PC ran without iceTransportPolicy relay',
            { harness: true, reason: 'init-script-not-applied' }
        );
    const pair = classifyPair(rec.route, cell);
    rec.routePair = pair;
    if (!pair.ok)
        throw new PhaseError(
            'verify',
            `${pair.reason}: observed ${pair.observed}, expected ${cell.path === 'REL' ? 'relay' : 'direct'} (${pair.label})`,
            { signatureKey: pair.reason }
        );
    if (pair.reason === 'route-unproven') rec.notes.push('route-unproven');

    // Stats first, so a later failure never hides a report attempt: the
    // host's config as GetSettings read it, and every visitor so far.
    rec.stats = statsProofCheck(cell, safeEvidence(host), rec, ctx);
    rec.stats.proof.browserAttempts = visitorStats(st.visitors, rec);
    if (cli) {
        // A sender has no stats path at all; FLOE_NO_STATS=1 rides along
        // anyway (the build's hard line for every CLI run), and the local
        // /api/stats delta below must stay 0.
        const proof = safeEvidence(deliverer)?.statsProof ?? null;
        rec.stats.proof.cliVisitor = proof;
        if (proof?.floeNoStats !== '1')
            throw new PhaseError(
                'verify',
                'stats-attempt: the CLI visitor ran without FLOE_NO_STATS=1',
                { signatureKey: 'stats-attempt' }
            );
    }

    // The host's account and the done view the owner reads. On the UIA lane
    // the account IS the done view (source uia): DN1 carries the saved count,
    // and DN3 alone vouches for files and verified, which read null without it.
    const r = snap.result || {};
    const uia = snap.source === 'uia';
    rec.request.result = {
        files: r.files ?? null,
        saved: r.saved ?? null,
        verified: r.verified ?? null,
        renamed: r.renamed ?? null,
    };
    if (uia ? r.saved !== N : r.files !== N || r.saved !== N)
        throw flow(
            'verify',
            uia
                ? `the host's done view reads ${r.saved} file(s) saved; the visitor sent ${N}`
                : `the host saved ${r.saved} of ${r.files} file(s); the visitor sent ${N}`
        );
    const view = await host.driver.readRequestResult();
    rec.request.hostView = view;
    rec.completion.receiver = {
        ...rec.completion.receiver,
        text: view.heading,
    };
    if (view.files !== N)
        throw flow('verify', `the done heading reads ${JSON.stringify(view.heading)}, not ${N} file(s)`);
    // Critic M8 (H7 round). Since D-161 the verified words are the check
    // mark's screen-reader text, and on the UIA lane the done view is the
    // host's whole account: there is no GetRequestLink count to cross-check
    // it with. A view without the text, because a window does not expose the
    // span or its words changed, proves nothing, and the finding must name
    // the host's view, never the visitor's line. A modern visitor always
    // sends digests (P0-27, P0-22), so a clean drop always shows it. The old
    // compare here was the flag against itself and could never fail.
    if (uia && view.verifiedLine !== true)
        throw flow(
            'verify',
            `the host's done view carries no ${REQUEST_STRINGS.verifiedLine} text (the check mark's screen-reader span), so the drop is not proven verified`
        );
    const allVerified = r.verified === N;
    if (view.verifiedLine !== allVerified)
        throw flow(
            'verify',
            `the host's SHA sentence ${view.verifiedLine ? 'shows' : 'is missing'} with ${r.verified ?? 'not all'} of ${N} verified`
        );
    if (cli) {
        // TA-16: exit 0 and TL-03's arrived line naming the visitor's own N.
        rec.request.visitorExit = delivered.exitCode;
        if (delivered.exitCode !== 0)
            throw flow('verify', `the CLI visitor exited ${delivered.exitCode}`);
        if (delivered.detail.arrived?.files !== N)
            throw flow(
                'verify',
                `the CLI visitor's arrived line names ${delivered.detail.arrived?.files ?? 'no'} file(s), not ${N}`
            );
    }
    const shaLine = cli
        ? delivered.detail.shaLine === true
        : delivered.lines.some((l) => l.includes(VISITOR_TEXT.shaMatched));
    if (shaLine !== allVerified)
        throw flow(
            'verify',
            `the visitor's SHA line ${shaLine ? 'shows' : 'is missing'} with ${r.verified ?? (allVerified ? N : 'not all')} of ${N} verified`
        );
    // A web visitor, and the CLI, always send their digests (P0-27, P0-22),
    // so fewer verified files than sent ones is a finding even when both
    // ends agree.
    if (!allVerified)
        throw flow('verify', `the host verified ${r.verified ?? 'not all'} of ${N} file(s)`);

    // The files themselves.
    await manifestMatch(fixture, st.outDir, r.folder, rec);

    // The link reads used up: a fresh visitor gets the used copy, and the
    // host never shows a second prompt. It takes a second (web) visitor, so
    // TA-16's CLI cell leaves it to the web cells.
    if (!cli) {
        const checker = await newVisitor(ctx, rec, st, 'visitor-used', false);
        await checker.addFiles([fixture.paths[0]], st.clock);
        await checker.send(st.clock);
        try {
            const seen = await checker.awaitTitle([VISITOR_TEXT.used], {
                timeoutMs: T.join + T.connect,
                ...st.clock,
                live: st.live,
            });
            rec.request.usedUp = seen.title;
        } catch (e) {
            throw flow('verify', `the link is not used up after the drop (${e.message.replace(/^request-flow: /, '')})`);
        }
        const after = await snapshotOf(host);
        if (after.state !== 'done')
            throw flow('verify', `the host left done (${after.state}) when a second visitor tried the used link`);
        rec.stats.proof.browserAttempts = visitorStats(st.visitors, rec);
    }

    if (ctx.statsOracle) {
        if (ctx.safety) ctx.safety.localReceives += 1;
        rec.statsAfter = await ctx.statsOracle.read();
        rec.stats.proof.localTotalAfter = rec.statsAfter;
        if (rec.statsBefore !== 0 || rec.statsAfter !== 0) {
            if (ctx.safety) ctx.safety.localStatsDeltaZero = false;
            throw new PhaseError(
                'verify',
                `stats-delta: local /api/stats read ${rec.statsBefore}/${rec.statsAfter}`,
                { signatureKey: 'stats-delta' }
            );
        }
    }
    const ms = Math.max(1, (st.doneAt ?? st.clock.now()) - (st.acceptedAt ?? 0));
    rec.metrics = {
        throughputMBps: Number((fixture.totalBytes / 1e6 / (ms / 1000)).toFixed(1)),
    };
}

// ------------------------------------------------------------- attempts

function newRequestRecord(cell) {
    return {
        flow: cell.request.flow,
        link: null,
        tab: null,
        addresses: null,
        made: null,
        prompts: [],
        answers: [],
        declined: null,
        reopened: false,
        blip: null,
        result: null,
        hostView: null,
        usedUp: null,
        // TA-16: the CLI visitor's exit code (web cells leave it null).
        visitorExit: null,
        released: null,
        swept: null,
    };
}

/** The keyed-signature and verdict bookkeeping runAttempt's catch does. */
function failRecord(rec, e, cell, current, ctx) {
    rec.ok = false;
    rec.outcome = 'fail';
    const d = describeError(e);
    rec.error = { ...d, message: scrub(d.message) };
    rec.failedPhase = e.phase || current;
    rec.safety = e instanceof SafetyError || Boolean(e.safety);
    rec.harness = Boolean(e.harness) || (!(e instanceof PhaseError) && !rec.safety);
    if (e.verdict === 'SKIP' && e.reason) {
        rec.harness = false;
        rec.skipReason = e.reason;
    }
    const turnHeavy = ctx.ledger ? ctx.ledger.inWindow().turn >= 16 : false;
    const text = scrub([e.message, e.signatureKey].filter(Boolean).join('\n'));
    rec.signature = classifySignature(text, {
        relay: cell.path === 'REL',
        turnHeavy,
    });
    if (e.signatureKey) {
        const row = SIGNATURES.find(([k]) => k === e.signatureKey);
        const retry = row ? row[2] : false;
        rec.signature = {
            key: e.signatureKey,
            retryable:
                retry === 'rel' ? cell.path === 'REL' && turnHeavy : Boolean(retry),
            triage: row ? row[3] : null,
            text: rec.signature.text,
        };
    }
    rec.signatureKey = rec.signature.key;
    if (rec.safety) rec.safetyError = e;
}

/**
 * One attempt of a request cell (TA-10 to TA-13, TA-15): a record in
 * runAttempt's shape. Phases: setup, blip (TA-13), host.start,
 * request, done, verify, teardown.
 */
export async function runRequestAttempt(cell, ctx, n) {
    const T = cell.timeouts;
    const clock = clockOf(ctx);
    const rec = {
        n,
        cellId: cell.id,
        designed: false,
        startedAt: new Date().toISOString(),
        endedAt: null,
        phases: {},
        phaseList: [],
        outcome: 'fail',
        ok: false,
        signature: null,
        signatureKey: null,
        // The link is not a room link a report can hash: its shown form is
        // rec.request.link, and nothing else keeps it.
        room: { link: null, code: null },
        senderExit: null,
        receiverExit: null,
        evidence: {},
        evidenceDir: null,
        outDir: null,
        fixture: null,
        route: { sender: null, receiver: null },
        timeline: [],
        notes: [],
        error: null,
        failedPhase: null,
        harness: false,
        safety: false,
        deadlineAt: Date.now() + T.hardCap,
        completion: { sender: null, receiver: null },
        request: newRequestRecord(cell),
    };
    const st = {
        clock,
        live: { on: true },
        host: null,
        link: null,
        visitors: [],
        releaseFailures: [],
        releaseDone: false,
        browser: null,
        blip: null,
        outDir: null,
    };
    let current = 'setup';
    const phase = async (name, ms, fn) => {
        current = name;
        const t = Date.now();
        try {
            const v = await attemptTimeout(Promise.resolve().then(fn), ms, name);
            rec.phases[name] = Date.now() - t;
            rec.phaseList.push({ name, ms: Date.now() - t, ok: true });
            return v;
        } catch (e) {
            rec.phases[name] = Date.now() - t;
            rec.phaseList.push({
                name,
                ms: Date.now() - t,
                ok: false,
                error: scrub(e.message),
            });
            if (!e.phase) e.phase = name;
            throw e;
        }
    };
    let fixture = null;
    try {
        await phase('setup', T.verify, async () => {
            rec.evidenceDir = path.join(ctx.evidenceRoot, 'cells', cell.id, `attempt-${n}`);
            mkdirSync(rec.evidenceDir, { recursive: true });
            fixture = await ensureFixture(
                cell.fixture,
                path.join(ctx.fixturesDir, cell.id, `a${n}`)
            );
            rec.fixture = fixture;
            st.outDir = path.join(rec.evidenceDir, 'out');
            mkdirSync(st.outDir, { recursive: true });
            rec.outDir = st.outDir;
            if (ctx.statsOracle) rec.statsBefore = await ctx.statsOracle.read();
            if (ctx.ledger) {
                await ctx.ledger.waitFor(cell.cost, { sleep: ctx.sleep || defaultSleep, log: ctx.log });
                rec.ledgerEventsBefore = ctx.ledger.events.length;
            }
        });
        let blipUrl = null;
        if (cell.request.flow === 'blip-then-accept') {
            await phase('blip', 10_000, async () => {
                // The third lock after cellPlan's refusal and BlipProxy's own:
                // the runner never cuts sockets in front of a server that is
                // not on this machine (OD-33), whatever reached it.
                const server = ctx.infra?.server;
                if (!cell.request.loopbackOnly || !isLoopbackUrl(server))
                    throw new SafetyError(
                        `${cell.id}: the blip proxy would front ${server ?? 'no server'}, which is not loopback; nothing was started`
                    );
                const start =
                    ctx.startBlip || (await import('./blip.mjs')).startBlip;
                st.blip = await start({ upstream: server });
                blipUrl = st.blip.url;
                // The host is pointed at this URL next; without one the
                // swap would be skipped and the cell would run with no
                // proxy in the host's path.
                if (!isLoopbackUrl(blipUrl))
                    throw blipUnproven(
                        'blip',
                        'the blip proxy handed back no loopback URL, so the host cannot be pointed at it'
                    );
            });
        }
        let proxyKey = BLIP_KEY;
        if (cell.request.flow === 'caddy-reload') {
            // TA-14: a local Docker Caddy in front of the local server, the
            // host behind it (lib/caddy.mjs). Pulling caddy:2 on a first run
            // is part of this budget.
            await phase('caddy', 180_000, async () => {
                // The runner's own lock after cellPlan's refusal and
                // caddyUpstream's: never a reload in front of a server that
                // is not on this machine (OD-33).
                const server = ctx.infra?.server;
                if (!cell.request.loopbackOnly || !isLoopbackUrl(server))
                    throw new SafetyError(
                        `${cell.id}: the Caddy proxy would front ${server ?? 'no server'}, which is not loopback; nothing was started`
                    );
                const start =
                    ctx.startCaddy || (await import('./caddy.mjs')).startCaddy;
                st.caddy = await start({
                    upstream: server,
                    runDir: rec.evidenceDir,
                    log: ctx.log,
                });
                blipUrl = st.caddy.url;
                proxyKey = CADDY_KEY;
                if (!isLoopbackUrl(blipUrl))
                    throw proxyUnproven(
                        CADDY_KEY,
                        'caddy',
                        'the Caddy proxy handed back no loopback URL, so the host cannot be pointed at it'
                    );
            });
        }
        await phase('host.start', T.link + 30_000, () =>
            startHost(cell, ctx, rec, st, {
                outDir: st.outDir,
                relayOnly: cell.receiver.relayOnly,
                blipUrl,
                proxyKey,
            })
        );
        const requestMs =
            T.accept +
            T.join +
            T.connect +
            (cell.request.flow === 'blip-then-accept'
                ? cell.request.blipMs + RECLAIM_MS
                : 0) +
            (cell.request.flow === 'caddy-reload'
                ? REQUEST_CADDY_RECONNECT_MS + RECLAIM_MS + T.firstBytes + 120_000
                : 0) +
            (cell.request.flow === 'decline-then-accept'
                ? T.accept + T.join + T.connect
                : 0);
        st.deliverer = await phase('request', requestMs, () =>
            runFlow(cell, ctx, rec, st, fixture, T)
        );
        const budget = T.firstBytes + T.complete + T.exit;
        await phase('done', budget, async () => {
            // Both ends are watched together; the first to fail stops the
            // other, and the host's account wins, since its stop code (a
            // hash-mismatch, say) is the finding the visitor only echoes.
            let failed = false;
            const both = { get on() { return st.live.on && !failed; } };
            const stopOther = (e) => {
                failed = true;
                throw e;
            };
            // TA-16's CLI resolves on its exit whatever it was, and only then
            // is judged, below: its failure never stops the host's wait.
            const cli = cell.request.visitor === 'cli';
            const [h, v] = await Promise.allSettled([
                awaitHostDrop(st.host, rec, st, budget, both).catch(stopOther),
                cli
                    ? awaitCliVisitor(st.deliverer, budget, both, clock)
                    : st.deliverer
                          .awaitTitle([arrivedTitle(fixture.files.length)], {
                              timeoutMs: budget,
                              ...clock,
                              live: both,
                          })
                          .catch(stopOther),
            ]);
            const ended = (x) => /the attempt ended$/.test(x.reason?.message || '');
            if (h.status === 'rejected' && !ended(h)) throw h.reason;
            if (v.status === 'rejected' && !ended(v)) throw v.reason;
            if (h.status === 'rejected') throw h.reason;
            if (v.status === 'rejected') throw v.reason;
            const snap = h.value;
            const delivered = v.value;
            if (cli && !delivered.ok) throw cliVisitorFailed(delivered);
            st.snap = snap;
            st.delivered = delivered;
            st.doneAt = clock.now();
            rec.completion = {
                sender: {
                    text: cli ? delivered.detail.arrived.line : delivered.title,
                    seenAt: cli ? null : delivered.at - (st.acceptedAt ?? delivered.at),
                    exitCode: cli ? delivered.exitCode : null,
                    kind: 'transfer',
                    ok: true,
                    synthesized: false,
                },
                receiver: {
                    text: `request ${snap.state}`,
                    seenAt: null,
                    exitCode: null,
                    kind: 'transfer',
                    ok: true,
                    synthesized: false,
                },
            };
        });
        await phase('verify', T.verify + T.join + T.connect, () =>
            verifyRequest(cell, ctx, rec, st, fixture, T)
        );
        rec.ok = true;
        rec.outcome = 'pass';
    } catch (e) {
        failRecord(rec, e, cell, current, ctx);
    } finally {
        st.live.on = false;
        try {
            await phase('teardown', T.teardown, async () => {
                for (const v of st.visitors) {
                    try {
                        await v.close();
                    } catch (e) {
                        rec.notes.push(scrub(`close ${v.tag}: ${e.message}`));
                    }
                }
                // TA-16's CLI visitor, if it is still running (a failed cell).
                if (st.cliVisitor) {
                    try {
                        await st.cliVisitor.stop(rec.ok ? 'done' : 'failed');
                    } catch (e) {
                        rec.notes.push(scrub(`stop the CLI visitor: ${e.message}`));
                    }
                }
                if (st.host) {
                    try {
                        // stop() runs releaseHost first (beforeClose).
                        await st.host.stop(rec.ok ? 'done' : 'failed');
                    } catch (e) {
                        rec.notes.push(scrub(`stop host: ${e.message}`));
                        if (e instanceof SafetyError || e.safety) {
                            rec.ok = false;
                            rec.outcome = 'fail';
                            rec.safety = true;
                            rec.safetyError = e;
                            rec.error = rec.error || describeError(e);
                            rec.failedPhase = rec.failedPhase || 'teardown';
                        }
                    }
                }
                if (st.blip) {
                    try {
                        await st.blip.stop();
                    } catch (e) {
                        rec.notes.push(`blip stop: ${e.message}`);
                    }
                }
                if (st.caddy) {
                    try {
                        await st.caddy.stop();
                    } catch (e) {
                        rec.notes.push(`caddy stop: ${e.message}`);
                    }
                }
            });
        } catch (e) {
            rec.notes.push(scrub(`teardown: ${e.message}`));
        }
        markHostRelease(rec, releaseProblems(st));
        // Every visitor's report attempts reach the Safety table, pass or
        // fail; verify only turns them into the cell's verdict.
        if (ctx.safety) {
            for (const v of st.visitors) {
                const p = v.statsProof();
                ctx.safety.statsReportAttempts += p.attempts;
                ctx.safety.bytesReportedEvents += p.bytesReportedEvents;
            }
        }
        const hostEv = st.host ? safeEvidence(st.host) : null;
        const visitorsEv = st.visitors.map((v) => safeEvidence(v));
        rec.evidence = scrubDeep({
            sender: st.deliverer
                ? safeEvidence(st.deliverer)
                : st.cliVisitor
                  ? safeEvidence(st.cliVisitor)
                  : (visitorsEv.at(-1) ?? null),
            receiver: hostEv,
            visitors: visitorsEv,
        });
        rec.evidence.captures = [...(hostEv?.captures || [])];
        if (ctx.safety?.captures)
            ctx.safety.captures.count += rec.evidence.captures.length;
        if (
            ctx.ledger &&
            ctx.infra?.name === 'prod' &&
            ctx.ledger.events.length === (rec.ledgerEventsBefore ?? 0) &&
            rec.phases['host.start'] !== undefined
        ) {
            ctx.ledger.commit(cell.cost);
            rec.notes.push('ledger: adapters did not spend, charged the cell cost');
        }
        rec.endedAt = new Date().toISOString();
        rec.bytesMoved = rec.ok
            ? (fixture?.totalBytes ?? 0)
            : st.outDir
              ? dropFiles(st.outDir).reduce((a, r) => {
                    try {
                        return a + statSync(path.join(st.outDir, r)).size;
                    } catch {
                        return a;
                    }
                }, 0)
              : 0;
        rec.notes = rec.notes.map(scrub);
        writeEvidence(rec);
    }
    return rec;
}

function writeEvidence(rec) {
    if (!rec.evidenceDir) return;
    try {
        writeFileSync(
            path.join(rec.evidenceDir, 'route.json'),
            JSON.stringify(
                scrubDeep({ route: rec.route, pair: rec.routePair ?? null, timeline: rec.timeline }),
                null,
                4
            )
        );
        writeFileSync(
            path.join(rec.evidenceDir, 'outputs.json'),
            JSON.stringify(rec.outputs ?? [], null, 4)
        );
        const { safetyError, ...plain } = rec;
        void safetyError;
        writeFileSync(
            path.join(rec.evidenceDir, 'attempt.json'),
            JSON.stringify(scrubDeep(plain), null, 4)
        );
    } catch (e) {
        rec.notes.push(`evidence write: ${e.message}`);
    }
}

// ------------------------------------------------------------- TA-17

/**
 * The hooks that hold a link open through one quick-cell attempt: the host
 * makes a link into its own folder after setup, the quick cell runs as it
 * always does, and verify then requires the same link still waiting and
 * that folder still empty. The host is released in the attempt's teardown.
 */
export function openLinkHooks(cell, ctx) {
    const st = {
        clock: clockOf(ctx),
        live: { on: true },
        host: null,
        link: null,
        visitors: [],
        releaseFailures: [],
        releaseDone: false,
    };
    return {
        /** What the host release left undone (runOpenLinkAttempt reads it). */
        releaseProblems: () => releaseProblems(st),
        async afterSetup(rec) {
            rec.request = newRequestRecord(cell);
            st.drops = path.join(rec.evidenceDir, 'host-drops');
            mkdirSync(st.drops, { recursive: true });
            await startHost(cell, ctx, rec, st, {
                outDir: st.drops,
                relayOnly: false,
            });
        },
        async afterVerify(rec) {
            const snap = await snapshotOf(st.host);
            rec.request.after = snap.state;
            if (snap.state !== 'waiting' || snap.link !== st.link)
                throw flow(
                    'verify',
                    `the open link did not survive the quick cell (the host reads ${snap.state}${snap.link && snap.link !== st.link ? ' with another link' : ''})`
                );
            if (dropFiles(st.drops).length)
                throw flow('verify', "files arrived in the open link's folder during the quick cell");
        },
        async teardown(rec) {
            st.live.on = false;
            if (!st.host) return;
            try {
                await st.host.stop(rec.ok ? 'done' : 'failed');
            } finally {
                rec.evidence.host = scrubDeep(safeEvidence(st.host));
                if (ctx.safety?.captures)
                    ctx.safety.captures.count += (rec.evidence.host?.captures || []).length;
                rec.notes = rec.notes.map(scrub);
            }
        },
    };
}

/**
 * One attempt of a TA-17 cell: the quick cell with a link held open. The
 * release is judged after runAttempt returns, because its teardown phase
 * can time out while the release is still running (the first live run's
 * D2C-reqopen, 2026-09-24); attempt.json is rewritten when that changes
 * the verdict.
 */
export async function runOpenLinkAttempt(cell, ctx, n, opts = {}) {
    const hooks = openLinkHooks(cell, ctx);
    const rec = await runAttempt(cell, ctx, n, { ...opts, hooks });
    const problems = hooks.releaseProblems();
    if (problems.length) {
        markHostRelease(rec, problems);
        rec.notes = rec.notes.map(scrub);
        if (rec.evidenceDir) {
            try {
                const { safetyError, ...plain } = rec;
                void safetyError;
                writeFileSync(
                    path.join(rec.evidenceDir, 'attempt.json'),
                    JSON.stringify(scrubDeep(plain), null, 4)
                );
            } catch (e) {
                rec.notes.push(`evidence write: ${e.message}`);
            }
        }
    }
    return rec;
}
