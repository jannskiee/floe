#!/usr/bin/env node

/**
 * Tests for floe-run.mjs: the two start switches (--request-links and
 * --local-turn), the environment the server is spawned with, and the rule
 * that no printed line ever carries the local TURN secret.
 *
 * Nothing here binds a port or starts server/. Every case runs the real
 * script in a child process, preloaded (node --import) with fakes for the
 * three calls that would touch the machine:
 *   - child_process.spawn: the server becomes an idle node process (a real
 *     pid for the pidfile, tasklist and taskkill, listening on nothing), and
 *     the variables it was handed are recorded;
 *   - http.get: a fake /health, /api/stats and /api/turn-credentials that
 *     answer the way server/ would for the recorded environment, with the
 *     secret planted in every field of the credentials body;
 *   - net.connect: the port probe, bound or free as the case says.
 * TEMP, TMP and TMPDIR point at a fresh folder per run, so the pidfile and
 * the policy file never meet a real floe-run stack on this machine.
 *
 * Run: node --test .claude/skills/floe-run/scripts/floe-run.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./floe-run.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(SCRIPT), '..', '..', '..', '..');
const SECRET = 'sentinel-turn-secret-9f3a';
const DOMAIN = 'turn-domain.test.invalid';
const SENTINEL_URL = 'http://127.0.0.1:9';

/**
 * Runs inside the floe-run process (serialized into the --import preload),
 * so it may use only what it is handed.
 */
function installFakes({
    cp,
    fs,
    http,
    module,
    net,
    path,
    EventEmitter,
    PassThrough,
}) {
    const dir = process.env.FLOE_RUN_FAKE_DIR;
    const bound = new Set(
        String(process.env.FLOE_RUN_FAKE_BOUND || '')
            .split(',')
            .filter(Boolean)
            .map(Number)
    );
    const envFile = path.join(dir, 'server-env.json');
    const note = (line) =>
        fs.appendFileSync(path.join(dir, 'calls.log'), `${line}\n`);
    const recorded = () => {
        try {
            return JSON.parse(fs.readFileSync(envFile, 'utf8'));
        } catch {
            return {};
        }
    };

    const realSpawn = cp.spawn;
    cp.spawn = (cmd, args, opts) => {
        note(`spawn ${args.join(' ')}`);
        if (args[0] !== 'server.js') throw new Error(`unexpected spawn ${cmd}`);
        const env = opts.env || {};
        const seen = {
            keys: Object.keys(env)
                .filter((k) =>
                    /^(TURN_|FLOE_LOCAL_TURN_|POLICY_FILE$)/i.test(k)
                )
                .sort(),
        };
        for (const k of [
            'POLICY_FILE',
            'TURN_DOMAIN',
            'TURN_SECRET',
            'UPSTASH_REDIS_REST_URL',
            'UPSTASH_REDIS_REST_TOKEN',
        ]) {
            if (Object.prototype.hasOwnProperty.call(env, k)) seen[k] = env[k];
        }
        fs.writeFileSync(envFile, JSON.stringify(seen));
        // Idles until stop kills it, and exits on its own once the wrapper
        // is gone, so a wrapper killed on a timeout leaks nothing.
        const idle = `setInterval(() => { try { process.kill(${process.pid}, 0); } catch { process.exit(0); } }, 500);`;
        return realSpawn(process.execPath, ['-e', idle], {
            stdio: opts.stdio,
            windowsHide: true,
        });
    };
    module.syncBuiltinESMExports();

    const route = (pathname) => {
        const env = recorded();
        if (pathname === '/health') {
            let on = false;
            try {
                on =
                    JSON.parse(fs.readFileSync(env.POLICY_FILE, 'utf8'))
                        .requestLinks === true;
            } catch {
                on = false;
            }
            return {
                status: 'healthy',
                uptime: 1,
                features: on ? ['request-1'] : [],
            };
        }
        if (pathname === '/api/stats') return { totalBytes: 0 };
        if (pathname === '/api/turn-credentials') {
            if (!(env.TURN_DOMAIN && env.TURN_SECRET)) {
                return [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                ];
            }
            const s = env.TURN_SECRET;
            return [
                { urls: `stun:${env.TURN_DOMAIN}:3478` },
                {
                    urls: `turn:${env.TURN_DOMAIN}:3478?${s}`,
                    username: s,
                    credential: s,
                },
                {
                    urls: [`turns:${env.TURN_DOMAIN}:5349?${s}`],
                    username: s,
                    credential: s,
                },
            ];
        }
        return null;
    };
    http.get = (url, cb) => {
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = () => {};
        const { pathname } = new URL(url);
        note(`get ${pathname}`);
        setImmediate(() => {
            const body = route(pathname);
            if (!body) return req.emit('error', new Error('ECONNREFUSED'));
            const res = new PassThrough();
            res.statusCode = 200;
            cb(res);
            res.end(JSON.stringify(body));
        });
        return req;
    };
    net.connect = (opts) => {
        const sock = new EventEmitter();
        sock.destroy = () => {};
        sock.setTimeout = () => sock;
        note(`connect ${opts.port}`);
        setImmediate(() =>
            bound.has(opts.port)
                ? sock.emit('connect')
                : sock.emit('error', new Error('ECONNREFUSED'))
        );
        return sock;
    };
}

let BASE;
let PRELOAD;
const printed = [];

function freshDir(name) {
    const dir = path.join(BASE, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// The test process's own environment minus anything that could steer the
// server under test: a real TURN pair, a policy file, Cloudflare or Upstash.
const STEERING = /^(FLOE_LOCAL_TURN_|TURN_|CLOUDFLARE_|UPSTASH_|POLICY_FILE$)/i;

function baseEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!STEERING.test(k)) env[k] = v;
    }
    return env;
}

function launch(args, { dir, env = {}, bound = [] }) {
    const child = spawn(
        process.execPath,
        ['--import', PRELOAD, SCRIPT, ...args],
        {
            env: {
                ...baseEnv(),
                TEMP: dir,
                TMP: dir,
                TMPDIR: dir,
                FLOE_RUN_FAKE_DIR: dir,
                FLOE_RUN_FAKE_BOUND: bound.join(','),
                ...env,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }
    );
    const run = { args, stdout: '', stderr: '', code: null };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (run.stdout += d));
    child.stderr.on('data', (d) => (run.stderr += d));
    run.exited = new Promise((resolve) =>
        child.on('close', (code) => {
            run.code = code;
            printed.push(run);
            resolve(run);
        })
    );
    run.child = child;
    return run;
}

// Waits for a run to exit, killing it after `ms` (code stays null), so a
// start that should have refused but went on to READY fails instead of hangs.
async function reap(run, ms = 15_000) {
    let timer;
    const done = await Promise.race([
        run.exited,
        new Promise((r) => (timer = setTimeout(() => r(null), ms))),
    ]);
    clearTimeout(timer);
    if (!done) run.child.kill();
    return run.exited;
}

async function once(args, opts) {
    return reap(launch(args, opts));
}

async function waitForReady(run, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (/^stop: /m.test(run.stdout)) return true;
        if (run.code !== null) return false;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function readJson(file) {
    try {
        return JSON.parse(readText(file));
    } catch {
        return null;
    }
}

function calls(dir) {
    try {
        return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
    } catch {
        return '';
    }
}

const inside = (file, dir) =>
    path
        .resolve(file)
        .toLowerCase()
        .startsWith(path.resolve(dir).toLowerCase() + path.sep);

// start -> READY -> check -> check --json -> stop, with snapshots taken while
// the stack is up. The start wrapper is always reaped, whatever fails.
async function stack(name, flags, env) {
    const dir = freshDir(name);
    const start = launch(['start', ...flags], { dir, env });
    const none = { code: null, stdout: '', stderr: '' };
    const out = {
        dir,
        start,
        env: { keys: [] },
        pidfileText: '',
        policyText: '',
    };
    out.check = out.checkJson = out.stop = none;
    try {
        // A start that never reaches READY leaves every snapshot empty, so
        // each case fails on its own assertion instead of the whole file.
        if (await waitForReady(start)) {
            out.env = readJson(path.join(dir, 'server-env.json')) || out.env;
            out.pidfileText = readText(path.join(dir, 'floe-run.json'));
            out.policyPath = out.env.POLICY_FILE;
            out.policyText = out.policyPath ? readText(out.policyPath) : '';
            out.check = await once(['check'], { dir, env, bound: [3001] });
            out.checkJson = await once(['check', '--json'], {
                dir,
                env,
                bound: [3001],
            });
            out.stop = await once(['stop'], { dir, env });
        }
    } finally {
        await reap(start);
    }
    out.policyAfterStop = out.policyPath ? fs.existsSync(out.policyPath) : null;
    return out;
}

let ON;
let OFF;

before(async () => {
    BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'floe-run-test-'));
    const preload = path.join(BASE, 'fakes.mjs');
    fs.writeFileSync(
        preload,
        [
            "import cp from 'node:child_process';",
            "import fs from 'node:fs';",
            "import http from 'node:http';",
            "import module from 'node:module';",
            "import net from 'node:net';",
            "import path from 'node:path';",
            "import { EventEmitter } from 'node:events';",
            "import { PassThrough } from 'node:stream';",
            `(${installFakes})({ cp, fs, http, module, net, path, EventEmitter, PassThrough });`,
            '',
        ].join('\n')
    );
    PRELOAD = pathToFileURL(preload).href;
    const local = {
        FLOE_LOCAL_TURN_DOMAIN: DOMAIN,
        FLOE_LOCAL_TURN_SECRET: SECRET,
    };
    [ON, OFF] = await Promise.all([
        stack('on', ['--relaxed', '--request-links', '--local-turn'], local),
        stack('off', ['--relaxed'], local),
    ]);
});

after(() => {
    if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

describe('floe-run start switches', () => {
    test('--request-links writes a policy file that says requestLinks true', () => {
        assert.match(ON.start.stdout, /^READY$/m, ON.start.stderr);
        assert.ok(ON.policyPath, 'the server was handed no POLICY_FILE');
        assert.deepEqual(JSON.parse(ON.policyText), { requestLinks: true });
        assert.ok(
            inside(ON.policyPath, ON.dir),
            `${ON.policyPath} is not beside the pidfile`
        );
        assert.ok(
            !inside(ON.policyPath, ROOT),
            `${ON.policyPath} is inside the repo tree`
        );
        assert.match(ON.start.stdout, /^features: \["request-1"\]$/m);
    });

    test('the spawn env carries POLICY_FILE only with the flag', () => {
        assert.equal(ON.env.POLICY_FILE, ON.policyPath);
        assert.match(OFF.start.stdout, /^READY$/m, OFF.start.stderr);
        assert.ok(!('POLICY_FILE' in OFF.env), JSON.stringify(OFF.env));
        assert.ok(
            !OFF.env.keys.some((k) => /^POLICY_FILE$/i.test(k)),
            OFF.env.keys.join(',')
        );
        assert.match(OFF.start.stdout, /^features: \[\]$/m);
    });

    test('stop removes the policy file', async () => {
        // After a real stop the wrapper's teardown also deletes it, so the
        // stack run alone cannot tell which of the two did. Here stop runs
        // against a pidfile with no live pids, so only stop can.
        assert.equal(ON.policyAfterStop, false);
        const dir = freshDir('stop-only');
        const policy = path.join(dir, 'floe-run-policy.json');
        fs.writeFileSync(policy, '{"requestLinks":true}\n');
        fs.writeFileSync(
            path.join(dir, 'floe-run.json'),
            JSON.stringify({
                root: ROOT,
                wrapperPid: null,
                serverPid: null,
                clientPid: null,
            })
        );
        const run = await once(['stop'], { dir });
        assert.equal(run.code, 0, run.stderr);
        assert.equal(
            fs.existsSync(policy),
            false,
            'stop left the policy file behind'
        );
        assert.equal(fs.existsSync(path.join(dir, 'floe-run.json')), false);
    });

    test('unknown flags still fail with usage', async () => {
        const dir = freshDir('usage');
        for (const args of [
            ['start', '--bogus'],
            ['start', '--request-links=true'],
            ['check', '--request-links'],
            ['check', '--local-turn'],
            ['stop', '--request-links'],
            ['restart'],
        ]) {
            const run = await once(args, { dir });
            assert.equal(run.code, 2, `${args.join(' ')}: ${run.stderr}`);
            assert.match(
                run.stderr,
                /usage: .*start \[--client\] \[--relaxed\] \[--request-links\] \[--local-turn\] \| check \[--json\] \| stop/,
                args.join(' ')
            );
        }
        assert.equal(
            calls(dir),
            '',
            'a usage failure probed, fetched or spawned something'
        );
    });

    test('--local-turn without both session variables fails with usage and spawns nothing', async () => {
        for (const [label, env] of [
            ['neither', {}],
            ['secret only', { FLOE_LOCAL_TURN_SECRET: SECRET }],
            ['domain only', { FLOE_LOCAL_TURN_DOMAIN: DOMAIN }],
            [
                'empty secret',
                { FLOE_LOCAL_TURN_DOMAIN: DOMAIN, FLOE_LOCAL_TURN_SECRET: '' },
            ],
        ]) {
            const dir = freshDir(`local-turn-${label.replace(/ /g, '-')}`);
            const run = await once(
                ['start', '--request-links', '--local-turn'],
                { dir, env }
            );
            assert.equal(run.code, 2, `${label}: ${run.stdout}${run.stderr}`);
            assert.match(
                run.stderr,
                /--local-turn needs FLOE_LOCAL_TURN_DOMAIN and FLOE_LOCAL_TURN_SECRET/,
                label
            );
            assert.match(run.stderr, /usage: /, label);
            assert.equal(
                calls(dir),
                '',
                `${label}: probed, fetched or spawned before refusing`
            );
            assert.equal(
                fs.existsSync(path.join(dir, 'floe-run-policy.json')),
                false,
                label
            );
            assert.equal(
                fs.existsSync(path.join(dir, 'floe-run.json')),
                false,
                label
            );
        }
    });

    test('the spawn env carries TURN_SECRET and TURN_DOMAIN only with --local-turn', () => {
        assert.equal(ON.env.TURN_SECRET, SECRET);
        assert.equal(ON.env.TURN_DOMAIN, DOMAIN);
        // The session's own names never reach a child, with or without the flag.
        for (const run of [ON, OFF]) {
            assert.ok(
                !run.env.keys.some((k) => /^FLOE_LOCAL_TURN_/i.test(k)),
                run.env.keys.join(',')
            );
        }
        assert.ok(
            !('TURN_SECRET' in OFF.env) && !('TURN_DOMAIN' in OFF.env),
            JSON.stringify(OFF.env)
        );
        assert.deepEqual(OFF.env.keys, []);
        assert.match(ON.start.stdout, /^turn: coturn$/m);
        assert.match(OFF.start.stdout, /^turn: stun-only$/m);
    });

    test('no printed line ever contains the secret', () => {
        // Not vacuous: the secret really reached the server, and the fake
        // served it back in every field of the credentials body.
        assert.equal(ON.env.TURN_SECRET, SECRET);
        assert.match(ON.start.stdout, /^turn: coturn$/m);
        assert.match(ON.check.stdout, /^turn: coturn$/m);
        assert.equal(JSON.parse(ON.checkJson.stdout).turn, 'coturn');
        const runs = printed.filter((r) => r.stdout || r.stderr);
        assert.ok(
            runs.length >= 8,
            `only ${runs.length} runs printed anything`
        );
        for (const run of runs) {
            for (const line of `${run.stdout}\n${run.stderr}`.split(/\r?\n/)) {
                assert.ok(
                    !line.includes(SECRET),
                    `${run.args.join(' ')} printed: ${line}`
                );
            }
        }
        assert.ok(
            !ON.pidfileText.includes(SECRET),
            'the pidfile carries the secret'
        );
        assert.ok(
            !ON.policyText.includes(SECRET),
            'the policy file carries the secret'
        );
    });

    test('check reports features and turn, in text and in --json', () => {
        for (const [run, features, turn] of [
            [ON, ['request-1'], 'coturn'],
            [OFF, [], 'stun-only'],
        ]) {
            assert.equal(
                run.check.code,
                0,
                run.check.stdout + run.check.stderr
            );
            const lines = run.check.stdout.split(/\r?\n/);
            assert.ok(
                lines.includes(`features: ${JSON.stringify(features)}`),
                run.check.stdout
            );
            assert.ok(lines.includes(`turn: ${turn}`), run.check.stdout);
            const report = JSON.parse(run.checkJson.stdout);
            assert.deepEqual(report.features, features);
            assert.equal(report.turn, turn);
            assert.equal(report.totalBytes, 0);
        }
    });

    test('the stats sentinel and its proof are unchanged by either switch', () => {
        for (const run of [ON, OFF]) {
            assert.equal(run.env.UPSTASH_REDIS_REST_URL, SENTINEL_URL);
            assert.equal(run.env.UPSTASH_REDIS_REST_TOKEN, 'local-sentinel');
            assert.match(
                run.start.stdout,
                /^stats: sentinel http:\/\/127\.0\.0\.1:9, totalBytes=0, server pid \d+$/m
            );
            const statsReads = calls(run.dir)
                .split('\n')
                .filter((l) => l === 'get /api/stats');
            assert.ok(
                statsReads.length >= 2,
                `start read /api/stats ${statsReads.length} time(s)`
            );
            assert.equal(run.stop.code, 0, run.stop.stderr);
            assert.equal(run.start.code, 0, run.start.stderr);
        }
    });
});
