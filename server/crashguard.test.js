'use strict';

// Regression tests for six unauthenticated remote kills of the signaling
// server, and for the Socket.IO upgrade pass-through they must not break.
//
// These spawn server.js as a CHILD PROCESS rather than requiring it. That is the
// whole design of the file, not a convenience. An in-process test cannot observe
// the failure it exists to catch: `node --test` installs its own uncaughtException
// handling, so a throw escaping into the socket layer never ends the test runner,
// and a TCP connect from inside the server's own process answers whether the
// event loop is momentarily free, not whether the process is alive. An earlier
// version of this file asserted liveness that way, and its test for the
// unclaimed-path reset passed with the fix fully reverted.
//
// With a child, death is a fact (`child.exitCode`) and so is the backstop
// (its stderr). Each attack ends in assertSurvived(); see the note there for
// why the stderr half is the one that actually discriminates.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

const SERVER = require.resolve('./server.js');

// Every socket and child this file opens, so a failed assertion is a red test
// rather than a hung runner. `node --test` waits on live handles, and the
// previous version leaked a websocket on any failure, which turned a 3-second
// failure into a 10-minute CI job timeout.
const openSockets = new Set();
const children = new Set();

function track(sock) {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
    return sock;
}

test.after(() => {
    for (const s of openSockets) { try { s.destroy ? s.destroy() : s.terminate(); } catch { /* already gone */ } }
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
});

// --- harness ---------------------------------------------------------------

// A port nobody is listening on yet. server.js reads PORT and logs nothing on a
// healthy start (docs/self-hosting/operations.mdx promises exactly that), so
// there is no ready line to parse and no reason to add one just for tests.
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function startServer(extraEnv = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PORT: String(port),
            // Hermetic: without this the child inherits server/.env and initStats()
            // makes a live Upstash call on every spawn.
            UPSTASH_REDIS_REST_URL: '',
            UPSTASH_REDIS_REST_TOKEN: '',
            ...extraEnv,
        },
    });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.resume();

    const srv = {
        child,
        port,
        get stderr() { return stderr; },
        stop() { children.delete(child); child.kill('SIGKILL'); },
    };

    const deadline = Date.now() + 10000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode} during startup: ${stderr}`);
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/health`);
            if (resp.ok) { await resp.json(); break; }
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error(`server did not start: ${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
    }
    return srv;
}

// The server is alive AND nothing reached the process-level backstop.
//
// Both halves are load-bearing, and the second is the one that discriminates.
// server.js installs an uncaughtException handler that logs and keeps serving,
// so for four of the six kills the process survives whether or not the guard is
// present: "did it exit" cannot tell them apart. What can is whether the throw
// happened at all. Confirmed by mutation: reverting any one of the six guards
// puts exactly one "Unhandled error" line in the child's stderr, and reverting
// none leaves it empty.
async function assertSurvived(srv, what) {
    // A synchronous exit is observable at once; give an in-flight one a tick to
    // be reported, and the backstop's console.error time to flush.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
        srv.child.exitCode, null,
        `server process exited (${srv.child.exitCode}) after ${what}\n--- stderr ---\n${srv.stderr}`
    );
    assert.doesNotMatch(
        srv.stderr, /Unhandled error/,
        `${what} reached the uncaughtException backstop instead of being handled at its source\n--- stderr ---\n${srv.stderr}`
    );
    const resp = await fetch(`http://127.0.0.1:${srv.port}/health`);
    assert.equal(resp.status, 200, `server stopped serving after ${what}`);
    assert.equal((await resp.json()).status, 'healthy');
}

const UPGRADE_HEADERS =
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n' +
    'Sec-WebSocket-Version: 13\r\n';

// One raw upgrade request. Resolves with the reply headers, the socket (so a
// caller can write frames on an accepted connection), and afterHandshake(), which
// waits for a pattern in whatever the server sends once the headers are done.
function rawUpgrade(srv, target) {
    return new Promise((resolve, reject) => {
        const socket = track(net.connect(srv.port, '127.0.0.1', () => {
            socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n${UPGRADE_HEADERS}\r\n`);
        }));
        let buf = '';
        let headEnd = -1;
        const timer = setTimeout(() => reject(new Error(`no reply to ${target}`)), 5000);
        const waiters = [];
        const check = () => {
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].pattern.test(buf.slice(headEnd + 4))) waiters.splice(i, 1)[0].resolve(true);
            }
        };
        socket.on('data', (d) => {
            buf += d.toString('latin1');
            if (headEnd === -1 && buf.includes('\r\n\r\n')) {
                headEnd = buf.indexOf('\r\n\r\n');
                clearTimeout(timer);
                resolve({
                    head: buf.slice(0, headEnd),
                    body: buf.slice(headEnd + 4),
                    socket,
                    afterHandshake: (pattern, ms) => new Promise((res) => {
                        if (pattern.test(buf.slice(headEnd + 4))) return res(true);
                        const w = { pattern, resolve: res };
                        waiters.push(w);
                        setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); res(false); } }, ms);
                    }),
                });
            }
            if (headEnd !== -1) check();
        });
        socket.on('error', (err) => { clearTimeout(timer); reject(err); });
        socket.on('close', () => {
            clearTimeout(timer);
            for (const w of waiters.splice(0)) w.resolve(false);
            if (!buf) reject(new Error(`socket closed with no reply to ${target}`));
        });
    });
}

function open(srv) {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    track(ws);
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function waitFor(ws, type, ms = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`timed out waiting for ${type}`)); }, ms);
        function onMessage(raw) {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (!msg || msg.type !== type) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(msg);
        }
        ws.on('message', onMessage);
    });
}

async function pair(srv) {
    const roomId = randomUUID();
    const a = await open(srv);
    const b = await open(srv);
    const aJoined = waitFor(a, 'room-joined');
    a.send(JSON.stringify({ type: 'join-room', roomId }));
    await aJoined;
    const bJoined = waitFor(b, 'room-joined');
    const aSawPeer = waitFor(a, 'user-connected');
    b.send(JSON.stringify({ type: 'join-room', roomId }));
    await Promise.all([bJoined, aSawPeer]);
    return { a, b, roomId };
}

// --- (a) request targets Node accepts and WHATWG URL rejects ---------------

test('an unparseable upgrade target is refused, not fatal', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    for (const target of ['//', '///', '//?', '//[', '//@', '//%']) {
        const { head, body } = await rawUpgrade(srv, target);
        assert.match(head, /^HTTP\/1\.1 400 Bad Request\r\n/, `target ${JSON.stringify(target)}`);
        assert.equal(body, 'Bad Request');
    }
    await assertSurvived(srv, 'six unparseable upgrade targets');
});

// --- (e) a target both routers claim ---------------------------------------

test('a dot-segment target is left to Socket.IO, not claimed twice', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // engine.io claims an upgrade by a literal prefix compare on the UNPARSED
    // target; this server compares a WHATWG-normalized pathname. Each of these
    // satisfies both, so engine.io completed the handshake and then
    // wss.handleUpgrade threw "called more than once with the same socket".
    //
    // The 101 alone proves nothing here: engine.io sends it before this server
    // ever runs, so it arrives either way. What separates a working connection
    // from a broken one is what comes after it, which is why the engine.io OPEN
    // packet is the assertion. Without the guard the throw is caught one frame
    // later and the socket is destroyed, so the packet never arrives.
    for (const target of [
        '/socket.io/../ws?EIO=4&transport=websocket',
        '/socket.io/%2e%2e/ws?EIO=4&transport=websocket',
        '/socket.io/a/b/../../../ws?EIO=4&transport=websocket',
    ]) {
        const { head, afterHandshake } = await rawUpgrade(srv, target);
        assert.match(head, /^HTTP\/1\.1 101 /, `target ${target} should be handled by Socket.IO`);
        const opened = await afterHandshake(/"sid"/, 3000);
        assert.ok(opened, `${target} produced a 101 but no usable Socket.IO session`);
    }
    await assertSurvived(srv, 'three dot-segment upgrade targets');
});

test('a plain /socket.io/ upgrade still reaches Socket.IO', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // The guard that matters most in this file. Break the pass-through and every
    // browser silently falls back to long-polling: transfers still work, nothing
    // errors, and no other test notices.
    const { head } = await rawUpgrade(srv, '/socket.io/?EIO=4&transport=websocket');
    assert.match(head, /^HTTP\/1\.1 101 /);
    await assertSurvived(srv, 'a Socket.IO upgrade');
});

// --- (b) a JSON scalar as a message ----------------------------------------

test('a literal null frame is ignored and the socket keeps working', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // JSON.parse('null') returns null without throwing, so the parse guard misses
    // it and reading .type raised a TypeError inside a ws 'message' listener.
    const ws = await open(srv);
    ws.send('null');
    const pong = waitFor(ws, 'pong');
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await pong).type, 'pong');
    await assertSurvived(srv, 'a null frame');
});

// --- (d) a deeply nested signal --------------------------------------------

// Smallest depth at which JSON.stringify overflows the stack on THIS runtime,
// found by doubling. Not a constant: V8's JSON.parse is iterative while
// JSON.stringify is recursive, and the recursion budget varies with the stack
// size, so the figure differs between Node majors and machines. Measured 2235 on
// Node 22.18 here, a 4.4 KB frame. The test asserts the premise instead of
// assuming it, so a future runtime that changes either half fails loudly rather
// than passing for the wrong reason.
function stringifyOverflowDepth() {
    for (let depth = 512; depth <= 262144; depth *= 2) {
        const value = JSON.parse('['.repeat(depth) + ']'.repeat(depth));
        try { JSON.stringify(value); } catch (err) {
            if (err instanceof RangeError) return depth;
            throw err;
        }
    }
    return null;
}

test('a deeply nested signal is dropped and both peers stay usable', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    const depth = stringifyOverflowDepth();
    assert.ok(depth, 'JSON.stringify no longer overflows at any depth this test can build, so it is not exercising the kill');
    const nested = '['.repeat(depth) + ']'.repeat(depth);
    const frame = `{"type":"signal","signal":${nested}}`;
    assert.ok(frame.length < 1e6, `frame is ${frame.length} bytes, over the server's 1 MB maxPayload`);
    assert.doesNotThrow(() => JSON.parse(nested), 'the server must be able to parse this or it never reaches handleSignal');

    const { a, b } = await pair(srv);
    a.send(frame);

    // Three claims. The last two are what separate the fix at its source from
    // the uncaughtException backstop: with the backstop alone the process lives,
    // but the sending peer's ws Receiver is left mid-write and that socket
    // answers nothing at all, so it never leaves `rooms` either.
    await assertSurvived(srv, `a ${depth}-deep signal`);

    const pong = waitFor(a, 'pong');
    a.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await pong).type, 'pong', 'the sending peer should still be answering');

    const relayed = waitFor(b, 'signal');
    a.send(JSON.stringify({ type: 'signal', signal: { sdp: 'ok' } }));
    assert.deepEqual((await relayed).signal, { sdp: 'ok' }, 'a normal signal should still relay');
});

// --- (c) a reset inside the upgrade window ---------------------------------

test('a client reset on an unclaimed upgrade path is not fatal', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // Node removes its own socket 'error' listener before emitting 'upgrade',
    // and for a path neither /ws nor engine.io's nothing attaches another.
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => {
            const socket = track(net.connect(srv.port, '127.0.0.1', () => {
                socket.write(`GET /nope HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n${UPGRADE_HEADERS}\r\n`);
                setTimeout(() => { socket.resetAndDestroy(); resolve(); }, 40);
            }));
            socket.on('error', resolve);
        });
    }
    await assertSurvived(srv, 'five resets on an unclaimed upgrade path');
});

// --- (f) a malformed frame on a rate-limited connection --------------------

test('a malformed frame on a rate-limited connection is not fatal', async (t) => {
    // MAX_CONNECTIONS_PER_IP is what the production default (30) would need 31
    // connections to reach; 2 reaches the same branch in three.
    const srv = await startServer({ MAX_CONNECTIONS_PER_IP: '2' });
    t.after(() => srv.stop());

    await open(srv);
    await open(srv);

    // The third is accepted at the HTTP layer and rejected by the handler, which
    // used to return before attaching any 'error' listener. close() only starts
    // the handshake, so the Receiver keeps reading for 30 seconds.
    const { head, socket } = await rawUpgrade(srv, '/ws');
    assert.match(head, /^HTTP\/1\.1 101 /);
    // An unmasked text frame from a client. Four bytes, no crafting.
    socket.write(Buffer.from([0x81, 0x02, 0x41, 0x42]));

    await assertSurvived(srv, 'an unmasked frame on a rate-limited connection');
});
