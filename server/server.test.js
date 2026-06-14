'use strict';

// Unit tests for pure server logic — no network I/O.
// Uses Node's built-in test runner (node:test), available from Node 18+.
// Run with: npm test

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
    getClientIp,
    generateCode,
    checkRateLimit,
    handleJoinRoom,
    handleSignal,
    handleDisconnect,
    rooms,
    codeToRoom,
    connectionCounts,
} = require('./server');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID   = '11111111-1111-1111-1111-111111111111';

function makePeer(id) {
    const msgs = [];
    return {
        id,
        roomId: null,
        msgs,
        send(type, data) { msgs.push({ type, data }); },
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
// generateCode
// ---------------------------------------------------------------------------

describe('generateCode', () => {
    beforeEach(() => { codeToRoom.clear(); });

    it('returns a three-word hyphen-delimited code', () => {
        const code = generateCode();
        const parts = code.split('-');
        assert.ok(parts.length >= 3, `expected ≥3 parts, got: ${code}`);
        parts.forEach(p => assert.ok(p.length > 0, `empty part in code: ${code}`));
    });

    it('falls back to a 4-word code after 10 collisions with active entries', () => {
        // Force Math.random to always return 0 so every attempt generates the same code.
        const orig = Math.random;
        Math.random = () => 0;
        try {
            const fixed = generateCode();                           // e.g. "apple-apple-apple"
            codeToRoom.set(fixed, { roomId: ROOM_ID, expires: Date.now() + 60_000 });
            const next = generateCode();
            assert.equal(next.split('-').length, 4, `expected 4-word fallback, got: ${next}`);
        } finally {
            Math.random = orig;
        }
    });

    it('treats an expired entry as a free slot and reuses the same 3-word code', () => {
        const orig = Math.random;
        Math.random = () => 0;
        try {
            const fixed = generateCode();
            codeToRoom.set(fixed, { roomId: ROOM_ID, expires: Date.now() - 1 }); // already expired
            const next = generateCode();
            assert.equal(next, fixed, 'expired slot should be reused');
            assert.equal(next.split('-').length, 3, 'should return the 3-word form');
        } finally {
            Math.random = orig;
        }
    });
});

// ---------------------------------------------------------------------------
// Room lifecycle — handleJoinRoom
// ---------------------------------------------------------------------------

describe('handleJoinRoom', () => {
    beforeEach(() => { rooms.clear(); });

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
    beforeEach(() => { rooms.clear(); });

    it('routes signal to the other peer when targeted by ID', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleSignal(pA, { type: 'offer' }, 'peer-B', null);

        assert.equal(pB.msgs.length, 1);
        assert.equal(pB.msgs[0].type, 'signal');
        assert.equal(pA.msgs.length, 0, 'sender should not receive its own signal');
    });

    it('routes signal by roomId when no targetId is given', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleSignal(pA, { type: 'candidate' }, null, ROOM_ID);

        assert.equal(pB.msgs.length, 1);
        assert.equal(pB.msgs[0].type, 'signal');
    });

    it('falls back to sender.roomId when neither targetId nor explicit roomId is given', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleSignal(pA, { type: 'candidate' }, null, null);

        assert.equal(pB.msgs.length, 1);
    });

    it('is a no-op when the target peer does not exist', () => {
        const pA = makePeer('peer-A');
        handleJoinRoom(pA, ROOM_ID);
        pA.msgs.length = 0;

        // Should not throw.
        handleSignal(pA, { type: 'offer' }, 'nonexistent-id', null);
        assert.equal(pA.msgs.length, 0);
    });

    it('is a no-op when signal payload is falsy', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pB.msgs.length = 0;

        handleSignal(pA, null, 'peer-B', null);
        assert.equal(pB.msgs.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Peer disconnect — handleDisconnect
// ---------------------------------------------------------------------------

describe('handleDisconnect', () => {
    beforeEach(() => { rooms.clear(); });

    it('notifies the remaining peer and removes the room', () => {
        const pA = makePeer('peer-A');
        const pB = makePeer('peer-B');
        handleJoinRoom(pA, ROOM_ID);
        handleJoinRoom(pB, ROOM_ID);
        pA.msgs.length = 0;
        pB.msgs.length = 0;

        handleDisconnect(pA);

        assert.ok(pB.msgs.some(m => m.type === 'peer-disconnected'));
        assert.equal(pB.roomId, null);
        assert.equal(rooms.has(ROOM_ID), false);
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
});
