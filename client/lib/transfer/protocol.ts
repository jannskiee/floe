// Floe wire-protocol constants and message helpers.
// Mirrors cli/internal/transfer/sender.go + receiver.go — keep in sync.

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
    const localRange = localMin === localMax ? `protocol ${localMin}` : `protocol ${localMin}-${localMax}`;
    const remoteRange = remoteMin === remoteMax ? `protocol ${remoteMin}` : `protocol ${remoteMin}-${remoteMax}`;
    const localStr = localVer ? `${localRange} (${localVer})` : localRange;
    const remoteStr = remoteVer ? `${remoteRange} (${remoteVer})` : remoteRange;
    if (localTooOld) {
        return `Cannot transfer: your browser is running an older version of Floe.\nYou: ${localStr}  Peer: ${remoteStr}\nRefresh the page to get the latest version.`;
    }
    return `Cannot transfer: peer's floe is too old.\nYou: ${localStr}  Peer: ${remoteStr}\nAsk the other side to run \`floe update\`.`;
}

// --- Control message classifier ---

const decoder = new TextDecoder();

/**
 * Classifies a data channel message as a Floe control message or file data.
 * Returns the parsed control message if recognized, null if it should be
 * treated as file data (written to disk / appended to the receive buffer).
 *
 * Preserves exact browser semantics:
 *   - Only probe if byteLength <= CONTROL_MSG_MAX (1000)
 *   - Decoded text must start with '{'
 *   - JSON.parse must succeed and 'type' must be a known control type
 */
export function classifyControl(data: ArrayBuffer | Uint8Array): ControlMessage | null {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (buf.byteLength > CONTROL_MSG_MAX) return null;

    let text: string;
    try {
        text = decoder.decode(buf);
    } catch {
        return null;
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
