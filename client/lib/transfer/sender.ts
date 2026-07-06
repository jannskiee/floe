// Floe sender engine — framework-agnostic, no React or simple-peer imports.
// Extracted from P2PTransfer.tsx sendAllFiles/sendSingleFile.
import {
    HIGH_WATER,
    LOW_WATER,
    READ_SLAB,
    chunkSize,
    classifyControl,
    metadataMessage,
    endMessage,
    checkCompat,
    compatErrorMessage,
    PROTOCOL_VERSION,
    MIN_PROTOCOL_VERSION,
    ACK_TIMEOUT_MS,
    type Ack,
    type Incompatible,
} from './protocol';

export interface SenderCallbacks {
    onFileStart?: (index: number, total: number, fileName: string) => void;
    onProgress?: (percent: number) => void;
    onSpeed?: (bytesPerSec: number, etaSeconds: number) => void;
    onSpeedReset?: () => void;
    onError?: (msg: string) => void;
    onAllSent?: () => void;
    isDestroyed?: () => boolean;
}

export interface FileEntry {
    id: string;
    file: File;
}

// Minimal buffering interface used by the sender.
// The real implementation is RTCDataChannel; in tests a plain object works.
export interface BufferChannel {
    readonly bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    addEventListener(type: 'bufferedamountlow', handler: () => void): void;
    removeEventListener(type: 'bufferedamountlow', handler: () => void): void;
}

export interface SenderDeps {
    send: (data: string | Uint8Array) => void;
    // Registers a handler for incoming data (peer.on('data')).
    // Returns an unsubscribe function.
    onData: (handler: (data: Uint8Array | ArrayBuffer) => void) => () => void;
    channel: BufferChannel;
    sctpMaxMessageSize?: number | null;
}

/**
 * Sends all files over the data channel in order.
 *
 * Real usage (in component):
 *   const channel = (peer as any)._channel as RTCDataChannel;
 *   const pc = (peer as any)._pc as RTCPeerConnection;
 *   await sendFiles({
 *     send: d => peer.send(d),
 *     onData: h => { peer.on('data', h); return () => peer.off('data', h); },
 *     channel,
 *     sctpMaxMessageSize: pc?.sctp?.maxMessageSize,
 *   }, files, cb);
 */
export async function sendFiles(
    deps: SenderDeps,
    files: FileEntry[],
    cb: SenderCallbacks = {}
): Promise<void> {
    const destroyed = cb.isDestroyed ?? (() => false);
    const totalBytes = files.reduce((s, e) => s + e.file.size, 0);

    for (let i = 0; i < files.length; i++) {
        if (destroyed()) break;
        const entry = files[i];
        cb.onFileStart?.(i, files.length, entry.file.name);
        await sendSingleFile(deps, entry, i + 1, files.length, totalBytes, cb);
    }

    if (!destroyed()) {
        cb.onAllSent?.();
    }
}

// Result of waiting for the receiver's ack.
type AckResult =
    | { type: 'ack'; offset: number; pv?: number; pvMin?: number; ver?: string }
    | { type: 'incompatible'; reason: string }
    | { type: 'timeout' };

async function sendSingleFile(
    deps: SenderDeps,
    entry: FileEntry,
    index: number,
    total: number,
    totalBytes: number,
    cb: SenderCallbacks
): Promise<void> {
    const { file, id } = entry;
    const { send, onData, channel } = deps;
    const destroyed = cb.isDestroyed ?? (() => false);

    if (destroyed()) return;

    const CHUNK_SIZE = chunkSize(deps.sctpMaxMessageSize);

    channel.bufferedAmountLowThreshold = LOW_WATER;

    // 1. Send metadata with protocol version fields
    try {
        send(metadataMessage(id, file.name, file.size, index, total, totalBytes));
    } catch {
        return;
    }

    // 2. Wait for ack (15 s timeout), handling incompatible responses
    const ackResult = await waitForAck(onData, id);
    if (ackResult.type === 'timeout') {
        cb.onError?.('Transfer timed out waiting for receiver. Please try again.');
        return;
    }
    if (ackResult.type === 'incompatible') {
        cb.onError?.(ackResult.reason);
        return;
    }

    // Defense in depth: verify protocol compat from the receiver's pv fields on
    // the first file. The receiver already checked from its side; this catches
    // the case where an old receiver (no pv field, treated as v1) connects to a
    // future sender that dropped support for v1.
    if (index === 1 && (ackResult.pv !== undefined || ackResult.pvMin !== undefined)) {
        const { ok, localTooOld } = checkCompat(
            MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
            ackResult.pvMin ?? 0, ackResult.pv ?? 0
        );
        if (!ok) {
            cb.onError?.(compatErrorMessage(
                localTooOld, '', ackResult.ver ?? '',
                MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
                ackResult.pvMin ?? 1, ackResult.pv ?? 1
            ));
            return;
        }
    }

    let offset = ackResult.offset;
    let speedMeasureStart = performance.now();
    let speedMeasureBytes = 0;
    let lastSpeedUpdate = 0;
    let chunkCount = 0;

    const waitForBuffer = () =>
        new Promise<void>((r) => {
            const onLow = () => {
                channel.removeEventListener('bufferedamountlow', onLow);
                r();
            };
            if (channel.bufferedAmount < LOW_WATER) {
                r();
            } else {
                channel.addEventListener('bufferedamountlow', onLow);
            }
        });

    // 3. Send chunks
    while (offset < file.size) {
        if (destroyed()) break;

        const slabEnd = Math.min(offset + READ_SLAB, file.size);
        let slabBuffer: ArrayBuffer;
        try {
            slabBuffer = await file.slice(offset, slabEnd).arrayBuffer();
        } catch {
            break;
        }

        let slabOffset = 0;
        while (slabOffset < slabBuffer.byteLength) {
            if (destroyed()) break;

            if (channel.bufferedAmount >= HIGH_WATER) {
                await waitForBuffer();
            }

            if (destroyed()) break;

            const chunkLen = Math.min(CHUNK_SIZE, slabBuffer.byteLength - slabOffset);
            const chunk = new Uint8Array(slabBuffer, slabOffset, chunkLen);

            try {
                send(chunk);
            } catch {
                await new Promise((r) => setTimeout(r, 100));
                continue;
            }

            slabOffset += chunkLen;
            offset += chunkLen;
            speedMeasureBytes += chunkLen;
            chunkCount++;

            const now = performance.now();
            if (now - lastSpeedUpdate > 1000) {
                const elapsed = (now - speedMeasureStart) / 1000;
                if (elapsed > 0) {
                    const bytesPerSec = speedMeasureBytes / elapsed;
                    const remaining = file.size - offset;
                    cb.onSpeed?.(bytesPerSec, remaining / bytesPerSec);
                }
                speedMeasureStart = now;
                speedMeasureBytes = 0;
                lastSpeedUpdate = now;
            }

            if (chunkCount % 10 === 0 || offset >= file.size) {
                cb.onProgress?.(Math.round((offset / file.size) * 100));
            }
        }
    }

    cb.onSpeedReset?.();

    // 4. Send end marker
    try {
        send(endMessage());
    } catch { }
}

function waitForAck(
    onData: (handler: (data: Uint8Array | ArrayBuffer) => void) => () => void,
    fileId: string
): Promise<AckResult> {
    return Promise.race([
        new Promise<AckResult>((resolve) => {
            const off = onData((raw) => {
                const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                const msg = classifyControl(buf);
                if (!msg) return;
                if (msg.type === 'ack' && (msg as Ack).id === fileId) {
                    off();
                    const ack = msg as Ack;
                    resolve({ type: 'ack', offset: ack.offset, pv: ack.pv, pvMin: ack.pvMin, ver: ack.ver });
                } else if (msg.type === 'incompatible') {
                    off();
                    resolve({ type: 'incompatible', reason: (msg as Incompatible).reason });
                }
            });
        }),
        new Promise<AckResult>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), ACK_TIMEOUT_MS)),
    ]);
}
