// In-memory surface adapters for cell.test.mjs and audit.test.mjs. Every
// leg emulates one scripted outcome (PASS, FAIL early-race, a retryable
// failure then PASS, a route mismatch, a refusal, a hash mismatch, an
// undrivable desktop receiver, a stats breach, a missing init script, an
// infra outage, the kill cells) without Playwright, PowerShell or a Floe
// binary. Receivers write real files into opts.outDir so the runner's
// walk and sha256 comparison exercise the same code as a live run.
import { randomUUID } from 'node:crypto';
import {
    closeSync,
    copyFileSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { Leg, PhaseError, SafetyError, sleep } from '../surfaces.mjs';

const LETTER = { web: 'W', cli: 'C', desktop: 'D', wsl: 'L' };

export const SCRIPTS = Object.freeze([
    'pass',
    'early-race',
    'retry-then-pass',
    'route-mismatch',
    'refusal',
    'cap-not-enforced',
    'hash-mismatch',
    'missing-file',
    'undrivable',
    'stats-breach',
    'stats-attempt',
    'init-script-missing',
    'infra-down',
    'connect-timeout',
    'kill',
    'harness-crash',
    'savedir-skip',
    'restore-mismatch',
    'done-hang',
]);

/**
 * webShape 'b1' (default) reports the flat policyOk / localStorage the
 * fixture always used; 'b2' reports lib/web.mjs's own shape (policy { ok }
 * and localStorageRead) so the cell runner is proven against both.
 */
export function fakeWorld({ tick = 5, webShape = 'b1' } = {}) {
    const world = {
        tick,
        webShape,
        scripts: new Map(),
        calls: [],
        killed: new Set(),
        rooms: new Map(),
        nextPid: 40000,
        started: new Map(),
        killRequests: [],
        spends: [],
        setScript(cellId, script) {
            world.scripts.set(cellId, script);
        },
        scriptFor(cell, attempt) {
            const s = world.scripts.get(cell.id);
            if (typeof s === 'function') return s(attempt, cell);
            if (Array.isArray(s)) return s[Math.min(attempt - 1, s.length - 1)];
            if (s) return s;
            if (cell.expect === 'refusal') return 'refusal';
            if (
                cell.expect === 'kill-sender' ||
                cell.expect === 'kill-receiver'
            )
                return 'kill';
            return 'pass';
        },
    };
    return world;
}

function spend(ledger, kind) {
    if (ledger && typeof ledger.spend === 'function') ledger.spend(kind);
}

class FakeLeg extends Leg {
    constructor(surface, world, opts) {
        super(opts);
        this.surface = surface;
        this.world = world;
        this.script = world.scriptFor(
            { id: opts.cellId, expect: opts.expect },
            opts.attempt
        );
        this.pid = world.nextPid++;
        this.h = { pid: this.pid };
        this._link = null;
        this._code = null;
        this.connectedAt = null;
        this.doneKind = null;
        this.statsAttempts = 0;
        this.bytesReportedEvents = 0;
        this.samples = [];
        this.exitCode = null;
        world.started.set(this.pid, {
            image: `${surface}.exe`,
            label: `${opts.cellId}:${opts.role}`,
        });
        world.calls.push({
            cellId: opts.cellId,
            attempt: opts.attempt,
            role: opts.role,
            surface,
            script: this.script,
        });
    }

    get letter() {
        return LETTER[this.surface];
    }

    async start() {
        const { opts } = this;
        if (!opts.evidenceDir)
            throw new PhaseError('start', 'fake leg: evidenceDir is required');
        mkdirSync(opts.evidenceDir, { recursive: true });
        if (opts.role === 'receiver' && opts.statsOff !== true)
            throw new SafetyError('fake receiver started without statsOff');
        spend(opts.ledger, 'turn');
        spend(opts.ledger, 'conn');
        this.world.spends.push({ cellId: opts.cellId, role: opts.role });
        if (this.script === 'harness-crash' && opts.role === 'sender')
            throw new TypeError(
                'fake adapter crashed: cannot read properties of undefined'
            );
        if (this.script === 'infra-down')
            throw new PhaseError(
                'start',
                'Error: failed to connect to signaling server: dial tcp: connection refused'
            );
        if (opts.role === 'sender') {
            if (!opts.files || !opts.files.length)
                throw new PhaseError('start', 'fake sender: no files');
            const room = randomUUID();
            this._link = `${(opts.infra && opts.infra.web) || 'https://www.floe.one'}/#room=${room}`;
            this._code =
                this.surface === 'web'
                    ? null
                    : `alpha-${room.slice(0, 4)}-charlie`;
            this.world.rooms.set(this._link, {
                files: opts.files,
                sender: this,
            });
            this.room = this.world.rooms.get(this._link);
            if (this._code)
                this.world.rooms.set(
                    this._code,
                    this.world.rooms.get(this._link)
                );
            if (this._code) spend(opts.ledger, 'code');
        } else {
            const target = opts.target;
            if (!target)
                throw new PhaseError('start', 'fake receiver: no target');
            if (this.script === 'undrivable' && this.surface === 'desktop')
                throw new PhaseError(
                    'start',
                    'desktop receiver: status read Please enter a code or link.',
                    {
                        reason: 'uia-setvalue',
                    }
                );
            if (this.script === 'savedir-skip' && this.surface === 'desktop')
                throw new PhaseError(
                    'start',
                    'desktop receiver: SetValue left "" in the save-dir field',
                    { verdict: 'SKIP', reason: 'desktop-savedir' }
                );
            if (opts.input === 'code') spend(opts.ledger, 'code');
            this.room = this.world.rooms.get(target);
            if (!this.room)
                throw new PhaseError(
                    'start',
                    `Error: code "${target}" not found or expired`
                );
            this.room.receiver = this;
        }
        await sleep(this.world.tick);
        return this;
    }

    async code() {
        return this._code;
    }

    async link() {
        return this.role === 'sender' ? this._link : this.opts.target;
    }

    async awaitConnected() {
        await sleep(this.world.tick);
        if (this.script === 'retry-then-pass' && this.attempt === 1)
            throw new PhaseError(
                'connect',
                'Error: failed to fetch ICE credentials: Get "/api/turn-credentials": 503'
            );
        if (this.script === 'connect-timeout')
            throw new PhaseError(
                'connect',
                'Error: timed out establishing a connection'
            );
        this.connectedAt = Date.now();
        return { t: this.connectedAt };
    }

    route() {
        if (!this.connectedAt) return null;
        const relayCell = /-REL-/.test(this.cellId);
        const forced = Boolean(this.opts.relayOnly);
        const mismatch = this.script === 'route-mismatch';
        const relay = mismatch ? !relayCell : relayCell;
        if (this.surface === 'web') {
            const policyOk =
                this.script === 'init-script-missing'
                    ? false
                    : forced
                      ? true
                      : null;
            const pair = relay
                ? {
                      local: forced ? 'relay' : 'srflx',
                      remote: forced ? 'srflx' : 'relay',
                  }
                : { local: 'host', remote: 'host' };
            this.samples.push({
                t: Date.now(),
                pcs: [{ policy: forced ? 'relay' : null, pair }],
            });
            return {
                t: Date.now(),
                source: 'getStats',
                local: pair.local,
                remote: pair.remote,
                verdict: relay ? 'relay' : 'direct',
                policyOk,
            };
        }
        if (this.surface === 'desktop')
            return {
                t: Date.now(),
                source: 'pill',
                local: null,
                remote: null,
                verdict: relay ? 'relay' : 'direct',
            };
        if (this.opts.pionTrace)
            return {
                t: Date.now(),
                source: 'pion-trace',
                local: null,
                remote: null,
                verdict: relay ? 'relay' : 'direct',
            };
        return null;
    }

    async awaitDone() {
        const { opts, world } = this;
        const ms = () => Date.now() - (this.connectedAt || Date.now());
        await sleep(world.tick);
        if (this.script === 'early-race') {
            this.exitCode = 1;
            return this.role === 'receiver'
                ? {
                      ok: false,
                      kind: 'error',
                      detail: {
                          error: 'Error: connected, but no data arrived from the sender within 30s',
                          class: 'stall-before-metadata',
                      },
                      exitCode: 1,
                      ms: ms(),
                  }
                : {
                      ok: false,
                      kind: 'error',
                      detail: {
                          error: 'Error: timed out waiting for ack',
                          class: 'ack-timeout',
                      },
                      exitCode: 1,
                      ms: ms(),
                  };
        }
        if (this.script === 'refusal' || this.script === 'cap-not-enforced') {
            if (
                this.script === 'cap-not-enforced' &&
                this.role === 'receiver'
            ) {
                // Bytes move over the relay: the guard must catch this.
                const p = path.join(opts.outDir, 'fixture.bin.part');
                mkdirSync(opts.outDir, { recursive: true });
                writeFileSync(p, Buffer.alloc(1024));
                await sleep(world.tick * 40);
                return {
                    ok: true,
                    kind: 'transfer',
                    detail: {},
                    exitCode: 0,
                    ms: ms(),
                };
            }
            if (this.script === 'cap-not-enforced') {
                // A sender whose cap did not hold sends normally; the moved
                // bytes on the receiver side are what the guard must catch.
                this.exitCode = 0;
                return {
                    ok: true,
                    kind: 'transfer',
                    detail: { text: 'Sent 1 file' },
                    exitCode: 0,
                    ms: ms(),
                };
            }
            this.exitCode = 1;
            if (this.role !== 'sender')
                // A real browser receiver has no refusal oracle (2026-08-29:
                // cap3g ran the 75 s done budget out on production while the
                // CLI had refused at 3.9 s), so the driver must never wait on
                // the receiver once the sender refused.
                throw new Error(
                    'fake receiver: awaitDone called after the sender refused'
                );
            return {
                ok: true,
                kind: 'refusal',
                detail: {
                    class: 'relay-cap-refusal',
                    side: 'self',
                    error: 'Error: transfer blocked: relay connections are capped at 2 GB (selected 3 GB)',
                },
                exitCode: 1,
                ms: ms(),
            };
        }
        if (this.script === 'kill') return this.killScript(ms);
        if (this.script === 'done-hang') {
            // The transfer completes (file on disk, a CLI exits 0) but the
            // completion oracle never fires: the 2026-08-28 desktop failure.
            if (this.role === 'receiver') {
                mkdirSync(opts.outDir, { recursive: true });
                for (const src of this.room.files)
                    this.deliver(src, this.surface !== 'web');
            }
            this.exitCode =
                this.surface === 'cli' || this.surface === 'wsl' ? 0 : null;
            await new Promise(() => {});
        }
        if (this.role === 'receiver') {
            mkdirSync(opts.outDir, { recursive: true });
            const files = this.room.files;
            const nested = this.surface !== 'web';
            for (const src of files) this.deliver(src, nested);
            if (this.script === 'stats-breach') this.bytesReportedEvents = 1;
            if (this.script === 'stats-attempt') this.statsAttempts = 1;
            this.exitCode = 0;
            return {
                ok: true,
                kind: 'transfer',
                detail: {
                    complete: true,
                    text:
                        this.surface === 'web' ? '1 file received' : 'Saved to',
                },
                exitCode: 0,
                ms: ms(),
            };
        }
        this.exitCode = 0;
        return {
            ok: true,
            kind: 'transfer',
            detail: {
                complete: true,
                text: this.surface === 'web' ? 'All Files Sent!' : 'Sent',
            },
            exitCode: 0,
            ms: ms(),
        };
    }

    deliver(src, nested) {
        const { opts } = this;
        const st = statSafe(src);
        if (st && st.isDirectory()) {
            const base = path.basename(src);
            const walk = (d, rel) => {
                for (const e of readdirSafe(d)) {
                    const abs = path.join(d, e.name);
                    const r = rel ? `${rel}/${e.name}` : e.name;
                    if (e.isDirectory()) walk(abs, r);
                    else this.writeOut(abs, nested ? `${base}/${r}` : e.name);
                }
            };
            walk(src, '');
            return;
        }
        this.writeOut(src, path.basename(src));
    }

    writeOut(src, rel) {
        const { opts } = this;
        if (
            this.script === 'missing-file' &&
            /(^|\/)b\.bin$|fixture-\d+\.bin$/.test(rel) &&
            !this._skipped
        ) {
            this._skipped = true;
            return;
        }
        const dest = path.join(opts.outDir, ...rel.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        if (this.script === 'hash-mismatch' && !this._flipped) {
            this._flipped = true;
            const buf = readFileSync(dest);
            if (buf.length) {
                buf[0] ^= 0xff;
                writeFileSync(dest, buf);
            } else writeFileSync(dest, Buffer.from([1]));
        }
    }

    async killScript(ms) {
        const { opts, world } = this;
        const victim = opts.expect === 'kill-sender' ? 'sender' : 'receiver';
        const stem = path.basename(this.room.files[0]);
        if (this.role === 'receiver') {
            mkdirSync(opts.outDir, { recursive: true });
            const finalName = path.join(opts.outDir, stem);
            const partPath = `${finalName}.part`;
            if (this.attempt >= 2 && statSafe(partPath)) {
                // A stale .part blocks the name; the retry claims "stem (1).ext".
                const ext = path.extname(stem);
                const alt = path.join(
                    opts.outDir,
                    `${stem.slice(0, -ext.length)} (1)${ext}`
                );
                copyFileSync(this.room.files[0], alt);
                this.exitCode = 0;
                return {
                    ok: true,
                    kind: 'transfer',
                    detail: { complete: true, savedAs: path.basename(alt) },
                    exitCode: 0,
                    ms: ms(),
                };
            }
            const fd = openSync(partPath, 'w');
            ftruncateSync(fd, (opts.killAtBytes || 50 * 1024 * 1024) + 1);
            closeSync(fd);
            const other = this.room.sender;
            for (let i = 0; i < 400; i++) {
                await sleep(world.tick);
                if (world.killed.has(this.pid)) {
                    this.exitCode = null;
                    return {
                        ok: false,
                        kind: 'killed',
                        detail: { error: null },
                        exitCode: null,
                        ms: ms(),
                    };
                }
                if (other && world.killed.has(other.pid)) {
                    rmSync(partPath, { force: true });
                    this.exitCode = 1;
                    return {
                        ok: false,
                        kind: 'error',
                        detail: {
                            error: `Error: connection closed mid-transfer: ${stem} (52428801 of 209715200 bytes)`,
                            class: 'stall-mid-file',
                        },
                        exitCode: 1,
                        ms: ms(),
                    };
                }
            }
            return {
                ok: false,
                kind: 'error',
                detail: { error: 'fake: no kill arrived' },
                exitCode: 1,
                ms: ms(),
            };
        }
        const other = this.room.receiver;
        for (let i = 0; i < 400; i++) {
            await sleep(world.tick);
            if (world.killed.has(this.pid)) {
                this.exitCode = null;
                return {
                    ok: false,
                    kind: 'killed',
                    detail: { error: null },
                    exitCode: null,
                    ms: ms(),
                };
            }
            if (
                other &&
                other.exitCode !== null &&
                other.exitCode !== undefined
            ) {
                if (victim === 'receiver' && world.killed.has(other.pid)) {
                    this.exitCode = 1;
                    return {
                        ok: false,
                        kind: 'error',
                        detail: {
                            error: 'Error: peer disconnected mid-transfer',
                            class: 'peer-left',
                        },
                        exitCode: 1,
                        ms: ms(),
                    };
                }
                if (this.attempt >= 2) {
                    this.exitCode = 0;
                    return {
                        ok: true,
                        kind: 'transfer',
                        detail: { complete: true },
                        exitCode: 0,
                        ms: ms(),
                    };
                }
            }
        }
        return {
            ok: false,
            kind: 'error',
            detail: { error: 'fake: sender never finished' },
            exitCode: 1,
            ms: ms(),
        };
    }

    async outputs() {
        return [];
    }

    async stop(reason) {
        await super.stop(reason);
        this.stopped = true;
        if (
            this.script === 'restore-mismatch' &&
            this.surface === 'desktop' &&
            this.role === 'receiver'
        )
            throw new SafetyError(
                'desktop.json restore mismatch: want aaaa, got bbbb',
                { want: 'aaaa', got: 'bbbb' }
            );
    }

    evidence() {
        const receiver = this.role === 'receiver';
        let statsProof = null;
        if (receiver && this.surface === 'web')
            statsProof = {
                kind: 'route-abort',
                attempts: this.statsAttempts,
                bytesReportedEvents: this.bytesReportedEvents,
                localStorage: 'false',
            };
        else if (receiver && (this.surface === 'cli' || this.surface === 'wsl'))
            statsProof = { kind: 'argv+env', noReport: true, floeNoStats: '1' };
        else if (receiver && this.surface === 'desktop')
            statsProof = {
                kind: 'desktop.json-preflight',
                reportStats: false,
                migrated: true,
                sha256Before: 'a',
                sha256After: 'a',
                restoredIdentical: true,
            };
        const policyOk =
            this.script === 'init-script-missing' &&
            this.surface === 'web' &&
            this.opts.relayOnly
                ? false
                : null;
        const ev = {
            surface: this.surface,
            role: this.role,
            version: this.build ? this.build.version : null,
            argv: [`${this.surface}`, this.role],
            env: receiver
                ? { FLOE_NO_STATS: '1', FLOE_NO_UPDATE_CHECK: '1' }
                : { FLOE_NO_UPDATE_CHECK: '1' },
            transcript: null,
            samples: this.samples,
            bytesReportedEvents: this.bytesReportedEvents,
            exit: this.exitCode === null ? null : { code: this.exitCode },
            captures: [],
            statsProof,
            notes: this.notes,
        };
        if (this.surface === 'desktop') {
            // What lib/desktop.mjs reports: window-cropped captures, the
            // config guard's state and the remembered save dir.
            ev.captures = [{ tag: 'done', path: `${this.role}-done.png` }];
            ev.config = {
                applied: true,
                match: this.script !== 'restore-mismatch',
            };
            if (receiver)
                ev.saveDir = {
                    original: 'Downloads',
                    changed: true,
                    restored: true,
                };
        }
        if (this.surface === 'web' && this.world.webShape === 'b2') {
            ev.policy = {
                ok: policyOk === null ? true : policyOk,
                checked: 1,
                offenders: policyOk === false ? ['all'] : [],
            };
            if (statsProof)
                ev.statsProof = {
                    kind: 'route-abort',
                    attempts: statsProof.attempts,
                    bytesReportedEvents: statsProof.bytesReportedEvents,
                    localStorageSeed: 'false',
                    localStorageRead: 'false',
                    breach: false,
                };
        } else ev.policyOk = policyOk;
        return ev;
    }
}

function statSafe(p) {
    try {
        return statSync(p);
    } catch {
        return null;
    }
}
function readdirSafe(d) {
    try {
        return readdirSync(d, { withFileTypes: true });
    } catch {
        return [];
    }
}

export function makeFakeAdapters(world = fakeWorld()) {
    const surface = (name) => ({
        createLeg: (opts) => new FakeLeg(name, world, opts),
        preflight: async () => ({
            ok: true,
            reason: null,
            detail: { fake: true, name },
        }),
        probe: async () => ({ ok: true, fake: true }),
        probeRelay: async () => ({ ok: true, detail: 'fake relay probe' }),
        shutdown: async () => {
            world.calls.push({ shutdown: name });
        },
    });
    const proc = {
        started: world.started,
        killTree(pid) {
            world.killRequests.push(pid);
            if (!world.started.has(pid))
                throw new SafetyError(
                    `refusing to kill pid ${pid}: not started by this run`,
                    { pid }
                );
            world.killed.add(pid);
            return { killed: true, image: world.started.get(pid).image };
        },
        killAllStarted() {
            return [];
        },
        classifyExit(code) {
            return { code, kind: code === 0 ? 'ok' : 'error', class: null };
        },
    };
    const stack = {
        ensureStack: async () => ({
            owned: false,
            started: false,
            server: 'http://localhost:3001',
            web: 'http://localhost:3000',
            stop: async () => {},
        }),
        stopStack: async () => {},
        statsTotal: async () => 0,
    };
    // The desktop adapter also answers the probe subcommand: storePackage
    // and the aggregate shape audit.mjs prints and matrix.mjs gates on.
    const desktop = {
        ...surface('desktop'),
        storePackage: async () => ({ present: false }),
        probe: async (o = {}) => ({
            available: true,
            receiverDrivable: true,
            saveDirSettable: true,
            senderDrivable: true,
            present: !o.userAway,
            focusNeeded: false,
            mode: o.mode ?? null,
            detail: 'P1 drivable; P2 skipped; P6 packaged-argv-ok; P8 no-activation; P9 restored-across-relaunch',
            saveDirOriginal: 'D:\\down',
            probes: {
                P1: {
                    probe: 'P1',
                    verdict: 'drivable',
                    detail: {
                        afterTabFlip: 'zzz-zzz-zzz',
                        status: { kind: 'connecting', text: 'Connecting...' },
                    },
                },
                P2: {
                    probe: 'P2',
                    verdict: 'skipped',
                    detail: 'no portable exe staged (store build)',
                },
                P6: {
                    probe: 'P6',
                    verdict: 'packaged-argv-ok',
                    detail: { packaged: true, argvHonored: true },
                },
                P8: {
                    probe: 'P8',
                    verdict: 'no-activation',
                    detail: { minimized: true, activated: false },
                },
                P9: {
                    probe: 'P9',
                    verdict: 'restored-across-relaunch',
                    detail: {
                        original: 'D:\\down',
                        settable: true,
                        restoredAcrossRelaunch: true,
                    },
                },
            },
        }),
    };
    return {
        web: surface('web'),
        cli: surface('cli'),
        desktop,
        wsl: surface('wsl'),
        proc,
        stack,
        world,
    };
}
