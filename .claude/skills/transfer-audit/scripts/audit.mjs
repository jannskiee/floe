#!/usr/bin/env node
/**
 * transfer-audit driver: runs a live transfer matrix across web (floe.one),
 * CLI and Floe Desktop as sender and receiver, direct and forced relay, on
 * production or the local HEAD stack, with sha256 integrity, route
 * evidence, receivers opted out of the public stats counter, and every
 * surface compared with its latest release.
 *
 * Why the driver is split the way it is: lib/matrix.mjs decides WHAT runs
 * (pure, gated by probe.json), lib/cell.mjs decides HOW one cell runs (a
 * phase machine with product-derived timeouts and signature-based retry),
 * the surface adapters (lib/web.mjs, lib/cli.mjs, lib/desktop.mjs,
 * lib/wsl.mjs) only know how to drive one surface, and this file owns the
 * run: manifest, ledger, versions, builds, infra, probes, the cell loop,
 * the report and the cleanup. Adapters are imported lazily through
 * lib/adapters.mjs so the pure parts and --self-test never load Playwright
 * or PowerShell.
 *
 * Safety by construction: every write goes through lib/fence.mjs (only
 * --out, --bin-dir and the APPDATA redirect are writable; .env files, the
 * real %APPDATA%\floe tree and every Floe checkout are refused); HTTP is
 * GET-only (lib/http.mjs, grep-tested); the TURN body is parsed in memory
 * and only scheme names survive (lib/turn.mjs); every receiver leg carries
 * statsOff: true; processes are killed only through lib/proc.mjs, which
 * refuses any pid this run did not start; production requests are paced
 * under 50 percent of the server limiters (lib/pacing.mjs).
 *
 * Usage:
 *   node audit.mjs run [--profile shipped|head] [--quick | --deep]
 *       [--cells <id-or-glob,...>] [--desktop auto|store|portable|wailsdev|none]
 *       [--bin-dir <dir>] [--pin] [--strict] [--pion-trace] [--user-away]
 *       [--pause-max <min>] [--web-sha <sha> | --web-sha-file <json>]
 *       [--server-sha <sha>] [--keep] [--keep-data] [--monitor <n>]
 *       [--dry-run] [--relaxed]
 *       [--root <dir>] [--client-dir <dir>] [--out <dir>] [--json]
 *   node audit.mjs probe | versions | cleanup [--run <id>] [flags]
 *   node audit.mjs --self-test
 * Tests:
 *   node --test <this dir>/audit.test.mjs and <this dir>/lib/*.test.mjs
 * Exit: 0 clean; 1 any FAIL (or FLAKY under --strict); 2 usage; 3
 * precondition or mid-run infra abort; 4 safety invariant tripped; 5 partial
 * (SKIP, FLAKY or harness ERROR, no FAIL); 6 version drift only; 130
 * interrupted. Precedence 2, 4, 3, 1, 5, 6, 0. `versions` exits 0 or 6,
 * `probe` 0 or 3, `cleanup` 0 or 1. A usage error prints on stderr and
 * nothing on stdout, --json included. `run` prints one
 * `PROGRESS <cellId> <verdict>` line per cell for a background monitor.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    statfsSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    getAdapter as realGetAdapter,
    tryAdapter as realTryAdapter,
} from './lib/adapters.mjs';
import { USAGE, UsageError, parseArgs } from './lib/args.mjs';
import { RETRY_CAP, runCell } from './lib/cell.mjs';
import { createFence, isUnder, normalizePath } from './lib/fence.mjs';
import { formatBytes } from './lib/fixtures.mjs';
import { get, getJson, head } from './lib/http.mjs';
import {
    QUICK_IDS,
    cellPlan,
    countsForExit,
    matchCells,
} from './lib/matrix.mjs';
import { Ledger } from './lib/pacing.mjs';
import {
    selectCli,
    sideloadCli,
    sideloadDesktop,
    findStagedDesktop,
    buildHeadCli,
    headDesktopCommands,
    gitSha7,
    sha256Sync,
} from './lib/release.mjs';
import {
    EXIT,
    buildRunJson,
    exitCodeFor,
    headline,
    newSafety,
    relayBytesOf,
    renderMarkdown,
} from './lib/report.mjs';
import { classifyRoute } from './lib/route.mjs';
import { SafetyError, sleep as defaultSleep } from './lib/surfaces.mjs';
import { classifyIce, describeTurn, probeTurn } from './lib/turn.mjs';
import { decodeWslOutput } from './lib/wsl.mjs';
import { SKIP_REASONS } from './lib/matrix.mjs';
import { PENALIZED_KEYS } from './lib/cell.mjs';
import {
    cliUnderTestOracle,
    collectVersions,
    defaultExec,
    gatingDrift,
    identityVersion,
    inverseIdentity,
    makeGh,
    REPO,
    STORE_PACKAGE,
} from './lib/versions.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> <skill>/ -> skills/ -> .claude/ -> repo root.
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..');
const NAME = 'transfer-audit';
const PROD = Object.freeze({
    server: 'https://api.floe.one',
    web: 'https://www.floe.one',
});
const LOCAL = Object.freeze({
    server: 'http://localhost:3001',
    web: 'http://localhost:3000',
});
const WIN = process.platform === 'win32';
const PS = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
];

const realFs = { existsSync, statSync };

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function writeJson(file, data) {
    writeFileSync(file, JSON.stringify(data, null, 4) + '\n');
}

function gitStatus(root, exec) {
    try {
        return exec('git', ['status', '--porcelain'], { cwd: root });
    } catch {
        return null;
    }
}

function worktreeRoots(root, exec) {
    try {
        const out = exec('git', ['worktree', 'list', '--porcelain'], {
            cwd: root,
        });
        return out
            .split(/\r?\n/)
            .filter((l) => l.startsWith('worktree '))
            .map((l) => l.slice('worktree '.length).trim());
    } catch {
        return [root];
    }
}

/**
 * --out and --bin-dir must not sit inside any Floe checkout (the main
 * checkout or a worktree): the run writes ledger.json, probe.json, run dirs
 * and side-loaded binaries there, and the fence's HEAD-build carve-out
 * would otherwise let them land in the tree. Exit 2, before anything is
 * created.
 */
function refuseCheckoutDirs(opts, roots) {
    for (const dir of [opts.out, opts.binDir].filter(Boolean)) {
        const root = roots.find((r) => isUnder(dir, r));
        if (root)
            throw new UsageError(
                `${dir} is inside the checkout ${root}; use a scratch dir for --out and --bin-dir`
            );
    }
}

/** Fence for a subcommand, built before any directory or log file exists. */
function fenceFor(opts, io, exec, { allow = [] } = {}) {
    const roots = worktreeRoots(opts.root, exec);
    refuseCheckoutDirs(opts, roots);
    return createFence({
        allow: allow.filter(Boolean),
        repoRoots: roots,
        appData: io.appData,
    });
}

function hostInfo(clientDir, exec) {
    const info = {
        hostname: os.hostname(),
        os: `${WIN ? 'Windows' : os.type()} ${os.release()}`,
        node: process.version,
        go: null,
        playwright: null,
        chromiumRevision: null,
    };
    try {
        info.go = exec('go', ['version']).replace(/^go version\s+/, '');
    } catch {
        info.go = null;
    }
    try {
        const req = createRequire(path.join(clientDir, 'package.json'));
        info.playwright = req('@playwright/test/package.json').version;
        const browsers = req('playwright-core/browsers.json');
        const c = (browsers.browsers || []).find((b) => b.name === 'chromium');
        info.chromiumRevision = c ? c.revision : null;
    } catch {
        // Reported as missing by the infra row.
    }
    return info;
}

function playwrightCheck(clientDir) {
    try {
        const req = createRequire(path.join(clientDir, 'package.json'));
        const pw = req('@playwright/test');
        const exe = pw.chromium.executablePath();
        const present = existsSync(exe);
        return {
            ok: present,
            detail: present
                ? `@playwright/test ${req('@playwright/test/package.json').version}, ${path.basename(path.dirname(path.dirname(exe)))}`
                : `chromium missing at ${exe}: run playwright install chromium from client/`,
        };
    } catch (e) {
        return {
            ok: false,
            detail: `@playwright/test not resolvable from ${clientDir}: ${e.message.split('\n')[0]}`,
        };
    }
}

function diskFree(dir) {
    try {
        const s = statfsSync(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return null;
    }
}

function selfTest(out) {
    const checks = [];
    const check = (name, fn) => {
        try {
            const r = fn();
            checks.push([
                r === true ? 'ok  ' : 'FAIL',
                name,
                r === true ? '' : String(r),
            ]);
        } catch (e) {
            checks.push(['FAIL', name, e.message]);
        }
    };
    check(
        'identityVersion desktop-v3.4.5 -> 4.4.5.0',
        () =>
            identityVersion('desktop-v3.4.5') === '4.4.5.0' ||
            identityVersion('desktop-v3.4.5')
    );
    check(
        'inverseIdentity 4.4.5.0 -> 3.4.5',
        () =>
            inverseIdentity('4.4.5.0') === '3.4.5' || inverseIdentity('4.4.5.0')
    );
    check('classifyIce cloudflare shape', () => {
        const r = classifyIce([
            { urls: ['stun:a:3478'] },
            {
                urls: [
                    'turn:a:3478?transport=udp',
                    'turns:a:443?transport=tcp',
                ],
                username: 'u',
                credential: 'c',
            },
        ]);
        return (
            (r.servesTurn &&
                r.schemes.join(',') === 'stun,turn,turns' &&
                !JSON.stringify(r).includes('credential')) ||
            JSON.stringify(r)
        );
    });
    check(
        'classifyRoute relay from getStats',
        () =>
            classifyRoute({
                samples: [
                    {
                        pcs: [
                            {
                                policy: 'relay',
                                pair: { local: 'relay', remote: 'srflx' },
                            },
                        ],
                    },
                ],
            }).verdict === 'relay' || 'not relay'
    );
    check('Ledger waits at the TURN edge', () => {
        let t = 0;
        const l = new Ledger({ now: () => t });
        for (let i = 0; i < 10; i++) l.commit({ turn: 1 }, (t = i * 100));
        return l.waitMs({ turn: 1 }, 1000) > 0 || 'no wait';
    });
    check('cellPlan default 18 / quick 6 / deep 35', () => {
        const d = cellPlan().length;
        const q = cellPlan({ subset: 'quick' }).length;
        const x = cellPlan({ subset: 'deep' }).length;
        return (d === 18 && q === 6 && x === 35) || `${d}/${q}/${x}`;
    });
    check(
        'cellPlan receivers carry statsOff',
        () =>
            cellPlan({ subset: 'deep' }).every(
                (c) => c.receiver.statsOff === true
            ) || 'missing'
    );
    check('exit precedence 2,4,3,1,5,6,0', () => {
        const cells = [{ verdict: 'FAIL' }, { verdict: 'SKIP' }];
        const versions = [{ gate: true, status: 'STALE' }];
        return (
            (exitCodeFor({ usage: true, safety: true }) === 2 &&
                exitCodeFor({ safety: true, precondition: true, cells }) ===
                    4 &&
                exitCodeFor({ precondition: true, cells }) === 3 &&
                exitCodeFor({ cells, versions }) === 1 &&
                exitCodeFor({ cells: [{ verdict: 'SKIP' }], versions }) === 5 &&
                exitCodeFor({ cells: [{ verdict: 'PASS' }], versions }) === 6 &&
                exitCodeFor({
                    cells: [{ verdict: 'PASS' }, { verdict: 'NA' }],
                }) === 0) ||
            'precedence broken'
        );
    });
    check(
        'matchCells glob',
        () =>
            (matchCells('S-REL-W2C', ['S-REL-*']) &&
                !matchCells('S-DIR-W2C', ['S-REL-*'])) ||
            'glob'
    );
    let failed = 0;
    for (const [status, name, detail] of checks) {
        if (status === 'FAIL') failed += 1;
        out(`${status} ${name}${detail ? `: ${detail}` : ''}`);
    }
    out(
        `${NAME}: self-test ${failed ? `${failed} failure(s)` : 'green'} (${checks.length} checks)`
    );
    return failed ? 1 : 0;
}

class Precondition extends Error {
    constructor(message) {
        super(message);
        this.name = 'Precondition';
        this.exitCode = 3;
    }
}

function makeLogger(file, echo) {
    return (line) => {
        const text = `[${new Date().toISOString()}] ${line}`;
        try {
            appendFileSync(file, text + '\n');
        } catch {
            // The log is best effort; the run record is the truth.
        }
        if (echo) echo(text);
    };
}

// ---------------------------------------------------------------------------
// Probes (P3, P4, P5, P7 here; P1, P2, P6, P8, P9 through the desktop adapter)
// ---------------------------------------------------------------------------

/**
 * Accepts the raw bytes of `wsl -l -v` (UTF-16LE by default, UTF-8 under
 * WSL_UTF8=1; lib/wsl.mjs decodeWslOutput sniffs which) or an already
 * decoded string.
 */
function parseWslList(input) {
    const lines = decodeWslOutput(input).split(/\r?\n/);
    for (const l of lines) {
        const m = /^\s*\*?\s*(Ubuntu-22\.04)\s+(\w+)/.exec(l);
        if (m)
            return {
                present: true,
                running: m[2].toLowerCase() === 'running',
                state: m[2],
            };
    }
    return { present: false, running: false, state: null };
}

function probeWsl(exec) {
    if (!WIN) return { present: false, running: false, state: 'not windows' };
    try {
        // Bytes, not a decoded string: latin1 maps each byte to one code
        // unit and raw keeps the leading byte a trim would eat, so the
        // listing decodes correctly whether wsl printed UTF-16LE or UTF-8.
        const out = exec('wsl.exe', ['-l', '-v'], {
            encoding: 'latin1',
            raw: true,
            timeout: 15_000,
        });
        return parseWslList(
            Buffer.isBuffer(out)
                ? out
                : Buffer.from(String(out ?? ''), 'latin1')
        );
    } catch (e) {
        return {
            present: false,
            running: false,
            state: `wsl -l failed: ${e.message.split('\n')[0]}`,
        };
    }
}

function probeFirewall(exec, binDir) {
    if (!WIN || !binDir)
        return { inboundAllow: null, rules: [], detail: 'not probed' };
    try {
        const out = exec(
            'powershell.exe',
            [
                ...PS,
                `Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '${binDir.replace(/'/g, "''")}*' } | ForEach-Object { $_ | Get-NetFirewallRule } | Select-Object DisplayName,Direction,Action,Enabled | ConvertTo-Json -Compress`,
            ],
            { timeout: 60_000 }
        );
        const parsed = out.trim() ? JSON.parse(out) : [];
        const rules = Array.isArray(parsed) ? parsed : [parsed];
        const allow = rules.some((r) =>
            String(r.Direction) === '1' || /inbound/i.test(String(r.Direction))
                ? (String(r.Action) === '2' ||
                      /allow/i.test(String(r.Action))) &&
                  (r.Enabled === 1 ||
                      r.Enabled === true ||
                      /true/i.test(String(r.Enabled)))
                : false
        );
        const block = rules.some(
            (r) => String(r.Action) === '4' || /block/i.test(String(r.Action))
        );
        return {
            inboundAllow: rules.length ? allow : false,
            block,
            rules,
            detail: rules.length ? `${rules.length} rule(s)` : 'none',
        };
    } catch (e) {
        return {
            inboundAllow: null,
            rules: [],
            detail: `read failed: ${e.message.split('\n')[0]}`,
        };
    }
}

function probeMotw(exec, exe, fence, { desktopMode = 'auto' } = {}) {
    if (!WIN) return { marked: null, detail: 'not windows' };
    if (!exe || !existsSync(exe))
        return {
            marked: null,
            detail:
                desktopMode === 'none'
                    ? 'n/a (--desktop none)'
                    : 'n/a (store build; no portable exe staged, so nothing to unblock)',
        };
    try {
        const out = exec(
            'powershell.exe',
            [
                ...PS,
                `if (Get-Item -LiteralPath '${exe.replace(/'/g, "''")}' -Stream Zone.Identifier -ErrorAction SilentlyContinue) { 'marked' } else { 'clean' }`,
            ],
            { timeout: 30_000 }
        );
        if (out.trim() === 'marked') {
            fence.assertWritable(exe);
            exec(
                'powershell.exe',
                [
                    ...PS,
                    `Unblock-File -LiteralPath '${exe.replace(/'/g, "''")}'`,
                ],
                { timeout: 30_000 }
            );
            return {
                marked: true,
                unblocked: true,
                detail: 'Zone.Identifier removed from our own file',
            };
        }
        return { marked: false, detail: 'no Zone.Identifier stream' };
    } catch (e) {
        return {
            marked: null,
            detail: `read failed: ${e.message.split('\n')[0]}`,
        };
    }
}

async function localServerUp(fetchImpl) {
    try {
        const r = await getJson(`${LOCAL.server}/health`, {
            timeoutMs: 2000,
            fetchImpl,
        });
        return r.status === 200;
    } catch {
        return false;
    }
}

/**
 * What the desktop probes need that `probe` does not resolve through
 * resolveBuilds: the concrete launch mode (auto picks the Store build when
 * it is installed) and a portable exe for P2 and P7, found under --bin-dir
 * in either layout or side-loaded when --desktop portable asks for it.
 */
async function probeDesktopInputs({
    opts,
    io,
    desktop,
    builds,
    versions,
    log,
}) {
    const exec = io.exec || defaultExec;
    const gh = io.gh || makeGh(exec);
    const info = {};
    let mode = opts.desktop;
    let build = builds?.desktop ?? null;
    if (mode === 'auto' && build?.launch) mode = build.launch;
    if (mode === 'auto') {
        const pkg =
            typeof desktop.storePackage === 'function'
                ? await desktop.storePackage()
                : { present: false };
        mode = pkg.present ? 'store' : 'portable';
        info.storeVersion = pkg.present ? pkg.version : null;
        log(
            `probe desktop: --desktop auto -> ${mode}${pkg.present ? ` (Store ${pkg.version})` : ' (no Store package)'}`
        );
    }
    const tag = versions?.latest?.desktop ?? null;
    let portableExe =
        build && (build.launch === 'portable' || build.kind === 'head')
            ? (build.path ?? null)
            : null;
    if (!portableExe && tag && opts.binDir) {
        const staged = findStagedDesktop(opts.binDir, tag);
        if (staged) {
            portableExe = staged.path;
            info.portableSource = `${staged.layout} under --bin-dir${staged.verified ? ', SHA256SUMS verified' : ', unverified'}`;
            log(
                `probe desktop: portable ${tag} found at ${staged.path} (${info.portableSource})`
            );
        }
    }
    if (!portableExe && mode === 'portable' && tag) {
        const binDir = opts.binDir || path.join(opts.out, 'bin');
        mkdirSync(binDir, { recursive: true });
        const d = sideloadDesktop({ tag, dest: binDir, gh });
        portableExe = d.path;
        info.portableSource = 'side-loaded (SHA256SUMS verified)';
        log(`probe desktop: side-loaded ${tag} -> ${d.path}`);
    }
    if (mode === 'portable' && !build)
        build = portableExe
            ? {
                  kind: 'shipped',
                  launch: 'portable',
                  path: portableExe,
                  version: tag ? tag.replace(/^desktop-v/, '') : null,
                  isPackaged: false,
              }
            : null;
    if (mode === 'store' && !build)
        build = {
            kind: 'shipped',
            launch: 'store',
            path: null,
            isPackaged: true,
        };
    info.portableExe = portableExe;
    return { mode, build, portableExe, info };
}

function probeDetailText(r) {
    const d = r.detail;
    if (d === null || d === undefined) return '';
    if (typeof d === 'string') return ` (${d})`;
    const parts = [];
    for (const [k, v] of Object.entries(d)) {
        if (v && typeof v === 'object') {
            if (k === 'status' && v.kind) parts.push(`status=${v.kind}`);
            else if (k === 'real' && 'unchanged' in v)
                parts.push(`real unchanged=${v.unchanged}`);
            continue;
        }
        parts.push(`${k}=${v}`);
    }
    return parts.length ? ` (${parts.join(', ')})` : '';
}

async function runProbes({ opts, io, ledger, fence, log, builds, versions }) {
    const exec = io.exec || defaultExec;
    const pending = [];
    const probe = {
        at: new Date().toISOString(),
        turn: { prod: null, local: null },
        browserRelay: { ok: null, detail: 'pending' },
        desktop: {
            available: null,
            receiverDrivable: null,
            saveDirSettable: null,
            senderDrivable: null,
            present: null,
            focusNeeded: null,
            mode: opts.desktop,
            detail: 'pending',
        },
        wsl: { present: null, running: null, localOrigin: null },
        firewall: { inboundAllow: null },
        disk: { freeBytes: diskFree(opts.out) },
        motw: null,
        playwright: null,
        pending,
    };
    // P4 on production is one paced GET of scheme names, whatever the
    // profile; P3 (a browser transfer on floe.one) is shipped-only.
    {
        try {
            probe.turn.prod = await probeTurn(PROD.server, {
                ledger,
                fetchImpl: io.fetchImpl,
                sleep: io.sleep,
            });
            log(`probe P4 prod TURN: ${describeTurn(probe.turn.prod)}`);
        } catch (e) {
            probe.turn.prod = { servesTurn: null, error: e.message };
            log(`probe P4 prod TURN failed: ${e.message}`);
        }
    }
    if (await localServerUp(io.fetchImpl)) {
        try {
            probe.turn.local = await probeTurn(LOCAL.server, {
                fetchImpl: io.fetchImpl,
            });
            log(`probe P4 local TURN: ${describeTurn(probe.turn.local)}`);
        } catch (e) {
            probe.turn.local = { servesTurn: null, error: e.message };
        }
    } else
        probe.turn.local = {
            servesTurn: opts.profile === 'head' ? false : null,
            detail: 'local server not running',
        };
    probe.playwright = playwrightCheck(opts.clientDir);
    const web = await (io.tryAdapter || realTryAdapter)('web');
    if (
        web &&
        typeof web.probeRelay === 'function' &&
        opts.profile === 'shipped' &&
        probe.playwright.ok
    ) {
        try {
            const r = await web.probeRelay({
                clientDir: opts.clientDir,
                web: PROD.web,
                server: PROD.server,
                ledger,
                evidenceDir: path.join(opts.out, 'probe-evidence'),
                log,
            });
            probe.browserRelay = {
                ok: Boolean(r.ok),
                detail: r.detail ?? null,
            };
        } catch (e) {
            probe.browserRelay = {
                ok: null,
                detail: `probe failed: ${e.message}`,
            };
        }
    } else {
        probe.browserRelay = {
            ok: null,
            detail: web
                ? opts.profile !== 'shipped'
                    ? 'skipped (P3 is a production browser transfer; it runs under --profile shipped)'
                    : 'skipped (no chromium)'
                : 'pending',
        };
        if (!web) pending.push('P3 browser relay (web adapter)');
    }
    const desktop = await (io.tryAdapter || realTryAdapter)('desktop');
    if (opts.desktop === 'none')
        probe.desktop = {
            ...probe.desktop,
            available: false,
            detail: '--desktop none',
        };
    else if (desktop && typeof desktop.probe === 'function') {
        try {
            const d = await probeDesktopInputs({
                opts,
                io,
                desktop,
                builds,
                versions,
                log,
            });
            probe.desktop = { ...probe.desktop, ...d.info, mode: d.mode };
            const r = await desktop.probe({
                mode: d.mode,
                portableExe: d.portableExe,
                binDir: opts.binDir,
                out: opts.out,
                build: d.build,
                userAway: opts.userAway,
                pauseMaxMin: opts.pauseMaxMin,
                fence,
                log,
            });
            probe.desktop = { ...probe.desktop, ...r };
        } catch (e) {
            probe.desktop = {
                ...probe.desktop,
                detail: `probe failed: ${e.message}`,
            };
        }
    } else pending.push('P1 P2 P6 P8 P9 desktop (desktop adapter)');
    probe.wsl = { ...probe.wsl, ...probeWsl(exec) };
    // The effective staged-binary dir, not just an operator override, or
    // the probe reports "not probed" on every default run.
    probe.firewall = probeFirewall(
        exec,
        opts.binDir || (opts.out ? path.join(opts.out, 'bin') : null)
    );
    // P7 only means something for an exe on disk: the portable build under
    // test, else the staged portable exe the desktop probe found.
    const motwExe = builds?.desktop?.path ?? probe.desktop?.portableExe ?? null;
    probe.motw = probeMotw(exec, motwExe, fence, { desktopMode: opts.desktop });
    return probe;
}

/**
 * The first line of run and probe output. The default profile is shipped,
 * which drives production floe.one and api.floe.one (P3 is a production
 * browser receive), so the profile in effect is said before anything runs.
 */
export function profileLine(opts) {
    const defaulted = opts.profile === 'shipped' && !opts.profileGiven;
    return `profile: ${opts.profile}${defaulted ? ' (default)' : ''}`;
}

/**
 * On the head profile the served web tree is the --client-dir checkout,
 * which need not be --root (a second worktree), so its label carries that
 * checkout's HEAD: { webRoot, sha7, version: 'local HEAD <sha7>' }.
 */
export function webHeadLabel({ root, clientDir, rootSha7 = null, exec }) {
    const webRoot = path.dirname(path.resolve(clientDir));
    let sha7 = path.resolve(root) === webRoot ? rootSha7 : null;
    if (!sha7) {
        try {
            sha7 = gitSha7(webRoot, { exec }) || null;
        } catch {
            sha7 = null;
        }
    }
    return {
        webRoot,
        sha7,
        version: sha7 ? `local HEAD ${sha7}` : 'local HEAD unknown',
    };
}

/** { localSha7, webLocalSha7 } for the Versions rows on the head profile. */
function headShas(opts, exec, io = {}) {
    if (opts.profile !== 'head') return {};
    let rootSha7 = io.sha7 ?? null;
    if (!rootSha7) {
        try {
            rootSha7 = gitSha7(opts.root, { exec }) || null;
        } catch {
            rootSha7 = null;
        }
    }
    const web = webHeadLabel({
        root: opts.root,
        clientDir: opts.clientDir,
        rootSha7,
        exec,
    });
    return { localSha7: rootSha7, webLocalSha7: web.sha7 };
}

function readProbe(outDir, log) {
    const file = path.join(outDir, 'probe.json');
    if (!existsSync(file)) return null;
    try {
        const p = JSON.parse(readFileSync(file, 'utf8'));
        const ageMin = (Date.now() - Date.parse(p.at || 0)) / 60000;
        if (ageMin > 24 * 60) {
            log(`probe.json is ${Math.round(ageMin / 60)} h old; re-probing`);
            return null;
        }
        return p;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Builds and infra
// ---------------------------------------------------------------------------

async function resolveBuilds({ opts, io, versions, log, fence, manifest }) {
    const exec = io.exec || defaultExec;
    const gh = io.gh || makeGh(exec);
    const binDir = opts.binDir || path.join(opts.out, 'bin');
    fence.allowDir(binDir);
    mkdirSync(binDir, { recursive: true });
    manifest.binDir = binDir;
    const builds = { cli: null, desktop: null, web: null, wsl: null };
    const tryAdapter = io.tryAdapter || realTryAdapter;
    if (opts.profile === 'shipped') {
        const tag = versions.latest.cli;
        if (!tag)
            throw new Precondition(
                'cannot resolve the latest CLI release (gh release view failed); run gh auth status'
            );
        const pick = selectCli({
            pathVersion: versions.pathCli.version,
            latestTag: tag,
            pin: opts.pin,
        });
        log(`cli: ${pick.source} (${pick.reason})`);
        if (pick.source === 'path') {
            builds.cli = {
                kind: 'shipped',
                source: 'path',
                tag,
                version: versions.pathCli.version,
                path: versions.pathCli.path,
                sha256: sha256Sync(versions.pathCli.path),
            };
        } else {
            const s = sideloadCli({ tag, dest: binDir, gh });
            builds.cli = {
                kind: 'shipped',
                source: 'sideload',
                tag,
                version: s.version,
                path: s.path,
                sha256: s.sha256,
                zip: s.zip,
            };
            log(
                `cli: side-loaded ${tag} -> ${s.path} (sha256 ${s.sha256.slice(0, 8)})`
            );
        }
        const dtag = versions.latest.desktop;
        if (opts.desktop === 'wailsdev')
            throw new Precondition(
                '--desktop wailsdev is a head-profile lane; use --profile head'
            );
        if (opts.desktop !== 'none') {
            const store =
                versions.rows.find((r) => r.surface === 'Desktop Store')
                    ?.detail || null;
            const storeProduct = store?.version
                ? inverseIdentity(store.version)
                : null;
            const storeCurrent = Boolean(
                storeProduct && dtag && `desktop-v${storeProduct}` === dtag
            );
            const useStore =
                opts.desktop === 'store' ||
                (opts.desktop === 'auto' && storeCurrent);
            if (useStore && store) {
                builds.desktop = {
                    kind: 'shipped',
                    launch: 'store',
                    version: storeProduct,
                    identityVersion: store.version,
                    path: null,
                    isPackaged: true,
                    tag: `desktop-v${storeProduct}`,
                    installLocation: store.installLocation,
                    pfn: store.pfn,
                };
                log(
                    `desktop: Store build ${storeProduct} (${store.version})${storeCurrent ? '' : ' STALE'}`
                );
            } else if (opts.desktop === 'store') {
                throw new Precondition(
                    `--desktop store but ${STORE_PACKAGE} is not installed`
                );
            } else if (dtag) {
                const staged = findStagedDesktop(binDir, dtag);
                if (staged)
                    log(
                        `desktop: portable ${dtag} already staged (${staged.layout}${staged.verified ? ', SHA256SUMS verified' : ', unverified'})`
                    );
                const d =
                    staged ?? sideloadDesktop({ tag: dtag, dest: binDir, gh });
                builds.desktop = {
                    kind: 'shipped',
                    launch: 'portable',
                    version: d.version,
                    identityVersion: null,
                    path: d.path,
                    sha256: d.sha256,
                    isPackaged: false,
                    tag: dtag,
                };
                log(
                    `desktop: portable ${dtag} -> ${d.path} (isPackaged=false)`
                );
            } else
                log(
                    'desktop: no desktop-v* release resolved; desktop cells will be unavailable'
                );
        }
        builds.web = {
            kind: 'shipped',
            origin: PROD.web,
            sha: versions.web?.sha ?? null,
            version: versions.web?.sha
                ? versions.web.sha.slice(0, 7)
                : 'unknown',
        };
    } else {
        const sha7 = io.sha7 || gitSha7(opts.root, { exec });
        for (const w of [
            path.join(opts.root, 'desktop', 'frontend', 'dist'),
            path.join(opts.root, 'desktop', 'build', 'bin'),
        ])
            fence.allowDir(w);
        const built = await buildHeadCli({
            root: opts.root,
            sha7,
            binDir,
            exec,
        });
        builds.cli = {
            kind: 'head',
            source: 'go build',
            tag: null,
            version: built.version,
            path: built.path,
            sha256: built.sha256,
            sha7,
            root: opts.root,
        };
        log(`cli: built ${built.version} -> ${built.path}`);
        if (opts.desktop !== 'none') {
            const desktop = await tryAdapter('desktop');
            const plan = headDesktopCommands({ root: opts.root, sha7 });
            if (desktop && typeof desktop.buildHead === 'function') {
                const d = await desktop.buildHead({
                    ...plan,
                    mode: opts.desktop,
                    root: opts.root,
                    fence,
                    log,
                    exec,
                });
                builds.desktop = {
                    kind: 'head',
                    launch:
                        opts.desktop === 'wailsdev' ? 'wailsdev' : 'portable',
                    version: plan.version,
                    path: d?.path ?? plan.exe,
                    isPackaged: false,
                    sha256: d?.sha256 ?? null,
                };
            } else {
                builds.desktop = null;
                log(
                    'desktop: HEAD desktop build pending (desktop adapter has no buildHead)'
                );
            }
        }
        const web = webHeadLabel({
            root: opts.root,
            clientDir: opts.clientDir,
            rootSha7: sha7,
            exec,
        });
        builds.web = {
            kind: 'head',
            origin: LOCAL.web,
            sha: null,
            version: web.version,
            sha7: web.sha7,
            clientDir: opts.clientDir,
        };
        log(`web: ${web.version} served from ${opts.clientDir}`);
    }
    const cli = await tryAdapter('cli');
    if (cli && typeof cli.preflight === 'function' && builds.cli) {
        const pf = await cli.preflight({
            bin: builds.cli.path,
            build: builds.cli,
        });
        if (!pf.ok) throw new Precondition(`cli preflight: ${pf.reason}`);
        builds.cli.hasRelayOnly = Boolean(pf.detail?.cliHasRelayOnly);
        builds.cli.version = pf.detail?.version || builds.cli.version;
    }
    builds.wsl = builds.cli
        ? { ...builds.cli, kind: builds.cli.kind, launch: 'wsl' }
        : null;
    if (builds.desktop) {
        const desktop = await tryAdapter('desktop');
        if (desktop && typeof desktop.preflight === 'function') {
            const pf = await desktop.preflight({
                build: builds.desktop,
                mode: opts.desktop,
                binDir,
                fence,
                log,
            });
            builds.desktop.preflight = pf;
            if (!pf.ok) log(`desktop preflight: ${pf.reason}`);
        }
    }
    return builds;
}

async function resolveInfra({ opts, io, ledger, log, manifest, safety }) {
    const rows = [];
    const fetchImpl = io.fetchImpl;
    let stackHandle = null;
    let infra;
    if (opts.profile === 'shipped') {
        let healthy = false;
        try {
            const r = await getJson(`${PROD.server}/health`, {
                timeoutMs: 10_000,
                fetchImpl,
            });
            healthy = r.status === 200 && r.json?.status === 'healthy';
            rows.push({
                check: 'api.floe.one /health',
                ok: healthy,
                detail: healthy
                    ? `healthy, uptime ${Math.round(r.json.uptime)} s`
                    : `HTTP ${r.status}`,
            });
        } catch (e) {
            rows.push({
                check: 'api.floe.one /health',
                ok: false,
                detail: e.message,
            });
        }
        if (!healthy) throw new Precondition('api.floe.one is not healthy');
        try {
            const h = await head(`${PROD.web}/`, {
                timeoutMs: 10_000,
                fetchImpl,
            });
            rows.push({
                check: 'floe.one',
                ok: h.status === 200,
                detail: `${h.status} via ${new URL(h.url).host}, etag ${h.headers.etag || 'none'}`,
            });
        } catch (e) {
            rows.push({ check: 'floe.one', ok: false, detail: e.message });
        }
        infra = {
            name: 'prod',
            server: PROD.server,
            web: PROD.web,
            servesTurn: null,
            relaxed: false,
            statsOracle: 'none',
        };
    } else {
        const stack = await (io.tryAdapter || realTryAdapter)('stack');
        if (!stack)
            throw new Precondition(
                'head profile needs lib/stack.mjs (floe-run wrapper), which is not available'
            );
        stackHandle = await stack.ensureStack({
            root: opts.root,
            clientDir: opts.clientDir,
            relaxed: opts.relaxed,
            evidenceDir: path.join(manifest.runDir, 'stack'),
            log,
        });
        manifest.stack = {
            owned: Boolean(stackHandle.owned),
            started: Boolean(stackHandle.started),
            root: stackHandle.root ?? null,
            client: Boolean(stackHandle.client),
        };
        const total =
            stackHandle.ready?.totalBytes ??
            stackHandle.report?.totalBytes ??
            null;
        const stackRelaxed =
            stackHandle.ready?.relaxed ?? stackHandle.report?.relaxed ?? null;
        rows.push({
            check: 'local stack (head)',
            ok: true,
            detail: `${stackHandle.started ? 'started by this run' : 'reused (owned by floe-run)'} from ${stackHandle.root ?? opts.root}, /api/stats totalBytes=${total ?? '?'}${stackRelaxed === null ? '' : stackRelaxed ? ', limiters relaxed' : ', limiters at production values'}`,
        });
        infra = {
            name: 'local',
            server: stackHandle.server || LOCAL.server,
            web: stackHandle.web || LOCAL.web,
            servesTurn: null,
            relaxed: Boolean(opts.relaxed),
            statsOracle: 'sentinel',
            stack: stackHandle,
        };
        safety.localStatsDeltaZero = true;
    }
    return { infra, rows, stackHandle };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Side-load the Linux release CLI into WSL for the L2\* cells and record it
 * as builds.wsl, or turn those cells into SKIP wsl-sideload. A Windows exe
 * can never run inside the distro, so there is no fallback: the leg gets
 * the Linux path or the cells do not run. Exported for the unit test,
 * because this is the one step whose failure is invisible in a green run.
 */
export async function prepareWslBuild({
    cells,
    builds,
    binDir,
    getAdapter,
    log = () => {},
}) {
    const wslCells = (cells || []).filter(
        (c) => !c.verdict && c.sender && c.sender.surface === 'wsl'
    );
    if (!wslCells.length) return null;
    const tag = builds.cli && builds.cli.tag;
    try {
        if (!tag)
            throw new Error(
                'the WSL cells need a tagged CLI (shipped profile)'
            );
        if (!binDir) throw new Error('no bin dir for the side-load');
        const wslMod = await getAdapter('wsl');
        const s = await wslMod.sideload({
            tag,
            dir: path.join(binDir, tag),
            repo: REPO,
        });
        builds.wsl = {
            ...builds.cli,
            launch: 'wsl',
            path: s.linuxBin,
            wslBin: s.linuxBin,
            version: s.floeVersion || builds.cli.version,
            sideload: {
                asset: s.asset,
                dir: s.dir,
                downloaded: s.downloaded,
                checksumLine: s.checksumLine,
                floeVersion: s.floeVersion,
            },
        };
        log(
            `wsl: ${s.asset} verified inside WSL (${s.checksumLine}); ${s.linuxBin} reports ${s.floeVersion ?? '?'}`
        );
        return builds.wsl;
    } catch (e) {
        builds.wsl = null;
        log(
            `wsl: side-load failed, ${wslCells.length} cell(s) SKIP wsl-sideload: ${String(e.message).split('\n')[0]}`
        );
        for (const c of wslCells) {
            c.verdict = 'SKIP';
            c.reason = 'wsl-sideload';
            c.note = SKIP_REASONS['wsl-sideload'];
        }
        return null;
    }
}

/**
 * Delete the bytes a run moved, once every cell that moved them has been
 * verified: the fixtures it generated and the files each receiver saved.
 * Never touches a report, a transcript, a capture or attempt.json, and
 * never looks outside the run directory it is given.
 */
export function purgeRunData(
    runDir,
    { keepData = false, log = () => {} } = {}
) {
    const targets = [];
    const add = (p) => {
        if (existsSync(p)) targets.push(p);
    };
    add(path.join(runDir, 'fixtures'));
    const cellsDir = path.join(runDir, 'cells');
    if (existsSync(cellsDir))
        for (const cell of readdirSync(cellsDir, { withFileTypes: true })) {
            if (!cell.isDirectory()) continue;
            const cellDir = path.join(cellsDir, cell.name);
            for (const attempt of readdirSync(cellDir, {
                withFileTypes: true,
            })) {
                if (!attempt.isDirectory()) continue;
                add(path.join(cellDir, attempt.name, 'out'));
                add(path.join(cellDir, attempt.name, 'send'));
            }
        }
    let bytes = 0;
    for (const t of targets) bytes += dirBytes(t);
    if (keepData) {
        log(
            `data kept: ${formatBytes(bytes)} of fixtures and received files (--keep-data)`
        );
        return {
            purged: false,
            freedBytes: 0,
            heldBytes: bytes,
            dirs: targets.length,
        };
    }
    let removed = 0;
    for (const t of targets) {
        try {
            rmSync(t, { recursive: true, force: true, maxRetries: 3 });
            removed += 1;
        } catch (e) {
            log(`purge: ${t}: ${e.message}`);
        }
    }
    log(
        `purged ${formatBytes(bytes)} of transferred data from ${removed} director${removed === 1 ? 'y' : 'ies'}; the report, transcripts and captures stay`
    );
    return { purged: true, freedBytes: bytes, heldBytes: 0, dirs: removed };
}

/** Total size of a directory tree, 0 when it is missing. */
function dirBytes(p) {
    let total = 0;
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else
                try {
                    total += statSync(full).size;
                } catch {
                    // A file removed under us contributes nothing.
                }
        }
    };
    walk(p);
    return total;
}

async function dryRun({ opts, io, out, log }) {
    const exec = io.exec || defaultExec;
    const results = [];
    const step = async (name, fn) => {
        try {
            const d = await fn();
            results.push(['ok  ', name, d]);
        } catch (e) {
            results.push(['FAIL', name, e.message.split('\n')[0]]);
        }
    };
    await step('gh', () => exec('gh', ['--version']).split(/\r?\n/)[0]);
    if (WIN)
        await step('PowerShell', () =>
            exec('powershell.exe', [
                ...PS,
                '$PSVersionTable.PSVersion.ToString()',
            ])
        );
    await step('node fetch GET', async () => {
        const r = await get(
            `${opts.profile === 'head' ? LOCAL.server : PROD.server}/health`,
            { timeoutMs: 10_000, fetchImpl: io.fetchImpl }
        );
        return `HTTP ${r.status}`;
    });
    await step('Playwright', () => {
        const r = playwrightCheck(opts.clientDir);
        if (!r.ok) throw new Error(r.detail);
        return r.detail;
    });
    await step('go', () => exec('go', ['version']));
    let failed = 0;
    for (const [s, n, d] of results) {
        if (s === 'FAIL') failed += 1;
        out(`${s} ${n}: ${d}`);
        log(`dry-run ${s.trim()} ${n}: ${d}`);
    }
    out(
        `${NAME}: dry-run ${failed ? `${failed} tool class(es) failed` : 'every tool class answered'}`
    );
    return failed ? EXIT.precondition : EXIT.clean;
}

export async function runCmd(opts, io = {}) {
    const out = io.stdout || ((s) => process.stdout.write(s + '\n'));
    const err = io.stderr || ((s) => process.stderr.write(s + '\n'));
    const exec = io.exec || defaultExec;
    const sleep = io.sleep || defaultSleep;
    const getAdapter = io.getAdapter || realGetAdapter;
    const tryAdapter = io.tryAdapter || realTryAdapter;
    const startedAt = new Date();
    const runId = `${stamp()}-${opts.profile}-${opts.subset}`;
    // A --cells filter that names nothing in this profile and subset is a
    // usage error (exit 2) before anything is created, probed, paced or
    // side-loaded: otherwise the whole preamble runs for a "0/0 PASS".
    if (opts.cells) {
        const plan = cellPlan({
            profile: opts.profile,
            subset: opts.subset,
            cells: opts.cells,
            cliHasRelayOnly: true,
        });
        if (!plan.some((c) => c.reason !== 'filtered' && c.verdict !== 'NA'))
            throw new UsageError(
                `--cells ${opts.cells.join(',')} matches no executable ${opts.profile}/${opts.subset} cell id`
            );
    }
    // The fence comes first: nothing is created, not even --out, until it
    // has vouched for the paths this run will write.
    const fence = fenceFor(opts, io, exec, { allow: [opts.out, opts.binDir] });
    fence.assertWritable(path.join(opts.out, 'probe.json'));
    fence.assertWritable(path.join(opts.out, 'ledger.json'));
    if (opts.binDir) fence.assertWritable(path.join(opts.binDir, 'probe'));
    const runDir = path.join(opts.out, runId);
    fence.assertWritable(path.join(runDir, 'log.txt'));
    mkdirSync(opts.out, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const log = makeLogger(
        path.join(runDir, 'log.txt'),
        io.echoLog ? out : null
    );
    const manifest = {
        runId,
        startedAt: startedAt.toISOString(),
        profile: opts.profile,
        subset: opts.subset,
        root: opts.root,
        clientDir: opts.clientDir,
        out: opts.out,
        runDir,
        binDir: opts.binDir || path.join(opts.out, 'bin'),
        // Only a bin dir this run created under --out is ours to delete;
        // an operator's --bin-dir is kept by cleanup whatever its flags.
        binDirOwned: !opts.binDir,
        pids: [],
        // Filled by lib/desktop.mjs the moment the Store-mode guard edits
        // the real desktop.json, so `cleanup` can replay the backup.
        desktop: {
            backup: null,
            configPath: null,
            sha256: null,
            restored: null,
        },
        stack: { owned: false, started: false },
        fixtureDirs: [path.join(runDir, 'fixtures')],
        appDataRedirect: null,
        flags: {
            strict: opts.strict,
            userAway: opts.userAway,
            pionTrace: opts.pionTrace,
            desktop: opts.desktop,
            pin: opts.pin,
            keep: opts.keep,
            relaxed: opts.relaxed,
        },
    };
    const writeManifest = () =>
        writeJson(path.join(runDir, 'manifest.json'), manifest);
    writeManifest();
    log(
        `run ${runId} started (profile ${opts.profile}, subset ${opts.subset})`
    );
    if (!opts.json) out(profileLine(opts));
    if (opts.dryRun) return dryRun({ opts, io, out, log });

    const safety = newSafety();
    const ledger =
        io.ledger ||
        Ledger.open(path.join(opts.out, 'ledger.json'), {
            relaxed: opts.profile === 'head' && opts.relaxed,
            now: io.now,
        });
    const run = {
        runId,
        profile: opts.profile,
        subset: opts.subset,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        durationS: 0,
        root: opts.root,
        outDir: runDir,
        scratch: opts.out,
        host: hostInfo(opts.clientDir, exec),
        commits: {
            local: null,
            branch: null,
            main: null,
            web: null,
            server: null,
        },
        binaries: { cli: null, desktop: null, web: null },
        flags: manifest.flags,
        relayBytes: 0,
        cells: [],
        versions: [],
        infra: [],
        safety,
        pacing: null,
        probe: null,
        aborted: null,
        interrupted: false,
        exitCode: null,
        headline: null,
        artifacts: {
            reportMd: path.join(runDir, 'audit.md'),
            runJson: path.join(runDir, 'run.json'),
            cellsDir: path.join(runDir, 'cells'),
            ledger: ledger.file,
            versionsJson: path.join(runDir, 'versions.json'),
            manifest: path.join(runDir, 'manifest.json'),
            log: path.join(runDir, 'log.txt'),
        },
    };
    const gitBefore = gitStatus(opts.root, exec);
    let stackHandle = null;
    let interrupted = false;
    let safetyTripped = false;
    let precondition = null;
    const adaptersUsed = new Set();
    const finalize = async () => {
        for (const name of adaptersUsed) {
            try {
                const mod = await tryAdapter(name);
                if (mod && typeof mod.shutdown === 'function')
                    await mod.shutdown({ log, manifest });
            } catch (e) {
                log(`shutdown ${name}: ${e.message}`);
            }
        }
        const proc = await tryAdapter('proc');
        if (proc && typeof proc.killAllStarted === 'function') {
            for (const r of proc.killAllStarted())
                if (r.killed) safety.killedPids.push(r.pid);
        }
        if (stackHandle && manifest.stack.started) {
            try {
                const stack = await tryAdapter('stack');
                const r = stack
                    ? await stack.stopStack(stackHandle, { log })
                    : null;
                if (r && r.stopped) {
                    manifest.stack.started = false;
                    manifest.stack.stoppedAt = new Date().toISOString();
                    log(
                        `stack stopped (floe-run stop exit ${r.stopExit}; hygiene ${JSON.stringify(r.hygiene)})`
                    );
                }
            } catch (e) {
                log(`stack stop: ${e.message}`);
            }
        }
        const gitAfter = gitStatus(opts.root, exec);
        safety.workingTreeUnchanged =
            gitBefore === null || gitAfter === null
                ? null
                : gitBefore === gitAfter;
        safety.refusals = fence.refusals;
        run.finishedAt = new Date().toISOString();
        run.durationS = Number(
            ((Date.now() - startedAt.getTime()) / 1000).toFixed(1)
        );
        run.pacing = ledger.summary();
        run.interrupted = interrupted;
        run.exitCode = exitCodeFor({
            safety: safetyTripped,
            precondition: Boolean(precondition),
            interrupted,
            cells: run.cells,
            strict: opts.strict,
            versions: run.versions,
        });
        run.headline = headline(run);
        run.relayBytes = relayBytesOf(run.cells);
        // Every byte that moved has already been hashed and compared, and
        // both hashes are in run.json, so the payloads themselves are dead
        // weight: a deep run leaves several GB of fixtures and received
        // copies behind. Purge them unless the operator asked to keep them.
        // Reports, transcripts, captures and attempt.json always stay.
        run.dataPurge = purgeRunData(runDir, { keepData: opts.keepData, log });
        try {
            ledger.save();
            writeJson(run.artifacts.runJson, buildRunJson(run));
            writeFileSync(run.artifacts.reportMd, renderMarkdown(run));
            writeManifest();
        } catch (e) {
            log(`report write: ${e.message}`);
        }
        log(`run ${runId} finished: exit ${run.exitCode} (${run.headline})`);
        if (opts.json) out(JSON.stringify(buildRunJson(run), null, 4));
        else {
            out(renderMarkdown(run));
            out(
                `${NAME}: exit ${run.exitCode}; report ${run.artifacts.reportMd}`
            );
        }
        return run.exitCode;
    };
    const onSignal = async () => {
        interrupted = true;
        run.aborted = { reason: 'interrupted' };
        log('interrupted; tearing down');
        const code = await finalize();
        process.exit(code);
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    if (!io.noSignals) for (const s of signals) process.once(s, onSignal);
    try {
        // Versions (recorded; gating rows feed exit 6, never a stop).
        const versions = io.versions
            ? io.versions
            : await collectVersions({
                  root: opts.root,
                  exec,
                  gh: io.gh,
                  fetchImpl: io.fetchImpl,
                  webSha: opts.webSha,
                  webShaFile: opts.webShaFile,
                  serverSha: opts.serverSha,
                  webUrl: PROD.web,
                  serverUrl: PROD.server,
                  pin: opts.pin,
                  profile: opts.profile,
                  ...headShas(opts, exec, io),
                  storeUsed:
                      opts.desktop === 'store' || opts.desktop === 'auto',
                  log,
              });
        run.versions = versions.rows;
        run.commits = {
            local: versions.localCommit?.sha ?? null,
            branch: versions.localCommit?.branch ?? null,
            main: versions.mainSha ?? null,
            web: versions.web?.sha ?? null,
            server: opts.serverSha ?? null,
        };
        writeJson(run.artifacts.versionsJson, {
            rows: versions.rows,
            latest: versions.latest,
            mainSha: versions.mainSha,
            web: versions.web,
            localCommit: versions.localCommit,
        });
        log(
            `versions: ${versions.rows.map((r) => `${r.surface}=${r.status}`).join(', ')}`
        );

        // Builds.
        const builds = io.builds
            ? io.builds
            : await resolveBuilds({ opts, io, versions, log, fence, manifest });
        run.binaries = {
            cli: builds.cli
                ? {
                      tag: builds.cli.tag,
                      path: builds.cli.path,
                      sha256: builds.cli.sha256,
                      version: builds.cli.version,
                      source: builds.cli.source,
                  }
                : null,
            desktop: builds.desktop
                ? {
                      kind: builds.desktop.launch,
                      version: builds.desktop.version,
                      identityVersion: builds.desktop.identityVersion ?? null,
                      path: builds.desktop.path ?? null,
                      isPackaged: builds.desktop.isPackaged ?? null,
                  }
                : null,
            web: builds.web
                ? {
                      origin: builds.web.origin,
                      sha: builds.web.sha ?? null,
                      etag: null,
                  }
                : null,
        };
        if (!io.versions && builds.cli) {
            const row = run.versions.find(
                (r) => r.surface === 'CLI under test'
            );
            if (row)
                Object.assign(row, {
                    installed: `${builds.cli.version} (${builds.cli.source})`,
                    oracle: cliUnderTestOracle(builds.cli),
                    status:
                        opts.profile === 'head'
                            ? 'INFO'
                            : builds.cli.tag &&
                                builds.cli.version ===
                                    builds.cli.tag.replace(/^v/, '')
                              ? 'CURRENT'
                              : 'UNKNOWN',
                    detail: {
                        path: builds.cli.path,
                        sha256: builds.cli.sha256,
                    },
                });
        }
        if (!io.versions && builds.desktop) {
            const row = run.versions.find(
                (r) => r.surface === 'Desktop under test'
            );
            if (row)
                Object.assign(row, {
                    installed: `${builds.desktop.launch} ${builds.desktop.version}${builds.desktop.isPackaged === false ? ' (unpackaged)' : ''}`,
                    oracle:
                        builds.desktop.launch === 'store'
                            ? 'Get-AppxPackage'
                            : 'VerQueryValue; SHA256SUMS.txt',
                    status:
                        opts.profile === 'head'
                            ? 'INFO'
                            : builds.desktop.tag === versions.latest?.desktop
                              ? 'CURRENT'
                              : 'STALE',
                    gate: opts.profile !== 'head',
                    detail: run.binaries.desktop,
                });
        }

        // Infra.
        let infra;
        if (io.infra) {
            infra = io.infra;
            run.infra = io.infraRows || [];
        } else {
            const r = await resolveInfra({
                opts,
                io,
                ledger,
                log,
                manifest,
                safety,
            });
            infra = r.infra;
            run.infra = r.rows;
            stackHandle = r.stackHandle;
            writeManifest();
        }
        run.infra.push({
            check: 'Playwright',
            ...playwrightCheck(opts.clientDir),
        });
        run.infra.push({
            check: 'gh auth',
            ok: versions.ghOk !== false,
            detail:
                versions.ghOk === false
                    ? 'gh release view failed; run gh auth login'
                    : 'ok',
        });

        // Probes (P3-P5, P7 here; the rest through the desktop adapter).
        let probe = io.probe ?? readProbe(opts.out, log);
        if (!probe) {
            probe = await runProbes({
                opts,
                io,
                ledger,
                fence,
                log,
                builds,
                versions,
            });
            fence.assertWritable(path.join(opts.out, 'probe.json'));
            writeJson(path.join(opts.out, 'probe.json'), probe);
        }
        if (opts.profile === 'head' && !io.probe) {
            // probe.json may predate this stack; the local TURN answer is
            // one GET and decides whether relay cells run at all.
            try {
                const local = await probeTurn(infra.server, {
                    fetchImpl: io.fetchImpl,
                });
                probe = { ...probe, turn: { ...(probe.turn || {}), local } };
                log(`probe P4 local TURN (re-probed): ${describeTurn(local)}`);
            } catch (e) {
                log(`probe P4 local TURN re-probe failed: ${e.message}`);
            }
        }
        run.probe = probe;
        if (probe.turn?.prod)
            run.infra.push({
                check: 'api.floe.one TURN',
                ok:
                    probe.turn.prod.servesTurn !== false &&
                    probe.turn.prod.bodyJson !== false,
                detail: describeTurn(probe.turn.prod),
            });
        if (probe.turn?.local)
            run.infra.push({
                check: 'local TURN (head)',
                ok: true,
                detail:
                    probe.turn.local.detail || describeTurn(probe.turn.local),
            });
        if (probe.wsl)
            run.infra.push({
                check: 'WSL Ubuntu-22.04 (deep)',
                ok: true,
                detail: probe.wsl.present
                    ? probe.wsl.running
                        ? 'Running'
                        : 'Stopped (started on demand for deep cells)'
                    : 'absent',
            });
        if (probe.firewall)
            run.infra.push({
                check: 'firewall (side-loaded)',
                ok: !probe.firewall.block,
                detail: probe.firewall.block
                    ? 'BLOCK rule on the staged path'
                    : probe.firewall.inboundAllow
                      ? 'inbound Allow present'
                      : probe.firewall.inboundAllow === false
                        ? 'none'
                        : probe.firewall.detail || 'not probed',
            });
        if (probe.firewall?.block)
            throw new Precondition(
                'a Block firewall rule covers the staged exe path'
            );
        infra.servesTurn =
            opts.profile === 'head'
                ? (probe.turn?.local?.servesTurn ?? false)
                : (probe.turn?.prod?.servesTurn ?? null);
        if (
            builds.desktop &&
            builds.desktop.preflight &&
            builds.desktop.preflight.ok === false
        )
            probe = {
                ...probe,
                desktop: {
                    ...(probe.desktop || {}),
                    available: false,
                    detail: builds.desktop.preflight.reason,
                },
            };
        if (!builds.desktop && opts.desktop !== 'none')
            probe = {
                ...probe,
                desktop: {
                    ...(probe.desktop || {}),
                    available: false,
                    headBuild: opts.profile === 'head' ? false : undefined,
                },
            };

        // Plan.
        const cells = cellPlan({
            profile: opts.profile,
            subset: opts.subset,
            probe,
            cliHasRelayOnly: Boolean(builds.cli?.hasRelayOnly),
            cells: opts.cells,
            desktopMode: opts.desktop,
        });
        if (typeof io.cellHook === 'function') io.cellHook(cells);
        log(
            `plan: ${cells.length} cells (${cells.filter((c) => !c.verdict).length} executable)`
        );
        await prepareWslBuild({
            cells,
            builds,
            binDir: manifest.binDir,
            getAdapter,
            log,
        });
        const buildFor = (surface) => builds[surface] || null;
        const proc = await tryAdapter('proc');
        const ctx = {
            getAdapter: async (name) => {
                adaptersUsed.add(name);
                return getAdapter(name);
            },
            ledger,
            infra,
            buildFor,
            evidenceRoot: runDir,
            monitor: opts.monitor,
            fixturesDir: path.join(runDir, 'fixtures'),
            log,
            safety,
            retry: { used: 0, cap: io.retryCap ?? RETRY_CAP },
            sleep,
            killTree: async (pid) => {
                const p = proc || (await getAdapter('proc'));
                return p.killTree(pid);
            },
            statsOracle:
                infra.statsOracle === 'sentinel'
                    ? {
                          read: async () =>
                              (await getAdapter('stack')).statsTotal(
                                  infra.server
                              ),
                      }
                    : null,
            pionTrace: opts.pionTrace,
            cliHasRelayOnly: Boolean(builds.cli?.hasRelayOnly),
            userAway: opts.userAway,
            pauseMaxMin: opts.pauseMaxMin,
            shared: {
                fence,
                manifest,
                writeManifest,
                runDir,
                binDir: manifest.binDir,
                clientDir: opts.clientDir,
            },
            onPid: (pid, label) => {
                if (!pid) return;
                let image = null;
                try {
                    image =
                        proc && typeof proc.processImage === 'function'
                            ? proc.processImage(pid)
                            : null;
                } catch {
                    image = null;
                }
                // The creation stamp lets `cleanup` tell this incarnation
                // from a recycled pid; the registry may still be looking
                // it up, in which case the entry is completed in place.
                const known =
                    proc && proc.started instanceof Map
                        ? proc.started.get(pid)
                        : null;
                const entry = {
                    pid,
                    label,
                    image,
                    creation: known?.creation ?? null,
                    at: new Date().toISOString(),
                };
                manifest.pids.push(entry);
                writeManifest();
                if (
                    entry.creation === null &&
                    proc &&
                    typeof proc.creationTimeAsync === 'function'
                )
                    proc.creationTimeAsync(pid)
                        .then((c) => {
                            if (!c || entry.creation !== null) return;
                            entry.creation = c;
                            try {
                                writeManifest();
                            } catch {
                                // The run dir is gone; nothing to record.
                            }
                        })
                        .catch(() => {});
            },
            retryWaitMs: io.retryWaitMs,
            drainWaitMs: io.drainWaitMs,
        };
        let consecutiveInfra = 0;
        for (const cell of cells) {
            if (interrupted) break;
            if (run.aborted && !cell.verdict) {
                cell.verdict = 'SKIP';
                cell.reason = 'infra-down';
                cell.note =
                    'two consecutive infra symptoms; remaining production cells skipped';
            }
            let result;
            try {
                result = await runCell(cell, ctx);
            } catch (e) {
                if (e instanceof SafetyError || e.fence) {
                    safetyTripped = true;
                    log(`SAFETY ${cell.id}: ${e.message}`);
                    result = {
                        id: cell.id,
                        profile: cell.profile === 'H' ? 'head' : 'shipped',
                        path: cell.path,
                        variant: cell.variant,
                        sender: { surface: cell.sender.letter },
                        receiver: {
                            surface: cell.receiver.letter,
                            input: cell.receiver.input,
                        },
                        fixture: {
                            kind: cell.fixture.kind,
                            files: [],
                            totalBytes: cell.fixture.totalBytes,
                        },
                        verdict: 'ERROR',
                        reason: 'safety',
                        triage: null,
                        note: e.message,
                        attempts: [],
                        route: {
                            expected: cell.path === 'REL' ? 'relay' : 'direct',
                            observed: 'unobserved',
                            label: '-',
                            sources: [],
                        },
                        integrity: { ok: null, files: [] },
                        completion: {},
                        stats: {},
                        metrics: {},
                        durationS: 0,
                        countsForExit: true,
                    };
                    run.cells.push(result);
                    out(`PROGRESS ${cell.id} ${result.verdict}`);
                    run.aborted = { reason: `safety: ${e.message}` };
                    break;
                }
                throw e;
            }
            result.countsForExit = countsForExit({
                verdict: result.verdict,
                reason: result.reason,
            });
            run.cells.push(result);
            out(`PROGRESS ${cell.id} ${result.verdict}`);
            log(
                `${cell.id}: ${result.verdict}${result.reason ? ` ${result.reason}` : ''}${result.note ? ` (${result.note})` : ''}`
            );
            if (result.infraSymptom) {
                consecutiveInfra += 1;
                ledger.penalize();
            } else if (!cell.verdict) {
                consecutiveInfra = 0;
                // pacing.mjs counts CONSECUTIVE symptoms: a cell that ended
                // for any other reason clears them, so two recovered limiter
                // flakes far apart in a run never read as infra down.
                // On what the cell actually did, not on its key: a cell
                // that never penalized must not bridge two flakes.
                if (!result.penalized) ledger.clearSymptoms();
            }
            if (
                consecutiveInfra >= 2 &&
                infra.name === 'prod' &&
                !run.aborted
            ) {
                run.aborted = {
                    reason: 'infra-down: two consecutive signaling failures',
                };
                precondition = run.aborted.reason;
                log(run.aborted.reason);
            }
            if (
                opts.subset === 'quick' &&
                QUICK_IDS.length &&
                ledger.infraDown() &&
                infra.name === 'prod' &&
                !run.aborted
            ) {
                run.aborted = { reason: 'infra-down: limiter symptoms' };
                precondition = run.aborted.reason;
            }
        }
    } catch (e) {
        if (e instanceof Precondition) {
            precondition = e.message;
            run.aborted = { reason: e.message };
            log(`precondition: ${e.message}`);
            err(`${NAME}: ${e.message}`);
        } else if (e instanceof SafetyError || e.fence) {
            safetyTripped = true;
            run.aborted = { reason: `safety: ${e.message}` };
            log(`SAFETY: ${e.message}`);
            err(`${NAME}: safety invariant tripped: ${e.message}`);
        } else {
            run.aborted = { reason: `harness: ${e.message}` };
            precondition = run.aborted.reason;
            log(`harness error: ${e.stack || e.message}`);
            err(`${NAME}: ${e.message}`);
        }
    } finally {
        if (!io.noSignals)
            for (const s of signals) process.removeListener(s, onSignal);
    }
    return finalize();
}

// ---------------------------------------------------------------------------
// probe, versions, cleanup
// ---------------------------------------------------------------------------

export async function probeCmd(opts, io = {}) {
    const out = io.stdout || ((s) => process.stdout.write(s + '\n'));
    const err = io.stderr || ((s) => process.stderr.write(s + '\n'));
    const exec = io.exec || defaultExec;
    // Fence first, then the directory and the log it vouched for.
    const fence = fenceFor(opts, io, exec, { allow: [opts.out, opts.binDir] });
    fence.assertWritable(path.join(opts.out, 'probe.json'));
    fence.assertWritable(path.join(opts.out, 'probe.log'));
    fence.assertWritable(path.join(opts.out, 'ledger.json'));
    if (opts.binDir) fence.assertWritable(path.join(opts.binDir, 'probe'));
    mkdirSync(opts.out, { recursive: true });
    const log = makeLogger(
        path.join(opts.out, 'probe.log'),
        io.echoLog ? out : null
    );
    if (!opts.json) out(profileLine(opts));
    const ledger =
        io.ledger ||
        Ledger.open(path.join(opts.out, 'ledger.json'), {
            relaxed: opts.profile === 'head' && opts.relaxed,
            now: io.now,
        });
    let code = EXIT.clean;
    let versions = null;
    try {
        versions =
            io.versions ??
            (await collectVersions({
                root: opts.root,
                exec,
                gh: io.gh,
                fetchImpl: io.fetchImpl,
                webSha: opts.webSha,
                webShaFile: opts.webShaFile,
                serverSha: opts.serverSha,
                webUrl: PROD.web,
                serverUrl: PROD.server,
                profile: opts.profile,
                ...headShas(opts, exec, io),
                log,
            }));
    } catch (e) {
        err(`${NAME}: versions failed: ${e.message}`);
        code = EXIT.precondition;
    }
    let builds = io.builds ?? null;
    const probe = await runProbes({
        opts,
        io,
        ledger,
        fence,
        log,
        builds,
        versions,
    });
    probe.versions = versions
        ? { rows: versions.rows, latest: versions.latest, ghOk: versions.ghOk }
        : null;
    if (versions && versions.ghOk === false) {
        probe.pending.push('gh auth (gh release view failed)');
        code = EXIT.precondition;
    }
    if (
        opts.profile === 'shipped' &&
        probe.turn.prod &&
        probe.turn.prod.status &&
        probe.turn.prod.status !== 200
    )
        code = EXIT.precondition;
    if (probe.firewall?.block) code = EXIT.precondition;
    fence.assertWritable(path.join(opts.out, 'probe.json'));
    writeJson(path.join(opts.out, 'probe.json'), probe);
    ledger.save();
    if (opts.json) out(JSON.stringify(probe, null, 4));
    else {
        out(
            `probe P4 TURN prod: ${describeTurn(probe.turn.prod)}${probe.turn.prod?.stunFallbackShape ? ' (STUN fallback shape)' : ''}`
        );
        out(
            `probe P4 TURN local: ${probe.turn.local?.detail || describeTurn(probe.turn.local)}`
        );
        out(
            `probe P3 browser relay: ${probe.browserRelay.ok === null ? probe.browserRelay.detail : probe.browserRelay.ok ? 'ok' : `NO (${probe.browserRelay.detail})`}`
        );
        const d = probe.desktop || {};
        if (d.probes && Object.keys(d.probes).length) {
            for (const [name, r] of Object.entries(d.probes))
                out(`probe ${name} desktop: ${r.verdict}${probeDetailText(r)}`);
            const p9 = d.probes.P9;
            const saveDir =
                p9 && p9.detail && p9.detail.original !== undefined
                    ? `, save dir "${p9.detail.original}" ${/^restored/.test(p9.verdict) ? 'restored' : 'NOT restored'}`
                    : '';
            out(
                `probe desktop aggregate (${d.mode}): available ${d.available}, receiverDrivable ${d.receiverDrivable}, saveDirSettable ${d.saveDirSettable}, senderDrivable ${d.senderDrivable}, present ${d.present}, focusNeeded ${d.focusNeeded}${saveDir}`
            );
        } else
            out(
                `probe P1/P2/P6/P8/P9 desktop: ${d.detail || JSON.stringify(d)}`
            );
        out(
            `probe P7 MOTW: ${probe.motw ? probe.motw.detail : 'n/a (no portable exe staged)'}`
        );
        out(
            `probe WSL: ${probe.wsl.present ? (probe.wsl.running ? 'Running' : 'Stopped (the audit starts it on demand for deep cells)') : `absent (${probe.wsl.state || '?'})`}`
        );
        out(
            `probe firewall: ${probe.firewall.detail || (probe.firewall.inboundAllow ? 'inbound Allow present' : 'none')}`
        );
        out(
            `probe disk free: ${probe.disk.freeBytes === null ? 'unknown' : formatBytes(probe.disk.freeBytes)}`
        );
        out(`probe Playwright: ${probe.playwright?.detail}`);
        if (versions)
            for (const r of versions.rows)
                out(
                    `probe P5 ${r.surface}: ${r.installed ?? 'not installed'} vs ${r.latest ?? '-'} -> ${r.status}`
                );
        if (probe.pending.length) out(`pending: ${probe.pending.join('; ')}`);
        out(
            `${NAME}: probe written to ${path.join(opts.out, 'probe.json')} (exit ${code})`
        );
    }
    return code;
}

export async function versionsCmd(opts, io = {}) {
    const out = io.stdout || ((s) => process.stdout.write(s + '\n'));
    const exec = io.exec || defaultExec;
    const v =
        io.versions ??
        (await collectVersions({
            root: opts.root,
            exec,
            gh: io.gh,
            fetchImpl: io.fetchImpl,
            webSha: opts.webSha,
            webShaFile: opts.webShaFile,
            serverSha: opts.serverSha,
            webUrl: PROD.web,
            serverUrl: PROD.server,
            pin: opts.pin,
            profile: opts.profile,
            ...headShas(opts, exec, io),
            storeUsed: opts.desktop === 'store',
        }));
    const drift = gatingDrift(v.rows);
    const code = drift.length ? EXIT.drift : EXIT.clean;
    if (opts.json)
        out(
            JSON.stringify(
                {
                    rows: v.rows,
                    latest: v.latest,
                    mainSha: v.mainSha,
                    drift: drift.map((r) => r.surface),
                    exitCode: code,
                },
                null,
                4
            )
        );
    else {
        const w = [22, 30, 18, 36, 8];
        const p = (s, n) =>
            String(s ?? '-')
                .padEnd(n)
                .slice(0, Math.max(n, String(s ?? '-').length));
        out(
            `${p('Surface', w[0])} ${p('Installed / deployed', w[1])} ${p('Latest', w[2])} ${p('Oracle', w[3])} ${p('Status', w[4])} Suggest`
        );
        for (const r of v.rows)
            out(
                `${p(r.surface, w[0])} ${p(r.installed ?? 'not installed', w[1])} ${p(r.latest, w[2])} ${p(r.oracle, w[3])} ${p(r.status, w[4])} ${r.suggest ?? ''}`.trimEnd()
            );
        out(
            `${NAME}: versions ${drift.length ? `drift on ${drift.map((r) => r.surface).join(', ')} (exit 6)` : 'every gating row current (exit 0)'}`
        );
    }
    return code;
}

function newestRun(outDir) {
    if (!existsSync(outDir)) return null;
    const dirs = readdirSync(outDir, { withFileTypes: true })
        .filter(
            (e) =>
                e.isDirectory() &&
                existsSync(path.join(outDir, e.name, 'manifest.json'))
        )
        .map((e) => e.name)
        .sort();
    return dirs.length ? dirs[dirs.length - 1] : null;
}

export async function cleanupCmd(opts, io = {}) {
    const out = io.stdout || ((s) => process.stdout.write(s + '\n'));
    const err = io.stderr || ((s) => process.stderr.write(s + '\n'));
    const exec = io.exec || defaultExec;
    const tryAdapter = io.tryAdapter || realTryAdapter;
    // Manifest paths are data, never an allowlist: only --out (and a
    // --bin-dir the operator passes again) may be deleted from, so a
    // manifest that names a foreign binDir, appDataRedirect or fixture dir
    // is refused by the fence rather than obeyed. Built before the manifest
    // is even looked up, so a --out inside a checkout is exit 2 first.
    const fence = fenceFor(opts, io, exec, { allow: [opts.out, opts.binDir] });
    const runId = opts.run || newestRun(opts.out);
    if (!runId) {
        err(
            `${NAME}: nothing to clean up under ${opts.out} (no manifest.json)`
        );
        return EXIT.fail;
    }
    const file = path.join(opts.out, runId, 'manifest.json');
    if (!existsSync(file)) {
        err(`${NAME}: no manifest at ${file}`);
        return EXIT.fail;
    }
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    let refused = 0;
    const proc = await tryAdapter('proc');
    const creationOf =
        io.creationTime ??
        (proc && typeof proc.creationTime === 'function'
            ? proc.creationTime
            : null);
    for (const entry of manifest.pids || []) {
        const pid = Number(entry.pid);
        if (!pid) continue;
        let image = null;
        try {
            image =
                proc && typeof proc.processImage === 'function'
                    ? proc.processImage(pid)
                    : io.processImage
                      ? io.processImage(pid)
                      : null;
        } catch {
            image = null;
        }
        if (!image) {
            out(`pid ${pid} (${entry.label}) already gone`);
            continue;
        }
        if (!entry.image || image !== entry.image) {
            err(
                `${NAME}: pid ${pid} is now ${image}, not the ${entry.image || 'unknown image'} the run recorded (${entry.label}); not killed`
            );
            refused += 1;
            continue;
        }
        if (entry.creation && creationOf) {
            let current = null;
            try {
                current = creationOf(pid);
            } catch {
                current = null;
            }
            if (current && current !== entry.creation) {
                err(
                    `${NAME}: pid ${pid} was created at ${current}, not the ${entry.creation} the run recorded (${entry.label}); the pid was recycled, not killed`
                );
                refused += 1;
                continue;
            }
        }
        try {
            if (io.kill) io.kill(pid);
            else if (WIN)
                execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                    stdio: 'ignore',
                    windowsHide: true,
                });
            else process.kill(pid, 'SIGTERM');
            out(`killed pid ${pid} (${entry.label}, ${image})`);
        } catch (e) {
            err(`${NAME}: kill ${pid} failed: ${e.message}`);
            refused += 1;
        }
    }
    const desktop = await tryAdapter('desktop');
    if (manifest.desktop && manifest.desktop.backup) {
        if (desktop && typeof desktop.restoreConfig === 'function') {
            try {
                const r = await desktop.restoreConfig(manifest.desktop, {
                    fence,
                });
                out(
                    `desktop.json: ${r && r.detail ? r.detail : 'restore attempted'}`
                );
                if (r && r.ok === false) refused += 1;
            } catch (e) {
                err(`${NAME}: desktop.json restore failed: ${e.message}`);
                refused += 1;
            }
        } else {
            err(
                `${NAME}: desktop.json backup recorded at ${manifest.desktop.backup} but the desktop adapter cannot restore it; restore by hand`
            );
            refused += 1;
        }
    }
    if (manifest.stack && manifest.stack.started) {
        const stack = await tryAdapter('stack');
        if (stack && typeof stack.stopStack === 'function') {
            try {
                const r = await stack.stopStack(
                    {
                        started: true,
                        fromManifest: true,
                        root: manifest.stack.root || opts.root,
                        client: Boolean(manifest.stack.client),
                        h: null,
                    },
                    {}
                );
                out(
                    `local stack: ${r && r.stopped ? `floe-run stop exit ${r.stopExit}${r.stopOut ? ` (${r.stopOut.split(/\r?\n/)[0]})` : ''}` : (r && r.reason) || 'stop attempted'}`
                );
                manifest.stack.started = false;
            } catch (e) {
                err(`${NAME}: stack stop: ${e.message}`);
                refused += 1;
            }
        }
    }
    for (const dir of manifest.fixtureDirs || []) {
        if (!existsSync(dir)) continue;
        try {
            fence.assertWritable(dir);
            rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
            out(`removed fixtures ${dir}`);
        } catch (e) {
            err(`${NAME}: ${e.message}`);
            refused += 1;
        }
    }
    if (manifest.appDataRedirect && existsSync(manifest.appDataRedirect)) {
        try {
            fence.assertWritable(manifest.appDataRedirect);
            rmSync(manifest.appDataRedirect, {
                recursive: true,
                force: true,
                maxRetries: 3,
            });
            out(`removed APPDATA redirect ${manifest.appDataRedirect}`);
        } catch (e) {
            err(`${NAME}: ${e.message}`);
            refused += 1;
        }
    }
    // Wholesale deletion is for the bin dir a run created itself: the
    // default <out>/bin, or one the manifest marks as owned. It is never
    // --out itself and never a --bin-dir passed again now; the fence
    // refuses anything outside --out on top of that.
    const defaultBin = path.join(opts.out, 'bin');
    const ownedBin = Boolean(
        manifest.binDir &&
        manifest.binDirOwned !== false &&
        (manifest.binDirOwned === true ||
            isUnder(manifest.binDir, defaultBin)) &&
        normalizePath(manifest.binDir) !== normalizePath(opts.out) &&
        !isUnder(opts.out, manifest.binDir)
    );
    if (!opts.keep && ownedBin && existsSync(manifest.binDir) && !opts.binDir) {
        try {
            fence.assertWritable(manifest.binDir);
            rmSync(manifest.binDir, {
                recursive: true,
                force: true,
                maxRetries: 3,
            });
            out(`removed side-loaded binaries ${manifest.binDir}`);
        } catch (e) {
            err(`${NAME}: ${e.message}`);
            refused += 1;
        }
    } else if (manifest.binDir)
        out(
            `kept ${manifest.binDir}${!ownedBin || manifest.binDirOwned === false || opts.binDir ? ' (operator --bin-dir)' : opts.keep ? ' (--keep)' : ''}`
        );
    manifest.cleanedAt = new Date().toISOString();
    manifest.cleanupRefused = refused;
    writeJson(file, manifest);
    out(
        `${NAME}: cleanup of ${runId} ${refused ? `refused ${refused} item(s)` : 'complete'}`
    );
    return refused ? EXIT.fail : EXIT.clean;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(argv, io = {}) {
    const out = io.stdout || ((s) => process.stdout.write(s + '\n'));
    const err = io.stderr || ((s) => process.stderr.write(s + '\n'));
    let parsed;
    try {
        parsed = parseArgs(argv, {
            defaultRoot: io.defaultRoot || DEFAULT_ROOT,
            fs: io.fs || realFs,
        });
    } catch (e) {
        if (e instanceof UsageError) {
            err(`${NAME}: ${e.message}`);
            err(USAGE);
            return EXIT.usage;
        }
        throw e;
    }
    try {
        switch (parsed.cmd) {
            case 'help':
                out(USAGE);
                return EXIT.clean;
            case 'self-test':
                return selfTest(out);
            case 'run':
                return await runCmd(parsed.opts, io);
            case 'probe':
                return await probeCmd(parsed.opts, io);
            case 'versions':
                return await versionsCmd(parsed.opts, io);
            case 'cleanup':
                return await cleanupCmd(parsed.opts, io);
            default:
                err(`${NAME}: unknown command ${parsed.cmd}`);
                return EXIT.usage;
        }
    } catch (e) {
        // Refusals raised before a subcommand has a run record to report
        // through: a --out inside a checkout (usage, exit 2) or a write the
        // fence would not vouch for (safety, exit 4). Nothing on stdout.
        if (e instanceof UsageError) {
            err(`${NAME}: ${e.message}`);
            return EXIT.usage;
        }
        if (e instanceof SafetyError || (e && e.fence)) {
            err(`${NAME}: safety invariant tripped: ${e.message}`);
            return EXIT.safety;
        }
        throw e;
    }
}

export { parseWslList, probeWsl, selfTest, DEFAULT_ROOT, PROD, LOCAL };

const invokedDirectly =
    process.argv[1] &&
    path.resolve(process.argv[1]).toLowerCase() ===
        fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (e) => {
            process.stderr.write(`${NAME}: ${e && e.stack ? e.stack : e}\n`);
            process.exit(
                e instanceof SafetyError ? EXIT.safety : EXIT.precondition
            );
        }
    );
}
