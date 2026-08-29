/**
 * Local stack for the head profile of the transfer-audit skill, entirely
 * through the floe-run skill: `check --json` decides, `start --client
 * --relaxed` runs in the background until the literal READY line and its
 * block, `stop` only when this run started it, then the hygiene floe-run's
 * SKILL.md asks for after --client (next dev rewrites client/next-env.d.ts
 * and generates client/AGENTS.md and client/CLAUDE.md).
 *
 * The verdict ladder is floe-run's own: exit 2 means nothing is bound, so
 * start; 0 means a stack from this checkout is up and vouched for, so
 * reuse it and never stop it; 1 means :3001 is bound by something floe-run
 * cannot vouch for, which is a precondition failure (exit 3 for the
 * caller), never something to adopt or kill.
 *
 * Why the wrapper is spawned through proc.mjs: it gives the READY wait a
 * line matcher, a transcript in the evidence dir, and a kill that refuses
 * any pid this run did not start. floe-run's own server child is stopped by
 * `floe-run stop`, which checks the pidfile and the image itself.
 *
 * Every corepack or pnpm shell-out from here runs with cwd client/ and
 * COREPACK_ENABLE_AUTO_PIN=0: from the repo root corepack resolves pnpm
 * 11.7.0 and can write a packageManager field into root package.json, which
 * is a write to the shared tree (journal, pnpm/floe-run answer).
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { PhaseError } from './surfaces.mjs';
import { killTree, spawnFloe } from './proc.mjs';

const WIN = process.platform === 'win32';
export const FLOE_RUN_REL = '.claude/skills/floe-run/scripts/floe-run.mjs';
export const SERVER_URL = 'http://localhost:3001';
export const WEB_URL = 'http://localhost:3000';
export const READY_LINE = /^READY$/;
export const READY_END = /^stop: /;
export const START_TIMEOUT_MS = 200_000;
export const STOP_TIMEOUT_MS = 20_000;
export const GENERATED = Object.freeze([
    'client/AGENTS.md',
    'client/CLAUDE.md',
]);
export const REWRITTEN = 'client/next-env.d.ts';

export function floeRunPath(root) {
    return join(root, ...FLOE_RUN_REL.split('/'));
}

/**
 * The checkout floe-run runs from: the one that owns clientDir (its
 * node_modules, its pidfile), else root. A worktree passed as --root has
 * neither, and floe-run only vouches for a pidfile from its own root.
 */
export function stackRootFor({ root = null, clientDir = null } = {}) {
    if (clientDir) {
        const owner = dirname(resolve(clientDir));
        if (existsSync(floeRunPath(owner))) return owner;
    }
    return root;
}

/** The environment every corepack or pnpm child gets. */
export function corepackEnv(base = process.env) {
    return {
        ...base,
        COREPACK_ENABLE_AUTO_PIN: '0',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    };
}

/**
 * Run `corepack pnpm <args>` from <root>/client. Args are constants from
 * the caller, never user input, which is why shell: true (needed for the
 * .cmd shim on Windows) adds no injection surface.
 */
export function runPnpm(root, args, { timeoutMs = 600_000 } = {}) {
    return execFileSync('corepack', ['pnpm', ...args], {
        cwd: join(root, 'client'),
        env: corepackEnv(),
        encoding: 'utf8',
        shell: WIN,
        windowsHide: true,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * Parse the READY block (floe-run.mjs:478-500). Null until the READY line
 * is present; fields are null until their line arrives.
 */
export function parseReady(text) {
    const lines = String(text).split(/\r?\n/);
    const at = lines.findIndex((l) => READY_LINE.test(l.trim()));
    if (at < 0) return null;
    const block = lines.slice(at + 1);
    const grab = (key) => {
        const line = block.find((l) => l.startsWith(`${key}:`));
        return line ? line.slice(key.length + 1).trim() : null;
    };
    const stats = grab('stats');
    const server = grab('server');
    const web = grab('web');
    const limiters = grab('limiters');
    const pidfile = grab('pidfile');
    const num = (s, re) => {
        const m = s ? s.match(re) : null;
        return m ? Number(m[1]) : null;
    };
    return {
        server: server ? server.split(/\s+/)[0] : null,
        web: web && !web.startsWith('not started') ? web.split(/\s+/)[0] : null,
        clientStarted: web ? !web.startsWith('not started') : null,
        relaxed: limiters ? /relaxed/.test(limiters) : null,
        limiters,
        totalBytes: num(stats, /totalBytes=(\d+)/),
        serverPid: num(stats, /server pid (\d+)/),
        clientPid: num(web, /pid (\d+)\)/),
        wrapperPid: num(pidfile, /wrapper pid (\d+)/),
        pidfile: pidfile
            ? pidfile.replace(/\s*\(wrapper pid \d+\)$/, '')
            : null,
        complete: block.some((l) => READY_END.test(l)),
    };
}

/**
 * Map `floe-run check --json` to an action: 2 -> 'start', 0 -> 'reuse',
 * anything else -> 'refuse'. The report's own exitCode wins over the
 * process exit when both are present.
 */
export function parseCheck(exitCode, stdout = '') {
    let report = null;
    try {
        report = JSON.parse(stdout);
    } catch {
        report = null;
    }
    const code =
        report && Number.isInteger(report.exitCode)
            ? report.exitCode
            : exitCode;
    const action = code === 2 ? 'start' : code === 0 ? 'reuse' : 'refuse';
    return { action, exitCode: code, report };
}

function execNode(args, { cwd, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            args,
            {
                cwd,
                env: corepackEnv(),
                encoding: 'utf8',
                timeout: timeoutMs,
                windowsHide: true,
                maxBuffer: 8 * 1024 * 1024,
            },
            (err, stdout, stderr) => {
                const code =
                    err && typeof err.code === 'number'
                        ? err.code
                        : err
                          ? null
                          : 0;
                resolve({ code, stdout: stdout || '', stderr: stderr || '' });
            }
        );
    });
}

/** `floe-run check --json` -> { action, exitCode, report, stderr }. */
export async function floeRunCheck(root) {
    const script = floeRunPath(root);
    if (!existsSync(script))
        throw new PhaseError(
            'precondition',
            `floe-run not found at ${script}`,
            {
                exitCode: 3,
            }
        );
    const res = await execNode([script, 'check', '--json'], { cwd: root });
    return { ...parseCheck(res.code, res.stdout), stderr: res.stderr };
}

/** Wait for READY and the end of its block on a spawnFloe handle. */
export async function waitReady(h, timeoutMs = START_TIMEOUT_MS) {
    const t0 = Date.now();
    try {
        await h.waitLine(READY_LINE, timeoutMs);
        await h.waitLine(
            READY_END,
            Math.max(1000, timeoutMs - (Date.now() - t0))
        );
    } catch (err) {
        throw new PhaseError(
            'precondition',
            `floe-run start did not reach READY: ${err.message}`,
            { exitCode: 3, cause: err }
        );
    }
    return parseReady(h.stdout);
}

/**
 * ensureStack({ root, client, clientDir, relaxed, evidenceDir, log }) ->
 *   { started, owned, root, server, web, relaxed, ready, report, h,
 *     client, stop() }
 * started is true only when this call launched the wrapper; stop() is a
 * no-op otherwise. owned is true when the stack is floe-run's (started
 * here or reused with a vouched pidfile). clientDir names the client tree
 * the stack serves; it implies client and picks the floe-run root
 * (stackRootFor), so a worktree --root reuses or starts the main checkout's
 * stack instead of failing on a tree with no node_modules.
 */
export async function ensureStack({
    root,
    client = true,
    clientDir = null,
    relaxed = true,
    evidenceDir,
    timeoutMs = START_TIMEOUT_MS,
    log = null,
} = {}) {
    if (!root && !clientDir)
        throw new PhaseError('precondition', 'ensureStack: root is required', {
            exitCode: 3,
        });
    const stackRoot = stackRootFor({ root, clientDir }) ?? root;
    if (clientDir) client = true;
    const note = typeof log === 'function' ? log : () => {};
    if (stackRoot !== root)
        note(`stack: floe-run root ${stackRoot} (owns --client-dir)`);
    const check = await floeRunCheck(stackRoot);
    if (check.action === 'refuse') {
        const why =
            (check.report && check.report.verdict) ||
            check.stderr.trim() ||
            `floe-run check exited ${check.exitCode}`;
        throw new PhaseError('precondition', `floe-run check refused: ${why}`, {
            exitCode: 3,
            report: check.report,
        });
    }
    if (check.action === 'reuse') {
        const report = check.report || {};
        const handle = {
            started: false,
            owned: Boolean(report.owned),
            root: stackRoot,
            server: SERVER_URL,
            web: report.clientBound ? WEB_URL : null,
            relaxed: null,
            ready: null,
            report,
            h: null,
            client: Boolean(report.clientBound),
        };
        handle.stop = async () => ({
            stopped: false,
            reason: 'stack not started by this run',
        });
        return handle;
    }
    // The wrapper transcript is run evidence and lives under the run dir;
    // there is no fallback location outside the fence.
    if (!evidenceDir)
        throw new PhaseError(
            'precondition',
            'ensureStack: evidenceDir is required to start the stack (the floe-run transcript lives under the run dir)',
            { exitCode: 3 }
        );
    const script = floeRunPath(stackRoot);
    const args = [script, 'start'];
    if (client) args.push('--client');
    if (relaxed) args.push('--relaxed');
    const h = spawnFloe({
        bin: process.execPath,
        args,
        env: corepackEnv(),
        cwd: stackRoot,
        label: 'floe-run',
        evidenceDir,
    });
    let ready;
    try {
        ready = await waitReady(h, timeoutMs);
    } catch (err) {
        try {
            killTree(h.pid);
        } catch {
            // Already gone, or not ours to kill; the pidfile says the rest.
        }
        throw err;
    }
    const handle = {
        started: true,
        owned: true,
        root: stackRoot,
        server: ready.server ?? SERVER_URL,
        web: ready.web,
        relaxed: ready.relaxed,
        ready,
        report: check.report,
        h,
        client,
    };
    handle.stop = (opts) => stopStack(handle, opts);
    return handle;
}

/** Tracked by git at root? */
export function isTracked(root, rel) {
    try {
        execFileSync('git', ['ls-files', '--error-unmatch', rel], {
            cwd: root,
            stdio: 'ignore',
            windowsHide: true,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * After a --client run: restore the tracked next-env.d.ts and delete the
 * generated AGENTS.md and CLAUDE.md under client/, but only when they are
 * untracked (a tracked one is the repo's own file). Returns the actions.
 */
export function runHygiene(root) {
    const actions = [];
    try {
        execFileSync('git', ['checkout', '--', REWRITTEN], {
            cwd: root,
            stdio: 'ignore',
            windowsHide: true,
        });
        actions.push(`git checkout -- ${REWRITTEN}`);
    } catch (err) {
        actions.push(`git checkout -- ${REWRITTEN} failed: ${err.message}`);
    }
    for (const rel of GENERATED) {
        const abs = join(root, ...rel.split('/'));
        if (!existsSync(abs)) continue;
        if (isTracked(root, rel)) {
            actions.push(`kept tracked ${rel}`);
            continue;
        }
        rmSync(abs, { force: true });
        actions.push(`deleted ${rel}`);
    }
    return actions;
}

/**
 * `floe-run stop`, wait for the wrapper, then hygiene when --client ran.
 * A handle rebuilt from a manifest ({ started: true, root, client, h: null })
 * stops the same way, minus the wrapper wait.
 */
export async function stopStack(handle, { hygiene = true, log = null } = {}) {
    if (!handle || !handle.started)
        return { stopped: false, reason: 'stack not started by this run' };
    const note = typeof log === 'function' ? log : () => {};
    const script = floeRunPath(handle.root);
    note(`stack: floe-run stop from ${handle.root}`);
    const res = await execNode([script, 'stop'], { cwd: handle.root });
    let wrapperExit = handle.h
        ? await handle.h.waitExit(STOP_TIMEOUT_MS)
        : null;
    if (handle.h && !wrapperExit) {
        try {
            killTree(handle.h.pid);
        } catch {
            // Refused: the pid is no longer the wrapper; nothing to do.
        }
        wrapperExit = await handle.h.waitExit(5000);
    }
    handle.started = false;
    return {
        stopped: true,
        stopExit: res.code,
        stopOut: res.stdout.trim(),
        stopErr: res.stderr.trim(),
        wrapperExit,
        hygiene: handle.client && hygiene ? runHygiene(handle.root) : [],
    };
}

/** GET url -> { status, body }; only ever a GET. */
export function httpGet(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https:') ? https : http;
        const req = mod.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

/** GET <server>/api/stats -> totalBytes as a number; throws otherwise. */
export async function statsTotal(server = SERVER_URL, timeoutMs = 5000) {
    const url = `${String(server).replace(/\/+$/, '')}/api/stats`;
    const res = await httpGet(url, timeoutMs);
    if (res.status !== 200)
        throw new PhaseError('infra', `${url} answered ${res.status}`, {
            status: res.status,
        });
    let total;
    try {
        total = JSON.parse(res.body).totalBytes;
    } catch {
        throw new PhaseError('infra', `${url} returned no JSON`);
    }
    if (!Number.isFinite(total))
        throw new PhaseError('infra', `${url} has no numeric totalBytes`);
    return total;
}
