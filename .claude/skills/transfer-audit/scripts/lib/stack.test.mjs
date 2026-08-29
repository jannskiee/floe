/**
 * Tests for stack.mjs: READY parsing and the check --json ladder on canned
 * output, statsTotal against a throwaway local HTTP server, the post
 * --client hygiene in a temporary git repo, and ensureStack / stopStack
 * against tests/fake-floe-run.mjs standing in for the floe-run script (no
 * port is bound, nothing under server/ runs).
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/stack.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { PhaseError } from './surfaces.mjs';
import { killAllStarted } from './proc.mjs';
import {
    FLOE_RUN_REL,
    corepackEnv,
    ensureStack,
    floeRunPath,
    parseCheck,
    parseReady,
    runHygiene,
    stackRootFor,
    statsTotal,
    stopStack,
} from './stack.mjs';

const FAKE_RUN = fileURLToPath(
    new URL('./tests/fake-floe-run.mjs', import.meta.url)
);
const made = [];
function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'transfer-audit-stack-'));
    made.push(dir);
    return dir;
}

after(() => {
    killAllStarted();
    for (const d of made)
        rmSync(d, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
        });
});

const READY_WITH_CLIENT = [
    '[server] ',
    'READY',
    'stats: sentinel http://127.0.0.1:9, totalBytes=0, server pid 31337',
    'server: http://localhost:3001  (/health, /api/stats, /api/turn-credentials)',
    'web: http://localhost:3000  (corepack pnpm dev, NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001, pid 4242)',
    'cli: floe send <file> --server http://localhost:3001 --web http://localhost:3000',
    '     floe receive <code> --server http://localhost:3001',
    'limiters: relaxed to 1000/min per IP',
    'pidfile: C:\\Users\\alice\\AppData\\Local\\Temp\\floe-run.json (wrapper pid 777)',
    'stop: node .claude/skills/floe-run/scripts/floe-run.mjs stop',
    '[client]  ready in 2.1s',
].join('\n');

test('parseReady: the full block with a client', () => {
    const r = parseReady(READY_WITH_CLIENT);
    assert.deepEqual(r, {
        server: 'http://localhost:3001',
        web: 'http://localhost:3000',
        clientStarted: true,
        relaxed: true,
        limiters: 'relaxed to 1000/min per IP',
        totalBytes: 0,
        serverPid: 31337,
        clientPid: 4242,
        wrapperPid: 777,
        pidfile: 'C:\\Users\\alice\\AppData\\Local\\Temp\\floe-run.json',
        complete: true,
    });
});

test('parseReady: server only, defaults, partial and absent', () => {
    const serverOnly = READY_WITH_CLIENT.replace(
        /^web: .*$/m,
        'web: not started (pass --client for next dev on :3000)'
    ).replace(
        'limiters: relaxed to 1000/min per IP',
        'limiters: server defaults'
    );
    const r = parseReady(serverOnly);
    assert.equal(r.web, null);
    assert.equal(r.clientStarted, false);
    assert.equal(r.relaxed, false);
    assert.equal(r.clientPid, null);
    assert.equal(r.server, 'http://localhost:3001');
    assert.equal(parseReady('[server] starting\nnothing yet\n'), null);
    const partial = parseReady(
        'READY\nstats: sentinel http://127.0.0.1:9, totalBytes=0, server pid 1\n'
    );
    assert.equal(partial.complete, false);
    assert.equal(partial.serverPid, 1);
    assert.equal(partial.server, null);
});

test('parseCheck maps the floe-run ladder', () => {
    const json = (code) => JSON.stringify({ verdict: 'v', exitCode: code });
    assert.equal(parseCheck(2, json(2)).action, 'start');
    assert.equal(parseCheck(0, json(0)).action, 'reuse');
    assert.equal(parseCheck(1, json(1)).action, 'refuse');
    assert.equal(parseCheck(2, '').action, 'start');
    assert.equal(parseCheck(1, 'not json').action, 'refuse');
    assert.equal(parseCheck(null, '').action, 'refuse');
    // The report's own code wins over a wrapper's exit.
    assert.equal(parseCheck(0, json(1)).action, 'refuse');
    assert.equal(parseCheck(2, json(0)).report.verdict, 'v');
});

test('floeRunPath and corepackEnv', () => {
    assert.equal(FLOE_RUN_REL, '.claude/skills/floe-run/scripts/floe-run.mjs');
    const p = floeRunPath('C:\\repo');
    assert.ok(
        p.endsWith(
            join('.claude', 'skills', 'floe-run', 'scripts', 'floe-run.mjs')
        )
    );
    const env = corepackEnv({ PATH: 'p' });
    assert.deepEqual(env, {
        PATH: 'p',
        COREPACK_ENABLE_AUTO_PIN: '0',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    });
    assert.equal(corepackEnv().COREPACK_ENABLE_AUTO_PIN, '0');
});

test('statsTotal reads totalBytes with a GET and rejects anything else', async () => {
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push({ method: req.method, url: req.url });
        if (req.url === '/api/stats') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ totalBytes: 0 }));
        } else if (req.url === '/bad/api/stats') {
            res.end('nope');
        } else {
            res.statusCode = 404;
            res.end();
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal(await statsTotal(`${base}/`), 0);
        assert.equal(await statsTotal(base), 0);
        await assert.rejects(statsTotal(`${base}/bad`), (err) => {
            assert.ok(err instanceof PhaseError);
            assert.match(err.message, /no JSON/);
            return true;
        });
        await assert.rejects(statsTotal(`${base}/missing`), /answered 404/);
        assert.ok(hits.every((h) => h.method === 'GET'));
        assert.equal(hits[0].url, '/api/stats');
    } finally {
        server.close();
    }
});

// autocrlf false: the assertions compare bytes, and a global autocrlf=true
// would rewrite the checked-out file to CRLF.
function initRepo(root) {
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
}

// gpgsign off: the seed commit in a throwaway fixture repo must not depend
// on the developer's signing agent (a locked 1Password fails the commit
// with "failed to fill whole buffer").
function git(cwd, ...args) {
    return execFileSync(
        'git',
        [
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@example.com',
            '-c',
            'commit.gpgsign=false',
            ...args,
        ],
        {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }
    );
}

test('runHygiene restores next-env.d.ts and deletes only untracked generated files', () => {
    const root = fresh();
    initRepo(root);
    mkdirSync(join(root, 'client'), { recursive: true });
    writeFileSync(join(root, 'client', 'next-env.d.ts'), 'original\n');
    writeFileSync(join(root, 'client', 'CLAUDE.md'), 'tracked on purpose\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'seed');
    writeFileSync(
        join(root, 'client', 'next-env.d.ts'),
        'rewritten by next dev\n'
    );
    writeFileSync(join(root, 'client', 'AGENTS.md'), 'generated\n');
    const actions = runHygiene(root);
    assert.equal(
        readFileSync(join(root, 'client', 'next-env.d.ts'), 'utf8'),
        'original\n'
    );
    assert.ok(!existsSync(join(root, 'client', 'AGENTS.md')));
    assert.ok(
        existsSync(join(root, 'client', 'CLAUDE.md')),
        "a tracked CLAUDE.md is the repo's own"
    );
    assert.deepEqual(actions, [
        'git checkout -- client/next-env.d.ts',
        'deleted client/AGENTS.md',
        'kept tracked client/CLAUDE.md',
    ]);
    assert.equal(git(root, 'status', '--porcelain').trim(), '');
});

function fakeRoot(checkCode, { client = false } = {}) {
    const root = fresh();
    const script = floeRunPath(root);
    mkdirSync(join(script, '..'), { recursive: true });
    copyFileSync(FAKE_RUN, script);
    process.env.FAKE_FLOE_RUN_CHECK = String(checkCode);
    process.env.FAKE_FLOE_RUN_CLIENT = client ? '1' : '0';
    process.env.FAKE_FLOE_RUN_STOPFILE = join(root, 'stop.marker');
    return root;
}

test('ensureStack starts on exit 2, stopStack stops only what it started', async () => {
    const root = fakeRoot(2);
    const handle = await ensureStack({
        root,
        client: false,
        relaxed: true,
        evidenceDir: join(root, 'evidence'),
    });
    assert.equal(handle.started, true);
    assert.equal(handle.server, 'http://localhost:3001');
    assert.equal(handle.web, null);
    assert.equal(handle.relaxed, true);
    assert.equal(handle.ready.serverPid, 4242);
    assert.equal(handle.ready.complete, true);
    assert.ok(handle.h.argv.includes('--relaxed'));
    assert.ok(!handle.h.argv.includes('--client'));
    assert.equal(handle.h.exit, null, 'the wrapper stays up');
    const stopped = await handle.stop();
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.stopExit, 0);
    assert.match(stopped.stopOut, /stopped server/);
    assert.equal(stopped.wrapperExit.code, 0);
    assert.deepEqual(stopped.hygiene, []);
    assert.equal(handle.started, false);
    assert.deepEqual(await stopStack(handle), {
        stopped: false,
        reason: 'stack not started by this run',
    });
});

test('ensureStack with --client parses the web line and runs the hygiene on stop', async () => {
    const root = fakeRoot(2);
    initRepo(root);
    mkdirSync(join(root, 'client'));
    writeFileSync(join(root, 'client', 'next-env.d.ts'), 'original\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'seed');
    const handle = await ensureStack({
        root,
        client: true,
        relaxed: false,
        evidenceDir: join(root, 'evidence'),
    });
    assert.equal(handle.web, 'http://localhost:3000');
    assert.equal(handle.relaxed, false);
    assert.equal(handle.ready.clientPid, 4343);
    writeFileSync(join(root, 'client', 'next-env.d.ts'), 'rewritten\n');
    writeFileSync(join(root, 'client', 'AGENTS.md'), 'generated\n');
    const stopped = await handle.stop();
    assert.deepEqual(stopped.hygiene, [
        'git checkout -- client/next-env.d.ts',
        'deleted client/AGENTS.md',
    ]);
    assert.equal(
        readFileSync(join(root, 'client', 'next-env.d.ts'), 'utf8'),
        'original\n'
    );
});

test('ensureStack reuses an owned stack on exit 0 and never stops it', async () => {
    const root = fakeRoot(0, { client: true });
    const handle = await ensureStack({ root });
    assert.equal(handle.started, false);
    assert.equal(handle.server, 'http://localhost:3001');
    assert.equal(handle.web, 'http://localhost:3000');
    assert.equal(handle.h, null);
    assert.equal(handle.report.owned, true);
    assert.deepEqual(await handle.stop(), {
        stopped: false,
        reason: 'stack not started by this run',
    });
});

test('ensureStack with clientDir runs floe-run from the checkout that owns the client tree', async () => {
    const main = fakeRoot(0, { client: true });
    mkdirSync(join(main, 'client'), { recursive: true });
    const worktree = fresh();
    assert.equal(
        stackRootFor({ root: worktree, clientDir: join(main, 'client') }),
        main
    );
    assert.equal(stackRootFor({ root: worktree }), worktree);
    const notes = [];
    const handle = await ensureStack({
        root: worktree,
        clientDir: join(main, 'client'),
        log: (l) => notes.push(l),
    });
    assert.equal(handle.root, main);
    assert.equal(handle.owned, true);
    assert.equal(handle.started, false);
    assert.equal(handle.client, true);
    assert.equal(handle.web, 'http://localhost:3000');
    assert.ok(notes.some((l) => l.includes('owns --client-dir')));
});

test('ensureStack refuses to start without an evidence dir (no tmpdir fallback)', async () => {
    const root = fakeRoot(2);
    await assert.rejects(ensureStack({ root, client: false }), (err) => {
        assert.ok(err instanceof PhaseError);
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /evidenceDir is required/);
        return true;
    });
});

test('ensureStack refuses on exit 1 with a precondition error', async () => {
    const root = fakeRoot(1);
    await assert.rejects(ensureStack({ root }), (err) => {
        assert.ok(err instanceof PhaseError);
        assert.equal(err.phase, 'precondition');
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /bound but not by this script/);
        return true;
    });
    await assert.rejects(ensureStack({ root: fresh() }), /floe-run not found/);
});
