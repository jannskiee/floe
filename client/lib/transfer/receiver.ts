// Floe receiver engine — framework-agnostic, no React or simple-peer imports.
// Extracted from P2PTransfer.tsx peer.on('data') handler.
import {
    classifyControl,
    isControlFrame,
    isAbortReason,
    CONTROL_MSG_MAX,
    ackMessage,
    incompatibleMessage,
    checkCompat,
    compatErrorMessage,
    PROTOCOL_VERSION,
    MIN_PROTOCOL_VERSION,
    normalizeFileSize,
    type Metadata,
    type Incompatible,
} from './protocol';
import { sanitizeDisplayText } from '../download';

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
    /**
     * Fires exactly once when the final file of a transfer completes (index === total),
     * carrying the summed bytes and file count for the whole transfer. Use this for
     * per-transfer side effects (analytics, the global byte counter) so they run once
     * instead of once per file. Mirrors the sender's `onAllSent`.
     */
    onAllComplete?: (totalBytes: number, fileCount: number) => void;
    onWaiting?: () => void;
    onError?: (msg: string) => void;
}

// Report receive progress at least once per this many bytes. A byte-count
// threshold (rather than an exact modulo) works for any negotiated chunk size.
const PROGRESS_STEP = 1024 * 1024; // 1 MB

interface PartialDownload {
    chunks: ArrayBuffer[];
    received: number;
    lastReported: number; // `received` value at the last onProgress emission
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
export function createReceiver(cb: ReceiverCallbacks): { handleMessage: (data: string | Uint8Array | ArrayBuffer) => void } {
    const partialDownloads = new Map<string, PartialDownload>();
    let currentMetadata: Metadata | null = null;
    let hasCheckedCompat = false;
    // Hard stop. Set by any unrecoverable failure (an incompatible peer, or a
    // file that did not arrive whole); every later message is dropped.
    let aborted = false;
    // The announced size of the file being received, once validated, or null
    // when the peer announced nothing we can compare against.
    let expectedSize: number | null = null;
    let sessionBytes = 0; // accumulated across all files of the current transfer

    let receiveSpeedStart = performance.now();
    let receiveSpeedBytes = 0;
    let lastReceiveSpeedUpdate = 0;

    function handleMessage(data: string | Uint8Array | ArrayBuffer): void {
        if (aborted) return;

        // Framing decides, not content. See isControlFrame: a binary frame on
        // this side is file data even when its bytes spell a control message,
        // which is what a small .json file's whole content can do.
        if (isControlFrame(data)) {
            const text = data;
            // Mirrors the Go receiver: a string past the control cap is not
            // something to write and not something to parse, it is a peer
            // sending prose where a control message belongs. The browser used
            // to fall through and append it to the file instead, which quietly
            // corrupted any transfer whose metadata ran long (a deep enough
            // folder path does it).
            if (new TextEncoder().encode(text).byteLength > CONTROL_MSG_MAX) {
                aborted = true;
                cb.onError?.(
                    'The sender sent a control message larger than ' +
                        `${CONTROL_MSG_MAX} bytes, so the transfer was stopped.`
                );
                return;
            }
            const msg = classifyControl(text);
            // An unrecognized control type is dropped, not written. The Go
            // receiver has always done this; the browser used to append it to
            // whatever file was open, which is what made adding any new frame
            // type unsafe.
            if (!msg) return;

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
                        aborted = true;
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
                // classifyControl casts the metadata JSON straight to its
                // interface, so fileSize is whatever the peer chose to send.
                // Anything that is not a real byte count becomes null, which
                // reads as "unknown" everywhere below.
                expectedSize = normalizeFileSize(msg.fileSize);
                receiveSpeedStart = performance.now();
                receiveSpeedBytes = 0;
                lastReceiveSpeedUpdate = 0;
                cb.onSpeedReset?.();
                cb.onFileStart?.(msg.index, msg.total, msg.fileName, expectedSize ?? 0);

                let offset = 0;
                const existing = partialDownloads.get(msg.id);
                if (existing) {
                    offset = existing.received;
                } else {
                    partialDownloads.set(msg.id, { chunks: [], received: 0, lastReported: 0 });
                }

                // Send ack with protocol version fields so the sender can verify
                // compat from its side and show the optional peer-version note.
                cb.send(ackMessage(msg.id, offset));
            } else if (msg.type === 'incompatible') {
                // The sender is stopping on purpose and said why. This used to
                // be classified as control purely so it was never written as
                // file data, and then dropped, so the reason went nowhere and
                // the close that followed it was all this side had to go on.
                //
                // Latched, because peer.destroy() raises "User-Initiated Abort"
                // on this side a moment later and its handler would otherwise
                // overwrite the real reason with connection advice.
                aborted = true;
                const incompat = msg as Incompatible;
                const reason = sanitizeDisplayText(incompat.reason ?? '', 300);
                cb.onError?.(
                    isAbortReason(incompat) && reason
                        ? reason
                        : 'The sender stopped the transfer.'
                );
                return;
            } else if (msg.type === 'end') {
                if (!currentMetadata) return;
                const fileData = partialDownloads.get(currentMetadata.id);
                if (!fileData) return;

                // Integrity guard, matching cli/engine/transfer/receiver.go: a
                // byte count that does not equal the announced size means the
                // file is not what the sender described, so refuse it rather
                // than hand over something that looks complete.
                //
                // Exact inequality on two numbers, never a threshold or a timer.
                // Both directions fail: a short count is a truncation, and an
                // over-count means a frame boundary was wrong, which corrupts
                // the blob just as thoroughly.
                //
                // `expectedSize` is null when the peer announced no usable size,
                // and that skips the guard entirely. That is the whole
                // back-compat surface: a peer that sends nothing we can compare
                // against behaves exactly as it did before.
                if (expectedSize !== null && fileData.received !== expectedSize) {
                    // The name lands in an error banner, so it is the display
                    // form: a bidi override in the wire string would reorder
                    // the words of the banner around it.
                    const name = sanitizeDisplayText(currentMetadata.fileName);
                    const got = fileData.received;
                    const want = expectedSize;
                    const detail = `Incomplete file "${name}": received ${got} of ${want} bytes`;
                    partialDownloads.delete(currentMetadata.id);
                    currentMetadata = null;
                    expectedSize = null;
                    // Latch, like the incompatibility path: without this a
                    // multi-file transfer reports the failure and then flips
                    // straight back to "Receiving file 3 of 3".
                    aborted = true;
                    cb.onProgress?.(0, 0, 0);
                    cb.onSpeedReset?.();
                    // Tell the sender, or it just stops being acked: with more
                    // files to send it waits out the full 120 s ack deadline and
                    // then reports a timeout, which is the wrong cause two
                    // minutes late. Binary, like the compatibility path above,
                    // because nothing travelling receiver to sender is file data.
                    const enc = new TextEncoder().encode(
                        incompatibleMessage(`receiver discarded a file: ${detail}`)
                    );
                    cb.send(new Uint8Array(enc));
                    // Over-count is not truncation: it means a frame boundary
                    // was wrong, so say that rather than blaming the sender for
                    // stopping early.
                    cb.onError?.(
                        `${detail}. ` +
                        (got < want
                            ? 'The transfer was cut short, so the file was discarded.'
                            : 'More data arrived than the sender announced, so the file was discarded.') +
                        ' Ask the sender to try again.'
                    );
                    return;
                }

                const blob = new Blob(fileData.chunks);
                const completed: ReceivedFile = {
                    id: currentMetadata.id,
                    fileName: currentMetadata.fileName,
                    fileSize: fileData.received,
                    blob,
                };

                partialDownloads.delete(currentMetadata.id);
                cb.onFileComplete?.(completed, currentMetadata.index, currentMetadata.total);

                // Accumulate for the per-transfer callback, then fire once on the
                // last file so reporting happens a single time per transfer.
                sessionBytes += fileData.received;
                if (currentMetadata.index === currentMetadata.total) {
                    cb.onAllComplete?.(sessionBytes, currentMetadata.total);
                    sessionBytes = 0; // reset for a possible subsequent transfer
                }

                currentMetadata = null;
                expectedSize = null;
                cb.onWaiting?.();
                cb.onProgress?.(0, 0, 0);
                cb.onSpeedReset?.();
            }
            return;
        }

        // Binary frame: file data, unconditionally.
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
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
            if (elapsed > 0 && expectedSize) {
                const bytesPerSec = receiveSpeedBytes / elapsed;
                const remaining = expectedSize - fileData.received;
                cb.onSpeed?.(bytesPerSec, remaining / bytesPerSec);
            }
            receiveSpeedStart = now;
            receiveSpeedBytes = 0;
            lastReceiveSpeedUpdate = now;
        }

        if (
            expectedSize &&
            (fileData.received - fileData.lastReported >= PROGRESS_STEP ||
                fileData.received === expectedSize)
        ) {
            fileData.lastReported = fileData.received;
            cb.onProgress?.(
                Math.round((fileData.received / expectedSize) * 100),
                fileData.received,
                expectedSize
            );
        }
    }

    return { handleMessage };
}
