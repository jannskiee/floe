// The per-cell state machine: setup, sender.start, receiver.start, connect,
// route, done, verify, teardown, each under its own timeout from the
// matrix row. Every attempt gets a fresh room, output dir and fixture (the
// CLI never overwrites, so a reused dir would hide the real path). Retry
// is signature-based and happens at most once per cell under a run-wide
// cap of 3: the connect-then-nothing family is FAIL early-race and never
// retried, because a retry that passes would relabel the early-message
// race as luck. Verdicts: PASS, FLAKY (second attempt passed), FAIL, SKIP
// (precondition unmet at run time), ERROR (harness), plus the expected
// failure shapes of the cap3g, killsnd and killrcv cells.
import {
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { PhaseError, SafetyError, sleep as defaultSleep } from './surfaces.mjs';
import {
    compareOutputs,
    ensureFixture,
    formatBytes,
    readZip,
    walkOutputs,
} from './fixtures.mjs';
import { classifyPair } from './route.mjs';
import { readFileSync } from 'node:fs';

export const PHASES = Object.freeze([
    'setup',
    'sender.start',
    'receiver.start',
    'connect',
    'route',
    'done',
    'verify',
    'teardown',
]);

export const RETRY_CAP = 3;
export const RETRY_WAIT_MS = 20_000;
export const DRAIN_WAIT_MS = 90_000;
export const ROUTE_POLL_MS = 500;
export const KILL_POLL_MS = 500;

// [key, regex, retryable ('rel' = only on relay cells with a TURN-heavy
// window or a STUN-only warning), triage heading]. First hit wins.
export const SIGNATURES = Object.freeze([
    [
        'early-race',
        /connected, but no data arrived from the sender within|Connected, but the sender never started sending|receiver left or declined before the transfer started|no-data-after-connect/i,
        false,
        'connect-then-nothing',
    ],
    ['hash-mismatch', /hash-mismatch/, false, 'hash-mismatch'],
    ['incomplete-file', /incomplete file "/, false, 'incomplete-file'],
    ['route-mismatch', /route-mismatch/, false, 'route-mismatch'],
    ['route-disagree', /route-disagree/, false, 'route-disagree'],
    ['forcer-ineffective', /forcer-ineffective/, false, 'forcer-ineffective'],
    ['stats-attempt', /stats-attempt/, false, 'stats-attempt'],
    // A .part left behind by a receiver that exited clean is a product
    // defect (the staged write was never committed or abandoned), never a
    // harness fault.
    ['stale-part', /stale-part|stale \.part file/, false, 'stale-part'],
    // A CLI or desktop sender whose POST /api/code failed prints only the
    // Link row (main.go: "Warning: could not generate short code"); the
    // cause is the code limiter, so the retry is allowed and paced.
    [
        'code-registration-failed',
        /code-registration-failed|could not generate short code/i,
        true,
        'rate-limit',
    ],
    [
        'relay-cap',
        /relay connections are capped at 2 GB|Relay limit exceeded/,
        false,
        'relay-cap',
    ],
    [
        'uia-setvalue',
        /Please enter a code or link\.|uia-setvalue|desktop-receiver-undrivable/i,
        false,
        'uia-setvalue',
    ],
    // Only the texts a real 429 produces: the server bodies, the CLI's
    // code client ("server returned 429 when registering|resolving code")
    // and an HTTP status line. A bare 429 also appears in byte counts
    // ("429 of 12582912 bytes") and speeds ("429.3 KB/s"), so it is never
    // matched on its own.
    [
        'rate-limited',
        /Too many refreshes|Rate limit exceeded|Too many requests|Too many reports|server returned 429\b|HTTP 429\b/i,
        true,
        'rate-limit',
    ],
    // The browser leg records the status of every TURN credential answer.
    // A refused fetch on a relay-forced page leaves it with no candidates at
    // all, so its peer's connect timeout is the limiter's, not the network's.
    // 429 is the per-IP limiter (drain the window and retry); 5xx is the
    // server or the Cloudflare mint failing, which is infra, exactly as the
    // same answer seen by a CLI leg (ice-fetch-failed) already is.
    [
        'turn-fetch-rejected',
        /turn-fetch-status 429\b/,
        true,
        'turn-fetch-rejected',
    ],
    // Any other status the hint can carry: a 5xx from the server or the
    // Cloudflare mint, a 4xx, or the 0 the adapter records for a fetch that
    // never got headers. The 429 row sits above and wins; 200 and 304 never
    // reach the classifier.
    ['turn-fetch-failed', /turn-fetch-status \d+\b/, true, 'infra-down'],
    // The one designed FAIL of the relay-cap cell: bytes crossed the relay
    // before the gate, or the sender ended some other way.
    ['cap-not-enforced', /cap-not-enforced/, false, 'cap-not-enforced'],
    ['turn-degraded', /Using STUN only/, 'rel', 'turn-degraded'],
    [
        'ice-fetch-failed',
        /failed to fetch ICE credentials/i,
        true,
        'infra-down',
    ],
    [
        'signaling-unreachable',
        /could not reach signaling server|failed to connect to signaling server|Could not reach the server/i,
        true,
        'infra-down',
    ],
    [
        'room-full',
        /room is full|Link Invalid|expected sender role/i,
        true,
        'room-full',
    ],
    [
        'goto-timeout',
        /page\.goto|navigation timeout|goto-timeout/i,
        true,
        'stale-bundle',
    ],
    [
        'stale-bundle-reload',
        /stale-bundle-reload|ChunkLoadError|module factory is not available/i,
        true,
        'stale-bundle',
    ],
    // The product's own connect timeouts, plus the harness's: on a DIR
    // cell the connect budget (45 s) runs out before the CLI's own error
    // (signalWaitTimeout 30 s + connectTimeout 30 s) can land, so the
    // waitLine, waitForFunction and phase-timeout texts are the signature.
    [
        'connect-timeout',
        /timed out establishing a connection|timed out waiting for the peer|A connection could not be established|Connection failed|no line matching \/\^ \{2\}Connected|no PC reached connected in|phase timeout: connect exceeded/i,
        'rel',
        'connect-timeout',
    ],
    [
        'code-expired',
        /not found or expired|was not recognized/i,
        false,
        'code-expired',
    ],
    ['code-spent', /no longer active/i, false, 'code-spent'],
    [
        'peer-refused',
        /connection closed before any file arrived/i,
        false,
        'peer-refused',
    ],
    ['ack-timeout', /timed out waiting for ack/i, false, 'ack-timeout'],
    [
        'stall',
        /transfer stalled: no data for|backpressure stall|connection closed mid-transfer/i,
        false,
        'stall',
    ],
    ['incompatible', /Cannot transfer: /, false, 'incompatible'],
    ['wsl-host-ip', /wsl: no default route IP/, false, 'wsl-host-ip'],
    ['phase-timeout', /phase timeout/i, false, 'phase-timeout'],
]);

/**
 * Every key that has a row in references/triage.md. The report prints its
 * "no row" disclaimer from this set, so a key with a row never carries the
 * disclaimer and a key without one always does. triage.test.mjs asserts
 * this set and the table's first column are the same.
 */
export const TRIAGE_KEYS = new Set([
    'connect-then-nothing',
    'room-full',
    'code-expired',
    'code-spent',
    'turn-degraded',
    'turn-fetch-rejected',
    'turn-fetch-failed',
    'cap-not-enforced',
    'connect-timeout',
    'relay-cap',
    'phase-timeout',
    'stale-bundle',
    'stats-attempt',
    'rate-limit',
    'uia-setvalue',
    'infra-down',
    'stall',
    'incomplete-file',
    'hash-mismatch',
    'incompatible',
    'route-disagree',
    'route-mismatch',
    'forcer-ineffective',
    'peer-refused',
    'ack-timeout',
    'stale-part',
    'kill-receiver-part',
    'kill-failed',
    'kill-sender-outcome',
    'kill-sender-cleanup',
    'stats-delta',
    'wsl-host-ip',
]);

export const INFRA_KEYS = new Set([
    'ice-fetch-failed',
    'signaling-unreachable',
    'turn-fetch-failed',
]);

/**
 * Signature keys whose retry drains a full limiter window and counts a
 * ledger symptom. lib/pacing.mjs makes two CONSECUTIVE symptoms infraDown(),
 * so audit.mjs clears them after any cell that ended for another reason.
 */
export const PENALIZED_KEYS = new Set([
    'rate-limited',
    'code-registration-failed',
    'turn-degraded',
    'turn-fetch-rejected',
    'connect-timeout',
]);

/** classifySignature(text, { relay, turnHeavy }) -> { key, retryable, triage, text } */
export function classifySignature(
    text,
    { relay = false, turnHeavy = false } = {}
) {
    const s = String(text || '');
    for (const [key, re, retry, triage] of SIGNATURES) {
        if (re.test(s)) {
            const retryable =
                retry === 'rel' ? relay && turnHeavy : Boolean(retry);
            return { key, retryable, triage, text: firstLine(s) };
        }
    }
    return {
        key: 'unknown',
        retryable: false,
        triage: null,
        text: firstLine(s),
    };
}

/**
 * Lines from a web leg's evidence: one per leg whose LAST TURN credential
 * answer was neither 200 nor 304 (the status only, never a body; 304 is the
 * ordinary revalidation of a cached body on a same-context reload).
 *
 * `forcedOnly` is what the classifier passes: only a relay-forced page is
 * disabled by a refused fetch, since it then gathers no candidates at all.
 * A page that can still use STUN is unaffected, so a 429 there is a note for
 * the reader and never the failure's signature.
 */
export function turnFetchHints(legs = {}, { forcedOnly = false } = {}) {
    const out = [];
    for (const side of ['sender', 'receiver']) {
        const ev = legs[side] && safeEvidence(legs[side]);
        if (!ev || ev.surface !== 'web' || !Array.isArray(ev.turnFetches))
            continue;
        if (forcedOnly && !ev.relayOnly) continue;
        const last = ev.turnFetches[ev.turnFetches.length - 1];
        if (!last || last.status === 200 || last.status === 304) continue;
        const n = ev.turnFetches.length;
        out.push(
            `turn-fetch-status ${last.status} on the ${ev.relayOnly ? 'relay-forced ' : ''}web ${side}${n > 1 ? ` (${n} fetches)` : ''}`
        );
    }
    return out;
}

/** One note per web leg naming the candidate types each side produced. */
export function candidateNotes(legs = {}) {
    const out = [];
    for (const side of ['sender', 'receiver']) {
        const ev = legs[side] && safeEvidence(legs[side]);
        const cand = ev && ev.surface === 'web' && ev.candidates;
        if (!cand) continue;
        const fmt = (a) => (a && a.length ? a.join(',') : 'none');
        out.push(
            `web ${side} candidates: local ${fmt(cand.local)}; remote ${fmt(cand.remote)}`
        );
    }
    return out;
}

export function isEarlyRace(text) {
    return classifySignature(text).key === 'early-race';
}

const firstLine = (s) =>
    String(s || '')
        .split(/\r?\n/)
        .find((l) => l.trim()) || '';

export function describeError(e) {
    if (!e) return null;
    return {
        name: e.name || 'Error',
        message: e.message || String(e),
        phase: e.phase || null,
        reason: e.reason || null,
        signatureKey: e.signatureKey || null,
        harness: Boolean(e.harness),
        safety: e instanceof SafetyError || Boolean(e.safety),
    };
}

function withTimeout(promise, ms, phase) {
    let timer;
    const t = new Promise((_, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    new PhaseError(
                        phase,
                        `phase timeout: ${phase} exceeded ${ms} ms`,
                        { timeout: true }
                    )
                ),
            ms
        );
    });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

export function assertStatsOff(cell) {
    if (!cell.receiver || cell.receiver.statsOff !== true)
        throw new SafetyError(
            `cell ${cell.id}: receiver leg lacks statsOff: true`
        );
}

function legPid(leg) {
    return leg?.pid ?? leg?.h?.pid ?? null;
}

/** A leg's exit code once its process has ended, else null (desktop, web). */
function legExitCode(leg) {
    if (!leg) return null;
    if (typeof leg.exitCode === 'number') return leg.exitCode;
    const code = leg.h?.exit?.code;
    return typeof code === 'number' ? code : null;
}

/**
 * A done phase that ran out still has facts: each leg's exit code (a CLI
 * that printed its summary has exited) and whatever the receiver left on
 * disk. Record them and say so in the note, so the report can read
 * "transfer completed, oracle missed" rather than nothing. 2026-08-28: both
 * desktop cells timed out on a split Text node while the CLI receiver had
 * exited 0 with the file on disk, and attempt.json said receiverExit null.
 */
async function recordDoneTimeout(cell, legs, rec, outDir) {
    rec.senderExit = legExitCode(legs.sender);
    rec.receiverExit = legExitCode(legs.receiver);
    let files = [];
    let parts = [];
    try {
        const outs = outDir
            ? await walkOutputs(outDir, { allowPart: true })
            : [];
        files = outs.filter((o) => !o.part);
        parts = outs.filter((o) => o.part);
        rec.outputs = outs;
    } catch (err) {
        rec.notes.push(`done timeout: outputs unreadable: ${err.message}`);
    }
    const exitText = (side, code) => `${side} exit ${code ?? '-'}`;
    // A receiver without an exit code (desktop, web) counts as complete on
    // the file alone; a CLI or WSL receiver must have exited 0.
    const receiverExits =
        cell.receiver.surface === 'cli' || cell.receiver.surface === 'wsl';
    const completed =
        files.length > 0 &&
        parts.length === 0 &&
        (rec.receiverExit === 0 ||
            (!receiverExits && rec.receiverExit === null));
    let summary = `done timed out; ${exitText('sender', rec.senderExit)}, ${exitText('receiver', rec.receiverExit)}, ${files.length} file${files.length === 1 ? '' : 's'} on disk`;
    if (parts.length) summary += `, ${parts.length} .part`;
    if (completed) summary += ' (transfer completed, oracle missed)';
    rec.doneTimeout = {
        senderExit: rec.senderExit,
        receiverExit: rec.receiverExit,
        files: files.length,
        parts: parts.length,
        completed,
        summary,
    };
    rec.notes.push(summary);
}

function safeEvidence(leg) {
    try {
        return leg ? leg.evidence() : null;
    } catch (e) {
        return { error: e.message, notes: [] };
    }
}

/**
 * Every .part file under dir with its size. Runs inside the detached kill
 * and byte-guard loops, so nothing here may throw: a .part renamed to its
 * final name between readdir and stat is simply not a .part any more.
 */
export function partFiles(dir, fsImpl = { existsSync, readdirSync, statSync }) {
    const out = [];
    const walk = (d) => {
        let entries;
        try {
            entries = fsImpl.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const abs = path.join(d, e.name);
            if (e.isDirectory()) walk(abs);
            else if (/\.part$/i.test(e.name)) {
                try {
                    out.push({ path: abs, bytes: fsImpl.statSync(abs).size });
                } catch {
                    // Renamed or removed between readdir and stat.
                }
            }
        }
    };
    if (dir && fsImpl.existsSync(dir)) walk(dir);
    return out;
}

function legOpts(cell, role, ctx, rec, extra) {
    const leg = cell[role];
    const build = ctx.buildFor ? ctx.buildFor(leg.surface, role) : null;
    return {
        cellId: cell.id,
        attempt: rec.n,
        role,
        infra: ctx.infra,
        build,
        relayOnly: Boolean(leg.relayOnly),
        noRelay: Boolean(leg.noRelay),
        forcer: leg.forcer,
        cliHasRelayOnly: Boolean(ctx.cliHasRelayOnly),
        expect: cell.expect,
        killAtBytes: cell.killAtBytes,
        pionTrace: Boolean(
            ctx.pionTrace &&
            cell.path === 'REL' &&
            (leg.surface === 'cli' || leg.surface === 'wsl')
        ),
        deadlineAt: rec.deadlineAt,
        ledger: ctx.ledger,
        label: role,
        iface: ctx.iface || [],
        monitor: ctx.monitor ?? 'secondary',
        userAway: Boolean(ctx.userAway),
        pauseMaxMin: ctx.pauseMaxMin,
        shared: ctx.shared || {},
        // lib/web.mjs resolves Playwright from the installed client tree.
        clientDir: ctx.shared?.clientDir ?? null,
        log: ctx.log,
        ...extra,
    };
}

async function startRoutePoll(legs, rec, ctx) {
    let stopped = false;
    const sleep = defaultSleep;
    const cap = ctx.timelineCap ?? 4000;
    (async () => {
        while (!stopped) {
            for (const side of ['sender', 'receiver']) {
                const r =
                    legs[side] && legs[side].route ? legs[side].route() : null;
                if (r && rec.timeline.length < cap)
                    rec.timeline.push({ t: Date.now(), side, ...r });
            }
            await sleep(ROUTE_POLL_MS);
        }
    })();
    return { stop: () => (stopped = true) };
}

/** Kill the victim once the receiver's .part passes the threshold. */
function startKillWatch(cell, legs, rec, ctx, outDir) {
    let stopped = false;
    const sleep = defaultSleep;
    const victim = cell.expect === 'kill-sender' ? 'sender' : 'receiver';
    (async () => {
        while (!stopped) {
            const parts = partFiles(outDir);
            const biggest = parts.reduce((m, p) => Math.max(m, p.bytes), 0);
            if (biggest >= cell.killAtBytes) {
                const pid = legPid(legs[victim]);
                try {
                    const r = await ctx.killTree(pid);
                    rec.kill = {
                        victim,
                        pid,
                        atBytes: biggest,
                        result: r,
                        t: Date.now(),
                    };
                    if (ctx.safety) ctx.safety.killedPids.push(pid);
                } catch (e) {
                    rec.kill = {
                        victim,
                        pid,
                        atBytes: biggest,
                        error: e.message,
                        t: Date.now(),
                    };
                    rec.killError = e;
                }
                return;
            }
            await sleep(KILL_POLL_MS);
        }
    })();
    return { stop: () => (stopped = true) };
}

/** Refusal cells: the 3 GiB must never move; stop both legs at the first byte. */
function startByteGuard(legs, rec, ctx, outDir) {
    let stopped = false;
    const sleep = defaultSleep;
    (async () => {
        while (!stopped) {
            const parts = partFiles(outDir);
            const moved =
                parts.reduce((m, p) => m + p.bytes, 0) +
                (typeof legs.receiver?.bytesMoved === 'function'
                    ? legs.receiver.bytesMoved()
                    : 0);
            if (moved > 0) {
                rec.bytesMoved = moved;
                rec.guardTripped = true;
                for (const l of Object.values(legs)) {
                    try {
                        await l.stop('refusal-guard');
                    } catch {
                        // Best effort; verify reports the guard trip anyway.
                    }
                }
                return;
            }
            await sleep(KILL_POLL_MS);
        }
    })();
    return { stop: () => (stopped = true) };
}

/**
 * How many floe:bytes-reported events a receiver's evidence carries.
 * lib/web.mjs carries a LIST of events and the fixture adapters carry a
 * count, and `Number([{...}])` is NaN with `NaN > 0` false, so coercing the
 * list silently disarmed the browser opt-out gate and printed NaN in the
 * Safety table.
 */
export function bytesReportedCount(raw) {
    if (Array.isArray(raw)) return raw.length;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function statsProofCheck(cell, ev, rec, ctx) {
    const proof = ev?.statsProof || null;
    const surface = cell.receiver.surface;
    const events = bytesReportedCount(
        ev?.bytesReportedEvents ?? proof?.bytesReportedEvents ?? 0
    );
    if (events > 0)
        throw new SafetyError(
            'floe:bytes-reported fired on an opted-out receiver',
            { cellId: cell.id }
        );
    const out = {
        surface,
        proof: {
            browserAttempts: null,
            bytesReportedEvents: null,
            localStorage: null,
            argvNoReport: null,
            envNoStats: null,
            desktopJson: null,
            localTotalBefore: rec.statsBefore ?? null,
            localTotalAfter: rec.statsAfter ?? null,
        },
    };
    if (surface === 'web') {
        out.proof.browserAttempts = Number(proof?.attempts ?? 0);
        out.proof.bytesReportedEvents = events;
        // lib/web.mjs reports the value read back from the page as
        // localStorageRead; the fixture adapters use the short name.
        out.proof.localStorage =
            proof?.localStorage ?? proof?.localStorageRead ?? null;
        if (ctx.safety) {
            ctx.safety.statsReportAttempts += out.proof.browserAttempts;
            ctx.safety.bytesReportedEvents += events;
        }
        if (out.proof.browserAttempts > 0)
            throw new PhaseError(
                'verify',
                'stats-attempt: the opted-out browser receiver tried to report',
                { signatureKey: 'stats-attempt' }
            );
        // web.mjs computes the same verdict as statsProof.breach; consume it
        // rather than re-deriving a weaker one, and fail closed when the key
        // was never read back (an unproven opt-out is not a proven one).
        if (proof?.breach)
            throw new PhaseError(
                'verify',
                'stats-attempt: the browser receiver reported its opt-out as breached',
                { signatureKey: 'stats-attempt' }
            );
        if (out.proof.localStorage !== 'false')
            throw new PhaseError(
                'verify',
                `stats-attempt: localStorage floe:report-stats is ${JSON.stringify(out.proof.localStorage)}, not "false"`,
                { signatureKey: 'stats-attempt' }
            );
    } else if (surface === 'cli' || surface === 'wsl') {
        out.proof.argvNoReport = Boolean(proof?.noReport);
        out.proof.envNoStats = proof?.floeNoStats === '1';
        if (ctx.safety) {
            ctx.safety.cliReceiversOptedOut.total += 1;
            if (out.proof.argvNoReport && out.proof.envNoStats)
                ctx.safety.cliReceiversOptedOut.ok += 1;
        }
        if (!(out.proof.argvNoReport && out.proof.envNoStats))
            throw new PhaseError(
                'verify',
                'stats-proof-missing: CLI receiver lacks --no-report or FLOE_NO_STATS=1',
                { signatureKey: 'stats-attempt' }
            );
    } else if (surface === 'desktop') {
        out.proof.desktopJson = proof
            ? {
                  reportStats: proof.reportStats,
                  migrated: proof.migrated,
                  sha256Before: proof.sha256Before ?? null,
                  sha256After: proof.sha256After ?? null,
              }
            : null;
        const ok =
            proof && proof.reportStats === false && proof.migrated === true;
        if (ctx.safety) {
            ctx.safety.desktopReceiversOptedOut.total += 1;
            if (ok) ctx.safety.desktopReceiversOptedOut.ok += 1;
            if (proof && proof.restoredIdentical === false)
                ctx.safety.desktopReceiversOptedOut.configRestoredIdentical = false;
        }
        if (!ok)
            throw new PhaseError(
                'verify',
                'stats-proof-missing: desktop config lacks reportStats:false and migrated:true',
                { signatureKey: 'stats-attempt' }
            );
    }
    return out;
}

/** Safety-section counters that only exist after teardown. */
function recordSafety(cell, rec, ctx) {
    const s = ctx.safety;
    if (!s) return;
    const caps = [
        ...(rec.evidence.sender?.captures || []),
        ...(rec.evidence.receiver?.captures || []),
    ];
    if (s.captures) s.captures.count += caps.length;
    for (const side of ['sender', 'receiver']) {
        const ev = rec.evidence[side];
        if (!ev || ev.surface !== 'desktop') continue;
        // The Store-mode config guard reports its restore on both roles.
        if (ev.config && ev.config.applied && ev.config.match === false)
            s.desktopReceiversOptedOut.configRestoredIdentical = false;
        if (side === 'receiver' && ev.saveDir && ev.saveDir.changed) {
            const ok = ev.saveDir.restored === true;
            s.saveDirRestored = s.saveDirRestored === false ? false : ok;
        }
        // History rows: counted only when the adapter read the History
        // view; otherwise the report says so instead of implying zero.
        if (side === 'receiver') {
            if (typeof ev.historyRowsAdded === 'number')
                s.historyRowsAdded =
                    (typeof s.historyRowsAdded === 'number'
                        ? s.historyRowsAdded
                        : 0) + ev.historyRowsAdded;
            else if (s.historyRowsAdded === null)
                s.historyRowsAdded =
                    'not counted (the History view is not read through UIA)';
        }
    }
}

function completionOf(done, side, ev) {
    const d = done?.[side];
    if (!d) return { text: null, seenAt: null };
    const text =
        d.detail?.text ??
        d.detail?.savedAs ??
        (d.kind === 'transfer' ? 'complete' : (d.detail?.error ?? d.kind));
    return {
        text: text ? String(text) : null,
        seenAt: d.ms ?? null,
        exitCode: d.exitCode ?? null,
        kind: d.kind,
        ok: d.ok,
        // True when the driver wrote this completion instead of observing
        // it, so no reader mistakes it for something the surface reported.
        synthesized: d.detail?.synthesized ?? false,
    };
}

async function receiverOutputs(
    cell,
    legs,
    rec,
    outDir,
    { allowPart = false } = {}
) {
    const leg = legs.receiver;
    if (cell.zipDownload && typeof leg?.downloadZip === 'function') {
        const zipPath = await leg.downloadZip(
            path.join(rec.evidenceDir, 'received.zip')
        );
        rec.zipPath = zipPath;
        return readZip(readFileSync(zipPath));
    }
    if (
        cell.receiver.surface === 'web' &&
        leg &&
        typeof leg.outputs === 'function'
    ) {
        const list = await leg.outputs();
        if (list && list.length) return list;
    }
    if (outDir) {
        try {
            return await walkOutputs(outDir, { allowPart });
        } catch (e) {
            // A stale .part after a clean exit is the product's defect, so
            // it is a FAIL with a signature, never a harness ERROR.
            throw new PhaseError('verify', `stale-part: ${e.message}`, {
                signatureKey: 'stale-part',
            });
        }
    }
    return leg ? leg.outputs() : [];
}

/**
 * Bytes the receiver actually took in during one attempt, for the report's
 * relay-egress figure: the fixture on a completed transfer, what landed on
 * disk (the .part included) on a failed or killed one, and the guard's
 * count on a refusal cell. A designed kill-receiver retry reuses the
 * output dir, so the previous attempt's .part is not counted again.
 */
function bytesMovedOf(cell, rec, fixture, outs) {
    if (cell.expect === 'refusal') return rec.bytesMoved || 0;
    const killFirst =
        (cell.expect === 'kill-sender' || cell.expect === 'kill-receiver') &&
        !rec.designed;
    if (rec.ok && !killFirst) return fixture?.totalBytes ?? 0;
    const onDisk = (outs || [])
        .filter((o) => !(rec.designed && o.part))
        .reduce((a, o) => a + (Number(o.bytes) || 0), 0);
    return Math.max(onDisk, Number(rec.kill?.atBytes) || 0);
}

async function verifyAttempt(cell, ctx, rec, legs, done, fixture, outDir) {
    // Route.
    const forcedLeg = cell.forcedSide ? legs[cell.forcedSide] : null;
    const forcedEv = forcedLeg ? safeEvidence(forcedLeg) : null;
    // lib/web.mjs reports policy { ok, checked, offenders }; the fixture
    // adapters report the flat policyOk. Both mean the same thing.
    const policyOk = forcedEv
        ? (forcedEv.policyOk ?? forcedEv.policy?.ok ?? null)
        : null;
    if (cell.forcer === 'initScript' && policyOk === false)
        throw new PhaseError(
            'verify',
            'init-script-not-applied: a relay-forced browser PC ran without iceTransportPolicy relay',
            { harness: true, reason: 'init-script-not-applied' }
        );
    const pair = classifyPair(
        { sender: rec.route.sender, receiver: rec.route.receiver },
        cell
    );
    rec.routePair = pair;
    if (!pair.ok)
        throw new PhaseError(
            'verify',
            `${pair.reason}: observed ${pair.observed}, expected ${cell.path === 'REL' ? 'relay' : 'direct'} (${pair.label})`,
            { signatureKey: pair.reason }
        );
    if (pair.reason === 'route-unproven') rec.notes.push('route-unproven');

    // Before the shape-specific branches, because a refusal and both kill
    // cells return early: their receivers were silently missing from the
    // Safety attestation's denominators. statsProofCheck reads evidence()
    // only, so it needs no completion oracle.
    rec.stats = statsProofCheck(cell, safeEvidence(legs.receiver), rec, ctx);

    const s = done?.s;
    const r = done?.r;
    if (cell.expect === 'refusal') {
        // Both ways bytes can show up: a staging file for a CLI or desktop
        // receiver, and the browser receiver's own data-channel counter,
        // which is the only witness when the receiver writes nothing to disk.
        const movedNow =
            partFiles(outDir).reduce((m, p) => m + p.bytes, 0) +
            (typeof legs.receiver?.bytesMoved === 'function'
                ? Number(legs.receiver.bytesMoved()) || 0
                : 0);
        if (movedNow > 0) {
            rec.bytesMoved = Math.max(rec.bytesMoved || 0, movedNow);
            rec.guardTripped = true;
        }
        if (rec.guardTripped)
            throw new PhaseError(
                'verify',
                `cap-not-enforced: ${formatBytes(rec.bytesMoved)} moved over the relay before the cap`,
                { signatureKey: 'cap-not-enforced' }
            );
        const refused =
            s &&
            s.kind === 'refusal' &&
            (s.detail?.class === 'relay-cap-refusal' ||
                /relay connections are capped/.test(
                    String(s.detail?.error || '')
                ));
        if (!refused)
            throw new PhaseError(
                'verify',
                `cap-not-enforced: sender ended ${s ? `${s.kind} (${s.detail?.error || s.exitCode})` : 'without a result'} instead of the relay-cap refusal`,
                { signatureKey: 'cap-not-enforced' }
            );
        const outs = await receiverOutputs(cell, legs, rec, outDir, {
            allowPart: true,
        });
        if (outs.some((o) => !o.part && o.bytes > 0))
            throw new PhaseError(
                'verify',
                'cap-not-enforced: the receiver saved a file',
                { signatureKey: 'cap-not-enforced' }
            );
        rec.outputs = outs;
        rec.integrity = { ok: true, files: [] };
        rec.route.evidence = 'refusal';
        return;
    }
    if (cell.expect === 'kill-sender') {
        if (!rec.kill || rec.killError)
            throw new PhaseError(
                'verify',
                `kill-sender: kill did not happen (${rec.kill?.error || 'threshold never reached'})`,
                { signatureKey: 'kill-failed', harness: !rec.kill }
            );
        const err = String(r?.detail?.error || '');
        if (
            r?.ok ||
            !/connection closed mid-transfer|transfer stalled: no data for/.test(
                err
            )
        )
            throw new PhaseError(
                'verify',
                `kill-sender: receiver ended ${r?.kind} (${err || r?.exitCode}) instead of the mid-transfer error`,
                { signatureKey: 'kill-sender-outcome' }
            );
        const outs = await walkOutputs(outDir, { allowPart: true });
        if (outs.some((o) => o.part))
            throw new PhaseError(
                'verify',
                'kill-sender: a .part file survived the receiver cleanup',
                { signatureKey: 'kill-sender-cleanup' }
            );
        if (outs.some((o) => !o.part))
            throw new PhaseError(
                'verify',
                'kill-sender: a final file exists after a mid-transfer kill',
                { signatureKey: 'kill-sender-cleanup' }
            );
        rec.outputs = outs;
        rec.integrity = { ok: true, files: [] };
        return;
    }
    if (cell.expect === 'kill-receiver') {
        if (!rec.designed) {
            if (!rec.kill || rec.killError)
                throw new PhaseError(
                    'verify',
                    `kill-receiver: kill did not happen (${rec.kill?.error || 'threshold never reached'})`,
                    { signatureKey: 'kill-failed', harness: !rec.kill }
                );
            const outs = await walkOutputs(outDir, { allowPart: true });
            const parts = outs.filter((o) => o.part);
            if (parts.length !== 1)
                throw new PhaseError(
                    'verify',
                    `kill-receiver: expected exactly one .part, found ${parts.length}`,
                    { signatureKey: 'kill-receiver-part' }
                );
            if (outs.some((o) => !o.part))
                throw new PhaseError(
                    'verify',
                    'kill-receiver: a final file exists after the receiver was killed',
                    { signatureKey: 'kill-receiver-part' }
                );
            rec.outputs = outs;
            rec.integrity = { ok: true, files: [] };
            return;
        }
        // The designed retry is a plain transfer into the dir the first
        // attempt left its .part in: both legs must end ok, and exactly
        // that one .part may remain (matrix.md: "one .part; the second
        // attempt into the same dir lands name (1).bin").
        for (const [side, d] of [
            ['receiver', r],
            ['sender', s],
        ]) {
            if (!d || !d.ok || d.kind !== 'transfer')
                throw new PhaseError(
                    'done',
                    String(
                        d?.detail?.error ||
                            d?.detail?.tail ||
                            `${side} ended ${d?.kind ?? 'without a result'} exit ${d?.exitCode ?? '?'}`
                    ),
                    { side }
                );
        }
        const outs = await walkOutputs(outDir, { allowPart: true });
        const parts = outs.filter((o) => o.part);
        if (parts.length !== 1)
            throw new PhaseError(
                'verify',
                `kill-receiver: expected exactly one .part after the retry, found ${parts.length}`,
                { signatureKey: 'kill-receiver-part' }
            );
        const ext = path.extname(fixture.files[0].name);
        const alt = `${fixture.files[0].name.slice(0, fixture.files[0].name.length - ext.length)} (1)${ext}`;
        const cmp = compareOutputs(
            fixture.files,
            outs.filter((o) => !o.part),
            { nameMap: () => alt }
        );
        rec.outputs = outs;
        rec.integrity = {
            ok: cmp.ok,
            files: cmp.files,
            missing: cmp.missing,
            extra: cmp.extra,
            mismatched: cmp.mismatched,
        };
        if (!outs.some((o) => o.name === alt))
            throw new PhaseError(
                'verify',
                `kill-receiver: retry did not land ${alt}`,
                { signatureKey: 'kill-receiver-retry' }
            );
        if (cmp.mismatched.length)
            throw new PhaseError('verify', `hash-mismatch: ${alt}`, {
                signatureKey: 'hash-mismatch',
            });
        return;
    }

    // Plain transfer.
    for (const [side, d] of [
        ['receiver', r],
        ['sender', s],
    ]) {
        if (!d || !d.ok || d.kind !== 'transfer') {
            const text =
                d?.detail?.error ||
                d?.detail?.tail ||
                `${side} ended ${d?.kind ?? 'without a result'} exit ${d?.exitCode ?? '?'}`;
            throw new PhaseError('done', String(text), { side });
        }
    }
    const outs = await receiverOutputs(cell, legs, rec, outDir);
    const cmp = compareOutputs(fixture.files, outs);
    rec.outputs = outs;
    rec.integrity = {
        ok: cmp.ok,
        files: cmp.files,
        missing: cmp.missing,
        extra: cmp.extra,
        mismatched: cmp.mismatched,
    };
    if (cmp.mismatched.length)
        throw new PhaseError(
            'verify',
            `hash-mismatch: ${cmp.mismatched.map((m) => m.rel).join(', ')}`,
            { signatureKey: 'hash-mismatch' }
        );
    if (cmp.missing.length)
        throw new PhaseError(
            'verify',
            `missing-file: ${cmp.missing.join(', ')}`,
            { signatureKey: 'missing-file' }
        );
    if (cmp.extra.length)
        rec.notes.push(`extra files: ${cmp.extra.join(', ')}`);
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
    const ms = Math.max(r.ms || 0, s.ms || 0);
    rec.metrics = {
        throughputMBps:
            ms > 0
                ? Number((fixture.totalBytes / 1e6 / (ms / 1000)).toFixed(1))
                : null,
    };
}

export async function runAttempt(
    cell,
    ctx,
    n,
    { reuse = null, designed = false } = {}
) {
    const sleep = ctx.sleep || defaultSleep;
    const T = cell.timeouts;
    const rec = {
        n,
        designed,
        startedAt: new Date().toISOString(),
        endedAt: null,
        phases: {},
        phaseList: [],
        outcome: 'fail',
        ok: false,
        signature: null,
        signatureKey: null,
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
    };
    const legs = {};
    let current = 'setup';
    const phase = async (name, ms, fn) => {
        current = name;
        const t = Date.now();
        try {
            const v = await withTimeout(Promise.resolve().then(fn), ms, name);
            rec.phases[name] = Date.now() - t;
            rec.phaseList.push({ name, ms: Date.now() - t, ok: true });
            return v;
        } catch (e) {
            rec.phases[name] = Date.now() - t;
            rec.phaseList.push({
                name,
                ms: Date.now() - t,
                ok: false,
                error: e.message,
            });
            if (!e.phase) e.phase = name;
            throw e;
        }
    };
    let poll = null;
    let fixture = null;
    let outDir = null;
    let done = null;
    try {
        await phase('setup', T.verify, async () => {
            rec.evidenceDir = path.join(
                ctx.evidenceRoot,
                'cells',
                cell.id,
                `attempt-${n}`
            );
            mkdirSync(rec.evidenceDir, { recursive: true });
            fixture = reuse
                ? reuse.fixture
                : await ensureFixture(
                      cell.fixture,
                      path.join(ctx.fixturesDir, cell.id, `a${n}`)
                  );
            rec.fixture = fixture;
            outDir = reuse ? reuse.outDir : path.join(rec.evidenceDir, 'out');
            mkdirSync(outDir, { recursive: true });
            rec.outDir = outDir;
            if (ctx.statsOracle) rec.statsBefore = await ctx.statsOracle.read();
            await ctx.ledger.waitFor(cell.cost, { sleep, log: ctx.log });
            rec.ledgerEventsBefore = ctx.ledger.events.length;
        });
        await phase('sender.start', T.link + 5_000, async () => {
            const mod = await ctx.getAdapter(cell.sender.surface);
            legs.sender = mod.createLeg(
                legOpts(cell, 'sender', ctx, rec, {
                    files: fixture.paths,
                    evidenceDir: path.join(rec.evidenceDir, 'sender'),
                })
            );
            await legs.sender.start();
            rec.room.link = await legs.sender.link();
            rec.room.code = await legs.sender.code();
            if (ctx.onPid)
                for (const l of Object.values(legs))
                    ctx.onPid(legPid(l), `${cell.id}:sender`);
        });
        await phase('receiver.start', T.join, async () => {
            const input = cell.receiver.input;
            const target = input === 'code' ? rec.room.code : rec.room.link;
            if (!target) {
                // A sender that printed no code registered none: main.go
                // warns "could not generate short code" on a 429 or 503
                // from POST /api/code and prints the Link row alone. That
                // is the code limiter, a product symptom with a retry,
                // not a harness fault.
                const warn = safeEvidence(legs.sender)?.events?.find(
                    (e) => e && e.name === 'codeWarning'
                )?.line;
                throw new PhaseError(
                    'receiver.start',
                    `code-registration-failed: sender emits no ${input}${warn ? ` (${String(warn).trim()})` : ''}`,
                    { signatureKey: 'code-registration-failed' }
                );
            }
            const mod = await ctx.getAdapter(cell.receiver.surface);
            legs.receiver = mod.createLeg(
                legOpts(cell, 'receiver', ctx, rec, {
                    target,
                    input,
                    code: rec.room.code,
                    link: rec.room.link,
                    outDir,
                    statsOff: true,
                    evidenceDir: path.join(rec.evidenceDir, 'receiver'),
                    zipDownload: Boolean(cell.zipDownload),
                    // The browser receiver's completion predicate waits for
                    // "N files received" and N a[download]; without the
                    // count it settles after the first file of a batch.
                    expectFiles: fixture.files.length,
                })
            );
            await legs.receiver.start();
            if (ctx.onPid)
                ctx.onPid(legPid(legs.receiver), `${cell.id}:receiver`);
        });
        await phase('connect', T.connect, () =>
            Promise.all([
                legs.sender.awaitConnected(T.connect),
                legs.receiver.awaitConnected(T.connect),
            ])
        );
        rec.connectedAt = Date.now();
        poll = await startRoutePoll(legs, rec, ctx);
        await phase('route', T.route + 2_000, async () => {
            // Both sides wait in parallel: two legs without an oracle (CLI
            // to CLI, no pion trace) each run out the clock, and the phase
            // budget is one route timeout, not two.
            [rec.route.sender, rec.route.receiver] = await Promise.all([
                legs.sender.awaitRoute(T.route),
                legs.receiver.awaitRoute(T.route),
            ]);
        });
        done = await phase(
            'done',
            T.firstBytes + T.complete + T.exit,
            async () => {
                let guard = null;
                if (cell.expect === 'refusal')
                    guard = startByteGuard(legs, rec, ctx, outDir);
                else if (
                    cell.expect === 'kill-sender' ||
                    (cell.expect === 'kill-receiver' && !designed)
                )
                    guard = startKillWatch(cell, legs, rec, ctx, outDir);
                const budget = T.firstBytes + T.complete + T.exit;
                try {
                    if (cell.expect === 'refusal') {
                        // The relay gate is sender-side, so the sender's exit
                        // is the verdict (measured 2026-08-29: the CLI refused
                        // at 3.9 s while the browser receiver ran the whole
                        // 75 s done budget out). A receiver with no refusal
                        // oracle of its own (a browser or the desktop only
                        // sees the peer leave and the pill fall back to Ready)
                        // is synthesized; a CLI receiver still reports its own
                        // peer-refused exit, within the exit budget. A tripped
                        // byte guard already stopped both legs, so awaiting
                        // either would only turn the cap failure into a
                        // timeout: verify throws cap-not-enforced instead.
                        const t0 = Date.now();
                        const s = await legs.sender.awaitDone(budget);
                        const left = Math.max(1000, budget - (Date.now() - t0));
                        const noOracle =
                            cell.receiver.surface === 'web' ||
                            cell.receiver.surface === 'desktop';
                        let r = null;
                        if (!rec.guardTripped) {
                            if (s && s.kind === 'refusal' && noOracle)
                                r = {
                                    ok: true,
                                    kind: 'refusal',
                                    detail: {
                                        side: 'peer',
                                        synthesized: true,
                                        text: 'peer refused (synthesized: this surface has no refusal oracle)',
                                    },
                                    exitCode: null,
                                    ms: null,
                                };
                            else
                                try {
                                    r = await legs.receiver.awaitDone(
                                        s && s.kind === 'refusal'
                                            ? Math.min(left, T.exit)
                                            : left
                                    );
                                } catch (err) {
                                    // Never swallow a safety breach into a
                                    // product failure.
                                    if (
                                        err instanceof SafetyError ||
                                        err.safety ||
                                        !rec.guardTripped
                                    )
                                        throw err;
                                    rec.notes.push(
                                        `receiver awaitDone after the byte guard: ${err.message}`
                                    );
                                }
                        }
                        return { s, r };
                    }
                    const [s, r] = await Promise.all([
                        legs.sender.awaitDone(budget),
                        legs.receiver.awaitDone(budget),
                    ]);
                    return { s, r };
                } finally {
                    if (guard) guard.stop();
                }
            }
        );
        poll.stop();
        poll = null;
        rec.senderExit = done.s?.exitCode ?? null;
        rec.receiverExit = done.r?.exitCode ?? null;
        rec.completion = {
            sender: completionOf(done, 's'),
            receiver: completionOf(done, 'r'),
        };
        await phase('verify', T.verify, () =>
            verifyAttempt(cell, ctx, rec, legs, done, fixture, outDir)
        );
        rec.ok = true;
        rec.outcome = 'pass';
    } catch (e) {
        rec.ok = false;
        rec.outcome = 'fail';
        rec.error = describeError(e);
        rec.failedPhase = e.phase || current;
        rec.safety = e instanceof SafetyError || Boolean(e.safety);
        if (rec.failedPhase === 'done' && !done && !rec.safety)
            await recordDoneTimeout(cell, legs, rec, outDir);
        rec.harness =
            Boolean(e.harness) || (!(e instanceof PhaseError) && !rec.safety);
        if (
            e.reason === 'uia-setvalue' ||
            /uia-setvalue|Please enter a code or link/.test(e.message || '')
        ) {
            rec.harness = false;
            rec.skipReason = 'uia-setvalue';
        } else if (e.verdict === 'SKIP' && e.reason) {
            // An adapter that names a run-time precondition (desktop-savedir,
            // present) turns the attempt into SKIP <reason>, never FAIL.
            rec.harness = false;
            rec.skipReason = e.reason;
        }
        // The message first: its first line becomes the report's note, so
        // a keyed error still reads "hash-mismatch: a.bin" or quotes the
        // CLI warning behind a code-registration-failed. The key itself is
        // still in the text for the classifier.
        const evText = [
            e.message,
            e.signatureKey,
            // Only before connect: a refused TURN fetch can keep a
            // relay-forced page from ever connecting, but it explains
            // nothing about a transfer that already started.
            ...(rec.connectedAt
                ? []
                : turnFetchHints(legs, { forcedOnly: true })),
            legs.receiver && safeEvidence(legs.receiver)?.exit?.error,
            '',
        ]
            .filter(Boolean)
            .join('\n');
        for (const line of [...turnFetchHints(legs), ...candidateNotes(legs)])
            rec.notes.push(line);
        const turnHeavy = ctx.ledger ? ctx.ledger.inWindow().turn >= 16 : false;
        rec.signature = classifySignature(evText, {
            relay: cell.path === 'REL',
            turnHeavy,
        });
        if (e.signatureKey) {
            // A keyed PhaseError names the whole signature, not just its key:
            // taking the key alone left retryable and triage from whatever
            // else the text happened to match (a missing-file verify failure
            // inheriting a retry from an unrelated hint, for instance).
            const row = SIGNATURES.find(([k]) => k === e.signatureKey);
            const retry = row ? row[2] : false;
            rec.signature = {
                key: e.signatureKey,
                retryable:
                    retry === 'rel'
                        ? cell.path === 'REL' && turnHeavy
                        : Boolean(retry),
                triage: row ? row[3] : null,
                text: rec.signature.text,
            };
        }
        if (cell.expect === 'refusal' && rec.guardTripped) {
            // Bytes crossed the relay before the gate. However the done
            // phase ended, that is the finding.
            rec.harness = false;
            rec.signature = {
                key: 'cap-not-enforced',
                retryable: false,
                triage: 'cap-not-enforced',
                text: `cap-not-enforced: ${formatBytes(rec.bytesMoved || 0)} moved over the relay before the cap (${rec.signature.text})`,
            };
        }
        rec.signatureKey = rec.signature.key;
        if (rec.safety) rec.safetyError = e;
    } finally {
        if (poll) poll.stop();
        try {
            await phase('teardown', T.teardown, async () => {
                for (const side of ['sender', 'receiver']) {
                    const l = legs[side];
                    if (!l) continue;
                    try {
                        await l.stop(rec.ok ? 'done' : 'failed');
                    } catch (e) {
                        rec.notes.push(`stop ${side}: ${e.message}`);
                        if (e instanceof SafetyError || e.safety) {
                            // A desktop.json restore mismatch surfaces here,
                            // after the transfer; it still trips exit 4.
                            rec.ok = false;
                            rec.outcome = 'fail';
                            rec.safety = true;
                            rec.safetyError = e;
                            rec.error = rec.error || describeError(e);
                            rec.failedPhase = rec.failedPhase || 'teardown';
                        }
                    }
                    rec.evidence[side] = safeEvidence(l);
                }
                recordSafety(cell, rec, ctx);
                if (
                    ctx.ledger &&
                    ctx.infra?.name === 'prod' &&
                    ctx.ledger.events.length ===
                        (rec.ledgerEventsBefore ?? 0) &&
                    rec.phases['sender.start'] !== undefined
                ) {
                    ctx.ledger.commit(cell.cost);
                    rec.notes.push(
                        'ledger: adapters did not spend, charged the cell cost'
                    );
                }
            });
        } catch (e) {
            rec.notes.push(`teardown: ${e.message}`);
        }
        rec.endedAt = new Date().toISOString();
        try {
            let outs = rec.outputs;
            if (!Array.isArray(outs) && outDir)
                outs = await walkOutputs(outDir, { allowPart: true });
            rec.bytesMoved = bytesMovedOf(cell, rec, fixture, outs);
        } catch (e) {
            rec.notes.push(`bytes moved: outputs unreadable: ${e.message}`);
            rec.bytesMoved = rec.bytesMoved || 0;
        }
        rec.evidence.captures = [
            ...(rec.evidence.sender?.captures || []),
            ...(rec.evidence.receiver?.captures || []),
        ];
        try {
            if (rec.evidenceDir) {
                writeFileSync(
                    path.join(rec.evidenceDir, 'route.json'),
                    JSON.stringify(
                        {
                            route: rec.route,
                            pair: rec.routePair ?? null,
                            timeline: rec.timeline,
                        },
                        null,
                        4
                    )
                );
                writeFileSync(
                    path.join(rec.evidenceDir, 'outputs.json'),
                    JSON.stringify(rec.outputs ?? [], null, 4)
                );
                const { safetyError, ...plain } = rec;
                writeFileSync(
                    path.join(rec.evidenceDir, 'attempt.json'),
                    JSON.stringify(plain, null, 4)
                );
            }
        } catch (e) {
            rec.notes.push(`evidence write: ${e.message}`);
        }
    }
    return rec;
}

function baseResult(cell, ctx) {
    const build = (surface, role) =>
        ctx.buildFor ? ctx.buildFor(surface, role) : null;
    const sb = build(cell.sender.surface, 'sender');
    const rb = build(cell.receiver.surface, 'receiver');
    return {
        id: cell.id,
        profile: cell.profile === 'H' ? 'head' : 'shipped',
        path: cell.path,
        variant: cell.variant,
        sender: {
            surface: cell.sender.letter,
            build: sb?.kind ?? null,
            version: sb?.version ?? null,
            forcer: cell.sender.forcer,
            noRelay: cell.sender.noRelay,
            argv: null,
            env: null,
        },
        receiver: {
            surface: cell.receiver.letter,
            build: rb?.kind ?? null,
            version: rb?.version ?? null,
            forcer: cell.receiver.forcer,
            noRelay: cell.receiver.noRelay,
            input: cell.receiver.input,
            argv: null,
            env: null,
            outputDir: null,
        },
        rcvBuild: rb
            ? `${cell.receiver.surface} ${rb.version ?? '?'}${rb.launch ? ` ${rb.launch}` : ''}`
            : cell.receiver.surface,
        fixture: {
            kind: cell.fixture.kind,
            files: [],
            totalBytes: cell.fixture.totalBytes ?? 0,
        },
        verdict: null,
        reason: null,
        triage: null,
        note: null,
        attempts: [],
        route: {
            expected: cell.path === 'REL' ? 'relay' : 'direct',
            observed: 'unobserved',
            label: '-',
            sources: [],
        },
        integrity: { ok: null, files: [] },
        completion: { sender: null, receiver: null },
        stats: { surface: cell.receiver.letter, proof: null },
        metrics: { throughputMBps: null },
        durationS: 0,
        infraSymptom: false,
        countsForExit: true,
    };
}

function fill(result, rec, cell) {
    if (!rec) return;
    if (rec.fixture)
        result.fixture.files = rec.fixture.files.map((f) => ({
            name: f.name,
            size: f.bytes,
            sha256: f.sha256,
        }));
    if (rec.routePair) {
        result.route.observed = rec.routePair.observed;
        result.route.label = rec.routePair.label;
        result.route.sources = rec.routePair.sources;
    } else if (rec.route?.sender || rec.route?.receiver) {
        const pair = classifyPair(rec.route, cell);
        result.route.observed = pair.observed;
        result.route.label = pair.label;
        result.route.sources = pair.sources;
    }
    if (rec.route?.evidence === 'refusal')
        result.route.label = 'relay [refusal]';
    if (rec.integrity) result.integrity = rec.integrity;
    if (rec.completion) result.completion = rec.completion;
    if (rec.stats) result.stats = rec.stats;
    if (rec.metrics) result.metrics = rec.metrics;
    result.sender.argv = rec.evidence?.sender?.argv ?? null;
    result.sender.env = rec.evidence?.sender?.env ?? null;
    result.receiver.argv = rec.evidence?.receiver?.argv ?? null;
    result.receiver.env = rec.evidence?.receiver?.env ?? null;
    result.receiver.outputDir = rec.outDir ?? null;
}

export function attemptSummary(rec) {
    const { safetyError, fixture, evidence, timeline, ...rest } = rec;
    return {
        ...rest,
        evidence: {
            senderTranscript: evidence?.sender?.transcript ?? null,
            receiverTranscript: evidence?.receiver?.transcript ?? null,
            // lib/desktop.mjs captures are { tag, t, path, w, h }; the
            // report wants paths.
            captures: (evidence?.captures ?? []).map((c) =>
                typeof c === 'string' ? c : (c && c.path) || String(c)
            ),
            browserConsole:
                evidence?.receiver?.console ??
                evidence?.sender?.console ??
                null,
            dir: rec.evidenceDir,
        },
        timelineSamples: timeline ? timeline.length : 0,
    };
}

/**
 * runCell(cell, ctx) -> CellResult. ctx: { getAdapter, ledger, infra,
 *   buildFor(surface, role), evidenceRoot, fixturesDir, log, safety,
 *   retry: { used, cap }, sleep, killTree, statsOracle, pionTrace,
 *   cliHasRelayOnly, userAway, pauseMaxMin, shared, onPid }
 */
export async function runCell(cell, ctx) {
    const t0 = Date.now();
    const result = baseResult(cell, ctx);
    if (cell.verdict) {
        result.verdict = cell.verdict;
        result.reason = cell.reason;
        result.note = cell.note;
        result.countsForExit =
            cell.verdict !== 'NA' && cell.reason !== 'filtered';
        return result;
    }
    assertStatsOff(cell);
    const sleep = ctx.sleep || defaultSleep;
    ctx.retry = ctx.retry || { used: 0, cap: RETRY_CAP };
    const attempts = [];
    const finish = (verdict, reason, triage, note, last) => {
        result.verdict = verdict;
        result.reason = reason;
        result.triage = triage;
        result.note = note;
        result.attempts = attempts.map(attemptSummary);
        fill(result, last, cell);
        result.durationS = Number(((Date.now() - t0) / 1000).toFixed(1));
        result.penalized = attempts.some((a) => a.penalized === true);
        result.infraSymptom = Boolean(
            last?.signature && INFRA_KEYS.has(last.signature.key)
        );
        if (verdict === 'FLAKY') {
            const first = attempts[0];
            result.infraSymptom = Boolean(
                first?.signature && INFRA_KEYS.has(first.signature.key)
            );
        }
        return result;
    };
    const failureOf = (a) => {
        if (a.safety)
            throw (
                a.safetyError ||
                new SafetyError(a.error?.message || 'safety invariant tripped')
            );
        if (a.skipReason)
            return [
                'SKIP',
                a.skipReason,
                'uia-setvalue',
                a.error?.message || a.skipReason,
            ];
        if (a.harness)
            return [
                'ERROR',
                a.error?.reason || 'harness',
                a.error?.reason || null,
                `${a.failedPhase}: ${a.error?.message}`,
            ];
        const sig = a.signature || classifySignature('');
        const facts = a.doneTimeout ? `; ${a.doneTimeout.summary}` : '';
        return [
            'FAIL',
            sig.key,
            sig.triage,
            `${a.failedPhase}: ${sig.text || a.error?.message || sig.key}${facts}`,
        ];
    };

    const a = await runAttempt(cell, ctx, 1);
    attempts.push(a);
    if (cell.expect === 'kill-receiver') {
        if (!a.ok) return finish(...failureOf(a), a);
        const b = await runAttempt(cell, ctx, 2, { reuse: a, designed: true });
        attempts.push(b);
        if (b.ok)
            return finish(
                'PASS',
                null,
                null,
                'kill at 50 MiB, retry landed (1)',
                b
            );
        return finish(...failureOf(b), b);
    }
    if (a.ok) return finish('PASS', null, null, routeNoteOf(a), a);
    if (a.safety) failureOf(a);
    const [verdict, key, triage, note] = failureOf(a);
    if (verdict !== 'FAIL') return finish(verdict, key, triage, note, a);
    const sig = a.signature;
    if (!cell.retryable || !sig.retryable || ctx.retry.used >= ctx.retry.cap)
        return finish(
            'FAIL',
            key,
            triage,
            note +
                (ctx.retry.used >= ctx.retry.cap && sig.retryable
                    ? ' (retry cap reached)'
                    : ''),
            a
        );
    ctx.retry.used += 1;
    if (ctx.ledger) ctx.ledger.retriesUsed = ctx.retry.used;
    if (PENALIZED_KEYS.has(sig.key)) {
        if (ctx.ledger) ctx.ledger.penalize();
        a.penalized = true;
        if (ctx.log)
            ctx.log(
                `${cell.id}: ${sig.key}, waiting ${DRAIN_WAIT_MS / 1000} s for the window to drain before the retry`
            );
        await sleep(ctx.drainWaitMs ?? DRAIN_WAIT_MS);
    } else {
        if (ctx.log)
            ctx.log(
                `${cell.id}: ${sig.key}, retrying once after ${RETRY_WAIT_MS / 1000} s`
            );
        await sleep(ctx.retryWaitMs ?? RETRY_WAIT_MS);
    }
    const b = await runAttempt(cell, ctx, 2);
    attempts.push(b);
    if (b.ok) {
        const unproven = routeNoteOf(b);
        return finish(
            'FLAKY',
            sig.key,
            sig.triage,
            `attempt 1: ${sig.text || sig.key}; attempt 2 passed${unproven ? `; ${unproven}` : ''}`,
            b
        );
    }
    const [v2, k2, t2, n2] = failureOf(b);
    return finish(v2, k2, t2, n2, b);
}

/**
 * A passing DIR cell whose route no side observed (the desktop pill never
 * showed Direct, the browser sampled nothing) still passes: the shipped
 * product offers no stronger direct-path proof. The Note column says so
 * instead of leaving the attempt's `route-unproven` note buried in
 * attempt.json.
 */
export const ROUTE_UNPROVEN_NOTE = 'route-unproven (no route oracle answered)';

function routeNoteOf(rec) {
    return rec?.notes?.includes('route-unproven') ? ROUTE_UNPROVEN_NOTE : null;
}
