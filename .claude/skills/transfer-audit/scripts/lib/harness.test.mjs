/**
 * Tests for harness.mjs: the pure parts of the CLI-shaped sender that can lie
 * about a digest, plus the leg driven over a stand-in process handle. The real
 * process against a real peer is exercised by the audit's own forced-mismatch
 * cells, not here.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/harness.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileURLToPath } from 'node:url';

import { getAdapter, isSurfaceAdapter } from './adapters.mjs';
import {
    HarnessLeg,
    ROUTE_GRACE_MS,
    durationSeconds,
    lastEvent,
    lieFlag,
    outcomeFromEvents,
    preflight,
    routeFromEvents,
} from './harness.mjs';

test('lieFlag: only the two lying modes produce a flag', () => {
    assert.equal(lieFlag('corrupt'), '-corrupt-hash');
    assert.equal(lieFlag('malformed'), '-malformed-hash');
    assert.equal(lieFlag(null), null);
    assert.equal(lieFlag(undefined), null);
    assert.equal(lieFlag('anything-else'), null);
});

test('lastEvent reads the last matching event and ignores everything else', () => {
    const stdout = [
        '{"event":"joined","role":"sender","roomId":"r1"}',
        '{"event":"link","link":"http://localhost:3000/#room=r1"}',
        'not json at all',
        '{"event":"channel-open"}',
        '{"event":"peer-refused","code":"hash-mismatch"}',
        '{"event":"peer-refu',
    ].join('\n');
    assert.equal(lastEvent(stdout, 'link').link, 'http://localhost:3000/#room=r1');
    assert.equal(lastEvent(stdout, 'peer-refused').code, 'hash-mismatch');
    assert.equal(lastEvent(stdout, 'done'), null);
    // A half-written line while the process is still going must not throw.
    assert.equal(lastEvent('{"event":"link"', 'link'), null);
    // The newest one wins.
    const twice = '{"event":"peer-refused","code":"other"}\n{"event":"peer-refused","code":"hash-mismatch"}';
    assert.equal(lastEvent(twice, 'peer-refused').code, 'hash-mismatch');
});

test('argv: the mode, the two URLs, the lie and the files, in that order', () => {
    const leg = new HarnessLeg({
        role: 'sender',
        bin: 'floe-e2ehost.exe',
        server: 'http://localhost:3001',
        web: 'http://localhost:3000',
        room: '8b1d4d38-6a6a-4a7e-9b1d-2b5d6f0a1c2d',
        hashLie: 'corrupt',
        files: ['C:/tmp/a.bin'],
    });
    assert.deepEqual(leg.argv(), [
        'send',
        '-server',
        'http://localhost:3001',
        '-web',
        'http://localhost:3000',
        '-room',
        '8b1d4d38-6a6a-4a7e-9b1d-2b5d6f0a1c2d',
        '-corrupt-hash',
        'C:/tmp/a.bin',
    ]);

    // Without a lie the same leg sends the truth, and a missing room is left to
    // the harness to generate.
    const honest = new HarnessLeg({
        role: 'sender',
        bin: 'floe-e2ehost.exe',
        server: 'http://localhost:3001',
        web: 'http://localhost:3000',
        hashLie: null,
        files: ['C:/tmp/a.bin', 'C:/tmp/b.bin'],
    });
    assert.deepEqual(honest.argv(), [
        'send',
        '-server',
        'http://localhost:3001',
        '-web',
        'http://localhost:3000',
        'C:/tmp/a.bin',
        'C:/tmp/b.bin',
    ]);
    assert.ok(!honest.argv().some((a) => a.includes('hash')), 'no lying flag');
});

test('argv takes the URLs from infra, where the runner puts them, and needs a server', () => {
    const leg = new HarnessLeg({
        role: 'sender',
        bin: 'x',
        infra: { server: 'http://127.0.0.1:3001', web: 'http://127.0.0.1:3000' },
        server: 'http://stale:1',
        hashLie: 'malformed',
        files: ['f'],
    });
    assert.deepEqual(leg.argv(), [
        'send',
        '-server',
        'http://127.0.0.1:3001',
        '-web',
        'http://127.0.0.1:3000',
        '-malformed-hash',
        'f',
    ]);
    const none = new HarnessLeg({ role: 'sender', bin: 'x', files: ['f'] });
    assert.throws(() => none.argv(), /infra\.server is required/);
});

test('argv hands the harness the attempt clock, never send.go fixed defaults', () => {
    const leg = new HarnessLeg({
        role: 'sender',
        bin: 'x',
        infra: { server: 'http://127.0.0.1:3001' },
        hashLie: 'corrupt',
        deadlineAt: 1_000_000 + 184_200,
        now: 1_000_000,
        refusalWaitMs: 15_000,
        files: ['f'],
    });
    assert.deepEqual(leg.argv(), [
        'send',
        '-server',
        'http://127.0.0.1:3001',
        '-corrupt-hash',
        '-timeout',
        '185s',
        '-refusal-wait',
        '15s',
        'f',
    ]);
    // A deadline already behind us still leaves the harness room to report.
    assert.equal(durationSeconds(-5000, 30), 30);
    assert.equal(durationSeconds(1, 5), 5);
    assert.equal(durationSeconds(Number.NaN, 30), 30);
    assert.equal(durationSeconds(61_001, 30), 62, 'rounded up');
});

test('env inherits the scrubbed environment and always opts out', () => {
    const leg = new HarnessLeg({
        role: 'sender',
        bin: 'x',
        files: ['f'],
        baseEnv: {
            PATH: 'C:/Windows',
            SystemRoot: 'C:/Windows',
            FLOE_SERVER: 'https://api.floe.one',
            FLOE_NO_STATS: '0',
            PION_LOG_TRACE: 'all',
        },
    });
    const env = leg.env();
    assert.equal(env.PATH, 'C:/Windows', 'the process still finds its system DLLs');
    assert.equal(env.SystemRoot, 'C:/Windows');
    assert.equal(env.FLOE_SERVER, undefined, 'a stray server cannot retarget it');
    assert.equal(env.PION_LOG_TRACE, undefined, 'stdout stays events only');
    assert.equal(env.FLOE_NO_STATS, '1');
    assert.equal(env.FLOE_NO_UPDATE_CHECK, '1');
});

test('routeFromEvents: only the two verdict words make a route sample', () => {
    const direct = routeFromEvents('{"event":"channel-open"}\n{"event":"route","path":"direct"}', 42);
    assert.deepEqual(direct, {
        t: 42,
        source: 'harness-connection-type',
        local: null,
        remote: null,
        verdict: 'direct',
    });
    assert.equal(routeFromEvents('{"event":"route","path":"relay"}').verdict, 'relay');
    assert.equal(routeFromEvents('{"event":"channel-open"}'), null, 'no event, no guess');
    assert.equal(routeFromEvents('{"event":"route","path":"host 192.0.2.1:50000"}'), null);
    assert.equal(routeFromEvents('{"event":"route"}'), null);
});

/** A stand-in for proc.mjs's handle: stdout, an exit, and the clock start. */
function fakeHandle(stdout, { exit = null } = {}) {
    return { stdout, exit, t0: 0, pid: null, stalledFor: () => 0 };
}

test('route() and awaitRoute read the harness route event', async () => {
    const leg = new HarnessLeg({ role: 'sender', bin: 'x', files: ['f'] });
    assert.equal(leg.route(), null, 'nothing before the process starts');
    leg.h = fakeHandle('{"event":"channel-open"}\n{"event":"route","path":"direct"}');
    leg.marks.connected = 7;
    assert.equal(leg.route().verdict, 'direct');
    assert.equal(leg.route().t, 7);
    const r = await leg.awaitRoute(30_000);
    assert.equal(r.verdict, 'direct');
    assert.equal(r.source, 'harness-connection-type');
});

test('awaitRoute answers unknown without running out the cell route timeout', async () => {
    // Exited without a route event: answered at once.
    const gone = new HarnessLeg({ role: 'sender', bin: 'x', files: ['f'] });
    gone.h = fakeHandle('{"event":"channel-open"}', { exit: { code: 1 } });
    const t0 = Date.now();
    const r1 = await gone.awaitRoute(30_000);
    assert.equal(r1.verdict, 'unknown');
    assert.ok(Date.now() - t0 < 1000, 'no wait for a process that already exited');

    // Still running, no route event: capped by the shorter of the two clocks.
    const quiet = new HarnessLeg({ role: 'sender', bin: 'x', files: ['f'] });
    quiet.h = fakeHandle('{"event":"channel-open"}');
    const t1 = Date.now();
    const r2 = await quiet.awaitRoute(300);
    assert.equal(r2.verdict, 'unknown');
    assert.ok(Date.now() - t1 < 2000);
    assert.ok(ROUTE_GRACE_MS <= 5_000, 'the grace stays well under a route timeout');
});

test('outcomeFromEvents: a refusal frame, no refusal, and the harness own errors', () => {
    const refused = outcomeFromEvents('{"event":"peer-refused","code":"hash-mismatch"}');
    assert.equal(refused.kind, 'refusal');
    assert.deepEqual(refused.detail, { class: 'peer-refused', code: 'hash-mismatch' });
    assert.equal(outcomeFromEvents('{"event":"peer-refused","code":"other"}').kind, 'refusal');

    // A truthful run: the receiver kept the file and no refusal came.
    for (const code of ['none', 'closed']) {
        const kept = outcomeFromEvents(`{"event":"peer-refused","code":"${code}"}`);
        assert.equal(kept.kind, 'transfer', code);
        assert.equal(kept.detail.class, 'no-refusal');
        assert.equal(kept.detail.code, code);
    }
    assert.equal(outcomeFromEvents('{"event":"done"}').kind, 'transfer');
    const failed = outcomeFromEvents('{"event":"error","stage":"setup"}');
    assert.equal(failed.ok, false);
    assert.equal(failed.detail.stage, 'setup');
    assert.equal(outcomeFromEvents('').detail.stage, 'unknown');
});

test('budget follows the attempt deadline and never drops below a second', () => {
    const free = new HarnessLeg({ role: 'sender', bin: 'x', files: ['f'] });
    assert.equal(free.budget(5000), 5000);
    const late = new HarnessLeg({
        role: 'sender',
        bin: 'x',
        files: ['f'],
        deadlineAt: Date.now() - 10,
    });
    assert.equal(late.budget(5000), 1000);
});

test('a harness leg is a sender with no code and no outputs', async () => {
    const leg = new HarnessLeg({ role: 'sender', bin: 'x', files: ['f'] });
    assert.equal(leg.surface, 'harness');
    assert.deepEqual(await leg.outputs(), [], 'a sender writes nothing');
    assert.equal(await leg.code(), null, 'the harness never registers a code');
    assert.equal(leg.evidence().statsProof, null, 'a sender carries no stats proof');
});

test('preflight answers like a surface adapter: a missing binary is a precondition', async () => {
    const none = await preflight({});
    assert.equal(none.ok, false);
    assert.match(none.reason, /internal.e2ehost/, 'it names the thing to build');

    const missing = await preflight({ harnessBin: 'C:/nowhere/floe-e2ehost.exe' });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /missing at/);

    // This file itself stands in for a binary that is present.
    const here = fileURLToPath(import.meta.url);
    const found = await preflight({ harnessBin: here });
    assert.equal(found.ok, true);
    assert.equal(found.reason, null);
    assert.equal(found.detail.bin, here);
});

test('the registry can hand out the harness adapter', async () => {
    const mod = await getAdapter('harness');
    assert.equal(typeof mod.createLeg, 'function');
    assert.equal(typeof mod.preflight, 'function');
    assert.ok(isSurfaceAdapter(mod), 'it satisfies the surface-adapter shape');
});
