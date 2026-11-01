 'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { roomIdFromToken } = require('./hosttoken');

const SERVER = require.resolve('./server.js');

function mulberry32(seed) {
    return function () {
        let t = (seed += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function choose(random, values) {
    return values[Math.floor(random() * values.length)];
}


function makeFrames(seed, count) {
    const random = mulberry32(seed);
    const token = Array.from(
        { length: 32 },
        () => Math.floor(random() * 256),
    );
    const validToken = Buffer.from(token).toString('base64url');
    const validRoomId = roomIdFromToken(validToken);

    
    const deepValue = '['.repeat(1200) + '0' + ']'.repeat(1200);

    const roomIds = [
        null,
        1,
        {},
        [],
        '__proto__',
        'constructor',
        '\uD800',
        '\uDFFF',
        '00000000-0000-4000-8000-000000000042',
        validRoomId,
        'a'.repeat(128),
        deepValue,
        'x'.repeat(900_000),
    ];


    const types = [
        'join-room',
        'request-join',
        'request-seal',
        'request-reopen',
        'request-close',
        'signal',
        'ping',
    ];

    return Array.from({ length: count }, () => {
        const type = choose(random, types);
        const payload = {
            type,
            roomId: choose(random, roomIds),
        };

        if (type === 'join-room' && random() < 0.5) {
            payload.hostToken = validToken;
        }

        if (type === 'signal') {
            payload.signal = choose(random, [
                null,
                {},
                { type: 'offer' },
                { type: 'answer', sdp: 'x'.repeat(256) },
            ]);
        }

        if (random() < 0.15) {
            payload.extra = choose(random, [
                null,
                '__proto__',
                'constructor',
                { ['__proto__']: true },
                { constructor: 'test' },
            ]);
        }


        return JSON.stringify(payload);
    });

}

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function policyFile(t, requestLinks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floe-fuzz-policy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ requestLinks }));

    return file;
}

async function startServer(extraEnv = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PORT: String(port),
            UPSTASH_REDIS_REST_URL: '',
            UPSTASH_REDIS_REST_TOKEN: '',
            CLOUDFLARE_TURN_KEY_ID: '',
            CLOUDFLARE_TURN_KEY_API_TOKEN: '',
            TURN_SECRET: '',
            TURN_DOMAIN: '',
            TRUSTED_PROXY_COUNT: '1',
            ...extraEnv,
        },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const srv = {
        child,
        port,
        get stderr() { return stderr; },
        stop() { child.kill('SIGKILL'); },
    };

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited during startup: ${stderr}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.status === 200) return srv;
        } catch {
            // Wait for the HTTP listener.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    srv.stop();
    throw new Error(`Server did not start: ${stderr}`);
}

async function assertHealthy(srv, label) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(srv.child.exitCode, null, `${label}: server exited`);
    assert.doesNotMatch(srv.stderr, /Unhandled error/, `${label}: backstop reached`);

    const response = await fetch(`http://127.0.0.1:${srv.port}/health`);
    assert.equal(response.status, 200, `${label}: health endpoint failed`);
    assert.equal((await response.json()).status, 'healthy');
}

let nextClientIp = 10;

function nextClientAddress() {
    const blocks = ['192.0.2', '198.51.100', '203.0.113'];
    const index = nextClientIp++ - 1;

    return `${blocks[Math.floor(index / 254) % blocks.length]}.${(index % 254) + 1}`;
}

function openWs(srv) {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, {
        headers: {
            'X-Forwarded-For': nextClientAddress(),
        },
    });

    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function createResponseCoverage() {
    const counts = new Map();

    function record(message) {
        const type = typeof message?.type === 'string'
            ? message.type
            : 'unknown';
        counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    function report(label) {
        const summary = Object.fromEntries(
            [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
        );
        console.log(`${label} response coverage: ${JSON.stringify(summary)}`);
        return summary;
    }

    return { record, report };
}

function waitForType(ws, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off('message', onMessage);
            reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);

        function onMessage(raw) {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }

            if (message?.type === type) {
                clearTimeout(timer);
                ws.off('message', onMessage);
                resolve(message);
            }
        }

        ws.on('message', onMessage);
    });
}


function waitForPong(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off('message', onMessage);
            reject(new Error('Canary did not receive pong'));
        }, timeoutMs);

        function onMessage(raw) {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (message?.type === 'pong') {
                clearTimeout(timer);
                ws.off('message', onMessage);
                resolve();
            }
        }

        ws.on('message', onMessage);
    });
}


test('request-link policy toggles the advertised feature', async (t) => {
    for (const enabled of [true, false]) {
        const policy = policyFile(t, enabled);
        const srv = await startServer({ POLICY_FILE: policy });
        t.after(() => srv.stop());

        const response = await fetch(
            `http://127.0.0.1:${srv.port}/health`,
        );

        assert.equal(response.status, 200);

        const health = await response.json();

        if (enabled) {
            assert.ok(
                health.features.includes('request-1'),
                'request-1 should be advertised when request links are enabled',
            );
        } else {
            assert.ok(
                !health.features.includes('request-1'),
                'request-1 should not be advertised when request links are disabled',
            );
        }

        await assertHealthy(srv, `requestLinks=${enabled}`);
    }
});


test('seeded sequence pairs, signals, disconnects and reconnects', async (t) => {
    const srv = await startServer({
        POLICY_FILE: policyFile(t, true),
    });
    t.after(() => srv.stop());

    const seed = Number(process.env.FLOE_SERVER_FUZZ_SEED ?? 42);
    const random = mulberry32(seed ^ 0x6A09E667);
    const tokenBytes = Array.from(
    { length: 32 },
    () => Math.floor(random() * 256),
);
const token = Buffer.from(tokenBytes).toString('base64url');
    const roomId = roomIdFromToken(token);

    const host = await openWs(srv);
    t.after(() => host.terminate());

    const hostReply = waitForType(host, 'room-joined');
    host.send(JSON.stringify({
        type: 'join-room',
        roomId,
        hostToken: token,
    }));
    assert.equal((await hostReply).role, 'host');

    const visitor = await openWs(srv);
    t.after(() => visitor.terminate());

    const visitorReply = waitForType(visitor, 'request-joined');
    visitor.send(JSON.stringify({
        type: 'request-join',
        roomId,
    }));
    await visitorReply;

    const signalReply = waitForType(visitor, 'signal');
    host.send(JSON.stringify({
        type: 'signal',
        signal: { type: 'offer', sdp: 'fuzz-test' },
    }));
    await signalReply;

    visitor.terminate();

    await assertHealthy(srv, 'after visitor disconnect');

    const reconnectedVisitor = await openWs(srv);
    t.after(() => reconnectedVisitor.terminate());

    const reconnectReply = waitForType(reconnectedVisitor, 'request-joined');
    reconnectedVisitor.send(JSON.stringify({
        type: 'request-join',
        roomId,
    }));
    await reconnectReply;

    await assertHealthy(srv, 'after visitor reconnect');
});

test('seeded frame fuzzer keeps the /ws server healthy', async (t) => {
    const seed = Number(process.env.FLOE_SERVER_FUZZ_SEED ?? 42);
    const count = Number(process.env.FLOE_SERVER_FUZZ_FRAMES ?? 100);

    assert.ok(Number.isSafeInteger(seed), 'seed must be a safe integer');
    assert.ok(Number.isSafeInteger(count) && count > 0, 'frame count must be positive');

    const frames = makeFrames(seed, count);
    assert.ok(frames.every((frame) => Buffer.byteLength(frame) < 1_000_000));

    const srv = await startServer();
    t.after(() => srv.stop());

    const fuzzSocket = await openWs(srv);
    const canary = await openWs(srv);
    const coverage = createResponseCoverage();
    fuzzSocket.on('message', (raw) => {
        try {
            coverage.record(JSON.parse(raw.toString()));
        } catch {
            coverage.record(null);
        }
    });
    t.after(() => {
        fuzzSocket.terminate();
        canary.terminate();
    });

    for (let i = 0; i < frames.length; i++) {
        if (fuzzSocket.readyState !== WebSocket.OPEN) break;
        fuzzSocket.send(frames[i]);

        if ((i + 1) % 10 === 0 || i === frames.length - 1) {
            await assertHealthy(srv, `seed ${seed}, frame ${i + 1}`);

            const pong = waitForPong(canary);
            canary.send(JSON.stringify({ type: 'ping' }));
            await pong;
        }
    }

    await assertHealthy(srv, `seed ${seed}, completed`);
    console.log(`Fuzzer /ws: seed=${seed}, frames=${frames.length}`);
    coverage.report('Fuzzer /ws');
});

function openSocketIO(srv) {
    const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/socket.io/?EIO=4&transport=websocket`,
        {
            headers: {
                Origin: 'http://localhost:3000',
                'X-Forwarded-For': nextClientAddress(),
            },
        },
    );

    ws.on('error', () => {});

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('Socket.IO namespace handshake timed out'));
        }, 5000);

        ws.on('message', (raw) => {
            const message = raw.toString();

            if (message.startsWith('0')) {
                ws.send('40');
            } else if (message === '2') {
                ws.send('3');
            } else if (message.startsWith('40')) {
                clearTimeout(timer);
                resolve({
                    ws,
                    sendEvent(event, ...args) {
                        ws.send(`42${JSON.stringify([event, ...args])}`);
                    },
                    sendPingWithAck() {
                        ws.send(`421${JSON.stringify(['ping'])}`);
                    },
                });
            }
        });

        ws.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
test('Socket.IO handshake and ping events work while server stays healthy', async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());

    const client = await openSocketIO(srv);
    t.after(() => client.ws.terminate());

    // Ping without ACK.
    client.sendEvent('ping');

    // Ping with ACK. Socket.IO event id 1 requests an acknowledgement.
    const ack = new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Socket.IO ping ACK timed out')),
            5000,
        );

        client.ws.on('message', function onMessage(raw) {
            const message = raw.toString();
            if (message.startsWith('431')) {
                clearTimeout(timer);
                client.ws.off('message', onMessage);
                resolve(message);
            }
        });
    });

    client.sendPingWithAck();
    assert.match(await ack, /^431/);

    await assertHealthy(srv, 'Socket.IO ping');
});
test('seeded frame fuzzer keeps the Socket.IO server healthy', async (t) => {
    const seed = Number(process.env.FLOE_SERVER_FUZZ_SEED ?? 42);
    const count = Number(process.env.FLOE_SERVER_FUZZ_FRAMES ?? 100);

    assert.ok(Number.isSafeInteger(seed), 'seed must be a safe integer');
    assert.ok(Number.isSafeInteger(count) && count > 0, 'frame count must be positive');

    const random = mulberry32(seed ^ 0x51A7);
    const roomIds = [
        null,
        1,
        {},
        [],
        '__proto__',
        'constructor',
        '00000000-0000-4000-8000-000000000042',
    ];
    const events = ['ping', 'join-room', 'request-join', 'signal'];

    const srv = await startServer();
    t.after(() => srv.stop());

    const client = await openSocketIO(srv);
    const canary = await openSocketIO(srv);
    const coverage = createResponseCoverage();

    client.ws.on('close', (code) => {
        coverage.record({ type: `close:${code}` });
    });
    client.ws.on('message', (raw) => {
        const message = raw.toString();

        try {
            // Socket.IO event packet: 42[eventName, payload]
            if (message.startsWith('42')) {
                const packet = JSON.parse(message.slice(2));
                const eventName = Array.isArray(packet) ? packet[0] : null;

                coverage.record(
                    typeof eventName === 'string'
                        ? { type: `event:${eventName}` }
                        : null,
                );
                return;
            }

            // Socket.IO ACK packet: 43<packetId>[payload]
            if (message.startsWith('43')) {
                coverage.record({ type: 'ack' });
            }
        } catch {
            coverage.record(null);
        }
    });
    t.after(() => {
        client.ws.terminate();
        canary.ws.terminate();
    });

    for (let i = 0; i < count; i++) {
        const event = choose(random, events);
        const roomId = choose(random, roomIds);

        if (event === 'signal') {
            client.sendEvent('signal', {
                signal: choose(random, [
                    null,
                    {},
                    { type: 'offer' },
                    { type: 'answer', sdp: 'x'.repeat(128) },
                ]),
            });
        } else if (event === 'ping') {
            if (random() < 0.5) {
                client.sendEvent('ping');
            } else {
                client.sendPingWithAck();
            }
        } else {
            client.sendEvent(event, roomId);
        }

        if ((i + 1) % 10 === 0 || i === count - 1) {
            await assertHealthy(srv, `Socket.IO seed ${seed}, event ${i + 1}`);
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    canary.ws.off('message', onMessage);
                    reject(new Error('Socket.IO canary ACK timed out'));
                }, 5000);

                function onMessage(raw) {
                    if (raw.toString().startsWith('431')) {
                        clearTimeout(timer);
                        canary.ws.off('message', onMessage);
                        resolve();
                    }
                }

                canary.ws.on('message', onMessage);
                canary.sendPingWithAck();
            });
        }

        if (client.ws.readyState !== WebSocket.OPEN) break;
    }

    await assertHealthy(srv, `Socket.IO seed ${seed}, completed`);
    console.log(`Fuzzer Socket.IO: seed=${seed}, events=${count}`);
    coverage.report('Fuzzer Socket.IO');
});
