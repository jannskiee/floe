// The per-connection gate of the link-key check. Created right after new SimplePeer,
// before any page listener, it owns what a keyed connection reads and sends:
//
//   - its own kc goes out once, ahead of every other frame this side sends;
//   - the peer's kc is judged, inside the data callback that delivers it, so there
//     is no "verifying" state and no hold queue (decision W1);
//   - frames that beat the engine's first subscriber are kept for it.
//
// A session with no key is a pure pass-through that attaches nothing early, so a
// keyless page keeps simple-peer's own buffering exactly as it is today. Imports no
// simple-peer: the tests drive it through a fake (keySession.test.ts).
//
// Why it owns 'data' from construction. simple-peer pushes a frame as soon as the
// channel opens, while 'connect' waits on getStats polled every 100 ms, and a late
// listener only gets buffered frames a tick after it attaches. A pre-metadata check
// that attached later would miss a kc that had already arrived.
//
// The key, a peer's tag, the SDP and the room id stay inside here. What comes out is
// a verdict and enums, so nothing a report or a dispatch carries can leak any of them.

import type { LinkKey } from '../linkKey';
import {
    ENFORCE_LINK_KEYS,
    ENFORCE_SHARE_LINK_KEY,
    KEY_CHECK_SDP_FALLBACK,
    classifyControl,
    refusalCodeOf,
    type ControlMessage,
    type Incompatible,
    type KeyCheckFrame,
} from './protocol';
import {
    certHashes,
    createSignalGate,
    kcFrame,
    keyCheckTag,
    parseKeyCheckTag,
    tagsEqual,
    type CertHashes,
    type CertSource,
    type FileRole,
} from './keyCheck';

/** How many frames a first subscriber can be owed, beside the first incompatible,
 *  which is kept however many came before it. */
export const MAX_EARLY_FRAMES = 8;

// How often settle asks its caller whether to stop: the sender's other waits poll the
// same question at the same rate.
const SETTLE_STOP_POLL_MS = 200;

export type KeySurface = 'share-sender' | 'share-receiver' | 'request-visitor';

/** enforce: a failed check stops the transfer, and silence is a failure. detect: a
 *  bad tag stops it, silence is allowed (a released receiver sends no kc). observe:
 *  checks and reports, and never stops anything (the rollback lever). */
export type KeyMode = 'enforce' | 'detect' | 'observe';

export type KeyVerdict = 'pending' | 'verified' | 'failed' | 'unavailable';

/** Why a check did not verify: an enum, the only thing that leaves this module. */
export type KeyOutcome = 'bad-tag' | 'malformed' | 'missing' | 'silent' | 'unavailable' | 'peer-refused';

export interface KeyReport {
    role: 'sender' | 'receiver' | 'visitor';
    path: 'der' | 'sdp' | 'none';
    outcome: KeyOutcome;
    mode: KeyMode;
}

export interface KeyLevers {
    ENFORCE_LINK_KEYS: boolean;
    ENFORCE_SHARE_LINK_KEY: boolean;
}

const LEVERS: KeyLevers = { ENFORCE_LINK_KEYS, ENFORCE_SHARE_LINK_KEY };

/** What a surface does about a failed check. The only reader of the two enforce
 *  levers, so a flip cannot reach one page and miss another. */
export function linkKeyMode(surface: KeySurface, levers: KeyLevers = LEVERS): KeyMode {
    if (!levers.ENFORCE_LINK_KEYS) return 'observe';
    if (surface === 'share-sender') return levers.ENFORCE_SHARE_LINK_KEY ? 'enforce' : 'detect';
    return 'enforce';
}

export type KeyFrame = string | Uint8Array | ArrayBuffer;
type FrameHandler = (data: KeyFrame) => void;

/** The part of a simple-peer instance this reads. */
export interface PeerLike {
    on(event: 'data', handler: FrameHandler): unknown;
    on(event: 'connect' | 'close', handler: () => void): unknown;
    off(event: 'data', handler: FrameHandler): unknown;
    off(event: 'connect' | 'close', handler: () => void): unknown;
    send(data: string | Uint8Array): void;
    readonly destroyed: boolean;
    readonly initiator: boolean;
    readonly _pc?: CertSource | null;
    readonly _channel?: { readonly readyState: string } | null;
}

export interface KeySessionOptions {
    peer: PeerLike;
    fileRole: FileRole;
    /** Null is a keyless session. */
    key: LinkKey | null;
    roomId: string;
    mode: KeyMode;
    reportRole: KeyReport['role'];
    /** Defaults to KEY_CHECK_SDP_FALLBACK. */
    sdpFallback?: boolean;
    /** Once, with the verdict, inside whatever delivered it. */
    onVerdict?: (verdict: Exclude<KeyVerdict, 'pending'>) => void;
    /** At most once per connection (O7): a check that failed, or the other side's
     *  refusal for this code, which can follow a check that verified. */
    onReport?: (report: KeyReport) => void;
}

export interface KeySession {
    readonly keyed: boolean;
    readonly mode: KeyMode;
    /** Settles when own kc has gone out ('sent') or never will ('none'). Never rejects. */
    readonly ownKcOut: Promise<'sent' | 'none'>;
    /** The only data subscription downstream uses. Replays what came early. */
    onData(handler: FrameHandler): () => void;
    /** Own kc first, once, then this frame. Throws what peer.send throws. */
    send(data: string | Uint8Array): void;
    verdict(): KeyVerdict;
    outcome(): KeyOutcome | null;
    /** Waits for a verdict, up to `waitMs`, until the close, or until `stopped` says so. */
    settle(waitMs: number, stopped: () => boolean): Promise<KeyVerdict | 'timeout' | 'stopped'>;
    /** The file receiver's engine hands the sender's kc here. */
    peerTag(frame: KeyCheckFrame): KeyVerdict;
    /** A frame arrived that needed the proof ahead of it: decides 'missing' if still pending. */
    beforeFile(): KeyVerdict;
    /** The wait for a proof ran out. A failure in enforce mode, and nothing otherwise. */
    noteSilent(): void;
    /** This side stopped on its own account, with nothing more to say: an own kc that
     *  has not gone out never will, and nothing further is reported. */
    quiet(): void;
    /** Whether a signal from the server may reach this peer. */
    admitSignal(signal: unknown): boolean;
    dispose(): void;
}

const sessions = new WeakMap<object, KeySession>();

/** The session of a peer instance, for code that only holds the peer. A WeakMap, not a
 *  ref, because a page's peer ref is set only at the end of building the peer. */
export function keySessionOf(peer: object): KeySession | undefined {
    return sessions.get(peer);
}

export function createKeySession(options: KeySessionOptions): KeySession {
    const session = options.key === null ? keylessSession(options) : keyedSession(options, options.key);
    sessions.set(options.peer, session);
    return session;
}

function keylessSession({ peer, mode }: KeySessionOptions): KeySession {
    return {
        keyed: false,
        mode,
        ownKcOut: Promise.resolve('none'),
        onData(handler) {
            peer.on('data', handler);
            return () => {
                peer.off('data', handler);
            };
        },
        send(data) {
            peer.send(data);
        },
        verdict: () => 'pending',
        outcome: () => null,
        settle: () => Promise.resolve('pending'),
        peerTag: () => 'pending',
        beforeFile: () => 'pending',
        noteSilent() {},
        quiet() {},
        admitSignal: () => true,
        dispose() {},
    };
}

/** A page's own handler must not break the data stream this runs in, and must not
 *  vanish either: it surfaces in a microtask, where the page's error handler sees it. */
function guarded(call: () => void): void {
    try {
        call();
    } catch (err) {
        queueMicrotask(() => {
            throw err;
        });
    }
}

function keyedSession(options: KeySessionOptions, key: LinkKey): KeySession {
    const { peer, fileRole, roomId, mode, reportRole, onVerdict, onReport } = options;
    const sdpFallback = options.sdpFallback ?? KEY_CHECK_SDP_FALLBACK;
    const peerRole: FileRole = fileRole === 'sender' ? 'receiver' : 'sender';
    const gate = createSignalGate(peer.initiator ? 'answer' : 'offer');
    // Bound now, so a wrapper a page puts around the peer's send later (a first-frame
    // watcher, say) never sees this side's kc.
    const rawSend = peer.send.bind(peer);

    let own: 'unsent' | 'sent' | 'none' = 'unsent';
    let resolveOwn: (value: 'sent' | 'none') => void = () => {};
    const ownKcOut = new Promise<'sent' | 'none'>((resolve) => {
        resolveOwn = resolve;
    });

    let verdict: KeyVerdict = 'pending';
    let outcome: KeyOutcome | null = null;
    let reported = false;
    let quieted = false;
    let closed = false;

    const subscribers = new Set<FrameHandler>();
    // Null once the first subscriber has come: a frame with nobody listening after
    // that is lost, as it is on a stream whose only listener left.
    let early: KeyFrame[] | null = [];
    let keptIncompatible = false;

    const waiters = new Set<(answer: KeyVerdict | 'timeout' | 'stopped') => void>();

    let hashesRead = false;
    let hashesFound: CertHashes | null = null;
    const hashes = (): CertHashes | null => {
        if (!hashesRead) {
            hashesRead = true;
            hashesFound = certHashes(peer._pc, fileRole, { sdpFallback });
        }
        return hashesFound;
    };

    function report(why: KeyOutcome): void {
        if (reported || quieted) return;
        reported = true;
        guarded(() => onReport?.({ role: reportRole, path: hashesFound?.path ?? 'none', outcome: why, mode }));
    }

    function decide(next: Exclude<KeyVerdict, 'pending'>, why: KeyOutcome | null): void {
        if (verdict !== 'pending') return;
        verdict = next;
        outcome = why;
        for (const answer of [...waiters]) answer(next);
        if (why !== null) report(why);
        guarded(() => onVerdict?.(next));
    }

    function finishOwn(result: 'sent' | 'none'): void {
        own = result;
        resolveOwn(result);
    }

    function channelOpen(): boolean {
        return !peer.destroyed && peer._channel?.readyState === 'open';
    }

    /** At the first inbound frame or 'connect', and from every send. Never an empty kc
     *  (DV1, D7): a side that cannot prove anything sends nothing. */
    function ensureOwn(): void {
        if (own !== 'unsent' || !channelOpen()) return;
        const certs = hashes();
        let frame: string;
        try {
            if (!certs) throw new Error('no certificates');
            frame = kcFrame(keyCheckTag(key, fileRole, roomId, certs.hS, certs.hR));
        } catch {
            finishOwn('none');
            decide('unavailable', 'unavailable');
            return;
        }
        try {
            // TEXT from the file sender, BINARY from the file receiver: on the way to a
            // receiver a binary frame is file data, and the other way a Go sender reads
            // every frame as bytes.
            rawSend(fileRole === 'sender' ? frame : new TextEncoder().encode(frame));
        } catch {
            return; // the channel left 'open' just now; a later send or the close settles it
        }
        finishOwn('sent');
    }

    function judge(frame: KeyCheckFrame): void {
        if (verdict !== 'pending') return; // the first kc stands
        const certs = hashes();
        if (!certs) {
            decide('unavailable', 'unavailable');
            return;
        }
        const got = parseKeyCheckTag(frame);
        if (!got) {
            decide('failed', 'malformed');
            return;
        }
        let want: Uint8Array;
        try {
            want = keyCheckTag(key, peerRole, roomId, certs.hS, certs.hR);
        } catch {
            decide('unavailable', 'unavailable');
            return;
        }
        if (tagsEqual(got, want)) decide('verified', null);
        else decide('failed', 'bad-tag');
    }

    function noteRefusal(message: ControlMessage | null): void {
        if (message?.type === 'incompatible' && refusalCodeOf(message as Incompatible) === 'unverified') {
            report('peer-refused');
        }
    }

    function latch(data: KeyFrame, message: ControlMessage | null): void {
        if (!early) return;
        // A sender's engine would drop a frame that does not classify. A receiver's
        // judges every frame, file bytes included.
        if (fileRole === 'sender' && !message) return;
        if (message?.type === 'incompatible' && !keptIncompatible) {
            keptIncompatible = true;
            early.push(data);
        } else if (early.length < MAX_EARLY_FRAMES) {
            early.push(data);
        }
    }

    function deliver(data: KeyFrame, message: ControlMessage | null): void {
        if (subscribers.size === 0) {
            latch(data, message);
            return;
        }
        for (const handler of [...subscribers]) handler(data);
    }

    const onInbound: FrameHandler = (data) => {
        ensureOwn();
        if (fileRole === 'receiver') {
            // The engine judges every frame, kc included, at its one ordered entry. Only
            // a string can be control here: a binary frame is file data, whatever it spells.
            const message = typeof data === 'string' ? classifyControl(data) : null;
            noteRefusal(message);
            deliver(data, message);
            return;
        }
        // A file sender reads by content, since a receiver frames control as binary.
        const message = classifyControl(data);
        if (message?.type === 'kc') {
            judge(message as KeyCheckFrame);
            return;
        }
        noteRefusal(message);
        deliver(data, message);
    };

    const onClose = (): void => {
        closed = true;
        early = null;
        if (own === 'unsent') finishOwn('none');
        for (const answer of [...waiters]) answer('stopped');
    };

    peer.on('connect', ensureOwn);
    peer.on('close', onClose);
    peer.on('data', onInbound);

    return {
        keyed: true,
        mode,
        ownKcOut,
        onData(handler) {
            subscribers.add(handler);
            const replay = early;
            early = null;
            if (replay) for (const data of replay) handler(data);
            return () => {
                subscribers.delete(handler);
            };
        },
        send(data) {
            ensureOwn();
            // The channel refused the kc just now and is still open. Nothing may lead
            // the kc, so this frame does not go either, and the next send tries again.
            // Fixed words, and every caller treats a throw as a failed send.
            if (own === 'unsent' && channelOpen()) throw new Error('the link key proof could not be sent');
            rawSend(data);
        },
        verdict: () => verdict,
        outcome: () => outcome,
        settle(waitMs, stopped) {
            if (verdict !== 'pending') return Promise.resolve(verdict);
            if (closed || stopped()) return Promise.resolve('stopped');
            return new Promise((resolve) => {
                const answer = (result: KeyVerdict | 'timeout' | 'stopped') => {
                    clearTimeout(timer);
                    clearInterval(poll);
                    waiters.delete(answer);
                    resolve(result);
                };
                const timer = setTimeout(() => answer('timeout'), waitMs);
                const poll = setInterval(() => {
                    if (stopped()) answer('stopped');
                }, SETTLE_STOP_POLL_MS);
                waiters.add(answer);
            });
        },
        peerTag(frame) {
            judge(frame);
            return verdict;
        },
        beforeFile() {
            if (verdict === 'pending') decide('failed', 'missing');
            return verdict;
        },
        noteSilent() {
            if (mode === 'enforce') decide('failed', 'silent');
        },
        quiet() {
            quieted = true;
            if (own === 'unsent') finishOwn('none');
        },
        admitSignal: (signal) => gate.admit(signal),
        dispose() {
            peer.off('connect', ensureOwn);
            peer.off('close', onClose);
            peer.off('data', onInbound);
            onClose();
        },
    };
}
