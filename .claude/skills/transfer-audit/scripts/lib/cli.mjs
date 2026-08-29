/**
 * CLI surface adapter for the transfer-audit skill: one floe process per
 * leg, driven through proc.mjs, with every string it matches quoted from
 * cli/cmd/floe/main.go and cli/engine/transfer at f14a8d7 (the shipped
 * 1.10.5 prints the same lines; the parser fixtures under tests/fixtures/
 * are captured from that binary).
 *
 * Command lines (main.go:91-98 and :268-273):
 *   <bin> send <paths...> --server <s> --web <w> [--no-relay] [--relay-only]
 *   <bin> receive <code|link> --server <s> --output <dir> --yes --no-report
 * --no-relay only when the cell asks for it (the judge's C3: C2C and L2C
 * only, because every other pair has a peer with a route oracle).
 * --relay-only only when the cell forces the relay on this leg AND the
 * binary lists the flag in `send --help`; 1.10.5 does not, so the flag is
 * never sent to a shipped CLI and the S-REL-C2C cell stays NA until it ships.
 *
 * Environment (buildEnv): PION_LOG_*, FLOE_SERVER, FLOE_WEB and FLOE_NO_STATS
 * are stripped from the inherited environment (main.go:73-82 reads
 * FLOE_SERVER when --server is not passed, and a stray one in the auditor's
 * shell must not retarget a child), FLOE_NO_UPDATE_CHECK=1 always
 * (selfupdate.go returns before any cache read or write), FLOE_NO_STATS=1 on
 * every receiver (main.go:356-359: either it or --no-report blanks the stats
 * URL; the adapter sends both), PION_LOG_TRACE=ice only under --pion-trace.
 *
 * Stats proof for a receiver is argv plus env, recorded verbatim; the CLI
 * prints nothing about the report path, so the proof is what it was started
 * with, not what it did.
 *
 * Route evidence: the CLI prints nothing about the ICE path today. With
 * PION_LOG_TRACE=ice the pion agent logs "Set selected candidate pair: ..."
 * (ice/v4 agent.go:780, Trace level) whose local and remote halves name the
 * candidate types; a future "  Connected (direct|relay)" suffix is accepted
 * by the marker regex so no parser change is needed when it ships.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { Leg, PhaseError } from './surfaces.mjs';
import {
    classifyExit,
    firstErrorLine,
    killTree,
    spawnFloe,
    tail,
} from './proc.mjs';

export const START_TIMEOUT_MS = 30_000;
export const STOP_GRACE_MS = 5_000;

// main.go:107 version template "floe {{.Version}}"; GoReleaser strips the v.
export const VERSION_RE = /^floe (\S+)\s*$/m;
// main.go:203 box row via format.go PrintBox "  %s%s   %s": three lowercase
// words, four after ten collisions (server/server.js generateCode).
export const CODE_RE = /^\s*Code\s+([a-z]+(?:-[a-z]+){2,3})\s*$/m;
// client/e2e/helpers.ts:177
export const LINK_RE = /https?:\/\/\S*#room=[^\s]+/;
// Summary rows: sender.go:319-323 (Sent, Time), receiver.go:548-552
// (Received, Time, Saved to). Labels are padded to the longest label.
export const SUMMARY_ROW_RE =
    /^ {2}(Sent|Received|Time|Saved to) {3,}(.+?)\s*$/gm;
// pion/ice/v4 agent.go:780 under PION_LOG_TRACE=ice.
export const PION_PAIR_RE = /Set selected candidate pair: (.*)$/;
// relay.go:70 wrapped by cobra's "Error: " prefix (main.go SilenceUsage).
export const REFUSAL_PREFIX =
    'Error: transfer blocked: relay connections are capped at 2 GB (selected ';

// Stdout markers, main.go unless noted. "Connected" accepts the optional
// route suffix a later CLI may print.
export const MARKERS = Object.freeze({
    turnWarning:
        /^ {2}Warning: could not reach signaling server for TURN credentials\. Using STUN only\.$/, // ice/credentials.go:118
    codeWarning: /^ {2}Warning: could not generate short code/, // :184
    sending: /^ {2}Sending {3}(.+)$/, // :200
    waiting: /^ {2}Waiting for peer\.\.\.$/, // :208
    connecting: /^ {2}Connecting\.\.\.$/, // :228
    connectingToSender: /^ {2}Connecting to sender\.\.\.$/, // :339
    connected: /^ {2}Connected(?: \((direct|relay)\))?$/, // :234, :353
    peerVersion: /^ {2}Peer version: (.+)$/, // sender.go:457, receiver.go:359
    incoming: /^ {2}Incoming {3}(.+)$/, // receiver.go:372
    progress: /^ {2}\[(\d+)\/(\d+)\] /, // format.go:128
    savedAs: /^ {2}Saved as (.+)$/, // receiver.go:536
    canceled: /^ {2}Canceled\.$/, // main.go:455 (stderr)
});

export function parseVersion(stdout = '') {
    const m = stdout.match(VERSION_RE);
    return m ? m[1] : null;
}

/** Every long flag cobra lists, e.g. ['--help', '--no-relay', ...]. */
export function parseHelpFlags(stdout = '') {
    const flags = new Set();
    for (const m of stdout.matchAll(/^\s+(?:-[A-Za-z], )?(--[a-z][a-z-]*)/gm))
        flags.add(m[1]);
    return [...flags];
}

export function parseCode(stdout = '') {
    const m = stdout.match(CODE_RE);
    return m ? m[1] : null;
}

export function parseLink(stdout = '') {
    const m = stdout.match(LINK_RE);
    return m ? m[0].trim() : null;
}

/**
 * { sent, received, time, savedTo, files, size, duration, avg, complete }
 * with the raw row values as strings and null where a row is absent.
 */
export function parseSummary(stdout = '') {
    const rows = {};
    for (const m of stdout.matchAll(SUMMARY_ROW_RE)) rows[m[1]] = m[2];
    const out = {
        sent: rows.Sent ?? null,
        received: rows.Received ?? null,
        time: rows.Time ?? null,
        savedTo: rows['Saved to'] ?? null,
        files: null,
        size: null,
        duration: null,
        avg: null,
        complete: false,
    };
    const count = (rows.Sent || rows.Received || '').match(
        /^(\d+) files? \((.+)\)$/
    );
    if (count) {
        out.files = Number(count[1]);
        out.size = count[2];
    }
    if (rows.Time) {
        const [duration, avg] = rows.Time.split(' · avg ');
        out.duration = duration;
        out.avg = avg ?? null;
    }
    out.complete = Boolean(rows.Sent || (rows.Received && rows['Saved to']));
    return out;
}

/**
 * The last pion "Set selected candidate pair" line on stderr, split at
 * "<->" into the local and remote candidate types, or null. verdict is
 * 'relay' when either side is a relay candidate (relay.go:59-62 rule).
 */
export function parsePionPair(stderr = '') {
    const lines = stderr.split(/\r?\n/).filter((l) => PION_PAIR_RE.test(l));
    if (!lines.length) return null;
    const line = lines.at(-1);
    const desc = line.match(PION_PAIR_RE)[1];
    const [localSide = '', remoteSide = ''] = desc.split('<->');
    const typeOf = (s) => (s.match(/\b(host|srflx|prflx|relay)\b/) || [])[1];
    const local = typeOf(localSide) || null;
    const remote = typeOf(remoteSide) || null;
    const verdict =
        local === 'relay' || remote === 'relay'
            ? 'relay'
            : local || remote
              ? 'direct'
              : 'unknown';
    return { line, local, remote, verdict, count: lines.length };
}

/** The receiver's positional argument: opts.target, else by opts.input. */
export function receiverTarget(opts) {
    if (opts.target) return opts.target;
    if (opts.input === 'code') return opts.code ?? null;
    return opts.link ?? opts.code ?? null;
}

/** Pure. Sender: send <files> --server --web; receiver: receive <target> ... */
export function buildArgs(opts) {
    const infra = opts.infra || {};
    const server = infra.server ?? opts.server;
    const web = infra.web ?? opts.web;
    if (!server) throw new PhaseError('start', 'cli: infra.server is required');
    const args = [];
    if (opts.role === 'sender') {
        const files = opts.files || [];
        if (!files.length)
            throw new PhaseError('start', 'cli sender: opts.files is empty');
        args.push('send', ...files, '--server', server);
        if (web) args.push('--web', web);
    } else if (opts.role === 'receiver') {
        const target = receiverTarget(opts);
        if (!target)
            throw new PhaseError('start', 'cli receiver: no code or link');
        if (!opts.outDir)
            throw new PhaseError(
                'start',
                'cli receiver: opts.outDir is required'
            );
        args.push(
            'receive',
            target,
            '--server',
            server,
            '--output',
            opts.outDir,
            '--yes',
            '--no-report'
        );
    } else {
        throw new PhaseError('start', `cli: unknown role ${opts.role}`);
    }
    if (opts.noRelay) args.push('--no-relay');
    if (opts.relayOnly && opts.cliHasRelayOnly) args.push('--relay-only');
    for (const name of opts.iface || []) args.push('--iface', name);
    return args;
}

export const STRIP_ENV = Object.freeze([
    'FLOE_SERVER',
    'FLOE_WEB',
    'FLOE_NO_STATS',
]);

/** Pure over base (default process.env). */
export function buildEnv(opts, base = process.env) {
    const env = {};
    for (const [key, value] of Object.entries(base)) {
        const upper = key.toUpperCase();
        if (upper.startsWith('PION_LOG_') || STRIP_ENV.includes(upper))
            continue;
        env[key] = value;
    }
    env.FLOE_NO_UPDATE_CHECK = '1';
    if (opts.role === 'receiver') env.FLOE_NO_STATS = '1';
    if (opts.pionTrace) env.PION_LOG_TRACE = 'ice';
    return env;
}

/** The evidence subset of an env: the three keys the proof is made of. */
export function envSubset(env) {
    return {
        FLOE_NO_STATS: env.FLOE_NO_STATS ?? null,
        FLOE_NO_UPDATE_CHECK: env.FLOE_NO_UPDATE_CHECK ?? null,
        PION_LOG_TRACE: env.PION_LOG_TRACE ?? null,
    };
}

function spend(ledger, kind) {
    if (ledger && typeof ledger.spend === 'function') ledger.spend(kind);
}

function rephase(err, phase) {
    if (err instanceof PhaseError && err.phase === phase) return err;
    const wrapped = new PhaseError(phase, err.message, {
        cause: err,
        innerPhase: err && err.phase,
    });
    return wrapped;
}

export function sha256File(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

function walk(dir, visit) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, visit);
        else if (entry.isFile()) visit(full);
    }
}

function execText(bin, args, env) {
    return execFileSync(bin, args, {
        encoding: 'utf8',
        env,
        windowsHide: true,
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * { ok, reason, detail: { bin, version, sendFlags, receiveFlags,
 *   cliHasRelayOnly } }. Uses `--version` (never `floe version`, which
 * writes update-check.json) and the two `--help` pages; starts no transfer.
 */
export async function preflight(opts = {}) {
    const bin = opts.bin ?? (opts.build && opts.build.path) ?? 'floe';
    // binArgs go before the floe verbs; tests drive tests/fake-floe.mjs
    // through node this way. Empty for a real binary.
    const pre = opts.binArgs ?? [];
    const detail = {
        bin,
        version: null,
        sendFlags: [],
        receiveFlags: [],
        cliHasRelayOnly: false,
    };
    if (isAbsolute(bin) && !existsSync(bin))
        return { ok: false, reason: `binary not found: ${bin}`, detail };
    const env = buildEnv({ role: 'preflight' }, opts.baseEnv ?? process.env);
    try {
        detail.version = parseVersion(
            execText(bin, [...pre, '--version'], env)
        );
    } catch (err) {
        return {
            ok: false,
            reason: `${bin} --version failed: ${err.message}`,
            detail,
        };
    }
    if (!detail.version)
        return {
            ok: false,
            reason: `${bin} --version printed no "floe <version>" line`,
            detail,
        };
    try {
        detail.sendFlags = parseHelpFlags(
            execText(bin, [...pre, 'send', '--help'], env)
        );
        detail.receiveFlags = parseHelpFlags(
            execText(bin, [...pre, 'receive', '--help'], env)
        );
    } catch (err) {
        return {
            ok: false,
            reason: `${bin} --help failed: ${err.message}`,
            detail,
        };
    }
    detail.cliHasRelayOnly = detail.sendFlags.includes('--relay-only');
    for (const need of ['--no-report', '--yes', '--output']) {
        if (!detail.receiveFlags.includes(need))
            return {
                ok: false,
                reason: `receive --help lists no ${need}`,
                detail,
            };
    }
    if (!detail.sendFlags.includes('--server'))
        return { ok: false, reason: 'send --help lists no --server', detail };
    return { ok: true, reason: null, detail };
}

export class CliLeg extends Leg {
    constructor(opts) {
        super(opts);
        this.surface = 'cli';
        this.bin = opts.bin ?? (opts.build && opts.build.path) ?? 'floe';
        this.binArgs = opts.binArgs ?? [];
        this.verbatim = Boolean(opts.verbatim);
        this.label = opts.label ?? opts.role;
        this.argv = buildArgs(opts);
        this.env = buildEnv(opts, opts.baseEnv ?? process.env);
        this.h = null;
        this.marks = {};
        this.connectedSuffix = null;
        this._link = null;
        this._code = null;
        this._pionCache = { len: -1, value: null };
    }

    /** ms left until opts.deadlineAt, capped at ms, never below 1 s. */
    budget(ms) {
        const { deadlineAt } = this.opts;
        if (!deadlineAt) return ms;
        return Math.max(1000, Math.min(ms, deadlineAt - Date.now()));
    }

    async start() {
        const { opts } = this;
        const timeout = this.budget(opts.startTimeoutMs ?? START_TIMEOUT_MS);
        // main.go:139/:295 fetch TURN, :158/:313 open /ws, :181 registers a
        // code (sender) and code.Resolve GETs one (receiver by code).
        spend(opts.ledger, 'turn');
        spend(opts.ledger, 'conn');
        if (opts.role === 'sender' || opts.input === 'code')
            spend(opts.ledger, 'code');
        this.h = spawnFloe({
            bin: this.bin,
            args: [...this.binArgs, ...this.argv],
            env: this.env,
            cwd: opts.cwd,
            label: this.label,
            evidenceDir: opts.evidenceDir,
            stallMs: opts.stallMs,
            verbatim: this.verbatim,
        });
        try {
            if (opts.role === 'sender') {
                // The Code row prints before the Link row (main.go:202-205),
                // so once the link is out the code is final or absent.
                const hit = await this.h.waitLine(LINK_RE, timeout);
                this.marks.link = hit.t;
                this._link = parseLink(this.h.stdout);
                this._code = parseCode(this.h.stdout);
            } else {
                const hit = await this.h.waitLine(
                    MARKERS.connectingToSender,
                    timeout
                );
                this.marks.joined = hit.t;
            }
        } catch (err) {
            throw rephase(err, 'start');
        }
        return this;
    }

    async code() {
        return this._code;
    }

    async link() {
        if (this.role === 'receiver') return receiverTarget(this.opts);
        return this._link;
    }

    async awaitConnected(timeoutMs) {
        let hit;
        try {
            hit = await this.h.waitLine(
                MARKERS.connected,
                this.budget(timeoutMs)
            );
        } catch (err) {
            throw rephase(err, 'connect');
        }
        this.marks.connected = hit.t;
        const m = hit.line.match(MARKERS.connected);
        if (m && m[1]) this.connectedSuffix = m[1];
        return hit;
    }

    pion() {
        const stderr = this.h ? this.h.stderr : '';
        if (stderr.length !== this._pionCache.len) {
            this._pionCache = {
                len: stderr.length,
                value: parsePionPair(stderr),
            };
        }
        return this._pionCache.value;
    }

    /**
     * Without PION_LOG_TRACE nothing after the Connected line can change
     * the answer, so a leg with no trace answers at once instead of
     * running out the route timeout (a CLI-to-CLI cell has two of them).
     */
    async awaitRoute(timeoutMs) {
        if (!this.opts.pionTrace) {
            const r = this.route();
            if (r && r.verdict !== 'unknown') return r;
            return { t: Date.now(), source: 'none', verdict: 'unknown' };
        }
        return super.awaitRoute(timeoutMs);
    }

    route() {
        try {
            const pion = this.pion();
            if (pion && pion.verdict !== 'unknown') {
                return {
                    t: Date.now(),
                    source: 'pion-trace',
                    local: pion.local,
                    remote: pion.remote,
                    verdict: pion.verdict,
                    line: pion.line,
                };
            }
            if (this.connectedSuffix) {
                return {
                    t: this.marks.connected,
                    source: 'cli-connected',
                    local: null,
                    remote: null,
                    verdict: this.connectedSuffix,
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * ok means a recognized terminal outcome; check kind against the cell.
     * transfer: exit 0 with the summary rows. refusal: the sender's own
     * relay-cap error (exit 1) or the receiver seeing the peer refuse
     * (detail.class 'peer-refused'). Anything else is ok: false.
     */
    async awaitDone(timeoutMs) {
        const exit = await this.h.waitExit(this.budget(timeoutMs));
        if (!exit) {
            throw new PhaseError(
                'done',
                `cli ${this.role}: still running after ${timeoutMs} ms (silent for ${this.h.stalledFor()} ms)${tail(this.h)}`,
                { stalledMs: this.h.stalledFor() }
            );
        }
        const ms = exit.t - this.h.t0;
        const cls = classifyExit(exit.code, this.h.stderr);
        const summary = parseSummary(this.h.stdout);
        const error = firstErrorLine(this.h.stderr);
        if (exit.code === 0 && summary.complete)
            return {
                ok: true,
                kind: 'transfer',
                detail: summary,
                exitCode: 0,
                ms,
            };
        if (exit.code === 1 && cls.class === 'relay-cap-refusal') {
            return {
                ok: true,
                kind: 'refusal',
                detail: { class: cls.class, side: 'self', error },
                exitCode: 1,
                ms,
            };
        }
        if (exit.code === 1 && cls.class === 'peer-refused') {
            return {
                ok: true,
                kind: 'refusal',
                detail: { class: cls.class, side: 'peer', error },
                exitCode: 1,
                ms,
            };
        }
        return {
            ok: false,
            kind: exit.code === 0 ? 'transfer' : 'error',
            detail: {
                class: cls.class,
                exitKind: cls.kind,
                error,
                summary,
                signal: exit.signal,
                spawnError: exit.error,
                tail: tail(this.h),
            },
            exitCode: exit.code,
            ms,
        };
    }

    /** Receiver: every file under outDir with a streaming sha256; no .part. */
    async outputs() {
        if (this.role !== 'receiver') return [];
        const dir = this.opts.outDir;
        if (!dir || !existsSync(dir)) return [];
        const files = [];
        const parts = [];
        walk(dir, (path) => {
            const rel = relative(dir, path).split(sep).join('/');
            if (path.endsWith('.part')) parts.push(rel);
            else
                files.push({
                    name: basename(path),
                    rel,
                    path,
                    bytes: statSync(path).size,
                });
        });
        if (parts.length) {
            throw new PhaseError(
                'verify',
                `cli receiver: staging files left in ${dir}: ${parts.join(', ')}`,
                { parts }
            );
        }
        files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        for (const f of files) f.sha256 = await sha256File(f.path);
        return files;
    }

    /** No graceful signal exists on Windows; kill only our own pid. */
    async stop(reason) {
        await super.stop(reason);
        const h = this.h;
        if (!h || h.exit || !h.pid) return;
        const result = killTree(h.pid);
        this.notes.push(`killTree pid ${h.pid}: ${JSON.stringify(result)}`);
        await h.waitExit(STOP_GRACE_MS);
    }

    evidence() {
        const h = this.h;
        const markers = {};
        const events = [];
        if (h) {
            for (const entry of h.lines) {
                for (const [name, re] of Object.entries(MARKERS)) {
                    if (name === 'progress' || !re.test(entry.line)) continue;
                    if (!(name in markers)) markers[name] = entry.t - h.t0;
                    events.push({ t: entry.t - h.t0, name, line: entry.line });
                }
                if (entry.stream === 'err' && /^Error: /.test(entry.line))
                    events.push({
                        t: entry.t - h.t0,
                        name: 'error',
                        line: entry.line,
                    });
            }
            const first = h.lines.find((l) => MARKERS.progress.test(l.line));
            if (first) markers.progress = first.t - h.t0;
        }
        return {
            surface: 'cli',
            role: this.role,
            bin: this.bin,
            version: (this.opts.build && this.opts.build.version) ?? null,
            argv: h ? h.argv : [this.bin, ...this.binArgs, ...this.argv],
            env: envSubset(this.env),
            transcript: h ? h.transcriptPath : null,
            exit: h ? h.exit : null,
            markers,
            events,
            pion: this.pion(),
            summary: h ? parseSummary(h.stdout) : null,
            code: this._code,
            link: this._link,
            statsProof:
                this.role === 'receiver'
                    ? {
                          kind: 'argv+env',
                          noReport: this.argv.includes('--no-report'),
                          floeNoStats: this.env.FLOE_NO_STATS ?? null,
                      }
                    : null,
            notes: this.notes,
        };
    }
}

export function createLeg(opts) {
    return new CliLeg(opts);
}

/** Resolve a bare binary name the way spawn will (where / which). */
export function resolveBin(bin) {
    return new Promise((resolve) => {
        if (isAbsolute(bin)) return resolve(existsSync(bin) ? bin : null);
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        execFile(cmd, [bin], { windowsHide: true }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout.split(/\r?\n/).find(Boolean) || null);
        });
    });
}
