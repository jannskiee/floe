// Floe wire-protocol constants and message helpers.
// Mirrors cli/engine/transfer/sender.go + receiver.go - keep in sync.
import { sanitizeDisplayText } from '../download';

export const CONTROL_MSG_MAX = 1000; // bytes; matches browser byteLength guard
export const HIGH_WATER = 8 * 1024 * 1024; // 8 MB — pause sending at/above
export const LOW_WATER = 4 * 1024 * 1024;  // 4 MB — resume sending below
export const READ_SLAB = 4 * 1024 * 1024;  // 4 MB — disk read slab size
export const DEFAULT_CHUNK = 64 * 1024;    // 64 KB — fallback chunk size
export const MAX_CHUNK = 256 * 1024;       // 256 KB — cap on adaptive chunk

// Milliseconds the sender waits for the receiver's ack before failing. Mirrors
// the CLI sender's 120 s ack deadline (cli/engine/transfer/sender.go). It must be
// this generous because a CLI receiver only acks after a human answers its
// interactive "Accept? [Y/n]" prompt; a shorter timeout aborts a browser→CLI
// transfer whenever the person at the terminal is slow to accept.
export const ACK_TIMEOUT_MS = 120_000;

// ProtocolVersion is the highest wire protocol version this build speaks.
// MinProtocolVersion is the lowest it still supports.
//
// Bump policy: increment ProtocolVersion on any breaking wire change. Raise
// MinProtocolVersion only when dropping support for an old wire format. Never
// tie either constant to the app's npm version — they are independent.
export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

// Adaptive chunk size: use the negotiated SCTP max, capped at MAX_CHUNK.
export function chunkSize(sctpMax?: number | null): number {
    if (sctpMax && Number.isFinite(sctpMax) && sctpMax > 0) {
        return Math.min(MAX_CHUNK, sctpMax);
    }
    return DEFAULT_CHUNK;
}

// --- Message types ---

export interface Metadata {
    type: 'metadata';
    id: string;
    fileName: string;
    fileSize: number;
    index: number;
    total: number;
    totalBytes: number;
    pv?: number;    // sender's highest protocol version (absent on legacy peers)
    pvMin?: number; // sender's minimum protocol version (absent on legacy peers)
    ver?: string;   // sender's human release string, e.g. "v1.5.5"
}

export interface Ack {
    type: 'ack';
    id: string;
    offset: number;
    pv?: number;    // receiver's highest protocol version
    pvMin?: number; // receiver's minimum protocol version
    ver?: string;   // receiver's human release string
}

export interface End {
    type: 'end';
}

// Sent by the CLI receiver after all files are written and verified.
// Tells the CLI sender delivery is confirmed so it can close cleanly.
// Browser receivers never send this; the protocol handles both cases.
export interface Received {
    type: 'received';
}

// Sent by the receiver to the sender when their protocol version ranges do not
// overlap. Sent as binary (Uint8Array) so old senders that don't know this
// type can safely drop it rather than treating it as file data.
export interface Incompatible {
    type: 'incompatible';
    reason: string;
    pv?: number;
    pvMin?: number;
    ver?: string;
}

export type ControlMessage = Metadata | Ack | End | Received | Incompatible;

// --- Message builders ---

export function metadataMessage(
    id: string,
    fileName: string,
    fileSize: number,
    index: number,
    total: number,
    totalBytes: number,
    ver?: string
): string {
    return JSON.stringify({
        type: 'metadata', id, fileName, fileSize, index, total, totalBytes,
        pv: PROTOCOL_VERSION,
        pvMin: MIN_PROTOCOL_VERSION,
        ver,
    } satisfies Metadata);
}

export function ackMessage(id: string, offset: number, ver?: string): string {
    return JSON.stringify({
        type: 'ack', id, offset,
        pv: PROTOCOL_VERSION,
        pvMin: MIN_PROTOCOL_VERSION,
        ver,
    } satisfies Ack);
}

export function endMessage(): string {
    return JSON.stringify({ type: 'end' } satisfies End);
}

export function incompatibleMessage(reason: string): string {
    return JSON.stringify({
        type: 'incompatible', reason,
        pv: PROTOCOL_VERSION,
        pvMin: MIN_PROTOCOL_VERSION,
    } satisfies Incompatible);
}

// --- Protocol compatibility ---

/**
 * Reports whether two peers can transfer files given their advertised protocol
 * version ranges. Missing (0/undefined) remote values indicate a legacy peer
 * and are treated as version 1.
 */
export function checkCompat(
    localMin: number,
    localMax: number,
    remoteMin: number,
    remoteMax: number
): { ok: boolean; localTooOld: boolean } {
    if (!remoteMin) remoteMin = 1;
    if (!remoteMax) remoteMax = 1;
    const lo = Math.max(localMin, remoteMin);
    const hi = Math.min(localMax, remoteMax);
    if (lo <= hi) return { ok: true, localTooOld: false };
    return { ok: false, localTooOld: remoteMin > localMax };
}

/**
 * Returns a user-facing error string for an incompatible peer. localVer and
 * remoteVer are human release strings; either may be empty for legacy peers.
 */
export function compatErrorMessage(
    localTooOld: boolean,
    localVer: string,
    remoteVer: string,
    localMin: number,
    localMax: number,
    remoteMin: number,
    remoteMax: number
): string {
    // Peer-supplied, and this covers both callers (the ver in receiver.ts and sender.ts).
    remoteVer = sanitizeDisplayText(remoteVer, 64);
    const localRange = localMin === localMax ? `protocol ${localMin}` : `protocol ${localMin}-${localMax}`;
    const remoteRange = remoteMin === remoteMax ? `protocol ${remoteMin}` : `protocol ${remoteMin}-${remoteMax}`;
    const localStr = localVer ? `${localRange} (${localVer})` : localRange;
    const remoteStr = remoteVer ? `${remoteRange} (${remoteVer})` : remoteRange;
    if (localTooOld) {
        return `Cannot transfer: your browser is running an older version of Floe.\nYou: ${localStr}  Peer: ${remoteStr}\nRefresh the page to get the latest version.`;
    }
    // Not "run `floe update`": the peer may be a browser or the desktop app,
    // and only the CLI has that command. Go passes an updateHint for exactly
    // this; the browser has no way to know which surface it is talking to, so
    // it says the thing that is true of all three.
    return `Cannot transfer: peer's floe is too old.\nYou: ${localStr}  Peer: ${remoteStr}\nAsk the other side to update Floe.`;
}

// --- Control message classifier ---

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Classifies a frame's BYTES as a Floe control message or as file data, and
 * returns the parsed control message or null.
 *
 * This answers a question about content only. Whether a frame is ELIGIBLE to be
 * control is the caller's to answer, and on the receive path the answer is the
 * SCTP framing, not the bytes: see `isControlFrame` and `createReceiver`.
 *
 *   - Only probe if byteLength <= CONTROL_MSG_MAX (1000)
 *   - Decoded text must start with '{'
 *   - JSON.parse must succeed and 'type' must be a known control type
 */
export function classifyControl(data: string | ArrayBuffer | Uint8Array): ControlMessage | null {
    let text: string;
    if (typeof data === 'string') {
        // A JS string measures in UTF-16 code units, and the cap is a byte
        // budget the Go receiver enforces on the same frame, so measure bytes.
        if (encoder.encode(data).byteLength > CONTROL_MSG_MAX) return null;
        text = data;
    } else {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (buf.byteLength > CONTROL_MSG_MAX) return null;
        try {
            text = decoder.decode(buf);
        } catch {
            return null;
        }
    }

    if (!text.startsWith('{')) return null;

    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return null;
    }

    const t = msg['type'];
    if (t === 'metadata') return msg as unknown as Metadata;
    if (t === 'ack') return msg as unknown as Ack;
    if (t === 'end') return msg as unknown as End;
    if (t === 'received') return msg as unknown as Received;
    if (t === 'incompatible') return msg as unknown as Incompatible;
    return null;
}

/**
 * Whether a frame arriving at a RECEIVER may be a control message at all.
 *
 * The wire already answers this and Floe used to ignore it. Every Floe sender
 * since v1.0.0 sends `metadata` and `end` as a TEXT frame (a JS string handed
 * to `peer.send`, or `dc.SendText` in the Go engine) and file chunks as BINARY.
 * So on the receive path a binary frame is file data, whatever its bytes spell.
 *
 * Probing the bytes was the bug (#316): a whole small file whose content is a
 * control-shaped JSON object, such as the 14 bytes `{"type":"end"}`, was
 * consumed as control and never written. Floe Desktop's Send-text box makes
 * that a one-click send.
 *
 * This is a PROHIBITION as much as a decision: a future sender-to-receiver
 * control frame MUST go out as text, or it lands in somebody's file. The
 * receiver-to-sender direction is unaffected and keeps its mixed framing
 * (`ack` is a string, `incompatible` is binary), because no file data travels
 * that way, so the sender's loops still classify by content.
 *
 * The browser could not see this bit until the peer was given
 * `readableObjectMode`: simple-peer pushes text frames through a non-objectMode
 * readable-stream Duplex, which Buffer.from()s them before Floe sees them.
 */
export function isControlFrame(data: string | ArrayBuffer | Uint8Array): data is string {
    return typeof data === 'string';
}

/**
 * Validates a peer-supplied `fileSize`.
 *
 * `classifyControl` above casts the parsed JSON straight to its interface, so
 * every field on a `Metadata` is whatever the other side chose to send:
 * `fileSize` may be absent, a string, negative, fractional, or beyond the range
 * where JavaScript integers are exact.
 *
 * Returns the value when it is a real byte count, and `null` otherwise. `null`
 * means "the peer announced no usable size", and every caller must fall back to
 * whatever it did before validation existed rather than treat it as a failure:
 * that is what keeps a peer which never announced a size working exactly as it
 * used to.
 *
 * Zero is a valid size and must survive as `0`, not collapse to `null`, or every
 * empty file would lose its (trivially satisfiable) integrity check.
 */
export function normalizeFileSize(value: unknown): number | null {
    if (typeof value !== 'number') return null;
    if (!Number.isInteger(value)) return null; // also rejects NaN and Infinity
    if (value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
    return value;
}
