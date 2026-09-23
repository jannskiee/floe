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
// rows apply unchanged. runOpenLinkAttempt runs TA-17: the quick cell's own
// attempt, with the host holding a link open beside it (runAttempt hooks).
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
import { RE, safeCode, samePath } from './desktop.mjs';
import { compareOutputs, ensureFixture, walkOutputs } from './fixtures.mjs';
import { isLoopbackUrl } from './matrix.mjs';
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
/** The request host verbs exist on the wailsdev lane only (UIA: Phase F). */
export const UIA_PENDING = 'request-host-uia-pending';

// The lane states in which a link exists and can be closed (Close link),
// and the results that hold the Beta switch until Dismiss (requestLink.ts
// LINK_PHASES and HOLDS).
const LINK_OPEN = new Set([
    'waiting',
    'reconnecting',
    'connecting',
    'deciding',
    'declined',
]);
const RESULTS = new Set(['done', 'stopped']);

const scrub = (s) => redactRequestLinks(s);

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
 * Settings > Beta > Request links, read back through GetSettings. The
 * switch stays disabled until the app's own /health probe answers
 * (requestLinksSwitch in settings.ts: off and not yet available), and
 * opening Settings is what starts that probe, so the click is retried for
 * BETA_WAIT_MS before the switch counts as stuck.
 */
export const BETA_WAIT_MS = 10_000;
export async function setRequestLinks(host, on, { now = Date.now, nap = defaultSleep } = {}) {
    const before = (await host.driver.settings())?.requestLinks === true;
    if (before === on) return { before, after: before, changed: false };
    await host.withSettings(async () => {
        const start = now();
        for (;;) {
            const r = await host.driver.setToggle(RE.requestLinksRow, on);
            if (r.after === on || now() - start >= BETA_WAIT_MS) return r;
            await nap(HOST_POLL_MS);
        }
    });
    const after = (await host.driver.settings())?.requestLinks === true;
    if (after !== on)
        throw flow(
            'host.start',
            `the Beta switch did not turn ${on ? 'on' : 'off'} (GetSettings requestLinks=${after}); the app may not see request-1 on its server`
        );
    return { before, after, changed: true };
}

/**
 * Launch the host, force its relay when the cell asks (TA-12), turn the
 * Beta switch on, point it at the blip proxy (TA-13), make a link into
 * `outDir` and read it. Returns the full link; the record keeps its shown
 * form only.
 */
async function startHost(cell, ctx, rec, st, { outDir, relayOnly, blipUrl = null }) {
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
    if (host.mode !== 'wailsdev')
        throw new PhaseError(
            'host.start',
            `the request link host verbs run on the wailsdev lane only (this desktop is ${host.mode}); the UIA verbs are Phase F prep`,
            { verdict: 'SKIP', reason: UIA_PENDING }
        );
    st.host = host;
    // Whatever happens next, the leg's stop (the cell's teardown or the
    // audit's interrupt shutdown) closes the link and puts the switches back.
    host.beforeClose = () => releaseHost(st, rec);
    await host.launch([]);
    await host.applyRelayForcer();
    st.beta = await setRequestLinks(host, true, st.clock);
    rec.request.beta = { ...st.beta };
    if (blipUrl) {
        const before = await host.driver.settings();
        st.addresses = { server: before?.server ?? '', web: before?.web ?? '' };
        const web = ctx.infra?.web ?? '';
        const after = await host.driver.setAddresses(blipUrl, web);
        rec.request.addresses = { swapped: true, restored: null };
        if (!after || after.server !== blipUrl || after.web !== web)
            throw new PhaseError(
                'host.start',
                'the host did not take the blip proxy as its server address (SetSettings read back something else)',
                { harness: true, reason: 'wailsdev-config' }
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
 * link, put a result away (the Beta switch is locked while one shows),
 * restore the addresses the blip swapped, and turn the Beta switch back off
 * if the cell turned it on. Runs from the host leg's stop, once.
 */
async function releaseHost(st, rec) {
    if (st.released) return;
    st.released = true;
    const { host } = st;
    const { now, nap } = st.clock;
    const note = (l) => rec.notes.push(scrub(l));
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
            rec.request.released = (await snapshotOf(host)).state;
        }
    } catch (e) {
        note(`host release: ${e.message}`);
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
            if (!ok) note('host addresses: the old server address did not read back; set it again in the dev app');
        } catch (e) {
            rec.request.addresses = { swapped: true, restored: false };
            note(`host addresses: ${e.message}`);
        }
    }
    if (st.beta?.changed) {
        try {
            await setRequestLinks(host, false, st.clock);
        } catch (e) {
            note(`Beta switch restore: ${e.message}`);
        }
    }
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
    rec.request.prompts.push(prompt);
    if (
        prompt.files !== fixture.files.length ||
        prompt.totalBytes !== fixture.totalBytes
    )
        throw flow(
            'request',
            `the prompt reads ${prompt.files} file(s) and ${prompt.totalBytes} bytes; the visitor offered ${fixture.files.length} and ${fixture.totalBytes}`
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
        const v = await open('visitor-1');
        const cutting = st.blip.cut(ms, { wait: st.clock.nap });
        cutting.catch(() => {});
        const blip = { cutMs: ms, reconnecting: false, hostAbsent: false, reclaimed: false };
        rec.request.blip = blip;
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

    // The host's account and the done view the owner reads.
    const r = snap.result || {};
    rec.request.result = {
        files: r.files ?? null,
        saved: r.saved ?? null,
        verified: r.verified ?? null,
        renamed: r.renamed ?? null,
    };
    if (r.files !== N || r.saved !== N)
        throw flow('verify', `the host saved ${r.saved} of ${r.files} file(s); the visitor sent ${N}`);
    const view = await host.driver.readRequestResult();
    rec.request.hostView = view;
    rec.completion.receiver = {
        ...rec.completion.receiver,
        text: view.heading,
    };
    if (view.files !== N)
        throw flow('verify', `the done heading reads ${JSON.stringify(view.heading)}, not ${N} file(s)`);
    const allVerified = r.verified === N;
    if (view.verifiedLine !== allVerified)
        throw flow(
            'verify',
            `the host's SHA sentence ${view.verifiedLine ? 'shows' : 'is missing'} with ${r.verified} of ${N} verified`
        );
    const shaLine = delivered.lines.some((l) => l.includes(VISITOR_TEXT.shaMatched));
    if (shaLine !== allVerified)
        throw flow(
            'verify',
            `the visitor's SHA line ${shaLine ? 'shows' : 'is missing'} with ${r.verified} of ${N} verified`
        );
    // A web visitor always sends its digests (P0-27), so fewer verified
    // files than sent ones is a finding even when both screens agree.
    if (!allVerified)
        throw flow('verify', `the host verified ${r.verified} of ${N} file(s)`);

    // The files themselves.
    await manifestMatch(fixture, st.outDir, r.folder, rec);

    // The link reads used up: a fresh visitor gets the used copy, and the
    // host never shows a second prompt.
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
        beta: null,
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
        released: null,
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
            });
        }
        await phase('host.start', T.link + 30_000, () =>
            startHost(cell, ctx, rec, st, {
                outDir: st.outDir,
                relayOnly: cell.receiver.relayOnly,
                blipUrl,
            })
        );
        const requestMs =
            T.accept +
            T.join +
            T.connect +
            (cell.request.flow === 'blip-then-accept'
                ? cell.request.blipMs + RECLAIM_MS
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
            const [h, v] = await Promise.allSettled([
                awaitHostDrop(st.host, rec, st, budget, both).catch(stopOther),
                st.deliverer
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
            st.snap = snap;
            st.delivered = delivered;
            st.doneAt = clock.now();
            rec.completion = {
                sender: {
                    text: delivered.title,
                    seenAt: delivered.at - (st.acceptedAt ?? delivered.at),
                    exitCode: null,
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
            });
        } catch (e) {
            rec.notes.push(scrub(`teardown: ${e.message}`));
        }
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
            sender: st.deliverer ? safeEvidence(st.deliverer) : (visitorsEv.at(-1) ?? null),
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
    };
    return {
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

/** One attempt of a TA-17 cell: the quick cell with a link held open. */
export function runOpenLinkAttempt(cell, ctx, n, opts = {}) {
    return runAttempt(cell, ctx, n, { ...opts, hooks: openLinkHooks(cell, ctx) });
}
