'use strict';

// The startup seed against reports that arrive before it. stats.js reads the
// Upstash pair at require time, so this file configures a pair that names no
// real host and answers every call from an in-process fake: nothing here may
// reach the network, and a call the fake does not expect fails the test.

const { describe, it } = require('node:test');
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

const { initStats, statsHandler, statsReportHandler, statsRateLimits } = require('./stats');

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
    it('carries a 10 s timeout, as the Cloudflare mint in turn.js does', async () => {
        // Node's global fetch has no timeout of its own, so without a signal a
        // hung Upstash holds every report's INCRBY open. A plain controller's
        // signal stands in for the timer, so nothing here waits on one.
        const realFetch = globalThis.fetch;
        const realTimeout = AbortSignal.timeout;
        let requestedMs = null;
        let sawSignal = null;
        AbortSignal.timeout = (ms) => {
            requestedMs = ms;
            return new AbortController().signal;
        };
        globalThis.fetch = async (_url, init) => {
            sawSignal = Boolean(init && init.signal);
            return { ok: true, json: async () => ({ result: 0 }) };
        };
        try {
            statsRateLimits.clear();
            statsReportHandler({ ip: '5.6.7.8', body: { bytes: 1 } }, fakeRes());
            await settle();
        } finally {
            globalThis.fetch = realFetch;
            AbortSignal.timeout = realTimeout;
        }
        assert.equal(sawSignal, true, 'the INCRBY call carried no abort signal');
        assert.equal(requestedMs, 10_000);
    });
});
