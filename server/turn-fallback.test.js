'use strict';

// Tests for generateCoturnCredentials, the turnCredentialsHandler rate limiter,
// and the fallback to STUN_FALLBACK. Runs WITHOUT Cloudflare env vars so
// generateCloudflareIceServers returns null, exercising the paths that
// turn.test.js (which injects fake Cloudflare keys at require time) does not
// reach. Like turn.test.js, this file is separate from server.test.js because
// turn.js reads Cloudflare env vars at require time, and each `node --test`
// file runs in its own process.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// The premise of this file (no Cloudflare keys, no coturn secret) is made true
// here instead of assumed. turn.js reads the Cloudflare pair at require time,
// so with it set every turnCredentialsHandler call below would mint a real
// credential over the network with a real API token; with the coturn pair set,
// 'returns null when both are unset' would fail.
delete process.env.CLOUDFLARE_TURN_KEY_ID;
delete process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
delete process.env.TURN_SECRET;
delete process.env.TURN_DOMAIN;

// Nothing in this file may reach the network: any fetch fails loudly and is
// counted, so a removed guard shows up as a failure instead of a silent mint.
let fetchCalls = 0;
globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('turn-fallback.test.js: unexpected network call');
};

const {
    STUN_FALLBACK,
    turnRateLimits,
    TURN_MAX_REQUESTS,
    generateCloudflareIceServers,
    generateCoturnCredentials,
    turnCredentialsHandler,
} = require('./turn');

// Tests set TURN_SECRET and TURN_DOMAIN at run time; each one gets back the
// values it started with (unset, after the deletes above) instead of a blind
// delete.
let savedTurnEnv = {};
function saveTurnEnv() {
    savedTurnEnv = { TURN_SECRET: process.env.TURN_SECRET, TURN_DOMAIN: process.env.TURN_DOMAIN };
}
function restoreTurnEnv() {
    for (const [key, value] of Object.entries(savedTurnEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

describe('the no-Cloudflare premise', () => {
    it('generateCloudflareIceServers returns null and never calls fetch', async () => {
        assert.equal(await generateCloudflareIceServers(), null);
        assert.equal(fetchCalls, 0);
    });
});

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

// ---------------------------------------------------------------------------
// generateCoturnCredentials
// ---------------------------------------------------------------------------

describe('generateCoturnCredentials', () => {
    beforeEach(saveTurnEnv);
    afterEach(restoreTurnEnv);

    it('returns null when TURN_SECRET is unset', () => {
        process.env.TURN_DOMAIN = 'turn.example.com';
        assert.equal(generateCoturnCredentials(), null);
    });

    it('returns null when TURN_DOMAIN is unset', () => {
        process.env.TURN_SECRET = 'secret';
        assert.equal(generateCoturnCredentials(), null);
    });

    it('returns null when both are unset', () => {
        assert.equal(generateCoturnCredentials(), null);
    });

    it('returns three ICE server entries when both vars are set', () => {
        process.env.TURN_SECRET = 'test-secret';
        process.env.TURN_DOMAIN = 'turn.example.com';
        const result = generateCoturnCredentials();
        assert.equal(result.length, 3);
        assert.ok(result[0].urls.startsWith('stun:'));
        assert.ok(result[1].urls.startsWith('turn:'));
        assert.ok(result[2].urls.startsWith('turns:'));
    });

    it('includes the domain in every URL', () => {
        process.env.TURN_SECRET = 'test-secret';
        process.env.TURN_DOMAIN = 'relay.example.org';
        const result = generateCoturnCredentials();
        for (const entry of result) {
            assert.ok(entry.urls.includes('relay.example.org'), entry.urls);
        }
    });

    it('username is {expiry}:floeuser with a 24h TTL', () => {
        process.env.TURN_SECRET = 'test-secret';
        process.env.TURN_DOMAIN = 'turn.example.com';
        const before = Math.floor(Date.now() / 1000) + 24 * 3600;
        const result = generateCoturnCredentials();
        const after = Math.floor(Date.now() / 1000) + 24 * 3600;
        const username = result[1].username;
        assert.ok(username.endsWith(':floeuser'));
        const expiry = parseInt(username.split(':')[0], 10);
        assert.ok(expiry >= before && expiry <= after);
    });

    it('credential is HMAC-SHA1 of the username with TURN_SECRET', () => {
        const secret = 'my-turn-secret';
        process.env.TURN_SECRET = secret;
        process.env.TURN_DOMAIN = 'turn.example.com';
        const result = generateCoturnCredentials();
        const username = result[1].username;
        const expected = crypto.createHmac('sha1', secret).update(username).digest('base64');
        assert.equal(result[1].credential, expected);
        assert.equal(result[2].credential, expected);
    });

    it('TURN and TURNS entries share the same username and credential', () => {
        process.env.TURN_SECRET = 'test-secret';
        process.env.TURN_DOMAIN = 'turn.example.com';
        const result = generateCoturnCredentials();
        assert.equal(result[1].username, result[2].username);
        assert.equal(result[1].credential, result[2].credential);
    });
});

// ---------------------------------------------------------------------------
// turnCredentialsHandler — fallback paths (no Cloudflare configured)
// ---------------------------------------------------------------------------

describe('turnCredentialsHandler — without Cloudflare', () => {
    beforeEach(() => { turnRateLimits.clear(); saveTurnEnv(); });
    afterEach(restoreTurnEnv);

    it('returns STUN_FALLBACK when no TURN provider is configured', async () => {
        const res = fakeRes();
        await turnCredentialsHandler({ ip: '1.2.3.4' }, res);
        assert.deepEqual(res.body, STUN_FALLBACK);
    });

    it('returns coturn credentials when TURN_SECRET and TURN_DOMAIN are set', async () => {
        process.env.TURN_SECRET = 'test-secret';
        process.env.TURN_DOMAIN = 'turn.example.com';
        const res = fakeRes();
        await turnCredentialsHandler({ ip: '1.2.3.4' }, res);
        assert.equal(res.body.length, 3);
        assert.ok(res.body[0].urls.startsWith('stun:'));
        assert.ok(res.body[1].urls.startsWith('turn:'));
    });

    it('rate-limits at TURN_MAX_REQUESTS then returns 429', async () => {
        for (let i = 0; i < TURN_MAX_REQUESTS; i++) {
            const res = fakeRes();
            await turnCredentialsHandler({ ip: '10.0.0.1' }, res);
            assert.equal(res.statusCode, 200, `request ${i + 1} should pass`);
        }
        const res = fakeRes();
        await turnCredentialsHandler({ ip: '10.0.0.1' }, res);
        assert.equal(res.statusCode, 429);
    });

    it('tracks IPs independently for rate limiting', async () => {
        for (let i = 0; i < TURN_MAX_REQUESTS; i++) {
            await turnCredentialsHandler({ ip: '10.0.0.1' }, fakeRes());
        }
        const res = fakeRes();
        await turnCredentialsHandler({ ip: '10.0.0.2' }, res);
        assert.equal(res.statusCode, 200);
    });

    it('collapses IPv6 addresses in the same /64 for rate limiting', async () => {
        for (let i = 0; i < TURN_MAX_REQUESTS; i++) {
            await turnCredentialsHandler(
                { ip: `2001:db8:1:2::${(i + 1).toString(16)}` },
                fakeRes(),
            );
        }
        const res = fakeRes();
        await turnCredentialsHandler({ ip: '2001:db8:1:2:ffff::1' }, res);
        assert.equal(res.statusCode, 429, 'same /64 shares the budget');
    });

    it('no handler call above reached the network', () => {
        assert.equal(fetchCalls, 0);
    });
});
