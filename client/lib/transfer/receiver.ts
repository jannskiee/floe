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
    peerCompatErrorMessage,
    PROTOCOL_VERSION,
    MIN_PROTOCOL_VERSION,
    normalizeFileSize,
    normalizeSha256,
    metadataProblem,
    type End,
    type Metadata,
    type Incompatible,
} from './protocol';
import { hashBlob as workerHashBlob } from './fileHash';
import { sanitizeDisplayText } from '../download';

export interface ReceivedFile {
    id: string;
    fileName: string;
    fileSize: number;
    blob: Blob;
    // True only when the sender sent a SHA-256 and it matched this Blob. A
    // local fact, never a peer value.
    verified: boolean;
}

export interface ReceiverDeps {
    // The digest function, so a test can pass Node's crypto; the default is the
    // Worker behind hashBlob. A rejection, or a synchronous throw, is read as null.
    hashBlob?: (blob: Blob, signal?: AbortSignal) => Promise<string | null>;
    // How long a digest may take for a file of this many bytes before the file
    // is kept unverified instead.
    hashBoundMs?: (bytes: number) => number;
}

// A floor rate of 10 MB/s plus 30 s, so a 2 GB file gets 230 s. A worker that
// never replies must not keep settled() pending forever; a bound that fires
// keeps the file unverified, the same as a browser without Workers.
function defaultHashBoundMs(bytes: number): number {
    return Math.ceil((bytes / 10_000_000) * 1000) + 30_000;
}

const HASH_MISMATCH_REASON = 'receiver discarded a file because its SHA-256 did not match';
const HASH_UNREADABLE_REASON = "receiver discarded a file because the sender's SHA-256 was not readable";

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
    // A file's bytes are all here and its SHA-256 is being checked; the file is
    // handed over, or refused, when the check settles.
    onVerifying?: (index: number, total: number) => void;
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
 *
 * `settled()` resolves once no SHA-256 check is pending. A close handler waits on
 * it, because a Go sender exits right after its last end marker while this side
 * may still be hashing the file it sent.
 */
export function createReceiver(
    cb: ReceiverCallbacks,
    deps: ReceiverDeps = {}
): { handleMessage: (data: string | Uint8Array | ArrayBuffer) => void; settled: () => Promise<void> } {
    const hashBlob = deps.hashBlob ?? workerHashBlob;
    const hashBoundMs = deps.hashBoundMs ?? defaultHashBoundMs;
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
    // Files handed to onFileComplete in the current transfer: the `saved` a
    // hash refusal reports, the twin of filesReceived in the Go receiver.
    let filesHanded = 0;

    // While a SHA-256 check is pending, string frames wait here and are handled
    // in order once it settles. Binary frames are dropped instead: no file is
    // open during the wait, which is what the synchronous path would do to them.
    let pending = false;
    let queued: string[] = [];
    let settledWaiters: Array<() => void> = [];

    let receiveSpeedStart = performance.now();
    let receiveSpeedBytes = 0;
    let lastReceiveSpeedUpdate = 0;

    function handleMessage(data: string | Uint8Array | ArrayBuffer): void {
        if (aborted) return;
        if (pending) {
            if (isControlFrame(data)) queued.push(data);
            return;
        }
        processMessage(data);
    }

    function settled(): Promise<void> {
        if (!pending) return Promise.resolve();
        return new Promise((resolve) => settledWaiters.push(resolve));
    }

    // Hands a finished file over, in the order the callers rely on: the file,
    // then the per-transfer total, then the waiting state.
    function complete(meta: Metadata, blob: Blob, size: number, verified: boolean): void {
        cb.onFileComplete?.({ id: meta.id, fileName: meta.fileName, fileSize: size, blob, verified }, meta.index, meta.total);
        filesHanded += 1;
        // Accumulate for the per-transfer callback, then fire once on the
        // last file so reporting happens a single time per transfer.
        sessionBytes += size;
        if (meta.index === meta.total) {
            cb.onAllComplete?.(sessionBytes, meta.total);
            sessionBytes = 0; // reset for a possible subsequent transfer
            filesHanded = 0;
        }
        currentMetadata = null;
        expectedSize = null;
        cb.onWaiting?.();
        cb.onProgress?.(0, 0, 0);
        cb.onSpeedReset?.();
    }

    // A file that failed its SHA-256: nothing of it is kept, the sender is told
    // why with a code and the count already handed over, and the transfer stops.
    function refuseHash(unreadable: boolean): void {
        aborted = true;
        queued = [];
        partialDownloads.clear();
        currentMetadata = null;
        expectedSize = null;
        cb.onProgress?.(0, 0, 0);
        cb.onSpeedReset?.();
        try {
            const enc = new TextEncoder().encode(
                incompatibleMessage(unreadable ? HASH_UNREADABLE_REASON : HASH_MISMATCH_REASON, 'hash-mismatch', filesHanded)
            );
            cb.send(new Uint8Array(enc));
        } catch {
            // The peer is gone; the close is all it will get.
        }
        cb.onError?.(
            unreadable
                ? "The sender's SHA-256 for a file could not be read, so the file was discarded. Ask the sender to try again."
                : 'A file did not match what was sent, so it was discarded. Ask the sender to try again.'
        );
    }

    // Runs after a pending check settles: the frames that waited, in order,
    // until one of them starts another check or the transfer stops.
    function drain(): void {
        while (!pending && !aborted && queued.length > 0) {
            processMessage(queued.shift() as string);
        }
        if (aborted) queued = [];
        if (!pending) {
            const waiters = settledWaiters;
            settledWaiters = [];
            for (const resolve of waiters) resolve();
        }
    }

    function processMessage(data: string | Uint8Array | ArrayBuffer): void {
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
                partialDownloads.clear();
                currentMetadata = null;
                expectedSize = null;
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
                // A description Go would refuse is refused here too, before the
                // compatibility check and before any chunk is kept: a junk size
                // used to switch off the byte-count guard the SHA-256 check follows.
                const problem = metadataProblem(msg);
                if (problem !== null) {
                    aborted = true;
                    partialDownloads.clear();
                    currentMetadata = null;
                    expectedSize = null;
                    try {
                        const enc = new TextEncoder().encode(incompatibleMessage(`receiver rejected the file description: ${problem}`));
                        cb.send(new Uint8Array(enc));
                    } catch {
                        // The peer is gone; the close is all it will get.
                    }
                    cb.onError?.('The sender described a file in a way Floe could not read, so the transfer was stopped. Ask the sender to try again.');
                    return;
                }
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
                        // Two strings, not one. errMsg names the sides from
                        // this browser's point of view, which is right for the
                        // banner below and wrong for the wire: a peer that
                        // prints `reason` verbatim would read "You" as itself
                        // and be told the wrong side is old. The Go receiver
                        // has sent a peer-perspective reason since PR #282;
                        // this is the browser half of that.
                        const peerMsg = peerCompatErrorMessage(
                            localTooOld, '', msg.ver ?? '',
                            MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
                            remotePvMin || 1, remotePv || 1
                        );
                        // Send incompatible as binary so the CLI sender's ack loop
                        // can handle it; old senders drop unrecognized control types.
                        // No flush wait here, unlike the Go receiver: this side
                        // does not close the connection afterwards, it only
                        // sets UI state, so the frame has time to leave.
                        const enc = new TextEncoder().encode(incompatibleMessage(peerMsg));
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
                // Nothing more is coming, so let the buffered chunks go.
                partialDownloads.clear();
                currentMetadata = null;
                expectedSize = null;
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
                    // Best effort, and after nothing that matters locally: a
                    // throw from a peer already torn down must not swallow the
                    // only explanation this side ever shows.
                    try {
                        const enc = new TextEncoder().encode(
                            incompatibleMessage(`receiver discarded a file: ${detail}`)
                        );
                        cb.send(new Uint8Array(enc));
                    } catch {
                        // The peer is gone; the close is all it will get.
                    }
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

                const meta = currentMetadata;
                const size = fileData.received;

                // SHA-256, when the sender sent one, after the byte-count guard
                // so a short file still reports a short file. Read only through
                // normalizeSha256: a key that is present but unreadable (null, a
                // number, uppercase, the wrong length) refuses at once, before any
                // hashing, the twin of parseEnd in the Go receiver.
                if (Object.prototype.hasOwnProperty.call(msg, 'sha256')) {
                    const want = normalizeSha256((msg as End).sha256);
                    if (want === null) {
                        refuseHash(true);
                        return;
                    }
                    // The Blob is what the person keeps (its object URL is the
                    // download), so hashing this same object checks exactly those
                    // bytes. The chunk arrays are released before the wait, so
                    // memory peaks no longer than it did before the check.
                    const blob = new Blob(fileData.chunks);
                    partialDownloads.delete(meta.id);
                    currentMetadata = null;
                    expectedSize = null;
                    pending = true;
                    // Everything from here runs inside the promise chain, so nothing
                    // that throws (a callback, a hasher, an engine without
                    // AbortSignal.timeout, which Safari lacks before 16) can leave
                    // the receiver pending with every later frame queued behind it.
                    Promise.resolve()
                        .then(() => {
                            cb.onVerifying?.(meta.index, meta.total);
                            const signal =
                                typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                                    ? AbortSignal.timeout(hashBoundMs(size))
                                    : undefined;
                            return hashBlob(blob, signal);
                        })
                        .catch(() => null)
                        .then((got) => {
                            pending = false;
                            try {
                                // A null digest (no Worker, a worker failure, the time
                                // bound) keeps the file unverified: a missing check never
                                // claims a match, and the byte count already passed.
                                if (got !== null && got !== want) refuseHash(false);
                                else complete(meta, blob, size, got === want);
                            } finally {
                                drain();
                            }
                        });
                    return;
                }

                const blob = new Blob(fileData.chunks);
                partialDownloads.delete(meta.id);
                complete(meta, blob, size, false);
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

    return { handleMessage, settled };
}
