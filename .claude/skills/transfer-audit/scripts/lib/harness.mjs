/**
 * The CLI-shaped sender that can lie about a digest: the test-only
 * `floe-e2ehost send` mode (cli/internal/e2ehost/send.go), driven as a leg so a
 * forced-mismatch cell can have a sender the engine will never become.
 *
 * It speaks one JSON event per line on stdout and nothing else, so this adapter
 * waits on event shapes rather than on human text: `link` carries the room link,
 * `channel-open` is the pairing, and `peer-refused` carries the receiver's own
 * refusal code. A run that reaches `peer-refused` with `hash-mismatch` is the
 * success this cell is asking about.
 *
 * Route: the harness prints no candidate information, on purpose (an address is
 * exactly what the audit must never write down), so a harness leg offers no
 * route evidence and the cell's route rests on the receiver's own oracle. That
 * is recorded in work/14-test-evidence/P0-27/harness-leg-design.md of the plan
 * folder rather than decided here.
 *
 * Nothing in this file ships: the binary it drives is built from
 * cli/internal/e2ehost, which `go list -deps ./cmd/floe` never names.
 */
import { existsSync } from 'node:fs';

import { Leg, PhaseError } from './surfaces.mjs';
import { killTree, spawnFloe } from './proc.mjs';

export const LINK_EVENT_RE = /"event"\s*:\s*"link"/;
export const OPEN_EVENT_RE = /"event"\s*:\s*"channel-open"/;
export const REFUSED_EVENT_RE = /"event"\s*:\s*"peer-refused"/;
export const DONE_EVENT_RE = /"event"\s*:\s*"done"/;
export const ERROR_EVENT_RE = /"event"\s*:\s*"error"/;

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

export class HarnessLeg extends Leg {
    constructor(opts) {
        super(opts);
        this.surface = 'harness';
        this.bin = opts.bin;
        this._link = null;
        this.h = null;
    }

    argv() {
        const { opts } = this;
        const args = ['send', '-server', opts.server, '-web', opts.web];
        if (opts.room) args.push('-room', opts.room);
        const flag = lieFlag(opts.hashLie);
        if (flag) args.push(flag);
        return [...args, ...(opts.files || [])];
    }

    async start() {
        const { opts } = this;
        if (!this.bin)
            throw new PhaseError('spawn', 'harness sender: bin is required');
        if (!opts.files || !opts.files.length)
            throw new PhaseError('spawn', 'harness sender: files are required');
        this.h = spawnFloe({
            bin: this.bin,
            args: this.argv(),
            // The harness is a receiver's peer, not a receiver: it reports
            // nothing to the stats counter, and the environment says so anyway.
            env: { ...opts.env, FLOE_NO_STATS: '1', FLOE_NO_UPDATE_CHECK: '1' },
            cwd: opts.cwd,
            label: this.label || 'e2ehost-send',
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
        return null;
    }

    async awaitRoute() {
        // No candidate information by design; the receiver's oracle decides.
        return null;
    }

    async awaitDone(timeoutMs) {
        const exit = await this.h.waitExit(this.budget(timeoutMs));
        if (!exit)
            throw new PhaseError(
                'done',
                `harness sender: still running after ${timeoutMs} ms (silent for ${this.h.stalledFor()} ms)`,
                { stalledMs: this.h.stalledFor() }
            );
        const ms = exit.t - this.h.t0;
        const refused = lastEvent(this.h.stdout, 'peer-refused');
        if (refused)
            return {
                ok: true,
                kind: 'refusal',
                ms,
                exitCode: exit.code,
                detail: { class: 'peer-refused', code: refused.code || 'other' },
            };
        if (lastEvent(this.h.stdout, 'done'))
            return { ok: true, kind: 'transfer', ms, exitCode: exit.code, detail: {} };
        const failed = lastEvent(this.h.stdout, 'error');
        return {
            ok: false,
            kind: 'error',
            ms,
            exitCode: exit.code,
            detail: { stage: (failed && failed.stage) || 'unknown' },
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
