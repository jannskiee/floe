'use strict';

// The host token of a request link and the room id derived from it.
//
// Floe Desktop draws 32 random bytes, sends them as base64url without padding
// (exactly 43 characters) in `join-room {roomId, hostToken}` over /ws, and keeps
// them in memory only. The room id in the link is DERIVED from the token, so a
// link holder, who knows the room id, cannot find a token that derives it
// (preimage resistance): seat 0 stays unforgeable even after this server forgets
// a reservation (a restart, a grace expiry, request-close).
//
// The derivation is one algorithm on both sides (spec 04 5.3), pinned by
// cli/engine/signaling/testdata/derivation-vectors.json, which an independent
// Node one-liner generated from the formula before either implementation:
//   b = SHA-256(utf8("floe-request-room-v1:" + hostToken))[0:16]
//   b[6] = (b[6] & 0x0f) | 0x40      version 4
//   b[8] = (b[8] & 0x3f) | 0x80      variant 10
//   roomId = lowercase hex 8-4-4-4-12 of b
// 122 bits of the digest remain, and the result passes UUID_REGEX.
//
// Nothing here logs, and nothing here is ever given the token of a frame that
// has not passed HOST_TOKEN_REGEX: the regex runs before any hash, so a hostile
// length never reaches crypto.

const crypto = require('crypto');

const HOST_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;
const DERIVATION_PREFIX = 'floe-request-room-v1:';

// What the server keeps: a 32-byte Buffer, never the token. Compared only with
// crypto.timingSafeEqual against another hostTokenHash, so both sides are
// always 32 bytes and the length-mismatch RangeError cannot happen.
function hostTokenHash(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function uuidFormat(bytes16) {
    const h = Buffer.from(bytes16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function roomIdFromToken(token) {
    const digest = crypto.createHash('sha256').update(DERIVATION_PREFIX + token, 'utf8').digest();
    const b = Buffer.from(digest.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return uuidFormat(b);
}

module.exports = {
    HOST_TOKEN_REGEX,
    hostTokenHash,
    roomIdFromToken,
    uuidFormat,
};
