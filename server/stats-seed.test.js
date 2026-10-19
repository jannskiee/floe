'use strict';

// The startup seed against reports that arrive before it, each Upstash call's
// timeout, and the one INCRBY in flight at a time. stats.js reads the
// Upstash pair at require time, so this file configures a pair that names no
// real host and answers every call from an in-process fake: nothing here may
// reach the network, and a call the fake does not expect fails the test.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.UPSTASH_REDIS_REST_URL = 'http://upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

// The fake counter. GET answers when the test says so, with the value it says,
// so a report can land while the seed is still on its way; INCRBY adds and
// answers the new total at once, as Upstash does.
let stored = 0;
let releaseGet = null;
globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://upstash.invalid');
    const [cmd, , arg] = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, json: async () => ({ result }) });
    if (cmd === 'GET') {
        return new Promise((resolve) => { releaseGet = (value) => resolve(reply(value)); });
    }
    if (cmd === 'INCRBY') {
        stored += arg;
        return reply(stored);
    }
    throw new Error(`stats-seed.test.js: unexpected command ${cmd}`);
};

const { initStats, statsHandler, statsReportHandler, statsRateLimits, MAX_REPORT_BYTES } = require('./stats');

function fakeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function total() {
    const res = fakeRes();
    statsHandler({}, res);
    return res.body.totalBytes;
}

const settle = () => new Promise((r) => setImmediate(r));

describe('initStats', () => {
    it('keeps a report that arrived while the seed was still on its way', async () => {
        stored = 1000;
        statsRateLimits.clear();
        const seeding = initStats();
        await settle();
        // The report lands first: the counter holds 1100 from here on.
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: 100 } }, fakeRes());
        await settle();
        // The GET was read before the INCRBY reached the counter, so it says 1000.
        releaseGet(1000);
        await seeding;
        await settle();
        assert.equal(total(), 1100, 'the seed overwrote a report it had not seen');
    });
});

describe('the Upstash call', () => {
    it('carries a 10 s timeout, as the Cloudflare mint in turn.js does', { timeout: 2000 }, async () => {
        // Node's global fetch gives up only at undici's 300 s defaults, so
        // without a signal a hung Upstash holds the one INCRBY in flight that
        // long. One controller per call stands in for its timer, and the fake
        // settles only when that signal fires, as turn.test.js's does, so the
        // test sees the abort end the call, on the report path and at
        // startup, with nothing left unhandled.
        const realFetch = globalThis.fetch;
        const realTimeout = AbortSignal.timeout;
        const requestedMs = [];
        const timers = [];
        const signals = [];
        AbortSignal.timeout = (ms) => {
            requestedMs.push(ms);
            const controller = new AbortController();
            timers.push(controller);
            return controller.signal;
        };
        globalThis.fetch = (_url, init) =>
            new Promise((_resolve, reject) => {
                // Without a signal a hung upstream would never settle; fail fast
                // instead, so a missing timeout reads as an assertion failure.
                if (!init || !init.signal) return reject(new Error('fetch called without an abort signal'));
                signals.push(init.signal);
                init.signal.addEventListener('abort', () => reject(init.signal.reason));
            });
        const timeUp = (n) => timers[n].abort(new DOMException('timed out', 'TimeoutError'));
        try {
            statsRateLimits.clear();
            statsReportHandler({ ip: '5.6.7.8', body: { bytes: 1 } }, fakeRes());
            assert.equal(signals.length, 1, 'the INCRBY call carried no abort signal');
            assert.equal(signals[0], timers[0].signal, 'the INCRBY call carried a signal other than its timer');
            timeUp(0);
            await settle();
            // The abort ended the call, so the next report gets a call of its own.
            statsReportHandler({ ip: '5.6.7.8', body: { bytes: 1 } }, fakeRes());
            assert.equal(signals.length, 2, 'an aborted INCRBY still held the slot');
            timeUp(1);
            await settle();
            // The startup read carries a timer of its own, and its abort lets
            // initStats resolve.
            const seeding = initStats();
            assert.equal(signals[2], timers[2].signal, 'the startup read carried no timer of its own');
            timeUp(2);
            await seeding;
        } finally {
            globalThis.fetch = realFetch;
            AbortSignal.timeout = realTimeout;
        }
        assert.deepEqual(requestedMs, [10_000, 10_000, 10_000]);
    });
});

// A fake Upstash that answers only when a test says so. Each call is recorded
// with its command and argument; answer(total) settles it as Upstash would,
// fail() as a refusal, and a call made with an abort signal also settles when
// that signal fires, as Node's fetch does.
function heldUpstash() {
    const calls = [];
    const fetch = (url, init) =>
        new Promise((resolve, reject) => {
            assert.equal(url, 'http://upstash.invalid');
            const [cmd, , arg] = JSON.parse(init.body);
            calls.push({
                cmd,
                arg,
                answer: (result) => resolve({ ok: true, json: async () => ({ result }) }),
                fail: () => resolve({ ok: false, json: async () => ({ error: 'refused' }) }),
            });
            if (init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
    const incrby = () => calls.filter((c) => c.cmd === 'INCRBY');
    return { calls, fetch, incrby, args: () => incrby().map((c) => c.arg), cmds: () => calls.map((c) => c.cmd) };
}

describe('one INCRBY at a time', () => {
    const realFetch = globalThis.fetch;
    const realTimeout = AbortSignal.timeout;
    let upstash;
    let timers;

    beforeEach(() => {
        statsRateLimits.clear();
        upstash = heldUpstash();
        globalThis.fetch = upstash.fetch;
        // One controller per call stands in for its 10 s timer, so a test can
        // fire a call's timeout without waiting for it.
        timers = [];
        AbortSignal.timeout = () => {
            const controller = new AbortController();
            timers.push(controller);
            return controller.signal;
        };
    });

    afterEach(async () => {
        // Settle whatever a failing test left open, twice, since an answer can
        // send the bytes that waited, so the next test starts with the slot free.
        for (const call of upstash.calls) call.answer(0);
        await settle();
        for (const call of upstash.calls) call.answer(0);
        await settle();
        globalThis.fetch = realFetch;
        AbortSignal.timeout = realTimeout;
    });

    it('holds one call however many networks report while Upstash is stalled', async () => {
        const before = total();
        let sum = 0;
        // 1000 rate keys, one IPv6 /64 each, so the 60-a-minute limit refuses
        // none of them; no call settles until the test answers it.
        for (let i = 0; i < 1000; i++) {
            const res = fakeRes();
            statsReportHandler({ ip: `2001:db8:0:${i.toString(16)}::1`, body: { bytes: i + 1 } }, res);
            assert.equal(res.statusCode, 200);
            sum += i + 1;
        }
        assert.equal(upstash.incrby().length, 1, `${upstash.incrby().length} INCRBY calls pending at once`);
        // Every report is in the total at once, as with one call per report.
        assert.equal(total(), before + sum);

        // The answer frees the slot, and the 999 reports that waited go in one
        // call; nothing goes out after it with nothing to carry.
        upstash.incrby()[0].answer(1);
        await settle();
        assert.deepEqual(upstash.args(), [1, sum - 1]);
        upstash.incrby()[1].answer(sum);
        await settle();
        assert.equal(upstash.incrby().length, 2);
        assert.equal(total(), before + sum);
    });

    it('a call ended by its timeout frees the slot and drops only its own bytes', async () => {
        const before = total();
        statsReportHandler({ ip: '198.51.100.1', body: { bytes: 5 } }, fakeRes());
        statsReportHandler({ ip: '198.51.100.2', body: { bytes: 7 } }, fakeRes());
        assert.equal(upstash.incrby().length, 1);
        timers[0].abort(new DOMException('timed out', 'TimeoutError'));
        await settle();
        // The 5 are not sent again: Upstash may have applied that call and lost
        // only its answer. The 7 that waited go next.
        assert.deepEqual(upstash.args(), [5, 7]);
        upstash.incrby()[1].answer(0);
        await settle();
        assert.equal(upstash.incrby().length, 2);
        assert.equal(total(), before + 12, 'a failed call took its bytes out of the total');
    });

    it('a refused call is not sent again', async () => {
        statsReportHandler({ ip: '198.51.100.3', body: { bytes: 9 } }, fakeRes());
        upstash.incrby()[0].fail();
        await settle();
        // With nothing waiting, nothing goes out: a read-only token refuses
        // every write, and a retry would send it again at once, forever.
        assert.equal(upstash.incrby().length, 1);
        statsReportHandler({ ip: '198.51.100.3', body: { bytes: 4 } }, fakeRes());
        assert.deepEqual(upstash.args(), [9, 4]);
    });

    it('a seed that lands while bytes wait for the slot ends at the stored total', async () => {
        // A counter well above everything this file has reported, so the seed
        // and each answer can be seen raising the total.
        const stored = 1e12;
        const before = total();
        const seeding = initStats();
        statsReportHandler({ ip: '198.51.100.4', body: { bytes: 100 } }, fakeRes());
        statsReportHandler({ ip: '198.51.100.5', body: { bytes: 50 } }, fakeRes());
        // The seed is a call of its own: it neither holds the slot nor waits
        // for it.
        assert.deepEqual(upstash.cmds(), ['GET', 'INCRBY']);
        assert.equal(total(), before + 150);
        // The GET was read before either report reached the counter.
        upstash.calls[0].answer(stored);
        await seeding;
        assert.equal(total(), stored);
        upstash.incrby()[0].answer(stored + 100);
        await settle();
        assert.equal(total(), stored + 100);
        assert.deepEqual(upstash.args(), [100, 50]);
        upstash.incrby()[1].answer(stored + 150);
        await settle();
        assert.equal(total(), stored + 150);
    });

    it('an answer Number() cannot read neither holds the slot nor goes unhandled', async () => {
        const unhandled = [];
        const onUnhandled = (err) => unhandled.push(err);
        process.on('unhandledRejection', onUnhandled);
        try {
            statsReportHandler({ ip: '198.51.100.6', body: { bytes: 3 } }, fakeRes());
            // Number() throws on this: neither valueOf nor toString is callable.
            upstash.incrby()[0].answer({ valueOf: 1, toString: 1 });
            await settle();
            statsReportHandler({ ip: '198.51.100.6', body: { bytes: 2 } }, fakeRes());
            assert.deepEqual(upstash.args(), [3, 2]);
            await settle();
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        assert.equal(unhandled.length, 0, `unhandled: ${unhandled.map(String).join('; ')}`);
    });

    it('carries the bytes that waited in calls of at most a safe integer', async () => {
        // 2000 reports at the cap, each from a /64 of its own, while the first
        // call is pending: the carry is 1999 times 5 TiB, above 2^53, which as
        // one argument Redis could refuse whole. Last in this file: the total
        // it leaves would sit above any seed a later test used.
        for (let i = 0; i < 2000; i++) {
            const ip = `2001:db8:1:${i.toString(16)}::1`;
            statsReportHandler({ ip, body: { bytes: MAX_REPORT_BYTES } }, fakeRes());
        }
        for (let n = 1; n <= 3; n++) {
            assert.equal(upstash.incrby().length, n);
            upstash.incrby()[n - 1].answer(0);
            await settle();
        }
        assert.equal(upstash.incrby().length, 3, 'a call went out with nothing to carry');
        const args = upstash.args();
        assert.ok(args.every(Number.isSafeInteger), `unsafe argument in ${args.join(', ')}`);
        const rest = 1999 * MAX_REPORT_BYTES - Number.MAX_SAFE_INTEGER;
        assert.deepEqual(args, [MAX_REPORT_BYTES, Number.MAX_SAFE_INTEGER, rest]);
        // Summed as BigInt: past 2^53 a Number sum rounds.
        const sent = args.reduce((sum, arg) => sum + BigInt(arg), 0n);
        assert.equal(sent, 2000n * BigInt(MAX_REPORT_BYTES));
    });
});
