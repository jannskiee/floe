/**
 * Tests for cli.mjs: the pure builders and parsers on captured output, and
 * the CliLeg state machine driven by tests/fake-floe.mjs.
 *
 * The parser fixtures under tests/fixtures/ were captured from the shipped
 * floe 1.10.5 sending and receiving through a local floe-run stack, with
 * the room id, the code and the output path replaced by fixed synthetic
 * values (the shapes are what matter). Two more cases run the real binary
 * when `floe` is on PATH: `--help`/`--version` through preflight, and a
 * `floe send` against an unreachable server, which prints the STUN
 * warning and exits 1 before any code box (main.go: signaling.Connect runs
 * before code.Register), so it proves the warning marker, the exit
 * classification and the wrapper's exited-before-line path.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/cli.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { PhaseError } from './surfaces.mjs';
import { killAllStarted } from './proc.mjs';
import {
    CliLeg,
    MARKERS,
    REFUSAL_PREFIX,
    buildArgs,
    buildEnv,
    createLeg,
    envSubset,
    parseCode,
    parseHelpFlags,
    parseLink,
    parsePionPair,
    parseSummary,
    parseVersion,
    preflight,
    receiverTarget,
    resolveBin,
} from './cli.mjs';

const FAKE = fileURLToPath(new URL('./tests/fake-floe.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./tests/fixtures/', import.meta.url));
const SEND_FIXTURE = join(FIXTURES, 'send-1.10.5.stdout.txt');
const RECEIVE_FIXTURE = join(FIXTURES, 'receive-1.10.5.stdout.txt');
const HELP_FIXTURE = join(FIXTURES, 'send-help-1.10.5.txt');
/**
 * Fixture text with line endings normalized. git checks these files out
 * CRLF on Windows (core.autocrlf), and a test that matches against a \n
 * string would silently stop matching on a fresh clone.
 */
const fixture = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const INFRA = { server: 'http://localhost:3001', web: 'http://localhost:3000' };
const made = [];

function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'transfer-audit-cli-'));
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

function fakeOpts(over = {}) {
    const dir = fresh();
    return {
        cellId: 'S-DIR-C2C',
        attempt: 1,
        infra: INFRA,
        build: {
            kind: 'shipped',
            version: '1.10.5-fake',
            path: process.execPath,
        },
        bin: process.execPath,
        binArgs: [FAKE],
        evidenceDir: join(dir, 'evidence'),
        outDir: join(dir, 'out'),
        deadlineAt: Date.now() + 60_000,
        baseEnv: {
            ...process.env,
            FAKE_FLOE_MODE: 'normal',
            FAKE_FLOE_DELAY_MS: '10',
        },
        ...over,
    };
}

function withMode(opts, mode, extra = {}) {
    return {
        ...opts,
        baseEnv: { ...opts.baseEnv, FAKE_FLOE_MODE: mode, ...extra },
    };
}

// ---------------------------------------------------------------------------
// buildArgs / buildEnv
// ---------------------------------------------------------------------------

test('buildArgs: sender and receiver shapes', () => {
    assert.deepEqual(
        buildArgs({
            role: 'sender',
            infra: INFRA,
            files: ['C:\\f\\a.bin', 'C:\\f\\b.bin'],
        }),
        [
            'send',
            'C:\\f\\a.bin',
            'C:\\f\\b.bin',
            '--server',
            INFRA.server,
            '--web',
            INFRA.web,
        ]
    );
    assert.deepEqual(
        buildArgs({
            role: 'receiver',
            infra: INFRA,
            target: 'olive-tiger-castle',
            outDir: 'C:\\out',
        }),
        [
            'receive',
            'olive-tiger-castle',
            '--server',
            INFRA.server,
            '--output',
            'C:\\out',
            '--yes',
            '--no-report',
        ]
    );
});

test('buildArgs: a receiver never omits --no-report or --yes', () => {
    for (const noRelay of [false, true])
        for (const relayOnly of [false, true])
            for (const cliHasRelayOnly of [false, true])
                for (const input of ['code', 'link']) {
                    const args = buildArgs({
                        role: 'receiver',
                        infra: INFRA,
                        input,
                        code: 'a-b-c',
                        link: 'http://localhost:3000/#room=x',
                        outDir: 'D:\\out',
                        noRelay,
                        relayOnly,
                        cliHasRelayOnly,
                    });
                    assert.ok(args.includes('--no-report'));
                    assert.ok(args.includes('--yes'));
                    assert.equal(
                        args[1],
                        input === 'code'
                            ? 'a-b-c'
                            : 'http://localhost:3000/#room=x'
                    );
                    assert.equal(args.includes('--no-relay'), noRelay);
                    assert.equal(
                        args.includes('--relay-only'),
                        relayOnly && cliHasRelayOnly
                    );
                }
});

test('buildArgs: --no-relay only on request, --relay-only only when the CLI lists it', () => {
    const base = { role: 'sender', infra: INFRA, files: ['a'] };
    assert.ok(!buildArgs(base).includes('--no-relay'));
    assert.ok(buildArgs({ ...base, noRelay: true }).includes('--no-relay'));
    assert.ok(
        !buildArgs({ ...base, relayOnly: true }).includes('--relay-only')
    );
    assert.ok(
        !buildArgs({
            ...base,
            relayOnly: true,
            cliHasRelayOnly: false,
        }).includes('--relay-only')
    );
    assert.ok(
        buildArgs({ ...base, relayOnly: true, cliHasRelayOnly: true }).includes(
            '--relay-only'
        )
    );
    assert.deepEqual(
        buildArgs({ ...base, iface: ['Ethernet', 'Wi-Fi'] }).slice(-4),
        ['--iface', 'Ethernet', '--iface', 'Wi-Fi']
    );
});

test('buildArgs: refuses a missing server, files, target or outDir', () => {
    assert.throws(
        () => buildArgs({ role: 'sender', files: ['a'] }),
        /infra.server/
    );
    assert.throws(
        () => buildArgs({ role: 'sender', infra: INFRA, files: [] }),
        /files/
    );
    assert.throws(
        () => buildArgs({ role: 'receiver', infra: INFRA, outDir: 'x' }),
        /code or link/
    );
    assert.throws(
        () => buildArgs({ role: 'receiver', infra: INFRA, target: 'a-b-c' }),
        /outDir/
    );
    assert.throws(
        () => buildArgs({ role: 'judge', infra: INFRA }),
        /unknown role/
    );
    assert.equal(receiverTarget({ input: 'link', link: 'L', code: 'C' }), 'L');
    assert.equal(receiverTarget({ input: 'code', link: 'L', code: 'C' }), 'C');
    assert.equal(receiverTarget({ target: 'T', link: 'L' }), 'T');
});

test('buildEnv strips and sets as specified', () => {
    const base = {
        PATH: 'x',
        PION_LOG_TRACE: 'all',
        pion_log_debug: 'ice',
        FLOE_SERVER: 'http://evil',
        FLOE_WEB: 'http://evil',
        FLOE_NO_STATS: '1',
        FLOE_NO_UPDATE_CHECK: '0',
        HOME: 'h',
    };
    const sender = buildEnv({ role: 'sender' }, base);
    assert.deepEqual(sender, {
        PATH: 'x',
        HOME: 'h',
        FLOE_NO_UPDATE_CHECK: '1',
    });
    const receiver = buildEnv({ role: 'receiver' }, base);
    assert.equal(receiver.FLOE_NO_STATS, '1');
    assert.equal(receiver.FLOE_NO_UPDATE_CHECK, '1');
    assert.ok(!('PION_LOG_TRACE' in receiver));
    const traced = buildEnv({ role: 'sender', pionTrace: true }, base);
    assert.equal(traced.PION_LOG_TRACE, 'ice');
    assert.ok(!('FLOE_NO_STATS' in traced));
    assert.deepEqual(envSubset(receiver), {
        FLOE_NO_STATS: '1',
        FLOE_NO_UPDATE_CHECK: '1',
        PION_LOG_TRACE: null,
    });
});

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

test('parseVersion and parseHelpFlags', () => {
    assert.equal(parseVersion('floe 1.10.5\n'), '1.10.5');
    assert.equal(parseVersion('floe dev\n'), 'dev');
    assert.equal(parseVersion('floe head-abc1234\r\n'), 'head-abc1234');
    assert.equal(parseVersion('nope'), null);
    const help = fixture(HELP_FIXTURE);
    const flags = parseHelpFlags(help);
    for (const f of ['--help', '--iface', '--no-relay', '--server', '--web'])
        assert.ok(flags.includes(f), f);
    assert.ok(!flags.includes('--relay-only'));
    const withRelayOnly = help.replace(
        '  -h, --help   help for send\n',
        '  -h, --help         help for send\n      --relay-only   force the TURN relay path\n'
    );
    assert.ok(parseHelpFlags(withRelayOnly).includes('--relay-only'));
});

test('parseCode, parseLink and parseSummary on the shipped 1.10.5 sender transcript', () => {
    const out = fixture(SEND_FIXTURE);
    assert.match(parseCode(out), /^[a-z]+(-[a-z]+){2,3}$/);
    assert.equal(
        parseLink(out),
        'http://localhost:3000/#room=11111111-2222-4333-8444-555555555555'
    );
    const s = parseSummary(out);
    assert.equal(s.complete, true);
    assert.equal(s.files, 1);
    assert.match(s.sent, /^1 file \(12(.0)? MB\)$/);
    assert.match(s.time, /^\d+s( · avg [\d.]+ [KM]B\/s)?$/);
    assert.equal(s.received, null);
    assert.equal(s.savedTo, null);
    assert.ok(MARKERS.waiting.test('  Waiting for peer...'));
    for (const key of ['sending', 'waiting', 'connecting', 'connected']) {
        assert.ok(
            out.split(/\r\n|\r|\n/).some((l) => MARKERS[key].test(l)),
            key
        );
    }
});

test('parseSummary on the shipped 1.10.5 receiver transcript', () => {
    const out = fixture(RECEIVE_FIXTURE);
    const s = parseSummary(out);
    assert.equal(s.complete, true);
    assert.equal(s.files, 1);
    assert.match(s.received, /^1 file \(12(.0)? MB\)$/);
    assert.equal(s.savedTo, 'C:\\Users\\alice\\Downloads\\floe');
    assert.equal(s.sent, null);
    assert.equal(parseCode(out), null);
    // The bar redraws with a bare \r (the wrapper splits the same way).
    const lines = out.split(/\r\n|\r|\n/);
    for (const key of ['connectingToSender', 'connected', 'incoming'])
        assert.ok(
            lines.some((l) => MARKERS[key].test(l)),
            key
        );
    assert.ok(lines.some((l) => MARKERS.progress.test(l)));
});

test('parsers on synthetic shapes', () => {
    const box =
        '  ─────\n  Code   olive-tiger-castle-moon\n  Link   https://floe.one/#room=abc\n  ─────\n';
    assert.equal(parseCode(box), 'olive-tiger-castle-moon');
    assert.equal(parseLink(box), 'https://floe.one/#room=abc');
    assert.equal(
        parseCode(
            '  Warning: could not generate short code: x\n  Link   https://floe.one/#room=abc\n'
        ),
        null
    );
    assert.equal(parseCode('  Code   not a code\n'), null);
    assert.equal(parseLink('no link here'), null);
    const s = parseSummary(
        '\n  Sent   3 files (1.5 MB)\n  Time   1m 2s · avg 2.0 MB/s\n'
    );
    assert.deepEqual(
        {
            files: s.files,
            size: s.size,
            duration: s.duration,
            avg: s.avg,
            complete: s.complete,
        },
        {
            files: 3,
            size: '1.5 MB',
            duration: '1m 2s',
            avg: '2.0 MB/s',
            complete: true,
        }
    );
    const r = parseSummary(
        '  Received   2 files (10 Bytes)\n  Time       0s\n  Saved to   D:\\out\n'
    );
    assert.equal(r.complete, true);
    assert.equal(r.avg, null);
    assert.equal(r.savedTo, 'D:\\out');
    assert.equal(
        parseSummary('  Received   2 files (10 Bytes)\n').complete,
        false
    );
    assert.ok(MARKERS.connected.test('  Connected (relay)'));
    assert.ok(MARKERS.connected.test('  Connected (direct)'));
    assert.ok(!MARKERS.connected.test('  Connected (maybe)'));
    assert.ok(MARKERS.connected.test('  Connected'));
    assert.ok(!MARKERS.connected.test('  Connecting...'));
    assert.ok(
        REFUSAL_PREFIX.startsWith(
            'Error: transfer blocked: relay connections are capped at 2 GB (selected '
        )
    );
});

test('parsePionPair reads the local and remote candidate types', () => {
    const line = (local, remote) =>
        `ice TRACE: 12:00:00.000000 agent.go:780: Set selected candidate pair: prio 9 (local, prio 9) udp4 ${local} 203.0.113.9:40000 related 0.0.0.0:0 (resolved: <nil>) <-> udp4 ${remote} 198.51.100.7:50000 related 0.0.0.0:0 (resolved: <nil>) (remote, prio 9), state: succeeded, nominated: true, nominateOnBindingSuccess: false`;
    assert.equal(parsePionPair(''), null);
    assert.equal(parsePionPair('ice TRACE: something else\n'), null);
    const relayLocal = parsePionPair(`${line('relay', 'srflx')}\n`);
    assert.deepEqual(
        {
            local: relayLocal.local,
            remote: relayLocal.remote,
            verdict: relayLocal.verdict,
            count: relayLocal.count,
        },
        { local: 'relay', remote: 'srflx', verdict: 'relay', count: 1 }
    );
    assert.equal(parsePionPair(`${line('host', 'relay')}\n`).verdict, 'relay');
    assert.equal(parsePionPair(`${line('host', 'host')}\n`).verdict, 'direct');
    assert.equal(
        parsePionPair(`${line('prflx', 'srflx')}\n`).verdict,
        'direct'
    );
    // The last line wins: a renomination from host to relay.
    const two = parsePionPair(
        `${line('host', 'host')}\n${line('relay', 'srflx')}\n`
    );
    assert.equal(two.verdict, 'relay');
    assert.equal(two.count, 2);
});

// ---------------------------------------------------------------------------
// CliLeg on the fake binary
// ---------------------------------------------------------------------------

test('CliLeg sender: start gives link and code, then connects and completes', async () => {
    const opts = fakeOpts({ role: 'sender', files: ['a.bin'] });
    const leg = createLeg(opts);
    assert.ok(leg instanceof CliLeg);
    assert.equal(leg.surface, 'cli');
    await leg.start();
    assert.equal(await leg.code(), 'amber-otter-cloud');
    assert.equal(
        await leg.link(),
        'http://localhost:3000/#room=11111111-2222-4333-8444-555555555555'
    );
    assert.equal(leg.route(), null);
    const hit = await leg.awaitConnected(5000);
    assert.equal(hit.line, '  Connected');
    assert.equal(leg.route(), null, 'no oracle without a suffix or a trace');
    const done = await leg.awaitDone(10_000);
    assert.equal(done.ok, true);
    assert.equal(done.kind, 'transfer');
    assert.equal(done.exitCode, 0);
    assert.equal(done.detail.files, 1);
    assert.deepEqual(await leg.outputs(), []);
    const ev = leg.evidence();
    assert.equal(ev.statsProof, null);
    assert.deepEqual(ev.env, {
        FLOE_NO_STATS: null,
        FLOE_NO_UPDATE_CHECK: '1',
        PION_LOG_TRACE: null,
    });
    assert.ok(ev.argv.includes('send'));
    assert.ok(!ev.argv.includes('--no-report'));
    assert.equal(ev.exit.code, 0);
    assert.equal(ev.version, '1.10.5-fake');
    assert.ok(existsSync(ev.transcript));
    assert.ok(ev.markers.waiting < ev.markers.connected);
    assert.ok(typeof ev.markers.progress === 'number');
    await leg.stop('done');
});

test('CliLeg receiver: outputs are hashed and the stats proof is argv plus env', async () => {
    const opts = fakeOpts({
        role: 'receiver',
        input: 'code',
        target: 'amber-otter-cloud',
    });
    const leg = createLeg(opts);
    await leg.start();
    assert.equal(await leg.link(), 'amber-otter-cloud');
    await leg.awaitConnected(5000);
    const done = await leg.awaitDone(10_000);
    assert.equal(done.kind, 'transfer');
    assert.equal(done.detail.savedTo, opts.outDir);
    const outputs = await leg.outputs();
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].name, 'fixture.bin');
    assert.equal(outputs[0].rel, 'fixture.bin');
    assert.equal(outputs[0].bytes, 1024);
    assert.equal(
        outputs[0].sha256,
        createHash('sha256').update(Buffer.alloc(1024, 0x5a)).digest('hex')
    );
    const ev = leg.evidence();
    assert.deepEqual(ev.statsProof, {
        kind: 'argv+env',
        noReport: true,
        floeNoStats: '1',
    });
    assert.ok(ev.argv.includes('--no-report'));
    assert.equal(ev.env.FLOE_NO_STATS, '1');
    await leg.stop('done');
});

test('CliLeg receiver: a leftover .part fails outputs()', async () => {
    const leg = createLeg(
        withMode(fakeOpts({ role: 'receiver', target: 'a-b-c' }), 'part')
    );
    await leg.start();
    await leg.awaitDone(10_000);
    await assert.rejects(leg.outputs(), (err) => {
        assert.ok(err instanceof PhaseError);
        assert.equal(err.phase, 'verify');
        assert.deepEqual(err.parts, ['fixture.bin.part']);
        return true;
    });
});

test('CliLeg: the relay-cap refusal maps to kind refusal on both sides', async () => {
    const sender = createLeg(
        withMode(fakeOpts({ role: 'sender', files: ['a.bin'] }), 'refusal')
    );
    await sender.start();
    await sender.awaitConnected(5000);
    const s = await sender.awaitDone(10_000);
    assert.deepEqual(
        {
            ok: s.ok,
            kind: s.kind,
            exitCode: s.exitCode,
            cls: s.detail.class,
            side: s.detail.side,
        },
        {
            ok: true,
            kind: 'refusal',
            exitCode: 1,
            cls: 'relay-cap-refusal',
            side: 'self',
        }
    );
    assert.ok(s.detail.error.startsWith(REFUSAL_PREFIX));
    const receiver = createLeg(
        withMode(fakeOpts({ role: 'receiver', target: 'a-b-c' }), 'refusal')
    );
    await receiver.start();
    const r = await receiver.awaitDone(10_000);
    assert.deepEqual(
        { ok: r.ok, kind: r.kind, cls: r.detail.class, side: r.detail.side },
        { ok: true, kind: 'refusal', cls: 'peer-refused', side: 'peer' }
    );
});

test('CliLeg: the early-message race surfaces as an error with its class', async () => {
    const leg = createLeg(
        withMode(fakeOpts({ role: 'receiver', target: 'a-b-c' }), 'race')
    );
    await leg.start();
    await leg.awaitConnected(5000);
    const done = await leg.awaitDone(10_000);
    assert.equal(done.ok, false);
    assert.equal(done.kind, 'error');
    assert.equal(done.exitCode, 1);
    assert.equal(done.detail.class, 'stall-before-metadata');
    assert.match(done.detail.error, /^Error: connected, but no data arrived/);
});

test('CliLeg: awaitRoute answers at once without a pion trace, and keeps a Connected suffix', async () => {
    const base = {
        role: 'receiver',
        target: 'alpha-bravo-charlie',
        outDir: 'C:\\out',
        infra: { server: 'http://localhost:3001' },
    };
    const quiet = createLeg(base);
    const t0 = Date.now();
    const r = await quiet.awaitRoute(5000);
    assert.ok(Date.now() - t0 < 1000, 'no trace: no waiting');
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.source, 'none');
    const suffixed = createLeg(base);
    suffixed.connectedSuffix = 'direct';
    suffixed.marks.connected = 42;
    assert.deepEqual(await suffixed.awaitRoute(5000), {
        t: 42,
        source: 'cli-connected',
        local: null,
        remote: null,
        verdict: 'direct',
    });
    const traced = createLeg({ ...base, pionTrace: true });
    const t1 = Date.now();
    const slow = await traced.awaitRoute(600);
    assert.ok(Date.now() - t1 >= 500, 'with a trace the base poll runs');
    assert.equal(slow.verdict, 'unknown');
});

test('CliLeg: route() from the Connected suffix and from the pion trace', async () => {
    const suffixed = createLeg(
        withMode(fakeOpts({ role: 'sender', files: ['a.bin'] }), 'normal', {
            FAKE_FLOE_SUFFIX: 'relay',
        })
    );
    await suffixed.start();
    await suffixed.awaitConnected(5000);
    const r1 = suffixed.route();
    assert.equal(r1.source, 'cli-connected');
    assert.equal(r1.verdict, 'relay');
    await suffixed.awaitDone(10_000);

    const traced = createLeg(
        withMode(
            fakeOpts({ role: 'receiver', target: 'a-b-c', pionTrace: true }),
            'normal',
            {
                FAKE_FLOE_PAIR: 'relay',
            }
        )
    );
    assert.equal(traced.env.PION_LOG_TRACE, 'ice');
    await traced.start();
    await traced.awaitConnected(5000);
    const r2 = await traced.awaitRoute(5000);
    assert.equal(r2.source, 'pion-trace');
    assert.equal(r2.verdict, 'relay');
    assert.equal(r2.local, 'relay');
    await traced.awaitDone(10_000);
    assert.equal(traced.evidence().pion.verdict, 'relay');
});

test('CliLeg: awaitDone times out on a stall and stop() kills only our pid', async () => {
    const leg = createLeg(
        withMode(fakeOpts({ role: 'sender', files: ['a.bin'] }), 'stall')
    );
    await leg.start();
    await leg.awaitConnected(5000);
    await assert.rejects(leg.awaitDone(300), (err) => {
        assert.ok(err instanceof PhaseError);
        assert.equal(err.phase, 'done');
        assert.match(err.message, /still running/);
        return true;
    });
    await leg.stop('timeout');
    assert.ok(leg.h.exit, 'process gone after stop');
    assert.ok(
        leg.notes.some((n) => /killTree pid \d+: \{"killed":true/.test(n))
    );
    assert.equal(leg.evidence().exit.code === 0, false);
});

test('CliLeg: start rephases a spawn failure as a start error', async () => {
    const leg = createLeg(
        fakeOpts({
            role: 'sender',
            files: ['a.bin'],
            bin: 'transfer-audit-no-such-binary',
            binArgs: [],
        })
    );
    await assert.rejects(leg.start(), (err) => {
        assert.equal(err.phase, 'start');
        assert.equal(err.innerPhase, 'exited');
        return true;
    });
});

test('preflight on the fake binary parses version and flags', async () => {
    const pre = await preflight({ bin: process.execPath, binArgs: [FAKE] });
    assert.equal(pre.ok, true, pre.reason);
    assert.equal(pre.detail.version, '1.10.5-fake');
    assert.equal(pre.detail.cliHasRelayOnly, false);
    assert.ok(pre.detail.receiveFlags.includes('--no-report'));
    const withFlag = await preflight({
        bin: process.execPath,
        binArgs: [FAKE],
        baseEnv: { ...process.env, FAKE_FLOE_RELAY_ONLY: '1' },
    });
    assert.equal(withFlag.detail.cliHasRelayOnly, true);
    const missing = await preflight({ bin: join(fresh(), 'nope.exe') });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /not found/);
});

// ---------------------------------------------------------------------------
// the shipped binary, when it is on PATH
// ---------------------------------------------------------------------------

// Opt-in, like the live web test: the ladder must not spawn whichever floe
// happens to be first on PATH. LTA_LIVE=1 turns these two on.
const REAL =
    process.env.LTA_LIVE === '1'
        ? await resolveBin(process.env.FLOE_BIN || 'floe')
        : null;

test(
    'real floe: preflight reads --version and both --help pages',
    { skip: !REAL && 'set LTA_LIVE=1 (and FLOE_BIN) for the real binary' },
    async () => {
        const pre = await preflight({ bin: REAL });
        assert.equal(pre.ok, true, pre.reason);
        assert.match(pre.detail.version, /^\d+\.\d+\.\d+/);
        assert.equal(typeof pre.detail.cliHasRelayOnly, 'boolean');
        for (const f of [
            '--no-report',
            '--yes',
            '--output',
            '--no-relay',
            '--server',
            '--web',
        ])
            assert.ok(pre.detail.receiveFlags.includes(f), f);
    }
);

test(
    'real floe send against an unreachable server: STUN warning, exit 1, classified',
    { skip: !REAL && 'set LTA_LIVE=1 (and FLOE_BIN) for the real binary' },
    async () => {
        const dir = fresh();
        const file = join(dir, 'tiny.bin');
        writeFileSync(file, Buffer.alloc(16, 1));
        const leg = createLeg({
            role: 'sender',
            cellId: 'REAL-UNREACHABLE',
            attempt: 1,
            bin: REAL,
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
            files: [file],
            evidenceDir: join(dir, 'evidence'),
            startTimeoutMs: 20_000,
        });
        await assert.rejects(leg.start(), (err) => {
            assert.equal(err.phase, 'start');
            assert.equal(err.innerPhase, 'exited');
            return true;
        });
        const h = leg.h;
        assert.equal(h.exit.code, 1);
        assert.ok(
            h.lines.some((l) => MARKERS.turnWarning.test(l.line)),
            'STUN warning printed'
        );
        const done = await leg.awaitDone(1000);
        assert.equal(done.ok, false);
        assert.equal(done.detail.class, 'signaling-connect-failed');
        assert.match(
            done.detail.error,
            /^Error: failed to connect to signaling server/
        );
        assert.equal(leg.evidence().env.FLOE_NO_UPDATE_CHECK, '1');
    }
);
