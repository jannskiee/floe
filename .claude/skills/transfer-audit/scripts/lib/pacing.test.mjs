// node --test .claude/skills/<skill>/scripts/lib/pacing.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
    COST,
    Ledger,
    PROD_LIMITS,
    cellCost,
    costOf,
    legKind,
} from './pacing.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'lta-pacing-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function clock(start = 0) {
    let t = start;
    return { now: () => t, set: (v) => (t = v), tick: (ms) => (t += ms) };
}

test('caps are 50 percent of production: 10 TURN, 15 conn, 30 code', () => {
    const l = new Ledger({ now: () => 0 });
    assert.equal(l.allowed('turn'), 10);
    assert.equal(l.allowed('conn'), 15);
    assert.equal(l.allowed('code'), 30);
    assert.deepEqual(PROD_LIMITS, { turn: 20, conn: 30, code: 60, stats: 60 });
});

test('waitMs at the TURN edge waits until the oldest event leaves the window', () => {
    const c = clock();
    const l = new Ledger({ now: c.now, minGapMs: 0 });
    for (let i = 0; i < 10; i++) l.commit({ turn: 1 }, i * 1000);
    c.set(20_000);
    assert.equal(l.waitMs({ turn: 1 }), 60_000 - 20_000);
    assert.equal(l.waitMs({ turn: 2 }), 61_000 - 20_000);
    assert.equal(l.waitMs({ conn: 1 }), 0);
    c.set(60_001);
    assert.equal(l.waitMs({ turn: 1 }), 0);
});

test('conn and code buckets are independent', () => {
    const c = clock(1000);
    const l = new Ledger({ now: c.now, minGapMs: 0 });
    for (let i = 0; i < 15; i++) l.commit({ conn: 1 }, 1000);
    assert.ok(l.waitMs({ conn: 1 }) > 0);
    assert.equal(l.waitMs({ code: 1 }), 0);
    for (let i = 0; i < 30; i++) l.commit({ code: 1 }, 1000);
    assert.ok(l.waitMs({ code: 1 }) > 0);
});

test('8 s floor between leg starts and a one-window penalty', () => {
    const c = clock(100_000);
    const l = new Ledger({ now: c.now });
    l.commit({ turn: 1 });
    assert.equal(l.waitMs({ turn: 1 }), 8_000);
    c.tick(8_000);
    assert.equal(l.waitMs({ turn: 1 }), 0);
    l.penalize();
    assert.equal(l.waitMs({ turn: 1 }), 60_000);
    assert.equal(l.symptoms, 1);
    assert.ok(!l.infraDown());
    l.penalize();
    assert.ok(l.infraDown());
    l.clearSymptoms();
    assert.ok(!l.infraDown());
});

test('relaxed mode never waits', () => {
    const c = clock(0);
    const l = Ledger.relaxed({ now: c.now });
    for (let i = 0; i < 100; i++) l.commit({ turn: 1, conn: 1, code: 1 }, 0);
    assert.equal(l.waitMs({ turn: 5, conn: 5, code: 5 }), 0);
    assert.equal(l.minGapMs, 0);
});

test('spend records adapter kinds and waitFor sleeps the computed wait', async () => {
    const c = clock(0);
    const l = new Ledger({ now: c.now, minGapMs: 0 });
    l.spend('web:sender');
    l.spend('turn');
    assert.deepEqual(l.inWindow(), { turn: 2, conn: 1, code: 0 });
    assert.throws(() => l.spend('bogus'), /unknown ledger cost kind/);
    for (let i = 0; i < 8; i++) l.commit({ turn: 1 }, 0);
    let slept = 0;
    const wait = await l.waitFor(
        { turn: 1 },
        { sleep: async (ms) => (slept = ms) }
    );
    assert.equal(wait, 60_000);
    assert.equal(slept, 60_000);
    assert.deepEqual(l.waitsMs, [60_000]);
});

test('load/toJSON round trip and file persistence', () => {
    const c = clock(5_000);
    const l = new Ledger({ now: c.now });
    l.commit({ turn: 1, conn: 1 });
    l.penalize();
    l.waitsMs.push(123);
    const copy = Ledger.load(JSON.stringify(l), { now: c.now });
    assert.deepEqual(copy.events, l.events);
    assert.equal(copy.penaltyUntil, l.penaltyUntil);
    assert.deepEqual(copy.waitsMs, [123]);
    const file = path.join(dir, 'ledger.json');
    l.save(file);
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).events.length, 1);
    const opened = Ledger.open(file, { now: c.now });
    assert.equal(opened.events.length, 1);
    assert.equal(opened.file, file);
    const fresh = Ledger.open(path.join(dir, 'missing.json'), { now: c.now });
    assert.equal(fresh.events.length, 0);
});

test('load clamps a foreign clock: future events dropped, future stamps clamped, counts validated', () => {
    const now = 1_000_000;
    const l = Ledger.load(
        {
            events: [
                { t: now + 3_600_000, turn: 1, conn: 1 },
                { t: now - 1000, turn: '9', conn: 1, code: -2, kind: 'x' },
                { t: now - 2000, turn: 2 },
                { t: 'x', turn: 1 },
                null,
                7,
            ],
            lastStartAt: now + 3_600_000,
            penaltyUntil: now + 10 * 3_600_000,
            symptoms: -3,
            waitsMs: [5, 'x', -1],
            retriesUsed: 2.7,
        },
        { now: () => now, minGapMs: 0 }
    );
    assert.equal(l.events.length, 2, 'the future event and the junk are gone');
    assert.deepEqual(l.events[0], {
        t: now - 1000,
        turn: 0,
        conn: 1,
        code: 0,
        kind: 'x',
    });
    assert.deepEqual(l.inWindow(), { turn: 2, conn: 1, code: 0 });
    assert.equal(l.lastStartAt, now, 'never later than now');
    assert.equal(l.penaltyUntil, now + 60_000, 'at most one window ahead');
    assert.equal(l.symptoms, 0);
    assert.deepEqual(l.waitsMs, [5]);
    assert.equal(l.retriesUsed, 2);
    assert.ok(
        l.waitMs({ turn: 1 }) <= 60_000,
        'a stalled waitFor is bounded by one window'
    );
    // A clock that jumped forward by an hour would otherwise prune ten
    // TURN fetches the server still counts.
    const forward = Ledger.load(
        {
            events: Array.from({ length: 10 }, (_, i) => ({
                t: now - 30_000 + i,
                turn: 1,
            })),
        },
        { now: () => now, minGapMs: 0 }
    );
    assert.equal(forward.inWindow().turn, 10);
    assert.ok(
        forward.waitMs({ turn: 1 }) > 0,
        'ten TURN fetches 30 s ago still count'
    );
    assert.equal(Ledger.load('null', { now: () => now }).events.length, 0);
});

test('cellCost sums both legs and legKind maps inputs', () => {
    const cell = {
        sender: { surface: 'cli' },
        receiver: { surface: 'web', input: 'link' },
    };
    assert.deepEqual(cellCost(cell), { turn: 2, conn: 2, code: 1 });
    const dd = {
        sender: { surface: 'desktop' },
        receiver: { surface: 'cli', input: 'code' },
    };
    assert.deepEqual(cellCost(dd), { turn: 2, conn: 2, code: 2 });
    assert.equal(legKind('cli', 'receiver', 'code'), 'cli:receiver:code');
    assert.equal(legKind('web', 'sender'), 'web:sender');
    for (const k of Object.keys(COST)) assert.deepEqual(costOf(k), COST[k]);
});

test('peakPer60s and summary', () => {
    const c = clock(0);
    const l = new Ledger({ now: c.now, minGapMs: 0 });
    for (let i = 0; i < 6; i++) l.commit({ turn: 1, conn: 1 }, i * 5_000);
    l.commit({ turn: 1 }, 200_000);
    const peak = l.peakPer60s();
    assert.equal(peak.turn, 6);
    assert.equal(peak.conn, 6);
    const s = l.summary();
    assert.equal(s.softBudgetPct, 50);
    assert.equal(s.retryCap, 3);
    assert.deepEqual(s.caps, PROD_LIMITS);
});

test('peakPer60s is the run peak, not the last window waitMs left behind', () => {
    let t = 0;
    const l = new Ledger({ now: () => t });
    for (let i = 0; i < 10; i++) l.spend('turn', (t = i * 1000));
    assert.equal(l.peakPer60s().turn, 10);
    t = 200_000;
    l.waitMs({ turn: 1 }, t);
    l.spend('turn', t);
    assert.equal(l.inWindow().turn, 1, 'the old events were pruned');
    assert.equal(l.summary().peakPer60s.turn, 10);
    assert.deepEqual(l.summary().peakPer60s, { turn: 10, conn: 0, code: 0 });
    // A loaded ledger starts from what the limiter already holds.
    const loaded = Ledger.load(
        {
            events: Array.from({ length: 4 }, (_, i) => ({
                t: 1000 + i,
                turn: 1,
                conn: 1,
            })),
        },
        { now: () => 2000 }
    );
    assert.deepEqual(loaded.peakPer60s(), { turn: 4, conn: 4, code: 0 });
});
