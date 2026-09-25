'use strict';

// Unit tests for server logic, all in this process. Only 'room seal over both
// transports' touches the network: it binds an ephemeral 127.0.0.1 port to
// drive the real connection handlers, and closes it when it is done.
// Uses Node's built-in test runner (node:test), available from Node 18+.
// Run with: npm test

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const WebSocket = require('ws');

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
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); });

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
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); });

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
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); });

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
    beforeEach(() => { rooms.clear(); roomMeta.clear(); roomToCode.clear(); codeFailures.clear(); });

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

    it('refuses a roomId that is not a string, without throwing', () => {
        // RegExp.test stringifies its argument: a deeply nested array blew the
        // stack (a 500 and a stack trace per request, FT-CODE-RANGE), and a
        // one-element array holding a UUID passed and became a map key.
        let deep = ROOM_ID;
        for (let i = 0; i < 50000; i++) deep = [deep];
        for (const roomId of [deep, [ROOM_ID], { toString: () => ROOM_ID }, 42, true]) {
            const res = fakeRes();
            assert.doesNotThrow(() => registerCodeHandler({ body: { roomId } }, res));
            assert.equal(res.statusCode, 400);
            assert.deepEqual(res.body, { error: 'Invalid room ID' });
        }
        assert.equal(codeToRoom.size, 0, 'nothing registered');
        assert.equal(roomToCode.size, 0, 'no reverse entry');
    });
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
