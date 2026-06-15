// Floe receiver engine — framework-agnostic, no React or simple-peer imports.
// Extracted from P2PTransfer.tsx peer.on('data') handler.
import {
    classifyControl,
    ackMessage,
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
 *   });
 *   peer.on('data', rx.handleMessage);
 */
export function createReceiver(cb: ReceiverCallbacks): { handleMessage: (data: Uint8Array | ArrayBuffer) => void } {
    const partialDownloads = new Map<string, PartialDownload>();
    let currentMetadata: Metadata | null = null;

    let receiveSpeedStart = performance.now();
    let receiveSpeedBytes = 0;
    let lastReceiveSpeedUpdate = 0;

    function handleMessage(data: Uint8Array | ArrayBuffer): void {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
        const msg = classifyControl(buf);

        if (msg) {
            if (msg.type === 'metadata') {
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

        // Copy only the view's bytes into a new buffer (buf may be a view over a larger slab).
        fileData.chunks.push(buf.slice().buffer as ArrayBuffer);
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
