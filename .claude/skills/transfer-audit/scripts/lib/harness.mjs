/**
 * The CLI-shaped sender that can lie about a digest: the test-only
 * `floe-e2ehost send` mode (cli/internal/e2ehost/send.go), driven as a leg so a
 * forced-mismatch cell can have a sender the engine will never become.
 *
 * It speaks one JSON event per line on stdout and nothing else, so this adapter
 * waits on event shapes rather than on human text: `link` carries the room link,
 * `channel-open` is the pairing, `route` names the selected path, and
 * `peer-refused` carries the receiver's own refusal code. A run that reaches
 * `peer-refused` with `hash-mismatch` is the success this cell is asking about.
 *
 * Route (D-083): right after `channel-open` the harness prints
 * `{"event":"route","path":"direct"|"relay"}`, taken from the engine's own
 * `peer.Connection.ConnectionType()`. It is the verdict word only, never an
 * address or a candidate type, so a harness cell is judged by two observers like
 * every other direct cell. When the harness could not classify its path it
 * prints no route event, this leg reports `unknown`, and the receiver's oracle
 * decides alone.
 *
 * Nothing in this file ships: the binary it drives is built from
 * cli/internal/e2ehost, which `go list -deps ./cmd/floe` never names.
 */
import { existsSync } from 'node:fs';

import { Leg, PhaseError, sleep } from './surfaces.mjs';
import { killTree, spawnFloe } from './proc.mjs';
import { buildEnv } from './cli.mjs';

export const LINK_EVENT_RE = /"event"\s*:\s*"link"/;
export const OPEN_EVENT_RE = /"event"\s*:\s*"channel-open"/;
export const ROUTE_EVENT_RE = /"event"\s*:\s*"route"/;
export const REFUSED_EVENT_RE = /"event"\s*:\s*"peer-refused"/;
export const DONE_EVENT_RE = /"event"\s*:\s*"done"/;
export const ERROR_EVENT_RE = /"event"\s*:\s*"error"/;

// The route event follows channel-open in the same goroutine with nothing in
// between but one selected-pair read, so a harness that has not printed it this
// long after the pairing never will.
export const ROUTE_GRACE_MS = 5_000;

// The codes the harness passes through from a refusal frame (send.go
// refusalCode); `none` and `closed` mean no refusal frame arrived at all.
const REFUSAL_CODES = new Set(['hash-mismatch', 'write-failed', 'other']);

/** The last JSON object on stdout whose event matches, or null. */
export function lastEvent(stdout, name) {
    let found = null;
    for (const line of String(stdout).split(/\r?\n/)) {
        const text = line.trim();
        if (!text.startsWith('{') || !text.includes(`"${name}"`)) continue;
        try {
            const obj = JSON.parse(text);
            if (obj && obj.event === name) found = obj;
        } catch {
            // A partial line while the process is still writing.
        }
    }
    return found;
}

/** The flag that makes the harness lie, or null for a run that tells the truth. */
export function lieFlag(hashLie) {
    if (hashLie === 'corrupt') return '-corrupt-hash';
    if (hashLie === 'malformed') return '-malformed-hash';
    return null;
}

/**
 * Pure. The route sample for a harness stdout: the last `route` event's word
 * when it is one of the two the harness may print, else null.
 */
export function routeFromEvents(stdout, t = null) {
    const ev = lastEvent(stdout, 'route');
    const word = ev && (ev.path === 'direct' || ev.path === 'relay') ? ev.path : null;
    if (!word) return null;
    return {
        t: t ?? Date.now(),
        source: 'harness-connection-type',
        local: null,
        remote: null,
        verdict: word,
    };
}

/**
 * Pure. What the sender's end looks like from its last events: a refusal the
 * peer sent, no refusal at all (the peer kept the file or just left), or an
 * error stage of the harness's own.
 */
export function outcomeFromEvents(stdout) {
    const refused = lastEvent(stdout, 'peer-refused');
    if (refused) {
        const code = refused.code || 'other';
        if (REFUSAL_CODES.has(code))
            return {
                ok: true,
                kind: 'refusal',
                detail: { class: 'peer-refused', code },
            };
        return { ok: true, kind: 'transfer', detail: { class: 'no-refusal', code } };
    }
    if (lastEvent(stdout, 'done'))
        return { ok: true, kind: 'transfer', detail: {} };
    const failed = lastEvent(stdout, 'error');
    return {
        ok: false,
        kind: 'error',
        detail: { stage: (failed && failed.stage) || 'unknown' },
    };
}

export class HarnessLeg extends Leg {
    constructor(opts) {
        super(opts);
        this.surface = 'harness';
        this.bin = opts.bin ?? opts.harnessBin ?? null;
        this.label = opts.label ?? 'e2ehost-send';
        this.marks = {};
        this._link = null;
        this.h = null;
    }

    /** ms left until opts.deadlineAt, capped at ms, never below 1 s (CliLeg's rule). */
    budget(ms) {
        const { deadlineAt } = this.opts;
        if (!deadlineAt) return ms;
        return Math.max(1000, Math.min(ms, deadlineAt - Date.now()));
    }

    argv() {
        const { opts } = this;
        const infra = opts.infra || {};
        const server = infra.server ?? opts.server;
        const web = infra.web ?? opts.web;
        if (!server)
            throw new PhaseError('start', 'harness sender: infra.server is required');
        const args = ['send', '-server', server];
        if (web) args.push('-web', web);
        if (opts.room) args.push('-room', opts.room);
        const flag = lieFlag(opts.hashLie);
        if (flag) args.push(flag);
        return [...args, ...(opts.files || [])];
    }

    /**
     * The inherited environment with the CLI leg's scrubbing (no PION_LOG_*, no
     * FLOE_SERVER, FLOE_WEB or FLOE_NO_STATS from the auditor's shell), then the
     * opt-outs. The harness is a receiver's peer and reports nothing, but it says
     * so anyway.
     */
    env() {
        const { opts } = this;
        return {
            ...buildEnv(opts, opts.baseEnv ?? process.env),
            ...(opts.env || {}),
            FLOE_NO_STATS: '1',
            FLOE_NO_UPDATE_CHECK: '1',
        };
    }

    async start() {
        const { opts } = this;
        if (!this.bin)
            throw new PhaseError('spawn', 'harness sender: bin is required');
        if (!opts.files || !opts.files.length)
            throw new PhaseError('spawn', 'harness sender: files are required');
        const args = this.argv();
        // send.go runSend fetches TURN and opens /ws, like the CLI sender.
        for (const kind of ['turn', 'conn'])
            if (opts.ledger && typeof opts.ledger.spend === 'function')
                opts.ledger.spend(kind);
        this.h = spawnFloe({
            bin: this.bin,
            args,
            env: this.env(),
            cwd: opts.cwd,
            label: this.label,
            evidenceDir: opts.evidenceDir,
            stallMs: opts.stallMs,
        });
        const hit = await this.h.waitLine(
            LINK_EVENT_RE,
            this.budget(opts.startTimeoutMs ?? 30_000)
        );
        this.marks.link = hit.t;
        const ev = lastEvent(this.h.stdout, 'link');
        this._link = (ev && ev.link) || null;
        if (!this._link)
            throw new PhaseError('start', 'harness sender: no link in the link event');
        return this;
    }

    async code() {
        // The harness prints a link and never registers a code.
        return null;
    }

    async link() {
        return this._link;
    }

    async awaitConnected(timeoutMs) {
        const hit = await this.h.waitLine(OPEN_EVENT_RE, this.budget(timeoutMs));
        this.marks.connected = hit.t;
        return { at: hit.t };
    }

    route() {
        try {
            if (!this.h) return null;
            return routeFromEvents(this.h.stdout, this.marks.connected ?? null);
        } catch {
            return null;
        }
    }

    /**
     * The route event lands right after the pairing or never, so this waits
     * ROUTE_GRACE_MS at most rather than the cell's whole route timeout, and
     * answers `unknown` (the receiver then decides alone) when it never came.
     */
    async awaitRoute(timeoutMs) {
        const until = Date.now() + Math.min(timeoutMs, ROUTE_GRACE_MS);
        for (;;) {
            const r = this.route();
            if (r) return r;
            if (Date.now() >= until || (this.h && this.h.exit))
                return { t: Date.now(), source: 'none', verdict: 'unknown' };
            await sleep(100);
        }
    }

    async awaitDone(timeoutMs) {
        const exit = await this.h.waitExit(this.budget(timeoutMs));
        if (!exit)
            throw new PhaseError(
                'done',
                `harness sender: still running after ${timeoutMs} ms (silent for ${this.h.stalledFor()} ms)`,
                { stalledMs: this.h.stalledFor() }
            );
        return {
            ...outcomeFromEvents(this.h.stdout),
            ms: exit.t - this.h.t0,
            exitCode: exit.code,
        };
    }

    async outputs() {
        // A sender writes nothing.
        return [];
    }

    async stop(reason) {
        await super.stop(reason);
        const h = this.h;
        if (!h || h.exit || !h.pid) return { exit: h?.exit ?? null };
        const result = killTree(h.pid);
        this.notes.push(`killTree pid ${h.pid}: ${JSON.stringify(result)}`);
        await h.waitExit(5000);
        return { exit: h.exit ?? null };
    }

    evidence() {
        return {
            argv: this.h?.argv ?? null,
            pid: this.h?.pid ?? null,
            exit: this.h?.exit ?? null,
            // Events only: the harness prints no name, no size and no address.
            events: String(this.h?.stdout || '')
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.startsWith('{')),
            // A sender never reports; the receiver's proof is the one checked.
            statsProof: null,
            notes: this.notes,
        };
    }
}

export function createLeg(opts) {
    return new HarnessLeg(opts);
}

/**
 * { ok, reason, detail } like every other surface adapter. The harness is built
 * from the repository, never downloaded and never shipped, so its absence is a
 * precondition to report (build it with `go build ./internal/e2ehost` in
 * `cli/`) rather than something to discover halfway through a cell.
 */
export async function preflight(opts = {}) {
    const bin = opts.harnessBin || opts.bin || null;
    if (!bin)
        return {
            ok: false,
            reason: 'no harness binary path given (build ./internal/e2ehost and pass it as harnessBin)',
            detail: { bin: null },
        };
    if (!existsSync(bin))
        return {
            ok: false,
            reason: `harness binary missing at ${bin}: build it with go build ./internal/e2ehost in cli/`,
            detail: { bin },
        };
    return { ok: true, reason: null, detail: { bin } };
}
