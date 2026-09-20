'use strict';

// Unit tests for the stats module — handler logic, rate limiting, and Upstash
// degradation. Uses Node's built-in test runner (node:test).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
    statsRateLimits,
    STATS_MAX_REPORTS,
    MAX_REPORT_BYTES,
    initStats,
    statsHandler,
    statsReportHandler,
} = require('./stats');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function getTotal() {
    const res = fakeRes();
    statsHandler({}, res);
    return res.body.totalBytes;
}

// ---------------------------------------------------------------------------
// statsHandler — GET /api/stats
// ---------------------------------------------------------------------------

describe('statsHandler', () => {
    it('returns totalBytes as a number', () => {
        const res = fakeRes();
        statsHandler({}, res);
        assert.equal(typeof res.body.totalBytes, 'number');
    });
});

// ---------------------------------------------------------------------------
// statsReportHandler — POST /api/stats/report
// ---------------------------------------------------------------------------

describe('statsReportHandler', () => {
    beforeEach(() => { statsRateLimits.clear(); });

    it('increments the total and echoes it back', () => {
        const before = getTotal();
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: 500 } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.totalBytes, before + 500);
    });

    it('accumulates across multiple reports', () => {
        const before = getTotal();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: 100 } }, fakeRes());
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: 200 } }, fakeRes());
        assert.equal(getTotal(), before + 300);
    });

    // --- Validation ---------------------------------------------------------

    it('returns 400 for zero bytes', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: 0 } }, res);
        assert.equal(res.statusCode, 400);
    });

    it('returns 400 for negative bytes', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: -1 } }, res);
        assert.equal(res.statusCode, 400);
    });

    it('returns 400 for a float', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: 1.5 } }, res);
        assert.equal(res.statusCode, 400);
    });

    it('returns 400 for bytes exceeding the cap', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: MAX_REPORT_BYTES + 1 } }, res);
        assert.equal(res.statusCode, 400);
    });

    it('accepts exactly the maximum byte count', () => {
        const before = getTotal();
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: MAX_REPORT_BYTES } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.totalBytes, before + MAX_REPORT_BYTES);
    });

    it('returns 400 for a string', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: '1000' } }, res);
        assert.equal(res.statusCode, 400);
    });

    it('returns 400 when bytes key is absent', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: {} }, res);
        assert.equal(res.statusCode, 400);
    });

    it('returns 400 when body is undefined', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4' }, res);
        assert.equal(res.statusCode, 400);
    });

    it('returns 400 when body is null', () => {
        const res = fakeRes();
        statsReportHandler({ ip: '1.2.3.4', body: null }, res);
        assert.equal(res.statusCode, 400);
    });

    // --- Rate limiting ------------------------------------------------------

    it('allows up to STATS_MAX_REPORTS then returns 429', () => {
        for (let i = 0; i < STATS_MAX_REPORTS; i++) {
            const res = fakeRes();
            statsReportHandler({ ip: '10.0.0.1', body: { bytes: 1 } }, res);
            assert.equal(res.statusCode, 200, `request ${i + 1} should pass`);
        }
        const res = fakeRes();
        statsReportHandler({ ip: '10.0.0.1', body: { bytes: 1 } }, res);
        assert.equal(res.statusCode, 429);
    });

    it('tracks IPs independently', () => {
        for (let i = 0; i < STATS_MAX_REPORTS; i++) {
            statsReportHandler({ ip: '10.0.0.1', body: { bytes: 1 } }, fakeRes());
        }
        const res = fakeRes();
        statsReportHandler({ ip: '10.0.0.2', body: { bytes: 1 } }, res);
        assert.equal(res.statusCode, 200, 'a different IP must still be allowed');
    });

    it('collapses IPv6 addresses in the same /64', () => {
        for (let i = 0; i < STATS_MAX_REPORTS; i++) {
            const res = fakeRes();
            statsReportHandler(
                { ip: `2001:db8:1:2::${(i + 1).toString(16)}`, body: { bytes: 1 } },
                res,
            );
            assert.equal(res.statusCode, 200, `request ${i + 1}`);
        }
        const res = fakeRes();
        statsReportHandler({ ip: '2001:db8:1:2:ffff::1', body: { bytes: 1 } }, res);
        assert.equal(res.statusCode, 429, 'same /64 shares the budget');
    });

    it('unwraps IPv4-mapped IPv6 for rate limiting', () => {
        for (let i = 0; i < STATS_MAX_REPORTS; i++) {
            statsReportHandler({ ip: '::ffff:10.0.0.99', body: { bytes: 1 } }, fakeRes());
        }
        const res = fakeRes();
        statsReportHandler({ ip: '10.0.0.99', body: { bytes: 1 } }, res);
        assert.equal(res.statusCode, 429, 'mapped and plain IPv4 share one budget');
    });

    it('admits again after the rate window expires', (t) => {
        let now = 0;
        t.mock.method(Date, 'now', () => now);

        for (let i = 0; i < STATS_MAX_REPORTS; i++) {
            statsReportHandler({ ip: '10.0.0.3', body: { bytes: 1 } }, fakeRes());
        }
        const blocked = fakeRes();
        statsReportHandler({ ip: '10.0.0.3', body: { bytes: 1 } }, blocked);
        assert.equal(blocked.statusCode, 429);

        now = 61000;
        const res = fakeRes();
        statsReportHandler({ ip: '10.0.0.3', body: { bytes: 1 } }, res);
        assert.equal(res.statusCode, 200, 'allowed after window expires');
    });

    it('does not increment the total on a rejected report', () => {
        const before = getTotal();
        statsReportHandler({ ip: '1.2.3.4', body: { bytes: -1 } }, fakeRes());
        assert.equal(getTotal(), before);
    });

    it('does not increment the total on a rate-limited report', () => {
        for (let i = 0; i < STATS_MAX_REPORTS; i++) {
            statsReportHandler({ ip: '10.0.0.5', body: { bytes: 1 } }, fakeRes());
        }
        const before = getTotal();
        statsReportHandler({ ip: '10.0.0.5', body: { bytes: 999 } }, fakeRes());
        assert.equal(getTotal(), before, 'a rate-limited report must not touch the total');
    });
});

// ---------------------------------------------------------------------------
// initStats — Upstash degradation
// ---------------------------------------------------------------------------

describe('initStats', () => {
    it('resolves without throwing when Upstash is not configured', async () => {
        await assert.doesNotReject(initStats());
    });
});
