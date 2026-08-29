// node --test .claude/skills/<skill>/scripts/lib/turn.test.mjs
// The redaction proof: a fake /api/turn-credentials body carrying
// username and credential strings must never reach the probe result, any
// log line, or any file the probe caller writes under --out.
import assert from 'node:assert/strict';
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
    STUN_FALLBACK_BYTES,
    STUN_FALLBACK_BYTES_MIN,
    classifyIce,
    describeTurn,
    probeTurn,
} from './turn.mjs';
import { Ledger } from './pacing.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'lta-turn-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const USER = 'USER-SECRET-a1b2c3';
const CRED = 'CRED-SECRET-z9y8x7';
const STUN_FALLBACK = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];
const CLOUDFLARE = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
        urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: USER,
        credential: CRED,
    },
];
const COTURN = [
    { urls: 'stun:turn.example.org:3478' },
    { urls: 'turn:turn.example.org:3478', username: USER, credential: CRED },
];

test('classifyIce on every served shape', () => {
    assert.deepEqual(classifyIce(STUN_FALLBACK), {
        entries: 2,
        schemes: ['stun'],
        servesTurn: false,
    });
    assert.deepEqual(classifyIce(CLOUDFLARE), {
        entries: 2,
        schemes: ['stun', 'turn', 'turns'],
        servesTurn: true,
    });
    assert.deepEqual(classifyIce(COTURN), {
        entries: 2,
        schemes: ['stun', 'turn'],
        servesTurn: true,
    });
    assert.deepEqual(classifyIce({ iceServers: COTURN }), {
        entries: 2,
        schemes: ['stun', 'turn'],
        servesTurn: true,
    });
    assert.deepEqual(classifyIce(null), {
        entries: 0,
        schemes: [],
        servesTurn: false,
    });
    assert.deepEqual(classifyIce({ error: 'Too many requests' }), {
        entries: 0,
        schemes: [],
        servesTurn: false,
    });
});

function fakeFetch(body, { status = 200, calls } = {}) {
    return async (url, init) => {
        calls?.push({ url, method: init?.method });
        const text = JSON.stringify(body);
        return {
            status,
            ok: status >= 200 && status < 300,
            url,
            headers: new Map([
                ['content-length', String(Buffer.byteLength(text))],
            ]),
            text: async () => text,
        };
    };
}

test('probeTurn returns schemes only; credentials never appear anywhere', async () => {
    const logLines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => logLines.push(a.join(' '));
    console.error = (...a) => logLines.push(a.join(' '));
    let result;
    let thrown = null;
    try {
        const calls = [];
        result = await probeTurn('https://example.invalid/', {
            fetchImpl: fakeFetch(CLOUDFLARE, { calls }),
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'GET');
        assert.equal(
            calls[0].url,
            'https://example.invalid/api/turn-credentials'
        );
    } catch (e) {
        thrown = e;
    } finally {
        console.log = origLog;
        console.error = origErr;
    }
    assert.equal(thrown, null);
    const text = JSON.stringify(result);
    assert.ok(!text.includes(USER) && !text.includes(CRED), text);
    assert.ok(!text.includes('cloudflare.com'), 'urls must not leak either');
    assert.ok(
        !('urls' in result) &&
            !('username' in result) &&
            !('credential' in result)
    );
    assert.equal(result.servesTurn, true);
    assert.deepEqual(result.schemes, ['stun', 'turn', 'turns']);
    assert.equal(result.entries, 2);
    assert.equal(result.stunFallbackShape, false);
    assert.ok(logLines.every((l) => !l.includes(USER) && !l.includes(CRED)));
    // The caller writes the result to --out: prove the file is clean too.
    const file = path.join(dir, 'probe.json');
    writeFileSync(file, JSON.stringify({ turn: { prod: result } }, null, 4));
    for (const f of readdirSync(dir)) {
        const content = readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!content.includes(USER) && !content.includes(CRED), f);
    }
});

test('STUN fallback is flagged by scheme and by the 84-byte body', async () => {
    const body = JSON.stringify(STUN_FALLBACK);
    assert.equal(Buffer.byteLength(body), STUN_FALLBACK_BYTES_MIN);
    assert.ok(STUN_FALLBACK_BYTES_MIN <= STUN_FALLBACK_BYTES);
    const r = await probeTurn('http://localhost:3001', {
        fetchImpl: fakeFetch(STUN_FALLBACK),
    });
    assert.equal(r.servesTurn, false);
    assert.equal(r.stunFallbackShape, true);
    assert.equal(r.contentLength, 82);
    assert.equal(describeTurn(r), '2 entries, schemes stun');
});

test('a 429 is reported as rateLimited with servesTurn null', async () => {
    const r = await probeTurn('http://localhost:3001', {
        fetchImpl: fakeFetch({ error: 'Too many requests' }, { status: 429 }),
    });
    assert.equal(r.status, 429);
    assert.equal(r.rateLimited, true);
    assert.equal(r.servesTurn, null);
    assert.equal(describeTurn(r), 'HTTP 429');
});

test('the probe pays one TURN unit through the ledger', async () => {
    let t = 0;
    const ledger = new Ledger({ now: () => t, minGapMs: 0 });
    await probeTurn('https://example.invalid', {
        fetchImpl: fakeFetch(CLOUDFLARE),
        ledger,
        sleep: async () => {},
    });
    assert.deepEqual(ledger.inWindow(), { turn: 1, conn: 0, code: 0 });
});

test('a 200 with a non-JSON body is body-not-json, never "no turn scheme served"', async () => {
    const html = async (url) => ({
        status: 200,
        ok: true,
        url,
        headers: new Map([['content-length', '28']]),
        text: async () => '<html>captive portal</html>',
    });
    const r = await probeTurn('http://localhost:3001', { fetchImpl: html });
    assert.equal(r.status, 200);
    assert.equal(r.bodyJson, false);
    assert.equal(r.servesTurn, null, 'nothing proved either way');
    assert.equal(r.stunFallbackShape, false);
    assert.equal(describeTurn(r), 'HTTP 200, body-not-json');
    const stun = await probeTurn('http://localhost:3001', {
        fetchImpl: fakeFetch(STUN_FALLBACK),
    });
    assert.equal(stun.bodyJson, true);
    assert.equal(stun.servesTurn, false);
    assert.equal(describeTurn(stun), '2 entries, schemes stun');
});
