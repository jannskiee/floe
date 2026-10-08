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
    hashBoundMs as defaultHashBoundMs,
    POST_END_HASH_WAIT_MS,
    type End,
    type Metadata,
    type Incompatible,
} from './protocol';
import { hashBlob as workerHashBlob } from './fileHash';
import { sanitizeDisplayText } from '../download';
import { classifyThrow, type ReceiveFailureCode } from './receiveFailure';

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

// String frames held while a SHA-256 check is pending. A conforming sender has
// at most one in flight (it waits for the next ack), so this is room to spare,
// not a tuning knob.
export const MAX_QUEUED_WHILE_PENDING = 8;

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
    /**
     * `failure` is set only when this side stopped because something threw
     * while a frame was handled, and never carries a peer string, so its
     * fields may go to an error report. Every other stop calls with `msg` alone.
     */
    onError?: (msg: string, failure?: ReceiveFailure) => void;
}

export interface ReceiveFailure {
    /** 'out-of-memory' is the tab running out; 'internal' is anything else (see receiveFailure.ts). */
    code: Exclude<ReceiveFailureCode, 'channel-closed'>;
    /** What was thrown. For an error report only, never for the screen. */
    cause: unknown;
    /** Bytes of the open file held when it threw, 0 when none was open. */
    received: number;
    /** The open file's announced size, or null when unknown or none was open. */
    expected: number | null;
    /**
     * Whether the sender's metadata carried a `ver`. Go senders (the CLI and
     * Floe Desktop) always send one and browser senders never do, and only a
     * Go sender reads an abort that arrives in the middle of a file.
     */
    senderSentVersion: boolean;
}

export const OUT_OF_MEMORY_MESSAGE =
    'This browser ran out of memory while receiving, so the transfer was stopped. ' +
    'Receive large files on a computer with Floe Desktop (Windows) or the Floe CLI, which save straight to disk.';

export const INTERNAL_ERROR_MESSAGE =
    'Something went wrong while receiving, so the transfer was stopped. Ask the sender to try again.';

// Report receive progress at least once per this many bytes. A byte-count
// threshold (rather than an exact modulo) works for any negotiated chunk size.
const PROGRESS_STEP = 1024 * 1024; // 1 MB

// Chunk copies wait in the tab until this many bytes have gathered, then go
// into a Blob part together. In Chromium a Blob's bytes leave the renderer for
// the browser's blob storage, which pages to disk past its memory share, so
// the tab holds at most about this much of a file at a time instead of all of
// it (FLOE-M ran a tab out of memory holding a whole file as ArrayBuffers).
// Measured with a 4 GiB file on Chromium 151: the renderer stayed at 50-138 MiB
// where it used to peak at 9.4 GiB.
// Other engines keep Blob bytes in memory; there this changes no total, it
// only removes the second full copy `end` used to make. Large enough that the
// per-part overhead is noise, small next to any device's memory.
//
// The line counts bytes, so the number of copies is bounded separately (see
// STAGE_BYTES), and only the open file holds any: a metadata for another id
// lets the file it leaves go. Before both, a sender writing one-byte frames
// kept 16 M copies, about 1.6 GiB of heap, before the first spill, a renderer
// kill that fail() never sees, and one rotating ids kept just under this line
// in the tab for every id it opened (review R0-06-H6 L1).
export const SPILL_BYTES = 16 * 1024 * 1024; // 16 MiB

// A frame smaller than this is copied into the file's staging buffer of this
// size rather than becoming a copy of its own; the buffer joins the held
// copies when the next frame does not fit or a larger frame follows. So the
// tab holds at most about two copies per STAGE_BYTES of a file whatever the
// frame sizes, and every part is still cut at the SPILL_BYTES line. Measured
// in Node 22: a one-byte copy costs about 100 B of heap and 300 B of process
// memory, and a count line that spilled every 1024 copies (the review's trial
// fix) still left process memory 416 MiB up after 2 M one-byte frames,
// because the Blob keeps each copy as its own piece (2 M one-byte pieces:
// 411 MiB; the same bytes joined: 6 MiB). Floe's senders write frames of
// 16 KiB or more apart from each file's last, so those are copied as they
// always were.
const STAGE_BYTES = 16 * 1024;

interface PartialDownload {
    parts: Blob[]; // spilled, in order
    held: ArrayBuffer[]; // tight chunk copies not yet spilled, in order
    stage: Uint8Array<ArrayBuffer> | null; // small frames gathered (see STAGE_BYTES); null when none are
    staged: number; // bytes in use in `stage`, after everything in `held`
    heldBytes: number; // bytes in `held` and `stage` together
    received: number;
    lastReported: number; // `received` value at the last onProgress emission
    tail: Promise<void> | null; // the read-back of the newest part (see probe), null before the first
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
): {
    handleMessage: (data: string | Uint8Array | ArrayBuffer) => void;
    settled: () => Promise<void>;
    dispose: () => void;
} {
    const hashBlob = deps.hashBlob ?? workerHashBlob;
    const hashBoundMs = deps.hashBoundMs ?? defaultHashBoundMs;
    const partialDownloads = new Map<string, PartialDownload>();
    let currentMetadata: Metadata | null = null;
    let hasCheckedCompat = false;
    // Hard stop. Set by any unrecoverable failure (an incompatible peer, a
    // file that did not arrive whole, or a throw; see fail); every later
    // message is dropped.
    let aborted = false;
    // Set when the connection closing is what stopped the receiver, rather than
    // a failure it already reported. A part found broken after that still has
    // to be reported (see probe), and a SHA-256 check in progress still
    // finishes (see dispose).
    let closed = false;
    // The announced size of the file being received, once validated, or null
    // when the peer announced nothing we can compare against.
    let expectedSize: number | null = null;
    let sessionBytes = 0; // accumulated across all files of the current transfer
    let senderSentVersion = false; // see ReceiveFailure.senderSentVersion
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
        runMessage(data);
    }

    // Every frame goes through here, never straight to processMessage, so a
    // throw anywhere in it ends the transfer once (see fail). That covers a
    // frame held while a SHA-256 check is pending (its TextEncoder is an
    // allocation like any other) and every frame drain hands back afterwards.
    function runMessage(data: string | Uint8Array | ArrayBuffer): void {
        try {
            if (pending) holdWhilePending(data);
            else processMessage(data);
        } catch (err) {
            // A frame that already stopped the transfer and then threw (one of
            // its own callbacks, say) has said what went wrong; a second
            // message would talk over it. Let the throw surface, once.
            if (aborted) throw err;
            fail(err);
        }
    }

    function holdWhilePending(data: string | Uint8Array | ArrayBuffer): void {
        if (!isControlFrame(data)) return;
        // The control cap and a bound on the queue hold during a check too.
        // Without them a sender could park any number of strings of any size
        // in memory for as long as the hash takes (DV-AUDIT CP-0 F1). A
        // conforming sender has at most one frame in flight here: the next
        // file's metadata, or an incompatible.
        if (new TextEncoder().encode(data).byteLength > CONTROL_MSG_MAX) {
            stopWhilePending(
                'The sender sent a control message larger than ' +
                    `${CONTROL_MSG_MAX} bytes, so the transfer was stopped.`
            );
            return;
        }
        if (queued.length >= MAX_QUEUED_WHILE_PENDING) {
            stopWhilePending(
                'The sender sent more messages than a transfer allows while a file was being checked, so the transfer was stopped.'
            );
            return;
        }
        queued.push(data);
    }

    // A stop while a check is pending: nothing more is queued or kept, and the
    // file being checked is not handed over when its digest settles.
    function stopWhilePending(message: string): void {
        aborted = true;
        queued = [];
        partialDownloads.clear();
        currentMetadata = null;
        expectedSize = null;
        cb.onError?.(message);
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
        closed = false; // reported now, as in fail(), so a later broken part stays quiet
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
    // until one of them starts another check or the transfer stops. Through
    // runMessage, so a throw from a frame that waited is caught and latched
    // like any other instead of escaping the promise chain with nothing latched.
    //
    // In a finally, because runMessage lets a throw from a frame that already
    // stopped the transfer surface: that must not leave settled() waiters, the
    // component's close and error handlers among them, waiting for good.
    function drain(): void {
        try {
            while (!pending && !aborted && queued.length > 0) {
                runMessage(queued.shift() as string);
            }
        } finally {
            if (aborted) queued = [];
            if (!pending) {
                const waiters = settledWaiters;
                settledWaiters = [];
                for (const resolve of waiters) resolve();
            }
        }
    }

    // Anything that throws while a frame is handled ends the transfer here,
    // once. Before this the throw escaped into simple-peer's emitter with
    // nothing latched, so every later frame threw again: a tab that ran out of
    // memory raised the same uncaught error on each chunk for minutes (FLOE-M,
    // 3,871 events in six minutes from one receiver) and kept every byte it
    // already held, so the next load of the link could not even start (FLOE-N).
    function fail(
        err: unknown,
        code: ReceiveFailureCode = classifyThrow(err),
        sizes?: { received: number; expected: number | null }
    ): void {
        const open = currentMetadata ? partialDownloads.get(currentMetadata.id) : undefined;
        // Sizes describe a file still being received. A throw after the file
        // was handed over (from onFileComplete, say) has none open; a broken
        // part brings the sizes from when it was written (see probe).
        const received = sizes ? sizes.received : (open?.received ?? 0);
        const expected = sizes ? sizes.expected : open ? expectedSize : null;
        // Latch and let go of every held chunk before anything else: the work
        // below needs a little memory too, and V8 collects and retries a
        // failed allocation, so what is released here is what it gets. The
        // frames waiting out a check go too: none of them will be read now.
        release();
        queued = [];
        closed = false; // reported now, so a later broken part stays quiet
        // Our own ack could not go out because the channel is closing. The
        // connection is what failed, and the peer's close handler says so.
        if (code === 'channel-closed') return;
        // Tell the sender, or it keeps sending into a receiver that drops it
        // all. Binary, like every receiver-to-sender frame, and best effort.
        // write-failed is the closed set's code for a receiver that could not
        // keep a file, which is what both causes come to here; `saved` is the
        // count already handed over, as a hash refusal sends it. The reason
        // stays for peers that predate the code and print it verbatim.
        try {
            const of = expected === null ? '' : ` of ${expected}`;
            const reason =
                code === 'out-of-memory'
                    ? `receiver ran out of memory after receiving ${received}${of} bytes`
                    : 'receiver stopped because of an internal error';
            cb.send(new Uint8Array(new TextEncoder().encode(incompatibleMessage(reason, 'write-failed', filesHanded))));
        } catch {
            // The peer is gone, or even this did not fit; the close is all it gets.
        }
        // Clear the progress line, as the discard path does. Best effort, so
        // a throw here cannot cost the person the only explanation.
        try {
            cb.onProgress?.(0, 0, 0);
            cb.onSpeedReset?.();
        } catch {
            // Nothing to add: onError below is what matters.
        }
        cb.onError?.(
            code === 'out-of-memory' ? OUT_OF_MEMORY_MESSAGE : INTERNAL_ERROR_MESSAGE,
            { code, cause: err, received, expected, senderSentVersion }
        );
    }

    // Moves the held chunk copies into one Blob part, then checks it. The
    // check is kept as the file's tail, which a SHA-256 check waits for.
    function spill(file: PartialDownload): void {
        unstage(file);
        const part = new Blob(file.held);
        file.parts.push(part);
        file.held = [];
        file.heldBytes = 0;
        file.tail = probe(part, { received: file.received, expected: expectedSize });
    }

    // Moves the staged bytes to the end of the held copies as one tight copy
    // (a full stage is one already). A stage only exists with bytes in it.
    function unstage(file: PartialDownload): void {
        if (file.stage === null) return;
        file.held.push(file.staged === STAGE_BYTES ? file.stage.buffer : file.stage.slice(0, file.staged).buffer);
        file.stage = null;
        file.staged = 0;
    }

    // Chromium does not throw when its blob storage is full (Incognito pages
    // nothing to disk and shares about 2 GiB per profile on a computer; a
    // normal profile pages to disk up to a limit set from the disk's size).
    // new Blob() returns as usual with the right size and the Blob is broken:
    // only a read fails, and for a received file that read is the download,
    // which would fail after the whole transfer. Reading back the last byte of
    // every part finds it while the transfer is still running. A part that
    // turns out broken after its file was handed over, or after the
    // connection closed (a Go sender closes as soon as its last bytes are
    // out), is still reported; only a failure already reported keeps it quiet.
    //
    // The returned promise settles once the read-back has, and never rejects
    // for a broken part (that is fail's to report). A SHA-256 check waits for
    // it: a broken part also fails the hash worker's read, and that alone would
    // hand the file over unverified if the digest won the race.
    function probe(part: Blob, sizes: { received: number; expected: number | null }): Promise<void> {
        if (part.size === 0) return Promise.resolve();
        return part.slice(part.size - 1).arrayBuffer().then(
            () => {},
            (err: unknown) => {
                if (!aborted || closed) fail(err, 'out-of-memory', sizes);
            }
        );
    }

    // The whole file, in order. Composing Blobs from Blobs references their
    // bytes rather than copying them, and a single part is the file itself.
    function takeBlob(file: PartialDownload): Blob {
        if (file.heldBytes > 0) spill(file);
        return file.parts.length === 1 ? file.parts[0] : new Blob(file.parts);
    }

    // Settles once a part's read-back has, or once the bound passes, whichever
    // comes first, so waiting for it can never leave a check pending (CP0-F2).
    function readBack(tail: Promise<void> | null, bound: AbortSignal | null): Promise<void> {
        if (tail === null) return Promise.resolve();
        return new Promise((resolve) => {
            tail.then(() => resolve(), () => resolve());
            if (bound === null) return;
            if (bound.aborted) resolve();
            else bound.addEventListener('abort', () => resolve(), { once: true });
        });
    }

    // The connection closed. Stops the receiver and lets go of every chunk it
    // holds: without it a transfer that died partway kept its partial file for
    // the life of the tab. The frames waiting out a check go too, unread.
    //
    // A file whose SHA-256 is being checked is not partial: every byte is in
    // and its chunks are already released, so its check finishes and the file
    // is handed over or refused as usual (see the verdict at `end`). A Go
    // sender closes about 50 ms after its last end marker, which is usually
    // in the middle of that check; stopping it here dropped the last file of
    // every Go-to-browser transfer whose check outlasted the close.
    function dispose(): void {
        if (!aborted) closed = true;
        release();
        queued = [];
    }

    function release(): void {
        aborted = true;
        partialDownloads.clear();
        currentMetadata = null;
        expectedSize = null;
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
                        // Best effort, like the discard path: a peer already
                        // torn down must not cost this side its explanation.
                        try {
                            cb.send(new Uint8Array(enc));
                        } catch {
                            // The peer is gone; the close is all it will get.
                        }
                        cb.onError?.(errMsg);
                        return;
                    }
                }

                // A metadata for another id means the sender abandoned the
                // open file without an end, and the file is let go, as the Go
                // receiver deletes its .part: its copies and parts go, and a
                // later metadata for it starts over at offset 0. Kept for a
                // resume, a sender rotating ids held just under SPILL_BYTES
                // in the tab per id, and spilling it instead would still keep
                // a part per switch for one alternating two ids (review
                // R0-06-H6 L1). No Floe sender switches ids inside a file:
                // each stops the transfer on any failure. The same id again
                // is a resume and keeps everything.
                if (currentMetadata !== null && currentMetadata.id !== msg.id) {
                    partialDownloads.delete(currentMetadata.id);
                }
                currentMetadata = msg;
                senderSentVersion = typeof msg.ver === 'string' && msg.ver !== '';
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
                    partialDownloads.set(msg.id, {
                        parts: [],
                        held: [],
                        stage: null,
                        staged: 0,
                        heldBytes: 0,
                        received: 0,
                        lastReported: 0,
                        tail: null,
                    });
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
                    // bytes. The chunk copies are released before the wait, so
                    // memory peaks no longer than it did before the check.
                    const blob = takeBlob(fileData);
                    const tail = fileData.tail;
                    partialDownloads.delete(meta.id);
                    currentMetadata = null;
                    expectedSize = null;
                    pending = true;
                    // Everything from here runs inside the promise chain, so nothing
                    // that throws (a callback, a hasher, an engine without
                    // AbortSignal.timeout, which Safari lacks before 16) can leave
                    // the receiver pending with every later frame queued behind it.
                    let boundTimer: ReturnType<typeof setTimeout> | null = null;
                    let bound: AbortSignal | null = null;
                    Promise.resolve()
                        .then(() => {
                            // A controller plus a timer, not AbortSignal.timeout:
                            // Safari before 16 has no AbortSignal.timeout, so the
                            // signal was undefined there and a hasher that never
                            // answered left this pending forever with every later
                            // frame queued behind it (CP0-F2). AbortController is
                            // available wherever Workers are. Started before
                            // onVerifying, so the read-back wait below is bounded
                            // even when that callback throws.
                            const ac = new AbortController();
                            bound = ac.signal;
                            // With more files to come the sender is waiting on the
                            // next ack, which queues behind this hash.
                            const waitMs = meta.index < meta.total
                                ? Math.min(hashBoundMs(size), POST_END_HASH_WAIT_MS)
                                : hashBoundMs(size);
                            boundTimer = setTimeout(() => ac.abort(), waitMs);
                            cb.onVerifying?.(meta.index, meta.total);
                            return hashBlob(blob, ac.signal);
                        })
                        .catch(() => null)
                        // The read-back of the file's last part settles with the
                        // digest, inside the same bound (see probe). A broken part
                        // fails the hash worker's read too, and that null alone
                        // would hand the file over unverified; the probe stops the
                        // transfer on the real cause instead.
                        .then((got) => readBack(tail, bound).then(() => got))
                        .then((got) => {
                            if (boundTimer !== null) {
                                clearTimeout(boundTimer);
                                boundTimer = null;
                            }
                            pending = false;
                            try {
                                // A null digest (no Worker, a worker failure, the time
                                // bound) keeps the file unverified: a missing check never
                                // claims a match, and the byte count already passed.
                                // A transfer stopped during the check hands nothing over,
                                // unless the connection closing is all that stopped it
                                // (see dispose): a failure, a broken part included,
                                // clears `closed` when it reports.
                                if (aborted && !closed) return;
                                if (got !== null && got !== want) refuseHash(false);
                                else complete(meta, blob, size, got === want);
                            } catch (err) {
                                // The end frame's own work, finished late, so outside
                                // runMessage: a throw while the file is handed over
                                // (a callback, say) stops the transfer once, as it does
                                // on the unchecked path (#500). One after a stop that
                                // already spoke surfaces instead, as in runMessage.
                                if (aborted && !closed) throw err;
                                fail(err);
                            } finally {
                                drain();
                            }
                        });
                    return;
                }

                const blob = takeBlob(fileData);
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
        // a tight ArrayBuffer of that length. A small frame is copied into the
        // stage instead (see STAGE_BYTES), and an empty one leaves nothing.
        if (buf.byteLength >= STAGE_BYTES) {
            unstage(fileData); // what was staged came first
            fileData.held.push(new Uint8Array(buf).buffer);
        } else if (buf.byteLength > 0) {
            if (fileData.stage !== null && fileData.staged + buf.byteLength > STAGE_BYTES) unstage(fileData);
            if (fileData.stage === null) fileData.stage = new Uint8Array(STAGE_BYTES);
            fileData.stage.set(buf, fileData.staged);
            fileData.staged += buf.byteLength;
        }
        fileData.heldBytes += buf.byteLength;
        fileData.received += buf.byteLength;
        if (fileData.heldBytes >= SPILL_BYTES) spill(fileData);
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

    return { handleMessage, settled, dispose };
}
