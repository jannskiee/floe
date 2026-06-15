// Floe wire-protocol constants and message helpers.
// Mirrors cli/internal/transfer/sender.go + receiver.go — keep in sync.

export const CONTROL_MSG_MAX = 1000; // bytes; matches browser byteLength guard
export const HIGH_WATER = 8 * 1024 * 1024; // 8 MB — pause sending at/above
export const LOW_WATER = 4 * 1024 * 1024;  // 4 MB — resume sending below
export const READ_SLAB = 4 * 1024 * 1024;  // 4 MB — disk read slab size
export const DEFAULT_CHUNK = 64 * 1024;    // 64 KB — fallback chunk size
export const MAX_CHUNK = 256 * 1024;       // 256 KB — cap on adaptive chunk

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
}

export interface Ack {
    type: 'ack';
    id: string;
    offset: number;
}

export interface End {
    type: 'end';
}

export type ControlMessage = Metadata | Ack | End;

// --- Message builders ---

export function metadataMessage(
    id: string,
    fileName: string,
    fileSize: number,
    index: number,
    total: number
): string {
    return JSON.stringify({ type: 'metadata', id, fileName, fileSize, index, total } satisfies Metadata);
}

export function ackMessage(id: string, offset: number): string {
    return JSON.stringify({ type: 'ack', id, offset } satisfies Ack);
}

export function endMessage(): string {
    return JSON.stringify({ type: 'end' } satisfies End);
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
    return null;
}
