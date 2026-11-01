// The pure half of the link-key check: which DTLS certificates a proof binds, the
// proof itself, its frame, and the guard on signals. keySession.ts decides when each
// runs. The wire spec is the Go engine's too (cli/engine/transfer/keycheck.go), and
// keycheck-vectors.json holds both to one independent generator.
//
// Everything read here came from the other side or the server: a certificate, an
// SDP, a tag, a signal. None of it is ever displayed, logged, stored or quoted in an
// error, and every failure comes back as null, not as words.

import { base64UrlDecode, base64UrlEncode, linkKeyBytes, type LinkKey } from '../linkKey';
import type { KeyCheckFrame } from './protocol';
import { hmacSha256, sha256 } from './sha256Sync';

/** 43 unpadded base64url characters, canonical: 32 bytes leave two padding bits in
 *  the last character. Anything else is malformed, a failed check for a side that
 *  holds the key. */
export const KC_TAG_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const TAG_BYTES = 32;
const HASH_BYTES = 32;
const CONTEXT = new TextEncoder().encode('floe-kc-v1');
const ROLE_SENDER = 0x73; // 's'
const ROLE_RECEIVER = 0x72; // 'r'

export type FileRole = 'sender' | 'receiver';

/** The part of RTCPeerConnection this reads, so a test can pass a fake. */
export interface CertSource {
    readonly localDescription: { readonly sdp?: unknown } | null;
    readonly remoteDescription: { readonly sdp?: unknown } | null;
    readonly sctp?: {
        readonly transport?: { getRemoteCertificates?: () => unknown } | null;
    } | null;
}

export interface CertHashes {
    /** SHA-256 of the file sender's DTLS certificate. */
    hS: Uint8Array;
    /** SHA-256 of the file receiver's DTLS certificate. */
    hR: Uint8Array;
    /** Where the remote hash came from: 'der' the certificate DTLS used, 'sdp' the
     *  strict fallback. */
    path: 'der' | 'sdp';
}

/**
 * SHA-256 of both ends' certificates, by file role, or null when they cannot be read
 * for certain: a side that holds the key then has no proof to give or check, and
 * never pretends otherwise.
 *
 * Local: this page's own description, every sha-256 fingerprint in it, all of which
 * must agree. Remote: the certificate DTLS actually used,
 * pc.sctp.transport.getRemoteCertificates()[0]. That is the point of the check, since
 * a server that swapped fingerprints in the SDP cannot change what DTLS presented.
 *
 * The fallback for a browser without that API reads the remote description, which the
 * server carried, so it holds only for a shape with no room for a trick: exactly one
 * m= line and exactly one fingerprint at any level, of any algorithm, and that one is
 * sha-256. Two of either is the BUNDLE offer that shows one reader an honest
 * fingerprint while DTLS uses another. It runs only when the API cannot answer, which
 * nothing the other side sends can cause once a channel is open, and only with the
 * lever on (KEY_CHECK_SDP_FALLBACK, passed in by the session).
 */
export function certHashes(
    pc: CertSource | null | undefined,
    fileRole: FileRole,
    options: { sdpFallback: boolean }
): CertHashes | null {
    if (!pc) return null;
    try {
        const local = localFingerprint(pc);
        if (!local) return null;
        const der = remoteDerHash(pc);
        const remote = der ?? (options.sdpFallback ? remoteSdpFingerprint(pc) : null);
        if (!remote) return null;
        const path = der ? 'der' : 'sdp';
        return fileRole === 'sender' ? { hS: local, hR: remote, path } : { hS: remote, hR: local, path };
    } catch {
        return null;
    }
}

function remoteDerHash(pc: CertSource): Uint8Array | null {
    try {
        const transport = pc.sctp?.transport;
        const certs = transport?.getRemoteCertificates?.() as unknown[] | undefined;
        const der = certs?.[0];
        return der instanceof ArrayBuffer && der.byteLength > 0 ? sha256(new Uint8Array(der)) : null;
    } catch {
        return null;
    }
}

function localFingerprint(pc: CertSource): Uint8Array | null {
    const lines = sdpLines(pc.localDescription?.sdp);
    if (!lines) return null;
    let found: Uint8Array | null = null;
    for (const line of lines) {
        if (!/^a=fingerprint:sha-256 /i.test(line)) continue;
        const value = decodeFingerprint(line.slice(line.indexOf(' ') + 1));
        if (!value || (found && !tagsEqual(found, value))) return null;
        found = value;
    }
    return found;
}

function remoteSdpFingerprint(pc: CertSource): Uint8Array | null {
    const lines = sdpLines(pc.remoteDescription?.sdp);
    if (!lines) return null;
    if (lines.filter((l) => /^m=/i.test(l)).length !== 1) return null;
    // Any spelling that starts this way counts, so a second line cannot hide from
    // the count by its case or by what follows the name.
    const prints = lines.filter((l) => /^a=fingerprint/i.test(l));
    if (prints.length !== 1) return null;
    const match = /^a=fingerprint:sha-256 (\S+)$/i.exec(prints[0]);
    return match ? decodeFingerprint(match[1]) : null;
}

/** The lines of a description, or null for one with a carriage return anywhere but
 *  ahead of a newline: where a parser would end such a line is a question this never
 *  has to answer. */
function sdpLines(sdp: unknown): string[] | null {
    if (typeof sdp !== 'string') return null;
    const lines = sdp.split(/\r\n|\n/);
    return lines.some((l) => l.includes('\r')) ? null : lines;
}

/** 32 bytes from hex, ignoring case and colons, or null. */
function decodeFingerprint(value: string): Uint8Array | null {
    const hex = value.replace(/:/g, '');
    if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
    const bytes = new Uint8Array(HASH_BYTES);
    for (let i = 0; i < HASH_BYTES; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}

/**
 * HMAC-SHA256(k, "floe-kc-v1" || 0x00 || role || len(roomId) as 1 byte || roomId || hS
 * || hR), with `role` the side whose tag this is, 's' or 'r'. The room id is used
 * exactly as held, case kept. Throws, in fixed words, on a room id that does not fit
 * the one length byte or a hash that is not 32 bytes: the message has to stay
 * unambiguous. The caller treats that as a check it cannot run.
 */
export function keyCheckTag(k: LinkKey, role: FileRole, roomId: string, hS: Uint8Array, hR: Uint8Array): Uint8Array {
    const room = new TextEncoder().encode(roomId);
    if (room.length === 0 || room.length > 255) throw new Error('a room id for a key check is 1 to 255 bytes');
    if (hS.length !== HASH_BYTES || hR.length !== HASH_BYTES) throw new Error('a certificate hash is 32 bytes');
    const message = new Uint8Array(CONTEXT.length + 3 + room.length + 2 * HASH_BYTES);
    let at = 0;
    message.set(CONTEXT, at);
    at += CONTEXT.length;
    message[at++] = 0x00;
    message[at++] = role === 'sender' ? ROLE_SENDER : ROLE_RECEIVER;
    message[at++] = room.length;
    message.set(room, at);
    at += room.length;
    message.set(hS, at);
    message.set(hR, at + HASH_BYTES);
    return hmacSha256(linkKeyBytes(k), message);
}

/** `{"type":"kc","tag":"<43>"}`, type first, 65 bytes, byte-equal to the Go frame. */
export function kcFrame(tag: Uint8Array): string {
    if (tag.length !== TAG_BYTES) throw new Error('a key check tag is 32 bytes');
    return JSON.stringify({ type: 'kc', tag: base64UrlEncode(tag) } satisfies KeyCheckFrame);
}

/** The one reader of a peer's tag: its own key `tag`, a canonical string, as 32 bytes;
 *  null for anything else. Twin of parseKC in Go, pinned by the keyCheck parity rows. */
export function parseKeyCheckTag(frame: KeyCheckFrame): Uint8Array | null {
    const value = Object.prototype.hasOwnProperty.call(frame, 'tag') ? frame.tag : undefined;
    return typeof value === 'string' && KC_TAG_RE.test(value) ? base64UrlDecode(value, TAG_BYTES) : null;
}

/** Constant time over the bytes, once the lengths agree: the tag is a secret until it
 *  has matched. */
export function tagsEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    return difference === 0;
}

/**
 * Which signals a peer instance on a keyed page will take from the server. Floe never
 * renegotiates, so the only description a connection needs is one, of the type the
 * WebRTC role expects: `peer.initiator ? 'answer' : 'offer'`, never the file role,
 * since a request-link visitor sends the file and answers. The fallback above relies
 * on that one being the first and the last.
 *
 * A signal is admitted or dropped whole and is never stripped: simple-peer destroys
 * the peer over a signal with none of its fields (index.js, 'signal() called with
 * invalid signal data'), so an emptied object is worse than a dropped one, and so
 * this drops what would do that too.
 */
export function createSignalGate(expected: 'offer' | 'answer'): { admit(signal: unknown): boolean } {
    let used = false;
    return {
        admit(signal: unknown): boolean {
            if (signal === null || typeof signal !== 'object') return false;
            const s = signal as Record<string, unknown>;
            if ('renegotiate' in s || 'transceiverRequest' in s) return false;
            if ('sdp' in s) {
                if (used || s.type !== expected || typeof s.sdp !== 'string' || s.sdp === '') return false;
                used = true;
                return true;
            }
            return Boolean(s.candidate);
        },
    };
}
