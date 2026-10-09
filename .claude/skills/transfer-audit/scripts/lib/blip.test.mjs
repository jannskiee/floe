// lib/blip.mjs: the TA-13 host blip proxy against a loopback echo server.
// Binds 127.0.0.1 ephemeral ports only; no Floe, no network beyond loopback.
//
// Run: node --test .claude/skills/transfer-audit/scripts/lib/blip.test.mjs
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { BLIP_HOST, BlipProxy, loopbackTarget, startBlip } from './blip.mjs';

async function echoServer() {
    const sockets = new Set();
    const server = net.createServer((s) => {
        sockets.add(s);
        s.on('error', () => {});
        s.on('close', () => sockets.delete(s));
        s.pipe(s);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        sockets,
        close: () =>
            new Promise((r) => {
                for (const s of sockets) s.destroy();
                server.close(() => r());
            }),
    };
}

/** Connect, send `msg`, resolve { echoed, closed } within `ms`. */
function roundTrip(port, msg, ms = 1500) {
    return new Promise((resolve) => {
        const s = net.connect(port, BLIP_HOST);
        let data = '';
        let settled = false;
        const done = (closed) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            s.destroy();
            resolve({ echoed: data, closed });
        };
        const t = setTimeout(() => done(false), ms);
        s.on('error', () => done(true));
        s.on('close', () => done(true));
        s.on('data', (d) => {
            data += d.toString();
            if (data === msg) done(false);
        });
        s.on('connect', () => s.write(msg));
    });
}

test('blip refuses an upstream that is not loopback, before anything listens', () => {
    for (const bad of [
        'https://api.floe.one',
        'http://10.0.0.5:3001',
        'http://localhost.evil.example:3001',
        'ws://127.0.0.1:3001',
        'nonsense',
    ])
        assert.throws(() => new BlipProxy({ upstream: bad }), /not a loopback/, bad);
    assert.deepEqual(loopbackTarget('http://localhost:3001'), {
        host: 'localhost',
        port: 3001,
    });
    assert.deepEqual(loopbackTarget('http://[::1]:3001'), { host: '::1', port: 3001 });
});

test('blip binds 127.0.0.1 only and carries bytes both ways', async () => {
    const echo = await echoServer();
    const blip = await startBlip({ upstream: echo.url });
    try {
        assert.equal(blip.server.address().address, '127.0.0.1');
        const r = await roundTrip(blip.port, 'hello');
        assert.equal(r.echoed, 'hello');
        assert.equal(blip.stats.accepted, 1);
    } finally {
        await blip.stop();
        await echo.close();
    }
});

test('the proxy keeps the URL the runner points the host at, and has none before it listens', async () => {
    // request.mjs reads `blip.url` off what startBlip returns. start() used
    // to return the URL without keeping it, so the first live TA-13 run
    // (2026-09-24) pointed the host at nothing and cut a socket-free proxy.
    const idle = new BlipProxy({ upstream: 'http://localhost:3001' });
    assert.equal(idle.url, null, 'no URL before start()');
    const echo = await echoServer();
    const blip = await startBlip({ upstream: echo.url });
    try {
        assert.equal(blip.url, `http://${BLIP_HOST}:${blip.port}`);
        assert.ok(blip.port > 0);
    } finally {
        await blip.stop();
        await echo.close();
    }
});

test('a cut closes live sockets, refuses new ones for the window, then resumes', async () => {
    const echo = await echoServer();
    const blip = await startBlip({ upstream: echo.url });
    try {
        // A live proxied socket, as the host's /ws would be.
        const live = net.connect(blip.port, BLIP_HOST);
        live.on('error', () => {});
        const liveClosed = new Promise((r) => live.on('close', r));
        await new Promise((r) => live.on('connect', r));
        live.write('x');
        await new Promise((r) => live.once('data', r));
        assert.equal(blip.live, 1);

        let release;
        const gate = new Promise((r) => (release = r));
        const cutting = blip.cut(400, { wait: () => gate });
        await liveClosed;
        assert.equal(blip.live, 0, 'the live socket was destroyed');
        assert.equal(blip.cutting, true);

        const during = await roundTrip(blip.port, 'during', 800);
        assert.equal(during.echoed, '', 'nothing crosses during the cut');
        assert.equal(during.closed, true, 'a new socket is refused during the cut');
        assert.equal(blip.stats.refused, 1);

        // The window ends: the proxy accepts again.
        blip.cutUntil = 0;
        release();
        const r = await cutting;
        assert.equal(r.destroyed, 1);
        const after = await roundTrip(blip.port, 'after');
        assert.equal(after.echoed, 'after', 'the proxy resumed after the window');
        assert.equal(blip.stats.cuts, 1);
    } finally {
        await blip.stop();
        await echo.close();
    }
});

test('a cut uses its own clock window when nothing ends it early', async () => {
    const echo = await echoServer();
    const blip = await startBlip({ upstream: echo.url });
    try {
        const t0 = Date.now();
        const r = await blip.cut(150);
        assert.ok(Date.now() - t0 >= 140, 'the cut lasted its window');
        assert.equal(blip.cutting, false);
        assert.equal(r.destroyed, 0);
        const after = await roundTrip(blip.port, 'ok');
        assert.equal(after.echoed, 'ok');
        await assert.rejects(blip.cut(0), /positive window/);
    } finally {
        await blip.stop();
        await echo.close();
    }
});
