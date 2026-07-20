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

// How often the progress ticker re-derives delivered bytes for the UI. It runs
// through backpressure and ack waits, so the bar keeps moving while the send
// loop itself is blocked on a slow link.
const PROGRESS_TICK_MS = 500;

// Buffer level to drain to before starting the next file's metadata/ack
// handshake. The ack can only arrive after the receiver consumes the previous
// file's tail (the channel is ordered), so draining first keeps the 120 s ack
// deadline from having to absorb a multi-MB drain on a slow relay.
const METADATA_DRAIN_THRESHOLD = 64 * 1024;

// Tracks the file currently shown in the UI. Progress is derived from
// DELIVERED bytes (queued offset minus what still sits in the channel buffer),
// not queued bytes: with an 8 MB high-water mark the two can differ by a
// minute's worth of data on a slow relay. The per-file ack guarantees the
// buffer only ever holds the displayed file's unsent tail (plus <1 KB of
// control messages), so the subtraction is sound.
interface ProgressView {
    active: boolean;
    size: number;
    offset: number; // bytes of this file queued into the channel so far
    lastSpeedTime: number;
    lastSpeedDelivered: number;
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

    const view: ProgressView = {
        active: false,
        size: 0,
        offset: 0,
        lastSpeedTime: performance.now(),
        lastSpeedDelivered: 0,
    };

    const emitView = () => {
        if (!view.active || destroyed()) return;
        const delivered = Math.min(
            view.size,
            Math.max(0, view.offset - deps.channel.bufferedAmount)
        );
        cb.onProgress?.(
            view.size > 0 ? Math.round((delivered / view.size) * 100) : 100
        );
        const now = performance.now();
        const dt = (now - view.lastSpeedTime) / 1000;
        if (dt >= 1 && delivered > view.lastSpeedDelivered) {
            const bytesPerSec = (delivered - view.lastSpeedDelivered) / dt;
            cb.onSpeed?.(bytesPerSec, (view.size - delivered) / bytesPerSec);
            view.lastSpeedTime = now;
            view.lastSpeedDelivered = delivered;
        }
    };

    const ticker = setInterval(emitView, PROGRESS_TICK_MS);

    try {
        for (let i = 0; i < files.length; i++) {
            if (destroyed()) return;
            const entry = files[i];
            const ok = await sendSingleFile(
                deps, entry, i + 1, files.length, totalBytes, cb, view, emitView
            );
            if (!ok) return;
        }

        if (destroyed()) return;

        // "All Files Sent!" must mean delivered, not queued: the last file's
        // tail (up to HIGH_WATER bytes) can still be in the buffer here.
        await drainBelow(deps.channel, 0, destroyed);
        if (destroyed()) return;

        emitView();
        cb.onSpeedReset?.();
        cb.onAllSent?.();
    } finally {
        clearInterval(ticker);
    }
}

// Resolves once the channel buffer has drained to at most `threshold` bytes
// (or the peer is destroyed). Uses the bufferedamountlow event plus a poll
// fallback, since the event is unreliable when the threshold changes while a
// drain is already in flight.
function drainBelow(
    channel: BufferChannel,
    threshold: number,
    destroyed: () => boolean
): Promise<void> {
    if (channel.bufferedAmount <= threshold || destroyed()) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        const prevThreshold = channel.bufferedAmountLowThreshold;
        channel.bufferedAmountLowThreshold = threshold;
        let poll: ReturnType<typeof setInterval> | null = null;
        const finish = () => {
            channel.removeEventListener('bufferedamountlow', onLow);
            if (poll) clearInterval(poll);
            channel.bufferedAmountLowThreshold = prevThreshold;
            resolve();
        };
        const onLow = () => {
            if (channel.bufferedAmount <= threshold) finish();
        };
        channel.addEventListener('bufferedamountlow', onLow);
        poll = setInterval(() => {
            if (destroyed() || channel.bufferedAmount <= threshold) finish();
        }, 200);
    });
}

// Result of waiting for the receiver's ack.
type AckResult =
    | { type: 'ack'; offset: number; pv?: number; pvMin?: number; ver?: string }
    | { type: 'incompatible'; reason: string }
    | { type: 'timeout' };

// Returns false when the transfer must stop (error already reported via cb).
async function sendSingleFile(
    deps: SenderDeps,
    entry: FileEntry,
    index: number,
    total: number,
    totalBytes: number,
    cb: SenderCallbacks,
    view: ProgressView,
    emitView: () => void
): Promise<boolean> {
    const { file, id } = entry;
    const { send, onData, channel } = deps;
    const destroyed = cb.isDestroyed ?? (() => false);

    if (destroyed()) return true;

    const CHUNK_SIZE = chunkSize(deps.sctpMaxMessageSize);

    // Let the previous file's tail drain before the handshake; the progress
    // ticker keeps updating the previous file's bar during this wait. No-op on
    // the first file (buffer is empty).
    await drainBelow(channel, METADATA_DRAIN_THRESHOLD, destroyed);
    if (destroyed()) return true;

    channel.bufferedAmountLowThreshold = LOW_WATER;

    // 1. Send metadata with protocol version fields
    try {
        send(metadataMessage(id, file.name, file.size, index, total, totalBytes));
    } catch {
        return false;
    }

    // 2. Wait for ack (120 s timeout), handling incompatible responses
    const ackResult = await waitForAck(onData, id);
    if (ackResult.type === 'timeout') {
        cb.onError?.('Transfer timed out waiting for receiver. Please try again.');
        return false;
    }
    if (ackResult.type === 'incompatible') {
        cb.onError?.(ackResult.reason);
        return false;
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
            return false;
        }
    }

    // The ack means the receiver has consumed everything before this file and
    // opened it — only now switch the displayed file, so the sender's label
    // and bar stay in step with what the receiver is actually working on.
    cb.onFileStart?.(index - 1, total, file.name);
    view.active = true;
    view.size = file.size;
    view.offset = ackResult.offset;
    view.lastSpeedTime = performance.now();
    view.lastSpeedDelivered = ackResult.offset;
    emitView();

    let offset = ackResult.offset;

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

    // 3. Send chunks. Progress/speed emission is owned by the ticker in
    // sendFiles, which derives delivered bytes from view.offset minus the
    // channel's bufferedAmount — this loop only advances view.offset.
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
            view.offset = offset;
        }
    }

    // 4. Send end marker
    try {
        send(endMessage());
    } catch { }

    return true;
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
