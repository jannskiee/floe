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
const http = require('node:http');
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
// extraHeaders is inserted verbatim, each line ending in \r\n. host is the Host
// header, which the server never routes on, so a test can present whatever a
// proxy in front of it would have forwarded.
function rawUpgrade(srv, target, extraHeaders = '', host = `127.0.0.1:${srv.port}`) {
    return new Promise((resolve, reject) => {
        const socket = track(net.connect(srv.port, '127.0.0.1', () => {
            socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${extraHeaders}${UPGRADE_HEADERS}\r\n`);
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

// --- Origin on both WebSocket paths ----------------------------------------
//
// A browser names the page it runs on in Origin, so without a check any page on
// any site could open signaling sockets here from its visitors' addresses. A
// refusal is a status line on the wire, which no in-process test can see, so the
// live cases live here. The CLI and the desktop app never send a foreign Origin:
// cli/engine/signaling/client.go originFromServer sends a floe.one or localhost
// origin for the two known servers and the server's own address for any other.

const EVIL = 'Origin: https://evil.example\r\n';
const REFUSED_WS = /^Refused a connection on \/ws from Origin "https:\/\/evil\.example"/gm;
const REFUSED_SIO = /^Refused a connection on \/socket\.io from Origin "https:\/\/evil\.example"/gm;

// A plain HTTP GET with no connection pooling, for the Socket.IO polling
// transport, which is an ordinary request rather than an upgrade.
function get(srv, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: srv.port, path, headers, agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error(`no reply to ${path}`)));
    });
}

async function joinsARoom(ws) {
    const joined = waitFor(ws, 'room-joined');
    ws.send(JSON.stringify({ type: 'join-room', roomId: randomUUID() }));
    return (await joined).role;
}

test('/ws with a foreign Origin gets 403 and the server survives', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    for (let i = 0; i < 3; i++) {
        const { head, body } = await rawUpgrade(srv, '/ws', EVIL);
        assert.match(head, /^HTTP\/1\.1 403 Forbidden\r\n/);
        assert.equal(body, 'Forbidden');
    }
    await assertSurvived(srv, 'three /ws handshakes from a foreign Origin');
    // Logged once per path however many arrive: a line per refusal would hand
    // any web page a log flood at a rate it picks.
    assert.equal((srv.stderr.match(REFUSED_WS) || []).length, 1, `stderr:\n${srv.stderr}`);
});

test('no Origin reaches open', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // Any non-browser client may leave Origin out, so the server cannot require
    // it without stopping nothing but its own users.
    const { head } = await rawUpgrade(srv, '/ws');
    assert.match(head, /^HTTP\/1\.1 101 /);

    const ws = await open(srv); // the ws client sends no Origin unless told to
    assert.equal(await joinsARoom(ws), 'sender');
    await assertSurvived(srv, 'a /ws client with no Origin');
});

test('/ws with the server\'s own host as Origin reaches open', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // What every installed CLI and desktop app sends a self-hosted server. The
    // https form is the same server behind a proxy that ends TLS: host only.
    for (const origin of [`http://127.0.0.1:${srv.port}`, `https://127.0.0.1:${srv.port}`]) {
        const ws = track(new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: origin } }));
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        assert.equal(await joinsARoom(ws), 'sender', origin);
    }
    await assertSurvived(srv, 'two /ws clients naming the server\'s own host');
});

test('a Socket.IO websocket upgrade with a foreign Origin gets 400 Origin not allowed', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // engine.io's abortUpgrade answers 400 for every refusal code and carries
    // the reason allowRequest gave as the body.
    const { head, body } = await rawUpgrade(srv, '/socket.io/?EIO=4&transport=websocket', EVIL);
    assert.match(head, /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.equal(body, 'Origin not allowed');
    await assertSurvived(srv, 'a Socket.IO upgrade from a foreign Origin');
});

test('a Socket.IO websocket upgrade from http://localhost:3000 still gets 101', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    const { head, afterHandshake } = await rawUpgrade(srv, '/socket.io/?EIO=4&transport=websocket', 'Origin: http://localhost:3000\r\n');
    assert.match(head, /^HTTP\/1\.1 101 /);
    assert.ok(await afterHandshake(/"sid"/, 3000), '101 but no Socket.IO session');
    await assertSurvived(srv, 'a Socket.IO upgrade from an allowed Origin');
});

test('a Socket.IO polling handshake with a foreign Origin gets 403 and an allowed one 200', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    const path = '/socket.io/?EIO=4&transport=polling';
    const refused = await get(srv, path, { Origin: 'https://evil.example' });
    assert.equal(refused.status, 403);
    assert.deepEqual(JSON.parse(refused.body), { code: 4, message: 'Origin not allowed' });

    const allowed = await get(srv, path, { Origin: 'https://floe.one' });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /"sid"/);
    await assertSurvived(srv, 'two Socket.IO polling handshakes');
});

test('a foreign Origin on a Socket.IO target is refused by Socket.IO alone', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // The ordering proof on the wire's side. engine.io refuses these before the
    // /ws handler runs, and the second target also satisfies the /ws pathname
    // check (the dot-segment case above). If the /ws origin check ever moved
    // above either pass-through return, it would refuse these too and say so in
    // a /ws line: the client already has engine.io's 400 by then, so stderr is
    // the only place the difference shows.
    for (const target of [
        '/socket.io/?EIO=4&transport=websocket',
        '/socket.io/../ws?EIO=4&transport=websocket',
    ]) {
        const { head, body } = await rawUpgrade(srv, target, EVIL);
        assert.match(head, /^HTTP\/1\.1 400 Bad Request\r\n/, target);
        assert.equal(body, 'Origin not allowed', target);
    }
    await assertSurvived(srv, 'two Socket.IO targets from a foreign Origin');
    assert.equal((srv.stderr.match(REFUSED_SIO) || []).length, 1, `stderr:\n${srv.stderr}`);
    assert.equal((srv.stderr.match(REFUSED_WS) || []).length, 0, `the /ws check ran for a Socket.IO target:\n${srv.stderr}`);
});

// The Origin and Host the Go client sends, built the way it builds them, so the
// same-host rule is exercised with the request every installed CLI and desktop
// app actually makes. A copy of originFromServer in cli/engine/signaling/client.go
// (unchanged in every release): keep the two in step. The Host header is the
// URL's host as typed (gorilla/websocket sets `Host: u.Host`), or, behind a
// proxy like nginx `proxy_set_header Host $host`, the lowercased host name
// without its port.
function originFromServer(serverURL) {
    if (serverURL === 'https://api.floe.one') return 'https://floe.one';
    if (serverURL === 'http://localhost:3001') return 'http://localhost:3000';
    const u = serverURL.endsWith('/') ? serverURL.slice(0, -1) : serverURL;
    const i = u.indexOf('://');
    if (i === -1) return u;
    let host = u.slice(i + 3);
    const j = host.indexOf('/');
    if (j !== -1) host = host.slice(0, j);
    return u.slice(0, i + 3) + host;
}

function typedHost(serverURL) {
    const rest = serverURL.slice(serverURL.indexOf('://') + 3);
    const j = rest.indexOf('/');
    return j === -1 ? rest : rest.slice(0, j);
}

function portStrippedHost(serverURL) {
    return new URL(serverURL.replace(/^ws/, 'http')).hostname;
}

test('a Go client\'s handshake passes the same-host rule directly and through a port-stripping proxy', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    const servers = [
        `http://127.0.0.1:${srv.port}`,
        'https://floe.example.com:8443',
        'https://floe.example.com:8443/',
        'https://Floe.Example.com:8443/signal',
        'wss://floe.example.com:8443',
        'https://floe.example.com:443',
        'http://floe.example.com:80',
        'https://floe.example.com',
    ];
    for (const server of servers) {
        const origin = `Origin: ${originFromServer(server)}\r\n`;
        for (const [how, host] of [['direct', typedHost(server)], ['port-stripping proxy', portStrippedHost(server)]]) {
            const { head, socket } = await rawUpgrade(srv, '/ws', origin, host);
            assert.match(head, /^HTTP\/1\.1 101 /, `--server ${server}, ${how} (Host ${host})`);
            socket.destroy();
        }
    }

    // The edge this rule does not cover, and the docs name: a proxy that
    // rewrites Host to the upstream address.
    const { head } = await rawUpgrade(srv, '/ws', `Origin: ${originFromServer('https://floe.example.com:8443')}\r\n`, 'localhost:3001');
    assert.match(head, /^HTTP\/1\.1 403 /);
    await assertSurvived(srv, 'Go-shaped handshakes, direct and through proxies');
});
