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

    it('a failure in the next window logs again with its own reason', async () => {
        const lines = [];
        console.error = (...args) => lines.push(args.join(' '));
        const mintedAt = clock;
        globalThis.fetch = async () => {
            clock += 10_000; // a slow failure: the first line is logged 10 s into the window
            throw new DOMException('timed out', 'TimeoutError');
        };
        assert.equal(await turn.generateCloudflareIceServers(), null);
        await drain();

        clock = mintedAt + turn.CF_CACHE_MS;
        globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
        assert.equal(await turn.generateCloudflareIceServers(), null);
        await drain();

        assert.equal(lines.length, 2, lines.join('\n'));
        assert.match(lines[0], /TimeoutError/);
        assert.match(lines[1], /status 502/);
    });

    // Node's fetch rejects every failure to reach a host the same way, with a
    // TypeError whose message is 'fetch failed', and keeps what went wrong in
    // its cause: a code such as ENOTFOUND, and a message that names the host.
    // The reason is the code when it is a plain code, else the error's name
    // when it is a plain word, else the word error, as for the Upstash line.
    it('a network failure logs its error code, never a message or the host', async () => {
        const lines = [];
        console.error = (...args) => lines.push(args.join(' '));
        globalThis.fetch = () => Promise.reject(Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND rtc.live.cloudflare.com'), { code: 'ENOTFOUND' }),
        }));
        assert.equal(await turn.generateCloudflareIceServers(), null);
        await drain();
        assert.deepEqual(lines, ['Cloudflare TURN mint failed (ENOTFOUND)']);
        assert.doesNotMatch(lines.join('\n'), /fetch failed|getaddrinfo|rtc\.live|test-api-token|test-key-id/);
    });

    it('a code that is not a plain code falls back to the error name', async () => {
        const lines = [];
        console.error = (...args) => lines.push(args.join(' '));
        globalThis.fetch = () => Promise.reject(Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ENOTFOUND) token=ABC' },
        }));
        assert.equal(await turn.generateCloudflareIceServers(), null);
        await drain();
        assert.deepEqual(lines, ['Cloudflare TURN mint failed (TypeError)']);
    });

    it('a name that is not a plain word logs the word error', async () => {
        const lines = [];
        console.error = (...args) => lines.push(args.join(' '));
        globalThis.fetch = () => Promise.reject(Object.assign(new Error('boom'), { name: 'x) token=abc' }));
        assert.equal(await turn.generateCloudflareIceServers(), null);
        await drain();
        assert.deepEqual(lines, ['Cloudflare TURN mint failed (error)']);
    });

    it('the mint never rejects', async () => {
        globalThis.fetch = () => { throw new TypeError('synchronous throw'); };
        assert.equal(await turn.generateCloudflareIceServers(), null);
        if (typeof turn.__resetCfCacheForTests === 'function') turn.__resetCfCacheForTests();
        globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
        assert.equal(await turn.generateCloudflareIceServers(), null);
    });

    it('serves a copy at once under an hour old, and over an hour waits for its refresh', async () => {
        let n = 0;
        globalThis.fetch = async () => iceResponse(`u${++n}`);
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u1');
        clock += 59 * 60 * 1000;
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u1');
        await drain();
        clock += 61 * 60 * 1000; // the copy minted behind it is 61 minutes old
        const served = await turn.generateCloudflareIceServers();
        await drain();
        assert.equal(usernameOf(served), 'u3');
    });

    it('while Cloudflare fails, still serves a copy 22 hours old', async () => {
        globalThis.fetch = async () => iceResponse('u1');
        await turn.generateCloudflareIceServers();
        globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
        clock += 22 * 3600 * 1000;
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u1');
        await drain();
        clock += 1000; // within 5 minutes of that failure
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u1');
    });
});

describe('relayState with Cloudflare keys', () => {
    // The coturn pair could come from the shell that runs the suite; without
    // it a lapsed Cloudflare copy reads 'stun', as the handler then serves.
    let savedCoturn;
    beforeEach(() => {
        clock = 1_000_000;
        Date.now = () => clock;
        console.error = () => {};
        turn.__resetCfCacheForTests();
        savedCoturn = { TURN_SECRET: process.env.TURN_SECRET, TURN_DOMAIN: process.env.TURN_DOMAIN };
        delete process.env.TURN_SECRET;
        delete process.env.TURN_DOMAIN;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        Date.now = realNow;
        console.error = realConsoleError;
        for (const [key, value] of Object.entries(savedCoturn)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
    // A /health poll must never mint: any fetch while reading fails the test.
    function readState() {
        const before = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('relayState fetched'); };
        try { return turn.relayState(); } finally { globalThis.fetch = before; }
    }

    it('reads cloudflare before anything was minted, without minting', () => {
        assert.equal(readState(), 'cloudflare');
    });

    it('walks cloudflare, cloudflare-failing, stun and back as mints fail and recover', async () => {
        globalThis.fetch = async () => iceResponse('u1');
        await turn.generateCloudflareIceServers();
        assert.equal(readState(), 'cloudflare');

        // One failed refresh is noise: the copy is still served.
        globalThis.fetch = failing;
        clock += turn.CF_CACHE_MS + 1;
        await turn.generateCloudflareIceServers();
        await drain();
        assert.equal(readState(), 'cloudflare');

        // A second in a row, while the last copy is still served.
        clock += turn.CF_CACHE_MS + 1;
        await turn.generateCloudflareIceServers();
        await drain();
        assert.equal(readState(), 'cloudflare-failing');

        // Past CF_STALE_MS the copy is no longer served, and the handler
        // answers with STUN only.
        clock = 1_000_000 + turn.CF_STALE_MS + 1;
        assert.equal(readState(), 'stun');

        // The next good mint clears it.
        globalThis.fetch = async () => iceResponse('u2');
        clock += turn.CF_CACHE_MS + 1;
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u2');
        assert.equal(readState(), 'cloudflare');
    });

    it('a quiet server whose last good copy aged out still reads cloudflare', async () => {
        // Nothing mints without a request, so a self-host nobody used for a
        // day must not read as a dead relay: its next request mints.
        globalThis.fetch = async () => iceResponse('u1');
        await turn.generateCloudflareIceServers();
        clock += turn.CF_STALE_MS + 1;
        assert.equal(readState(), 'cloudflare');
        globalThis.fetch = async () => iceResponse('u2');
        assert.equal(usernameOf(await turn.generateCloudflareIceServers()), 'u2');
    });

    it('a first mint that fails reads stun, which is what the handler then serves', async () => {
        globalThis.fetch = failing;
        assert.equal(await turn.generateCloudflareIceServers(), null);
        assert.equal(readState(), 'stun');
    });

    it('reads coturn once no Cloudflare copy is usable and the coturn pair is set', async () => {
        process.env.TURN_SECRET = 'test-secret';
        process.env.TURN_DOMAIN = 'turn.example.com';
        globalThis.fetch = failing;
        await turn.generateCloudflareIceServers();
        assert.equal(readState(), 'coturn');
    });
});
