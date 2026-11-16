'use strict';

// A seeded, reproducible fuzzer for the signaling server's two socket
// transports, /ws and Socket.IO. It drives server.js as a child process, as
// crashguard.test.js does and for the same reason (see the note at the top of
// that file): only a child shows a throw that reaches the process backstop.
// crashguard.test.js pins the kills found by hand in #441; this file keeps
// looking for new ones, in every frame type, in hostile values of every field
// the server reads, and in orderings across several sockets that reach the
// stateful paths (a paired room, a request link with its host and visitors).
//
// The smoke, with a fixed seed, runs inside `npm test`: one child with
// request links on and one with them off, then a check that the generator
// replays its seed exactly. Two variables change the run:
//
//   FLOE_SERVER_FUZZ_SEED    the seed, a whole number from 0 to 4294967295.
//                            The same seed sends the same frames, in the same
//                            order, on the same Node version (the deep nest
//                            is sized to the runtime's own stack).
//   FLOE_SERVER_FUZZ_FRAMES  how many frames to send to each child. The smoke
//                            sends SMOKE_FRAMES. From LONG_RUN_FRAMES up, the
//                            run is a long run, and must also reach every
//                            reply type in LONG_RUN_REPLIES.
//
// An empty variable reads as unset. A long run, from server/:
//
//   FLOE_SERVER_FUZZ_SEED=42 FLOE_SERVER_FUZZ_FRAMES=200000 node --test fuzz.test.js
//
// A batch fails when the child has exited, when its stderr carries an
// "Unhandled error" line, when /health stops answering 200, or when a canary
// socket's ping on either transport gets no pong. The failure names the seed,
// the request-link state and the batch, and lists the frames of that batch and
// of the one before it, since the backstop's line can reach this process after
// the next batch's checks have started.
//
// A seed that fails is a way to stop the server from the internet. Report it
// privately, as SECURITY.md describes, and never in an issue, a pull request,
// a commit or a CI log.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { roomIdFromToken } = require('./hosttoken');

const SERVER = require.resolve('./server.js');

const DEFAULT_SEED = 1;
const SMOKE_FRAMES = 5000;
const LONG_RUN_FRAMES = 20000;

// Stated again here rather than read from server.js, which this file never
// requires: a change to one of them should be a change someone makes here too.
const SIGNAL_MAX_CHARS = 64 * 1024; // server.js
const SIGNAL_MAX_DEPTH = 8; // server.js
const MAX_PAYLOAD = 1e6; // server.js: wss maxPayload and Socket.IO maxHttpBufferSize
const REQUEST_JOINS_PER_MINUTE = 30; // server.js, per socket
const MAX_CONNECTIONS_PER_IP = 30; // server.js default, left as it is
const REQUEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000; // server.js

// How long any one wait may take before the batch fails.
const WAIT_MS = 5000;

// The reply types a long run must reach, per state and transport. Each is one
// the generator aims at many times in 20,000 frames, so a long run that misses
// one has stopped reaching that path. The smoke asserts none of them: which
// replies a short run reaches depends on timing at the edges (a drop the
// server has not seen yet), and the smoke must not flake.
const LONG_RUN_REPLIES = {
    on: {
        ws: [
            'no reply', 'pong', 'room-joined', 'user-connected', 'signal', 'peer-disconnected', 'room-full',
            'error: Invalid room ID', 'error: Invalid host token', 'request-joined', 'host-absent', 'link-ended',
            'close 1007', 'close 1008', 'close 1009',
        ],
        sio: [
            'no reply', 'ack', 'room-joined', 'user-connected', 'signal', 'peer-disconnected', 'room-full',
            'error: Invalid room ID', 'request-joined', 'host-absent', 'connect_error', 'close 1009',
        ],
    },
    off: {
        ws: [
            'no reply', 'pong', 'room-joined', 'user-connected', 'signal', 'peer-disconnected', 'room-full',
            'error: Invalid room ID', 'error: Invalid host token', 'refused: disabled', 'disabled',
            'close 1007', 'close 1008', 'close 1009',
        ],
        sio: [
            'no reply', 'ack', 'room-joined', 'user-connected', 'signal', 'peer-disconnected', 'room-full',
            'error: Invalid room ID', 'disabled', 'connect_error', 'close 1009',
        ],
    },
};

// The frame kinds every run sends, on each transport: every /ws type in the
// server's switch, the bare null from #441, and every Socket.IO event. The
// generator decides what is sent, so this holds for a seed or it never does.
const REQUIRED_KINDS = {
    ws: [
        'join-room', 'join-room+hostToken', 'request-join', 'request-seal', 'request-reopen', 'request-close',
        'signal', 'ping', 'null',
    ],
    sio: ['ping', 'ping+ack', 'join-room', 'request-join', 'signal'],
};

// An empty value reads as unset; anything else must be a whole number in range.
function settingFromEnv(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
        throw new Error(`${name} must be a whole number from ${min} to ${max}, not ${JSON.stringify(raw)}`);
    }
    return n;
}

const SEED = settingFromEnv('FLOE_SERVER_FUZZ_SEED', DEFAULT_SEED, 0, 0xffffffff);
const FRAMES = settingFromEnv('FLOE_SERVER_FUZZ_FRAMES', SMOKE_FRAMES, 1, Number.MAX_SAFE_INTEGER);
const LONG_RUN = FRAMES >= LONG_RUN_FRAMES;

// --- harness, copied from crashguard.test.js -----------------------------------
//
// Copied rather than required: loading a test file registers its tests, so
// this run would run the whole crash-guard suite a second time.

const openSockets = new Set();
const children = new Set();

function track(sock) {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
    return sock;
}

test.after(() => {
    for (const s of openSockets) { try { s.terminate(); } catch { /* already gone */ } }
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
});

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

async function startServer(extraEnv = {}, { cwd = __dirname } = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PORT: String(port),
            UPSTASH_REDIS_REST_URL: '',
            UPSTASH_REDIS_REST_TOKEN: '',
            TRUSTED_PROXY_COUNT: '1',
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

// No relay source at all, so nothing this run does can reach Cloudflare or a
// coturn with whatever the parent environment or server/.env holds.
const NO_RELAY = {
    CLOUDFLARE_TURN_KEY_ID: '',
    CLOUDFLARE_TURN_KEY_API_TOKEN: '',
    TURN_SECRET: '',
    TURN_DOMAIN: '',
};

// A file saying false, rather than no POLICY_FILE, keeps the off run off even
// when a local server/.env names a policy file.
function policyFileSaying(t, on) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floe-fuzz-policy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ requestLinks: on }));
    return file;
}

// Smallest depth at which JSON.stringify overflows the stack on this runtime,
// found by doubling (see crashguard.test.js for why it is measured).
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

// crashguard.test.js asserts that the overflow is there; here a runtime whose
// JSON.stringify no longer overflows (Node 26 made it iterative) still gets a
// nest that deep, a 512 KiB frame, rather than no run at all.
function hostileRoomIds() {
    const depth = stringifyOverflowDepth() || 131072;
    return [
        'null',
        '1',
        '{}',
        '['.repeat(depth * 2) + ']'.repeat(depth * 2),
        JSON.stringify('a'.repeat(900 * 1024)),
    ];
}

// --- the seeded generator -------------------------------------------------------

// mulberry32: 32 bits of state, a few lines, and the same sequence for a seed
// on every platform. Not for secrets; nothing here is one.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Every value a batch holds comes from here: frames, room ids, host tokens and
// addresses. Nothing is read back from a reply, so a seed decides every frame
// on its own, and the frames can be built, sent and dropped one batch at a time.
class Draw {
    constructor(seed) {
        this.next = mulberry32(seed);
        this.actors = 0;
    }

    int(n) { return Math.floor(this.next() * n); }
    between(lo, hi) { return lo + this.int(hi - lo + 1); }
    chance(p) { return this.next() < p; }
    pick(list) { return list[this.int(list.length)]; }

    // [weight, value] pairs.
    weighted(pairs) {
        let total = 0;
        for (const [w] of pairs) total += w;
        let x = this.next() * total;
        for (const [w, v] of pairs) {
            if ((x -= w) < 0) return v;
        }
        return pairs[pairs.length - 1][1];
    }

    bytes(n) {
        const b = Buffer.alloc(n);
        for (let i = 0; i < n; i++) b[i] = this.int(256);
        return b;
    }

    // A UUID of version 4, the shape every room id has.
    uuid() {
        const h = this.bytes(16);
        h[6] = (h[6] & 0x0f) | 0x40;
        h[8] = (h[8] & 0x3f) | 0x80;
        const x = h.toString('hex');
        return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
    }

    // A host token as Floe Desktop draws one: 32 bytes, base64url, 43 characters.
    token() {
        return this.bytes(32).toString('base64url');
    }

    // An address of the actor's own, as one X-Forwarded-For hop names it, so
    // no two actors share a connection budget. Numbered, never reused in a
    // run; a quarter are IPv6, which the server keys by /64.
    address() {
        const n = ++this.actors;
        if (this.chance(0.25)) {
            return `2001:db8:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}::${(1 + this.int(0xfffe)).toString(16)}`;
        }
        return `10.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
}

// The values too big to build per frame, built once per process and shared by
// every frame that carries them, so a long run never holds more than one
// batch's own small strings.
let bigValues = null;
function big() {
    if (bigValues) return bigValues;
    const ids = hostileRoomIds();
    bigValues = {
        overflow: ids[3], // the nested-array signal from #441, past JSON.stringify's stack
        id900k: ids[4],
        filler: 'a'.repeat(MAX_PAYLOAD + 64),
    };
    return bigValues;
}

function nest(depth, open, close, inner = '0') {
    return open.repeat(depth) + inner + close.repeat(depth);
}

// A JSON string about `chars` long as signalFits counts it, written with
// `unit`: a plain character counts one, an escaped quote six.
function sizedString(chars, unit = 'a', unitChars = 1) {
    return `"${unit.repeat(Math.max(0, Math.floor((chars - 2) / unitChars)))}"`;
}

const SCALARS = ['null', 'true', 'false', '0', '-0', '1', '-1', '1.5', '9e20', '1e309', '-1e309', '9007199254740993', '""'];
const STRINGS = [
    '"x"', '"null"', '"__proto__"', '"constructor"', '"prototype"', '"toString"', '"hasOwnProperty"',
    '"\\ud800"', '"\\udc00\\ud800"', '"a\\ud83d"', '"\\u0000"', '"\\n"', '"\\u2028"',
];
const OBJECTS = [
    '{}', '[]', '[[]]', '[null]', '{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}',
    '{"__proto__":null}', '{"length":1e9}', '{"toLowerCase":"x"}', '{"0":1,"length":1}', '{"type":"offer","sdp":"v=0"}',
    '{"__proto__":[],"constructor":"x"}',
];

// One hostile value as JSON text, for any field the server reads. ctx holds the
// batch's own room id and host token, so the near-misses are near the real thing.
function hostileValue(d, ctx) {
    const kind = d.weighted([
        [3, 'scalar'], [3, 'string'], [3, 'uuid'], [2, 'token'], [3, 'object'], [3, 'nest'], [2, 'overflow'], [2, 'size'],
    ]);
    switch (kind) {
        case 'scalar': return d.pick(SCALARS);
        case 'string': return d.pick(STRINGS);
        case 'uuid': {
            const id = d.chance(0.5) ? ctx.id : d.uuid();
            return d.pick([
                JSON.stringify(id.toUpperCase()), JSON.stringify(`${id} `), JSON.stringify(` ${id}`),
                JSON.stringify(id.slice(1)), JSON.stringify(`${id}0`), JSON.stringify(id.replace(/-/g, '')),
                JSON.stringify([id]), JSON.stringify({ roomId: id }), `"${id.slice(0, 35)}\\ud800"`,
                JSON.stringify(id), JSON.stringify(d.uuid()),
            ]);
        }
        case 'token': {
            const token = d.chance(0.5) ? ctx.token : d.token();
            return d.pick([
                JSON.stringify(token), JSON.stringify(token.slice(1)), JSON.stringify(`${token}A`),
                JSON.stringify(`+${token.slice(1)}`), JSON.stringify(`/${token.slice(1)}`), `"${token.slice(0, 42)}\\ud800"`,
                JSON.stringify([token]), JSON.stringify({ hostToken: token }),
            ]);
        }
        case 'object': return d.pick(OBJECTS);
        case 'nest': {
            const depth = d.pick([SIGNAL_MAX_DEPTH - 1, SIGNAL_MAX_DEPTH, SIGNAL_MAX_DEPTH + 1, 64, 1000]);
            return d.chance(0.5) ? nest(depth, '[', ']') : nest(depth, '{"__proto__":', '}', '{}');
        }
        case 'overflow': return big().overflow;
        case 'size': {
            const at = SIGNAL_MAX_CHARS + d.between(-12, 4);
            return d.pick([
                sizedString(at),
                `{"sdp":${sizedString(at - 10)}}`,
                sizedString(at, '\\"', 6),
                big().id900k,
            ]);
        }
    }
    throw new Error(`unknown value kind ${kind}`);
}

// The field's own value most of the time, so the stateful paths are reached,
// and a hostile one otherwise.
function field(d, ctx, valid, pHostile = 0.25) {
    return d.chance(pHostile) ? hostileValue(d, ctx) : valid;
}

const ENDS_IN = ['0', '-1', '1.5', '1e20', '"60000"', 'null', '{}', String(REQUEST_MAX_AGE_MS + 1), '9007199254740993'];

function endsIn(d) {
    if (d.chance(0.3)) return '';
    const v = d.chance(0.6) ? String(1 + d.int(REQUEST_MAX_AGE_MS)) : d.pick(ENDS_IN);
    return `,"endsIn":${v}`;
}

// A plain signal, the shape the clients send, or a hostile one.
function signalValue(d, ctx, pHostile = 0.35) {
    if (d.chance(pHostile)) return hostileValue(d, ctx);
    return d.pick([
        `{"type":"offer","sdp":"v=0 ${d.int(1e9)}"}`,
        `{"type":"answer","sdp":"v=0 ${d.int(1e9)}"}`,
        `{"candidate":{"candidate":"candidate:${d.int(1e6)} 1 udp 1 10.0.0.1 ${d.int(65536)} typ host","sdpMid":"0"}}`,
        '{"renegotiate":true}',
    ]);
}

// The target, when there is one, is compared and never stored: only hostile
// values, since a real one is a server-made peer id no frame can know.
function targetField(d, ctx) {
    return d.chance(0.25) ? `,"target":${hostileValue(d, ctx)}` : '';
}

// A text frame padded to `total` bytes with its last field: a frame of exactly
// 1e6 bytes is read, one byte more closes the socket with 1009.
function paddedFrame(prefix, suffix, total) {
    return prefix + big().filler.slice(0, total - prefix.length - suffix.length) + suffix;
}

function oversizeTotal(d) {
    return d.pick([MAX_PAYLOAD - d.int(64), MAX_PAYLOAD, MAX_PAYLOAD + 1, MAX_PAYLOAD + 1 + d.int(64)]);
}

// --- /ws frames -------------------------------------------------------------------

// One /ws frame of a given kind. A frame is { kind, data, mode }: data is the
// text or bytes on the wire, and mode is 'text', 'binary', or 'raw' (bytes
// sent as a text frame, for invalid UTF-8).
function wsFrame(d, ctx, kind) {
    const id = () => field(d, ctx, JSON.stringify(d.chance(0.8) ? ctx.id : ctx.id.toUpperCase()));
    switch (kind) {
        case 'join-room':
            return text(kind, `{"type":"join-room","roomId":${id()}}`);
        case 'join-room+hostToken':
            return text(kind, `{"type":"join-room","roomId":${id()},"hostToken":${field(d, ctx, JSON.stringify(ctx.token))}${endsIn(d)}}`);
        case 'request-join':
            return text(kind, `{"type":"request-join","roomId":${id()}}`);
        case 'request-seal':
        case 'request-reopen':
        case 'request-close':
            return text(kind, `{"type":"${kind}","roomId":${id()}}`);
        case 'signal':
            return text(kind, `{"type":"signal","signal":${signalValue(d, ctx)}${targetField(d, ctx)}}`);
        case 'ping':
            return text(kind, d.pick(['{"type":"ping"}', `{"type":"ping","roomId":${hostileValue(d, ctx)}}`]));
        case 'null':
            return text(kind, 'null');
        case 'scalar':
            return text(kind, d.pick([...SCALARS.filter((s) => s !== 'null'), ...STRINGS, '[]', '[{"type":"ping"}]', '[null]']));
        case 'malformed':
            return text(kind, d.pick([
                '', ' ', '{', '}', '{"type":"join-room"', '{"type":}', '{type:"ping"}', "{'type':'ping'}", 'undefined',
                'NaN', '{"type":"ping"}{"type":"ping"}', '\u0000', '{"type":"ping",}', `{"type":"signal","signal":${'['.repeat(100)}`,
            ]));
        case 'no-type':
            return text(kind, d.pick([
                `{"roomId":${id()}}`, `{"signal":${signalValue(d, ctx)}}`, '{}', '{"__proto__":{"type":"ping"}}',
                `{"constructor":{"type":"join-room"},"roomId":${id()}}`,
            ]));
        case 'unknown-type':
            return text(kind, `{"type":${d.pick([
                '"__proto__"', '"constructor"', '"toString"', '"hasOwnProperty"', '"PING"', '"join-room "', '"request-"',
                '["ping"]', 'null', '1', '{"toString":"ping"}', '"pong"', '"error"', '"room-joined"', '"user-connected"',
            ])},"roomId":${id()}}`);
        case 'binary':
            // ws hands the server a Buffer, which JSON.parse reads as text.
            const inner = wsFrame(d, ctx, d.pick(['ping', 'join-room', 'request-join', 'signal', 'null']));
            return { kind, data: Buffer.from(inner.data), mode: 'binary' };
        case 'invalid-utf8':
            // Continuation bytes (0x80 to 0xbf) with no lead byte: never UTF-8,
            // so ws closes the socket with 1007 before the server reads it.
            const stray = d.bytes(1 + d.int(4)).map((b) => 0x80 | (b & 0x3f));
            return { kind, data: Buffer.concat([Buffer.from('{"type":"ping","x":"'), stray, Buffer.from('"}')]), mode: 'raw' };
        case 'oversize': {
            const total = oversizeTotal(d);
            const type = d.pick(['signal', 'join-room', 'request-join', 'ping']);
            const key = type === 'signal' ? 'signal' : 'roomId';
            return text(kind, paddedFrame(`{"type":"${type}","${key}":"`, '"}', total));
        }
    }
    throw new Error(`unknown /ws frame kind ${kind}`);

    function text(k, data) { return { kind: k, data, mode: 'text' }; }
}

// A /ws frame of any kind, the way a lone socket of mixed frames draws them.
function anyWsFrame(d, ctx) {
    return wsFrame(d, ctx, d.weighted([
        [3, 'join-room'], [2, 'join-room+hostToken'], [3, 'request-join'], [1, 'request-seal'], [1, 'request-reopen'],
        [1, 'request-close'], [3, 'signal'], [2, 'ping'], [2, 'null'], [2, 'scalar'], [2, 'malformed'], [2, 'no-type'],
        [2, 'unknown-type'], [1, 'binary'], [0.5, 'invalid-utf8'], [0.3, 'oversize'],
    ]));
}

// --- Socket.IO frames -------------------------------------------------------------
//
// Raw Socket.IO v4 packets over a bare engine.io websocket, no client library:
// '42' is an event, '42<id>' one that asks for an ack ('43<id>'), '45<n>-' a
// binary event whose n attachments follow as binary frames.

function sioFrame(d, ctx, kind) {
    const id = () => field(d, ctx, JSON.stringify(d.chance(0.8) ? ctx.id : ctx.id.toUpperCase()));
    switch (kind) {
        case 'ping':
            return text(kind, '42["ping"]');
        case 'ping+ack':
            // Ack ids below 1e6; the fences use their own from 1e9 up.
            return text(kind, d.pick([`42${d.int(1e6)}["ping"]`, `42${d.int(1e6)}["ping",${hostileValue(d, ctx)}]`]));
        case 'join-room':
            return text(kind, `42["join-room",${id()}]`);
        case 'request-join':
            return text(kind, `42["request-join",${id()}]`);
        case 'signal':
            return text(kind, d.chance(0.85)
                ? `42["signal",{"signal":${signalValue(d, ctx)}${targetField(d, ctx)}}]`
                : `42["signal",${hostileValue(d, ctx)}]`);
        case 'arity':
            return text(kind, d.pick([
                '42["join-room"]', '42["request-join"]', '42["signal"]', `42["join-room",${id()},${hostileValue(d, ctx)}]`,
                `42["request-join",${id()},${id()}]`, `42["signal",{"signal":${signalValue(d, ctx)}},1]`,
            ]));
        case 'unknown-event':
            return text(kind, `42[${d.pick([
                '"__proto__"', '"constructor"', '"toString"', '"hasOwnProperty"', '"PING"', '"request-seal"', '"request-close"',
                '"pong"', '"error"', '1', '0',
            ])},${id()}]`);
        case 'reserved-event':
            return text(kind, `42[${d.pick([
                '"disconnect"', '"disconnecting"', '"connect"', '"connect_error"', '"newListener"', '"removeListener"',
            ])}]`);
        case 'malformed':
            return text(kind, d.pick([
                '42[', '42{}', '42"x"', '42null', '42[]', '4', '9', '42abc[]', '43[]', '431[]', '40', '4x', '', '2', '3', '6',
                '42-1["ping"]', '42 ["ping"]', '45["ping"]', '41/nope,',
            ]));
        case 'binary': {
            const n = d.between(1, 2);
            const payload = d.pick([
                `{"signal":{"_placeholder":true,"num":0}}`,
                `{"_placeholder":true,"num":0}`,
                `{"signal":{"_placeholder":true,"num":${d.pick([1, 5, -1, '"0"', 'null'])}}}`,
                `{"signal":${nest(d.pick([SIGNAL_MAX_DEPTH, 64, 1000]), '[', ']', '{"_placeholder":true,"num":0}')}}`,
            ]);
            const event = d.pick(['signal', 'signal', 'join-room', 'request-join']);
            const attachments = [];
            for (let i = 0; i < n; i++) attachments.push(d.bytes(d.int(64)));
            return { kind, data: `45${n}-["${event}",${payload}]`, mode: 'text', attachments };
        }
        case 'oversize': {
            const total = oversizeTotal(d);
            const event = d.pick(['signal', 'join-room', 'request-join']);
            return event === 'signal'
                ? text(kind, paddedFrame('42["signal",{"signal":"', '"}]', total))
                : text(kind, paddedFrame(`42["${event}","`, '"]', total));
        }
    }
    throw new Error(`unknown Socket.IO frame kind ${kind}`);

    function text(k, data) { return { kind: k, data, mode: 'text' }; }
}

function anySioFrame(d, ctx) {
    return sioFrame(d, ctx, d.weighted([
        [2, 'ping'], [2, 'ping+ack'], [3, 'join-room'], [3, 'request-join'], [3, 'signal'], [1, 'arity'],
        [1, 'unknown-event'], [0.5, 'reserved-event'], [1, 'malformed'], [1, 'binary'], [0.3, 'oversize'],
    ]));
}

// --- batches ------------------------------------------------------------------------
//
// A batch is a scenario: 1 to 4 actors, each a socket on one transport at an
// address of its own, and the steps they take. A step sends one frame, drops
// the actor's socket (the next step opens a fresh one), or opens a crowd.

// The most steps one actor takes in a batch. Every step can cost a connection
// (a drop, or a frame the server closes the socket on), and an actor must stay
// under its address's MAX_CONNECTIONS_PER_IP a minute.
const MAX_ACTOR_STEPS = MAX_CONNECTIONS_PER_IP - 2;

class Batch {
    constructor(d, n, scenario) {
        this.d = d;
        this.n = n;
        this.scenario = scenario;
        this.actors = [];
        this.steps = [];
        this.frames = 0;
        // Each actor's request-joins on its current socket and steps in all,
        // known to the generator alone.
        this.joins = [];
        this.taken = [];
        this.rotate = true;
    }

    actor(transport) {
        this.actors.push({ transport, address: this.d.address() });
        this.joins.push(0);
        this.taken.push(0);
        return this.actors.length - 1;
    }

    full(a) { return this.taken[a] >= MAX_ACTOR_STEPS; }

    send(a, frame) {
        if (this.full(a)) return;
        // A fresh socket before the per-socket request-join budget is spent,
        // except in the batch that is there to spend it.
        if (frame.kind === 'request-join') {
            if (this.rotate && this.joins[a] >= REQUEST_JOINS_PER_MINUTE) this.drop(a, 'rotate');
            this.joins[a]++;
        }
        this.steps.push({ a, op: 'send', ...frame });
        this.frames++;
        this.taken[a]++;
    }

    drop(a, how) {
        this.steps.push({ a, op: 'drop', how: how || this.d.pick(this.actors[a].transport === 'ws'
            ? ['close', 'terminate']
            : ['close', 'terminate', 'namespace', 'engine']) });
        this.joins[a] = 0;
        this.taken[a]++;
    }

    frame(a, ctx, kind) {
        return this.actors[a].transport === 'ws' ? wsFrame(this.d, ctx, kind) : sioFrame(this.d, ctx, kind);
    }

    any(a, ctx) {
        return this.actors[a].transport === 'ws' ? anyWsFrame(this.d, ctx) : anySioFrame(this.d, ctx);
    }
}

function transport(d) {
    return d.chance(0.5) ? 'ws' : 'sio';
}

// Two sockets in one ordinary room, on any mix of transports: join, signal,
// drop mid-sequence and join again, with a third and fourth now and then.
function pairBatch(d, n) {
    const b = new Batch(d, n, 'pair');
    const ctx = { id: d.uuid(), token: d.token() };
    const actors = [b.actor(transport(d)), b.actor(transport(d))];
    for (let i = d.int(3); i > 0 && d.chance(0.4); i--) actors.push(b.actor(transport(d)));
    b.send(actors[0], b.frame(actors[0], ctx, 'join-room'));
    b.send(actors[1], b.frame(actors[1], ctx, 'join-room'));
    for (let i = d.between(4, 24); i > 0; i--) {
        const a = d.pick(actors);
        const op = d.weighted([[6, 'signal'], [2, 'join'], [1, 'drop'], [3, 'any']]);
        if (op === 'signal') b.send(a, b.frame(a, ctx, 'signal'));
        else if (op === 'join') b.send(a, b.frame(a, ctx, 'join-room'));
        else if (op === 'drop') b.drop(a);
        else b.send(a, b.any(a, ctx));
    }
    return b;
}

// A request link: a /ws host holding a valid token and visitors on either
// transport. Often the whole drop first (seated, both signal so the room
// seals, then seal and one of close, reopen or a host drop and reclaim), and
// then anything in any order.
function requestBatch(d, n) {
    const b = new Batch(d, n, 'request');
    const token = d.token();
    const ctx = { id: roomIdFromToken(token), token };
    const host = b.actor('ws');
    const visitors = [];
    for (let i = d.between(1, 3); i > 0; i--) visitors.push(b.actor(transport(d)));
    const control = (type, who = host) => b.send(who, b.frame(who, ctx, type));
    const hostJoin = () => b.send(host, b.frame(host, ctx, 'join-room+hostToken'));
    const visitorJoin = (v) => b.send(v, b.frame(v, ctx, d.chance(0.9) ? 'request-join' : 'join-room'));
    const signal = (who) => b.send(who, b.frame(who, ctx, 'signal'));

    hostJoin();
    if (d.chance(0.6)) {
        visitorJoin(visitors[0]);
        signal(host);
        signal(visitors[0]);
        control('request-seal');
        const end = d.pick(['request-close', 'request-reopen', 'reclaim']);
        if (end === 'reclaim') {
            b.drop(host);
            hostJoin();
        } else {
            control(end);
        }
    }
    for (let i = d.between(3, 16); i > 0; i--) {
        const v = d.pick(visitors);
        const op = d.weighted([
            [3, 'visitor-join'], [3, 'signal'], [1, 'seal'], [1, 'reopen'], [1, 'close'], [1, 'reclaim'],
            [1, 'host-drop'], [1, 'visitor-drop'], [1, 'stray-control'], [2, 'any'],
        ]);
        if (op === 'visitor-join') visitorJoin(v);
        else if (op === 'signal') signal(d.chance(0.5) ? host : v);
        else if (op === 'seal') control('request-seal');
        else if (op === 'reopen') control('request-reopen');
        else if (op === 'close') control('request-close');
        else if (op === 'reclaim') hostJoin();
        else if (op === 'host-drop') b.drop(host);
        else if (op === 'visitor-drop') b.drop(v);
        else if (op === 'stray-control') {
            // A control from a visitor (silent over /ws, an unknown event over
            // Socket.IO), or the host's with another link's id.
            const type = d.pick(['request-seal', 'request-reopen', 'request-close']);
            if (d.chance(0.5)) b.send(v, b.frame(v, ctx, b.actors[v].transport === 'ws' ? type : 'unknown-event'));
            else b.send(host, b.frame(host, { id: d.uuid(), token: ctx.token }, type));
        } else {
            const who = d.chance(0.3) ? host : v;
            b.send(who, b.any(who, ctx));
        }
    }
    return b;
}

// One socket of mixed frames.
function loneBatch(d, n) {
    const b = new Batch(d, n, 'lone');
    const ctx = { id: d.uuid(), token: d.token() };
    const a = b.actor(transport(d));
    for (let i = d.between(5, MAX_ACTOR_STEPS); i > 0; i--) {
        if (d.chance(0.05)) b.drop(a);
        else b.send(a, b.any(a, ctx));
    }
    return b;
}

// One socket past the request-join budget: the frames after the 30th get no
// reply at all, and the socket keeps working.
function budgetBatch(d, n) {
    const b = new Batch(d, n, 'budget');
    b.rotate = false;
    const ctx = { id: d.uuid(), token: d.token() };
    const a = b.actor(transport(d));
    for (let i = REQUEST_JOINS_PER_MINUTE + d.between(1, 4); i > 0; i--) {
        b.steps.push({ a, op: 'send', ...b.frame(a, ctx, 'request-join') });
        b.frames++;
    }
    b.send(a, b.frame(a, ctx, d.pick(['ping', 'join-room'])));
    return b;
}

// One more connection from one address than a minute allows: the last is
// refused, with 1008 on /ws and a connect error on Socket.IO.
function crowdBatch(d, n) {
    const b = new Batch(d, n, 'crowd');
    const a = b.actor(transport(d));
    b.steps.push({ a, op: 'crowd', count: MAX_CONNECTIONS_PER_IP + 1 });
    return b;
}

function makeBatch(d, n) {
    const scenario = d.weighted([[36, 'pair'], [36, 'request'], [18, 'lone'], [6, 'budget'], [4, 'crowd']]);
    if (scenario === 'pair') return pairBatch(d, n);
    if (scenario === 'request') return requestBatch(d, n);
    if (scenario === 'lone') return loneBatch(d, n);
    if (scenario === 'budget') return budgetBatch(d, n);
    return crowdBatch(d, n);
}

// The batches of a run, one at a time, until `frames` frames have been drawn.
function* batches(seed, frames) {
    const d = new Draw(seed);
    let drawn = 0;
    for (let n = 1; drawn < frames; n++) {
        const b = makeBatch(d, n);
        drawn += b.frames;
        yield b;
    }
}

// What a step puts on the wire, for the digest a run prints.
function digestStep(hash, b, step) {
    const actor = b.actors[step.a];
    hash.update(`${b.n}|${step.a}|${actor.transport}|${actor.address}|${step.op}|${step.kind || step.how || step.count}|${step.mode || ''}|`);
    if (step.data !== undefined) hash.update(step.data);
    for (const att of step.attachments || []) hash.update(att);
    hash.update('\n');
}

// A step as a failure lists it: never the whole of a 1 MB frame.
function describeStep(b, step) {
    const actor = b.actors[step.a];
    const who = `actor ${step.a} (${actor.transport === 'ws' ? '/ws' : 'Socket.IO'}, ${actor.address})`;
    if (step.op === 'drop') return `${who}: drop (${step.how})`;
    if (step.op === 'crowd') return `${who}: ${step.count} connections`;
    const shown = Buffer.isBuffer(step.data) ? `<${step.mode} ${step.data.toString('hex').slice(0, 80)}>` : JSON.stringify(step.data.slice(0, 120));
    const att = step.attachments ? ` + ${step.attachments.length} attachment(s)` : '';
    const size = `${step.data.length} ${Buffer.isBuffer(step.data) ? 'bytes' : 'chars'}`;
    return `${who}: ${step.kind}, ${size}${att}: ${shown}${step.data.length > 120 ? '...' : ''}`;
}

function describeBatch(b) {
    if (!b) return '(none)';
    return [`batch ${b.n} (${b.scenario}):`, ...b.steps.map((s, i) => `  ${i + 1}. ${describeStep(b, s)}`)].join('\n');
}

// --- connections --------------------------------------------------------------------

// A reply as the coverage report counts it: the type, and for an error or a
// refusal the server's fixed message or code.
function replyName(type, data) {
    if (type === 'error' && data && typeof data.message === 'string') return `error: ${data.message}`;
    if (type === 'refused' && data && typeof data.code === 'string') return `refused: ${data.code}`;
    return String(type);
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms ${what}`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

// One /ws socket. Its fence is a WebSocket ping frame, which ws answers after
// every frame read before it, and which no frame of the grammar can be
// mistaken for: an app-level {"type":"ping"} is part of the grammar.
class WsConn {
    constructor(ws) {
        this.ws = ws;
        this.transport = 'ws';
        this.inbox = [];
        this.closeCode = null;
        this.fences = new Map();
        this.nextFence = 0;
        this.closed = new Promise((resolve) => {
            ws.on('close', (code) => {
                this.closeCode = code;
                for (const done of this.fences.values()) done('closed');
                this.fences.clear();
                resolve();
            });
        });
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { this.inbox.push('unparsable'); return; }
            this.inbox.push(msg && typeof msg === 'object' ? replyName(msg.type, msg) : 'unparsable');
        });
        ws.on('pong', (data) => {
            const done = this.fences.get(data.toString());
            if (done) { this.fences.delete(data.toString()); done('ok'); }
        });
    }

    static open(srv, address) {
        const ws = connect(`ws://127.0.0.1:${srv.port}/ws`, { 'X-Forwarded-For': address });
        return withTimeout(new Promise((resolve, reject) => {
            ws.once('open', () => resolve(new WsConn(ws)));
            ws.once('close', () => reject(new Error('a /ws connection closed before it opened')));
        }), WAIT_MS, 'for a /ws connection to open').catch((err) => { ws.terminate(); throw err; });
    }

    get open() { return this.ws.readyState === WebSocket.OPEN; }

    send(step) {
        if (step.mode === 'binary') this.ws.send(step.data, { binary: true });
        else if (step.mode === 'raw') this.ws.send(step.data, { binary: false });
        else this.ws.send(step.data);
    }

    // Resolves 'ok' once the server has read everything sent before it, or
    // 'closed' when the socket closes first; rejects when neither comes.
    fence() {
        if (this.closeCode !== null) return Promise.resolve('closed');
        if (!this.open) return withTimeout(this.closed.then(() => 'closed'), WAIT_MS, 'for a closing /ws socket to close');
        const id = String(this.nextFence++);
        const answered = new Promise((resolve) => this.fences.set(id, resolve));
        this.ws.ping(id);
        return withTimeout(answered, WAIT_MS, 'for a /ws socket to answer a ping frame');
    }

    async drop(how) {
        if (how === 'terminate') this.ws.terminate();
        else this.ws.close(1000);
        await withTimeout(this.closed, WAIT_MS, 'for a dropped /ws socket to close').catch(() => this.ws.terminate());
    }

    release() { reset(this.ws); }
}

// One Socket.IO socket over a bare engine.io websocket. '0' is engine.io's
// open, answered with '40' to connect the default namespace, which the server
// acks with '40' or refuses with '44'. '2' is the server's ping, answered '3'.
// Its fence is a ping event with an ack id of its own, from 1e9 up.
class SioConn {
    constructor(ws) {
        this.ws = ws;
        this.transport = 'sio';
        this.inbox = [];
        this.closeCode = null;
        this.fences = new Map();
        this.nextFence = 1e9;
        this.namespace = null; // 'connected' or 'refused', once the server says
        this.closed = new Promise((resolve) => {
            ws.on('close', (code) => {
                this.closeCode = code;
                for (const done of this.fences.values()) done('closed');
                this.fences.clear();
                resolve();
            });
        });
        this.answered = new Promise((resolve) => { this.onNamespace = resolve; });
        ws.on('message', (raw, isBinary) => this.read(raw, isBinary));
    }

    read(raw, isBinary) {
        if (isBinary) { this.inbox.push('binary'); return; }
        const text = raw.toString();
        if (text.startsWith('0')) { this.ws.send('40'); return; }
        if (text === '2') { this.ws.send('3'); return; }
        if (text.startsWith('40')) { this.namespace = 'connected'; this.onNamespace(); return; }
        if (text.startsWith('44')) {
            this.namespace = 'refused';
            this.inbox.push('connect_error');
            this.onNamespace();
            return;
        }
        if (text.startsWith('41')) { this.inbox.push('disconnect'); return; }
        const ack = /^43(\d+)/.exec(text);
        if (ack) {
            const done = this.fences.get(ack[1]);
            if (done) { this.fences.delete(ack[1]); done('ok'); } else this.inbox.push('ack');
            return;
        }
        const event = /^42\d*(\[[\s\S]*)$/.exec(text);
        if (event) {
            try {
                const [type, data] = JSON.parse(event[1]);
                this.inbox.push(replyName(type, data));
            } catch { this.inbox.push('unparsable'); }
            return;
        }
        this.inbox.push(`engine.io ${text.slice(0, 1)}`);
    }

    // Resolves once the namespace answered, with 'connected' or 'refused'.
    static open(srv, address) {
        const ws = connect(`ws://127.0.0.1:${srv.port}/socket.io/?EIO=4&transport=websocket`, {
            Origin: 'http://localhost:3000',
            'X-Forwarded-For': address,
        });
        const conn = new SioConn(ws);
        return withTimeout(Promise.race([
            conn.answered.then(() => conn),
            conn.closed.then(() => { throw new Error('a Socket.IO connection closed before its namespace answered'); }),
        ]), WAIT_MS, 'for a Socket.IO namespace to answer').catch((err) => { ws.terminate(); throw err; });
    }

    get open() { return this.ws.readyState === WebSocket.OPEN && this.namespace === 'connected'; }

    send(step) {
        this.ws.send(step.data);
        for (const att of step.attachments || []) this.ws.send(att, { binary: true });
    }

    fence() {
        if (this.closeCode !== null) return Promise.resolve('closed');
        if (!this.open) {
            // Closing already, or the server left the namespace ('41').
            reset(this.ws);
            return withTimeout(this.closed.then(() => 'closed'), WAIT_MS, 'for a closing Socket.IO socket to close');
        }
        const id = String(this.nextFence++);
        const answered = new Promise((resolve) => this.fences.set(id, resolve));
        this.ws.send(`42${id}["ping"]`);
        return withTimeout(answered, WAIT_MS, 'for a Socket.IO socket to ack a ping');
    }

    async drop(how) {
        if (how === 'terminate') this.ws.terminate();
        else if (how === 'namespace') this.ws.send('41');
        else {
            // engine.io's own close packet first, when that is the drop: on its
            // own the server takes seconds to act on it, and a graceful close
            // still delivers it ahead of the close frame.
            if (how === 'engine') this.ws.send('1');
            this.ws.close(1000);
        }
        await withTimeout(this.closed, WAIT_MS, 'for a dropped Socket.IO socket to close').catch(() => this.ws.terminate());
    }

    release() { reset(this.ws); }
}

// The times of the closes in the last TIME_WAIT_WINDOW_MS that left a
// TIME_WAIT, oldest first. At TIME_WAIT_BUDGET a new connection waits for the
// oldest to leave the window: well inside every platform's default ephemeral
// range even at Windows' 120 s, and a smoke never comes near it.
const TIME_WAIT_WINDOW_MS = 60000;
const TIME_WAIT_BUDGET = 6000;
const closes = [];

async function pace() {
    for (;;) {
        const now = Date.now();
        while (closes.length && now - closes[0] >= TIME_WAIT_WINDOW_MS) closes.shift();
        if (closes.length < TIME_WAIT_BUDGET) return;
        await new Promise((r) => setTimeout(r, closes[0] + TIME_WAIT_WINDOW_MS - now));
    }
}

// A WebSocket whose TCP socket this file holds, for reset below.
function connect(url, headers) {
    let socket = null;
    const ws = track(new WebSocket(url, {
        headers,
        createConnection: (opts) => (socket = net.connect({ host: opts.host, port: opts.port })),
    }));
    ws.on('error', () => {});
    ws.on('close', () => { if (!ws.wasReset) closes.push(Date.now()); });
    ws.tcp = () => socket;
    return ws;
}

// Every socket the run is done with ends in a TCP reset, which leaves no
// TIME_WAIT on either side. A close by either side leaves one for 30 s
// (macOS), 60 s (Linux) or 120 s (Windows), and a long run opens hundreds of
// connections a second: on macOS, with every finished socket closed, the
// 16,384 ephemeral ports were gone about 10 s into a 200,000 frame run
// (connect EADDRNOTAVAIL), whichever side of the loopback connection closed
// first. The grammar's own drops and the server's refusals still close, about
// a third of all connections, so openConn paces the run on those.
function reset(ws) {
    ws.wasReset = true;
    const socket = ws.tcp();
    if (socket && !socket.destroyed) socket.resetAndDestroy();
    else ws.terminate();
}

async function openConn(srv, kind, address) {
    await pace();
    return kind === 'ws' ? WsConn.open(srv, address) : SioConn.open(srv, address);
}

// --- the run ------------------------------------------------------------------------

// The canaries: one socket per transport, open for the whole run at addresses
// no actor is given, so no actor's budget is spent by them and the 31st
// canary of a minute is never refused.
async function openCanaries(srv) {
    const ws = await WsConn.open(srv, '192.0.2.1');
    const sio = await SioConn.open(srv, '192.0.2.2');
    assert.equal(sio.namespace, 'connected', 'the Socket.IO canary was refused');
    let nextAck = 0;
    return {
        async check() {
            if (ws.closeCode !== null || sio.closeCode !== null) throw new Error('a canary socket was closed');
            const wsPong = new Promise((resolve) => {
                const onMessage = (raw) => {
                    let msg;
                    try { msg = JSON.parse(raw); } catch { return; }
                    if (msg && msg.type === 'pong') { ws.ws.off('message', onMessage); resolve(); }
                };
                ws.ws.on('message', onMessage);
            });
            ws.ws.send('{"type":"ping"}');
            const id = String(nextAck++);
            const sioAck = new Promise((resolve) => sio.fences.set(id, resolve));
            sio.ws.send(`42${id}["ping"]`);
            await withTimeout(wsPong, WAIT_MS, 'for the /ws canary\'s pong');
            if (await withTimeout(sioAck, WAIT_MS, 'for the Socket.IO canary\'s ack') !== 'ok') throw new Error('the Socket.IO canary was closed');
            ws.inbox.length = 0;
            sio.inbox.length = 0;
        },
        release() { ws.release(); sio.release(); },
    };
}

// The four checks after every batch: the child is running, nothing reached
// the backstop, /health answers 200 and both canaries answer. The stderr check
// is last, so the backstop's line has had the other three round trips to arrive.
async function checkServer(srv, canaries) {
    if (srv.child.exitCode !== null || srv.child.signalCode !== null) {
        throw new Error(`the server process exited (${srv.child.exitCode ?? srv.child.signalCode})`);
    }
    await canaries.check();
    const resp = await fetch(`http://127.0.0.1:${srv.port}/health`, { signal: AbortSignal.timeout(WAIT_MS) });
    if (resp.status !== 200) throw new Error(`/health answered ${resp.status}`);
    await resp.arrayBuffer();
    if (/Unhandled error/.test(srv.stderr)) throw new Error('a frame reached the uncaughtException backstop');
}

class Coverage {
    constructor() {
        this.replies = { ws: new Map(), sio: new Map() };
        this.sent = { ws: new Map(), sio: new Map() };
    }

    add(map, key) { map.set(key, (map.get(key) || 0) + 1); }

    // One frame's replies, on every actor socket, counted once per type. A
    // crowd's connection has replies and no frame (kind null).
    frame(transport, kind, replies) {
        if (kind !== null) this.add(this.sent[transport], kind);
        const seen = new Set(replies);
        if (seen.size === 0) seen.add('no reply');
        for (const r of seen) this.add(this.replies[transport], r);
    }

    line(map) {
        return [...map].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(', ');
    }
}

async function runStep(srv, b, step, conns, coverage) {
    const actor = b.actors[step.a];
    if (step.op === 'drop') {
        if (conns[step.a]) await conns[step.a].drop(step.how);
        conns[step.a] = null;
        return;
    }
    if (step.op === 'crowd') {
        const crowd = [];
        try {
            for (let i = 0; i < step.count; i++) {
                const conn = await openConn(srv, actor.transport, actor.address);
                crowd.push(conn);
                // A /ws refusal is a 1008 close right after the open; the fence
                // waits for it. A Socket.IO one is the namespace's connect error.
                const admitted = actor.transport === 'ws' ? await conn.fence() === 'ok' : conn.namespace === 'connected';
                coverage.frame(actor.transport, null, admitted ? ['admitted'] : conn.closeCode !== null ? [`close ${conn.closeCode}`] : conn.inbox);
            }
        } finally {
            for (const conn of crowd) conn.release();
        }
        return;
    }

    // A socket the server closed, or the actor dropped, is replaced here.
    let conn = conns[step.a];
    if (!conn || conn.closeCode !== null || !conn.open) {
        if (conn) conn.release();
        conn = await openConn(srv, actor.transport, actor.address);
        if (!conn.open) throw new Error(`harness: actor ${step.a}'s connection was refused, so its address is over a budget`);
        conns[step.a] = conn;
    }
    for (const c of conns) if (c) c.inbox.length = 0;
    conn.send(step);

    // The sender first: once it is fenced, the server has handled the frame,
    // so whatever it sent another socket is already ahead of that socket's fence.
    await conn.fence();
    const others = conns.filter((c) => c && c !== conn);
    await Promise.all(others.map((c) => c.fence()));
    const replies = [];
    for (const c of conns) {
        if (!c) continue;
        replies.push(...c.inbox);
        c.inbox.length = 0;
        if (c.closeCode !== null && !c.counted) {
            replies.push(`close ${c.closeCode}`);
            c.counted = true;
        }
    }
    coverage.frame(actor.transport, step.kind, replies);
}

async function fuzz(t, on) {
    const state = on ? 'on' : 'off';
    const srv = await startServer({ ...NO_RELAY, POLICY_FILE: policyFileSaying(t, on) });
    t.after(() => srv.stop());
    const canaries = await openCanaries(srv);
    t.after(() => canaries.release());

    const coverage = new Coverage();
    const hash = createHash('sha256');
    const started = Date.now();
    let previous = null;
    let frames = 0;
    let count = 0;
    for (const b of batches(SEED, FRAMES)) {
        const conns = b.actors.map(() => null);
        try {
            try {
                for (const step of b.steps) {
                    digestStep(hash, b, step);
                    await runStep(srv, b, step, conns, coverage);
                }
            } finally {
                for (const c of conns) if (c) c.release();
            }
            await checkServer(srv, canaries);
        } catch (err) {
            // The backstop's line gets a moment to arrive before the report.
            await new Promise((r) => setTimeout(r, 250));
            assert.fail(failure(state, b, previous, err, srv));
        }
        frames += b.frames;
        count++;
        previous = b;
    }

    // The last batch's backstop line can arrive after its checks.
    await new Promise((r) => setTimeout(r, 250));
    try {
        await checkServer(srv, canaries);
    } catch (err) {
        assert.fail(failure(state, null, previous, err, srv));
    }

    t.diagnostic(`seed ${SEED}, request links ${state}: ${frames} frames in ${count} batches, ${Date.now() - started} ms`);
    t.diagnostic(`frames digest ${hash.digest('hex')}`);
    t.diagnostic(`/ws replies: ${coverage.line(coverage.replies.ws)}`);
    t.diagnostic(`Socket.IO replies: ${coverage.line(coverage.replies.sio)}`);
    t.diagnostic(`/ws frames sent: ${coverage.line(coverage.sent.ws)}`);
    t.diagnostic(`Socket.IO frames sent: ${coverage.line(coverage.sent.sio)}`);

    for (const [tr, name] of [['ws', '/ws'], ['sio', 'Socket.IO']]) {
        const missing = REQUIRED_KINDS[tr].filter((k) => !coverage.sent[tr].has(k));
        assert.deepEqual(missing, [], `seed ${SEED} sent no ${name} frame of these kinds; pick a FLOE_SERVER_FUZZ_FRAMES that does`);
        if (LONG_RUN) {
            const unreached = LONG_RUN_REPLIES[state][tr].filter((r) => !coverage.replies[tr].has(r));
            assert.deepEqual(unreached, [], `a long run with seed ${SEED} and request links ${state} reached none of these ${name} replies`);
        }
    }
}

// A wait that timed out is most often a socket a throw left stuck, so the
// backstop's line, when there is one, leads the report, as orBackstop does in
// crashguard.test.js.
function failure(state, b, previous, err, srv) {
    const backstop = 'a frame reached the uncaughtException backstop';
    const why = /Unhandled error/.test(srv.stderr) && err.message !== backstop ? `${backstop} (then: ${err.message})` : err.message;
    return [
        `fuzz failure: seed ${SEED}, request links ${state}, ${b ? `batch ${b.n}` : 'after the last batch'}: ${why}`,
        `replay: FLOE_SERVER_FUZZ_SEED=${SEED} FLOE_SERVER_FUZZ_FRAMES=${FRAMES} node --test fuzz.test.js`,
        'Report a failing seed privately (SECURITY.md), never in public.',
        `frames of the batch before:\n${describeBatch(previous)}`,
        b ? `frames of the failing batch:\n${describeBatch(b)}` : '',
        `--- server stderr ---\n${srv.stderr.slice(-4000)}`,
    ].join('\n');
}

function generatorDigest(seed) {
    const hash = createHash('sha256');
    for (const b of batches(seed, FRAMES)) {
        for (const step of b.steps) digestStep(hash, b, step);
    }
    return hash.digest('hex');
}

test('the fuzzer\'s frames reach no backstop with request links on', async (t) => {
    await fuzz(t, true);
});

test('the fuzzer\'s frames reach no backstop with request links off', async (t) => {
    await fuzz(t, false);
});

test('a seed replays the same frames, and another seed sends others', (t) => {
    const first = generatorDigest(SEED);
    assert.equal(generatorDigest(SEED), first, `seed ${SEED} drew different frames on a second run`);
    const other = (SEED + 1) >>> 0;
    assert.notEqual(generatorDigest(other), first, `seeds ${SEED} and ${other} drew the same frames`);
    t.diagnostic(`frames digest ${first}`);
});
