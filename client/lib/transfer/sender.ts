// Floe sender engine — framework-agnostic, no React or simple-peer imports.
// Extracted from P2PTransfer.tsx sendAllFiles/sendSingleFile.
import {
    incompatibleMessage,
    HIGH_WATER,
    LOW_WATER,
    READ_SLAB,
    chunkSize,
    classifyControl,
    metadataMessage,
    endMessage,
    checkCompat,
    compatErrorMessage,
    compatErrorFromIncompatible,
    isAbortReason,
    refusalCodeOf,
    verifiedCountOf,
    PROTOCOL_VERSION,
    MIN_PROTOCOL_VERSION,
    ACK_TIMEOUT_MS,
    SEND_FILE_HASHES,
    hashBoundMs,
    type Ack,
    type Incompatible,
    type Received,
    type RefusalCode,
} from './protocol';
import { hashBlob as workerHashBlob } from './fileHash';
import { sanitizeDisplayText } from '../download';

// The digest wait's own escape: how often it asks whether the transfer is still
// alive, and the token that says it is not. The token is a symbol so it can
// never be confused with a digest the worker returned.
const DIGEST_STOP_POLL_MS = 200;
const STOPPED = Symbol('transfer stopped');

export interface SenderCallbacks {
    onFileStart?: (index: number, total: number, fileName: string) => void;
    onProgress?: (percent: number) => void;
    onSpeed?: (bytesPerSec: number, etaSeconds: number) => void;
    onSpeedReset?: () => void;
    onError?: (msg: string) => void;
    onAllSent?: () => void;
    isDestroyed?: () => boolean;
    // The receiver stopped the session with an incompatible frame. `code` is
    // an allowlisted RefusalCode or null; `saved` is the peer's count clamped
    // to [0, files]; `rangeOverlaps` is the same split compatErrorFromIncompatible
    // makes, so false means a version mismatch and true a deliberate abort.
    // Three derived values and no peer text: a caller that renders none of
    // today's wording (the request link visitor) has everything it needs here.
    // onError still carries today's wording for the ones that do.
    onStopped?: (stop: { code: RefusalCode | null; saved: number; rangeOverlaps: boolean }) => void;
    // The receiver sent `received`. No field of the frame is read here.
    onReceived?: () => void;
    // The same frame's report: `files` is the local count, `verified` the
    // receiver's matched count when verifiedCountOf accepts it (else null), and
    // `allVerified` whether it equals `files`. The receiver's claim, not a proof.
    onDelivered?: (report: { files: number; verified: number | null; allVerified: boolean }) => void;
    // The receiver acked this file: 1-based, once per matched ack, and the
    // sender's own count. It carries no `saved`, which rides only the
    // incompatible frame and never an ack (E-22).
    onAck?: (index: number) => void;
    // The typed twin of the three onError strings a send can end on, with the
    // 1-based file it happened on (the last one for a close after the final
    // end frame). onError keeps firing with today's wording.
    onFailed?: (failure: { kind: 'ack-timeout' | 'closed' | 'unreadable'; index: number }) => void;
}

export interface FileEntry {
    id: string;
    file: File;
    // The file's path inside the folder the sender picked, forward slashes, as
    // the visitor's folder walk produces it. It rides the existing metadata
    // name, so there is no wire change and no ProtocolVersion bump; Go
    // receivers already sanitize a path per component (safeJoin). Absent for a
    // flat pick, where the file's own name is the whole name.
    relativePath?: string;
}

// Minimal buffering interface used by the sender.
// The real implementation is RTCDataChannel; in tests a plain object works.
export interface BufferChannel {
    readonly bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    // 'close' is what ends a pending ack wait at once when the peer goes away
    // (the real RTCDataChannel fires it; a test double may ignore it).
    addEventListener(type: 'bufferedamountlow' | 'close', handler: () => void): void;
    removeEventListener(type: 'bufferedamountlow' | 'close', handler: () => void): void;
}

export interface SenderDeps {
    send: (data: string | Uint8Array) => void;
    // Registers a handler for incoming data (peer.on('data')).
    // Returns an unsubscribe function.
    onData: (handler: (data: string | Uint8Array | ArrayBuffer) => void) => () => void;
    channel: BufferChannel;
    sctpMaxMessageSize?: number | null;
    // The digest function, so a test can pass its own; the default is the Worker
    // behind hashBlob. A rejection, or a synchronous throw, is read as null.
    hashBlob?: (blob: Blob, signal?: AbortSignal) => Promise<string | null>;
    // How long a digest may take for a file of this many bytes before the end
    // frame goes out without one. Overridable as on the receiver, so a test can
    // make the bound fire.
    hashBoundMs?: (bytes: number) => number;
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

export interface SendOptions {
    // How long the FIRST file waits for the receiver's ack. Defaults to
    // ACK_TIMEOUT_MS (120 s); a caller whose receiver may take longer to
    // decide passes a longer value. Later files keep ACK_TIMEOUT_MS: only the
    // first metadata waits for a human to answer a prompt, and after that the
    // receiver is already committed, so a long deadline there would only delay
    // a dead transfer (spec 07 4.9).
    ackTimeoutMs?: number;
    // Whether each file's SHA-256 goes on its end frame. Defaults to
    // SEND_FILE_HASHES, the rollback lever.
    sendHashes?: boolean;
    // Whether the send resolves only once the receiver says `received`.
    // Without it the send resolves at the drain, which is what the main app
    // has always done. With it the last end frame is not the end: the receiver
    // may still be committing a large file or retrying a blocked rename, so
    // the wait ends only on `received` (then onAllSent), on a refusal, or on
    // the channel closing.
    //
    // Two rules for a caller that turns this on:
    //
    // Success is onAllSent and nothing else. Under this option onAllSent
    // cannot fire before the last end frame, while a `received` frame is
    // whatever the peer chose to send whenever it chose to send it: one during
    // the first file latches delivery all the same. So onReceived and
    // onDelivered report a claim and must not drive a page state transition,
    // or one early frame from a hostile peer ends the transfer's UI mid-send.
    //
    // isDestroyed is mandatory. There is no deadline here on purpose (E-36):
    // the receiver's own blocked-rename retry is what is bounded, so a host
    // that simply stalls leaves this wait open, and Cancel, which is
    // isDestroyed going true, is the only way out of it.
    requireReceived?: boolean;
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
    cb: SenderCallbacks = {},
    opts: SendOptions = {}
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

    // One control listener for the whole session, registered before the first
    // metadata. The per-file ack wait used to be the only listener, so a refusal
    // that arrived after `end` or between chunks was never seen.
    const session = openSession(deps, cb, files.length);
    const ticker = setInterval(emitView, PROGRESS_TICK_MS);
    // Set once the session is handed to lingerUntilDone, which owns the close
    // from then on. Every other exit still closes it here.
    let lingering = false;

    try {
        for (let i = 0; i < files.length; i++) {
            if (destroyed()) return;
            const entry = files[i];
            // Aborted whichever way this file ends, so a stopped transfer never
            // leaves the worker reading the rest of a large file.
            const hashAbort = new AbortController();
            let ok: boolean;
            try {
                ok = await sendSingleFile(
                    deps, entry, i + 1, files.length, totalBytes, cb, view, emitView,
                    i === 0 ? (opts.ackTimeoutMs ?? ACK_TIMEOUT_MS) : ACK_TIMEOUT_MS, session,
                    { enabled: opts.sendHashes ?? SEND_FILE_HASHES, hashBlob: deps.hashBlob ?? workerHashBlob, signal: hashAbort.signal }
                );
            } finally {
                hashAbort.abort();
            }
            if (!ok) return;
        }

        if (destroyed() || session.reportStop()) return;

        // "All Files Sent!" must mean delivered, not queued: the last file's
        // tail (up to HIGH_WATER bytes) can still be in the buffer here.
        await drainBelow(deps.channel, 0, destroyed);
        if (destroyed() || session.reportStop()) return;

        emitView();
        cb.onSpeedReset?.();
        if (opts.requireReceived) {
            // The same window, awaited instead of left running: the send has
            // not succeeded until the receiver says so. No second listener and
            // no deadline (E-36); Cancel reaches it through destroyed().
            lingering = true;
            const ending = await session.lingerUntilDone(destroyed);
            // A close before `received` is a lost transfer and not a finished
            // one, so onAllSent belongs to `received` alone. A refusal has
            // already been reported by reportStop, and a destroyed peer is
            // this page tearing the transfer down, which has nothing to report.
            if (ending === 'received') cb.onAllSent?.();
            else if (ending === 'closed') cb.onFailed?.({ kind: 'closed', index: files.length });
            return;
        }
        cb.onAllSent?.();
        // Fire and forget, never awaited here: a CLI receiver's hash refusal
        // lands about CONTROL_FLUSH_MS after the last byte, and closing here
        // dropped it and left the page claiming success (F-SHA-4). Awaiting it
        // without requireReceived would leave sendFiles pending for the life of
        // the page whenever the peer answers nothing, which is every
        // browser-to-browser transfer.
        lingering = true;
        void session.lingerUntilDone(destroyed);
    } finally {
        clearInterval(ticker);
        if (!lingering) session.close();
    }
}

// How long a control frame gets to reach the wire before teardown. Mirrors
// controlFlushTimeout in cli/engine/transfer/control.go.
export const CONTROL_FLUSH_MS = 2000;

/**
 * Sends a reason to the peer and waits for it to reach the wire.
 *
 * Without the wait the frame is routinely lost: destroy() tears the channel
 * down and whatever was still queued goes with it, so the peer sees only the
 * close and reports a lost connection instead of the reason (issue #284
 * measured the same race on the Go side, lost in 6 of 6 rounds on one machine
 * state). Bounded and best effort: a peer that never drains must not hold the
 * teardown open, and a reason lost at the deadline is no worse than today.
 *
 * Sent as a STRING. On the sender-to-receiver path a binary frame is file data
 * by definition, so a binary reason would land in somebody's file.
 */
export async function sendAbortReason(
    send: (data: string | Uint8Array) => void,
    channel: BufferChannel | undefined,
    reason: string
): Promise<void> {
    try {
        send(incompatibleMessage(reason));
    } catch {
        return; // already torn down; the close is all the peer will get
    }
    if (!channel) return;
    // The loser of the race has to be told, or drainBelow keeps its 200 ms
    // poll and its bufferedamountlow listener forever and leaves the
    // channel threshold clamped at 0, which would then suppress the
    // backpressure event a later transfer on the same channel depends on.

    let over = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
        drainBelow(channel, 0, () => over),
        new Promise<void>((resolve) => {
            timer = setTimeout(() => {
                over = true;
                resolve();
            }, CONTROL_FLUSH_MS);
        }),
    ]);
    over = true;
    if (timer) clearTimeout(timer);
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

// Result of waiting for the receiver's ack. `stopped` means the session latch
// holds an incompatible frame; `closed` means the channel closed first.
type AckResult =
    | { type: 'ack'; offset: number; pv?: number; pvMin?: number; ver?: string }
    | { type: 'stopped' }
    | { type: 'closed' }
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
    emitView: () => void,
    ackTimeoutMs: number,
    session: Session,
    hashing: { enabled: boolean; hashBlob: NonNullable<SenderDeps['hashBlob']>; signal: AbortSignal }
): Promise<boolean> {
    const { file, id } = entry;
    const { send, channel } = deps;
    const destroyed = cb.isDestroyed ?? (() => false);
    // One name for the wire and for any message that names this file, so the
    // person watching and the receiver writing it never see two different
    // things. Identical to file.name for every caller that picks flat files.
    const wireName = entry.relativePath ?? file.name;

    if (destroyed()) return true;

    const CHUNK_SIZE = chunkSize(deps.sctpMaxMessageSize);

    // Let the previous file's tail drain before the handshake; the progress
    // ticker keeps updating the previous file's bar during this wait. No-op on
    // the first file (buffer is empty).
    await drainBelow(channel, METADATA_DRAIN_THRESHOLD, destroyed);
    if (destroyed()) return true;
    if (session.reportStop()) return false;

    channel.bufferedAmountLowThreshold = LOW_WATER;

    // 1. Send metadata with protocol version fields
    try {
        send(metadataMessage(id, wireName, file.size, index, total, totalBytes));
    } catch {
        return false;
    }

    // The digest starts as the metadata goes out and runs in the worker while the
    // chunks are sent, so for most files it is ready by the last chunk. It reads
    // the same File the chunks come from; a file that changes during the send
    // makes the receiver discard it, which is the safe outcome.
    const digest = hashing.enabled
        ? Promise.resolve()
            .then(() => hashing.hashBlob(file, hashing.signal))
            .catch(() => null)
        : null;

    // 2. Wait for ack (120 s unless the caller set ackTimeoutMs). An
    // incompatible frame, before or during the wait, stops the session.
    const ackResult = await session.waitForAck(id, ackTimeoutMs);
    if (ackResult.type === 'timeout') {
        cb.onError?.('Transfer timed out waiting for receiver. Please try again.');
        cb.onFailed?.({ kind: 'ack-timeout', index });
        return false;
    }
    if (ackResult.type === 'stopped') {
        session.reportStop();
        return false;
    }
    if (ackResult.type === 'closed') {
        // The words the app already shows when the peer connection drops, so
        // no new copy is introduced.
        cb.onError?.('Connection lost. The other device may have closed the tab.');
        cb.onFailed?.({ kind: 'closed', index });
        return false;
    }
    // The receiver took this file. Reported before the checks below, which are
    // about what it asked for and not about whether it answered.
    cb.onAck?.(index);

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

    // The offset is the receiver's word for how much of this file it already
    // has, and classifyControl casts it straight off the wire. Outside the
    // file it is a receiver bug or a hostile peer: a negative one made the
    // chunk loop below spin forever on empty slabs, and a missing one sent an
    // end marker after zero bytes. Refuse it before the file is touched.
    const resumeAt: unknown = ackResult.offset;
    if (typeof resumeAt !== 'number' || !Number.isInteger(resumeAt) || resumeAt < 0 || resumeAt > file.size) {
        // The refused value is quoted back so the person can see what was
        // asked for, which makes it peer text on a screen: cleaned and capped
        // like every other peer string that reaches this banner. A number needs
        // no more than a few characters, and a hostile one is bounded by the
        // frame alone, which is what let a bidi mark reorder the line for
        // pv and pvMin (protocolNumber's comment records that fix).
        cb.onError?.(
            `The receiver asked to resume "${wireName}" from byte ` +
            `${sanitizeDisplayText(String(resumeAt), 32)} of ${file.size}, ` +
            `which is not possible. Please try again.`
        );
        return false;
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

    // Waits for the buffer to fall below LOW_WATER, or for the peer to go
    // away. The escape is destroyed(), never a deadline: a time-based one
    // would let a truncated file fall through to the unconditional end marker
    // below and return true, which is exactly the failure the slab read guard
    // further down records having already been fixed once.
    //
    // Without any escape at all, a receiver that closed its tab while the
    // buffer sat above HIGH_WATER left this promise unsettled for the life of
    // the page: sendSingleFile never returned, so sendFiles never reached its
    // finally, and the 500ms progress ticker and the 4 MB slab stayed
    // reachable. emitView early-returns on destroyed(), so it was invisible.
    const waitForBuffer = () =>
        new Promise<void>((r) => {
            let poll: ReturnType<typeof setInterval> | null = null;
            const finish = () => {
                channel.removeEventListener('bufferedamountlow', onLow);
                if (poll) clearInterval(poll);
                r();
            };
            const onLow = () => finish();
            if (channel.bufferedAmount < LOW_WATER || destroyed()) {
                r();
            } else {
                channel.addEventListener('bufferedamountlow', onLow);
                poll = setInterval(() => {
                    if (destroyed() || channel.bufferedAmount < LOW_WATER) finish();
                }, 200);
            }
        });

    // 3. Send chunks. Progress/speed emission is owned by the ticker in
    // sendFiles, which derives delivered bytes from view.offset minus the
    // channel's bufferedAmount — this loop only advances view.offset.
    while (offset < file.size) {
        if (destroyed()) break;
        // A refusal can arrive at any time; once it has, no further chunk and
        // no end marker may be sent.
        if (session.reportStop()) return false;

        const slabEnd = Math.min(offset + READ_SLAB, file.size);
        let slabBuffer: ArrayBuffer;
        try {
            slabBuffer = await file.slice(offset, slabEnd).arrayBuffer();
        } catch {
            // The file became unreadable after the user picked it: moved,
            // renamed, on an unplugged drive, or a cloud placeholder whose
            // local copy was evicted.
            //
            // This used to `break`, which fell through to the unconditional
            // end marker below and returned true, so the sender announced a
            // finished file after a short byte count and both sides showed
            // success. Returning false skips the end marker and stops the
            // transfer, which is what this function already documents itself
            // as doing. No retry: a file that is genuinely gone will not come
            // back on a second read.
            cb.onError?.(
                `Could not read "${wireName}". It may have been moved, renamed, ` +
                `or on a drive or folder that is no longer available. Nothing further was sent.`
            );
            cb.onFailed?.({ kind: 'unreadable', index });
            return false;
        }

        let slabOffset = 0;
        while (slabOffset < slabBuffer.byteLength) {
            if (destroyed()) break;

            if (channel.bufferedAmount >= HIGH_WATER) {
                await waitForBuffer();
            }

            if (destroyed()) break;
            if (session.reportStop()) return false;

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

    // 4. Send end marker, carrying the digest only when it covers the whole file:
    // the receiver acked offset 0 (a resume would make a suffix digest mismatch)
    // and the worker produced one. A null digest leaves the key out, and the
    // receiver keeps its byte-count check.
    let sha256: string | null = null;
    if (digest && ackResult.offset === 0 && !destroyed()) {
        // The wait can outlast the transfer on a slow machine, and a peer that
        // goes away or refuses after the last chunk must end the send now: a
        // plain await would keep the worker hashing the rest of the file for an
        // end marker that may never be sent. The poll mirrors waitForBuffer's
        // shape; sendFiles' finally aborts the hash itself.
        let poll: ReturnType<typeof setInterval> | null = null;
        let boundTimer: ReturnType<typeof setTimeout> | null = null;
        const stopped = new Promise<typeof STOPPED>((resolve) => {
            poll = setInterval(() => {
                if (destroyed() || session.reportStop()) resolve(STOPPED);
            }, DIGEST_STOP_POLL_MS);
        });
        // A hasher that never answers used to leave this await pending for the
        // life of the page, so no end frame ever went out (CP0-F2). The bound
        // resolves null, which is what an absent digest already means: the key
        // is left off the frame and the receiver keeps its byte-count check.
        const bound = new Promise<null>((resolve) => {
            boundTimer = setTimeout(() => resolve(null), (deps.hashBoundMs ?? hashBoundMs)(entry.file.size));
        });
        let outcome: string | null | typeof STOPPED;
        try {
            outcome = await Promise.race([digest, stopped, bound]);
        } finally {
            if (poll) clearInterval(poll);
            if (boundTimer) clearTimeout(boundTimer);
        }
        if (outcome === STOPPED) return false;
        sha256 = outcome;
        // A refusal can also land in the same tick the digest resolves.
        if (session.reportStop()) return false;
    }
    try {
        send(endMessage(sha256));
    } catch { }

    return true;
}

// Which of the four things ended the window after the last end frame. Only
// `received` is a finished transfer; `destroyed` is this page tearing the
// transfer down, so nothing is reported for it.
type DoneReason = 'received' | 'stopped' | 'closed' | 'destroyed';

interface Session {
    waitForAck(fileId: string, timeoutMs: number): Promise<AckResult>;
    // Reports the latched refusal once (onError with today's wording, then
    // onStopped) and returns true while the session is stopped.
    reportStop(): boolean;
    close(): void;
    // After the last end frame the listener stays attached until the first of a
    // `received` frame, the channel close, or destroyed() polled at
    // DIGEST_STOP_POLL_MS. A CLI receiver's hash refusal lands about
    // CONTROL_FLUSH_MS after the last byte, which is after onAllSent, and
    // closing here dropped it and left the page claiming success (F-SHA-4).
    // The same window is what lets a `received` frame reach onDelivered at all.
    // The promise is awaited only under requireReceived, where the send has not
    // succeeded until the receiver says so; without it sendFiles must not await
    // it, or a peer that never answers would never let the send resolve. It
    // closes the session itself on every exit.
    lingerUntilDone(destroyed: () => boolean): Promise<DoneReason>;
}

// The session's one control listener: acks for the current file, a stop latch
// for an incompatible frame at any time, received frames, and the channel close.
function openSession(deps: SenderDeps, cb: SenderCallbacks, fileCount: number): Session {
    let stopped: Incompatible | null = null;
    let reported = false;
    let closed = false;
    let pending: { fileId: string; resolve: (r: AckResult) => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Every ack wait cleans up whichever arm lost: an N-file transfer used to
    // leave N pending timers, each retaining its closure.
    const settle = (r: AckResult) => {
        if (!pending) return;
        const { resolve } = pending;
        pending = null;
        if (timer) clearTimeout(timer);
        timer = null;
        resolve(r);
    };

    // Set only while the window after the last end frame is open
    // (lingerUntilDone). One shot: whichever of a `received` frame, a refusal,
    // the channel close or a destroyed() poll arrives first runs it with its
    // own reason, and it clears itself first, so a second frame cannot re-enter
    // teardown and close() calling it again is a no-op.
    let lateDone: ((why: DoneReason) => void) | null = null;
    const finishLate = (why: DoneReason) => {
        const f = lateDone;
        lateDone = null;
        f?.(why);
    };
    // Whether the peer already confirmed delivery. Read only by
    // lingerUntilDone, so a `received` that arrived before the window opened
    // does not arm a poll that nothing would ever clear.
    let delivered = false;

    const off = deps.onData((raw) => {
        // The SENDER keeps classifying by content, and must: a Go receiver sends
        // its ack, received and incompatible frames as BINARY. That is safe here
        // in a way it is not on the receive path, because no file data ever
        // travels receiver to sender. classifyControl keeps the byte cap.
        const msg = classifyControl(raw);
        if (!msg) return;
        if (msg.type === 'ack') {
            const ack = msg as Ack;
            if (pending && ack.id === pending.fileId) {
                settle({ type: 'ack', offset: ack.offset, pv: ack.pv, pvMin: ack.pvMin, ver: ack.ver });
            }
        } else if (msg.type === 'incompatible') {
            // The first refusal wins. Its pv range travels with it, because that
            // is what separates a version mismatch from a deliberate abort.
            if (!stopped) stopped = msg as Incompatible;
            settle({ type: 'stopped' });
            // Last, so today's callbacks still run first. In the window after
            // the last end frame this is what reports the refusal and tears the
            // session down; outside it, lateDone is null and this does nothing.
            finishLate('stopped');
            // Reported at receipt, whatever the send loop is doing. A receiver
            // that refuses mid-file sends this frame and then tears the channel
            // down, and the loop used to read the latch only at its
            // checkpoints: a refusal that landed while it waited for buffer
            // space lost to whatever teardown came next (the channel close,
            // an ICE failure, a channel error, a stuck-closing timer), and the
            // page reported a lost connection instead (WP-W1 review F1 and
            // R2-1; spec 07 4.7's wire-code rule). reportStop reports once;
            // every checkpoint still sees the latch and stops the send. A
            // throwing page handler must not break the data stream this runs in.
            try {
                reportStop();
            } catch {
                // Already marked reported; the latch still stops the send.
            }
        } else if (msg.type === 'received') {
            cb.onReceived?.();
            const verified = verifiedCountOf(msg as Received, fileCount);
            cb.onDelivered?.({ files: fileCount, verified, allVerified: fileCount > 0 && verified === fileCount });
            delivered = true;
            finishLate('received');
        }
    });

    // A refusal is already reported when its frame arrives (above), so the
    // close has nothing of its own to report.
    const onClose = () => {
        closed = true;
        settle({ type: 'closed' });
        finishLate('closed');
    };
    deps.channel.addEventListener('close', onClose);

    // Hoisted out of the returned literal so lingerUntilDone can call both
    // without `this`, and so the teardown body exists exactly once.
    const reportStop = (): boolean => {
        if (!stopped) return false;
        if (!reported) {
            reported = true;
            // Rebuilt from the frame's pv range rather than printed as sent,
            // the way the Go sender has done since PR #282. On a genuine
            // version mismatch the peer's sentence names the sides from ITS
            // point of view and offers ITS remedy. A deliberate abort still
            // comes through verbatim: that is the overlapping-range half of
            // compatErrorFromIncompatible, and it is what carries the
            // relay-cap reason from PR #429.
            cb.onError?.(compatErrorFromIncompatible(stopped));
            // The typed stop carries only an allowlisted code and a clamped
            // count, never the peer's text.
            const raw: unknown = stopped.saved;
            const saved = typeof raw === 'number' && Number.isInteger(raw)
                ? Math.min(Math.max(raw, 0), fileCount)
                : 0;
            // The same split compatErrorFromIncompatible makes one line above,
            // as a boolean rather than as wording: false is a version mismatch
            // and true a deliberate abort. Derived from the frame's pv range,
            // so it carries none of its text.
            cb.onStopped?.({ code: refusalCodeOf(stopped), saved, rangeOverlaps: isAbortReason(stopped) });
        }
        return true;
    };

    const close = () => {
        // First, so a close from any other path can never strand the linger's
        // interval. lateDone is already null when the window was never opened.
        finishLate('closed');
        off();
        deps.channel.removeEventListener('close', onClose);
        settle({ type: 'closed' });
    };

    return {
        waitForAck(fileId, timeoutMs) {
            if (stopped) return Promise.resolve({ type: 'stopped' });
            if (closed) return Promise.resolve({ type: 'closed' });
            return new Promise<AckResult>((resolve) => {
                pending = { fileId, resolve };
                timer = setTimeout(() => settle({ type: 'timeout' }), timeoutMs);
            });
        },
        reportStop,
        close,
        lingerUntilDone(destroyed) {
            // Everything that could already have ended the window: a refusal
            // latched before the last end frame, a delivery already confirmed,
            // a closed channel, a destroyed peer. Nothing to wait for, so close
            // now. The order is the reporting order: a refusal outranks a
            // delivery, because a receiver that refused never got the file.
            let already: DoneReason | null = null;
            if (reportStop()) already = 'stopped';
            else if (delivered) already = 'received';
            else if (closed) already = 'closed';
            else if (destroyed()) already = 'destroyed';
            if (already) {
                close();
                return Promise.resolve(already);
            }
            // destroyed() is a poll because a destroyed peer fires no event
            // here; `received`, a refusal and the channel close come through
            // the listener itself and run lateDone directly.
            return new Promise<DoneReason>((resolve) => {
                const poll = setInterval(() => {
                    if (destroyed()) finishLate('destroyed');
                }, DIGEST_STOP_POLL_MS);
                lateDone = (why) => {
                    clearInterval(poll);
                    // The teardown and the answer are owed whatever the page's
                    // own handlers do: a throwing onStopped or onError used to
                    // leave the listener attached, and with the wait awaited it
                    // would leave the send pending for the life of the page too.
                    try {
                        reportStop();
                    } finally {
                        close();
                        resolve(why);
                    }
                };
            });
        },
    };
}
