// node --test .claude/skills/<skill>/scripts/audit.test.mjs
// The entry point on fake adapters: parseArgs and usage exit 2, the exit
// precedence through a full `run` (versions, builds, infra and probe are
// injected; the cells run on tests/fake-legs.mjs), PROGRESS lines,
// audit.md and run.json, the versions and cleanup subcommands, and
// --self-test as a child process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import {
    main,
    parseWslList,
    prepareWslBuild,
    probeWsl,
    profileLine,
    purgeRunData,
    webHeadLabel,
} from './audit.mjs';
import { fakeWorld, makeFakeAdapters } from './lib/tests/fake-legs.mjs';

const SCRIPT = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');
const base = mkdtempSync(path.join(tmpdir(), 'lta-audit-'));
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

const root = path.join(base, 'repo');
mkdirSync(path.join(root, 'client'), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# fake checkout');
writeFileSync(path.join(root, 'client', 'package.json'), '{}');
mkdirSync(path.join(root, 'cli', 'engine', 'transfer'), { recursive: true });
mkdirSync(path.join(root, 'client', 'lib', 'transfer'), { recursive: true });
writeFileSync(
    path.join(root, 'cli', 'engine', 'transfer', 'protocol.go'),
    'ProtocolVersion    = 1\nMinProtocolVersion = 1\n'
);
writeFileSync(
    path.join(root, 'client', 'lib', 'transfer', 'protocol.ts'),
    'export const PROTOCOL_VERSION = 1;\nexport const MIN_PROTOCOL_VERSION = 1;\n'
);

const VERSIONS = (drift = false) => ({
    rows: [
        {
            surface: 'CLI on PATH',
            installed: '3.4.5',
            latest: 'v3.4.5',
            oracle: 'floe --version',
            status: 'CURRENT',
            gate: false,
            suggest: null,
            detail: {},
        },
        {
            surface: 'CLI under test',
            installed: '3.4.5 (path)',
            latest: 'v3.4.5',
            oracle: 'floe --version',
            status: 'CURRENT',
            gate: true,
            suggest: null,
            detail: {},
        },
        {
            surface: 'Web floe.one',
            installed: drift ? '1111111' : '2222222',
            latest: 'main 2222222',
            oracle: '--web-sha; gh compare',
            status: drift ? 'STALE' : 'CURRENT',
            gate: true,
            suggest: null,
            detail: {},
        },
        {
            surface: 'Protocol',
            installed: 'go 1/1, ts 1/1',
            latest: '-',
            oracle: 'source diff',
            status: 'PARITY',
            gate: true,
            suggest: null,
            detail: {},
        },
    ],
    latest: { cli: 'v3.4.5', desktop: 'desktop-v3.4.5' },
    pathCli: { path: 'C:\\x\\floe.exe', version: '3.4.5' },
    mainSha: '2222222222222222222222222222222222222222',
    web: { sha: '2222222', oracle: '--web-sha' },
    localCommit: { sha: 'aaaaaaaaaa', branch: 'main' },
    ghOk: true,
});

const BUILDS = {
    cli: {
        kind: 'shipped',
        source: 'path',
        tag: 'v3.4.5',
        version: '3.4.5',
        path: 'C:\\x\\floe.exe',
        sha256: 'c'.repeat(64),
        hasRelayOnly: false,
    },
    desktop: {
        kind: 'shipped',
        launch: 'portable',
        version: '3.4.5',
        path: 'C:\\x\\floe-desktop.exe',
        isPackaged: false,
        tag: 'desktop-v3.4.5',
    },
    web: { kind: 'shipped', origin: 'https://www.floe.one', sha: '2222222' },
    wsl: null,
};
const INFRA = {
    name: 'prod',
    server: 'https://api.invalid',
    web: 'https://web.invalid',
    servesTurn: true,
    relaxed: false,
    statsOracle: 'none',
};
const PROBE = {
    at: new Date().toISOString(),
    turn: {
        prod: {
            servesTurn: true,
            status: 200,
            entries: 2,
            schemes: ['stun', 'turn', 'turns'],
        },
        local: null,
    },
    browserRelay: { ok: true },
    desktop: { available: true, receiverDrivable: true, saveDirSettable: true },
    wsl: { present: false },
    firewall: { inboundAllow: null },
    disk: { freeBytes: 100e9 },
    pending: [],
};

function io(world, extra = {}) {
    const adapters = makeFakeAdapters(world);
    const stdout = [];
    const stderr = [];
    return {
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        lines: stdout,
        errors: stderr,
        getAdapter: async (name) => adapters[name],
        tryAdapter: async (name) => adapters[name] ?? null,
        exec: (cmd, args) => {
            if (cmd === 'git' && args[0] === 'status') return '';
            if (cmd === 'git' && args[0] === 'worktree')
                return `worktree ${root}\n`;
            if (cmd === 'go') return 'go version go1.25 windows/amd64';
            return '';
        },
        versions: VERSIONS(),
        builds: BUILDS,
        infra: INFRA,
        infraRows: [
            {
                check: 'api.floe.one /health',
                ok: true,
                detail: 'healthy (fake)',
            },
        ],
        probe: PROBE,
        sleep: async () => {},
        retryWaitMs: 0,
        drainWaitMs: 0,
        noSignals: true,
        appData: path.join(base, 'appdata'),
        defaultRoot: root,
        ...extra,
    };
}

function shrink(cells) {
    for (const c of cells) {
        if (c.fixture.kind === 'single') {
            c.fixture.bytes = 2048;
            c.fixture.totalBytes = 2048;
        }
        c.timeouts.route = 200;
    }
}

const out = (name) => path.join(base, name);

test('usage: unknown flag exits 2 with nothing on stdout', async () => {
    const i = io(fakeWorld());
    assert.equal(await main(['run', '--bogus'], i), 2);
    assert.equal(i.lines.length, 0);
    assert.match(i.errors[0], /unknown flag/);
    assert.ok(i.errors.some((l) => l.includes('usage:')));
    assert.equal(await main(['run', '--quick', '--deep', '--json'], i), 2);
    assert.equal(await main([], io(fakeWorld())), 0);
});

test('--self-test exits 0 and prints the ok table (child process)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--self-test'], {
        encoding: 'utf8',
        windowsHide: true,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /self-test green/);
    assert.ok(!/FAIL/.test(r.stdout));
});

test('run --quick on fake adapters: all PASS, PROGRESS lines, audit.md and run.json, exit 0', async () => {
    const world = fakeWorld();
    const i = io(world, { shrinkCells: true });
    const outDir = out('quick');
    const code = await main(
        [
            'run',
            '--quick',
            '--root',
            root,
            '--out',
            outDir,
            '--desktop',
            'portable',
        ],
        { ...i, cellHook: shrink }
    );
    assert.equal(
        i.lines[0],
        'profile: shipped (default)',
        'the profile in effect is the first line'
    );
    const progress = i.lines.filter((l) => l.startsWith('PROGRESS '));
    assert.equal(progress.length, 6, i.lines.join('\n'));
    assert.ok(
        progress.every((l) => / PASS$/.test(l)),
        progress.join('\n')
    );
    assert.equal(code, 0, i.lines.join('\n'));
    const runs = readdirSync(outDir).filter((d) => /-shipped-quick$/.test(d));
    assert.equal(runs.length, 1);
    const runDir = path.join(outDir, runs[0]);
    for (const f of [
        'manifest.json',
        'log.txt',
        'audit.md',
        'run.json',
        'versions.json',
    ])
        assert.ok(existsSync(path.join(runDir, f)), f);
    assert.ok(existsSync(path.join(outDir, 'ledger.json')));
    const md = readFileSync(path.join(runDir, 'audit.md'), 'utf8');
    assert.ok(
        md.startsWith(
            '# Floe live-transfer audit: 6/6 PASS, all surfaces on latest'
        )
    );
    assert.match(md, /\| S-REL-W2C\s+\| PASS/);
    assert.ok(md.includes('relay [W local]'));
    const json = JSON.parse(
        readFileSync(path.join(runDir, 'run.json'), 'utf8')
    );
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.run.exitCode, 0);
    assert.equal(json.totals.pass, 6);
    assert.equal(json.safety.cliReceiversOptedOut.ok, 3);
    assert.equal(json.safety.workingTreeUnchanged, true);
    assert.equal(json.run.relayBytes, 2048);
    const manifest = JSON.parse(
        readFileSync(path.join(runDir, 'manifest.json'), 'utf8')
    );
    assert.ok(manifest.pids.length >= 12);
    assert.ok(
        manifest.pids.every((p) => 'creation' in p),
        'every pid entry carries a creation slot for cleanup to compare'
    );
    assert.deepEqual(manifest.desktop, {
        backup: null,
        configPath: null,
        sha256: null,
        restored: null,
    });
    assert.ok(i.lines.some((l) => l.includes('transfer-audit: exit 0')));
});

test('--out or --bin-dir inside a checkout is a usage error (exit 2) before anything is created', async () => {
    const inside = path.join(root, 'lta-scratch');
    const cases = [
        ['run', '--quick', '--root', root, '--out', inside],
        [
            'run',
            '--quick',
            '--root',
            root,
            '--out',
            out('ok-out'),
            '--bin-dir',
            path.join(root, 'bin'),
        ],
        ['probe', '--root', root, '--out', inside],
        ['cleanup', '--root', root, '--out', inside],
    ];
    for (const argv of cases) {
        const i = io(fakeWorld());
        assert.equal(
            await main(argv, { ...i, cellHook: shrink }),
            2,
            argv.join(' ')
        );
        assert.equal(i.lines.length, 0, 'nothing on stdout');
        assert.ok(
            i.errors.some((l) => /inside the checkout/.test(l)),
            i.errors.join('\n')
        );
    }
    assert.ok(!existsSync(inside));
    assert.ok(!existsSync(path.join(root, 'bin')));
    assert.ok(!existsSync(out('ok-out')), 'the run never got as far as mkdir');
});

test('run and probe build the fence before creating anything: a --out under the real Floe app data leaves no trace', async () => {
    const appData = path.join(base, 'appdata');
    const runOut = path.join(appData, 'floe', 'lta-out');
    const i = io(fakeWorld());
    assert.equal(
        await main(['run', '--quick', '--root', root, '--out', runOut], {
            ...i,
            cellHook: shrink,
        }),
        4
    );
    assert.equal(i.lines.length, 0);
    assert.ok(
        i.errors.some((l) => /safety invariant tripped: write refused/.test(l)),
        i.errors.join('\n')
    );
    assert.ok(!existsSync(runOut), 'no run dir');
    assert.ok(!existsSync(path.join(appData, 'floe')), 'no app data tree');
    const probeOut = path.join(appData, 'floe', 'lta-probe');
    const p = io(fakeWorld());
    assert.equal(
        await main(['probe', '--root', root, '--out', probeOut], p),
        4
    );
    assert.equal(p.lines.length, 0);
    assert.ok(!existsSync(probeOut), 'no probe.log, no probe dir');
    assert.ok(!existsSync(path.join(appData, 'floe')));
});

test('cleanup never deletes an operator --bin-dir or a manifest path outside --out', async () => {
    const outDir = out('cleanup-foreign');
    const runId = '20260103-000000-shipped-quick';
    const runDir = path.join(outDir, runId);
    mkdirSync(runDir, { recursive: true });
    const tools = path.join(base, 'user-tools');
    const precious = path.join(tools, 'precious.txt');
    const victim = path.join(base, 'victim-appdata');
    const keep = path.join(victim, 'keep.txt');
    const foreignFixtures = path.join(base, 'foreign-fixtures');
    const fixture = path.join(foreignFixtures, 'f.bin');
    for (const [dir, file] of [
        [tools, precious],
        [victim, keep],
        [foreignFixtures, fixture],
    ]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, 'keep me');
    }
    // A manifest with no ownership flag (older run), one that claims the
    // operator's dir as owned (tampered), and one marked not owned: none
    // may reach the operator's files, and the foreign redirect and fixture
    // dirs are refused by the fence, never obeyed.
    for (const owned of [undefined, true, false]) {
        writeFileSync(
            path.join(runDir, 'manifest.json'),
            JSON.stringify({
                runId,
                binDir: tools,
                ...(owned === undefined ? {} : { binDirOwned: owned }),
                pids: [],
                desktop: { backup: null },
                stack: { started: false },
                fixtureDirs: [foreignFixtures],
                appDataRedirect: victim,
            })
        );
        const i = io(fakeWorld(), { tryAdapter: async () => null });
        const code = await main(
            ['cleanup', '--run', runId, '--root', root, '--out', outDir],
            i
        );
        assert.equal(code, 1, `owned=${owned}: refusals exit 1`);
        assert.ok(existsSync(precious), `owned=${owned}: --bin-dir intact`);
        assert.ok(existsSync(keep), `owned=${owned}: redirect dir intact`);
        assert.ok(existsSync(fixture), `owned=${owned}: fixture dir intact`);
        assert.ok(
            i.errors.filter((l) =>
                /write refused: outside every allowed dir/.test(l)
            ).length >= 2,
            `owned=${owned}: ${i.errors.join('\n')}`
        );
        assert.ok(
            i.lines.concat(i.errors).some((l) => l.includes(tools)),
            `owned=${owned}: the bin dir decision is reported`
        );
    }
    // Passing the same --bin-dir again makes it writable, never deletable.
    const again = io(fakeWorld(), { tryAdapter: async () => null });
    await main(
        [
            'cleanup',
            '--run',
            runId,
            '--root',
            root,
            '--out',
            outDir,
            '--bin-dir',
            tools,
        ],
        again
    );
    assert.ok(existsSync(precious));
    assert.ok(
        again.lines.some((l) =>
            /kept .*user-tools \(operator --bin-dir\)/.test(l)
        )
    );
    // A manifest whose binDir is --out itself can never trigger the wholesale delete.
    writeFileSync(
        path.join(runDir, 'manifest.json'),
        JSON.stringify({
            runId,
            binDir: outDir,
            binDirOwned: true,
            pids: [],
            desktop: { backup: null },
            stack: { started: false },
            fixtureDirs: [],
            appDataRedirect: null,
        })
    );
    const self = io(fakeWorld(), { tryAdapter: async () => null });
    assert.equal(
        await main(
            ['cleanup', '--run', runId, '--root', root, '--out', outDir],
            self
        ),
        0
    );
    assert.ok(existsSync(path.join(runDir, 'manifest.json')), '--out survived');
});

test('cleanup refuses a pid whose creation time differs from the manifest', async () => {
    const outDir = out('cleanup-creation');
    const runId = '20260104-000000-shipped-quick';
    const runDir = path.join(outDir, runId);
    mkdirSync(runDir, { recursive: true });
    const stamp = '2026-01-01T00:00:00.0000000Z';
    writeFileSync(
        path.join(runDir, 'manifest.json'),
        JSON.stringify({
            runId,
            binDir: path.join(outDir, 'bin'),
            pids: [
                {
                    pid: 5151,
                    label: 'recycled',
                    image: 'floe.exe',
                    creation: stamp,
                },
                {
                    pid: 5252,
                    label: 'same',
                    image: 'floe.exe',
                    creation: stamp,
                },
                {
                    pid: 5353,
                    label: 'unknown',
                    image: 'floe.exe',
                    creation: null,
                },
            ],
            desktop: { backup: null },
            stack: { started: false },
            fixtureDirs: [],
            appDataRedirect: null,
        })
    );
    const killed = [];
    const asked = [];
    const i = io(fakeWorld(), {
        tryAdapter: async () => null,
        processImage: () => 'floe.exe',
        creationTime: (pid) => {
            asked.push(pid);
            return pid === 5151 ? '2026-08-29T00:00:00.0000000Z' : stamp;
        },
        kill: (pid) => killed.push(pid),
    });
    const code = await main(
        ['cleanup', '--run', runId, '--root', root, '--out', outDir],
        i
    );
    assert.equal(code, 1, i.errors.join('\n'));
    assert.deepEqual(killed, [5252, 5353]);
    assert.deepEqual(asked, [5151, 5252], 'no stamp recorded, no comparison');
    assert.ok(
        i.errors.some((l) =>
            /pid 5151 was created at 2026-08-29.*not the 2026-01-01.*recycled/.test(
                l
            )
        )
    );
});

test('probe --desktop none says so on the P7 line; profileLine and webHeadLabel', async () => {
    const json = (body) =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    const fetchImpl = async (url) =>
        String(url).endsWith('/health')
            ? json({ status: 'healthy', uptime: 5 })
            : json({ iceServers: [{ urls: ['stun:x:3478'] }] });
    const i = io(fakeWorld(), { fetchImpl });
    const outDir = out('probe-none');
    const code = await main(
        [
            'probe',
            '--profile',
            'head',
            '--desktop',
            'none',
            '--root',
            root,
            '--out',
            outDir,
        ],
        i
    );
    assert.equal(code, 0, i.lines.concat(i.errors).join('\n'));
    const text = i.lines.join('\n');
    assert.match(
        text,
        /^probe P7 MOTW: (n\/a \(--desktop none\)|not windows)$/m
    );
    assert.ok(!/store build/.test(text), text);
    assert.equal(i.lines[0], 'profile: head');

    assert.equal(
        profileLine({ profile: 'shipped', profileGiven: false }),
        'profile: shipped (default)'
    );
    assert.equal(
        profileLine({ profile: 'shipped', profileGiven: true }),
        'profile: shipped'
    );
    assert.equal(profileLine({ profile: 'head' }), 'profile: head');

    // The served web tree is the --client-dir checkout, not --root.
    const other = path.join(base, 'other-worktree');
    const calls = [];
    const exec = (cmd, args, o) => {
        calls.push([cmd, ...args, o?.cwd]);
        if (cmd === 'git' && args[0] === 'rev-parse')
            return o.cwd === path.resolve(other) ? 'bbbbbbb' : 'aaaaaaa';
        return '';
    };
    const same = webHeadLabel({
        root,
        clientDir: path.join(root, 'client'),
        rootSha7: 'aaaaaaa',
        exec,
    });
    assert.deepEqual(
        [same.version, same.sha7, calls.length],
        ['local HEAD aaaaaaa', 'aaaaaaa', 0]
    );
    const elsewhere = webHeadLabel({
        root,
        clientDir: path.join(other, 'client'),
        rootSha7: 'aaaaaaa',
        exec,
    });
    assert.equal(elsewhere.version, 'local HEAD bbbbbbb');
    assert.equal(elsewhere.webRoot, path.resolve(other));
    assert.deepEqual(calls[0].slice(0, 4), [
        'git',
        'rev-parse',
        '--short=7',
        'HEAD',
    ]);
    const noGit = webHeadLabel({
        root,
        clientDir: path.join(other, 'client'),
        exec: () => {
            throw new Error('not a git repository');
        },
    });
    assert.equal(noGit.version, 'local HEAD unknown');
});

test('cleanup replays a desktop.json backup through the fence, and refuses a manifest that names another file', async () => {
    const outDir = out('cleanup-desktop');
    const runId = '20260105-000000-shipped-quick';
    const runDir = path.join(outDir, runId);
    mkdirSync(runDir, { recursive: true });
    const bak = path.join(runDir, 'desktop.json.bak');
    writeFileSync(bak, '{"reportStats":true}\n');
    const cfg = path.join(base, 'appdata', 'floe', 'desktop.json');
    const seen = [];
    const desktop = {
        restoreConfig: async (rec, { fence }) => {
            seen.push(rec.configPath);
            fence.assertWritable(rec.configPath, { viaGuard: true });
            return { ok: true, written: true, detail: 'restored (fake)' };
        },
    };
    const write = (configPath) =>
        writeFileSync(
            path.join(runDir, 'manifest.json'),
            JSON.stringify({
                runId,
                binDir: path.join(outDir, 'bin'),
                pids: [],
                desktop: {
                    backup: bak,
                    configPath,
                    sha256: 'x',
                    restored: null,
                },
                stack: { started: false },
                fixtureDirs: [],
                appDataRedirect: null,
            })
        );
    write(cfg);
    const ok = io(fakeWorld(), {
        tryAdapter: async (name) => (name === 'desktop' ? desktop : null),
    });
    assert.equal(
        await main(
            ['cleanup', '--run', runId, '--root', root, '--out', outDir],
            ok
        ),
        0,
        ok.errors.join('\n')
    );
    assert.ok(ok.lines.some((l) => /desktop\.json: restored \(fake\)/.test(l)));
    write(path.join(base, 'victim.json'));
    const bad = io(fakeWorld(), {
        tryAdapter: async (name) => (name === 'desktop' ? desktop : null),
    });
    assert.equal(
        await main(
            ['cleanup', '--run', runId, '--root', root, '--out', outDir],
            bad
        ),
        1
    );
    assert.ok(
        bad.errors.some((l) =>
            /desktop\.json restore failed: write refused/.test(l)
        )
    );
    assert.deepEqual(seen, [cfg, path.join(base, 'victim.json')]);
});

test('run default on fake adapters with a FAIL, a FLAKY and NA rows: exit 1, precedence over drift', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-C2D', 'early-race');
    world.setScript('S-DIR-C2W', 'retry-then-pass');
    const i = io(world, { versions: VERSIONS(true) });
    const code = await main(
        ['run', '--root', root, '--out', out('default'), '--json'],
        { ...i, cellHook: shrink }
    );
    assert.equal(code, 1);
    const json = JSON.parse(i.lines.find((l) => l.startsWith('{')));
    assert.equal(json.totals.total, 18);
    assert.equal(json.totals.na, 3);
    assert.equal(json.totals.fail, 1);
    assert.equal(json.totals.flaky, 1);
    assert.equal(json.totals.pass, 13);
    // FLAKY is its own count in the headline, never folded into SKIP.
    assert.match(
        json.run.headline,
        /^1 FAIL \(S-DIR-C2D\); 1 FLAKY; surfaces stale: Web floe\.one$/
    );
    const fail = json.cells.find((c) => c.id === 'S-DIR-C2D');
    assert.equal(fail.reason, 'early-race');
    assert.equal(fail.attempts.length, 1);
    assert.equal(json.pacing.retriesUsed, 1);
});

test('exit 5 on SKIP without FAIL, exit 6 on drift only, --strict turns FLAKY into 1, --cells filter does not count', async () => {
    const world = fakeWorld();
    const skipProbe = {
        ...PROBE,
        desktop: { available: true, receiverDrivable: false },
    };
    const s = io(world, { probe: skipProbe });
    assert.equal(
        await main(['run', '--quick', '--root', root, '--out', out('skip')], {
            ...s,
            cellHook: shrink,
        }),
        5
    );
    assert.ok(s.lines.some((l) => l === 'PROGRESS S-DIR-C2D SKIP'));
    const d = io(fakeWorld(), { versions: VERSIONS(true) });
    assert.equal(
        await main(['run', '--quick', '--root', root, '--out', out('drift')], {
            ...d,
            cellHook: shrink,
        }),
        6
    );
    const w2 = fakeWorld();
    w2.setScript('S-DIR-C2W', 'retry-then-pass');
    const strict = io(w2);
    assert.equal(
        await main(
            [
                'run',
                '--quick',
                '--strict',
                '--root',
                root,
                '--out',
                out('strict'),
            ],
            { ...strict, cellHook: shrink }
        ),
        1
    );
    const f = io(fakeWorld());
    assert.equal(
        await main(
            [
                'run',
                '--cells',
                'S-DIR-W2W',
                '--root',
                root,
                '--out',
                out('cells'),
            ],
            { ...f, cellHook: shrink }
        ),
        0
    );
    assert.equal(
        f.lines.filter((l) => l.startsWith('PROGRESS ') && / PASS$/.test(l))
            .length,
        1
    );
    assert.ok(f.lines.some((l) => l === 'PROGRESS S-DIR-C2C SKIP'));
});

test('a safety breach aborts the run with exit 4, above a FAIL', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-W2W', 'early-race');
    world.setScript('S-DIR-C2W', 'stats-breach');
    const i = io(world);
    const code = await main(
        ['run', '--quick', '--root', root, '--out', out('safety')],
        { ...i, cellHook: shrink }
    );
    assert.equal(code, 4);
    assert.ok(i.lines.some((l) => l === 'PROGRESS S-DIR-C2W ERROR'));
    assert.ok(
        !i.lines.some((l) => l.startsWith('PROGRESS S-DIR-W2C')),
        'the run stops at the breach'
    );
});

test('two consecutive infra symptoms skip the rest and exit 3', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-W2W', 'infra-down');
    world.setScript('S-DIR-C2W', 'infra-down');
    const i = io(world);
    const code = await main(
        ['run', '--quick', '--root', root, '--out', out('infra')],
        { ...i, cellHook: shrink, retryCap: 0 }
    );
    assert.equal(code, 3);
    assert.ok(i.lines.some((l) => l === 'PROGRESS S-DIR-W2C SKIP'));
    assert.ok(i.lines.some((l) => l === 'PROGRESS S-DIR-C2D SKIP'));
});

test('versions subcommand exits 0 or 6 and prints a table or JSON', async () => {
    const ok = io(fakeWorld());
    assert.equal(await main(['versions', '--root', root], ok), 0);
    assert.ok(ok.lines.some((l) => l.startsWith('Surface')));
    assert.ok(ok.lines.some((l) => /every gating row current/.test(l)));
    const drift = io(fakeWorld(), { versions: VERSIONS(true) });
    assert.equal(await main(['versions', '--root', root, '--json'], drift), 6);
    const json = JSON.parse(drift.lines.join('\n'));
    assert.deepEqual(json.drift, ['Web floe.one']);
    assert.equal(json.exitCode, 6);
});

test('cleanup replays the manifest: own pids only, refusals exit 1', async () => {
    const outDir = out('cleanup');
    const runDir = path.join(outDir, '20260101-000000-shipped-quick');
    mkdirSync(path.join(runDir, 'fixtures'), { recursive: true });
    writeFileSync(path.join(runDir, 'fixtures', 'x.bin'), 'x');
    const binDir = path.join(outDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'floe.exe'), 'fake');
    const manifest = {
        runId: '20260101-000000-shipped-quick',
        binDir,
        pids: [
            { pid: 4242, label: 'S-DIR-W2C:sender', image: 'floe.exe' },
            { pid: 4343, label: 'gone', image: 'floe.exe' },
            { pid: 4444, label: 'recycled', image: 'floe.exe' },
        ],
        desktop: { backup: null },
        stack: { started: false },
        fixtureDirs: [path.join(runDir, 'fixtures')],
        appDataRedirect: null,
    };
    writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
    const killed = [];
    const i = io(fakeWorld(), {
        tryAdapter: async () => null,
        processImage: (pid) =>
            pid === 4242 ? 'floe.exe' : pid === 4444 ? 'notepad.exe' : null,
        kill: (pid) => killed.push(pid),
    });
    const code = await main(['cleanup', '--root', root, '--out', outDir], i);
    assert.equal(code, 1, i.lines.concat(i.errors).join('\n'));
    assert.deepEqual(killed, [4242]);
    assert.ok(i.errors.some((l) => /pid 4444 is now notepad\.exe/.test(l)));
    assert.ok(!existsSync(path.join(runDir, 'fixtures')));
    assert.ok(
        !existsSync(binDir),
        'side-loaded binaries removed without --keep'
    );
    const after = JSON.parse(
        readFileSync(path.join(runDir, 'manifest.json'), 'utf8')
    );
    assert.equal(after.cleanupRefused, 1);
    const none = io(fakeWorld());
    assert.equal(
        await main(['cleanup', '--root', root, '--out', out('empty')], none),
        1
    );
    assert.equal(
        await main(
            ['cleanup', '--last', '--root', root, '--out', out('empty')],
            none
        ),
        1
    );
});

test('cleanup keeps an operator --bin-dir the run recorded as not its own', async () => {
    const outDir = out('cleanup-keep');
    const runDir = path.join(outDir, '20260102-000000-head-quick');
    mkdirSync(runDir, { recursive: true });
    const binDir = path.join(base, 'stable-bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'floe-desktop.exe'), 'staged by hand');
    writeFileSync(
        path.join(runDir, 'manifest.json'),
        JSON.stringify({
            runId: '20260102-000000-head-quick',
            binDir,
            binDirOwned: false,
            pids: [],
            desktop: { backup: null },
            stack: { started: false },
            fixtureDirs: [],
            appDataRedirect: null,
        })
    );
    const i = io(fakeWorld(), { tryAdapter: async () => null });
    assert.equal(
        await main(['cleanup', '--last', '--root', root, '--out', outDir], i),
        0,
        i.lines.concat(i.errors).join('\n')
    );
    assert.ok(existsSync(path.join(binDir, 'floe-desktop.exe')));
    assert.ok(i.lines.some((l) => /kept .*\(operator --bin-dir\)/.test(l)));
});

test('probe subcommand on fake adapters: one line per desktop probe, the aggregate, P7 n/a, and probe.json', async () => {
    const json = (body) =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    const fetchImpl = async (url) => {
        const u = String(url);
        if (u.endsWith('/health'))
            return json({ status: 'healthy', uptime: 5 });
        if (u.endsWith('/api/turn-credentials'))
            return json({
                iceServers: [
                    { urls: ['stun:x:3478'] },
                    {
                        urls: [
                            'turn:x:3478?transport=udp',
                            'turns:x:443?transport=tcp',
                        ],
                        username: 'u',
                        credential: 'secret-credential',
                    },
                ],
            });
        return new Response('nope', { status: 404 });
    };
    const i = io(fakeWorld(), { fetchImpl });
    const outDir = out('probe');
    const code = await main(
        [
            'probe',
            '--profile',
            'head',
            '--desktop',
            'store',
            '--root',
            root,
            '--out',
            outDir,
        ],
        i
    );
    assert.equal(code, 0, i.lines.concat(i.errors).join('\n'));
    const text = i.lines.join('\n');
    assert.equal(i.lines[0], 'profile: head');
    assert.match(
        text,
        /^probe P4 TURN prod: 2 entries, schemes stun,turn,turns$/m
    );
    assert.match(
        text,
        /^probe P4 TURN local: 2 entries, schemes stun,turn,turns$/m
    );
    assert.match(
        text,
        /^probe P3 browser relay: skipped \(P3 is a production browser transfer/m
    );
    assert.match(
        text,
        /^probe P1 desktop: drivable \(afterTabFlip=zzz-zzz-zzz, status=connecting\)$/m
    );
    assert.match(text, /^probe P2 desktop: skipped \(no portable exe staged/m);
    assert.match(
        text,
        /^probe desktop aggregate \(store\): available true, receiverDrivable true, saveDirSettable true, senderDrivable true, present true, focusNeeded false, save dir "D:\\down" restored$/m
    );
    assert.match(text, /^probe P7 MOTW: (n\/a \(store build|not windows)/m);
    assert.match(text, /^probe WSL: absent/m);
    assert.match(text, /^probe P5 Protocol: .* -> PARITY$/m);
    const probe = JSON.parse(
        readFileSync(path.join(outDir, 'probe.json'), 'utf8')
    );
    assert.equal(probe.desktop.probes.P1.verdict, 'drivable');
    assert.equal(probe.desktop.mode, 'store');
    assert.equal(probe.desktop.receiverDrivable, true);
    assert.equal(probe.turn.prod.servesTurn, true);
    assert.equal(probe.turn.local.servesTurn, true);
    assert.ok(
        !JSON.stringify(probe).includes('secret-credential'),
        'TURN bodies never reach probe.json'
    );
});

test('parseWslList', () => {
    assert.deepEqual(
        parseWslList(
            '  NAME            STATE           VERSION\n* Ubuntu-22.04    Running         2\n'
        ),
        { present: true, running: true, state: 'Running' }
    );
    assert.equal(
        parseWslList('  NAME  STATE\n  docker-desktop  Stopped  2').present,
        false
    );
    assert.equal(
        parseWslList(
            'U\0b\0u\0n\0t\0u\0-\0 2\0 2\0.\0 0\0 4\0 \0S\0t\0o\0p\0p\0e\0d\0'
        ).present,
        false
    );
});

test('--cells that matches no executable cell is a usage error before anything is created', async () => {
    const i = io(fakeWorld());
    const outDir = out('nocells');
    assert.equal(
        await main(
            ['run', '--root', root, '--out', outDir, '--cells', 'S-DIR-X2X'],
            { ...i, cellHook: shrink }
        ),
        2
    );
    assert.ok(!existsSync(outDir), 'nothing was created under --out');
    assert.ok(!i.lines.some((l) => l.startsWith('PROGRESS ')));
    assert.ok(
        i.errors.some((l) =>
            /--cells S-DIR-X2X matches no executable shipped\/default cell id/.test(
                l
            )
        ),
        i.errors.join('\n')
    );
    // An NA-only match and a deep-only id without --deep are no better.
    for (const c of ['S-DIR-D2D', 'S-DIR-C2C-fold'])
        assert.equal(
            await main(
                [
                    'run',
                    '--root',
                    root,
                    '--out',
                    out(`nocells-${c}`),
                    '--cells',
                    c,
                ],
                io(fakeWorld())
            ),
            2,
            c
        );
});

test('relayBytes counts what actually moved: a REL FAIL that landed bytes counts', async () => {
    const world = fakeWorld();
    world.setScript('S-REL-W2C', 'hash-mismatch');
    const i = io(world);
    const code = await main(
        [
            'run',
            '--quick',
            '--root',
            root,
            '--out',
            out('relay'),
            '--cells',
            'S-REL-W2C',
            '--json',
        ],
        { ...i, cellHook: shrink }
    );
    assert.equal(code, 1);
    const json = JSON.parse(i.lines.find((l) => l.startsWith('{')));
    const rel = json.cells.find((c) => c.id === 'S-REL-W2C');
    assert.equal(rel.verdict, 'FAIL');
    assert.equal(rel.attempts[0].bytesMoved, 2048);
    assert.equal(json.run.relayBytes, 2048);
});

test('parseWslList and probeWsl decode the listing from bytes, UTF-16LE or UTF-8', () => {
    const text =
        '  NAME              STATE           VERSION\r\n* Ubuntu-22.04      Running         2\r\n';
    const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(text, 'utf16le'),
    ]);
    assert.equal(parseWslList(utf16).present, true);
    assert.equal(
        parseWslList(Buffer.from(text, 'utf8')).present,
        true,
        'WSL_UTF8=1 output'
    );
    const seen = [];
    const r = probeWsl((cmd, args, opts) => {
        seen.push({ cmd, args, opts });
        return utf16.toString('latin1');
    });
    if (process.platform !== 'win32') {
        assert.equal(r.state, 'not windows');
        return;
    }
    assert.deepEqual(r, { present: true, running: true, state: 'Running' });
    assert.deepEqual(seen[0].args, ['-l', '-v']);
    assert.equal(seen[0].opts.encoding, 'latin1');
    assert.equal(seen[0].opts.raw, true, 'untrimmed bytes');
    assert.equal(
        probeWsl(() => Buffer.from(text, 'utf8').toString('latin1')).present,
        true,
        'a UTF-8 listing decodes too'
    );
});

test('prepareWslBuild hands the leg the side-loaded Linux path, pinned to the repo', async () => {
    const cells = [
        {
            id: 'S-DIR-L2C',
            sender: { surface: 'wsl' },
            receiver: { surface: 'cli' },
        },
        {
            id: 'S-DIR-W2W',
            sender: { surface: 'web' },
            receiver: { surface: 'web' },
        },
    ];
    const builds = {
        cli: { tag: 'v1.10.5', version: '1.10.5', sha256: 'abc' },
    };
    const seen = [];
    const wslMod = {
        sideload: async (o) => {
            seen.push(o);
            return {
                asset: 'floe_1.10.5_linux_amd64.tar.gz',
                dir: o.dir,
                downloaded: true,
                checksumLine: 'floe_1.10.5_linux_amd64.tar.gz: OK',
                floeVersion: '1.10.5',
                linuxBin: '/var/tmp/floe-lta/v1.10.5/floe',
            };
        },
    };
    const lines = [];
    const out = await prepareWslBuild({
        cells,
        builds,
        binDir: 'C:\\bin',
        getAdapter: async () => wslMod,
        log: (l) => lines.push(l),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tag, 'v1.10.5');
    assert.equal(
        seen[0].repo,
        'jannskiee/floe',
        'pinned, so the repo cannot come from the working directory'
    );
    assert.equal(out.wslBin, '/var/tmp/floe-lta/v1.10.5/floe');
    assert.equal(builds.wsl.path, '/var/tmp/floe-lta/v1.10.5/floe');
    assert.ok(!/\.exe$/i.test(builds.wsl.path), 'never a Windows exe');
    assert.equal(cells[0].verdict, undefined, 'the cell still runs');
    assert.match(lines.join(' '), /verified inside WSL/);

    // A failed side-load skips only the WSL cells, and never falls back.
    const cells2 = [
        {
            id: 'S-DIR-L2C',
            sender: { surface: 'wsl' },
            receiver: { surface: 'cli' },
        },
        {
            id: 'S-DIR-L2W',
            sender: { surface: 'wsl' },
            receiver: { surface: 'web' },
        },
        {
            id: 'S-DIR-W2W',
            sender: { surface: 'web' },
            receiver: { surface: 'web' },
        },
    ];
    const builds2 = { cli: { tag: 'v1.10.5' } };
    const lines2 = [];
    const failed = await prepareWslBuild({
        cells: cells2,
        builds: builds2,
        binDir: 'C:\\bin',
        getAdapter: async () => ({
            sideload: async () => {
                throw new Error('sha256sum said: (no line)');
            },
        }),
        log: (l) => lines2.push(l),
    });
    assert.equal(failed, null);
    assert.equal(builds2.wsl, null, 'no Windows-exe fallback');
    assert.deepEqual(
        cells2.map((c) => c.verdict ?? null),
        ['SKIP', 'SKIP', null]
    );
    assert.equal(cells2[0].reason, 'wsl-sideload');
    assert.match(lines2.join(' '), /side-load failed, 2 cell\(s\)/);

    // No WSL cell in the plan: nothing runs at all.
    const untouched = { cli: { tag: 'v1.10.5' } };
    assert.equal(
        await prepareWslBuild({
            cells: [{ id: 'S-DIR-W2W', sender: { surface: 'web' } }],
            builds: untouched,
            binDir: 'C:\\bin',
            getAdapter: async () => {
                throw new Error('must not be called');
            },
        }),
        null
    );
    assert.equal(untouched.wsl, undefined);
});

test('purgeRunData removes the transferred bytes and keeps the audit', () => {
    const runDir = path.join(base, 'purge-run');
    const mk = (rel, bytes) => {
        const full = path.join(runDir, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, Buffer.alloc(bytes, 7));
        return full;
    };
    const report = mk('audit.md', 100);
    const runJson = mk('run.json', 100);
    const log = mk('log.txt', 100);
    const transcript = mk(
        path.join('cells', 'S-DIR-C2C', 'attempt-1', 'sender.transcript.txt'),
        50
    );
    const attempt = mk(
        path.join('cells', 'S-DIR-C2C', 'attempt-1', 'attempt.json'),
        50
    );
    const capture = mk(
        path.join('cells', 'S-DIR-C2D', 'attempt-1', 'receiver', 'shot.png'),
        50
    );
    mk('fixtures/fixture-12582912.bin', 4096);
    mk(path.join('cells', 'S-DIR-C2C', 'attempt-1', 'out', 'a.bin'), 8192);
    mk(path.join('cells', 'S-DIR-C2D', 'attempt-1', 'out', 'b.bin'), 2048);

    const lines = [];
    const res = purgeRunData(runDir, { log: (l) => lines.push(l) });
    assert.equal(res.purged, true);
    assert.equal(res.freedBytes, 4096 + 8192 + 2048);
    assert.ok(res.dirs >= 3, JSON.stringify(res));
    // The payloads are gone.
    assert.equal(existsSync(path.join(runDir, 'fixtures')), false);
    assert.equal(
        existsSync(path.join(runDir, 'cells', 'S-DIR-C2C', 'attempt-1', 'out')),
        false
    );
    assert.equal(
        existsSync(path.join(runDir, 'cells', 'S-DIR-C2D', 'attempt-1', 'out')),
        false
    );
    // The audit itself is untouched.
    for (const keep of [report, runJson, log, transcript, attempt, capture])
        assert.equal(existsSync(keep), true, keep);
    assert.match(lines.join(' '), /purged .* of transferred data/);

    // --keep-data measures and keeps.
    const runDir2 = path.join(base, 'purge-keep');
    const f2 = path.join(runDir2, 'fixtures', 'x.bin');
    mkdirSync(path.dirname(f2), { recursive: true });
    writeFileSync(f2, Buffer.alloc(1234, 1));
    const lines2 = [];
    const kept = purgeRunData(runDir2, {
        keepData: true,
        log: (l) => lines2.push(l),
    });
    assert.deepEqual(
        { purged: kept.purged, freed: kept.freedBytes, held: kept.heldBytes },
        { purged: false, freed: 0, held: 1234 }
    );
    assert.equal(existsSync(f2), true);
    assert.match(lines2.join(' '), /data kept/);

    // A run directory with nothing to purge is not an error.
    const empty = purgeRunData(path.join(base, 'no-such-run'), {});
    assert.deepEqual(
        { p: empty.purged, f: empty.freedBytes },
        { p: true, f: 0 }
    );
});
