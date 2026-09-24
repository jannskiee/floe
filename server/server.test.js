'use strict';

// Unit tests for server logic, all in this process. Only 'room seal over both
// transports' touches the network: it binds an ephemeral 127.0.0.1 port to
// drive the real connection handlers, and closes it when it is done.
// Uses Node's built-in test runner (node:test), available from Node 18+.
// Run with: npm test

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// server.js reads POLICY_FILE once, at require time, so the path is set before
// the require below. A per-run temp directory: the file does not exist until a
// policy test writes it, and a missing file means request links are off.
const POLICY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'floe-policy-test-'));
const POLICY_PATH = path.join(POLICY_DIR, 'policy.json');
process.env.POLICY_FILE = POLICY_PATH;
after(() => fs.rmSync(POLICY_DIR, { recursive: true, force: true }));

const {
    DEFAULT_POLICY,
    POLICY_MAX_BYTES,
    parsePolicy,
    createPolicyStore,
} = require('./policy');

const { roomIdFromToken } = require('./hosttoken');

const {
    errorHandler,
    getClientIp,
    isAllowedOrigin,
    rateKey,
    generateCode,
    checkRateLimit,
    handleJoinRoom,
    handleSignal,
    handleDisconnect,
    registerCodeHandler,
    resolveCodeHandler,
    rooms,
    roomMeta,
    codeToRoom,
    roomToCode,
    codeFailures,
    connectionCounts,
    validateReportBytes,
    statsRateLimits,
    makeRateLimiter,
    codeRateLimits,
    selectMinimalIceUrls,
    createWSPeer,
    heartbeatTick,
    handlePong,
    WS_SEND_BUFFER_CEILING,
    server,
    healthHandler,
    policyStore,
    cleanupTick,
    handleHostJoin,
    endReservation,
    createsInWindow,
    countRequestRooms,
    requestCreates,
    REQUEST_GRACE_MS,
    REQUEST_CREATES_PER_DAY,
    REQUEST_CREATE_WINDOW_MS,
    MAX_REQUEST_ROOMS,
    handleRequestJoin,
    requestJoinAllowed,
    REQUEST_JOINS_PER_MINUTE,
    REQUEST_SEATINGS_PER_MINUTE,
    handleRequestControl,
    REQUEST_MAX_AGE_MS,
    REQUEST_CREATE_KEYS_MAX,
    requestRoomIds,
    REQUEST_USED_MARKER_MS,
} = require('./server');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID   = '11111111-1111-1111-1111-111111111111';

// `key` is the peer's rate key, as createSocketIOPeer and createWSPeer record
// it. The default is what getClientIp and rateKey yield for a peer with no
// address, so every test that names no key has all of its peers sharing one,
// which the room seal deliberately never seals (see 'room seal' below).
function makePeer(id, key = 'unknown') {
    const msgs = [];
    return {
        id,
        key,
        roomId: null,
        msgs,
        send(type, data) { msgs.push({ type, data }); },
    };
}

// Minimal Express response stub: records the status and the JSON body so a
// handler can be called directly, with no network I/O.
function fakeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

// ---------------------------------------------------------------------------
// getClientIp
// ---------------------------------------------------------------------------

describe('getClientIp', () => {
    it('returns socket address when XFF header is absent', () => {
        assert.equal(getClientIp(undefined, '1.2.3.4'), '1.2.3.4');
    });

    it('returns "unknown" when both header and socket address are absent', () => {
        assert.equal(getClientIp(undefined, undefined), 'unknown');
    });

    it('returns the client IP from a single-hop XFF (TRUSTED_PROXY_COUNT=1)', () => {
        // With one trusted proxy, the proxy appended '10.0.0.1' — that IS the client IP.
        // hops=['10.0.0.1'], idx=max(0, 1-1)=0 → '10.0.0.1'
        assert.equal(getClientIp('10.0.0.1', '172.16.0.1'), '10.0.0.1');
    });

    it('ignores a client-supplied spoofed prefix and uses the entry added by the trusted proxy', () => {
        // Client forges 'spoofed' in XFF; proxy appends 'real'.
        // hops=['spoofed','real'], idx=max(0, 2-1)=1 → 'real'
        assert.equal(getClientIp('spoofed, real', '172.16.0.1'), 'real');
    });

    it('trims whitespace around comma-separated hops', () => {
        assert.equal(getClientIp('  192.168.1.1  ,  10.0.0.5  ', '127.0.0.1'), '10.0.0.5');
    });

    it('falls back to socket address for an empty XFF string', () => {
        assert.equal(getClientIp('', '9.9.9.9'), '9.9.9.9');
    });
});

// ---------------------------------------------------------------------------
// isAllowedOrigin: who may open a WebSocket on /ws or Socket.IO
// ---------------------------------------------------------------------------

describe('isAllowedOrigin', () => {
    const HOST = 'api.floe.one';

    it('lets an absent Origin through, as undefined or empty', () => {
        // Any non-browser client may omit it, so requiring it would stop nothing.
        assert.equal(isAllowedOrigin(undefined, HOST), true);
        assert.equal(isAllowedOrigin('', HOST), true);
        assert.equal(isAllowedOrigin(undefined, undefined), true);
    });

    it('lets the three hardcoded web origins through on any host', () => {
        for (const origin of ['https://floe.one', 'https://www.floe.one', 'http://localhost:3000']) {
            assert.equal(isAllowedOrigin(origin, HOST), true, origin);
            assert.equal(isAllowedOrigin(origin, '192.168.1.50:3001'), true, origin);
            assert.equal(isAllowedOrigin(origin, undefined), true, `${origin} with no Host`);
        }
    });

    it('lets an Origin naming the server\'s own host through', () => {
        // cli/engine/signaling/client.go originFromServer sends the server's own
        // address for every self-hosted --server, so this is what every
        // installed CLI and desktop app presents to a self-hosted server.
        assert.equal(isAllowedOrigin('http://192.168.1.50:3001', '192.168.1.50:3001'), true);
        assert.equal(isAllowedOrigin('https://floe.example.com', 'floe.example.com'), true);
        assert.equal(isAllowedOrigin('http://[::1]:3001', '[::1]:3001'), true);
    });

    it('compares the host only, never the scheme', () => {
        // TLS usually ends at the proxy, so an https Origin meets a server that
        // was reached over plain http.
        assert.equal(isAllowedOrigin('https://192.168.1.50:3001', '192.168.1.50:3001'), true);
    });

    it('compares hosts without regard to case', () => {
        // Hostnames are case-insensitive, and the URL parser lowercases the
        // Origin's. A Host header keeps whatever case the client typed in
        // --server when the proxy passes it through unchanged.
        assert.equal(isAllowedOrigin('https://Floe.Example.com', 'Floe.Example.com'), true);
        assert.equal(isAllowedOrigin('https://floe.example.com', 'FLOE.example.COM'), true);
    });

    it('refuses a foreign origin and a lookalike', () => {
        assert.equal(isAllowedOrigin('https://evil.example', HOST), false);
        assert.equal(isAllowedOrigin('https://floe.one.evil.example', HOST), false);
        assert.equal(isAllowedOrigin('https://api.floe.one.evil.example', HOST), false);
    });

    it('refuses a port mismatch', () => {
        assert.equal(isAllowedOrigin('http://192.168.1.50:3000', '192.168.1.50:3001'), false);
        assert.equal(isAllowedOrigin('http://192.168.1.50', '192.168.1.50:3001'), false);
    });

    it('refuses the literal null origin', () => {
        // Sandboxed frames and file: pages send "null".
        assert.equal(isAllowedOrigin('null', HOST), false);
        assert.equal(isAllowedOrigin('null', 'null'), false);
    });

    it('refuses two Origin headers joined into one', () => {
        // Node joins a repeated Origin header with ", ", so an allowed value
        // followed by a foreign one arrives as a single string.
        assert.equal(isAllowedOrigin('https://floe.one, https://evil.example', HOST), false);
        assert.equal(isAllowedOrigin(`https://${HOST}, https://evil.example`, HOST), false);
    });

    it('refuses a backslash authority that hides the real host', () => {
        // WHATWG URL reads a backslash as a path separator in http(s), so the
        // host here is evil.example, not the name after the @.
        assert.equal(isAllowedOrigin(`https://evil.example\\@${HOST}`, HOST), false);
    });

    it('the same-host rule holds across the whole table, including a Host a proxy stripped of its port', () => {
        // One row per expectation above, plus the rows the port rule adds
        // (D-114). nginx `proxy_set_header Host $host`, the docs' own example
        // and the usual Nginx Proxy Manager and SWAG default, forwards the host
        // name without its port, so a CLI or desktop app pointed at
        // https://api.example.com:8443 arrives with that Origin and Host
        // api.example.com. A default port spelled out in --server (:80, :443)
        // stays in both the Origin and the Host the Go client sends.
        const rows = [
            // [origin, host, expected, why]
            [undefined, HOST, true, 'absent'],
            ['', HOST, true, 'empty'],
            [undefined, undefined, true, 'absent, no Host'],
            ['https://floe.one', HOST, true, 'allow-list'],
            ['https://www.floe.one', '192.168.1.50:3001', true, 'allow-list on another host'],
            ['http://localhost:3000', undefined, true, 'allow-list, no Host'],
            ['http://192.168.1.50:3001', '192.168.1.50:3001', true, 'same host and port'],
            ['https://floe.example.com', 'floe.example.com', true, 'same host, default port'],
            ['http://[::1]:3001', '[::1]:3001', true, 'IPv6 literal'],
            ['https://192.168.1.50:3001', '192.168.1.50:3001', true, 'scheme ignored'],
            ['https://Floe.Example.com', 'Floe.Example.com', true, 'case kept on both sides'],
            ['https://floe.example.com', 'FLOE.example.COM', true, 'case differs'],
            ['https://floe.example.com:8443', 'floe.example.com', true, 'proxy dropped the port from Host'],
            ['https://floe.example.com:8443', 'FLOE.EXAMPLE.COM', true, 'proxy dropped the port, case differs'],
            ['https://floe.example.com:443', 'floe.example.com:443', true, ':443 spelled out'],
            ['http://floe.example.com:80', 'floe.example.com:80', true, ':80 spelled out'],
            ['https://floe.example.com:443', 'floe.example.com', true, ':443 in Origin only'],
            ['https://evil.example', HOST, false, 'foreign'],
            ['https://floe.one.evil.example', HOST, false, 'lookalike'],
            ['https://api.floe.one.evil.example', HOST, false, 'lookalike of the host itself'],
            ['https://evil.example:8443', 'floe.example.com', false, 'port dropped, different host'],
            ['http://192.168.1.50:3000', '192.168.1.50:3001', false, 'port mismatch'],
            ['http://192.168.1.50', '192.168.1.50:3001', false, 'Host carries a port the Origin lacks'],
            ['https://floe.example.com', 'floe.example.com:8443', false, 'Host carries a port the Origin lacks'],
            ['https://floe.example.com:8443', 'localhost:3001', false, 'Host rewritten to the upstream'],
            ['https://floe.example.com', 'localhost:3001', false, 'Host rewritten to the upstream, default port'],
            ['null', HOST, false, 'null origin'],
            ['null', 'null', false, 'null origin and Host'],
            ['https://floe.one, https://evil.example', HOST, false, 'joined duplicate'],
            [`https://${HOST}, https://evil.example`, HOST, false, 'joined duplicate of the host'],
            [`https://evil.example\\@${HOST}`, HOST, false, 'backslash authority'],
            ['https://evil.example', undefined, false, 'no Host'],
            ['https://evil.example', '', false, 'empty Host'],
        ];
        const wrong = rows
            .filter(([origin, host, expected]) => isAllowedOrigin(origin, host) !== expected)
            .map(([origin, host, expected, why]) => `${why}: isAllowedOrigin(${JSON.stringify(origin)}, ${JSON.stringify(host)}) should be ${expected}`);
        assert.deepEqual(wrong, []);
    });

    it('refuses anything else when the Host header is absent', () => {
        assert.equal(isAllowedOrigin('https://evil.example', undefined), false);
        assert.equal(isAllowedOrigin('https://evil.example', ''), false);
    });
});

// ---------------------------------------------------------------------------
// handleUpgradeRequest: the order its checks run in
// ---------------------------------------------------------------------------

describe('handleUpgradeRequest order', () => {
    it('keeps the error listener first and the origin check after both pass-through returns', () => {
        // CLAUDE.md's kill list: the no-op socket error listener has to precede
        // anything that can throw, and the Socket.IO pass-through has to precede
        // anything that can refuse. A refusal placed above either return would
        // write a status line into a socket engine.io owns. On the wire that is
        // invisible today, because engine.io refuses a foreign Origin itself
        // before this handler runs (crashguard.test.js has the live check), so
        // the order is pinned here as well, from the source.
        const source = require('node:fs').readFileSync(require.resolve('./server.js'), 'utf8');
        const start = source.indexOf('function handleUpgradeRequest(');
        const end = source.indexOf("server.on('upgrade', handleUpgradeRequest);");
        assert.ok(start !== -1 && end > start, 'handleUpgradeRequest not found where expected');
        const code = source.slice(start, end)
            .split('\n')
            .filter(line => !/^\s*\/\//.test(line))
            .join('\n');

        const at = (marker) => {
            const i = code.indexOf(marker);
            assert.notEqual(i, -1, `marker missing from handleUpgradeRequest: ${marker}`);
            assert.equal(code.indexOf(marker, i + 1), -1, `marker appears twice: ${marker}`);
            return i;
        };
        const order = [
            "socket.on('error', () => {});",
            "if (pathname !== '/ws') return;",
            "if (req.url.startsWith(io.path() + '/')) return;",
            'if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {',
            // The warn call rather than refuseUpgrade(socket, 403), which later
            // checks in this handler may also use; this call is the origin check's own.
            "warnRejectedOrigin('/ws', req.headers.origin, req.headers.host);",
            'wss.handleUpgrade(',
        ].map(at);
        for (let i = 1; i < order.length; i++) {
            assert.ok(order[i - 1] < order[i], `check ${i} runs before check ${i - 1}`);
        }
    });
});

// ---------------------------------------------------------------------------
// rateKey: the key every per-IP limiter counts under
// ---------------------------------------------------------------------------

describe('rateKey', () => {
    it('unwraps both mapped spellings and keeps them distinct', () => {
        assert.equal(rateKey('::ffff:1.2.3.4'), '1.2.3.4');
        assert.equal(rateKey('::ffff:cb00:7107'), '203.0.113.7');
        assert.equal(rateKey('::ffff:102:304'), rateKey('::ffff:1.2.3.4'));
        // Unwrapped, not masked: every IPv4 client would otherwise share ::ffff:0:0/64.
        assert.notEqual(rateKey('::ffff:1.2.3.4'), rateKey('::ffff:1.2.3.5'));
    });

    it('two addresses in one /64 share a key and another /64 does not', () => {
        assert.equal(rateKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
        assert.equal(rateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
        assert.notEqual(rateKey('2001:db8:1:3::1'), rateKey('2001:db8:1:2::1'));
    });

    it('2001:db8::1 equals 2001:0db8::1', () => {
        assert.equal(rateKey('2001:db8::1'), rateKey('2001:0db8::1'));
        assert.equal(rateKey('2001:DB8::1'), '2001:db8:0:0::/64');
    });

    it('0:0:0:0:0:0:0:1 equals ::1', () => {
        assert.equal(rateKey('0:0:0:0:0:0:0:1'), rateKey('::1'));
    });

    it('unparseable inputs keep distinct buckets', () => {
        assert.notEqual(rateKey('unknown'), rateKey('garbage'));
        assert.equal(rateKey('1.2.3.4'), '1.2.3.4');
        assert.equal(rateKey(undefined), 'unknown');
        assert.equal(rateKey('fe80::1%eth0'), 'fe80::1%eth0');
    });

    it('leaves a zone id unchanged, even one holding a dot', () => {
        // net.isIPv6 accepts a zone id made of [0-9a-zA-Z-.:], so a dot in it once
        // reached the dotted-IPv4 branch and threw (seven groups plus ::).
        for (const zoned of ['1:2:3:4:5:6:7::%x.y', '::ffff:1.2.3.4%eth0', 'fe80::1%eth0.100', 'fe80::1%eth0']) {
            assert.equal(rateKey(zoned), zoned);
        }
    });

    it('keys every accepted spelling without throwing', () => {
        const expected = {
            '::': '0:0:0:0::/64',
            '::1.2.3.4': '0:0:0:0::/64',
            '64:ff9b::1.2.3.4': '64:ff9b:0:0::/64',
            '1::2:1.2.3.4': '1:0:0:0::/64',
            '1:2:3:4:5:6:7::': '1:2:3:4::/64',
            '1:2:3:4:5:6:1.2.3.4': '1:2:3:4::/64',
            '::2:3:4:5:6:7:8': '0:2:3:4::/64',
            '::FFFF:1.2.3.4': '1.2.3.4',
        };
        for (const [addr, key] of Object.entries(expected)) assert.equal(rateKey(addr), key, addr);
    });

    it('is the key checkRateLimit and makeRateLimiter count under', () => {
        connectionCounts.clear();
        for (let i = 0; i < 30; i++) checkRateLimit('2001:db8:1:2::' + (i + 1).toString(16));
        assert.equal(checkRateLimit('2001:db8:1:2:ffff::1'), false, 'a 31st address in the same /64 is blocked');
        assert.equal(checkRateLimit('::ffff:9.9.9.9'), true);
        assert.deepEqual([...connectionCounts.keys()], ['2001:db8:1:2::/64', '9.9.9.9']);
        connectionCounts.clear();

        const map = new Map();
        const limiter = makeRateLimiter(map, 60000, 1);
        limiter({ ip: '2001:db8:1:2::1' }, { status() { return this; }, json() { return this; } }, () => {});
        let allowed = false;
        limiter({ ip: '2001:db8:1:2::2' }, { status() { return this; }, json() { return this; } }, () => { allowed = true; });
        assert.equal(allowed, false, 'the same /64 shares one budget');
    });
});

// ---------------------------------------------------------------------------
// generateCode
// ---------------------------------------------------------------------------

describe('generateCode', () => {
    beforeEach(() => { codeToRoom.clear(); roomToCode.clear(); codeFailures.clear(); });

    it('returns a three-word hyphen-delimited code', () => {
        const code = generateCode();
        const parts = code.split('-');
        assert.ok(parts.length >= 3, `expected ≥3 parts, got: ${code}`);
        parts.forEach(p => assert.ok(p.length > 0, `empty part in code: ${code}`));
    });

    it('falls back to a 4-word code after 10 collisions with active entries', () => {
        // Inject a fixed picker so every attempt generates the same code.
        const fixed = generateCode(() => 'apple');                 // "apple-apple-apple"
        codeToRoom.set(fixed, { roomId: ROOM_ID, expires: Date.now() + 60_000 });
        const next = generateCode(() => 'apple');
        assert.equal(next.split('-').length, 4, `expected 4-word fallback, got: ${next}`);
    });

    it('treats an expired entry as a free slot and reuses the same 3-word code', () => {
        const fixed = generateCode(() => 'apple');
        codeToRoom.set(fixed, { roomId: ROOM_ID, expires: Date.now() - 1 }); // already expired
        const next = generateCode(() => 'apple');
        assert.equal(next, fixed, 'expired slot should be reused');
        assert.equal(next.split('-').length, 3, 'should return the 3-word form');
    });
});

describe('words.json', () => {
    // The phrase is the only secret guarding a code transfer, so the list size is
    // its strength: the EFF short word list (1296 words) minus its one hyphenated
    // entry (yo-yo) and the 48 words below, which read badly in a code shown in
    // large type and read aloud, or would alarm someone receiving files (virus,
    // scam, spoof, error). 1247 words, 30.85 bits for three. The character class
    // is what catches a future hyphenated word, which would print a three-word
    // code that reads as four parts.
    const words = require('./words.json');
    const EXCLUDED = ['aids', 'arson', 'bribe', 'chump', 'coke', 'coma', 'crazy', 'crook', 'cult', 'curse', 'dwarf', 'ebay', 'error', 'evil', 'fetal', 'gore', 'grave', 'grope', 'hate', 'hump', 'islam', 'junky', 'kung', 'mardi', 'pagan', 'panty', 'polio', 'prude', 'rabid', 'riot', 'roman', 'santa', 'scam', 'slain', 'slob', 'slum', 'spoof', 'stole', 'theft', 'thong', 'trump', 'virus', 'vixen', 'wimp', 'womb', 'wound', 'xerox', 'yahoo'];

    it('holds exactly the 1247 words of the reviewed EFF short list', () => {
        assert.equal(words.length, 1247);
    });

    it('leaves out every excluded word', () => {
        assert.deepEqual(words.filter((w) => EXCLUDED.includes(w)), []);
    });

    it('has no duplicates', () => {
        assert.equal(new Set(words).size, words.length);
    });

    it('uses only 3 to 5 lowercase letters per word', () => {
        const bad = words.filter((w) => !/^[a-z]{3,5}$/.test(w));
        assert.deepEqual(bad, []);
    });
});

// ---------------------------------------------------------------------------
// Room lifecycle — handleJoinRoom
// ---------------------------------------------------------------------------

describe('handleJoinRoom', () => {
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); policyStore.apply(DEFAULT_POLICY); });

    it('assigns sender role to the first peer in a room', () => {
        const p = makePeer('peer-A');
        handleJoinRoom(p, ROOM_ID);

        assert.equal(p.msgs.length, 1);
        assert.equal(p.msgs[0].type, 'room-joined');
        assert.equal(p.msgs[0].data.role, 'sender');
        assert.equal(p.roomId, ROOM_ID);
    });

    it('assigns receiver role to the second peer and notifies the first', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);

        assert.equal(pB.msgs[0].type, 'room-joined');
        assert.equal(pB.msgs[0].data.role, 'receiver');

        const notify = pA.msgs.find(m => m.type === 'user-connected');
        assert.ok(notify, 'first peer should receive user-connected');
    });

    it('sends room-full to a third peer and leaves it unjoined', () => {
        const [pA, pB, pC] = ['A', 'B', 'C'].map(makePeer);
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        handleJoinRoom(pC, ROOM_ID);

        const full = pC.msgs.find(m => m.type === 'room-full');
        assert.ok(full, 'third peer should receive room-full');
        assert.equal(pC.roomId, null);
    });

    it('sends an error for a non-UUID room ID', () => {
        const p = makePeer('peer-A');
        handleJoinRoom(p, 'not-a-uuid');
        assert.equal(p.msgs[0].type, 'error');
        assert.equal(p.roomId, null);
    });

    it('sends an error for a null room ID', () => {
        const p = makePeer('peer-A');
        handleJoinRoom(p, null);
        assert.equal(p.msgs[0].type, 'error');
    });
});

// ---------------------------------------------------------------------------
// Signal routing — handleSignal
// ---------------------------------------------------------------------------

describe('handleSignal', () => {
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); policyStore.apply(DEFAULT_POLICY); });

    it('routes signal to the other peer when targeted by ID', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleSignal(pA, { type: 'offer' }, 'peer-B');

        assert.equal(pB.msgs.length, 1);
        assert.equal(pB.msgs[0].type, 'signal');
        assert.equal(pA.msgs.length, 0, 'sender should not receive its own signal');
    });

    it('routes to the other peer in the room the server recorded for the sender', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleSignal(pA, { type: 'candidate' }, null);

        assert.equal(pB.msgs.length, 1);
        assert.equal(pB.msgs[0].type, 'signal');
    });

    it('routes by sender.roomId with an explicit null targetId', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleSignal(pA, { type: 'candidate' }, null);

        assert.equal(pB.msgs.length, 1);
    });

    it('is a no-op when the target peer does not exist', () => {
        const pA = makePeer('peer-A');
        handleJoinRoom(pA, ROOM_ID);
        pA.msgs.length = 0;

        // Should not throw.
        handleSignal(pA, { type: 'offer' }, 'nonexistent-id');
        assert.equal(pA.msgs.length, 0);
    });

    it('is a no-op when signal payload is falsy', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pB.msgs.length = 0;

        handleSignal(pA, null, 'peer-B');
        assert.equal(pB.msgs.length, 0);
    });

    it('does not route a signal to a peer in a different room', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, '22222222-2222-2222-2222-222222222222');
        pB.msgs.length = 0;

        // pA targets pB by id, but pB is in a different room — must be dropped.
        handleSignal(pA, { type: 'offer' }, 'peer-B');
        assert.equal(pB.msgs.length, 0, 'must not receive a cross-room signal');
    });
});

// ---------------------------------------------------------------------------
// Peer disconnect — handleDisconnect
// ---------------------------------------------------------------------------

describe('handleDisconnect', () => {
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); policyStore.apply(DEFAULT_POLICY); });

    it('removes only the disconnecting peer; the room survives with the remaining peer', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleDisconnect(pA);

        assert.ok(pB.msgs.some(m => m.type === 'peer-disconnected'));
        assert.equal(pB.roomId, ROOM_ID, 'remaining peer must keep its roomId');
        assert.deepEqual(rooms.get(ROOM_ID).map(p => p.id), ['peer-B']);
    });

    it('clears roomId on the disconnecting peer', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);

        handleDisconnect(pA);
        assert.equal(pA.roomId, null);
    });

    it('is a no-op when the peer is not in any room', () => {
        const p = makePeer('lone');
        handleDisconnect(p); // should not throw
        assert.equal(p.msgs.length, 0);
    });

    it('an out-of-order stale disconnect removes only the ghost entry, not the rejoined peer', () => {
        // A dirty network drop is only noticed via ping timeout, so the old
        // socket's disconnect can arrive AFTER the same user already rejoined
        // the room under a fresh socket id. It must evict only itself.
        const pOld = makePeer('peer-A-old');
        const pNew = makePeer('peer-A-new');
        handleJoinRoom(pOld, ROOM_ID);
        handleJoinRoom(pNew, ROOM_ID); // rejoin lands while the ghost still holds a seat
        pNew.msgs.length = 0;

        handleDisconnect(pOld);

        assert.deepEqual(rooms.get(ROOM_ID).map(p => p.id), ['peer-A-new']);
        assert.equal(pNew.roomId, ROOM_ID, 'rejoined peer must keep its seat');
    });

    it('deletes the room when the last peer disconnects', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);

        handleDisconnect(pA);
        handleDisconnect(pB);

        assert.equal(rooms.has(ROOM_ID), false);
    });

    it('a fresh join after a full disconnect recreates the room with sender role', () => {
        const pA = makePeer('peer-A');
        handleJoinRoom(pA, ROOM_ID);
        handleDisconnect(pA); // sole peer leaving deletes the room

        const pA2 = makePeer('peer-A2'); // same user, new socket id after reconnect
        handleJoinRoom(pA2, ROOM_ID);

        assert.equal(pA2.msgs[0].type, 'room-joined');
        assert.equal(pA2.msgs[0].data.role, 'sender');
        assert.deepEqual(rooms.get(ROOM_ID).map(p => p.id), ['peer-A2']);
    });
});

// ---------------------------------------------------------------------------
// Room seal: once two keys have sat in a room, a third key is refused
// ---------------------------------------------------------------------------

describe('room seal', () => {
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); policyStore.apply(DEFAULT_POLICY); });

    // What every real pair does before a single file byte can move: the sender
    // offers, the receiver answers. A key counts toward the seal only once its
    // peer has routed a signal, so a test that means "these two have paired"
    // has to say so with this, not with two joins.
    function exchangeSignals(sender, receiver) {
        handleSignal(sender, { type: 'offer' }, receiver.id);
        handleSignal(receiver, { type: 'answer' }, sender.id);
    }

    it('a third key after the receiver leaves gets room-full', () => {
        const pA = makePeer('peer-A', 'a');
        const pB = makePeer('peer-B', 'b');
        const pC = makePeer('peer-C', 'c');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        exchangeSignals(pA, pB);
        handleDisconnect(pB); // seat two is free again, so only the seal can refuse
        pA.msgs.length = 0;

        handleJoinRoom(pC, ROOM_ID);

        assert.deepEqual(pC.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(pC.roomId, null);
        assert.deepEqual(rooms.get(ROOM_ID).map(p => p.id), ['peer-A']);
        assert.equal(pA.msgs.length, 0, 'the seated sender hears nothing of a refused joiner');
    });

    it('the browser re-join with the same key gets receiver and a fresh user-connected', () => {
        // A browser receiver whose socket dropped comes back on a new socket id
        // from the same address and re-runs its join (P2PTransfer.tsx, the
        // reconnect handler). Its key is already one of the two.
        const pA = makePeer('peer-A', 'a');
        const pB = makePeer('peer-B', 'b');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        exchangeSignals(pA, pB); // sealed, so only the key check lets B2 in
        handleDisconnect(pB);
        pA.msgs.length = 0;

        const pB2 = makePeer('peer-B2', 'b');
        handleJoinRoom(pB2, ROOM_ID);

        assert.deepEqual(pB2.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
        assert.deepEqual(
            pA.msgs.filter(m => m.type === 'user-connected'),
            [{ type: 'user-connected', data: { id: 'peer-B2' } }],
        );
    });

    it('the ghost case admits the real receiver', () => {
        // P2PTransfer.tsx re-joins a reconnecting sender with a bare join-room,
        // which can land beside its own ghost (the old socket's disconnect has not
        // arrived yet) and so take seat two. A seal on "this room has been full
        // once" would then refuse the real receiver forever. Two keys have not
        // sat here, so the room stays open.
        const ghost = makePeer('peer-A-old', 'a');
        const rejoin = makePeer('peer-A-new', 'a');
        const pB = makePeer('peer-B', 'b');
        handleJoinRoom(ghost, ROOM_ID);
        handleJoinRoom(rejoin, ROOM_ID);
        assert.deepEqual(rejoin.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
        handleDisconnect(ghost);

        handleJoinRoom(pB, ROOM_ID);

        assert.deepEqual(pB.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
        assert.equal(pB.roomId, ROOM_ID);
        assert.deepEqual(rooms.get(ROOM_ID).map(p => p.id), ['peer-A-new', 'peer-B']);
    });

    it('peers sharing one key are not sealed', () => {
        // The same-NAT fail-open, asserted because it is deliberate: two people
        // behind one address never reach two keys, so the seal cannot tell a
        // stranger from the receiver there. A per-room token is the only fix,
        // and the released binaries have no field to carry one.
        const [pA, pB, pC] = ['peer-A', 'peer-B', 'peer-C'].map(id => makePeer(id, 'nat'));
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        exchangeSignals(pA, pB); // a real pair, and still one key
        handleDisconnect(pB);

        handleJoinRoom(pC, ROOM_ID);

        assert.deepEqual(pC.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
        assert.deepEqual(rooms.get(ROOM_ID).map(p => p.id), ['peer-A', 'peer-C']);
    });

    it('an unpaired room is not sealed', () => {
        // One key has sat here, so the room is still waiting for its receiver.
        const pA = makePeer('peer-A', 'a');
        const pB = makePeer('peer-B', 'b');
        handleJoinRoom(pA, ROOM_ID);

        handleJoinRoom(pB, ROOM_ID);

        assert.deepEqual(pB.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
        assert.deepEqual(pA.msgs.filter(m => m.type === 'user-connected'), [{ type: 'user-connected', data: { id: 'peer-B' } }]);
    });

    it('the seal lives and dies with its room', () => {
        // Deleted by destroyRoom at both of its call sites, so a room id that has
        // emptied starts unsealed, and the map cannot grow past the live rooms.
        const pA = makePeer('peer-A', 'a');
        const pB = makePeer('peer-B', 'b');
        handleJoinRoom(pA, ROOM_ID);
        assert.equal(roomMeta.get(ROOM_ID).keys.size, 0, 'a join alone counts nothing');
        handleJoinRoom(pB, ROOM_ID);
        assert.equal(roomMeta.get(ROOM_ID).keys.size, 0);
        exchangeSignals(pA, pB);
        assert.equal(roomMeta.get(ROOM_ID).keys.size, 2);
        handleDisconnect(pB);
        assert.equal(roomMeta.get(ROOM_ID).keys.size, 2, 'a departed key stays counted while the room exists');

        handleDisconnect(pA); // handleDisconnect's destroyRoom
        assert.equal(roomMeta.size, 0);

        const pC = makePeer('peer-C', 'c');
        const pD = makePeer('peer-D', 'd');
        handleJoinRoom(pC, ROOM_ID);
        handleJoinRoom(pD, ROOM_ID);
        assert.deepEqual(pD.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }], 'the emptied id starts unsealed');

        const other = '11111111-2222-4333-8444-555555555555';
        handleDisconnect(pD);
        handleJoinRoom(pC, other); // the leave-first block's destroyRoom
        assert.deepEqual([...roomMeta.keys()], [other]);
        assert.equal(roomMeta.get(other).keys.size, 0);
    });

    it('a sender that re-joins from a new address beside its own ghost does not lock out the receiver', () => {
        // The web sender waits with its link open. Its network changes (Wi-Fi to
        // cellular, a VPN toggled), Socket.IO reconnects within seconds under a
        // new key, and the bare re-join lands in seat two because the old
        // socket is still seated until its ping timeout reaps it (up to about
        // 45 s). Two keys have now sat in the room, but neither has signaled:
        // the ghost is dead and the sender has no one to offer to. Counting
        // them would have the sender seal its own room against the receiver.
        const ghost = makePeer('peer-A-old', 'wifi');
        const rejoin = makePeer('peer-A-new', 'cellular');
        const pB = makePeer('peer-B', 'home');
        handleJoinRoom(ghost, ROOM_ID);
        handleJoinRoom(rejoin, ROOM_ID);
        handleDisconnect(ghost);

        handleJoinRoom(pB, ROOM_ID);

        assert.deepEqual(pB.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
        assert.deepEqual(rooms.get(ROOM_ID).map(p => p.id), ['peer-A-new', 'peer-B']);

        // The pair that then forms still seals the room.
        exchangeSignals(rejoin, pB);
        handleDisconnect(pB);
        const stranger = makePeer('peer-X', 'elsewhere');
        handleJoinRoom(stranger, ROOM_ID);
        assert.deepEqual(stranger.msgs, [{ type: 'room-full', data: {} }]);
    });

    it('a key that has only been signaled to does not count', () => {
        // The rule is "has routed a signal", not "has taken part in one". A
        // receiver that was offered to and left before answering has no
        // connection and has received nothing, and its own network may be why
        // it left: counting it would refuse that receiver when it comes back
        // from its new address, and refuse nobody who could have been sent a
        // byte.
        const pA = makePeer('peer-A', 'a');
        const pB = makePeer('peer-B', 'b');
        const pC = makePeer('peer-C', 'c');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        handleSignal(pA, { type: 'offer' }, 'peer-B');
        handleDisconnect(pB);

        handleJoinRoom(pC, ROOM_ID);

        assert.deepEqual(pC.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
    });

    it('a signal the server drops counts nothing', () => {
        // Only a signal that reaches the other seat counts: a lone sender has no
        // one to route to, and a signal naming someone else is dropped.
        const pA = makePeer('peer-A', 'a');
        const pB = makePeer('peer-B', 'b');
        handleJoinRoom(pA, ROOM_ID);
        handleSignal(pA, { type: 'offer' }, null); // nobody in seat two yet
        handleJoinRoom(pB, ROOM_ID);
        handleSignal(pB, { type: 'answer' }, 'not-peer-A');

        assert.equal(roomMeta.get(ROOM_ID).keys.size, 0);
    });

    it('roomMeta keeps a per-process digest of each key, never the key', () => {
        // A rate key is an address (an IPv4 address in full, an IPv6 /64), and a
        // room can live for hours, past the "at most about two minutes" the
        // privacy page promises for an IP address. The seal only has to tell
        // keys apart, so it compares keyed digests instead.
        const other = '11111111-2222-4333-8444-555555555555';
        const raw = ['203.0.113.7', '2001:db8:1:2::/64', '198.51.100.9'];
        const pA = makePeer('peer-A', raw[0]);
        const pB = makePeer('peer-B', raw[1]);
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        handleSignal(pA, { type: 'offer' }, 'peer-B');
        const [digestA] = roomMeta.get(ROOM_ID).keys;
        handleSignal(pB, { type: 'answer' }, 'peer-A');
        const digestB = [...roomMeta.get(ROOM_ID).keys].find(d => d !== digestA);

        // The same key in another room of this process: the same digest.
        const pA2 = makePeer('peer-A2', raw[0]);
        const pC = makePeer('peer-C', raw[2]);
        handleJoinRoom(pA2, other);
        handleJoinRoom(pC, other);
        handleSignal(pA2, { type: 'offer' }, 'peer-C');

        assert.deepEqual([...roomMeta.get(other).keys], [digestA], 'one key, one digest');
        assert.equal(roomMeta.get(ROOM_ID).keys.size, 2);
        assert.ok(digestB && digestB !== digestA, 'two keys, two digests');

        const dump = JSON.stringify([...roomMeta].map(([id, m]) => [id, [...m.keys]]));
        for (const key of raw) assert.ok(!dump.includes(key), `roomMeta holds ${key}`);
        // Keyed, not a bare hash: 2^32 SHA-256 runs reverse any IPv4 address.
        const bare = raw.flatMap(k => ['hex', 'base64', 'base64url'].map(enc => createHash('sha256').update(k).digest(enc)));
        for (const d of [digestA, digestB]) {
            assert.equal(typeof d, 'string');
            assert.ok(!bare.includes(d), 'an unkeyed hash of the key');
        }
        // The secret stays inside server.js.
        assert.ok(!Object.values(require('./server')).some(v => v instanceof Uint8Array), 'an exported secret');
    });

    it('a peer with no key fails open instead of throwing', () => {
        // What a transport that lost its key would hand the seal. Every such
        // peer shares one key, so nobody is sealed out, and nothing throws on
        // the join and signal paths, where a throw is a remote kill.
        const [pA, pB, pC] = ['peer-A', 'peer-B', 'peer-C'].map((id) => {
            const p = makePeer(id);
            p.key = undefined;
            return p;
        });
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        assert.doesNotThrow(() => exchangeSignals(pA, pB));
        handleDisconnect(pB);

        assert.doesNotThrow(() => handleJoinRoom(pC, ROOM_ID));
        assert.deepEqual(pC.msgs, [{ type: 'room-joined', data: { role: 'receiver' } }]);
    });
});

// ---------------------------------------------------------------------------
// Room seal through the real transports
// ---------------------------------------------------------------------------

describe('room seal over both transports', () => {
    // The seal is only as good as the key each transport hands it, and a break
    // in that wiring fails open (every peer of that transport shares one key),
    // so no unit test above would notice. These drive the real io.use and /ws
    // connection handlers on an ephemeral loopback port. Each peer names its
    // own address in X-Forwarded-For, which getClientIp trusts for one hop by
    // default. 198.51.100.0/24 is TEST-NET-2 (RFC 5737).
    let port;
    const sockets = new Set();

    before(async () => {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        port = server.address().port;
    });

    after(async () => {
        for (const ws of sockets) ws.terminate();
        await new Promise((resolve) => server.close(resolve));
    });

    // Messages by type, in arrival order, whichever transport they came over.
    function mailbox() {
        const inbox = [];
        const waiters = [];
        return {
            push(type, data) {
                const i = waiters.findIndex(w => w.types.includes(type));
                if (i === -1) { inbox.push({ type, data }); return; }
                const [w] = waiters.splice(i, 1);
                clearTimeout(w.timer);
                w.resolve({ type, data });
            },
            next(types, ms = 3000) {
                const i = inbox.findIndex(m => types.includes(m.type));
                if (i !== -1) return Promise.resolve(inbox.splice(i, 1)[0]);
                return new Promise((resolve, reject) => {
                    const w = { types, resolve };
                    w.timer = setTimeout(() => {
                        waiters.splice(waiters.indexOf(w), 1);
                        reject(new Error(`no ${types.join(' or ')} within ${ms} ms`));
                    }, ms);
                    waiters.push(w);
                });
            },
        };
    }

    // A CLI peer: JSON frames on /ws.
    function wsPeer(address) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'X-Forwarded-For': address } });
        sockets.add(ws);
        const box = mailbox();
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            const { type, ...data } = msg;
            box.push(type, data);
        });
        return new Promise((resolve, reject) => {
            ws.once('error', reject);
            ws.once('open', () => resolve({
                join: (roomId) => ws.send(JSON.stringify({ type: 'join-room', roomId })),
                signal: (signal) => ws.send(JSON.stringify({ type: 'signal', signal })),
                next: box.next,
                close: () => ws.close(),
            }));
        });
    }

    // A browser peer: Socket.IO v4 spoken over a bare engine.io websocket, so
    // the test needs no client library. '0' is engine.io's open, answered by
    // '40' (connect the default namespace); '2' is its ping; '40' back is the
    // namespace ack, '44' a refusal from io.use; '42' carries an event.
    function sioPeer(address) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
            headers: { 'X-Forwarded-For': address, Origin: 'http://localhost:3000' },
        });
        sockets.add(ws);
        const box = mailbox();
        const emit = (...args) => ws.send('42' + JSON.stringify(args));
        return new Promise((resolve, reject) => {
            ws.once('error', reject);
            ws.on('message', (raw) => {
                const text = raw.toString();
                if (text.startsWith('0')) ws.send('40');
                else if (text === '2') ws.send('3');
                else if (text.startsWith('40')) resolve({
                    join: (roomId) => emit('join-room', roomId),
                    signal: (signal) => emit('signal', { signal }),
                    next: box.next,
                    close: () => ws.close(),
                });
                else if (text.startsWith('44')) reject(new Error(`io.use refused ${address}: ${text}`));
                else if (text.startsWith('42')) {
                    const [type, data] = JSON.parse(text.slice(2));
                    box.push(type, data);
                }
            });
        });
    }

    // A real pairing as the server sees it, then the receiver leaves. Each
    // await is the server's own answer, so every step has been processed
    // before the next one starts.
    async function pairThenLeave(sender, receiver, roomId) {
        sender.join(roomId);
        assert.deepEqual((await sender.next(['room-joined', 'room-full'])).data, { role: 'sender' });
        receiver.join(roomId);
        assert.deepEqual((await receiver.next(['room-joined', 'room-full'])).data, { role: 'receiver' });
        await sender.next(['user-connected']);
        sender.signal({ type: 'offer' });
        await receiver.next(['signal']);
        receiver.signal({ type: 'answer' });
        await sender.next(['signal']);
        receiver.close();
        await sender.next(['peer-disconnected']); // seat two is free again
    }

    async function joinOutcome(peer, roomId) {
        peer.join(roomId);
        return peer.next(['room-joined', 'room-full']);
    }

    it('/ws carries each connection its own key', async () => {
        const roomId = randomUUID();
        await pairThenLeave(await wsPeer('198.51.100.1'), await wsPeer('198.51.100.2'), roomId);

        const third = await joinOutcome(await wsPeer('198.51.100.3'), roomId);
        const back = await joinOutcome(await wsPeer('198.51.100.2'), roomId);

        assert.deepEqual(third, { type: 'room-full', data: {} }, 'a third address after the pair');
        assert.deepEqual(back, { type: 'room-joined', data: { role: 'receiver' } }, 'the receiver\'s own address');
    });

    it('Socket.IO carries each connection its own key', async () => {
        const roomId = randomUUID();
        await pairThenLeave(await sioPeer('198.51.100.11'), await sioPeer('198.51.100.12'), roomId);

        const third = await joinOutcome(await sioPeer('198.51.100.13'), roomId);
        const back = await joinOutcome(await sioPeer('198.51.100.12'), roomId);

        assert.deepEqual(third, { type: 'room-full', data: {} }, 'a third address after the pair');
        assert.deepEqual(back, { type: 'room-joined', data: { role: 'receiver' } }, 'the receiver\'s own address');
    });
});

// ---------------------------------------------------------------------------
// Code lifecycle and the per-key failed-resolve budget
// ---------------------------------------------------------------------------

describe('code lifecycle', () => {
    beforeEach(() => {
        rooms.clear();
        roomMeta.clear();
        codeToRoom.clear();
        roomToCode.clear();
        codeFailures.clear();
        policyStore.apply(DEFAULT_POLICY);
    });

    // Register through the shipped handler, never by hand, so every test starts
    // from the reverse index production actually builds.
    function register(roomId) {
        const res = fakeRes();
        registerCodeHandler({ body: { roomId } }, res);
        assert.equal(res.statusCode, 200, 'registration should succeed');
        return res.body.code;
    }

    function resolve(code, ip = '1.2.3.4') {
        const res = fakeRes();
        resolveCodeHandler({ params: { code }, ip }, res);
        return res;
    }

    it('a paired room retires its code', () => {
        const code = register(ROOM_ID);
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');

        handleJoinRoom(pA, ROOM_ID);
        assert.equal(codeToRoom.has(code), true, 'the first seat must not retire the code');

        handleJoinRoom(pB, ROOM_ID);

        assert.equal(codeToRoom.has(code), false, 'both maps should have dropped it');
        assert.equal(roomToCode.has(ROOM_ID), false);
        assert.equal(resolve(code).statusCode, 404);
    });

    it('pre-join retry survives', () => {
        // A receiver resolves, fails before it can take a seat (a 429 on ICE
        // credentials, an output path it cannot write, --relay-only against a
        // relay-less server) and resolves again. Both answers are the same 200,
        // and neither is charged against the budget.
        const code = register(ROOM_ID);

        const first = resolve(code);
        const second = resolve(code);

        assert.equal(first.statusCode, 200);
        assert.equal(second.statusCode, 200);
        assert.equal(first.body.roomId, ROOM_ID);
        assert.equal(second.body.roomId, ROOM_ID);
        assert.equal(codeFailures.size, 0, 'a hit must cost nothing');
    });

    it('an emptied room forgets its code', () => {
        const code = register(ROOM_ID);
        const pA = makePeer('peer-A');
        handleJoinRoom(pA, ROOM_ID);

        handleDisconnect(pA); // the sole peer leaving destroys the room

        assert.equal(resolve(code).statusCode, 404);
        assert.equal(codeToRoom.size, 0);
        assert.equal(roomToCode.size, 0);
    });

    it('a second POST for the same room retires the first code', () => {
        const first = register(ROOM_ID);
        const second = register(ROOM_ID);

        // generateCode may in principle re-mint the phrase it just retired, so
        // the collision-proof statement of "one live code per room" is the size
        // of the table, not an inequality between the two phrases.
        assert.equal(codeToRoom.size, 1, 'one live code per room');
        assert.equal(roomToCode.get(ROOM_ID), second);
        assert.equal(resolve(second).statusCode, 200);
        if (second !== first) {
            assert.equal(resolve(first).statusCode, 404, 'the first code must be retired');
        }
    });

    it('the failure budget precedes the lookup', () => {
        const code = register(ROOM_ID);
        for (let i = 0; i < 10; i++) {
            assert.equal(resolve(`miss-${i}-code`).statusCode, 404, `miss ${i} should be a plain 404`);
        }

        // The code is live, so only an order bug can answer anything but 429.
        const res = resolve(code);

        assert.equal(res.statusCode, 429);
        assert.deepEqual(res.body, { error: 'Too many requests' });
        assert.equal('roomId' in res.body, false, 'the refusal must not carry a room id');
        assert.equal(codeToRoom.has(code), true, 'a refused request must not consume the code');
    });

    it('a miss records one failure for the caller only and keeps the 404 body', () => {
        const res = resolve('nope-nope-nope', '1.2.3.4');

        assert.equal(res.statusCode, 404);
        // Unchanged wording: cli/engine/code/client.go branches on this 404.
        assert.deepEqual(res.body, { error: 'Code not found or expired' });
        assert.equal(codeFailures.get(rateKey('1.2.3.4')).length, 1);

        const other = resolve('nope-nope-nope', '5.6.7.8');

        assert.equal(other.statusCode, 404, 'a different key keeps its own budget');
        assert.equal(codeFailures.get(rateKey('1.2.3.4')).length, 1);
        assert.equal(codeFailures.get(rateKey('5.6.7.8')).length, 1);
    });

    it('a room emptied by its peer moving on forgets its code', () => {
        // The second of the two destroyRoom sites: the leave-first block in
        // handleJoinRoom, not handleDisconnect. No shipped client reaches it
        // with a code today, so this pins the seam for P0-10 and S1-SRV-02,
        // which both edit it.
        const other = '11111111-2222-4333-8444-555555555555';
        const code = register(ROOM_ID);
        const p = makePeer('peer-A');
        handleJoinRoom(p, ROOM_ID);

        handleJoinRoom(p, other); // leave-first empties ROOM_ID

        assert.equal(resolve(code).statusCode, 404);
        assert.equal(roomToCode.size, 0);
    });

    it('resolving an expired code drops both index entries', () => {
        // Pins dropCode on the resolve path. The sweeper calls the same helper
        // for the same reason (the reverse index must never outlive the forward
        // one), but the cleanup interval is not exported, so this is the only
        // call site a unit test can reach.
        const code = register(ROOM_ID);
        codeToRoom.set(code, { roomId: ROOM_ID, expires: Date.now() - 1 });

        assert.equal(resolve(code).statusCode, 404);

        assert.equal(codeToRoom.size, 0);
        assert.equal(roomToCode.size, 0, 'a forward-only delete would leave this at 1');
    });

    it('the budget counts under rateKey, not the raw address', () => {
        // Swapping rateKey(req.ip) for req.ip keeps every other test green,
        // because they all pass IPv4 literals, for which rateKey is identity.
        // It would hand every IPv6 host an unlimited supply of budgets.
        resolve('nope-nope-nope', '2001:db8::1');
        resolve('nope-nope-nope', '2001:db8:0:0:dead::2');

        assert.equal(codeFailures.size, 1, 'one /64 is one budget');
        assert.equal(codeFailures.get(rateKey('2001:db8::1')).length, 2);

        resolve('nope-nope-nope', '::ffff:1.2.3.4');
        resolve('nope-nope-nope', '1.2.3.4');

        assert.equal(codeFailures.get('1.2.3.4').length, 2, 'mapped IPv4 shares with plain IPv4');
        assert.equal(codeFailures.size, 2);
    });
});

// ---------------------------------------------------------------------------
// Stats reporting — validateReportBytes
// ---------------------------------------------------------------------------

describe('validateReportBytes', () => {
    const MAX = 5 * 1024 ** 4; // 5 TiB

    it('accepts a valid byte count', () => {
        assert.equal(validateReportBytes(1024, MAX), true);
    });

    it('accepts exactly the maximum', () => {
        assert.equal(validateReportBytes(MAX, MAX), true);
    });

    it('rejects zero', () => {
        assert.equal(validateReportBytes(0, MAX), false);
    });

    it('rejects a negative number', () => {
        assert.equal(validateReportBytes(-1, MAX), false);
    });

    it('rejects a float', () => {
        assert.equal(validateReportBytes(1.5, MAX), false);
    });

    it('rejects a value above the cap', () => {
        assert.equal(validateReportBytes(MAX + 1, MAX), false);
    });

    it('rejects non-numeric input', () => {
        assert.equal(validateReportBytes('1000', MAX), false);
        assert.equal(validateReportBytes(null, MAX), false);
        assert.equal(validateReportBytes(undefined, MAX), false);
    });
});

// ---------------------------------------------------------------------------
// Stats rate limiter cleanup
// ---------------------------------------------------------------------------

describe('statsRateLimits', () => {
    beforeEach(() => { statsRateLimits.clear(); });

    it('is exported and starts empty', () => {
        assert.equal(statsRateLimits.size, 0);
    });
});

// ---------------------------------------------------------------------------
// Rate limiting — checkRateLimit
// ---------------------------------------------------------------------------

describe('checkRateLimit', () => {
    beforeEach(() => { connectionCounts.clear(); });

    it('allows up to 30 connections from the same IP', () => {
        for (let i = 0; i < 30; i++) {
            assert.equal(checkRateLimit('1.2.3.4'), true, `attempt ${i + 1} should be allowed`);
        }
    });

    it('blocks the 31st connection from the same IP within the window', () => {
        for (let i = 0; i < 30; i++) checkRateLimit('1.2.3.4');
        assert.equal(checkRateLimit('1.2.3.4'), false);
    });

    it('tracks different IPs independently', () => {
        for (let i = 0; i < 30; i++) checkRateLimit('1.1.1.1');
        assert.equal(checkRateLimit('2.2.2.2'), true);
    });

    it('rejected attempts do not extend the lockout', (t) => {
        let now = 0;
        t.mock.method(Date, 'now', () => now);
        for (let i = 0; i < 30; i++) assert.equal(checkRateLimit('1.2.3.4'), true);
        // 200 refused attempts spread across the rest of the window.
        for (let i = 0; i < 200; i++) {
            now = 1000 + Math.floor((i * 58000) / 199);
            assert.equal(checkRateLimit('1.2.3.4'), false, `refused attempt ${i + 1} at ${now} ms`);
        }
        now = 60001;
        assert.equal(checkRateLimit('1.2.3.4'), true, 'admitted once the first admissions age out');
    });

    it('thirty clients behind one key reconnect after a restart', (t) => {
        let now = 0;
        t.mock.method(Date, 'now', () => now);
        // 50 clients behind one NAT reconnect after a restart (beforeEach cleared
        // the map): 30 get in within a second.
        for (let i = 0; i < 30; i++) {
            now = i * 33;
            assert.equal(checkRateLimit('203.0.113.9'), true, `client ${i + 1}`);
        }
        // The other 20 retry every 2 s for the rest of the window and are refused.
        for (now = 2000; now < 60000; now += 2000) {
            for (let c = 0; c < 20; c++) {
                assert.equal(checkRateLimit('203.0.113.9'), false, `straggler ${c + 1} at ${now} ms`);
            }
        }
        // Once the first thirty age out, every straggler gets in.
        now = 61000;
        for (let c = 0; c < 20; c++) {
            assert.equal(checkRateLimit('203.0.113.9'), true, `straggler ${c + 1} after the window`);
        }
    });
});

// ---------------------------------------------------------------------------
// Generic per-IP rate limiter middleware — makeRateLimiter
// ---------------------------------------------------------------------------

describe('makeRateLimiter', () => {
    it('allows up to max requests then returns 429', () => {
        const map = new Map();
        const limiter = makeRateLimiter(map, 60000, 3);
        let allowed = 0;
        for (let i = 0; i < 3; i++) {
            const res = fakeRes();
            limiter({ ip: '1.2.3.4' }, res, () => { allowed++; });
            assert.equal(res.statusCode, 200, `request ${i + 1} should pass`);
        }
        assert.equal(allowed, 3);

        const res = fakeRes();
        let nextCalled = false;
        limiter({ ip: '1.2.3.4' }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false, 'over-limit request must not call next()');
        assert.equal(res.statusCode, 429);
    });

    it('tracks different IPs independently', () => {
        const map = new Map();
        const limiter = makeRateLimiter(map, 60000, 1);
        limiter({ ip: '1.1.1.1' }, fakeRes(), () => {}); // exhaust IP 1's budget

        const res = fakeRes();
        let allowed = false;
        limiter({ ip: '2.2.2.2' }, res, () => { allowed = true; });
        assert.equal(allowed, true, 'a different IP must still be allowed');
        assert.equal(res.statusCode, 200);
    });
});

// ---------------------------------------------------------------------------
// Code endpoint rate limiter map
// ---------------------------------------------------------------------------

describe('codeRateLimits', () => {
    beforeEach(() => { codeRateLimits.clear(); });

    it('is exported and starts empty', () => {
        assert.equal(codeRateLimits.size, 0);
    });
});

// ---------------------------------------------------------------------------
// selectMinimalIceUrls
// ---------------------------------------------------------------------------

describe('selectMinimalIceUrls', () => {
    // The exact shape Cloudflare's generate-ice-servers returned in production.
    const cfStun = [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.cloudflare.com:53',
    ];
    const cfTurn = [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
    ];

    it('reduces the Cloudflare production list to one URL per class', () => {
        const { stunUrls, turnUrls } = selectMinimalIceUrls(cfStun, cfTurn);
        assert.deepEqual(stunUrls, ['stun:stun.cloudflare.com:3478']);
        assert.deepEqual(turnUrls, [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
        ]);
    });

    it('prefers the :3478 STUN URL regardless of order', () => {
        const { stunUrls } = selectMinimalIceUrls(
            ['stun:x:53', 'stun:x:3478'], []
        );
        assert.deepEqual(stunUrls, ['stun:x:3478']);
    });

    it('treats a turn: URL without a transport param as UDP (RFC 7065 default)', () => {
        const { turnUrls } = selectMinimalIceUrls([], ['turn:host:3478', 'turns:host:5349']);
        assert.deepEqual(turnUrls, ['turn:host:3478', 'turns:host:5349']);
    });

    it('falls back to any turns: URL when no :443 variant exists', () => {
        const { turnUrls } = selectMinimalIceUrls([], [
            'turn:host:3478?transport=udp',
            'turns:host:5349?transport=tcp',
        ]);
        assert.deepEqual(turnUrls, [
            'turn:host:3478?transport=udp',
            'turns:host:5349?transport=tcp',
        ]);
    });

    it('falls back to turn tcp when no turns: URL exists at all', () => {
        const { turnUrls } = selectMinimalIceUrls([], [
            'turn:host:80?transport=tcp',
        ]);
        assert.deepEqual(turnUrls, ['turn:host:80?transport=tcp']);
    });

    it('handles empty inputs', () => {
        const { stunUrls, turnUrls } = selectMinimalIceUrls([], []);
        assert.deepEqual(stunUrls, []);
        assert.deepEqual(turnUrls, []);
    });

    it('never returns duplicate TURN URLs', () => {
        const { turnUrls } = selectMinimalIceUrls([], ['turn:only:3478?transport=udp']);
        assert.deepEqual(turnUrls, ['turn:only:3478?transport=udp']);
    });
});

// ---------------------------------------------------------------------------
// Final error handler — errorHandler
// ---------------------------------------------------------------------------

describe('errorHandler', () => {
    function fakeRes() {
        return {
            statusCode: 200,
            body: null,
            headersSent: false,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; return this; },
        };
    }

    // Silence the deliberate console.error while these run; restore after.
    let realError;
    beforeEach(() => {
        realError = console.error;
        console.error = () => {};
    });
    after(() => { console.error = realError; });

    // The real shape body-parser produces for a malformed JSON body: a
    // SyntaxError carrying a filesystem-path stack, tagged status 400.
    function malformedBodyError() {
        const err = new SyntaxError("Expected property name or '}' in JSON at position 1");
        err.status = 400;
        err.statusCode = 400;
        err.expose = true;
        err.type = 'entity.parse.failed';
        err.stack = [
            "SyntaxError: Expected property name or '}' in JSON at position 1",
            '    at JSON.parse (<anonymous>)',
            '    at parse (/home/azureuser/floe/server/node_modules/body-parser/lib/types/json.js:91:21)',
            '    at /home/azureuser/floe/server/node_modules/body-parser/lib/read.js:162:18',
        ].join('\n');
        return err;
    }

    it('never puts a stack, a filesystem path, or a source location in the body', () => {
        const res = fakeRes();
        errorHandler(malformedBodyError(), {}, res, () => {});

        const serialized = JSON.stringify(res.body);
        // These three are the leak, asserted independently of NODE_ENV. Express's
        // built-in handler emits err.stack whenever env is not exactly
        // 'production' and never consults err.expose, so a 400 leaks as readily
        // as a 500. This is the regression guard for that.
        assert.ok(!serialized.includes('/'), `body must contain no path separator: ${serialized}`);
        assert.ok(!serialized.includes('.js:'), `body must contain no source location: ${serialized}`);
        assert.ok(!/\bat\s/.test(serialized), `body must contain no stack frame: ${serialized}`);
        assert.ok(!serialized.includes('azureuser'), 'body must not name the deploy user');
    });

    it('preserves a client-error status and answers with JSON', () => {
        const res = fakeRes();
        errorHandler(malformedBodyError(), {}, res, () => {});
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { error: 'Bad request' });
    });

    it('reports anything without a usable status as a 500', () => {
        for (const err of [new Error('Not allowed by CORS'), null, undefined, 'a string', { status: 99 }, { status: 700 }]) {
            const res = fakeRes();
            errorHandler(err, {}, res, () => {});
            assert.equal(res.statusCode, 500, `unexpected status for ${JSON.stringify(err)}`);
            assert.deepEqual(res.body, { error: 'Internal server error' });
        }
    });

    it('does not write once headers are already flushed', () => {
        const res = fakeRes();
        res.headersSent = true;
        errorHandler(malformedBodyError(), {}, res, () => {});
        assert.equal(res.statusCode, 200, 'must not touch the status mid-response');
        assert.equal(res.body, null, 'must not append a second body');
    });
});

// ---------------------------------------------------------------------------
// WebSocket liveness and backpressure
// ---------------------------------------------------------------------------

// The fields heartbeatTick, handlePong and createWSPeer().send touch, and
// nothing else. A real ws socket needs a real TCP peer; these three functions
// only read readyState and bufferedAmount and only call ping, send and
// terminate, so a plain object records exactly what each one did.
function fakeWS(overrides = {}) {
    return {
        peerId: 'peer-1',
        isAlive: true,
        pingNonce: null,
        readyState: 1, // WebSocket.OPEN
        bufferedAmount: 0,
        pings: [],
        sent: [],
        terminated: 0,
        ping(payload) { this.pings.push(payload); },
        send(frame) { this.sent.push(frame); },
        terminate() { this.terminated++; },
        ...overrides,
    };
}

describe('handlePong', () => {
    it('a socket that echoes the nonce survives two ticks', () => {
        const ws = fakeWS();

        heartbeatTick([ws]);
        handlePong(ws, ws.pings[0]);
        assert.equal(ws.isAlive, true, 'the answered ping must mark the socket alive');

        heartbeatTick([ws]);
        handlePong(ws, ws.pings[1]);
        assert.equal(ws.isAlive, true);

        // The tick that would reap it if either answer had been missed.
        heartbeatTick([ws]);
        assert.equal(ws.terminated, 0, 'an answering socket is never terminated');
        assert.equal(ws.pings.length, 3);
    });

    it('unsolicited pongs do not keep a socket alive', () => {
        const ws = fakeWS();

        // A stream that arrives before any ping. Nothing is outstanding, so
        // there is nothing it can answer.
        for (let i = 0; i < 10; i++) handlePong(ws, Buffer.alloc(8, 0x41));
        assert.equal(ws.isAlive, true, 'no tick has run yet');

        heartbeatTick([ws]);
        assert.equal(ws.isAlive, false);

        // The attack: a pong every few milliseconds, each one the wrong bytes.
        // The flag-only design ("a pong counts while a ping is outstanding")
        // clears on the first of these; the nonce design does not.
        for (let i = 0; i < 10; i++) handlePong(ws, Buffer.alloc(8, 0x41));
        assert.equal(ws.isAlive, false, 'a pong that answers no ping must not count');

        heartbeatTick([ws]);
        assert.equal(ws.terminated, 1, 'the second tick must reap the silent socket');
    });

    it('a replay of the previous nonce is ignored', () => {
        const ws = fakeWS();

        heartbeatTick([ws]);
        const first = ws.pings[0];
        handlePong(ws, first);
        assert.equal(ws.isAlive, true);

        heartbeatTick([ws]);
        // Same bytes, but that nonce has already been spent and a new one is
        // outstanding. An eavesdropper replaying what it saw gains nothing.
        handlePong(ws, Buffer.from(first));
        assert.equal(ws.isAlive, false);

        heartbeatTick([ws]);
        assert.equal(ws.terminated, 1);
    });

    it('ignores a pong that is not a buffer or not the right length', () => {
        const ws = fakeWS();
        heartbeatTick([ws]);
        const nonce = ws.pings[0];

        handlePong(ws, undefined);
        handlePong(ws, nonce.toString('latin1'));
        handlePong(ws, Buffer.alloc(0));
        handlePong(ws, Buffer.concat([nonce, Buffer.from([0])]));
        assert.equal(ws.isAlive, false);

        handlePong(ws, nonce);
        assert.equal(ws.isAlive, true, 'the real answer still counts');
    });
});

describe('heartbeatTick', () => {
    it('a silent socket is terminated on the second tick', () => {
        const ws = fakeWS();

        heartbeatTick([ws]);
        assert.equal(ws.terminated, 0, 'the first tick only asks');
        assert.equal(ws.pings.length, 1);
        assert.equal(ws.isAlive, false);

        heartbeatTick([ws]);
        assert.equal(ws.terminated, 1);
        assert.equal(ws.pings.length, 1, 'a reaped socket is not pinged again');
    });

    it('the nonce changes every tick', () => {
        const ws = fakeWS();
        const seen = new Set();

        for (let i = 0; i < 8; i++) {
            heartbeatTick([ws]);
            const nonce = ws.pings[i];
            assert.ok(Buffer.isBuffer(nonce), 'the ping payload must be a buffer');
            assert.equal(nonce.length, 8);
            assert.equal(ws.pingNonce, nonce, 'the outstanding nonce is what was sent');
            seen.add(nonce.toString('hex'));
            handlePong(ws, nonce);
            assert.equal(ws.pingNonce, null, 'an answered nonce is spent');
        }

        assert.equal(seen.size, 8, 'a nonce is never reused');
    });

    it('reaps only the sockets that owe an answer', () => {
        const alive = fakeWS();
        const silent = fakeWS();

        heartbeatTick([alive, silent]);
        handlePong(alive, alive.pings[0]);
        heartbeatTick([alive, silent]);

        assert.equal(alive.terminated, 0);
        assert.equal(silent.terminated, 1);
    });
});

describe('createWSPeer backpressure', () => {
    it('send over the ceiling terminates and drops', () => {
        const ws = fakeWS({ bufferedAmount: WS_SEND_BUFFER_CEILING + 1 });
        const peer = createWSPeer(ws);

        peer.send('signal', { signal: 'x', sender: 'peer-2' });

        assert.equal(ws.sent.length, 0, 'nothing may be queued behind the ceiling');
        assert.equal(ws.terminated, 1, 'a target that is not draining is cut off');
    });

    it('send at the ceiling still delivers', () => {
        // Strictly greater-than, so the boundary value is deliverable.
        const ws = fakeWS({ bufferedAmount: WS_SEND_BUFFER_CEILING });
        const peer = createWSPeer(ws);

        peer.send('signal', { signal: 'x', sender: 'peer-2' });

        assert.equal(ws.terminated, 0);
        assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'signal', signal: 'x', sender: 'peer-2' });
    });

    it('a closed socket is dropped without being terminated again', () => {
        const ws = fakeWS({ readyState: 3, bufferedAmount: WS_SEND_BUFFER_CEILING + 1 });
        const peer = createWSPeer(ws);

        peer.send('signal', { signal: 'x' });

        assert.equal(ws.sent.length, 0);
        assert.equal(ws.terminated, 0, 'the readyState check still comes first');
    });

    it('the ceiling is one maxPayload frame', () => {
        // A whole signaling exchange is under 10 KB, so the ceiling is set by
        // the inbound frame limit, not by the traffic: one full frame may be in
        // flight, a second one means the target is not reading. The two numbers
        // are coupled, so pin both.
        assert.equal(WS_SEND_BUFFER_CEILING, 1e6);

        const source = require('node:fs').readFileSync(require.resolve('./server.js'), 'utf8');
        assert.match(source, /maxPayload: 1e6/, 'maxPayload must still be the 1 MB the ceiling mirrors');
    });
});

// ---------------------------------------------------------------------------
// Request-link policy file (server/policy.js) and /health features
// ---------------------------------------------------------------------------

describe('policy', () => {
    const FIXED_LINES = new Set([
        'request links: on',
        'request links: off',
        'policy file unreadable, keeping previous policy',
    ]);

    // Written the way the runbook says to edit it: a temp file renamed over the
    // real one, so a reader never sees half a file.
    function writePolicy(file, text) {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
    }

    // A store of its own on its own file, with the log lines captured.
    function store(name) {
        const file = path.join(POLICY_DIR, name);
        const lines = [];
        return { file, lines, s: createPolicyStore({ path: file, log: (l) => lines.push(l) }) };
    }

    function health() {
        const res = fakeRes();
        healthHandler({}, res);
        return res.body;
    }

    beforeEach(() => {
        rooms.clear();
        roomMeta.clear();
        fs.rmSync(POLICY_PATH, { force: true });
        policyStore.apply(DEFAULT_POLICY);
    });

    after(() => {
        fs.rmSync(POLICY_PATH, { force: true });
        policyStore.apply(DEFAULT_POLICY);
    });

    it('missing file means off', () => {
        const empty = createPolicyStore({ path: '', log: () => {} });
        assert.equal(empty.reload(), 'missing');
        assert.equal(empty.requestLinks(), false);

        const { file, s } = store('missing.json');
        assert.equal(s.reload(), 'missing');
        assert.equal(s.requestLinks(), false);

        // On, then the file goes away: off again, not the last good policy.
        writePolicy(file, '{"requestLinks":true}');
        assert.equal(s.reload(), 'ok');
        assert.equal(s.requestLinks(), true);
        fs.rmSync(file);
        assert.equal(s.reload(), 'missing');
        assert.equal(s.requestLinks(), false);
    });

    it('malformed JSON keeps the last good policy', () => {
        const { file, lines, s } = store('malformed.json');
        writePolicy(file, '{"requestLinks":true}');
        assert.equal(s.reload(), 'ok');

        const garbage = Buffer.from([0x00, 0xff, 0xfe, 0x7b, 0x80, 0x22]).toString('latin1');
        for (const bad of ['{"requestLinks": tru', '', garbage, 'null', '"string"', '[true]', '['.repeat(100000)]) {
            writePolicy(file, bad);
            assert.equal(s.reload(), 'error', JSON.stringify(bad.slice(0, 20)));
            assert.equal(s.requestLinks(), true, 'the last good policy must stand');
        }
        // One line for the whole failure streak, and only fixed text: never the
        // content, never the path.
        assert.deepEqual(lines, ['request links: on', 'policy file unreadable, keeping previous policy']);
        for (const l of lines) assert.ok(FIXED_LINES.has(l), l);
    });

    it('a file over 64 KB keeps the last good policy', () => {
        const { file, s } = store('big.json');
        writePolicy(file, '{"requestLinks":true}');
        assert.equal(s.reload(), 'ok');

        const big = JSON.stringify({ requestLinks: false, pad: 'x'.repeat(POLICY_MAX_BYTES) });
        assert.ok(Buffer.byteLength(big) > POLICY_MAX_BYTES);
        writePolicy(file, big);
        assert.equal(s.reload(), 'error');
        assert.equal(s.requestLinks(), true);

        // Exactly at the cap is still read.
        const head = '{"requestLinks":false,"pad":"';
        const exact = head + 'x'.repeat(POLICY_MAX_BYTES - head.length - 2) + '"}';
        assert.equal(Buffer.byteLength(exact), POLICY_MAX_BYTES);
        writePolicy(file, exact);
        assert.equal(s.reload(), 'ok');
        assert.equal(s.requestLinks(), false);
    });

    it('"requestLinks": "true" (a string) is off', () => {
        for (const v of ['"true"', '1', '"yes"', '{}', '[true]', 'null']) {
            const { policy } = parsePolicy(`{"requestLinks":${v}}`);
            assert.equal(policy.requestLinks, false, v);
        }
        assert.equal(parsePolicy('{"requestLinks":true}').policy.requestLinks, true);
        assert.equal(parsePolicy('{}').policy.requestLinks, false);
    });

    it('unknown keys are ignored', () => {
        const text = '{"requestLinks":true,"denyRateKeys":["198.51.100.23"],"portalLinks":true,' +
            '"__proto__":{"requestLinks":false},"nested":{"deep":[1,2,3]}}';
        const { policy, error } = parsePolicy(text);
        assert.equal(error, null);
        assert.deepEqual(Object.keys(policy), ['requestLinks']);
        assert.equal(policy.requestLinks, true);
        assert.ok(Object.isFrozen(policy));
        assert.ok(Object.isFrozen(DEFAULT_POLICY));
        assert.equal(DEFAULT_POLICY.requestLinks, false);
    });

    it('an unchanged stamp is not re-parsed', () => {
        const { file, s } = store('stamp.json');
        writePolicy(file, '{"requestLinks":true}');
        const real = fs.readFileSync;
        let reads = 0;
        fs.readFileSync = function (...args) {
            if (args[0] === file) reads++;
            return real.apply(this, args);
        };
        try {
            assert.equal(s.reload(), 'ok');
            assert.equal(s.reload(), 'unchanged');
            assert.equal(s.reload(), 'unchanged');
            assert.equal(reads, 1);
            writePolicy(file, '{"requestLinks":false}');
            assert.equal(s.reload(), 'ok');
            assert.equal(reads, 2);
            assert.equal(s.requestLinks(), false);
        } finally {
            fs.readFileSync = real;
        }
    });

    it('a same-size file renamed over the policy with the same mtime is read', () => {
        // CP-SE F1-2, the finder's case: cp -p, tar x, rsync -a and docker cp
        // keep the mtime, and these two files are both 22 bytes.
        const { file, lines, s } = store('same-size-rename.json');
        const on = '{"requestLinks":true }';
        const off = '{"requestLinks":false}';
        assert.equal(Buffer.byteLength(on), Buffer.byteLength(off));
        const t = new Date('2026-09-24T12:00:00.000Z');
        fs.writeFileSync(file, on);
        fs.utimesSync(file, t, t);
        assert.equal(s.reload(), 'ok');
        assert.equal(s.requestLinks(), true);
        const was = fs.statSync(file, { bigint: true });

        fs.writeFileSync(`${file}.tmp`, off);
        fs.utimesSync(`${file}.tmp`, t, t);
        fs.renameSync(`${file}.tmp`, file); // the runbook's edit
        const now = fs.statSync(file, { bigint: true });
        assert.equal(now.size, was.size);
        assert.equal(now.mtimeNs, was.mtimeNs);
        assert.notEqual(now.ino, was.ino, 'the rename put a new file at the path');

        assert.equal(s.reload(), 'ok');
        assert.equal(s.requestLinks(), false);
        assert.deepEqual(lines, ['request links: on', 'request links: off']);
    });

    it('a same-size edit in place with its mtime put back is read', async () => {
        // cp -p onto the policy file itself keeps the inode as well as the
        // mtime; the change time moves, and no user tool can set it back.
        const { file, s } = store('same-size-in-place.json');
        const t = new Date('2026-09-24T12:00:00.000Z');
        fs.writeFileSync(file, '{"requestLinks":true }');
        fs.utimesSync(file, t, t);
        assert.equal(s.reload(), 'ok');
        const was = fs.statSync(file, { bigint: true });
        // Past a tick of a coarse file clock, or the edit's change time can
        // equal the first write's (measured on NTFS: equal with no wait).
        await new Promise((r) => setTimeout(r, 200));

        fs.writeFileSync(file, '{"requestLinks":false}');
        fs.utimesSync(file, t, t);
        const now = fs.statSync(file, { bigint: true });
        assert.equal(now.ino, was.ino, 'the same file');
        assert.equal(now.size, was.size);
        assert.equal(now.mtimeNs, was.mtimeNs);

        assert.equal(s.reload(), 'ok');
        assert.equal(s.requestLinks(), false);
    });

    it('a new inode alone, or a new change time alone, is a changed file', () => {
        // Each identity field on its own, every other stat field held equal.
        // A real rename also moves the change time on every platform this
        // suite runs on, so only a stubbed stat can show the inode alone.
        const { file, s } = store('stamp-fields.json');
        fs.writeFileSync(file, '{"requestLinks":true }');
        const real = fs.statSync;
        const base = { num: real(file), big: real(file, { bigint: true }) };
        const bumped = new Set();
        fs.statSync = function (p, opts, ...rest) {
            if (p !== file) return real.call(this, p, opts, ...rest);
            const b = opts && opts.bigint ? base.big : base.num;
            const one = typeof b.ino === 'bigint' ? 1n : 1;
            const st = {
                isFile: () => true,
                ino: b.ino, size: b.size, mtimeMs: b.mtimeMs, mtimeNs: b.mtimeNs, ctimeMs: b.ctimeMs, ctimeNs: b.ctimeNs,
            };
            if (bumped.has('ino')) st.ino += one;
            if (bumped.has('ctime')) {
                st.ctimeMs += one;
                if (st.ctimeNs !== undefined) st.ctimeNs += 1_000_000n;
            }
            return st;
        };
        try {
            assert.equal(s.reload(), 'ok');
            assert.equal(s.reload(), 'unchanged', 'every field equal');

            fs.writeFileSync(file, '{"requestLinks":false}');
            bumped.add('ino');
            assert.equal(s.reload(), 'ok', 'a new inode alone');
            assert.equal(s.requestLinks(), false);

            fs.writeFileSync(file, '{"requestLinks":true }');
            bumped.add('ctime');
            assert.equal(s.reload(), 'ok', 'a new change time alone');
            assert.equal(s.requestLinks(), true);
            assert.equal(s.reload(), 'unchanged');
        } finally {
            fs.statSync = real;
        }
    });

    // The byte-order marks Windows tooling writes (CP-SE F1-3): PowerShell
    // 5.1's Set-Content -Encoding utf8 writes UTF-8 with one, and its > and
    // Out-File write UTF-16 LE with one.
    const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
    function writeBytes(file, bytes) {
        fs.writeFileSync(`${file}.tmp`, bytes);
        fs.renameSync(`${file}.tmp`, file);
    }

    it('a policy file with a byte-order mark is read, in UTF-8 and in UTF-16 LE', () => {
        const { file, lines, s } = store('bom.json');
        writePolicy(file, '{"requestLinks": true}');
        assert.equal(s.reload(), 'ok');

        writeBytes(file, Buffer.concat([UTF8_BOM, Buffer.from('{"requestLinks": false}')]));
        assert.equal(s.reload(), 'ok', 'UTF-8 with a BOM');
        assert.equal(s.requestLinks(), false);

        writeBytes(file, Buffer.concat([UTF16LE_BOM, Buffer.from('{"requestLinks": true}\r\n', 'utf16le')]));
        assert.equal(s.reload(), 'ok', 'UTF-16 LE with a BOM');
        assert.equal(s.requestLinks(), true);

        writeBytes(file, Buffer.concat([UTF16LE_BOM, Buffer.from('{"requestLinks": false}\r\n', 'utf16le')]));
        assert.equal(s.reload(), 'ok');
        assert.equal(s.requestLinks(), false);
        assert.deepEqual(lines, ['request links: on', 'request links: off', 'request links: on', 'request links: off']);

        // At boot too.
        const boot = store('bom-boot.json');
        writeBytes(boot.file, Buffer.concat([UTF8_BOM, Buffer.from('{"requestLinks": true}')]));
        assert.equal(boot.s.reload(), 'ok');
        assert.equal(boot.s.requestLinks(), true);
    });

    it('a malformed file with a byte-order mark keeps the last good policy, and fails closed at boot', () => {
        const off = '{"requestLinks": false}';
        const bad = [
            Buffer.concat([UTF8_BOM, Buffer.from('{"requestLinks": fals')]),
            Buffer.concat([UTF8_BOM, UTF8_BOM, Buffer.from(off)]), // one mark is stripped, not two
            Buffer.concat([UTF16LE_BOM, Buffer.from([0x7b, 0x00, 0x22])]), // an odd byte count
            Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(off, 'utf16le').swap16()]), // UTF-16 BE: not decoded
            Buffer.from(off, 'utf16le'), // UTF-16 LE without its mark
        ];
        const { file, lines, s } = store('bom-bad.json');
        writePolicy(file, '{"requestLinks": true}');
        assert.equal(s.reload(), 'ok');
        for (const bytes of bad) {
            writeBytes(file, bytes);
            assert.equal(s.reload(), 'error', bytes.toString('hex').slice(0, 24));
            assert.equal(s.requestLinks(), true, 'the last good policy must stand');
        }
        assert.deepEqual(lines, ['request links: on', 'policy file unreadable, keeping previous policy']);

        for (const bytes of bad) {
            const boot = store('bom-bad-boot.json');
            writeBytes(boot.file, bytes);
            assert.equal(boot.s.reload(), 'error');
            assert.equal(boot.s.requestLinks(), false, 'a server that never read a good file is off');
        }
    });

    it('a flip is visible within one cleanupTick without restart', () => {
        // The module's own store, the one /health and the request handlers
        // consult, pointed at POLICY_PATH before server.js was required.
        assert.equal(policyStore.requestLinks(), false);
        assert.deepEqual(health().features, []);

        writePolicy(POLICY_PATH, '{"requestLinks":true}');
        cleanupTick();
        assert.equal(policyStore.requestLinks(), true);
        assert.deepEqual(health().features, ['request-1']);

        writePolicy(POLICY_PATH, '{"requestLinks":false}');
        cleanupTick();
        assert.equal(policyStore.requestLinks(), false);
        assert.deepEqual(health().features, []);

        writePolicy(POLICY_PATH, '{"requestLinks":true}');
        cleanupTick();
        fs.rmSync(POLICY_PATH);
        cleanupTick();
        assert.equal(policyStore.requestLinks(), false, 'a deleted file fails closed');
        assert.deepEqual(health().features, []);
    });

    it("/health carries features [] while off and ['request-1'] while on", () => {
        policyStore.apply({ requestLinks: false });
        assert.deepEqual(health().features, []);
        policyStore.apply({ requestLinks: true });
        assert.deepEqual(health().features, ['request-1']);
        policyStore.apply({ requestLinks: 'true' });
        assert.deepEqual(health().features, []);
    });

    it('every existing /health field is unchanged', () => {
        const body = health();
        assert.equal(body.status, 'healthy');
        assert.equal(typeof body.uptime, 'number');
        assert.deepEqual(Object.keys(body), ['status', 'uptime', 'features']);
    });
});

// ---------------------------------------------------------------------------
// Request rooms: host join with token (handleHostJoin)
// ---------------------------------------------------------------------------

// A host token the way Floe Desktop makes one: 32 random bytes, base64url, 43
// characters.
function newToken() {
    return randomBytes(32).toString('base64url');
}

// Every describe that touches request rooms starts from nothing, with request
// links on unless the test says otherwise.
function resetRequestState(on = true) {
    rooms.clear();
    roomMeta.clear();
    if (requestRoomIds) requestRoomIds.clear();
    requestCreates.clear();
    roomToCode.clear();
    codeToRoom.clear();
    // The file says the same as the store, so a cleanupTick() inside a test
    // re-reads it without flipping (and purging) anything.
    fs.writeFileSync(POLICY_PATH, JSON.stringify({ requestLinks: on }));
    policyStore.apply({ requestLinks: on });
}

function hostJoin(peer, token, now) {
    handleHostJoin(peer, roomIdFromToken(token), token, now);
    return peer.msgs[peer.msgs.length - 1];
}

describe('handleHostJoin', () => {
    const T0 = 1_800_000_000_000;

    beforeEach(() => resetRequestState(true));
    after(() => resetRequestState(false));

    it('a valid token creates a request room and seats the host', () => {
        const token = newToken();
        const host = makePeer('host-1', '198.51.100.7');
        assert.deepEqual(hostJoin(host, token, T0), { type: 'room-joined', data: { role: 'host' } });

        const id = roomIdFromToken(token);
        const meta = roomMeta.get(id);
        assert.equal(meta.kind, 'request');
        assert.ok(Buffer.isBuffer(meta.hostTokenHash));
        assert.equal(meta.hostTokenHash.length, 32);
        assert.deepEqual(meta.hostTokenHash, createHash('sha256').update(token, 'utf8').digest());
        assert.equal(meta.hostPeerId, 'host-1');
        assert.equal(meta.sealed, false);
        assert.equal(meta.createdAt, T0);
        assert.equal(meta.hostAbsentSince, null);
        assert.equal(meta.keys.size, 0, 'a join never counts toward the seal');
        assert.deepEqual(rooms.get(id), [host]);
        assert.equal(host.roomId, id);

        // Nothing in the record is the token or the address.
        for (const [k, v] of Object.entries(meta)) {
            assert.notEqual(v, token, `meta.${k} holds the token`);
            assert.notEqual(v, '198.51.100.7', `meta.${k} holds the address`);
        }
        assert.ok(!JSON.stringify([...Object.values(meta)]).includes('198.51.100.7'));
        for (const k of requestCreates.keys()) assert.notEqual(k, '198.51.100.7');
        assert.equal(host.msgs.length, 1);
    });

    it('a roomId that is not the derivation of its token is refused and creates nothing', () => {
        // The shared vectors, generated independently of this code.
        const vectors = require('../cli/engine/signaling/testdata/derivation-vectors.json').vectors;
        assert.equal(vectors.length, 3);
        for (const v of vectors) assert.equal(roomIdFromToken(v.hostToken), v.roomId, v.hostToken);

        const token = newToken();
        const host = makePeer('host-1', 'k1');
        for (const roomId of [randomUUID(), vectors[0].roomId, roomIdFromToken(newToken())]) {
            handleHostJoin(host, roomId, token, T0);
            assert.deepEqual(host.msgs.pop(), { type: 'error', data: { message: 'Invalid host token' } });
        }
        assert.equal(rooms.size, 0);
        assert.equal(roomMeta.size, 0);
        assert.equal(requestCreates.size, 0);

        // The derivation runs before the policy: a foreign token learns nothing
        // about whether request links are on.
        policyStore.apply({ requestLinks: false });
        handleHostJoin(host, randomUUID(), token, T0);
        assert.deepEqual(host.msgs.pop(), { type: 'error', data: { message: 'Invalid host token' } });
        handleHostJoin(host, roomIdFromToken(token), token, T0);
        assert.deepEqual(host.msgs.pop(), { type: 'refused', data: { code: 'disabled' } });
        policyStore.apply({ requestLinks: true });

        // A vector token with its own id is accepted, in either case, and the
        // room lives under the lowercase spelling.
        const v = vectors[2];
        handleHostJoin(host, v.roomId.toUpperCase(), v.hostToken, T0);
        assert.deepEqual(host.msgs.pop(), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(roomMeta.get(v.roomId).kind, 'request');
        assert.equal(host.roomId, v.roomId);
    });

    it('after endReservation a different token cannot create that roomId and the original can', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host-1', 'k1');
        hostJoin(host, token, T0);
        endReservation(id);
        assert.equal(roomMeta.size, 0);
        assert.equal(rooms.size, 0);
        assert.equal(host.roomId, null);

        const thief = makePeer('thief', 'k2');
        handleHostJoin(thief, id, newToken(), T0);
        assert.deepEqual(thief.msgs.pop(), { type: 'error', data: { message: 'Invalid host token' } });
        assert.equal(roomMeta.size, 0);

        const back = makePeer('host-2', 'k1');
        assert.deepEqual(hostJoin(back, token, T0 + 1), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(roomMeta.get(id).hostPeerId, 'host-2');
    });

    it('plain join-room into a reserved room answers room-full in grace and when present', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host-1', 'k1');
        hostJoin(host, token, T0);

        const joiner = makePeer('joiner', 'k2');
        handleJoinRoom(joiner, id);
        assert.deepEqual(joiner.msgs.pop(), { type: 'room-full', data: {} });
        handleJoinRoom(joiner, id.toUpperCase());
        assert.deepEqual(joiner.msgs.pop(), { type: 'room-full', data: {} });
        assert.deepEqual(rooms.get(id), [host], 'the room stays at one seat');
        assert.equal(joiner.roomId, null);

        // The host goes away: the room array is gone, the reservation stays.
        handleDisconnect(host);
        assert.equal(rooms.has(id), false);
        assert.equal(roomMeta.get(id).kind, 'request');
        handleJoinRoom(joiner, id);
        assert.deepEqual(joiner.msgs.pop(), { type: 'room-full', data: {} });
        assert.equal(rooms.has(id), false, 'no room is created in grace');
        assert.equal(joiner.roomId, null);

        // A refused joiner keeps the seat it already had.
        const other = randomUUID();
        handleJoinRoom(joiner, other);
        assert.equal(joiner.roomId, other);
        handleJoinRoom(joiner, id);
        assert.deepEqual(joiner.msgs.pop(), { type: 'room-full', data: {} });
        assert.equal(joiner.roomId, other);
    });

    it('the same token reclaims within grace without a user-connected and without a count', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host-1', 'k1');
        hostJoin(host, token, T0);
        handleDisconnect(host);
        const meta = roomMeta.get(id);
        // What the disconnect block records for a departed host.
        meta.hostPeerId = null;
        meta.hostAbsentSince = T0 + 1000;

        const back = makePeer('host-2', 'k1');
        assert.deepEqual(hostJoin(back, token, T0 + 1000 + REQUEST_GRACE_MS), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(back.msgs.length, 1);
        assert.ok(!back.msgs.some(m => m.type === 'user-connected'));
        assert.equal(meta.hostPeerId, 'host-2');
        assert.equal(meta.hostAbsentSince, null);
        assert.equal(roomMeta.get(id), meta, 'the same reservation, not a new one');
        assert.deepEqual(rooms.get(id), [back]);
        assert.equal(createsInWindow('k1', T0 + 2000), 1, 'a reclaim is not a create');
    });

    it('reclaim after grace is a counted fresh create and the sweep deletes an unreclaimed reservation', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host-1', 'k1');
        hostJoin(host, token, T0);
        handleDisconnect(host);
        roomMeta.get(id).hostPeerId = null;
        roomMeta.get(id).hostAbsentSince = T0;

        const late = T0 + REQUEST_GRACE_MS + 1;
        const back = makePeer('host-2', 'k1');
        assert.deepEqual(hostJoin(back, token, late), { type: 'room-joined', data: { role: 'host' } });
        const fresh = roomMeta.get(id);
        assert.equal(fresh.createdAt, late, 'a fresh reservation');
        assert.equal(createsInWindow('k1', late), 2, 'a re-create counts (E-34)');

        // The sweep: a second reservation whose host never returns.
        const other = newToken();
        const otherId = roomIdFromToken(other);
        const h2 = makePeer('host-3', 'k3');
        hostJoin(h2, other, T0);
        handleDisconnect(h2);
        roomMeta.get(otherId).hostPeerId = null;
        roomMeta.get(otherId).hostAbsentSince = T0;
        cleanupTick(T0 + REQUEST_GRACE_MS);
        assert.ok(roomMeta.has(otherId), 'not before the grace has passed');
        cleanupTick(T0 + REQUEST_GRACE_MS + 60_000);
        assert.equal(roomMeta.has(otherId), false);
        assert.ok(roomMeta.has(id), 'a seated host is never swept');
    });

    it('a wrong token of valid shape gets error Invalid host token', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host-1', 'k1');
        hostJoin(host, token, T0);
        const before = { ...roomMeta.get(id) };

        const wrong = makePeer('wrong', 'k2');
        handleHostJoin(wrong, id, newToken(), T0);
        assert.deepEqual(wrong.msgs, [{ type: 'error', data: { message: 'Invalid host token' } }]);
        assert.deepEqual({ ...roomMeta.get(id) }, before);
        assert.deepEqual(rooms.get(id), [host]);
        assert.equal(wrong.roomId, null);
    });

    it('newest host wins', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const a = makePeer('host-a', 'k1');
        hostJoin(a, token, T0);

        const a2 = makePeer('host-a2', 'k1');
        assert.deepEqual(hostJoin(a2, token, T0 + 5), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(a.roomId, null, 'the ghost loses its seat');
        assert.deepEqual(rooms.get(id), [a2]);
        const meta = roomMeta.get(id);
        assert.equal(meta.hostPeerId, 'host-a2');

        // The ghost's late close changes nothing and tells nobody.
        handleDisconnect(a);
        assert.deepEqual(rooms.get(id), [a2]);
        assert.equal(meta.hostPeerId, 'host-a2');
        assert.equal(meta.hostAbsentSince, null);
        assert.equal(a2.msgs.length, 1);
        assert.equal(createsInWindow('k1', T0 + 10), 1);
    });

    it('20 creates per rateKey per rolling 24 h, the 21st gets limited, another key unaffected, reclaims not counted, allowed again after 24 h', () => {
        // Two addresses in one IPv6 /64 are one rate key, so they share one budget.
        const key = rateKey('2001:db8:1:2::1');
        assert.equal(rateKey('2001:db8:1:2::ffff'), key);
        const tokens = [];
        for (let i = 0; i < REQUEST_CREATES_PER_DAY; i++) {
            const t = newToken();
            tokens.push(t);
            const p = makePeer(`h${i}`, rateKey(i % 2 ? '2001:db8:1:2::1' : '2001:db8:1:2::ffff'));
            assert.deepEqual(hostJoin(p, t, T0 + i), { type: 'room-joined', data: { role: 'host' } }, `create ${i + 1}`);
        }
        assert.equal(createsInWindow(key, T0 + 100), 20);

        const extra = makePeer('h21', key);
        const extraToken = newToken();
        assert.deepEqual(hostJoin(extra, extraToken, T0 + 100), { type: 'refused', data: { code: 'limited' } });
        assert.equal(roomMeta.has(roomIdFromToken(extraToken)), false);
        assert.equal(extra.roomId, null);

        const elsewhere = makePeer('other', rateKey('2001:db8:9:9::1'));
        assert.deepEqual(hostJoin(elsewhere, newToken(), T0 + 100), { type: 'room-joined', data: { role: 'host' } });

        // A reclaim by the exhausted key still works and costs nothing.
        const re = makePeer('h0-again', key);
        assert.deepEqual(hostJoin(re, tokens[0], T0 + 200), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(createsInWindow(key, T0 + 200), 20);

        // 24 h after the first create, one slot is free again.
        const day = T0 + REQUEST_CREATE_WINDOW_MS;
        assert.deepEqual(hostJoin(extra, extraToken, day), { type: 'room-joined', data: { role: 'host' } });
        assert.deepEqual(hostJoin(makePeer('h22', key), newToken(), day), { type: 'refused', data: { code: 'limited' } });

        // The budget is keyed by a digest, never by the key.
        for (const k of requestCreates.keys()) assert.ok(!k.includes('2001:db8'), k);
    });

    it('MAX_REQUEST_ROOMS refuses the next create with limited', () => {
        for (let i = 0; i < MAX_REQUEST_ROOMS; i++) {
            roomMeta.set(`fill-${i}`, { keys: new Set(), kind: 'request', hostPeerId: null, hostAbsentSince: T0, sealed: false });
            requestRoomIds.add(`fill-${i}`);
        }
        assert.equal(countRequestRooms(), MAX_REQUEST_ROOMS);
        const host = makePeer('host', 'k1');
        const token = newToken();
        assert.deepEqual(hostJoin(host, token, T0), { type: 'refused', data: { code: 'limited' } });
        assert.equal(roomMeta.has(roomIdFromToken(token)), false);
        assert.equal(requestCreates.size, 0, 'a refused create is not recorded');

        // Ordinary rooms are untouched by the cap.
        const a = makePeer('a', 'x');
        handleJoinRoom(a, randomUUID());
        assert.deepEqual(a.msgs.pop(), { type: 'room-joined', data: { role: 'sender' } });
    });

    it('a refused create at a full cap does not walk roomMeta', () => {
        for (let i = 0; i < MAX_REQUEST_ROOMS; i++) {
            roomMeta.set(`fill-${i}`, { keys: new Set(), kind: 'request', hostPeerId: null, hostAbsentSince: T0, sealed: false });
            requestRoomIds.add(`fill-${i}`);
        }
        let walks = 0;
        const counted = (name) => function (...args) { walks++; return Map.prototype[name].apply(this, args); };
        roomMeta.values = counted('values');
        roomMeta.entries = counted('entries');
        roomMeta.keys = counted('keys');
        roomMeta.forEach = counted('forEach');
        roomMeta[Symbol.iterator] = counted(Symbol.iterator);
        try {
            const host = makePeer('host', '203.0.113.77');
            for (let i = 0; i < 3; i++) {
                assert.deepEqual(hostJoin(host, newToken(), T0), { type: 'refused', data: { code: 'limited' } });
            }
        } finally {
            for (const k of ['values', 'entries', 'keys', 'forEach']) delete roomMeta[k];
            delete roomMeta[Symbol.iterator];
        }
        assert.equal(walks, 0);
    });

    it('the request-room count matches a walk after every kind of create and end', () => {
        const check = (what) => assert.equal(requestRoomIds.size, countRequestRooms(), what);
        const live = [];
        for (let i = 0; i < 12; i++) {
            const token = newToken();
            const host = makePeer(`h${i}`, `k${i}`);
            hostJoin(host, token, T0);
            live.push({ token, id: roomIdFromToken(token), host });
            check(`create ${i}`);
        }
        const plain = makePeer('plain', 'kp');
        handleJoinRoom(plain, randomUUID());
        check('an ordinary room');
        handleRequestControl(live[0].host, 'request-close', live[0].id);
        check('request-close');
        endReservation(live[1].id);
        check('endReservation');
        handleDisconnect(live[2].host, T0);
        check('host gone, reservation in grace');
        cleanupTick(T0 + REQUEST_GRACE_MS + 1);
        check('the grace sweep');
        hostJoin(makePeer('back', 'k3'), live[3].token, T0 + 5);
        check('a reclaim');
        handleDisconnect(live[4].host, T0);
        hostJoin(makePeer('late', 'k4'), live[4].token, T0 + REQUEST_GRACE_MS + 10);
        check('a lazy expiry and re-create');
        cleanupTick(live[5] && roomMeta.get(live[5].id).createdAt + REQUEST_MAX_AGE_MS + 1);
        check('the age ceiling');
        for (let i = 0; i < 3; i++) hostJoin(makePeer(`n${i}`, `kn${i}`), newToken(), T0);
        fs.writeFileSync(POLICY_PATH, '{"requestLinks":false}');
        policyStore.apply({ requestLinks: false });
        check('the policy purge');
        assert.equal(requestRoomIds.size, 0);
    });

    it('malformed hostToken and roomId never throw and change nothing', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const badIds = [undefined, null, 1, [], {}, [id], 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz', 'a'.repeat(1024 * 1024), `${id} `];
        const badTokens = [undefined, null, 1, [], {}, [token], token.slice(1), `${token}A`,
            `${token.slice(0, 42)}+`, `${token.slice(0, 42)}=`, `${token.slice(0, 42)}\n`, 'A'.repeat(1024 * 1024)];
        const p = makePeer('p', 'k1');
        for (const roomId of badIds) {
            assert.doesNotThrow(() => handleHostJoin(p, roomId, token, T0));
            assert.deepEqual(p.msgs.pop(), { type: 'error', data: { message: 'Invalid room ID' } });
        }
        for (const hostToken of badTokens) {
            assert.doesNotThrow(() => handleHostJoin(p, id, hostToken, T0));
            assert.deepEqual(p.msgs.pop(), { type: 'error', data: { message: 'Invalid host token' } });
        }
        assert.equal(p.msgs.length, 0);
        assert.equal(rooms.size, 0);
        assert.equal(roomMeta.size, 0);
        assert.equal(requestCreates.size, 0);
        assert.equal(p.roomId, null);
    });

    it('destroyRoom keeps request meta on the empty-room path and POST /api/code refuses a reserved roomId', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host-1', 'k1');
        hostJoin(host, token, T0);

        for (const roomId of [id, id.toUpperCase()]) {
            const res = fakeRes();
            registerCodeHandler({ body: { roomId } }, res);
            assert.equal(res.statusCode, 400);
            assert.deepEqual(res.body, { error: 'Invalid room ID' });
        }
        assert.equal(codeToRoom.size, 0);

        handleDisconnect(host); // the last peer leaves: the empty-room path
        assert.equal(rooms.has(id), false);
        assert.equal(roomMeta.get(id).kind, 'request');

        const res = fakeRes();
        registerCodeHandler({ body: { roomId: id } }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(codeToRoom.size, 0);

        // Ordinary rooms keep P0-10's lifecycle: the record dies with the room.
        const plain = randomUUID();
        const a = makePeer('a', 'x');
        handleJoinRoom(a, plain);
        assert.ok(roomMeta.has(plain));
        handleDisconnect(a);
        assert.equal(roomMeta.has(plain), false);
    });

    it('memory returns to zero after close, expiry and purge', () => {
        // Expiry: the host leaves and never comes back.
        const t1 = newToken();
        const h1 = makePeer('h1', 'k1');
        hostJoin(h1, t1, T0);
        handleDisconnect(h1);
        roomMeta.get(roomIdFromToken(t1)).hostPeerId = null;
        roomMeta.get(roomIdFromToken(t1)).hostAbsentSince = T0;
        // Purge: request links turned off while a host waits.
        const h2 = makePeer('h2', 'k2');
        hostJoin(h2, newToken(), T0);
        // Close: the reservation is ended outright.
        const t3 = newToken();
        const h3 = makePeer('h3', 'k3');
        hostJoin(h3, t3, T0);
        endReservation(roomIdFromToken(t3));

        cleanupTick(T0 + REQUEST_GRACE_MS + 60_000);
        policyStore.apply({ requestLinks: false });
        assert.equal(rooms.size, 0);
        assert.equal(roomMeta.size, 0);
        assert.ok(requestCreates.size > 0);
        cleanupTick(T0 + REQUEST_CREATE_WINDOW_MS);
        assert.equal(requestCreates.size, 0);
    });

    it('the policy flip purges an unsealed reservation with refused disabled', () => {
        const waiting = makePeer('waiting', 'k1');
        const wt = newToken();
        hostJoin(waiting, wt, T0);
        const sealedHost = makePeer('sealed', 'k2');
        const st = newToken();
        hostJoin(sealedHost, st, T0);
        roomMeta.get(roomIdFromToken(st)).sealed = true;

        policyStore.apply({ requestLinks: false });
        assert.deepEqual(waiting.msgs.pop(), { type: 'refused', data: { code: 'disabled' } });
        assert.equal(waiting.roomId, null);
        assert.equal(roomMeta.has(roomIdFromToken(wt)), false);
        assert.equal(rooms.has(roomIdFromToken(wt)), false);

        // A sealed room is left to finish on its data channel.
        assert.equal(sealedHost.msgs.length, 1);
        assert.equal(sealedHost.roomId, roomIdFromToken(st));
        assert.ok(roomMeta.has(roomIdFromToken(st)));

        // While off, a host join is refused and creates nothing.
        const late = makePeer('late', 'k3');
        const lt = newToken();
        assert.deepEqual(hostJoin(late, lt, T0), { type: 'refused', data: { code: 'disabled' } });
        assert.equal(roomMeta.has(roomIdFromToken(lt)), false);
    });

    it('requestCreates holds at most REQUEST_CREATE_KEYS_MAX keys and drops the oldest first, never refusing a new key', () => {
        assert.equal(REQUEST_CREATE_KEYS_MAX, 10000);
        // A full log: the first entry expired a day ago, the rest are live, in
        // the Map's order (least recently created first).
        requestCreates.set('planted-expired', [T0 - REQUEST_CREATE_WINDOW_MS - 1]);
        for (let i = 1; i < REQUEST_CREATE_KEYS_MAX; i++) requestCreates.set(`planted-${i}`, [T0 - 1000 + (i % 500)]);
        assert.equal(requestCreates.size, REQUEST_CREATE_KEYS_MAX);

        // A fresh key still creates (no limited for a full log), and the
        // expired entry is what makes room.
        const fresh = makePeer('fresh', '203.0.113.50');
        assert.deepEqual(hostJoin(fresh, newToken(), T0), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(requestCreates.size, REQUEST_CREATE_KEYS_MAX);
        assert.equal(requestCreates.has('planted-expired'), false);
        assert.equal(createsInWindow('203.0.113.50', T0), 1);

        // Then the oldest live entry goes, and a key that just created moves
        // to the back, so it is kept longest.
        const again = makePeer('planted-owner', '203.0.113.50');
        hostJoin(again, newToken(), T0 + 1);
        const other = makePeer('other', '203.0.113.51');
        hostJoin(other, newToken(), T0 + 2);
        assert.equal(requestCreates.size, REQUEST_CREATE_KEYS_MAX);
        assert.equal(requestCreates.has('planted-1'), false, 'the oldest live key');
        assert.ok(requestCreates.has('planted-2'));
        assert.equal(createsInWindow('203.0.113.50', T0 + 2), 2);
        assert.equal([...requestCreates.keys()].pop().startsWith('planted-'), false);
    });

    it('a malformed requestCreates entry never escapes cleanupTick', () => {
        requestCreates.set('planted', null);
        assert.doesNotThrow(() => cleanupTick(T0));
    });
});

// ---------------------------------------------------------------------------
// Request rooms: visitor join (handleRequestJoin)
// ---------------------------------------------------------------------------

describe('handleRequestJoin', () => {
    const T0 = 1_800_000_000_000;

    beforeEach(() => resetRequestState(true));
    after(() => resetRequestState(false));

    // A host seated in a fresh request room; returns the host and the id.
    function waitingHost(key = 'host-key') {
        const token = newToken();
        const host = makePeer(`host-${randomUUID()}`, key);
        hostJoin(host, token, T0);
        host.msgs.length = 0;
        return { host, id: roomIdFromToken(token), token };
    }

    it('a visitor never gets seat 0: request-join on an unknown UUID answers host-absent and creates nothing', () => {
        const v = makePeer('v', 'k-v');
        handleRequestJoin(v, randomUUID(), T0);
        assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }]);
        assert.equal(rooms.size, 0);
        assert.equal(roomMeta.size, 0);
        assert.equal(v.roomId, null);

        // Nor in a reservation whose host is away: the visitor can wait, never sit first.
        const { host, id } = waitingHost();
        handleDisconnect(host);
        roomMeta.get(id).hostPeerId = null;
        roomMeta.get(id).hostAbsentSince = T0;
        handleRequestJoin(v, id, T0);
        assert.deepEqual(v.msgs.pop(), { type: 'host-absent', data: {} });
        assert.equal(rooms.has(id), false);
        assert.equal(v.roomId, null);
    });

    it('request-join on an ordinary room id answers host-absent and leaves it unchanged', () => {
        const a = makePeer('a', 'k-a');
        const plain = randomUUID();
        handleJoinRoom(a, plain);
        const v = makePeer('v', 'k-v');
        handleRequestJoin(v, plain, T0);
        assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }]);
        assert.deepEqual(rooms.get(plain), [a]);
        assert.equal(a.msgs.length, 1, 'the ordinary room hears nothing');
        assert.equal(v.roomId, null);
    });

    it('the visitor is seated and the host gets user-connected exactly once', () => {
        const { host, id } = waitingHost();
        const v = makePeer('v', 'k-v');
        handleRequestJoin(v, id, T0);
        assert.deepEqual(v.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
        assert.deepEqual(host.msgs, [{ type: 'user-connected', data: { id: 'v' } }]);
        assert.deepEqual(rooms.get(id), [host, v]);
        assert.equal(v.roomId, id);
        assert.equal(roomMeta.get(id).hostPeerId, host.id, 'seat 0 is still the token holder');
        assert.equal(roomMeta.get(id).keys.size, 0, 'a join never counts toward the seal');
    });

    it('a second visitor while seat 1 is filled gets room-full', () => {
        const { host, id } = waitingHost();
        const v1 = makePeer('v1', 'k1');
        const v2 = makePeer('v2', 'k2');
        handleRequestJoin(v1, id, T0);
        handleRequestJoin(v2, id, T0);
        assert.deepEqual(v2.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(v2.roomId, null);
        assert.deepEqual(rooms.get(id), [host, v1]);
        assert.equal(v1.msgs.length, 1);
        assert.equal(host.msgs.length, 1);
    });

    it('disabled wins over every other answer while the policy is off', () => {
        const { host, id } = waitingHost();
        const sealedRoom = waitingHost('k-s');
        roomMeta.get(sealedRoom.id).sealed = true;
        const plain = randomUUID();
        handleJoinRoom(makePeer('a', 'k-a'), plain);

        // Turned off with the file, the way an operator does it; the sealed
        // room survives the purge and still answers disabled.
        fs.writeFileSync(POLICY_PATH, '{"requestLinks":false}');
        policyStore.apply({ requestLinks: false });
        const v = makePeer('v', 'k-v');
        for (const target of [randomUUID(), plain, id, sealedRoom.id]) {
            handleRequestJoin(v, target, T0);
            assert.deepEqual(v.msgs.pop(), { type: 'disabled', data: {} }, target);
        }
        assert.equal(v.roomId, null);
        assert.equal(rooms.has(id), false, 'the unsealed room was purged');
        assert.deepEqual(host.msgs.pop(), { type: 'refused', data: { code: 'disabled' } });

        // A malformed id still gets its own fixed answer first.
        handleRequestJoin(v, 'nope', T0);
        assert.deepEqual(v.msgs.pop(), { type: 'error', data: { message: 'Invalid room ID' } });
    });

    it('a repeated request-join from the seated visitor is idempotent', () => {
        const { host, id } = waitingHost();
        const v = makePeer('v', 'k-v');
        handleRequestJoin(v, id, T0);
        handleRequestJoin(v, id, T0);
        handleRequestJoin(v, id.toUpperCase(), T0);
        assert.deepEqual(v.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
        assert.deepEqual(host.msgs, [{ type: 'user-connected', data: { id: 'v' } }]);
        assert.deepEqual(rooms.get(id), [host, v]);
    });

    it('malformed roomId on request-join never throws', () => {
        const { host, id } = waitingHost();
        const v = makePeer('v', 'k-v');
        const bad = [undefined, null, 1, [], {}, [id], 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz', 'a'.repeat(1024 * 1024), `${id} `];
        for (const roomId of bad) {
            assert.doesNotThrow(() => handleRequestJoin(v, roomId, T0));
            assert.deepEqual(v.msgs.pop(), { type: 'error', data: { message: 'Invalid room ID' } });
        }
        assert.equal(v.msgs.length, 0);
        assert.equal(v.roomId, null);
        assert.deepEqual(rooms.get(id), [host]);
        assert.equal(host.msgs.length, 0);
    });

    it('signals route inside a request room and nobody outside can inject', () => {
        const { host, id } = waitingHost();
        const v = makePeer('v', 'k-v');
        handleRequestJoin(v, id, T0);
        host.msgs.length = 0;
        v.msgs.length = 0;

        handleSignal(host, { type: 'offer' }, 'v');
        assert.deepEqual(v.msgs, [{ type: 'signal', data: { signal: { type: 'offer' }, sender: host.id } }]);
        handleSignal(v, { type: 'answer' }, null);
        assert.deepEqual(host.msgs, [{ type: 'signal', data: { signal: { type: 'answer' }, sender: 'v' } }]);

        // Outsiders: a peer in another room, and a peer in no room, naming either seat.
        const other = makePeer('other', 'k-o');
        handleJoinRoom(other, randomUUID());
        const loose = makePeer('loose', 'k-l');
        for (const p of [other, loose]) {
            handleSignal(p, { type: 'offer' }, host.id);
            handleSignal(p, { type: 'offer' }, 'v');
        }
        assert.equal(host.msgs.length, 1);
        assert.equal(v.msgs.length, 1);
    });

    it("a visitor sharing the host's rateKey is seated", () => {
        const { host, id } = waitingHost('203.0.113.9');
        const v = makePeer('v', '203.0.113.9');
        handleRequestJoin(v, id, T0);
        assert.deepEqual(v.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
        assert.deepEqual(rooms.get(id), [host, v]);
        // And the room seal, once two keys have signaled, never refuses a
        // request-join. The pair has sealed the request room itself (D-116), so
        // the host reopens first.
        handleSignal(host, { type: 'offer' }, null);
        handleSignal(v, { type: 'answer' }, null);
        handleDisconnect(v);
        handleRequestControl(host, 'request-reopen', id);
        const v2 = makePeer('v2', '198.51.100.99');
        handleRequestJoin(v2, id, T0);
        assert.deepEqual(v2.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
    });

    it('host-absent while the host is in grace', () => {
        const { host, id } = waitingHost();
        handleDisconnect(host);
        roomMeta.get(id).hostPeerId = null;
        roomMeta.get(id).hostAbsentSince = T0;
        const v = makePeer('v', 'k-v');
        handleRequestJoin(v, id, T0 + 60_000);
        assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }]);
        assert.equal(v.roomId, null);
        assert.equal(rooms.has(id), false);
        assert.ok(roomMeta.has(id), 'the reservation is untouched');
    });

    it('the 31st request-join on one socket inside 60 s gets no reply and changes nothing; the window resets after 60 s; a second socket is unaffected', () => {
        assert.equal(REQUEST_JOINS_PER_MINUTE, 30);
        // Straight at the budget first.
        const p = makePeer('p', 'k');
        for (let i = 0; i < 30; i++) assert.equal(requestJoinAllowed(p, T0 + i), true, `frame ${i + 1}`);
        assert.equal(requestJoinAllowed(p, T0 + 100), false);
        assert.equal(requestJoinAllowed(p, T0 + 59_999), false);
        assert.equal(requestJoinAllowed(p, T0 + 60_000), true, 'a new window');

        // Then through the handler: 30 answered frames on an unknown id (so
        // nothing is seated), the 31st silent, even for a real waiting room.
        const { host, id } = waitingHost();
        const v = makePeer('v', 'k-v');
        for (let i = 0; i < 30; i++) handleRequestJoin(v, randomUUID(), T0 + i);
        assert.equal(v.msgs.length, 30);
        assert.ok(v.msgs.every(m => m.type === 'host-absent'));
        handleRequestJoin(v, id, T0 + 1000);
        assert.equal(v.msgs.length, 30, 'no reply to the 31st');
        assert.equal(v.roomId, null);
        assert.deepEqual(rooms.get(id), [host]);
        assert.equal(host.msgs.length, 0);
        handleRequestJoin(v, 'not-a-uuid', T0 + 1001);
        assert.equal(v.msgs.length, 30, 'a malformed frame is bounded the same way');

        // A second socket has its own budget.
        const w = makePeer('w', 'k-v');
        handleRequestJoin(w, id, T0 + 1002);
        assert.deepEqual(w.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);

        // After the window, v is answered again (room-full now: w sits there).
        handleRequestJoin(v, id, T0 + 60_000);
        assert.deepEqual(v.msgs.pop(), { type: 'room-full', data: {} });

        // The default clock path: Date.now() drives the same window.
        const d = makePeer('d', 'k-d');
        const realNow = Date.now;
        let fake = T0;
        Date.now = () => fake;
        try {
            for (let i = 0; i < 31; i++) handleRequestJoin(d, randomUUID());
            assert.equal(d.msgs.length, 30);
            fake = T0 + 60_000;
            handleRequestJoin(d, randomUUID());
            assert.equal(d.msgs.length, 31);
        } finally {
            Date.now = realNow;
        }
    });

    it('a link holder that seats and unseats itself is seated at most 6 times in any 60 s; the rest get room-full and change nothing', () => {
        // CP-SE F1-1. Every seating sends the host user-connected, and Floe
        // Desktop answers each one with a TURN fetch from its own network,
        // whose budget is 20 a minute. One socket, inside its own 30-frame
        // budget, seats itself and leaves by a plain join to a fresh room.
        const { host, id, token } = waitingHost();
        const v = makePeer('looper', 'k-looper');
        const answers = [];
        for (let i = 0; i < 30; i++) {
            const held = v.roomId;
            handleRequestJoin(v, id, T0 + i * 100);
            answers.push(v.msgs.pop().type);
            if (i >= 6) {
                // A refusal runs before the leave: the looper keeps the room it had.
                assert.equal(v.roomId, held, `refusal ${i - 5} kept the seat it had`);
                assert.deepEqual(rooms.get(held), [v]);
            }
            handleJoinRoom(v, randomUUID()); // leave without closing the socket
            v.msgs.length = 0;
        }
        const connected = host.msgs.filter(m => m.type === 'user-connected').length;
        assert.equal(connected, 6, 'user-connected the host saw inside one minute');
        assert.deepEqual(answers, [...Array(6).fill('request-joined'), ...Array(24).fill('room-full')]);
        assert.equal(REQUEST_SEATINGS_PER_MINUTE, 6);

        // A refused seating changed nothing: the host heard only the six
        // pairings, the looper kept the seat it had, and the reservation
        // still waits, unsealed, for its host's visitor.
        assert.deepEqual(host.msgs.map(m => m.type), Array(6).fill(['user-connected', 'peer-disconnected']).flat());
        assert.notEqual(v.roomId, id);
        assert.deepEqual(rooms.get(v.roomId), [v]);
        assert.deepEqual(rooms.get(id), [host]);
        const meta = roomMeta.get(id);
        assert.equal(meta.sealed, false);
        assert.equal(meta.hostPeerId, host.id);
        assert.equal(meta.signaled.size, 0);
        assert.equal(roomMeta.size, 1 + 1, 'the reservation and the looper\'s ordinary room');

        // Another link is unaffected.
        const other = waitingHost('k-other');
        const z = makePeer('z', 'k-z');
        handleRequestJoin(z, other.id, T0 + 3_000);
        assert.deepEqual(z.msgs.pop(), { type: 'request-joined', data: { role: 'visitor' } });

        // A refused peer stays where it was, and so does its partner: a
        // receiver paired in an ordinary room, and the host of another link,
        // each ask the spent link and keep their seats; nobody hears a leave.
        const plain = randomUUID();
        const a = makePeer('a', 'k-a');
        const b = makePeer('b', 'k-b');
        handleJoinRoom(a, plain);
        handleJoinRoom(b, plain);
        a.msgs.length = 0;
        b.msgs.length = 0;
        handleRequestJoin(b, id, T0 + 3_100);
        assert.deepEqual(b.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(b.roomId, plain);
        assert.deepEqual(rooms.get(plain), [a, b]);
        assert.deepEqual(a.msgs, [], 'the partner hears no peer-disconnected');
        other.host.msgs.length = 0;
        handleRequestJoin(other.host, id, T0 + 3_200);
        assert.deepEqual(other.host.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(other.host.roomId, other.id);
        assert.deepEqual(rooms.get(other.id), [other.host, z]);
        assert.equal(roomMeta.get(other.id).hostPeerId, other.host.id, 'its own link is not in grace');
        assert.equal(roomMeta.get(other.id).hostAbsentSince, null);
        assert.deepEqual(z.msgs, [], 'its visitor hears no host-absent');

        // Per reservation, not per socket or key: a fresh socket from anywhere
        // is refused too, and the host's reopen (Floe Desktop sends one after
        // every leave) does not refill it.
        handleRequestControl(host, 'request-reopen', id);
        const w = makePeer('w', 'k-w');
        handleRequestJoin(w, id, T0 + 59_999);
        assert.deepEqual(w.msgs.pop(), { type: 'room-full', data: {} });
        assert.equal(w.roomId, null);

        // Rolling: each seating frees its slot 60 s after it was made.
        handleRequestJoin(w, id, T0 + 60_000);
        assert.deepEqual(w.msgs.pop(), { type: 'request-joined', data: { role: 'visitor' } });
        handleDisconnect(w);
        const x = makePeer('x', 'k-x');
        handleRequestJoin(x, id, T0 + 60_050);
        assert.deepEqual(x.msgs.pop(), { type: 'room-full', data: {} });
        handleRequestJoin(x, id, T0 + 60_100);
        assert.deepEqual(x.msgs.pop(), { type: 'request-joined', data: { role: 'visitor' } });
        handleDisconnect(x);

        // The budget is the last check, so a truer answer still wins over it.
        handleDisconnect(host, T0 + 60_110);
        const y = makePeer('y', 'k-y');
        handleRequestJoin(y, id, T0 + 60_120);
        assert.deepEqual(y.msgs.pop(), { type: 'host-absent', data: {} });

        // A reclaim keeps the reservation, and its budget with it.
        const back = makePeer('back', 'host-key');
        assert.deepEqual(hostJoin(back, token, T0 + 60_130), { type: 'room-joined', data: { role: 'host' } });
        handleRequestJoin(y, id, T0 + 60_140);
        assert.deepEqual(y.msgs.pop(), { type: 'room-full', data: {} });

        // The budget dies with its reservation: after request-close, the same
        // token's new reservation (a counted create) seats at once.
        handleRequestControl(back, 'request-close', id);
        const again = makePeer('again', 'host-key');
        assert.deepEqual(hostJoin(again, token, T0 + 60_150), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(createsInWindow('host-key', T0 + 60_150), 2);
        handleRequestJoin(y, id, T0 + 60_160);
        assert.deepEqual(y.msgs.pop(), { type: 'request-joined', data: { role: 'visitor' } });
    });

    it('the re-seats a real visitor can need in one minute all still seat', () => {
        // The flows the seating budget must never refuse, pressed into 40 s,
        // which none of them can really fit in (the host waits 30 s for an
        // answer and 30 s for the channel before it reopens). Each seating is
        // one; a room-full answer costs nothing. Five seatings against 6.
        const { host, id } = waitingHost();
        const joined = { type: 'request-joined', data: { role: 'visitor' } };
        const full = { type: 'room-full', data: {} };
        const join = (p, t) => { handleRequestJoin(p, id, t); return p.msgs.pop(); };

        // 1. The first visit. Its socket blips before the channel opens.
        const a = makePeer('a', 'k-v');
        assert.deepEqual(join(a, T0), joined);

        // 2. Try again on a new socket while the server still holds the old
        //    seat: room-full, and the page's own retry 3 s later seats (R2).
        const b = makePeer('b', 'k-v');
        assert.deepEqual(join(b, T0 + 2_000), full);
        handleDisconnect(a);
        assert.deepEqual(join(b, T0 + 5_000), joined);

        // 3. A failed setup: the host reopens and evicts it (E-03); Try again.
        handleRequestControl(host, 'request-reopen', id);
        assert.deepEqual(b.msgs.pop(), full);
        assert.deepEqual(join(b, T0 + 10_000), joined);

        // 4. The pair signals (the room seals), the host declines and keeps
        //    waiting (a reopen), and the visitor sends again.
        handleSignal(host, { type: 'offer' }, null);
        handleSignal(b, { type: 'answer' }, null);
        assert.equal(roomMeta.get(id).sealed, true);
        handleRequestControl(host, 'request-reopen', id);
        assert.deepEqual(b.msgs.pop(), full);
        assert.deepEqual(join(b, T0 + 20_000), joined);

        // 5. The socket goes after it answered, before its channel opened: the
        //    room is sealed on that seat, the page's retries answer room-full
        //    until the host reopens (L1), and the next one seats.
        handleSignal(host, { type: 'offer' }, null);
        handleSignal(b, { type: 'answer' }, null);
        handleDisconnect(b);
        const c = makePeer('c', 'k-v');
        for (let t = T0 + 23_000; t < T0 + 35_000; t += 3_000) assert.deepEqual(join(c, t), full);
        handleRequestControl(host, 'request-reopen', id);
        assert.deepEqual(join(c, T0 + 38_000), joined);

        assert.equal(host.msgs.filter(m => m.type === 'user-connected').length, 5);
    });
});

// ---------------------------------------------------------------------------
// Request rooms: seal, reopen, close, disconnects and the sweep
// ---------------------------------------------------------------------------

const RQ_T0 = 1_800_000_000_000;

// A host and a seated visitor in a fresh request room, with the join traffic
// cleared from both mailboxes.
function pairedRequestRoom(hostKey = 'host-key', visitorKey = 'visitor-key') {
    const token = newToken();
    const id = roomIdFromToken(token);
    const host = makePeer(`host-${randomUUID()}`, hostKey);
    hostJoin(host, token, RQ_T0);
    const visitor = makePeer(`visitor-${randomUUID()}`, visitorKey);
    handleRequestJoin(visitor, id, RQ_T0);
    assert.deepEqual(visitor.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
    host.msgs.length = 0;
    visitor.msgs.length = 0;
    return { token, id, host, visitor };
}

describe('handleRequestControl', () => {
    beforeEach(() => resetRequestState(true));
    after(() => resetRequestState(false));

    it('seal then the visitor leaves: host gets peer-disconnected and the next request-join gets room-full', () => {
        const { id, host, visitor } = pairedRequestRoom('198.51.100.1', '198.51.100.2');
        handleRequestControl(host, 'request-seal', id);
        assert.equal(roomMeta.get(id).sealed, true);
        assert.equal(host.msgs.length + visitor.msgs.length, 0, 'no acknowledgment');

        handleDisconnect(visitor);
        assert.deepEqual(host.msgs, [{ type: 'peer-disconnected', data: {} }]);
        assert.deepEqual(rooms.get(id), [host]);
        assert.equal(roomMeta.get(id).sealed, true);

        // A stranger, the visitor coming back, and a joiner sharing either
        // seated key: all room-full while sealed.
        for (const [pid, key] of [['stranger', '203.0.113.5'], ['back', '198.51.100.2'], ['nat', '198.51.100.1']]) {
            const p = makePeer(pid, key);
            handleRequestJoin(p, id, RQ_T0);
            assert.deepEqual(p.msgs, [{ type: 'room-full', data: {} }], pid);
            assert.equal(p.roomId, null);
        }
        assert.deepEqual(rooms.get(id), [host]);
    });

    it('a visitor that drops before request-seal leaves the room sealed once both seats have signaled', () => {
        // The race request-seal alone loses: the data channel opens, the
        // visitor's socket drops, and the host's seal frame lands on a room
        // with seat 1 empty.
        const { id, host, visitor } = pairedRequestRoom();
        handleSignal(host, { type: 'offer' }, null);
        assert.equal(roomMeta.get(id).sealed, false, 'one side alone does not seal');
        handleSignal(visitor, { type: 'answer' }, null);
        assert.equal(roomMeta.get(id).sealed, true, 'both seats have signaled');

        handleDisconnect(visitor);
        handleRequestControl(host, 'request-seal', id); // late, and idempotent
        assert.equal(roomMeta.get(id).sealed, true);
        host.msgs.length = 0;
        const third = makePeer('third', 'k3');
        handleRequestJoin(third, id, RQ_T0);
        assert.deepEqual(third.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(host.msgs.length, 0, 'no user-connected mid-drop');
        assert.deepEqual(rooms.get(id), [host]);

        // Offered to and gone before answering: nothing was received, so the
        // room stays open (the P0-10 rule), and the next visitor must signal
        // afresh; reopen clears the record too.
        const o = pairedRequestRoom('ko', 'kov');
        handleSignal(o.host, { type: 'offer' }, null);
        handleDisconnect(o.visitor);
        const next = makePeer('next', 'kn');
        handleRequestJoin(next, o.id, RQ_T0);
        assert.deepEqual(next.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
        handleSignal(next, { candidate: 'early' }, null);
        assert.equal(roomMeta.get(o.id).sealed, false, 'the host signal before this visitor sat does not count');
        handleSignal(o.host, { type: 'offer' }, null);
        assert.equal(roomMeta.get(o.id).sealed, true);
        handleRequestControl(o.host, 'request-reopen', o.id);
        assert.equal(roomMeta.get(o.id).sealed, false);
        const again = makePeer('again', 'ka');
        handleRequestJoin(again, o.id, RQ_T0);
        handleSignal(again, { type: 'answer' }, null);
        assert.equal(roomMeta.get(o.id).sealed, false, 'a reopen starts the record over');
        assert.ok(roomMeta.get(o.id).signaled.size <= 2);
    });

    it('request-seal with no visitor is a no-op', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host', 'k');
        hostJoin(host, token, RQ_T0);
        handleRequestControl(host, 'request-seal', id);
        assert.equal(roomMeta.get(id).sealed, false);
        const v = makePeer('v', 'kv');
        handleRequestJoin(v, id, RQ_T0);
        assert.deepEqual(v.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
    });

    it('reopen is host-only', () => {
        const { id, host, visitor } = pairedRequestRoom();
        handleRequestControl(host, 'request-seal', id);

        // From the visitor, from a peer in another room, from a peer in no
        // room, and from the host naming another id: nothing changes.
        const other = pairedRequestRoom('ok', 'ov');
        const loose = makePeer('loose', 'kl');
        handleRequestControl(visitor, 'request-reopen', id);
        handleRequestControl(other.host, 'request-reopen', id);
        handleRequestControl(loose, 'request-reopen', id);
        handleRequestControl(host, 'request-reopen', other.id);
        handleRequestControl(host, 'request-reopen', randomUUID());
        assert.equal(roomMeta.get(id).sealed, true);
        assert.deepEqual(rooms.get(id), [host, visitor]);
        assert.equal(visitor.roomId, id);
        for (const p of [host, visitor, other.host, other.visitor, loose]) assert.equal(p.msgs.length, 0);

        // From the host with seat 1 empty: unsealed, and the next request-join seats.
        handleDisconnect(visitor);
        host.msgs.length = 0;
        handleRequestControl(host, 'request-reopen', id.toUpperCase());
        assert.equal(roomMeta.get(id).sealed, false);
        assert.equal(host.msgs.length, 0);
        const next = makePeer('next', 'kn');
        handleRequestJoin(next, id, RQ_T0);
        assert.deepEqual(next.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
        assert.deepEqual(host.msgs, [{ type: 'user-connected', data: { id: 'next' } }]);
    });

    it('reopen with a squatter seated evicts it with room-full and the next request-join seats', () => {
        const { id, host, visitor: squatter } = pairedRequestRoom();
        handleRequestControl(host, 'request-reopen', id);
        assert.deepEqual(squatter.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(squatter.roomId, null);
        assert.deepEqual(rooms.get(id), [host]);
        assert.equal(roomMeta.get(id).sealed, false);
        assert.equal(host.msgs.length, 0);

        // The evicted socket's later close is a no-op.
        handleDisconnect(squatter);
        assert.equal(host.msgs.length, 0);

        const invited = makePeer('invited', 'ki');
        handleRequestJoin(invited, id, RQ_T0);
        assert.deepEqual(invited.msgs, [{ type: 'request-joined', data: { role: 'visitor' } }]);
        assert.deepEqual(host.msgs, [{ type: 'user-connected', data: { id: 'invited' } }]);

        // A sealed room reopened the same way: evicted and unsealed.
        handleRequestControl(host, 'request-seal', id);
        handleRequestControl(host, 'request-reopen', id);
        assert.deepEqual(invited.msgs.pop(), { type: 'room-full', data: {} });
        assert.equal(roomMeta.get(id).sealed, false);
    });

    it('request-close deletes room and reservation; later request-join gets host-absent; from the visitor it is ignored', () => {
        const { id, host, visitor } = pairedRequestRoom();
        handleRequestControl(visitor, 'request-close', id);
        assert.ok(roomMeta.has(id));
        assert.deepEqual(rooms.get(id), [host, visitor]);

        handleRequestControl(host, 'request-close', id);
        assert.equal(rooms.has(id), false);
        assert.equal(roomMeta.has(id), false);
        assert.equal(host.roomId, null);
        assert.equal(visitor.roomId, null);
        assert.deepEqual(visitor.msgs, [{ type: 'host-absent', data: {} }], 'an unsealed visitor is told');

        const later = makePeer('later', 'kl');
        handleRequestJoin(later, id, RQ_T0);
        assert.deepEqual(later.msgs, [{ type: 'host-absent', data: {} }]);
        assert.equal(rooms.has(id), false);

        // A sealed visitor is not told: its drop runs on the data channel. Its
        // room goes too, and the reservation becomes a used marker (D-130).
        const s = pairedRequestRoom('k3', 'k4');
        handleRequestControl(s.host, 'request-seal', s.id);
        handleRequestControl(s.host, 'request-close', s.id);
        assert.equal(s.visitor.msgs.length, 0);
        assert.equal(s.visitor.roomId, null);
        assert.equal(rooms.has(s.id), false);
        assert.equal(roomMeta.get(s.id).used, true);
    });

    it('control messages with malformed or foreign ids are dropped silently', () => {
        const { id, host, visitor } = pairedRequestRoom();
        for (const type of ['request-seal', 'request-reopen', 'request-close']) {
            for (const roomId of [undefined, null, 1, [], {}, [id], 'a'.repeat(1024 * 1024), `${id} `]) {
                assert.doesNotThrow(() => handleRequestControl(host, type, roomId));
            }
        }
        assert.equal(roomMeta.get(id).sealed, false);
        assert.deepEqual(rooms.get(id), [host, visitor]);
        assert.equal(host.msgs.length + visitor.msgs.length, 0);
    });
});

describe('request rooms: disconnect and sweep', () => {
    beforeEach(() => resetRequestState(true));
    after(() => resetRequestState(false));

    it('host disconnects while Paired and unsealed: visitor gets host-absent, reservation kept with hostAbsentSince', () => {
        const { id, host, visitor } = pairedRequestRoom();
        handleDisconnect(host, RQ_T0 + 5);
        assert.deepEqual(visitor.msgs, [{ type: 'host-absent', data: {} }]);
        assert.equal(visitor.roomId, null);
        assert.equal(rooms.has(id), false);
        const meta = roomMeta.get(id);
        assert.equal(meta.hostPeerId, null);
        assert.equal(meta.hostAbsentSince, RQ_T0 + 5);

        // The evicted visitor's own close changes nothing.
        handleDisconnect(visitor);
        assert.equal(roomMeta.get(id), meta);
    });

    it('sealed host disconnects then reclaims: visitor stays seated', () => {
        const { token, id, host, visitor } = pairedRequestRoom();
        handleRequestControl(host, 'request-seal', id);
        handleDisconnect(host, RQ_T0 + 5);
        assert.deepEqual(visitor.msgs, [{ type: 'peer-disconnected', data: {} }]);
        assert.equal(visitor.roomId, id);
        assert.deepEqual(rooms.get(id), [visitor]);

        const back = makePeer('back', 'host-key');
        assert.deepEqual(hostJoin(back, token, RQ_T0 + 60_000), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(back.msgs.length, 1, 'no user-connected on a reclaim');
        assert.deepEqual(rooms.get(id), [visitor, back]);
        assert.equal(visitor.roomId, id);
        assert.equal(visitor.msgs.length, 1);
        assert.equal(roomMeta.get(id).sealed, true);

        // Signals route between the reclaimed host and the seated visitor.
        handleSignal(back, { type: 'ping' }, null);
        assert.deepEqual(visitor.msgs.pop(), { type: 'signal', data: { signal: { type: 'ping' }, sender: 'back' } });
    });

    it('a sealed room stays busy while the host is absent', () => {
        const { token, id, host, visitor } = pairedRequestRoom();
        handleRequestControl(host, 'request-seal', id);
        handleDisconnect(host, RQ_T0);

        const other = makePeer('other', 'ko');
        handleRequestJoin(other, id, RQ_T0 + 1000);
        assert.deepEqual(other.msgs, [{ type: 'room-full', data: {} }], 'room-full, not host-absent');
        assert.deepEqual(visitor.msgs, [{ type: 'peer-disconnected', data: {} }]);
        assert.equal(visitor.roomId, id);

        const back = makePeer('back', 'host-key');
        hostJoin(back, token, RQ_T0 + 2000);
        assert.ok(!back.msgs.some(m => m.type === 'user-connected'));
        assert.deepEqual(rooms.get(id), [visitor, back]);

        // With no reclaim, the sweep unseats the visitor silently at grace end.
        const quiet = pairedRequestRoom('kq', 'kqv');
        handleRequestControl(quiet.host, 'request-seal', quiet.id);
        handleDisconnect(quiet.host, RQ_T0);
        quiet.visitor.msgs.length = 0;
        cleanupTick(RQ_T0 + REQUEST_GRACE_MS);
        assert.equal(quiet.visitor.roomId, quiet.id, 'not before the grace has passed');
        cleanupTick(RQ_T0 + REQUEST_GRACE_MS + 1);
        assert.equal(quiet.visitor.roomId, null);
        assert.equal(quiet.visitor.msgs.length, 0, 'silently');
        assert.equal(roomMeta.has(quiet.id), false);
        assert.equal(rooms.has(quiet.id), false);
    });

    it('the sweep ends an unreclaimed reservation at grace', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host', 'k');
        hostJoin(host, token, RQ_T0);
        handleDisconnect(host, RQ_T0);
        cleanupTick(RQ_T0 + REQUEST_GRACE_MS);
        assert.ok(roomMeta.has(id));
        cleanupTick(RQ_T0 + REQUEST_GRACE_MS + 60_000);
        assert.equal(roomMeta.has(id), false);
        const v = makePeer('v', 'kv');
        handleRequestJoin(v, id, RQ_T0 + REQUEST_GRACE_MS + 60_001);
        assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }]);
    });

    it('the age ceiling ends a reservation older than 7 d plus 10 min', () => {
        assert.equal(REQUEST_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000);
        const { id, host, visitor } = pairedRequestRoom();
        handleRequestControl(host, 'request-seal', id);
        cleanupTick(RQ_T0 + REQUEST_MAX_AGE_MS);
        assert.ok(roomMeta.has(id), 'not at the ceiling itself');
        cleanupTick(RQ_T0 + REQUEST_MAX_AGE_MS + 1);
        assert.equal(roomMeta.has(id), false, 'sealed or not, with its host seated');
        assert.equal(rooms.has(id), false);
        assert.equal(host.roomId, null);
        assert.equal(visitor.roomId, null);
        assert.equal(host.msgs.length + visitor.msgs.length, 0);
    });

    it('a policy flip leaves a sealed room untouched and its signals still relay', () => {
        const sealedRoom = pairedRequestRoom('ks', 'ksv');
        handleRequestControl(sealedRoom.host, 'request-seal', sealedRoom.id);
        const open = pairedRequestRoom('ko', 'kov');

        fs.writeFileSync(POLICY_PATH, '{"requestLinks":false}');
        cleanupTick(RQ_T0);
        assert.equal(policyStore.requestLinks(), false);

        assert.deepEqual(open.host.msgs, [{ type: 'refused', data: { code: 'disabled' } }]);
        assert.deepEqual(open.visitor.msgs, [{ type: 'disabled', data: {} }]);
        assert.equal(roomMeta.has(open.id), false);

        assert.equal(sealedRoom.host.msgs.length + sealedRoom.visitor.msgs.length, 0);
        assert.deepEqual(rooms.get(sealedRoom.id), [sealedRoom.host, sealedRoom.visitor]);
        handleSignal(sealedRoom.host, { candidate: 'x' }, null);
        assert.deepEqual(sealedRoom.visitor.msgs, [{ type: 'signal', data: { signal: { candidate: 'x' }, sender: sealedRoom.host.id } }]);
        handleSignal(sealedRoom.visitor, { candidate: 'y' }, null);
        assert.deepEqual(sealedRoom.host.msgs, [{ type: 'signal', data: { signal: { candidate: 'y' }, sender: sealedRoom.visitor.id } }]);
    });

    it('a token re-join after a simulated restart re-creates the reservation and counts as a create', () => {
        const token = newToken();
        const id = roomIdFromToken(token);
        hostJoin(makePeer('before', 'k'), token, RQ_T0);
        // A restart: every in-memory map is empty again.
        rooms.clear();
        roomMeta.clear();
        requestCreates.clear();
        const after = makePeer('after', 'k');
        assert.deepEqual(hostJoin(after, token, RQ_T0 + 1000), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(roomMeta.get(id).kind, 'request');
        assert.equal(roomMeta.get(id).createdAt, RQ_T0 + 1000);
        assert.equal(createsInWindow('k', RQ_T0 + 1000), 1);
    });

    it('a malformed reservation never escapes cleanupTick', () => {
        // A room array holding a non-peer makes endReservation throw; both
        // sweeps (grace and age) must keep it inside cleanupTick.
        roomMeta.set('planted-grace', { keys: new Set(), kind: 'request', hostPeerId: null, hostAbsentSince: 0, createdAt: RQ_T0, sealed: false });
        rooms.set('planted-grace', [null]);
        roomMeta.set('planted-age', { keys: new Set(), kind: 'request', hostPeerId: 'x', hostAbsentSince: null, createdAt: 0, sealed: true });
        rooms.set('planted-age', [null]);
        assert.doesNotThrow(() => cleanupTick(RQ_T0 + REQUEST_GRACE_MS + 1));
        roomMeta.clear();
        rooms.clear();
    });

    it("a request room's keys never grow: visitors from distinct keys each signal and leave", () => {
        // The room seal's key history is never read for a request room, and
        // seat 1 frees on a visitor's own disconnect, so a digest per visitor
        // would grow at the visitor's pace for the life of the reservation.
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host', '198.51.100.200');
        hostJoin(host, token, RQ_T0);
        // At the seating budget's own pace, the fastest one link can be seated.
        const pace = 60_000 / REQUEST_SEATINGS_PER_MINUTE;
        for (let i = 0; i < 50; i++) {
            const v = makePeer(`v${i}`, `203.0.113.${i}`);
            handleRequestJoin(v, id, RQ_T0 + i * pace);
            assert.equal(v.roomId, id, `visitor ${i} seated`);
            handleSignal(v, { type: 'anything' }, null);
            handleDisconnect(v);
        }
        const v = makePeer('last', '203.0.113.99');
        handleRequestJoin(v, id, RQ_T0 + 50 * pace);
        handleSignal(host, { type: 'offer' }, null);
        assert.equal(roomMeta.get(id).keys.size, 0);

        // Ordinary rooms still count signaling keys (P0-10).
        const plain = randomUUID();
        const a = makePeer('a', 'ka');
        const b = makePeer('b', 'kb');
        handleJoinRoom(a, plain);
        handleJoinRoom(b, plain);
        handleSignal(a, { type: 'offer' }, null);
        handleSignal(b, { type: 'answer' }, null);
        assert.equal(roomMeta.get(plain).keys.size, 2);
    });

    it('newest host wins while Paired and unsealed: the visitor hears host-absent and loses its seat; the next request-join seats and the new host gets user-connected', () => {
        // Host A's socket went dead without the server noticing; V was seated
        // (its user-connected went to the dead socket); the desktop reconnects.
        const { token, id, host: a, visitor: v } = pairedRequestRoom();
        const a2 = makePeer('a2', 'host-key');
        assert.deepEqual(hostJoin(a2, token, RQ_T0 + 1000), { type: 'room-joined', data: { role: 'host' } });
        assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }]);
        assert.equal(v.roomId, null);
        assert.equal(a.roomId, null);
        assert.deepEqual(rooms.get(id), [a2]);

        // V's Try again on the same socket, then a clean pairing.
        handleRequestJoin(v, id, RQ_T0 + 2000);
        assert.deepEqual(v.msgs.pop(), { type: 'request-joined', data: { role: 'visitor' } });
        assert.deepEqual(a2.msgs.pop(), { type: 'user-connected', data: { id: v.id } });
        assert.deepEqual(rooms.get(id), [a2, v]);

        // A sealed room keeps its visitor through a replacement (its drop runs
        // on the data channel).
        const s = pairedRequestRoom('ks', 'ksv');
        handleRequestControl(s.host, 'request-seal', s.id);
        const s2 = makePeer('s2', 'ks');
        hostJoin(s2, s.token, RQ_T0 + 1000);
        assert.equal(s.visitor.msgs.length, 0);
        assert.equal(s.visitor.roomId, s.id);
        assert.deepEqual(rooms.get(s.id), [s.visitor, s2]);

        // The same host socket re-sending its join changes nothing.
        const same = pairedRequestRoom('kx', 'kxv');
        hostJoin(same.host, same.token, RQ_T0 + 1000);
        assert.equal(same.visitor.roomId, same.id);
        assert.equal(same.visitor.msgs.length, 0);
    });

    it('a malformed reservation does not stop the sweep of a good one', () => {
        // First in the Map, a planted entry that makes endReservation throw;
        // after it, a real reservation past its grace and one past the age
        // ceiling. Both real ones must still end on this tick.
        roomMeta.set('planted-bad', { keys: new Set(), kind: 'request', hostPeerId: null, hostAbsentSince: 0, createdAt: RQ_T0, sealed: false });
        rooms.set('planted-bad', [null]);
        const graceToken = newToken();
        const g = makePeer('g', 'kg');
        hostJoin(g, graceToken, RQ_T0);
        handleDisconnect(g, RQ_T0);
        const ageToken = newToken();
        hostJoin(makePeer('old', 'ko'), ageToken, RQ_T0 - REQUEST_MAX_AGE_MS);
        cleanupTick(RQ_T0 + REQUEST_GRACE_MS + 1);
        assert.equal(roomMeta.has(roomIdFromToken(graceToken)), false, 'the grace sweep went on past the bad entry');
        assert.equal(roomMeta.has(roomIdFromToken(ageToken)), false, 'the age ceiling went on past the bad entry');
        roomMeta.delete('planted-bad');
        rooms.delete('planted-bad');
    });

    it('memory returns to zero', () => {
        // Close.
        const a = pairedRequestRoom('ka', 'kav');
        handleRequestControl(a.host, 'request-close', a.id);
        // Expiry: the host leaves while paired and never comes back.
        const b = pairedRequestRoom('kb', 'kbv');
        handleDisconnect(b.host, RQ_T0);
        handleDisconnect(b.visitor, RQ_T0);
        // Sealed, host gone, visitor still seated until the grace ends.
        const c = pairedRequestRoom('kc', 'kcv');
        handleRequestControl(c.host, 'request-seal', c.id);
        handleDisconnect(c.host, RQ_T0);
        // Purge: a waiting host when request links go off.
        const d = pairedRequestRoom('kd', 'kdv');
        handleDisconnect(d.visitor, RQ_T0);

        cleanupTick(RQ_T0 + REQUEST_GRACE_MS + 1);
        fs.writeFileSync(POLICY_PATH, '{"requestLinks":false}');
        cleanupTick(RQ_T0 + REQUEST_GRACE_MS + 2);
        assert.equal(rooms.size, 0);
        assert.equal(roomMeta.size, 0);
        for (const p of [a, b, c, d]) {
            assert.equal(p.host.roomId, null);
            assert.equal(p.visitor.roomId, null);
        }
        cleanupTick(RQ_T0 + REQUEST_CREATE_WINDOW_MS);
        assert.equal(requestCreates.size, 0);
    });
});

// ---------------------------------------------------------------------------
// Request rooms: a used link (D-130, spec 04 5.16 c)
// ---------------------------------------------------------------------------

// A link whose drop ran: the pair signaled (which seals the room, D-116), the
// host confirmed the seal, and Floe Desktop sent request-close at done.
function usedRequestLink(closeAt, hostKey = 'host-key', visitorKey = 'visitor-key') {
    const link = pairedRequestRoom(hostKey, visitorKey);
    handleSignal(link.host, { type: 'offer' }, null);
    handleSignal(link.visitor, { type: 'answer' }, null);
    handleRequestControl(link.host, 'request-seal', link.id);
    assert.equal(roomMeta.get(link.id).sealed, true);
    handleRequestControl(link.host, 'request-close', link.id, closeAt);
    link.host.msgs.length = 0;
    link.visitor.msgs.length = 0;
    return link;
}

describe('request rooms: a used link (D-130)', () => {
    beforeEach(() => resetRequestState(true));
    after(() => resetRequestState(false));

    const CLOSED = RQ_T0 + 5_000;

    function setPolicy(on) {
        fs.writeFileSync(POLICY_PATH, JSON.stringify({ requestLinks: on }));
        policyStore.apply({ requestLinks: on });
    }

    it('a used link answers room-full after a sealed close, and disabled while request links are off', () => {
        const { id, host, visitor } = usedRequestLink(CLOSED);
        assert.equal(rooms.has(id), false, 'the room itself goes, as before');
        assert.equal(host.roomId, null);
        assert.equal(visitor.roomId, null);
        assert.deepEqual(visitor.msgs, [], 'the sealed visitor is left to its data channel');

        // A fresh visitor opening the link after the drop (TA-10, 11, 15).
        const fresh = makePeer('fresh', 'k-fresh');
        handleRequestJoin(fresh, id, CLOSED + 60_000);
        assert.deepEqual(fresh.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(fresh.roomId, null);
        // The visitor itself coming back, in upper case.
        handleRequestJoin(visitor, id.toUpperCase(), CLOSED + 61_000);
        assert.deepEqual(visitor.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(rooms.has(id), false, 'no room is created');
        assert.deepEqual(host.msgs, [], 'nobody is sent user-connected');

        // Nor can a plain join-room or a code take the id.
        const plain = makePeer('plain', 'k-plain');
        handleJoinRoom(plain, id);
        assert.deepEqual(plain.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(plain.roomId, null);
        assert.equal(rooms.has(id), false);
        const res = fakeRes();
        registerCodeHandler({ body: { roomId: id } }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(codeToRoom.size, 0);

        // The kill switch still wins, and the marker outlives the flip: it is
        // sealed, like a room whose drop is still running.
        setPolicy(false);
        handleRequestJoin(fresh, id, CLOSED + 62_000);
        assert.deepEqual(fresh.msgs.pop(), { type: 'disabled', data: {} });
        assert.equal(roomMeta.get(id).used, true);
        setPolicy(true);
        handleRequestJoin(fresh, id, CLOSED + 63_000);
        assert.deepEqual(fresh.msgs.pop(), { type: 'room-full', data: {} });
    });

    it('an unsealed close still ends the reservation outright, and a later request-join answers host-absent', () => {
        // Close link while waiting: no visitor ever paired.
        const token = newToken();
        const id = roomIdFromToken(token);
        const host = makePeer('host', 'host-key');
        hostJoin(host, token, RQ_T0);
        handleRequestControl(host, 'request-close', id, CLOSED);
        assert.equal(roomMeta.has(id), false);
        assert.equal(requestRoomIds.has(id), false, 'its slot is free at once');
        assert.equal(rooms.has(id), false);
        const v = makePeer('v', 'kv');
        handleRequestJoin(v, id, CLOSED + 1);
        assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }]);

        // Paired but not sealed (a visitor seated, nothing signaled yet): the
        // visitor hears host-absent, and nothing is kept either.
        const p = pairedRequestRoom('kp', 'kpv');
        handleRequestControl(p.host, 'request-close', p.id, CLOSED);
        assert.deepEqual(p.visitor.msgs, [{ type: 'host-absent', data: {} }]);
        assert.equal(roomMeta.has(p.id), false);
        handleRequestJoin(v, p.id, CLOSED + 2);
        assert.deepEqual(v.msgs.pop(), { type: 'host-absent', data: {} });

        // A sealed pair the host reopened (Keep waiting) is unsealed again, so
        // its close is an unsealed one.
        const r = pairedRequestRoom('kr', 'krv');
        handleSignal(r.host, { type: 'offer' }, null);
        handleSignal(r.visitor, { type: 'answer' }, null);
        handleRequestControl(r.host, 'request-reopen', r.id);
        handleRequestControl(r.host, 'request-close', r.id, CLOSED);
        assert.equal(roomMeta.has(r.id), false);
        handleRequestJoin(v, r.id, CLOSED + 3);
        assert.deepEqual(v.msgs.pop(), { type: 'host-absent', data: {} });

        // And the same token can make the link again (a counted create), as today.
        assert.deepEqual(hostJoin(makePeer('again', 'host-key'), token, CLOSED + 10), { type: 'room-joined', data: { role: 'host' } });
        assert.equal(createsInWindow('host-key', CLOSED + 10), 2);
    });

    it('a host join on a used id is refused with room-full, creates nothing and leaves the joiner where it was', () => {
        const { token, id, host } = usedRequestLink(CLOSED);
        const marker = roomMeta.get(id);
        const before = { ...marker };
        assert.equal(createsInWindow('host-key', CLOSED), 1);

        // The token's own holder, on its old socket and on a new one seated in
        // an ordinary room: room-full both times, and the new one keeps its room.
        assert.deepEqual(hostJoin(host, token, CLOSED + 1_000), { type: 'room-full', data: {} });
        const back = makePeer('back', 'host-key');
        const plain = randomUUID();
        handleJoinRoom(back, plain);
        back.msgs.length = 0;
        handleHostJoin(back, id.toUpperCase(), token, CLOSED + 2_000);
        assert.deepEqual(back.msgs, [{ type: 'room-full', data: {} }]);
        assert.equal(back.roomId, plain);
        assert.deepEqual(rooms.get(plain), [back]);

        // No control frame reaches the marker either: nobody is seated in it,
        // so a reopen can never unseal a used link.
        for (const p of [host, back]) {
            for (const type of ['request-reopen', 'request-seal', 'request-close']) handleRequestControl(p, type, id, CLOSED + 3_000);
        }

        assert.equal(roomMeta.get(id), marker, 'the marker, not a new reservation');
        assert.deepEqual({ ...roomMeta.get(id) }, before);
        assert.equal(rooms.has(id), false);
        assert.equal(host.roomId, null);
        assert.equal(createsInWindow('host-key', CLOSED + 3_000), 1, 'a refused join is not a create');
        assert.equal(host.msgs.length, 1);

        // Any other token still fails the derivation first, and the kill
        // switch still answers before the lookup.
        const other = makePeer('other', 'k-other');
        handleHostJoin(other, id, newToken(), CLOSED + 4_000);
        assert.deepEqual(other.msgs.pop(), { type: 'error', data: { message: 'Invalid host token' } });
        setPolicy(false);
        assert.deepEqual(hostJoin(back, token, CLOSED + 5_000), { type: 'refused', data: { code: 'disabled' } });
        assert.equal(roomMeta.get(id), marker);
        assert.equal(back.roomId, plain);
    });

    it('the used marker holds no token digest, no key digest and no address', () => {
        const hostAddress = '198.51.100.21';
        const visitorAddress = '2001:db8:5:6::/64';
        const { token, id, host, visitor } = usedRequestLink(CLOSED, hostAddress, visitorAddress);

        // Only what answering needs: a request id, sealed, used, and since when.
        const marker = roomMeta.get(id);
        assert.deepEqual(Object.keys(marker).sort(), ['closedAt', 'kind', 'sealed', 'used']);
        assert.deepEqual({ ...marker }, { kind: 'request', sealed: true, used: true, closedAt: CLOSED });
        for (const [k, v] of Object.entries(marker)) {
            assert.ok(v === null || typeof v !== 'object', `meta.${k} is a container`);
        }

        // The whole map, dumped: nothing the reservation saw survives it.
        const dump = JSON.stringify([...roomMeta]);
        const digest = createHash('sha256').update(token, 'utf8').digest();
        const secrets = [token, host.id, visitor.id, hostAddress, visitorAddress, '2001:db8:5:6',
            ...['hex', 'base64', 'base64url'].map(enc => digest.toString(enc)),
            JSON.stringify([...digest]).slice(1, -1)];
        for (const s of secrets) assert.ok(!dump.includes(s), `roomMeta holds ${s}`);
    });

    it('the sweep removes the used marker 24 h after the close and not before', () => {
        assert.equal(REQUEST_USED_MARKER_MS, 24 * 60 * 60 * 1000);
        const { id } = usedRequestLink(CLOSED);
        const v = makePeer('v', 'kv');

        // Neither the grace nor the age ceiling reads a marker: it has no host
        // to be absent and no creation time.
        cleanupTick(CLOSED + REQUEST_GRACE_MS + 60_000);
        assert.equal(roomMeta.get(id).used, true, 'not at the grace');
        cleanupTick(CLOSED + REQUEST_USED_MARKER_MS);
        assert.equal(roomMeta.get(id).used, true, 'not at 24 h itself');
        handleRequestJoin(v, id, CLOSED + REQUEST_USED_MARKER_MS);
        assert.deepEqual(v.msgs.pop(), { type: 'room-full', data: {} });

        cleanupTick(CLOSED + REQUEST_USED_MARKER_MS + 1);
        assert.equal(roomMeta.has(id), false);
        assert.equal(requestRoomIds.has(id), false);
        assert.equal(rooms.has(id), false);
        // Gone is gone: the id answers like any unknown one.
        handleRequestJoin(v, id, CLOSED + REQUEST_USED_MARKER_MS + 2);
        assert.deepEqual(v.msgs.pop(), { type: 'host-absent', data: {} });

        // A link closed late in its life keeps its full 24 h: the clock starts
        // at the close, not at the create.
        const lateClose = RQ_T0 + REQUEST_MAX_AGE_MS - 1;
        const late = usedRequestLink(lateClose, 'kl', 'klv');
        cleanupTick(RQ_T0 + REQUEST_MAX_AGE_MS + 1);
        assert.equal(roomMeta.get(late.id).used, true, 'past the age ceiling of its reservation');
        cleanupTick(lateClose + REQUEST_USED_MARKER_MS + 1);
        assert.equal(roomMeta.has(late.id), false);
    });

    it('a malformed used marker does not stop the sweep of a good one', () => {
        // First in the Map, a planted marker whose room array makes
        // endReservation throw; the real marker after it must still go.
        roomMeta.set('planted-used', { kind: 'request', sealed: true, used: true, closedAt: 0 });
        requestRoomIds.add('planted-used');
        rooms.set('planted-used', [null]);
        const { id } = usedRequestLink(CLOSED);
        assert.equal(roomMeta.get(id).used, true);
        assert.doesNotThrow(() => cleanupTick(CLOSED + REQUEST_USED_MARKER_MS + 1));
        assert.equal(roomMeta.has(id), false, 'the sweep went on past the bad entry');
        roomMeta.delete('planted-used');
        requestRoomIds.delete('planted-used');
        rooms.delete('planted-used');
    });

    it('the request-room count stays exact across mark, sweep and cap, and a marker counts toward MAX_REQUEST_ROOMS', () => {
        const check = (what) => assert.equal(requestRoomIds.size, countRequestRooms(), what);
        const used = usedRequestLink(CLOSED, 'k1', 'k1v');
        check('a sealed close');
        assert.ok(requestRoomIds.has(used.id), 'the marker keeps its slot');
        assert.equal(requestRoomIds.size, 1);
        const waiting = pairedRequestRoom('k2', 'k2v');
        handleRequestControl(waiting.host, 'request-close', waiting.id, CLOSED);
        check('an unsealed close');
        assert.equal(requestRoomIds.size, 1);

        // The cap: planted live reservations (host seated, young, so no sweep
        // ends them) and the one marker fill it exactly.
        for (let i = 1; i < MAX_REQUEST_ROOMS; i++) {
            roomMeta.set(`fill-${i}`, { keys: new Set(), kind: 'request', hostPeerId: `planted-${i}`, hostAbsentSince: null, createdAt: CLOSED, sealed: false });
            requestRoomIds.add(`fill-${i}`);
        }
        check('full');
        assert.equal(requestRoomIds.size, MAX_REQUEST_ROOMS);
        const t = newToken();
        assert.deepEqual(hostJoin(makePeer('late', 'k3'), t, CLOSED + 1), { type: 'refused', data: { code: 'limited' } });
        assert.equal(roomMeta.has(roomIdFromToken(t)), false);

        // The sweep frees the marker's slot, and only that one.
        cleanupTick(CLOSED + REQUEST_USED_MARKER_MS + 1);
        check('the marker sweep');
        assert.equal(requestRoomIds.size, MAX_REQUEST_ROOMS - 1);
        assert.deepEqual(hostJoin(makePeer('later', 'k3'), t, CLOSED + REQUEST_USED_MARKER_MS + 2), { type: 'room-joined', data: { role: 'host' } });
        check('a create into the freed slot');
        assert.equal(requestRoomIds.size, MAX_REQUEST_ROOMS);
    });

    // A pair that has signaled both ways, so its room is sealed (D-116), with
    // nothing closed yet.
    function sealedPair(hostKey, visitorKey) {
        const link = pairedRequestRoom(hostKey, visitorKey);
        handleSignal(link.host, { type: 'offer' }, null);
        handleSignal(link.visitor, { type: 'answer' }, null);
        assert.equal(roomMeta.get(link.id).sealed, true);
        link.host.msgs.length = 0;
        link.visitor.msgs.length = 0;
        return link;
    }

    // Every end of a sealed reservation other than request-close leaves
    // nothing (review 1 F1). A room is sealed from its pairing through the
    // prompt and a Decline, so such an end is no proof the link delivered
    // anything: a later visitor hears host-absent, and the token re-creates
    // the link (a fresh, counted create), as before D-130.
    function assertEndedWithoutMarker(link, at, what) {
        assert.equal(roomMeta.has(link.id), false, what);
        assert.equal(requestRoomIds.has(link.id), false, `${what}: its slot is free`);
        assert.equal(requestRoomIds.size, countRequestRooms(), `${what}: the count`);
        assert.equal(rooms.has(link.id), false, `${what}: no room`);
        const v = makePeer(`probe-${randomUUID()}`, 'k-probe');
        handleRequestJoin(v, link.id, at + 1);
        assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }], `${what}: request-join`);
    }

    // The token's holder comes back and gets a fresh reservation.
    function assertRecreated(link, hostKey, at, what) {
        const creates = createsInWindow(hostKey, at);
        const h = makePeer(`back-${randomUUID()}`, hostKey);
        assert.deepEqual(hostJoin(h, link.token, at), { type: 'room-joined', data: { role: 'host' } }, `${what}: re-created`);
        const meta = roomMeta.get(link.id);
        assert.equal(meta.used, undefined, `${what}: a reservation, not a marker`);
        assert.equal(meta.sealed, false, `${what}: fresh and unsealed`);
        assert.equal(meta.createdAt, at, `${what}: created now`);
        assert.equal(createsInWindow(hostKey, at), creates + 1, `${what}: a counted create`);
        assert.equal(requestRoomIds.size, countRequestRooms(), `${what}: the count after the create`);
    }

    it('a sealed reservation that ends any way but request-close leaves no marker, and its token re-creates the link', () => {
        // The grace sweep: the host went away after pairing without a
        // request-close (a laptop asleep during the prompt), the visitor still
        // seated, and nobody reclaimed within the grace.
        const grace = sealedPair('kg', 'kgv');
        handleDisconnect(grace.host, RQ_T0 + 1_000);
        assert.deepEqual(grace.visitor.msgs, [{ type: 'peer-disconnected', data: {} }]);
        grace.visitor.msgs.length = 0;
        const graceEnd = RQ_T0 + 1_000 + REQUEST_GRACE_MS + 1;
        cleanupTick(graceEnd);
        assert.equal(grace.visitor.roomId, null);
        assert.deepEqual(grace.visitor.msgs, [], 'the seated visitor is unseated silently, as before');
        assertEndedWithoutMarker(grace, graceEnd, 'the grace sweep');
        assertRecreated(grace, 'kg', graceEnd + 10, 'the grace sweep');

        // The same with seat 1 already empty: a Decline (sealed by
        // request-seal), the visitor gone, then the host.
        const declined = pairedRequestRoom('kd', 'kdv');
        handleRequestControl(declined.host, 'request-seal', declined.id);
        handleDisconnect(declined.visitor, RQ_T0 + 2_000);
        handleDisconnect(declined.host, RQ_T0 + 3_000);
        const declinedEnd = RQ_T0 + 3_000 + REQUEST_GRACE_MS + 1;
        cleanupTick(declinedEnd);
        assertEndedWithoutMarker(declined, declinedEnd, 'a Declined link past the grace');
        assertRecreated(declined, 'kd', declinedEnd + 10, 'a Declined link past the grace');

        // A lazy expiry: the token comes back after the grace, before any
        // sweep, and gets a fresh reservation at once.
        const lazy = sealedPair('kl', 'klv');
        handleDisconnect(lazy.host, RQ_T0 + 4_000);
        const lazyAt = RQ_T0 + 4_000 + REQUEST_GRACE_MS + 1;
        assertRecreated(lazy, 'kl', lazyAt, 'a lazy expiry');
        assert.equal(lazy.visitor.roomId, null, 'the old visitor is unseated');
        assert.deepEqual(lazy.visitor.msgs, [{ type: 'peer-disconnected', data: {} }], 'and told nothing more');

        // endReservation from any path but request-close.
        const direct = sealedPair('ke', 'kev');
        endReservation(direct.id, RQ_T0 + 5_000);
        assert.equal(direct.host.roomId, null);
        assert.equal(direct.visitor.roomId, null);
        assertEndedWithoutMarker(direct, RQ_T0 + 5_000, 'endReservation');
        assertRecreated(direct, 'ke', RQ_T0 + 6_000, 'endReservation');

        // The age ceiling, with its host still seated.
        const old = sealedPair('ko', 'kov');
        const ageEnd = RQ_T0 + REQUEST_MAX_AGE_MS + 1;
        cleanupTick(ageEnd);
        assert.equal(old.host.roomId, null);
        assert.equal(old.visitor.roomId, null);
        assert.equal(old.host.msgs.length + old.visitor.msgs.length, 0, 'silently');
        assertEndedWithoutMarker(old, ageEnd, 'the age ceiling');
        assertRecreated(old, 'ko', ageEnd + 10, 'the age ceiling');
    });

    it('every way an unsealed reservation ends leaves nothing, and a later request-join answers host-absent', () => {
        const gone = (id, what) => {
            assert.equal(roomMeta.has(id), false, what);
            assert.equal(requestRoomIds.has(id), false, `${what}: its slot is free`);
            assert.equal(requestRoomIds.size, countRequestRooms(), `${what}: the count`);
            const v = makePeer(`probe-${randomUUID()}`, 'k-probe');
            handleRequestJoin(v, id, RQ_T0);
            assert.deepEqual(v.msgs, [{ type: 'host-absent', data: {} }], `${what}: request-join`);
        };

        // The grace sweep: a host that waited alone, one whose visitor was
        // paired but had not signaled, and one whose sealed pair it reopened.
        const waiting = makePeer('waiting', 'kw');
        const wt = newToken();
        hostJoin(waiting, wt, RQ_T0);
        handleDisconnect(waiting, RQ_T0 + 1_000);
        const paired = pairedRequestRoom('kp', 'kpv');
        handleDisconnect(paired.host, RQ_T0 + 1_000);
        assert.deepEqual(paired.visitor.msgs, [{ type: 'host-absent', data: {} }], 'told at once, as before');
        const reopened = sealedPair('kr', 'krv');
        handleRequestControl(reopened.host, 'request-reopen', reopened.id);
        handleDisconnect(reopened.host, RQ_T0 + 1_000);
        cleanupTick(RQ_T0 + 1_000 + REQUEST_GRACE_MS + 1);
        gone(roomIdFromToken(wt), 'a waiting host, swept');
        gone(paired.id, 'paired, unsealed, swept');
        gone(reopened.id, 'reopened, swept');

        // A lazy expiry: today's counted fresh create.
        const lazy = pairedRequestRoom('kl', 'klv');
        handleDisconnect(lazy.host, RQ_T0 + 2_000);
        const lazyAt = RQ_T0 + 2_000 + REQUEST_GRACE_MS + 1;
        assert.deepEqual(hostJoin(makePeer('back', 'kl'), lazy.token, lazyAt), { type: 'room-joined', data: { role: 'host' } });
        assert.deepEqual({ used: roomMeta.get(lazy.id).used, createdAt: roomMeta.get(lazy.id).createdAt }, { used: undefined, createdAt: lazyAt });
        assert.equal(createsInWindow('kl', lazyAt), 2);

        // endReservation from any other path.
        const direct = pairedRequestRoom('ke', 'kev');
        endReservation(direct.id, RQ_T0 + 3_000);
        gone(direct.id, 'endReservation');

        // The age ceiling, with its host seated.
        const old = pairedRequestRoom('ko', 'kov');
        cleanupTick(RQ_T0 + REQUEST_MAX_AGE_MS + 1);
        assert.equal(old.host.roomId, null);
        gone(old.id, 'the age ceiling');

        // The policy purge, which only ever ends unsealed reservations (this
        // one, and the lazily re-created one above).
        const purged = pairedRequestRoom('kx', 'kxv');
        setPolicy(false);
        setPolicy(true);
        gone(purged.id, 'the policy purge');
        assert.equal(roomMeta.size, 0);
        assert.equal(requestRoomIds.size, 0);
    });

    it('a used marker never re-arms: touching, sweeping or ending it never gives it another day', () => {
        const marked = RQ_T0 + 1_000;
        const link = usedRequestLink(marked, 'kr', 'krv');
        assert.equal(roomMeta.get(link.id).closedAt, marked);

        // Everything that can reach it, a second before its day ends.
        const late = marked + REQUEST_USED_MARKER_MS - 1_000;
        handleRequestJoin(makePeer('v', 'kv'), link.id, late);
        hostJoin(makePeer('h', 'kr'), link.token, late);
        handleJoinRoom(makePeer('p', 'kp'), link.id);
        for (const p of [link.host, link.visitor]) {
            for (const type of ['request-seal', 'request-reopen', 'request-close']) handleRequestControl(p, type, link.id, late);
        }
        setPolicy(false);
        cleanupTick(late);
        setPolicy(true);
        cleanupTick(late);
        assert.deepEqual({ ...roomMeta.get(link.id) }, { kind: 'request', sealed: true, used: true, closedAt: marked });

        // Its end is final: the sweep forgets it rather than marking it again.
        cleanupTick(marked + REQUEST_USED_MARKER_MS + 1);
        assert.equal(roomMeta.has(link.id), false);
        assert.equal(requestRoomIds.has(link.id), false);
        cleanupTick(marked + 2 * REQUEST_USED_MARKER_MS + 2);
        assert.equal(roomMeta.has(link.id), false);

        // And a marker handed to endReservation is deleted, never renewed, even
        // when it comes the way a request-close hands a sealed room over.
        for (const [i, opts] of [undefined, { markUsed: true }].entries()) {
            const other = usedRequestLink(RQ_T0 + 1_000, `ko${i}`, `kov${i}`);
            endReservation(other.id, RQ_T0 + 2_000, opts);
            assert.equal(roomMeta.has(other.id), false, JSON.stringify(opts));
            assert.equal(requestRoomIds.has(other.id), false);
            assert.equal(requestRoomIds.size, countRequestRooms());
        }
    });
});
