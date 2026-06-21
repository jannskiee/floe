// Floe receiver engine — framework-agnostic, no React or simple-peer imports.
// Extracted from P2PTransfer.tsx peer.on('data') handler.
import {
    classifyControl,
    ackMessage,
    incompatibleMessage,
    checkCompat,
    compatErrorMessage,
    PROTOCOL_VERSION,
    MIN_PROTOCOL_VERSION,
    type Metadata,
} from './protocol';

export interface ReceivedFile {
    id: string;
    fileName: string;
    fileSize: number;
    blob: Blob;
}

export interface ReceiverCallbacks {
    send: (data: string | Uint8Array) => void;
    onFileStart?: (index: number, total: number, fileName: string, fileSize: number) => void;
    onProgress?: (percent: number, received: number, fileSize: number) => void;
    onSpeed?: (bytesPerSec: number, etaSeconds: number) => void;
    onSpeedReset?: () => void;
    onFileComplete?: (file: ReceivedFile, index: number, total: number) => void;
    onWaiting?: () => void;
    onError?: (msg: string) => void;
}

interface PartialDownload {
    chunks: ArrayBuffer[];
    received: number;
}

/**
 * Creates a stateful receiver engine.
 * Call `handleMessage(data)` for every `peer.on('data', ...)` event.
 *
 * Real usage (in component):
 *   const rx = createReceiver({
 *     send: d => peer.send(d),
 *     onFileStart: (i, t, name) => setStatus(`Receiving file ${i} of ${t}`),
 *     onProgress: (pct) => setProgress(pct),
 *     onSpeed: (bps, eta) => { setTransferSpeed(formatSpeed(bps)); setEstimatedTime(formatETA(eta)); },
 *     onSpeedReset: () => { setTransferSpeed(''); setEstimatedTime(''); },
 *     onFileComplete: (file) => {
 *       const url = URL.createObjectURL(file.blob);
 *       setReceivedFiles(prev => [...prev, { ...file, downloadUrl: url }]);
 *     },
 *     onWaiting: () => setStatus('File received. Waiting for next file'),
 *     onError: (msg) => { setError(msg); setStatus('Transfer failed'); },
 *   });
 *   peer.on('data', rx.handleMessage);
 */
export function createReceiver(cb: ReceiverCallbacks): { handleMessage: (data: Uint8Array | ArrayBuffer) => void } {
    const partialDownloads = new Map<string, PartialDownload>();
    let currentMetadata: Metadata | null = null;
    let hasCheckedCompat = false;
    let incompatibleDetected = false;

    let receiveSpeedStart = performance.now();
    let receiveSpeedBytes = 0;
    let lastReceiveSpeedUpdate = 0;

    function handleMessage(data: Uint8Array | ArrayBuffer): void {
        if (incompatibleDetected) return;

        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
        const msg = classifyControl(buf);

        if (msg) {
            if (msg.type === 'metadata') {
                // Protocol compatibility check on first file, before sending ack
                // or accepting any file bytes.
                if (!hasCheckedCompat) {
                    hasCheckedCompat = true;
                    const remotePv = msg.pv ?? 0;
                    const remotePvMin = msg.pvMin ?? 0;
                    const { ok, localTooOld } = checkCompat(
                        MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
                        remotePvMin, remotePv
                    );
                    if (!ok) {
                        incompatibleDetected = true;
                        const errMsg = compatErrorMessage(
                            localTooOld, '', msg.ver ?? '',
                            MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
                            remotePvMin || 1, remotePv || 1
                        );
                        // Send incompatible as binary so the CLI sender's ack loop
                        // can handle it; old senders drop unrecognized control types.
                        const enc = new TextEncoder().encode(incompatibleMessage(errMsg));
                        cb.send(new Uint8Array(enc));
                        cb.onError?.(errMsg);
                        return;
                    }
                }

                currentMetadata = msg;
                receiveSpeedStart = performance.now();
                receiveSpeedBytes = 0;
                lastReceiveSpeedUpdate = 0;
                cb.onSpeedReset?.();
                cb.onFileStart?.(msg.index, msg.total, msg.fileName, msg.fileSize);

                let offset = 0;
                const existing = partialDownloads.get(msg.id);
                if (existing) {
                    offset = existing.received;
                } else {
                    partialDownloads.set(msg.id, { chunks: [], received: 0 });
                }

                // Send ack with protocol version fields so the sender can verify
                // compat from its side and show the optional peer-version note.
                cb.send(ackMessage(msg.id, offset));
            } else if (msg.type === 'end') {
                if (!currentMetadata) return;
                const fileData = partialDownloads.get(currentMetadata.id);
                if (!fileData) return;

                const blob = new Blob(fileData.chunks);
                const completed: ReceivedFile = {
                    id: currentMetadata.id,
                    fileName: currentMetadata.fileName,
                    fileSize: fileData.received,
                    blob,
                };

                partialDownloads.delete(currentMetadata.id);
                cb.onFileComplete?.(completed, currentMetadata.index, currentMetadata.total);
                cb.onWaiting?.();
                cb.onProgress?.(0, 0, 0);
                cb.onSpeedReset?.();
            }
            return;
        }

        // Binary chunk — file data
        if (!currentMetadata) return;
        const fileData = partialDownloads.get(currentMetadata.id);
        if (!fileData) return;

        // Copy the chunk's bytes into a fresh, tightly-fit ArrayBuffer. `buf` may be a
        // view over a much larger (or pooled/shared) ArrayBuffer — notably simple-peer
        // delivers a Node Buffer whose `.slice()` is a non-copying view, so storing
        // `buf.slice().buffer` would pin (and later mis-read) the whole backing buffer.
        // `new Uint8Array(buf)` copies exactly buf.byteLength bytes; `.buffer` is then
        // a tight ArrayBuffer of that length.
        fileData.chunks.push(new Uint8Array(buf).buffer);
        fileData.received += buf.byteLength;
        receiveSpeedBytes += buf.byteLength;

        const now = performance.now();
        if (now - lastReceiveSpeedUpdate > 1000) {
            const elapsed = (now - receiveSpeedStart) / 1000;
            if (elapsed > 0 && currentMetadata.fileSize) {
                const bytesPerSec = receiveSpeedBytes / elapsed;
                const remaining = currentMetadata.fileSize - fileData.received;
                cb.onSpeed?.(bytesPerSec, remaining / bytesPerSec);
            }
            receiveSpeedStart = now;
            receiveSpeedBytes = 0;
            lastReceiveSpeedUpdate = now;
        }

        if (
            currentMetadata.fileSize &&
            (fileData.received % (160 * 1024 * 10) === 0 ||
                fileData.received === currentMetadata.fileSize)
        ) {
            cb.onProgress?.(
                Math.round((fileData.received / currentMetadata.fileSize) * 100),
                fileData.received,
                currentMetadata.fileSize
            );
        }
    }

    return { handleMessage };
}
