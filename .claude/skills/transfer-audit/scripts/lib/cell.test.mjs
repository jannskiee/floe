// node --test .claude/skills/<skill>/scripts/lib/cell.test.mjs
// The cell state machine on the in-memory fake adapters (tests/fake-legs.mjs).
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
    ROUTE_UNPROVEN_NOTE,
    bytesReportedCount,
    candidateNotes,
    INFRA_KEYS,
    PENALIZED_KEYS,
    SIGNATURES,
    classifySignature,
    isEarlyRace,
    turnFetchHints,
    partFiles,
    runCell,
} from './cell.mjs';
import { KILL_AT_BYTES } from './fixtures.mjs';
import { cellPlan } from './matrix.mjs';
import { Ledger } from './pacing.mjs';
import { newSafety } from './report.mjs';
import { SafetyError } from './surfaces.mjs';
import { fakeWorld, makeFakeAdapters } from './tests/fake-legs.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'lta-cell-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

// Small fixtures so the fake copies stay quick: the runner reads sizes from
// the cell, so shrink them here.
function small(cell) {
    if (cell.fixture.kind === 'single') {
        cell.fixture.bytes = 4096;
        cell.fixture.totalBytes = 4096;
    }
    if (cell.expect === 'transfer') {
        cell.timeouts.complete = 5000;
        cell.timeouts.firstBytes = 1000;
        cell.timeouts.exit = 1000;
    }
    cell.timeouts.route = 300;
    return cell;
}

const plan = Object.fromEntries(
    cellPlan({ subset: 'deep', cliHasRelayOnly: true }).map((c) => [c.id, c])
);
const pick = (id) => small(structuredClone(plan[id]));

// patch(adapters) may wrap an adapter before the runner sees it (see
// wrapLeg): the probes that found the audit's regressions did exactly that.
function makeCtx(world, extra = {}, patch = null) {
    const adapters = patch
        ? patch(makeFakeAdapters(world))
        : makeFakeAdapters(world);
    const safety = newSafety();
    let n = 0;
    return {
        getAdapter: async (name) => adapters[name],
        ledger: Ledger.relaxed({ now: () => Date.now() }),
        infra: {
            name: 'prod',
            server: 'https://api.invalid',
            web: 'https://web.invalid',
            servesTurn: true,
            relaxed: false,
            statsOracle: 'none',
        },
        buildFor: (surface) => ({
            kind: 'shipped',
            version: '3.4.5',
            path: null,
            launch: surface === 'desktop' ? 'portable' : undefined,
        }),
        evidenceRoot: path.join(dir, `run-${++n}-${Date.now()}`),
        fixturesDir: path.join(
            dir,
            'fixtures',
            String(Date.now() + Math.random())
        ),
        log: () => {},
        safety,
        retry: { used: 0, cap: 3 },
        sleep: async () => {},
        killTree: async (pid) => adapters.proc.killTree(pid),
        statsOracle: null,
        pionTrace: false,
        cliHasRelayOnly: true,
        retryWaitMs: 0,
        drainWaitMs: 0,
        ...extra,
    };
}

/** Wrap one surface's createLeg so fn(leg, opts) can patch each leg. */
function wrapLeg(adapters, surface, fn) {
    const orig = adapters[surface].createLeg;
    adapters[surface] = {
        ...adapters[surface],
        createLeg: (opts) => {
            const leg = orig(opts);
            fn(leg, opts);
            return leg;
        },
    };
    return adapters;
}

const smallKill = (id) => {
    const c = pick(id);
    c.killAtBytes = 4096;
    c.fixture = { kind: 'single', bytes: 1024, totalBytes: 1024 };
    return c;
};

test('classifySignature and the early-race family', () => {
    assert.equal(
        classifySignature(
            'Error: connected, but no data arrived from the sender within 30s'
        ).key,
        'early-race'
    );
    assert.ok(
        isEarlyRace(
            'Error: Connected, but the sender never started sending. Ask them to try again.'
        )
    );
    assert.equal(
        classifySignature('Error: connected, but no data arrived').retryable,
        false
    );
    const ice = classifySignature(
        'Error: failed to fetch ICE credentials: 503'
    );
    assert.equal(ice.key, 'ice-fetch-failed');
    assert.equal(ice.retryable, true);
    assert.equal(ice.triage, 'infra-down');
    assert.equal(
        classifySignature(
            'Error: room is full (someone else may already be receiving)'
        ).key,
        'room-full'
    );
    assert.equal(
        classifySignature('Too many refreshes. Reconnecting').key,
        'rate-limited'
    );
    const ct = classifySignature('Error: timed out establishing a connection');
    assert.equal(ct.key, 'connect-timeout');
    assert.equal(ct.retryable, false);
    assert.equal(
        classifySignature('Error: timed out establishing a connection', {
            relay: true,
            turnHeavy: true,
        }).retryable,
        true
    );
    assert.equal(
        classifySignature('hash-mismatch: fixture-1.bin').retryable,
        false
    );
    assert.equal(
        classifySignature(
            'Error: transfer blocked: relay connections are capped at 2 GB (selected 3 GB)'
        ).key,
        'relay-cap'
    );
    assert.equal(
        classifySignature(
            'Cannot transfer: your floe is too old for this peer.'
        ).key,
        'incompatible'
    );
    assert.equal(classifySignature('something new').key, 'unknown');
});

test('PASS: direct W2C with real files, hashes and stats proof', async () => {
    const world = fakeWorld();
    const ctx = makeCtx(world);
    const r = await runCell(pick('S-DIR-W2C'), ctx);
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.note));
    assert.equal(r.attempts.length, 1);
    assert.equal(r.integrity.ok, true);
    assert.equal(r.integrity.files.length, 1);
    assert.equal(r.route.label, 'direct [W]');
    assert.equal(r.stats.proof.argvNoReport, true);
    assert.equal(r.stats.proof.envNoStats, true);
    assert.equal(ctx.safety.cliReceiversOptedOut.ok, 1);
    assert.equal(r.rcvBuild, 'cli 3.4.5');
    assert.ok(r.attempts[0].phases.verify >= 0);
    assert.ok(
        existsSync(
            path.join(
                ctx.evidenceRoot,
                'cells',
                'S-DIR-W2C',
                'attempt-1',
                'attempt.json'
            )
        )
    );
    const stored = JSON.parse(
        readFileSync(
            path.join(
                ctx.evidenceRoot,
                'cells',
                'S-DIR-W2C',
                'attempt-1',
                'attempt.json'
            ),
            'utf8'
        )
    );
    assert.equal(stored.outcome, 'pass');
    assert.ok(
        world.spends.length >= 2,
        'fake adapters spent through the ledger'
    );
    assert.equal(
        ctx.safety.historyRowsAdded,
        null,
        'no desktop receiver, nothing to count'
    );
});

test('partFiles never throws when a .part vanishes between readdir and stat', () => {
    const d = path.join(dir, 'parts');
    mkdirSync(path.join(d, 'nested'), { recursive: true });
    writeFileSync(path.join(d, 'a.bin.part'), 'aa');
    writeFileSync(path.join(d, 'nested', 'b.bin.part'), 'bbb');
    writeFileSync(path.join(d, 'c.bin'), 'c');
    assert.deepEqual(
        partFiles(d)
            .map((p) => [path.basename(p.path), p.bytes])
            .sort(),
        [
            ['a.bin.part', 2],
            ['b.bin.part', 3],
        ]
    );
    const gone = Object.assign(new Error('ENOENT: renamed'), {
        code: 'ENOENT',
    });
    const racing = {
        existsSync,
        readdirSync,
        statSync: (p) => {
            if (p.endsWith('a.bin.part')) throw gone;
            return statSync(p);
        },
    };
    assert.deepEqual(
        partFiles(d, racing).map((p) => path.basename(p.path)),
        ['b.bin.part']
    );
    assert.deepEqual(partFiles(path.join(dir, 'missing')), []);
    assert.deepEqual(partFiles(null), []);
});

test('PASS: relay W2W and hideIP C2D show the forced side; C2C is direct by construction', async () => {
    const ctx = makeCtx(fakeWorld());
    const rel = await runCell(pick('S-REL-W2W'), ctx);
    assert.equal(rel.verdict, 'PASS', rel.note);
    assert.equal(rel.route.label, 'relay [W local,W]');
    const d = await runCell(pick('S-REL-C2D'), ctx);
    assert.equal(d.verdict, 'PASS', d.note);
    assert.equal(d.route.label, 'relay [D]');
    assert.equal(ctx.safety.desktopReceiversOptedOut.ok, 1);
    const c2c = await runCell(pick('S-DIR-C2C'), ctx);
    assert.equal(c2c.verdict, 'PASS', c2c.note);
    assert.equal(c2c.route.label, 'direct [--no-relay both]');
});

test('FAIL early-race is never retried and names the receiver build', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-C2D', 'early-race');
    const ctx = makeCtx(world);
    const r = await runCell(pick('S-DIR-C2D'), ctx);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'early-race');
    assert.equal(r.triage, 'connect-then-nothing');
    assert.equal(r.attempts.length, 1);
    assert.equal(ctx.retry.used, 0);
    assert.match(r.rcvBuild, /desktop 3\.4\.5/);
});

test('a done timeout still records exit codes and files on disk, and the note says the oracle missed', async () => {
    // 2026-08-28: both desktop cells timed out on a split Text node while
    // the CLI receiver had exited 0 with the file on disk, and attempt.json
    // recorded receiverExit null and no outputs.
    const hang = (id) => {
        const cell = pick(id);
        cell.timeouts.firstBytes = 100;
        cell.timeouts.complete = 200;
        cell.timeouts.exit = 100;
        return cell;
    };
    const world = fakeWorld();
    world.setScript('S-DIR-D2C', 'done-hang');
    world.setScript('S-DIR-C2D', 'done-hang');
    const ctx = makeCtx(world);
    const r = await runCell(hang('S-DIR-D2C'), ctx);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'phase-timeout');
    assert.equal(ctx.retry.used, 0, 'a phase timeout is never retried');
    const a = r.attempts[0];
    assert.equal(a.failedPhase, 'done');
    assert.equal(a.senderExit, null, 'a desktop sender has no exit code');
    assert.equal(a.receiverExit, 0, 'the CLI receiver had exited 0');
    assert.deepEqual(
        [a.doneTimeout.files, a.doneTimeout.parts, a.doneTimeout.completed],
        [1, 0, true]
    );
    assert.equal(
        r.note,
        'done: phase timeout: done exceeded 400 ms; done timed out; sender exit -, receiver exit 0, 1 file on disk (transfer completed, oracle missed)'
    );
    assert.ok(a.notes.includes(a.doneTimeout.summary));
    const outputs = JSON.parse(
        readFileSync(path.join(a.evidence.dir, 'outputs.json'), 'utf8')
    );
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].part, false);
    // A desktop receiver has no exit code either: the file alone decides.
    const d = await runCell(hang('S-DIR-C2D'), makeCtx(world));
    assert.equal(d.attempts[0].senderExit, 0);
    assert.equal(d.attempts[0].receiverExit, null);
    assert.match(
        d.note,
        /sender exit 0, receiver exit -, 1 file on disk \(transfer completed, oracle missed\)$/
    );
});

test('FLAKY: a retryable signature then a pass, with the run cap honored', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-C2W', 'retry-then-pass');
    const ctx = makeCtx(world);
    const r = await runCell(pick('S-DIR-C2W'), ctx);
    assert.equal(r.verdict, 'FLAKY');
    assert.equal(r.reason, 'ice-fetch-failed');
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0].outcome, 'fail');
    assert.equal(r.attempts[1].outcome, 'pass');
    assert.equal(ctx.retry.used, 1);
    assert.equal(r.infraSymptom, true);
    // Fresh room per attempt.
    assert.notEqual(r.attempts[0].room.link, r.attempts[1].room.link);
    const capped = makeCtx(world, { retry: { used: 3, cap: 3 } });
    world.setScript('S-DIR-W2C', 'retry-then-pass');
    const r2 = await runCell(pick('S-DIR-W2C'), capped);
    assert.equal(r2.verdict, 'FAIL');
    assert.match(r2.note, /retry cap reached/);
});

test('FAIL route-mismatch on a DIR cell and forcer-ineffective on a REL cell', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-W2W', 'route-mismatch');
    world.setScript('S-REL-W2C', 'route-mismatch');
    const ctx = makeCtx(world);
    const dir1 = await runCell(pick('S-DIR-W2W'), ctx);
    assert.equal(dir1.verdict, 'FAIL');
    assert.equal(dir1.reason, 'route-mismatch');
    assert.equal(dir1.attempts.length, 1);
    const rel = await runCell(pick('S-REL-W2C'), ctx);
    assert.equal(rel.verdict, 'FAIL');
    assert.equal(rel.reason, 'forcer-ineffective');
});

test('FAIL hash-mismatch and missing-file are never retried', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-C2C', 'hash-mismatch');
    world.setScript('S-DIR-C2C-fold', 'missing-file');
    const ctx = makeCtx(world);
    const r = await runCell(pick('S-DIR-C2C'), ctx);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'hash-mismatch');
    assert.equal(r.integrity.ok, false);
    assert.equal(r.attempts.length, 1);
    const m = await runCell(pick('S-DIR-C2C-fold'), ctx);
    assert.equal(m.verdict, 'FAIL');
    assert.equal(m.reason, 'missing-file');
});

test('refusal cell PASSes on the cap refusal and FAILs when bytes move', async () => {
    const world = fakeWorld();
    const ctx = makeCtx(world);
    const cell = pick('S-REL-C2W-cap3g');
    cell.fixture = { kind: 'single', bytes: 1024, totalBytes: 1024 };
    const r = await runCell(cell, ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(r.route.label, 'relay [refusal]');
    world.setScript('S-REL-C2W-cap3g', 'cap-not-enforced');
    const bad = await runCell(cell, makeCtx(world));
    assert.equal(bad.verdict, 'FAIL');
    assert.equal(bad.reason, 'cap-not-enforced');
});

test('kill cells: killsnd leaves no .part, killrcv leaves one and the retry lands (1)', async () => {
    const world = fakeWorld();
    const ctx = makeCtx(world);
    const snd = pick('S-DIR-C2C-killsnd');
    snd.killAtBytes = 4096;
    snd.fixture = { kind: 'single', bytes: 1024, totalBytes: 1024 };
    const r = await runCell(snd, ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(world.killRequests.length, 1);
    assert.ok(ctx.safety.killedPids.includes(world.killRequests[0]));
    assert.equal(r.attempts[0].kill.victim, 'sender');
    const rcv = pick('S-DIR-C2C-killrcv');
    rcv.killAtBytes = 4096;
    rcv.fixture = { kind: 'single', bytes: 1024, totalBytes: 1024 };
    const k = await runCell(rcv, ctx);
    assert.equal(k.verdict, 'PASS', k.note);
    assert.equal(k.attempts.length, 2);
    assert.equal(k.attempts[1].designed, true);
    assert.equal(k.attempts[0].outDir, k.attempts[1].outDir);
    assert.ok(k.integrity.files[0].where.includes('(1)'));
    assert.equal(KILL_AT_BYTES, 50 * 1024 * 1024);
});

test('undrivable desktop receiver becomes SKIP uia-setvalue, a harness crash becomes ERROR', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-C2D', 'undrivable');
    world.setScript('S-DIR-W2W', 'harness-crash');
    const ctx = makeCtx(world);
    const s = await runCell(pick('S-DIR-C2D'), ctx);
    assert.equal(s.verdict, 'SKIP');
    assert.equal(s.reason, 'uia-setvalue');
    const e = await runCell(pick('S-DIR-W2W'), ctx);
    assert.equal(e.verdict, 'ERROR');
    assert.equal(e.attempts.length, 1);
});

test('init script not applied is ERROR, never FAIL', async () => {
    const world = fakeWorld();
    world.setScript('S-REL-W2C', 'init-script-missing');
    const r = await runCell(pick('S-REL-W2C'), makeCtx(world));
    assert.equal(r.verdict, 'ERROR');
    assert.equal(r.reason, 'init-script-not-applied');
});

test('a bytes-reported event on an opted-out receiver is a SafetyError (exit 4 path)', async () => {
    const world = fakeWorld();
    world.setScript('S-DIR-C2W', 'stats-breach');
    await assert.rejects(
        runCell(pick('S-DIR-C2W'), makeCtx(world)),
        SafetyError
    );
    world.setScript('S-DIR-W2W', 'stats-attempt');
    const r = await runCell(pick('S-DIR-W2W'), makeCtx(world));
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'stats-attempt');
    assert.equal(r.attempts.length, 1);
});

test('a cell without statsOff on the receiver is refused before any leg starts', async () => {
    const cell = pick('S-DIR-W2C');
    cell.receiver.statsOff = false;
    await assert.rejects(runCell(cell, makeCtx(fakeWorld())), /statsOff/);
});

test('NA and SKIP cells return without touching adapters; infra symptoms are flagged', async () => {
    const world = fakeWorld();
    const ctx = makeCtx(world);
    const na = await runCell(pick('S-DIR-D2D'), ctx);
    assert.equal(na.verdict, 'NA');
    assert.equal(na.countsForExit, false);
    assert.equal(world.calls.length, 0);
    world.setScript('S-DIR-C2W', 'infra-down');
    const down = await runCell(
        pick('S-DIR-C2W'),
        makeCtx(world, { retry: { used: 3, cap: 3 } })
    );
    assert.equal(down.verdict, 'FAIL');
    assert.equal(down.reason, 'signaling-unreachable');
    assert.equal(down.infraSymptom, true);
});

test('lib/web.mjs evidence shape (policy.ok, localStorageRead) passes the same checks as the fixture shape', async () => {
    const world = fakeWorld({ webShape: 'b2' });
    const ctx = makeCtx(world, { statsOracle: { read: async () => 0 } });
    const r = await runCell(pick('S-DIR-C2W'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(r.stats.proof.localStorage, 'false');
    assert.equal(r.stats.proof.browserAttempts, 0);
    assert.equal(ctx.safety.localReceives, 1);
    world.setScript('S-REL-W2C', 'init-script-missing');
    const e = await runCell(pick('S-REL-W2C'), ctx);
    assert.equal(e.verdict, 'ERROR');
    assert.equal(e.reason, 'init-script-not-applied');
});

test('desktop receiver: save dir, captures and the config restore feed the Safety section; a restore mismatch at stop is a SafetyError', async () => {
    const world = fakeWorld();
    const ctx = makeCtx(world);
    const ok = await runCell(pick('S-DIR-C2D'), ctx);
    assert.equal(ok.verdict, 'PASS', ok.note);
    assert.equal(ctx.safety.saveDirRestored, true);
    assert.equal(
        ctx.safety.desktopReceiversOptedOut.configRestoredIdentical,
        true
    );
    assert.equal(ctx.safety.captures.count, 1);
    assert.deepEqual(ok.attempts[0].evidence.captures, ['receiver-done.png']);
    assert.match(
        String(ctx.safety.historyRowsAdded),
        /^not counted \(the History view is not read through UIA\)$/,
        'a desktop receiver ran, and the report says the rows were not counted rather than implying zero'
    );
    world.setScript('S-DIR-C2D', 'savedir-skip');
    const s = await runCell(pick('S-DIR-C2D'), ctx);
    assert.equal(s.verdict, 'SKIP');
    assert.equal(s.reason, 'desktop-savedir');
    world.setScript('S-DIR-C2D', 'restore-mismatch');
    await assert.rejects(runCell(pick('S-DIR-C2D'), ctx), SafetyError);
});

test('route phase: two legs without a route oracle wait in parallel, inside one route timeout', async () => {
    const ctx = makeCtx(fakeWorld(), { cliHasRelayOnly: false });
    const c = pick('S-DIR-C2C');
    c.timeouts.route = 1500;
    const r = await runCell(c, ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(r.route.label, 'direct [--no-relay both]');
    const routeMs = r.attempts[0].phases.route;
    assert.ok(
        routeMs < 1500 + 1000,
        `route phase took ${routeMs} ms for two oracle-less legs (sequential waits would take 3000)`
    );
});

test('teardown always runs and the head stats oracle gates on 0/0', async () => {
    const world = fakeWorld();
    const ctx = makeCtx(world, {
        statsOracle: { read: async () => 0 },
        infra: {
            name: 'local',
            server: 'http://localhost:3001',
            web: 'http://localhost:3000',
            statsOracle: 'sentinel',
        },
    });
    const ok = await runCell(pick('S-DIR-C2C'), ctx);
    assert.equal(ok.verdict, 'PASS', ok.note);
    assert.equal(ok.stats.proof.localTotalAfter, 0);
    let reads = 0;
    const bad = makeCtx(world, {
        statsOracle: { read: async () => (reads++ ? 4096 : 0) },
    });
    const r = await runCell(pick('S-DIR-C2W'), bad);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'stats-delta');
    assert.equal(bad.safety.localStatsDeltaZero, false);
    assert.ok(world.calls.length > 0);
});

// ---------------------------------------------------------------------------
// Regressions from the 2026-08-29 adversarial audit
// ---------------------------------------------------------------------------

test('signatures: a 429 inside a byte count or a speed is not a rate limit; the real 429 texts are', () => {
    const stall = classifySignature(
        'done: Error: connection closed mid-transfer: fixture-12582912.bin (429 of 12582912 bytes)'
    );
    assert.equal(stall.key, 'stall');
    assert.equal(stall.retryable, false);
    assert.equal(
        classifySignature(
            'cli receiver: still running after 105000 ms (silent for 31000 ms)\nstdout:   [1/1] fixture.bin  42% (429.3 KB/s) [3s:9s]'
        ).key,
        'unknown'
    );
    for (const t of [
        'Error: server returned 429 when registering code',
        'server returned 429 when resolving code',
        '{"error":"Too many reports"}',
        'HTTP 429',
        'Too many requests',
    ])
        assert.equal(classifySignature(t).key, 'rate-limited', t);
});

test('signatures: the harness connect timeouts classify as connect-timeout', () => {
    const cases = [
        'sender: no line matching /^ {2}Connected(?: \\((direct|relay)\\))?$/ in 45000 ms\nstderr: \nstdout:   Waiting for peer...\n  Connecting...',
        'web receiver: no PC reached connected in 45000 ms (page.waitForFunction: Timeout 45000ms exceeded.)',
        'phase timeout: connect exceeded 45000 ms',
    ];
    for (const t of cases) {
        const s = classifySignature(t, { relay: true, turnHeavy: true });
        assert.equal(s.key, 'connect-timeout', t);
        assert.equal(s.triage, 'connect-timeout');
        assert.equal(s.retryable, true, 'the rel rule still applies');
        assert.equal(classifySignature(t).retryable, false);
    }
    assert.equal(
        classifySignature('phase timeout: done exceeded 400 ms').key,
        'phase-timeout'
    );
});

test('killrcv: the designed retry must end ok on both legs and leave exactly one .part', async () => {
    // The receiver lands "(1)" but exits 1 after the rename.
    const w1 = fakeWorld();
    const c1 = makeCtx(w1, {}, (a) =>
        wrapLeg(a, 'cli', (leg, opts) => {
            if (opts.role !== 'receiver' || opts.attempt !== 2) return;
            const od = leg.awaitDone.bind(leg);
            leg.awaitDone = async (ms) => ({
                ...(await od(ms)),
                ok: false,
                kind: 'error',
                exitCode: 1,
                detail: {
                    error: 'Error: write error: The device is not ready.',
                },
            });
        })
    );
    const r1 = await runCell(smallKill('S-DIR-C2C-killrcv'), c1);
    assert.equal(r1.verdict, 'FAIL');
    assert.equal(r1.attempts.length, 2);
    assert.equal(r1.attempts[1].failedPhase, 'done');
    assert.match(r1.note, /write error/);
    // A second .part after the retry.
    const w2 = fakeWorld();
    const c2 = makeCtx(w2, {}, (a) =>
        wrapLeg(a, 'cli', (leg, opts) => {
            if (opts.role !== 'receiver' || opts.attempt !== 2) return;
            const od = leg.awaitDone.bind(leg);
            leg.awaitDone = async (ms) => {
                const r = await od(ms);
                writeFileSync(
                    path.join(opts.outDir, 'stray.bin.part'),
                    Buffer.alloc(10)
                );
                return r;
            };
        })
    );
    const r2 = await runCell(smallKill('S-DIR-C2C-killrcv'), c2);
    assert.equal(r2.verdict, 'FAIL');
    assert.equal(r2.reason, 'kill-receiver-part');
    assert.match(
        r2.note,
        /expected exactly one \.part after the retry, found 2/
    );
});

test('a passing DIR cell with no route oracle answered says so in the Note column', async () => {
    const noPill = makeCtx(fakeWorld(), {}, (a) =>
        wrapLeg(a, 'desktop', (leg) => {
            leg.route = () => null;
        })
    );
    const r = await runCell(pick('S-DIR-C2D'), noPill);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(r.note, ROUTE_UNPROVEN_NOTE);
    assert.equal(r.route.label, 'unobserved');
    const noStats = makeCtx(fakeWorld(), {}, (a) =>
        wrapLeg(a, 'web', (leg) => {
            leg.route = () => null;
        })
    );
    const r2 = await runCell(pick('S-DIR-W2C'), noStats);
    assert.equal(r2.verdict, 'PASS', r2.note);
    assert.equal(r2.note, ROUTE_UNPROVEN_NOTE);
    // An observed route keeps the Note column empty.
    const ok = await runCell(pick('S-DIR-W2C'), makeCtx(fakeWorld()));
    assert.equal(ok.note, null);
    assert.equal(ok.route.label, 'direct [W]');
});

test('the receiver leg is told how many files to expect', async () => {
    const seen = [];
    const record = (leg, opts) => {
        if (opts.role === 'receiver') seen.push(opts.expectFiles);
    };
    const zip = await runCell(
        pick('S-DIR-C2W-zip'),
        makeCtx(fakeWorld(), {}, (a) => wrapLeg(a, 'web', record))
    );
    assert.equal(zip.verdict, 'PASS', zip.note);
    await runCell(
        pick('S-DIR-C2W'),
        makeCtx(fakeWorld(), {}, (a) => wrapLeg(a, 'web', record))
    );
    await runCell(
        pick('S-DIR-C2C-bnd8'),
        makeCtx(fakeWorld(), {}, (a) => wrapLeg(a, 'cli', record))
    );
    assert.deepEqual(seen, [3, 1, 8]);
});

test('a stale .part after a clean exit is FAIL stale-part, never a harness ERROR', async () => {
    const ctx = makeCtx(fakeWorld(), {}, (a) =>
        wrapLeg(a, 'cli', (leg, opts) => {
            if (opts.role !== 'receiver') return;
            const od = leg.awaitDone.bind(leg);
            leg.awaitDone = async (ms) => {
                const r = await od(ms);
                writeFileSync(
                    path.join(opts.outDir, 'leftover.bin.part'),
                    Buffer.alloc(10)
                );
                return r;
            };
        })
    );
    const r = await runCell(pick('S-DIR-C2C'), ctx);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'stale-part');
    assert.equal(r.triage, 'stale-part');
    assert.equal(r.attempts[0].harness, false);
    assert.equal(r.attempts.length, 1, 'a product defect is never retried');
    assert.match(r.note, /^verify: stale-part: .*leftover\.bin\.part/);
});

test('a sender that registered no code is FAIL code-registration-failed with the CLI warning quoted, retried once', async () => {
    const WARN =
        '  Warning: could not generate short code: server returned 429 when registering code';
    const noCode = (leg, opts) => {
        if (opts.role !== 'sender') return;
        leg.code = async () => null;
        const ev = leg.evidence.bind(leg);
        leg.evidence = () => ({
            ...ev(),
            events: [{ t: 1, name: 'codeWarning', line: WARN }],
        });
    };
    const ctx = makeCtx(fakeWorld(), {}, (a) => wrapLeg(a, 'cli', noCode));
    const r = await runCell(pick('S-DIR-C2C'), ctx);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'code-registration-failed');
    assert.equal(r.triage, 'rate-limit');
    assert.equal(r.attempts[0].harness, false);
    assert.equal(r.attempts.length, 2, 'the code limiter is a retryable cause');
    assert.equal(ctx.retry.used, 1);
    assert.equal(ctx.ledger.symptoms, 1, 'penalized like any other 429');
    assert.match(
        r.note,
        /^receiver\.start: code-registration-failed: sender emits no code \(Warning: could not generate short code: server returned 429/
    );
    // Only the first attempt lacks a code: FLAKY. A link cell never asks.
    const flaky = makeCtx(fakeWorld(), {}, (a) =>
        wrapLeg(a, 'cli', (leg, opts) => {
            if (opts.attempt === 1) noCode(leg, opts);
        })
    );
    const f = await runCell(pick('S-DIR-C2C'), flaky);
    assert.equal(f.verdict, 'FLAKY');
    assert.equal(f.reason, 'code-registration-failed');
    const link = await runCell(
        pick('S-DIR-C2C-link'),
        makeCtx(fakeWorld(), {}, (a) => wrapLeg(a, 'cli', noCode))
    );
    assert.equal(link.verdict, 'PASS', link.note);
});

test('bytesMoved per attempt: the fixture on a completed transfer, what landed on a failed one, the .part on a kill, nothing on a refusal', async () => {
    const ok = await runCell(pick('S-DIR-W2C'), makeCtx(fakeWorld()));
    assert.equal(ok.attempts[0].bytesMoved, 4096);
    const w = fakeWorld();
    w.setScript('S-REL-W2C', 'hash-mismatch');
    const bad = await runCell(pick('S-REL-W2C'), makeCtx(w));
    assert.equal(bad.verdict, 'FAIL');
    assert.equal(
        bad.attempts[0].bytesMoved,
        4096,
        'the receiver took the bytes even though the hash failed'
    );
    w.setScript('S-REL-C2W', 'connect-timeout');
    const none = await runCell(
        pick('S-REL-C2W'),
        makeCtx(w, { retry: { used: 3, cap: 3 } })
    );
    assert.equal(none.verdict, 'FAIL');
    assert.equal(none.attempts[0].bytesMoved, 0);
    const cap = pick('S-REL-C2W-cap3g');
    cap.fixture = { kind: 'single', bytes: 1024, totalBytes: 1024 };
    const refused = await runCell(cap, makeCtx(fakeWorld()));
    assert.equal(refused.verdict, 'PASS', refused.note);
    assert.equal(refused.attempts[0].bytesMoved, 0);
    const k = await runCell(
        smallKill('S-DIR-C2C-killrcv'),
        makeCtx(fakeWorld())
    );
    assert.equal(k.verdict, 'PASS', k.note);
    assert.equal(k.attempts[0].bytesMoved, 4097, 'the .part the kill left');
    assert.equal(
        k.attempts[1].bytesMoved,
        1024,
        'the retry alone, without the stale .part it shares the dir with'
    );
});

test('turn-fetch-rejected: a refused TURN fetch on a relay-forced web leg outranks connect-timeout', () => {
    const legOf = (ev) => ({ evidence: () => ev });
    const legs = {
        sender: legOf({
            surface: 'web',
            relayOnly: true,
            turnFetches: [{ t: 1, status: 429 }],
            candidates: { local: [], remote: ['host', 'srflx'] },
        }),
        receiver: legOf({ surface: 'cli', exit: { code: 1 } }),
    };
    assert.deepEqual(turnFetchHints(legs), [
        'turn-fetch-status 429 on the relay-forced web sender',
    ]);
    assert.deepEqual(candidateNotes(legs), [
        'web sender candidates: local none; remote host,srflx',
    ]);
    const sig = classifySignature(
        [
            'desktop receiver: Error: A connection could not be established.',
            ...turnFetchHints(legs),
        ].join('\n'),
        { relay: true, turnHeavy: false }
    );
    assert.equal(sig.key, 'turn-fetch-rejected');
    assert.equal(sig.retryable, true, 'retried once after the window drains');
    assert.equal(sig.triage, 'turn-fetch-rejected');
    assert.equal(
        sig.text,
        'desktop receiver: Error: A connection could not be established.',
        'the note keeps the first line'
    );
    assert.deepEqual(
        turnFetchHints({
            sender: legOf({
                surface: 'web',
                relayOnly: true,
                turnFetches: [{ t: 1, status: 200 }],
            }),
        }),
        [],
        'a 200 answer is no hint'
    );
    assert.deepEqual(
        turnFetchHints({
            sender: legOf({ surface: 'cli', turnFetches: [{ status: 429 }] }),
        }),
        [],
        'only web legs carry the status oracle'
    );
    assert.equal(
        classifySignature(
            'desktop receiver: Error: A connection could not be established.',
            { relay: true }
        ).key,
        'connect-timeout',
        'without the hint the desktop text stays connect-timeout'
    );
});

test('the TURN hint is raised only for a relay-forced leg, only before connect, on the last non-200 answer', () => {
    const legOf = (ev) => ({ evidence: () => ev });
    const forced = (turnFetches) =>
        legOf({
            surface: 'web',
            relayOnly: true,
            turnFetches,
            candidates: { local: [], remote: [] },
        });
    const plain = (turnFetches) =>
        legOf({
            surface: 'web',
            relayOnly: false,
            turnFetches,
            candidates: { local: ['host'], remote: [] },
        });

    // forcedOnly is what the classifier passes.
    assert.deepEqual(
        turnFetchHints(
            { sender: plain([{ t: 1, status: 429 }]) },
            { forcedOnly: true }
        ),
        []
    );
    assert.deepEqual(
        turnFetchHints({ sender: plain([{ t: 1, status: 429 }]) }),
        ['turn-fetch-status 429 on the web sender']
    );
    assert.deepEqual(
        turnFetchHints(
            { sender: forced([{ t: 1, status: 429 }]) },
            { forcedOnly: true }
        ),
        ['turn-fetch-status 429 on the relay-forced web sender']
    );
    // 304 is Express revalidating a cached body; 200 last wins over an
    // earlier 429 (a stale-bundle reload refetches).
    assert.deepEqual(
        turnFetchHints({
            sender: forced([
                { t: 1, status: 200 },
                { t: 2, status: 304 },
            ]),
        }),
        []
    );
    assert.deepEqual(
        turnFetchHints({
            sender: forced([
                { t: 1, status: 429 },
                { t: 2, status: 200 },
            ]),
        }),
        []
    );
    assert.deepEqual(
        turnFetchHints({
            sender: forced([
                { t: 1, status: 200 },
                { t: 2, status: 503 },
            ]),
        }),
        ['turn-fetch-status 503 on the relay-forced web sender (2 fetches)']
    );
    // A fetch that never answered is recorded as status 0.
    assert.deepEqual(
        turnFetchHints({ sender: forced([{ t: 1, status: 0 }]) }),
        ['turn-fetch-status 0 on the relay-forced web sender']
    );

    // 429 is the limiter and retries; 5xx is infra and never drains a window.
    const lim = classifySignature(
        'x\nturn-fetch-status 429 on the relay-forced web sender'
    );
    assert.equal(lim.key, 'turn-fetch-rejected');
    assert.equal(lim.triage, 'turn-fetch-rejected');
    assert.equal(PENALIZED_KEYS.has('turn-fetch-rejected'), true);
    const inf = classifySignature(
        'x\nturn-fetch-status 503 on the relay-forced web sender'
    );
    assert.equal(inf.key, 'turn-fetch-failed');
    assert.equal(inf.triage, 'infra-down');
    assert.equal(INFRA_KEYS.has('turn-fetch-failed'), true);

    const src = readFileSync(new URL('./cell.mjs', import.meta.url), 'utf8');
    assert.match(
        src,
        /rec\.connectedAt\s*\n?\s*\?\s*\[\]\s*\n?\s*:\s*turnFetchHints\(legs, \{ forcedOnly: true \}\)/,
        'the classifier sees the hint only when connect never completed'
    );
});

test('a keyed PhaseError resolves its whole signature, not just the key', () => {
    // cap-not-enforced has a row: non-retryable, its own triage.
    const cap = classifySignature(
        'cap-not-enforced: 4 MB moved over the relay before the cap'
    );
    assert.equal(cap.key, 'cap-not-enforced');
    assert.equal(cap.retryable, false);
    assert.equal(cap.triage, 'cap-not-enforced');
    // Keys with no row must not inherit a retry from an unrelated match.
    for (const key of ['missing-file', 'kill-sender-outcome', 'stats-delta'])
        assert.equal(
            SIGNATURES.some(([k]) => k === key),
            false,
            key + ' has no row, so the driver falls back to the key itself'
        );
    const src = readFileSync(new URL('./cell.mjs', import.meta.url), 'utf8');
    assert.match(
        src,
        /const row = SIGNATURES\.find\(\(\[k\]\) => k === e\.signatureKey\)/
    );
    assert.match(
        src,
        /triage: row \? row\[3\] : null/,
        'a key with no row invents no triage heading'
    );
});

test('bytesReportedCount counts a LIST, because Number(list) is NaN', () => {
    // The web leg's evidence carries the events themselves; the fixture
    // adapters carry a count. Number([{t,bytes}]) is NaN and NaN > 0 is
    // false, so the browser opt-out gate was dead and the Safety table
    // printed NaN.
    assert.equal(bytesReportedCount([]), 0);
    assert.equal(bytesReportedCount([{ t: 1, bytes: 12 }]), 1);
    assert.equal(bytesReportedCount([{ t: 1 }, { t: 2 }]), 2);
    assert.equal(bytesReportedCount(0), 0);
    assert.equal(bytesReportedCount(3), 3);
    assert.equal(bytesReportedCount(undefined), 0);
    assert.equal(bytesReportedCount(null), 0);
    assert.equal(bytesReportedCount('2'), 2);
    assert.equal(bytesReportedCount({}), 0, 'never NaN');
    assert.ok(Number.isFinite(bytesReportedCount([{ t: 1 }])));
    const src = readFileSync(new URL('./cell.mjs', import.meta.url), 'utf8');
    assert.match(
        src,
        /const events = bytesReportedCount\(/,
        'statsProofCheck goes through the counter'
    );
});
