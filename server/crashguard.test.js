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
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { roomIdFromToken } = require('./hosttoken');

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
    let stdout = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => { stdout += d.toString(); });

    const srv = {
        child,
        port,
        get stderr() { return stderr; },
        get stdout() { return stdout; },
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

// --- liveness and backpressure on /ws --------------------------------------
//
// Not a crash: two ways a /ws peer can cost the process something without ever
// sending a malformed byte. They live here because, like the six kills above,
// neither is observable in process. The reap is a real heartbeat interval
// firing against a real socket, and the ceiling is the server's own
// bufferedAmount under a real paused TCP peer, which no fake can produce.

test('an unsolicited pong does not keep a silent socket seated', async (t) => {
    // HEARTBEAT_MS is a test knob; production never sets it and runs at 30 s.
    // At 300 ms the second tick, the one that reaps, lands near 600 ms.
    const srv = await startServer({ HEARTBEAT_MS: '300' });
    t.after(() => srv.stop());

    // autoPong: false switches off ws's own answer, so the only pongs on this
    // socket are the unsolicited ones below. The default client next to it
    // echoes the ping payload, which is what every shipped Floe peer does.
    const spoofer = track(new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { autoPong: false }));
    spoofer.on('error', () => {});
    await new Promise((resolve, reject) => {
        spoofer.once('open', resolve);
        spoofer.once('error', reject);
    });
    const honest = await open(srv);
    honest.on('error', () => {});

    const spam = setInterval(() => {
        try { spoofer.pong(Buffer.from('notanonce')); } catch { /* closed */ }
    }, 100);
    t.after(() => clearInterval(spam));

    const started = Date.now();
    const reaped = await Promise.race([
        new Promise((resolve) => spoofer.once('close', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    assert.equal(reaped, true, 'a stream of unsolicited pongs kept a silent socket seated');

    // "Stays open past 1.5 s" means past five heartbeat ticks.
    await new Promise((r) => setTimeout(r, Math.max(0, 1500 - (Date.now() - started))));
    assert.equal(
        honest.readyState, WebSocket.OPEN,
        'a peer that echoes the ping payload must never be reaped'
    );

    await assertSurvived(srv, 'a stream of unsolicited pongs');
});

test('a peer flooding a non-reading peer is cut off, not buffered', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    const { a, b } = await pair(srv);
    a.on('error', () => {});
    b.on('error', () => {});

    // B stops reading. Its kernel receive buffer fills, then the server's send
    // buffer, then the server's own heap: every frame A aims at B is held in
    // this process until B reads it, and B never will.
    b.pause();

    // The cut-off is asserted on A, not on B. A paused socket issues no reads,
    // so the reset that ends B arrives in B's kernel buffer and is not seen
    // until B resumes: b.readyState stays OPEN through the whole flood whether
    // or not the server cut it off. What is observable is handleDisconnect
    // telling the surviving peer, which is reading.
    let cutOff = false;
    const sawCutOff = waitFor(a, 'peer-disconnected', 20000).then(
        () => { cutOff = true; return true; },
        () => false
    );

    // Under maxPayload (1 MB) per frame, and at most 64 of them: 32 MB offered
    // in total and never more, so a regression cannot grow the CI runner past
    // that bound. The pacing lets the server read and route each frame.
    const payload = 'x'.repeat(512 * 1024);
    let frames = 0;
    while (frames < 64 && !cutOff) {
        a.send(JSON.stringify({ type: 'signal', signal: payload }));
        frames++;
        await new Promise((r) => setTimeout(r, 25));
    }

    assert.equal(
        await sawCutOff, true,
        `the server queued ${frames} frames of 512 KB for a peer that never read one`
    );
    assert.ok(frames < 64, `expected the cut-off before the 32 MB cap, offered all ${frames} frames`);

    // A is untouched: the flood costs the flooder's own peer its seat, nothing
    // more. The app-level ping is the cheapest proof the socket still serves.
    const pong = waitFor(a, 'pong');
    a.send(JSON.stringify({ type: 'ping' }));
    await pong;

    await assertSurvived(srv, 'a flood aimed at a peer that is not reading');
});

// --- request-link helpers -----------------------------------------------------

function newToken() {
    return randomBytes(32).toString('base64url');
}

// One host join; resolves with the server's first answer to it.
function hostJoin(ws, token, roomId = roomIdFromToken(token)) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('no answer to a host join')); }, 5000);
        function onMessage(raw) {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (!msg || !['room-joined', 'refused', 'room-full', 'error'].includes(msg.type)) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(msg);
        }
        ws.on('message', onMessage);
        ws.send(JSON.stringify({ type: 'join-room', roomId, hostToken: token }));
    });
}

// A /ws connection that names its own address (getClientIp trusts one hop).
function openAs(srv, address) {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { 'X-Forwarded-For': address } });
    track(ws);
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

// Every frame's reply, in order, until a pong closes the batch.
function repliesUntilPong(ws, ms = 10000) {
    return new Promise((resolve, reject) => {
        const got = [];
        const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`no pong; got ${JSON.stringify(got)}`)); }, ms);
        function onMessage(raw) {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg && msg.type === 'pong') {
                clearTimeout(timer);
                ws.off('message', onMessage);
                resolve(got);
                return;
            }
            got.push(msg);
        }
        ws.on('message', onMessage);
    });
}

// A socket that stops answering is what a throw out of a ws 'message' listener
// looks like from outside (its Receiver is left mid-write). When a wait times
// out, check the backstop first, so the failure names the Unhandled error line
// rather than the silence it caused.
async function orBackstop(srv, promise, what) {
    try {
        return await promise;
    } catch (err) {
        await assertSurvived(srv, what);
        throw err;
    }
}

function policyFileSaying(t, on) {
    const file = policyDir(t);
    writePolicy(file, JSON.stringify({ requestLinks: on }));
    return file;
}

// --- the request-link policy file (POLICY_FILE) ------------------------------
//
// The file is read at startup and on every tick of the real 60 s cleanup
// interval. A tick cannot be driven from outside the child, so the two tests
// that need one wait for it, and they run side by side so the file costs about
// two minutes of wall time rather than three.

function policyDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floe-cg-policy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'policy.json');
}

// The runbook's edit: a temp file renamed over the real one.
function writePolicy(file, content) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
}

async function features(srv) {
    const resp = await fetch(`http://127.0.0.1:${srv.port}/health`);
    assert.equal(resp.status, 200);
    return (await resp.json()).features;
}

async function until(what, ms, check) {
    const deadline = Date.now() + ms;
    for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 1000));
    }
}

const HOSTILE_POLICIES = [
    ['binary garbage', Buffer.from([0x00, 0xff, 0xfe, 0x7b, 0x22, 0x80, 0xc3, 0x28, 0x5b, 0x0a, 0xef, 0xbb, 0xbf])],
    ['2 MB of JSON', JSON.stringify({ requestLinks: true, pad: 'x'.repeat(2 * 1024 * 1024) })],
    ['[ nested 100,000 deep', '['.repeat(100000)],
    ['null', 'null'],
    ['"string"', '"string"'],
];

test.describe('request-link policy file', { concurrency: true }, () => {
    test('hostile policy file contents never reach the backstop', { timeout: 150000 }, async (t) => {
        const file = policyDir(t);

        // Startup: each variant is the file a fresh server finds at boot. The
        // read runs at module load, before the backstop is even installed, so a
        // throw there would end the process during startServer.
        for (const [name, content] of HOSTILE_POLICIES) {
            writePolicy(file, content);
            const srv = await startServer({ POLICY_FILE: file });
            await assertSurvived(srv, `a policy file of ${name} at startup`);
            assert.deepEqual(await features(srv), [], `${name} at boot must fail closed`);
            srv.stop();
        }

        // A real tick: a good file turns the feature on, then the null variant
        // lands and the next tick reads it. The one fixed stdout line is how
        // the test knows the tick ran; the last good policy must stand.
        writePolicy(file, '{"requestLinks":true}');
        const srv = await startServer({ POLICY_FILE: file });
        t.after(() => srv.stop());
        assert.deepEqual(await features(srv), ['request-1']);
        writePolicy(file, 'null');
        await until('the tick to read the null policy', 70000,
            async () => srv.stdout.includes('policy file unreadable, keeping previous policy') || /Unhandled error/.test(srv.stderr));
        await assertSurvived(srv, 'a null policy file read by the cleanup tick');
        assert.deepEqual(await features(srv), ['request-1'], 'a bad file keeps the last good policy');
        assert.doesNotMatch(srv.stdout + srv.stderr, /null|policy\.json|floe-cg-policy/,
            'no log line may carry the file content or its path');
    });

    test('policy flip within 60 s without restart', { timeout: 180000 }, async (t) => {
        const file = policyDir(t);
        writePolicy(file, '{"requestLinks":false}');
        const srv = await startServer({ POLICY_FILE: file });
        t.after(() => srv.stop());
        const pid = srv.child.pid;
        assert.deepEqual(await features(srv), []);
        const early = await open(srv);
        assert.deepEqual(await hostJoin(early, newToken()), { type: 'refused', code: 'disabled' });

        writePolicy(file, '{"requestLinks":true}');
        const onAt = Date.now();
        await until('request-1 in /health', 65000, async () => (await features(srv)).includes('request-1'));
        const onAfter = Date.now() - onAt;

        // A host that waits through the flip back to off is told so.
        const waiting = await open(srv);
        assert.deepEqual(await hostJoin(waiting, newToken()), { type: 'room-joined', role: 'host' });
        const told = waitFor(waiting, 'refused', 70000);

        writePolicy(file, '{"requestLinks":false}');
        const offAt = Date.now();
        await until('request-1 to leave /health', 65000, async () => !(await features(srv)).includes('request-1'));
        const offAfter = Date.now() - offAt;
        assert.deepEqual(await told, { type: 'refused', code: 'disabled' });

        assert.equal(srv.child.pid, pid);
        assert.equal(srv.child.exitCode, null, 'the flip must not cost a restart');
        t.diagnostic(`on after ${onAfter} ms, off after ${offAfter} ms, pid ${pid} throughout`);
        await assertSurvived(srv, 'two policy flips');
    });
});

// --- request rooms: the host join ---------------------------------------------

test('a hostToken of any hostile shape never reaches the backstop', async (t) => {
    const srv = await startServer({ POLICY_FILE: policyFileSaying(t, true) });
    t.after(() => srv.stop());

    const depth = stringifyOverflowDepth();
    assert.ok(depth, 'JSON.stringify no longer overflows at any depth this test can build');
    const deep = '['.repeat(depth * 2) + ']'.repeat(depth * 2);
    const token = newToken();
    const id = roomIdFromToken(token);
    const big = JSON.stringify('A'.repeat(900 * 1024));

    // Raw frames, so the hostile values are exactly what the wire carries.
    // The one-element array is the shape that slips past a regex without the
    // typeof guard (an array stringifies to its only element) and then reaches
    // the hash.
    const frames = [
        `{"type":"join-room","roomId":"${id}","hostToken":null}`,
        `{"type":"join-room","roomId":"${id}","hostToken":1}`,
        `{"type":"join-room","roomId":"${id}","hostToken":{}}`,
        `{"type":"join-room","roomId":"${id}","hostToken":${deep}}`,
        `{"type":"join-room","roomId":"${id}","hostToken":${big}}`,
        `{"type":"join-room","roomId":"${id}","hostToken":["${token}"]}`,
        `{"type":"join-room","roomId":null,"hostToken":"${token}"}`,
        `{"type":"join-room","roomId":{},"hostToken":"${token}"}`,
        `{"type":"join-room","roomId":["${id}"],"hostToken":"${token}"}`,
        `{"type":"join-room","roomId":${deep},"hostToken":"${token}"}`,
        `{"type":"join-room","roomId":${big},"hostToken":"${token}"}`,
    ];
    for (const f of frames) assert.ok(f.length < 1e6, `frame of ${f.length} bytes is over maxPayload`);

    const ws = await open(srv);
    const replies = repliesUntilPong(ws);
    for (const f of frames) ws.send(f);
    ws.send(JSON.stringify({ type: 'ping' }));
    const got = await orBackstop(srv, replies, 'hostile hostToken and roomId shapes on a host join');

    assert.equal(got.length, frames.length, JSON.stringify(got));
    for (const m of got.slice(0, 6)) assert.deepEqual(m, { type: 'error', message: 'Invalid host token' });
    for (const m of got.slice(6)) assert.deepEqual(m, { type: 'error', message: 'Invalid room ID' });
    await assertSurvived(srv, 'hostile hostToken and roomId shapes on a host join');

    // The socket still serves, and a real host join still works.
    assert.deepEqual(await hostJoin(ws, token), { type: 'room-joined', role: 'host' });
});

test('digest comparison never sees unequal lengths', async (t) => {
    const srv = await startServer({ POLICY_FILE: policyFileSaying(t, true) });
    t.after(() => srv.stop());

    const token = newToken();
    const id = roomIdFromToken(token);
    const host = await open(srv);
    assert.deepEqual(await hostJoin(host, token), { type: 'room-joined', role: 'host' });

    // Short and long tokens against a stored digest: refused by the regex
    // before any hash. A foreign token of the right shape fails the derivation.
    const other = await open(srv);
    const what = 'token lengths 1 to 10,000 against a stored digest, then a reclaim';
    for (const bad of ['A', 'A'.repeat(10000), `${token}A`, token.slice(1)]) {
        assert.deepEqual(await orBackstop(srv, hostJoin(other, bad, id), what), { type: 'error', message: 'Invalid host token' });
    }
    assert.deepEqual(await orBackstop(srv, hostJoin(other, newToken(), id), what), { type: 'error', message: 'Invalid host token' });

    // The one path that reaches the compare: the real token again, from a new
    // socket (newest host wins). Two 32-byte digests, by construction.
    assert.deepEqual(await orBackstop(srv, hostJoin(other, token), what), { type: 'room-joined', role: 'host' });
    await assertSurvived(srv, 'token lengths 1 to 10,000 against a stored digest, then a reclaim');
});

test('host lifecycle churn 200 times leaves the server healthy', { timeout: 120000 }, async (t) => {
    // Every connection comes from its own TEST-NET address, so neither the
    // connection limiter nor the 20-a-day create budget is what this measures.
    const srv = await startServer({ POLICY_FILE: policyFileSaying(t, true), MAX_CONNECTIONS_PER_IP: '1000' });
    t.after(() => srv.stop());

    for (let i = 0; i < 200; i++) {
        const address = `203.0.113.${i % 250}`;
        const token = newToken();
        const a = await openAs(srv, i < 250 ? address : `198.51.100.${i}`);
        assert.deepEqual(await hostJoin(a, token), { type: 'room-joined', role: 'host' }, `create ${i}`);
        a.terminate();
        const b = await openAs(srv, address);
        assert.deepEqual(await hostJoin(b, token), { type: 'room-joined', role: 'host' }, `reclaim ${i}`);
        b.close();
    }
    await assertSurvived(srv, '200 host create, terminate, reclaim and close cycles');
});
