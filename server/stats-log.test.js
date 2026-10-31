'use strict';

const { it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// stats.js reads these values when it is first required. No real Upstash
// requests are made: every fetch call is replaced with an in-process fake.
process.env.UPSTASH_REDIS_REST_URL = 'http://upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const { initStats, statsReportHandler, statsRateLimits } = require('./stats');

const originalError = console.error;
const originalFetch = globalThis.fetch;
let lines = [];

function answer(response) {
    globalThis.fetch = async () => {
        if (response instanceof Error) throw response;
        return response;
    };
}

function status(code) {
    return {
        ok: code >= 200 && code < 300,
        status: code,
        json: async () => ({ result: 1 }),
    };
}

async function report() {
    statsRateLimits.clear();
    statsReportHandler(
        { ip: '198.51.100.9', body: { bytes: 1 } },
        { json() {} },
    );
    await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
    // A successful request closes any failure streak left by a previous test.
    answer(status(200));
    await report();
    lines = [];
    console.error = (...args) => lines.push(args.join(' '));
});

afterEach(() => {
    console.error = originalError;
    globalThis.fetch = originalFetch;
});

it('writes one safe line per failure streak', async () => {
    answer(status(401));
    await initStats();
    await report(); // Another failure in the same streak must stay silent.

    answer(status(200));
    await report(); // Success allows the next failure to be logged.

    answer(Object.assign(new TypeError('fetch failed with secret details'), {
        cause: { code: 'ENOTFOUND' },
    }));
    await report();

    answer(status(200));
    await report();

    answer(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await initStats();

    assert.deepEqual(lines, [
        'Upstash counter read failed (status 401)',
        'Upstash counter update failed (ENOTFOUND)',
        'Upstash counter read failed (TimeoutError)',
    ]);
    assert.doesNotMatch(
        lines.join('\n'),
        /upstash\.invalid|test-token|fetch failed|secret details|operation was aborted/i,
    );
});

it('does not log a successful null result', async () => {
    answer({ ok: true, status: 200, json: async () => ({ result: null }) });
    await initStats();
    assert.deepEqual(lines, []);
});

it('ends a failure streak when a successful response contains null', async () => {
    answer(status(503));
    await initStats();

    answer({ ok: true, status: 200, json: async () => ({ result: null }) });
    await initStats();

    answer(status(503));
    await initStats();

    assert.deepEqual(lines, [
        'Upstash counter read failed (status 503)',
        'Upstash counter read failed (status 503)',
    ]);
});
