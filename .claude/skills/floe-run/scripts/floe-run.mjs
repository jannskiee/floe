#!/usr/bin/env node
/**
 * Starts the local Floe stack with the public stats counter neutralized, and
 * proves it before anything can receive.
 *
 * Why a script instead of `node server.js`: server/server.js calls
 * require('dotenv').config() at the top of the file with override off, so it
 * reads server/.env from its cwd and fills in every variable the environment
 * left unset. In the main checkout that file holds live Upstash credentials
 * for floe:bytes_total, the public all-time counter on the floe.one homepage.
 * The counter only ever takes INCRBY, so every byte a local receiver reports
 * through /api/stats/report is permanent (65 MB got in on 2026-07-10; on
 * 2026-08-16 a local server seeded 197 GB straight from production). Nothing
 * in the server refuses production; the guard is the environment it starts
 * with, and it covers the stats counter only (TURN keys still flow through).
 *
 * The guard is a sentinel, not an empty string: dotenv refills an UNSET
 * variable and PowerShell's `$env:X = ""` unsets, so both keys are set to a
 * non-empty, unroutable value (port 9 refuses at once, and upstashPost
 * swallows the error). Zero on /api/stats is then necessary but not
 * sufficient, which is why `check` also asks the pidfile whether this script
 * set the environment, and why `start` refuses a bound port it does not own
 * instead of adopting it.
 *
 * `stop` kills only what the pidfile names AND what still looks like it: the
 * pidfile must come from this checkout, and each pid must still carry the
 * image this run spawned (tasklist / ps), so a recycled pid is never a
 * stranger's process. A wrapper that died without teardown (console closed,
 * killed without /T) can leave next dev holding :3000 with no parent; `stop`
 * finds that listener through netstat / lsof and kills it too.
 *
 * Modes: start [--client] [--relaxed] | check [--json] | stop
 * Exit codes: 0 ok; 1 check found a server it cannot vouch for, or stop
 * refused a pid; 2 usage, or nothing to check or stop; 3 a port is bound;
 * 4 the server read a non-zero total; 5 the server or client never became
 * healthy.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// scripts/ -> floe-run/ -> skills/ -> .claude/ -> repo root.
const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..'
);
const PIDFILE = path.join(os.tmpdir(), 'floe-run.json');
const SERVER_PORT = 3001;
const CLIENT_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;
// 127.0.0.1, not localhost: engine.io-client skips its window 'offline'
// listener for the literal host "localhost", and the reconnect path needs it
// (see the same choice in client/playwright.config.ts).
const SOCKET_URL = `http://127.0.0.1:${SERVER_PORT}`;
// Unroutable on purpose: port 9 (discard) is closed on every box, so the
// connect fails at once and the server never blocks on it.
const SENTINEL_URL = 'http://127.0.0.1:9';
const SENTINEL_TOKEN = 'local-sentinel';
const WIN = process.platform === 'win32';
const SELF = 'node .claude/skills/floe-run/scripts/floe-run.mjs';
const MODE_FLAGS = {
    start: ['--client', '--relaxed'],
    check: ['--json'],
    stop: [],
};
const NODE_IMAGE = path.basename(process.execPath);

const children = { server: null, client: null };
let tearingDown = false;
let ready = false;

function fail(code, message) {
    console.error(`floe-run: ${message}`);
    process.exit(code);
}

function parseArgs(argv) {
    const [mode = 'start', ...rest] = argv;
    if (!(mode in MODE_FLAGS)) return null;
    const flags = { client: false, relaxed: false, json: false };
    for (const arg of rest) {
        if (!MODE_FLAGS[mode].includes(arg)) return null;
        flags[arg.slice(2)] = true;
    }
    return { mode, flags };
}

function run(cmd, args) {
    try {
        return execFileSync(cmd, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return '';
    }
}

function portBound(port) {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host: '127.0.0.1' });
        const done = (bound) => {
            sock.destroy();
            resolve(bound);
        };
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        // A silent port is not a free port; treat a hang as bound.
        sock.setTimeout(2000, () => done(true));
    });
}

function ownerHint(port) {
    return WIN
        ? `netstat -ano | findstr :${port}`
        : `lsof -iTCP:${port} -sTCP:LISTEN`;
}

// The pid holding a LISTEN socket on the port, or null.
function listenerPid(port) {
    if (WIN) {
        const line = run('netstat', ['-ano'])
            .split(/\r?\n/)
            .find(
                (l) =>
                    /^\s*TCP\s/.test(l) &&
                    new RegExp(`:${port}\\s`).test(l) &&
                    /LISTENING/.test(l)
            );
        const pid = line ? Number(line.trim().split(/\s+/).pop()) : NaN;
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    const pid = Number(
        run('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']).split(/\r?\n/)[0]
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// The executable name behind a pid (lowercase on Windows), or null.
function processImage(pid) {
    if (WIN) {
        const out = run('tasklist', [
            '/FI',
            `PID eq ${pid}`,
            '/FO',
            'CSV',
            '/NH',
        ]);
        const match = out.match(/^"([^"]+)"/m);
        return match ? match[1].toLowerCase() : null;
    }
    return run('ps', ['-p', String(pid), '-o', 'comm=']).trim() || null;
}

// Windows names the exact image this run spawned; POSIX comm names vary with
// the shebang, so anything from the node / sh / pnpm family counts.
function imageMatches(expected, actual) {
    if (!actual) return false;
    return WIN
        ? actual === String(expected).toLowerCase()
        : /node|sh|pnpm/.test(actual);
}

function httpGet(url, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.setTimeout(timeoutMs, () => req.destroy());
        req.on('error', () => resolve(null));
    });
}

async function readTotalBytes() {
    const res = await httpGet(`${SERVER_URL}/api/stats`);
    if (!res || res.status !== 200) return null;
    try {
        const total = JSON.parse(res.body).totalBytes;
        return Number.isFinite(total) ? total : null;
    } catch {
        return null;
    }
}

async function waitFor(url, timeoutMs, requestTimeoutMs, gaveUp) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (gaveUp()) return false;
        const res = await httpGet(url, requestTimeoutMs);
        if (res && res.status === 200) return true;
        await sleep(250);
    }
    return false;
}

function readPidfile() {
    if (!existsSync(PIDFILE)) return null;
    try {
        return JSON.parse(readFileSync(PIDFILE, 'utf8'));
    } catch {
        return null;
    }
}

function removePidfile() {
    try {
        unlinkSync(PIDFILE);
    } catch {
        // Already gone.
    }
}

function alive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM: it exists and belongs to someone else. Still alive.
        return err.code === 'EPERM';
    }
}

function sameRoot(a, b) {
    const norm = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
    return norm(a) === norm(b);
}

// Owned means a pidfile written by a run from THIS checkout whose server is
// still alive. Anything less and the environment behind :3001 is unknown.
function ownership() {
    const state = readPidfile();
    if (!state) return { owned: false, reason: 'no pidfile', state: null };
    if (!alive(state.serverPid)) {
        return {
            owned: false,
            reason: `stale pidfile, pid ${state.serverPid} is gone`,
            state,
        };
    }
    if (!sameRoot(state.root, ROOT)) {
        return {
            owned: false,
            reason: `started from another checkout, ${state.root}`,
            state,
        };
    }
    return { owned: true, reason: `pid ${state.serverPid}`, state };
}

// pnpm from PATH when it is there (corepack is gone from Node 25), corepack
// otherwise. On Windows both are .cmd shims, and spawn has refused those
// without a shell since Node 18.20 / 20.12; the args are constants, never
// user input, so shell: true adds no injection surface.
function pnpmLauncher() {
    const resolved =
        run(WIN ? 'where' : 'which', ['pnpm'])
            .split(/\r?\n/)
            .find(Boolean) || null;
    const shell = WIN && (!resolved || /\.(cmd|bat)$/i.test(resolved));
    return {
        cmd: resolved ? 'pnpm' : 'corepack',
        args: resolved ? ['dev'] : ['pnpm', 'dev'],
        shell,
        // What tasklist will report for the child: the shell, or the binary.
        image: shell
            ? 'cmd.exe'
            : resolved
              ? path.basename(resolved)
              : 'corepack',
        label: resolved ? `pnpm dev (${resolved})` : 'corepack pnpm dev',
    };
}

// The client is spawned through a shell on Windows (cmd.exe owns the tree) and
// as its own process group elsewhere, so a tree kill is the only kill that
// reaches next dev. /T /F on win32 is what the pidfile and Ctrl+C both need.
function killTree(pid, { group = false } = {}) {
    if (!alive(pid)) return;
    try {
        if (WIN) {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                stdio: 'ignore',
            });
        } else {
            process.kill(group ? -pid : pid, 'SIGTERM');
        }
    } catch {
        // Already gone, or not ours; nothing left to do either way.
    }
}

function pipePrefixed(child, prefix) {
    for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            for (const line of lines)
                process.stdout.write(`${prefix} ${line}\n`);
        });
        stream.on('end', () => {
            if (pending) process.stdout.write(`${prefix} ${pending}\n`);
        });
    }
}

// One teardown for every exit path: a signal, `stop` from another shell, or a
// child dying on its own. Guarded because the child exit that a kill causes
// would otherwise re-enter it.
function teardown(code, why) {
    if (tearingDown) return;
    tearingDown = true;
    if (why) console.log(`floe-run: ${why}`);
    if (children.client) killTree(children.client.pid, { group: true });
    if (children.server) killTree(children.server.pid);
    removePidfile();
    process.exit(code);
}

function watchChild(name, child) {
    child.on('exit', (code) => {
        if (tearingDown) return;
        // Before READY every exit is a failure. After it, `stop` removes the
        // pidfile before killing, so a missing pidfile is a deliberate stop.
        if (ready && !existsSync(PIDFILE)) teardown(0, 'stopped');
        else teardown(1, `${name} exited unexpectedly (code ${code})`);
    });
}

async function start(flags) {
    const own = ownership();
    if (own.owned)
        fail(3, `already running (pid ${own.state.serverPid}), run stop`);
    if (own.state && !alive(own.state.serverPid)) removePidfile();
    else if (own.state) {
        fail(
            3,
            `a floe-run stack from ${own.state.root} is running (pid ${own.state.serverPid}); stop it from there`
        );
    }
    for (const port of [SERVER_PORT, CLIENT_PORT]) {
        if (await portBound(port)) {
            fail(
                3,
                `:${port} is bound by a process this script did not start. Find it with:\n  ${ownerHint(port)}\nNever kill a process you did not start.`
            );
        }
    }

    const relaxed = flags.relaxed
        ? {
              MAX_CONNECTIONS_PER_IP: '1000',
              MAX_CODE_REQUESTS_PER_IP: '1000',
              MAX_TURN_REQUESTS_PER_IP: '1000',
          }
        : {};
    const server = spawn(process.execPath, ['server.js'], {
        cwd: path.join(ROOT, 'server'),
        env: {
            ...process.env,
            CLIENT_URL,
            PORT: String(SERVER_PORT),
            UPSTASH_REDIS_REST_URL: SENTINEL_URL,
            UPSTASH_REDIS_REST_TOKEN: SENTINEL_TOKEN,
            ...relaxed,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    children.server = server;
    pipePrefixed(server, '[server]');
    process.on('SIGINT', () => teardown(0, 'interrupted'));
    process.on('SIGTERM', () => teardown(0, 'terminated'));
    // Windows raises SIGHUP when the console window closes.
    process.on('SIGHUP', () => teardown(0, 'hangup'));

    const healthy = await waitFor(
        `${SERVER_URL}/health`,
        30_000,
        2000,
        () => server.exitCode !== null
    );
    if (!healthy) {
        teardown(
            5,
            server.exitCode !== null
                ? `server exited (code ${server.exitCode}) before /health answered`
                : 'the server did not answer /health within 30 s'
        );
    }

    // Twice: initStats is fire-and-forget, so a seed from real credentials can
    // land after /health is already answering.
    for (const attempt of [0, 1]) {
        if (attempt) await sleep(2000);
        const total = await readTotalBytes();
        if (total !== 0) {
            teardown(
                4,
                `stats read ${total === null ? 'nothing' : total}, the server seeded from real credentials; check the environment`
            );
        }
    }
    // From here on a server death is a failure, including during the client
    // wait below, so READY can never advertise a dead pid.
    watchChild('server', server);

    let launcher = null;
    if (flags.client) {
        launcher = pnpmLauncher();
        const client = spawn(launcher.cmd, launcher.args, {
            cwd: path.join(ROOT, 'client'),
            env: {
                ...process.env,
                NEXT_PUBLIC_SOCKET_URL: SOCKET_URL,
                COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
            },
            shell: launcher.shell,
            detached: !WIN,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        children.client = client;
        pipePrefixed(client, '[client]');
        // The first request makes next dev compile the home page, which can
        // take most of the budget, so give each request the whole window.
        const up = await waitFor(
            CLIENT_URL,
            120_000,
            120_000,
            () => client.exitCode !== null || server.exitCode !== null
        );
        if (!up) {
            teardown(
                5,
                client.exitCode !== null
                    ? `next dev exited (code ${client.exitCode}) before answering on :3000`
                    : 'next dev did not answer on :3000 within 120 s'
            );
        }
        watchChild('client', client);
    }

    writeFileSync(
        PIDFILE,
        JSON.stringify(
            {
                root: ROOT,
                wrapperPid: process.pid,
                serverPid: server.pid,
                serverImage: NODE_IMAGE,
                clientPid: children.client ? children.client.pid : null,
                clientImage: launcher ? launcher.image : null,
                startedAt: new Date().toISOString(),
                sentinelUrl: SENTINEL_URL,
            },
            null,
            4
        )
    );
    ready = true;

    console.log('READY');
    console.log(
        `stats: sentinel ${SENTINEL_URL}, totalBytes=0, server pid ${server.pid}`
    );
    console.log(
        `server: ${SERVER_URL}  (/health, /api/stats, /api/turn-credentials)`
    );
    if (children.client) {
        console.log(
            `web: ${CLIENT_URL}  (${launcher.label}, NEXT_PUBLIC_SOCKET_URL=${SOCKET_URL}, pid ${children.client.pid})`
        );
    } else {
        console.log('web: not started (pass --client for next dev on :3000)');
    }
    console.log(
        `cli: floe send <file> --server ${SERVER_URL} --web ${CLIENT_URL}`
    );
    console.log(`     floe receive <code> --server ${SERVER_URL}`);
    console.log(
        `limiters: ${flags.relaxed ? 'relaxed to 1000/min per IP' : 'server defaults'}`
    );
    console.log(`pidfile: ${PIDFILE} (wrapper pid ${process.pid})`);
    console.log(`stop: ${SELF} stop`);
}

async function check(flags) {
    const [serverBound, clientBound] = await Promise.all([
        portBound(SERVER_PORT),
        portBound(CLIENT_PORT),
    ]);
    const health = serverBound ? await httpGet(`${SERVER_URL}/health`) : null;
    const healthy = Boolean(health && health.status === 200);
    const totalBytes = serverBound ? await readTotalBytes() : null;
    const own = ownership();

    let code;
    let verdict;
    if (!serverBound) {
        code = 2;
        verdict = 'nothing is bound on :3001';
    } else if (!own.owned) {
        code = 1;
        verdict = `:3001 is bound but not by this script (${own.reason}); zero is necessary, not sufficient. Find the owner with: ${ownerHint(SERVER_PORT)}`;
    } else if (!healthy) {
        code = 1;
        verdict = 'owned, but /health is not answering';
    } else if (totalBytes !== 0) {
        code = 1;
        verdict = `owned, but /api/stats read ${totalBytes === null ? 'nothing' : totalBytes}; the sentinel did not hold`;
    } else {
        code = 0;
        verdict = `owned by this script (${own.reason}) and /api/stats reads 0`;
    }

    if (flags.json) {
        const report = {
            serverBound,
            healthy,
            totalBytes,
            clientBound,
            owned: own.owned,
            ownership: own.reason,
            pidfile: PIDFILE,
            root: ROOT,
            verdict,
            exitCode: code,
        };
        console.log(JSON.stringify(report, null, 4));
    } else {
        const stats =
            totalBytes === null
                ? 'totalBytes unreadable'
                : `totalBytes=${totalBytes}`;
        const owner = own.owned
            ? `owned (${own.reason})`
            : `not owned (${own.reason})`;
        console.log(
            serverBound
                ? `:3001 bound, /health ${healthy ? 'ok' : 'failing'}, ${stats}, ${owner}`
                : `:3001 free (${own.reason})`
        );
        const clientPid =
            own.owned && own.state.clientPid
                ? ` (client pid ${own.state.clientPid})`
                : '';
        console.log(clientBound ? `:3000 bound${clientPid}` : ':3000 free');
        console.log(`verdict: ${verdict}`);
    }
    process.exit(code);
}

async function stop() {
    const state = readPidfile();
    if (!state) fail(2, `nothing to stop (no pidfile at ${PIDFILE})`);
    if (!sameRoot(state.root, ROOT)) {
        fail(
            1,
            `the pidfile belongs to ${state.root}; run stop from that checkout`
        );
    }
    // Pidfile first: the foreground `start` reads its absence as a deliberate
    // stop when its children exit.
    removePidfile();
    let refused = 0;
    for (const [name, pid, expected, group] of [
        ['client', state.clientPid, state.clientImage, true],
        ['server', state.serverPid, state.serverImage, false],
    ]) {
        if (!pid) continue;
        if (!alive(pid)) {
            console.log(`${name} (pid ${pid}) was already gone`);
            continue;
        }
        const image = processImage(pid);
        if (!imageMatches(expected, image)) {
            console.error(
                `floe-run: pid ${pid} is now ${image || 'unknown'}, not the ${name} this run started (${expected}); not killed`
            );
            refused += 1;
            continue;
        }
        killTree(pid, { group });
        console.log(`stopped ${name} (pid ${pid})`);
    }

    // A wrapper that died without teardown leaves next dev on :3000 with no
    // parent in the pidfile. It is a descendant of this run, so kill the
    // listener itself, but only when it is still a node process.
    if (state.clientPid) {
        let bound = true;
        for (let i = 0; i < 8 && bound; i++) {
            await sleep(250);
            bound = await portBound(CLIENT_PORT);
        }
        if (bound) {
            const pid = listenerPid(CLIENT_PORT);
            const image = pid ? processImage(pid) : null;
            if (pid && imageMatches(NODE_IMAGE, image)) {
                killTree(pid);
                console.log(`stopped the orphaned :3000 listener (pid ${pid})`);
            } else {
                console.error(
                    `floe-run: :3000 is still bound by pid ${pid ?? 'unknown'} (${image ?? 'unknown image'}); not killed. Find it with:\n  ${ownerHint(CLIENT_PORT)}`
                );
                refused += 1;
            }
        }
    }
    process.exit(refused ? 1 : 0);
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed)
    fail(
        2,
        `usage: ${SELF} <start [--client] [--relaxed] | check [--json] | stop>`
    );
if (parsed.mode === 'start') await start(parsed.flags);
else if (parsed.mode === 'check') await check(parsed.flags);
else await stop();
