// Cloudflare TURN mint and cache tests.
//
// This file is the deliberate exception to "server module tests live in
// server.test.js": turn.js reads CLOUDFLARE_TURN_KEY_ID and
// CLOUDFLARE_TURN_KEY_API_TOKEN at require time, so the fake keys must be in
// process.env before the first require, and server.test.js requires ./server,
// which runs dotenv.config() and loads turn.js without them. `node --test`
// runs every file in its own process, so the fake keys never leak into the
// other suites. This file never requires ./server, and every test stubs
// globalThis.fetch, so nothing here reaches the network or a real key.

process.env.CLOUDFLARE_TURN_KEY_ID = 'test-key-id';
process.env.CLOUDFLARE_TURN_KEY_API_TOKEN = 'test-api-token';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const turn = require('./turn');

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realTimeout = AbortSignal.timeout;
const realConsoleError = console.error;

let clock = 1_000_000;

function iceResponse(username) {
    return {
        ok: true,
        status: 201,
        json: async () => ({
            iceServers: {
                urls: [
                    'stun:stun.cloudflare.com:3478',
                    'turn:turn.cloudflare.com:3478?transport=udp',
                    'turns:turn.cloudflare.com:443?transport=tcp',
                ],
                username,
                credential: `cred-${username}`,
            },
        }),
    };
}

function usernameOf(servers) {
    const entry = Array.isArray(servers) ? servers.find((s) => s && s.username) : null;
    return entry ? entry.username : null;
}

const drain = () => new Promise((resolve) => setImmediate(resolve));

describe('Cloudflare TURN mint and cache', () => {
    beforeEach(() => {
        clock = 1_000_000;
        Date.now = () => clock;
        console.error = () => {};
        if (typeof turn.__resetCfCacheForTests === 'function') turn.__resetCfCacheForTests();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        Date.now = realNow;
        AbortSignal.timeout = realTimeout;
        console.error = realConsoleError;
    });

    it('cache window is at most 5 minutes', () => {
        assert.equal(typeof turn.CF_CACHE_MS, 'number');
        assert.ok(turn.CF_CACHE_MS > 0 && turn.CF_CACHE_MS <= 5 * 60 * 1000, `CF_CACHE_MS=${turn.CF_CACHE_MS}`);
    });

    it('requested ttl equals CF_TURN_TTL and stays between 12 and 48 hours', async () => {
        let body = null;
        globalThis.fetch = async (_url, init) => {
            body = JSON.parse(init.body);
            return iceResponse('u1');
        };
        await turn.generateCloudflareIceServers();
        assert.equal(typeof turn.CF_TURN_TTL, 'number');
        assert.equal(body.ttl, turn.CF_TURN_TTL);
        assert.ok(turn.CF_TURN_TTL >= 12 * 3600 && turn.CF_TURN_TTL <= 48 * 3600);
    });

    it('a fetch that settles only on abort returns null and received the signal', { timeout: 2000 }, async () => {
        const controller = new AbortController();
        let requestedMs = null;
        AbortSignal.timeout = (ms) => {
            requestedMs = ms;
            setImmediate(() => controller.abort(new DOMException('timed out', 'TimeoutError')));
            return controller.signal;
        };
        let sawSignal = false;
        globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
            // Without a signal a hung upstream would never settle; fail fast instead,
            // so a missing timeout reads as an assertion failure, not a cancelled run.
            if (!init || !init.signal) return reject(new Error('fetch called without an abort signal'));
            sawSignal = true;
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
        const result = await turn.generateCloudflareIceServers();
        assert.equal(result, null);
        assert.equal(sawSignal, true);
        assert.equal(requestedMs, 10_000);
    });

    it('8 concurrent cold calls make one upstream call and all resolve to the same username', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls += 1;
            await drain();
            return iceResponse(`u${calls}`);
        };
        const results = await Promise.all(Array.from({ length: 8 }, () => turn.generateCloudflareIceServers()));
        assert.equal(calls, 1);
        const names = new Set(results.map(usernameOf));
        assert.deepEqual([...names], ['u1']);
    });

    it('serves the cached copy then refreshes off the request path', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls += 1;
            return iceResponse(`u${calls}`);
        };
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u1');
        clock += turn.CF_CACHE_MS + 1;
        const served = await turn.generateCloudflareIceServers();
        assert.equal(usernameOf(served), 'u1', 'the expired copy is served while the refresh runs');
        await drain();
        await drain();
        assert.equal(calls, 2);
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u2');
    });

    it('a failing upstream does not re-mint on every request', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls += 1;
            return { ok: false, status: 500, json: async () => ({}) };
        };
        assert.equal(await turn.generateCloudflareIceServers(), null);
        await drain();
        assert.equal(await turn.generateCloudflareIceServers(), null);
        await drain();
        assert.equal(await turn.generateCloudflareIceServers(), null);
        assert.equal(calls, 1);
    });

    it('stale is served just inside CF_STALE_MS and null just past it', async () => {
        assert.equal(typeof turn.CF_STALE_MS, 'number');
        globalThis.fetch = async () => iceResponse('u1');
        const mintedAt = clock;
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u1');

        globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
        clock = mintedAt + turn.CF_STALE_MS;
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u1');
        await drain();

        clock = mintedAt + turn.CF_STALE_MS + 1;
        assert.equal(await turn.generateCloudflareIceServers(), null);
    });

    it('the first failure logs exactly once', async () => {
        const lines = [];
        console.error = (...args) => lines.push(args.join(' '));
        globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
        await turn.generateCloudflareIceServers();
        await drain();
        clock += 1000;
        await turn.generateCloudflareIceServers();
        await drain();
        assert.equal(lines.length, 1, lines.join('\n'));
        assert.match(lines[0], /status 502/);
        assert.doesNotMatch(lines[0], /test-api-token|cred-|test-key-id/);
    });

    it('the mint never rejects', async () => {
        globalThis.fetch = () => { throw new TypeError('synchronous throw'); };
        assert.equal(await turn.generateCloudflareIceServers(), null);
        if (typeof turn.__resetCfCacheForTests === 'function') turn.__resetCfCacheForTests();
        globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
        assert.equal(await turn.generateCloudflareIceServers(), null);
    });
});
