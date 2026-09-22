// The request link visitor's state machine (spec 07 4.12).
//
// Pure: reduce(model, event) returns the next model and the effects the page
// has to run, and nothing else. The component owns the socket, the peer, the
// timers and the wake lock, and runs the effects in the order listed. Keeping
// the decisions here is what lets every row of the transition table, and the
// rules the reviews carried into it, be a unit test.
//
// State ids follow the spec: V1 to V13, plus the sub-states it names (V3c,
// V5a to V5c, V6a to V6d, V8a, V8b, V11a, V11b, V12a) and 'load' before the
// link has been read. V3a (no folder picking) and V3b (Hide my IP over 2 GB)
// are facts about the Ready view, computed where it renders; V3b's one rule
// that is a decision, Send refused, lives in sendBlock below.
//
// Peer-derived values reach this module already reduced by the sender to an
// allowlisted refusal or null, a clamped count and one boolean. The page's own
// names for them (refusal, savedCount, verifiedCount) are used throughout.

import { REFUSAL_CODES, type RefusalCode } from '../transfer/protocol';
import type { RelayGateVerdict } from '../relay';
import { RELAY_SIZE_LIMIT } from '../relay';
import {
    ANSWER_WINDOW_MS,
    ROOM_FULL_RETRY_WINDOW_MS,
    ROOM_FULL_SEALED_RETRIES,
    ROOM_FULL_SEALED_WINDOW_MS,
} from './constants';

export type VisitorState =
    | 'load'
    | 'V1' // Incomplete link
    | 'V2' // Unsupported browser
    | 'V3' // Ready
    | 'V3c' // Ready, the last pick was refused
    | 'V4' // Host absent
    | 'V5a' // Used
    | 'V5b' // Turned off
    | 'V5c' // Not available on this server
    | 'V6' // Connecting
    | 'V6a' // Couldn't connect
    | 'V6b' // Hide my IP needs a relay
    | 'V6c' // Refused by the connection limiter, retrying
    | 'V6d' // Canceled before accept (renders as Ready)
    | 'V7' // Waiting for accept
    | 'V8a' // Declined
    | 'V8b' // Timed out
    | 'V9' // Relay blocked
    | 'V10' // Sending
    | 'V11' // Stopped by a refusal code
    | 'V11a' // Stopped by the visitor
    | 'V11b' // Needs update
    | 'V12' // Lost
    | 'V12a' // Lost before accept
    | 'V13'; // Delivered

/** Events, with the spec's numbers. Three are the page's own and carry none:
 *  SOCKET_CONNECTED (the socket's connect, which is when request-join goes
 *  out), BACK_TO_FILES (the C-72 and C-81 button) and VERIFIED_COUNT (the
 *  display-only count from onDelivered). UNREADABLE is onFailed's third
 *  kind. SIGNAL_SENT is the answering peer's own signal going out, which is
 *  when the server may seal the room on this seat (review 2a L1). */
export type VisitorEvent =
    | { type: 'LINK_OK'; roomId: string } // E01
    | { type: 'LINK_INCOMPLETE' } // E02
    | { type: 'NO_WEBRTC' } // E03
    | { type: 'FILES_ADDED' } // E04
    | { type: 'PICK_REFUSED' } // E05
    | { type: 'CLEAR' } // E06
    | { type: 'HIDE_IP_TOGGLED' } // E07
    | { type: 'SEND'; count: number; size: number; hideIp: boolean; reading?: boolean } // E08
    | { type: 'ICE_READY'; hasTurn: boolean } // E09
    | { type: 'SOCKET_REFUSED' } // E10
    | {
          type: 'JOIN_ANSWER'; // E11
          answer: 'request-joined' | 'host-absent' | 'room-full' | 'disabled' | 'error';
          /** Milliseconds since this page's previous attempt ended, or null
           *  on the first attempt. Read only for room-full (row R2). */
          sincePreviousAttemptMs?: number | null;
      }
    | { type: 'JOIN_NO_ANSWER' } // E12
    | { type: 'SETUP_TIMEOUT' } // E13
    | { type: 'PEER_ERROR' } // E14
    | { type: 'CHANNEL_OPEN' } // E15
    | { type: 'RELAY_VERDICT'; action: RelayGateVerdict['action']; isRelay: boolean } // E16
    | { type: 'FIRST_METADATA_SENT'; now: number } // E17
    | { type: 'ACK'; index: number; now: number } // E18: the sender's own 1-based index
    | { type: 'INCOMPATIBLE'; refusal: RefusalCode | null; savedCount: number; rangeOverlaps: boolean } // E19
    | { type: 'ACK_TIMEOUT'; index: number } // E20
    | { type: 'PROGRESS'; percent?: number; bytesPerSec?: number; etaSeconds?: number } // E21
    | { type: 'RECEIVED'; now: number } // E22: onAllSent and nothing else
    | { type: 'CHANNEL_CLOSED' } // E23
    | { type: 'CANCEL' } // E24
    | { type: 'TRY_AGAIN'; count: number; size: number; hideIp: boolean; reading?: boolean } // E25
    | { type: 'SOCKET_LOST' } // E26
    | { type: 'PEER_DISCONNECTED' } // E27
    | { type: 'VISIBILITY'; visible: boolean } // E28
    | { type: 'HASHCHANGE'; roomId: string | null } // E29
    | { type: 'SOCKET_CONNECT_TIMEOUT' } // E30
    | { type: 'SEND_SETTLED_SILENT' } // E31
    | { type: 'SOCKET_CONNECTED' }
    | { type: 'BACK_TO_FILES' }
    | { type: 'VERIFIED_COUNT'; verifiedCount: number | null }
    | { type: 'UNREADABLE'; index: number }
    | { type: 'SIGNAL_SENT' };

/** What the page must do, in order. */
export type VisitorEffect =
    | 'startAttempt' // new attempt id; wake lock; fetch the ICE list
    | 'buildPeer' // the answering peer, BEFORE joining, so no early offer is dropped
    | 'connectSocket' // connect, listeners for this attempt, arm the connect timer
    | 'emitJoin' // request-join with the bare room id; arm the no-answer timer
    | 'retryJoin' // after ROOM_FULL_RETRY_DELAY_MS, request-join again
    | 'retryConnect' // jittered socket.connect() after a limiter refusal
    | 'clearConnectTimer'
    | 'clearJoinTimer'
    | 'armSetupTimer'
    | 'clearSetupTimer'
    | 'startBadgePoll'
    | 'armProbe' // the relay probe, RELAY_PROBE_DELAY_MS after the channel opens
    | 'sendFiles'
    | 'startCountdown'
    | 'sendCancelAbort' // the fixed Cancel reason, awaited, then the peer destroyed
    | 'destroyPeer'
    | 'disconnectSocket'
    | 'clearTimers'
    | 'releaseWakeLock'
    | 'reload';

export interface VisitorModel {
    state: VisitorState;
    /** The fragment's room id, held for the hashchange comparison only. */
    roomId: string | null;
    attempt: number;
    /** This attempt's inputs, fixed at Send. */
    hideIp: boolean;
    total: number;
    size: number;
    /** This attempt's progress through setup. */
    joinEmitted: boolean;
    joined: boolean;
    joinRetried: boolean;
    /** This attempt sent a signal of its own (its answer). */
    signaled: boolean;
    /** Carried from the attempts before this one: one of them signaled and
     *  never opened its channel, and none has joined since, so the server may
     *  still hold the room sealed on that seat (D-116, review 2a L1). */
    sealedOwnSeat: boolean;
    /** Room-full answers retried under sealedOwnSeat in this attempt. */
    sealedRetries: number;
    channelOpen: boolean;
    sendStarted: boolean;
    firstMetadataAt: number | null;
    /** The sender's own 1-based index of the last acked file. Arrived is
     *  derived from it (arrivedCount), never from a count the host sends. */
    ackIndex: number;
    acceptedAt: number | null;
    deliveredAt: number | null;
    percent: number;
    bytesPerSec: number;
    etaSeconds: number | null;
    /** The route the relay probe read. */
    route: 'direct' | 'relay' | null;
    /** V11: the allowlisted refusal (or null) and the clamped saved count. */
    stop: { refusal: RefusalCode | null; savedCount: number } | null;
    /** V12: how the drop was lost. */
    lost: 'closed' | 'ack-timeout' | 'silent' | null;
    /** V11 by an unreadable local file (C-130): the file's own 1-based index;
     *  0 otherwise. */
    unreadableIndex: number;
    /** The host's verified claim, display only (C-122). */
    verifiedCount: number | null;
}

export const initialModel: VisitorModel = {
    state: 'load',
    roomId: null,
    attempt: 0,
    hideIp: false,
    total: 0,
    size: 0,
    joinEmitted: false,
    joined: false,
    joinRetried: false,
    signaled: false,
    sealedOwnSeat: false,
    sealedRetries: 0,
    channelOpen: false,
    sendStarted: false,
    firstMetadataAt: null,
    ackIndex: 0,
    acceptedAt: null,
    deliveredAt: null,
    percent: 0,
    bytesPerSec: 0,
    etaSeconds: null,
    route: null,
    stop: null,
    lost: null,
    unreadableIndex: 0,
    verifiedCount: null,
};

/** Every state an attempt can end in. Entering one always disconnects the
 *  socket (E-04): that frees seat 1 for the host's request-reopen and keeps a
 *  late server answer out of the next attempt. */
export const ATTEMPT_ENDING_STATES: readonly VisitorState[] = [
    'V4', 'V5a', 'V5b', 'V5c', 'V6a', 'V6b', 'V6d', 'V8a', 'V8b', 'V9',
    'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13',
];

/** States that render the Ready view and accept picks and Send. */
const READY_LIKE: readonly VisitorState[] = ['V3', 'V3c', 'V6b', 'V6d'];
/** States from which Try again (or Send) starts a new attempt (4.12.4). */
const RETRY_FROM: readonly VisitorState[] = ['V4', 'V8a', 'V8b', 'V9', 'V6a', 'V6d', 'V12a'];
/** The states with an attempt live. A changed fragment reloads the page in
 *  every OTHER state (E29): the card lists V1 to V5, V8 and V9, and the review
 *  (WP-W1 F4) found that the idle states it leaves out (V6a, V6b, V6d, V12a,
 *  and the endings) would let the next Send or Try again join the old room
 *  while the address bar shows the new one. Mid-attempt the page ignores it:
 *  the room it is in is the one it joined. */
const LIVE_ATTEMPT: readonly VisitorState[] = ['V6', 'V6c', 'V7', 'V10'];

const TEARDOWN: VisitorEffect[] = ['clearTimers', 'disconnectSocket', 'releaseWakeLock', 'destroyPeer'];
/** With the channel open, the fixed Cancel reason goes first, and the effect
 *  that sends it destroys the peer once it has reached the wire. */
const CANCEL_TEARDOWN: VisitorEffect[] = ['sendCancelAbort', 'clearTimers', 'disconnectSocket', 'releaseWakeLock'];

export type SendBlock = 'empty' | 'reading' | 'relay-cap' | null;

/** Why Send is off, or null when it is on. Exactly 2 GB with Hide my IP on is
 *  allowed: the relay cap blocks strictly over RELAY_SIZE_LIMIT, as the gate
 *  does. A pick still being read (a folder walk in progress) blocks too, so a
 *  half-walked folder can never be sent. */
export function sendBlock(input: { count: number; size: number; hideIp: boolean; reading: boolean }): SendBlock {
    if (input.reading) return 'reading';
    if (!(input.count >= 1)) return 'empty';
    if (input.hideIp && input.size > RELAY_SIZE_LIMIT) return 'relay-cap';
    return null;
}

/** Files that arrived, from the sender's own count: after the ack of file N,
 *  files 1 to N-1 are done (row R5, E-22). All of them once delivered. */
export function arrivedCount(model: VisitorModel): number {
    if (model.state === 'V13') return model.total;
    return Math.max(0, model.ackIndex - 1);
}

/** Whole minutes left in the host's answer window, counted from the first
 *  metadata. 0 means under a minute, which the copy says as "less than 1 min"
 *  rather than "0 min". */
export function answerMinutesLeft(elapsedMs: number): number {
    const left = ANSWER_WINDOW_MS - Math.max(0, elapsedMs);
    return left < 60_000 ? 0 : Math.floor(left / 60_000);
}

/** The simple-peer config for this attempt. Hide my IP is
 *  iceTransportPolicy: 'relay', which makes the browser gather and send only
 *  relay candidates; the TURN servers stay in the list. Stripping them is
 *  what the main page's relay-off toggle does, the opposite of this. */
export function peerConfigFor(
    iceServers: readonly RTCIceServer[],
    hideIp: boolean
): { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy } {
    return {
        iceServers: iceServers.map((s) => ({ ...s })),
        iceTransportPolicy: hideIp ? 'relay' : 'all',
    };
}

/** Every option the visitor's answering peer is built with, so the page's
 *  one construction site cannot drop Hide my IP's relay policy unnoticed
 *  (WP-W1 review F2): the answering side (initiator false), trickle ICE, and
 *  readableObjectMode, which keeps the SCTP text and binary bit intact exactly
 *  as the main page's peer does. */
export function peerOptionsFor(iceServers: readonly RTCIceServer[], hideIp: boolean) {
    return {
        initiator: false,
        trickle: true,
        readableObjectMode: true,
        config: peerConfigFor(iceServers, hideIp),
    };
}

type Step = { model: VisitorModel; effects: VisitorEffect[] };

const stay = (model: VisitorModel): Step => ({ model, effects: [] });

function to(model: VisitorModel, state: VisitorState, patch: Partial<VisitorModel> = {}, effects: VisitorEffect[] = []): Step {
    return { model: { ...model, ...patch, state }, effects };
}

/** An attempt-ending transition: always the full teardown. */
function end(model: VisitorModel, state: VisitorState, patch: Partial<VisitorModel> = {}): Step {
    return to(model, state, patch, [...TEARDOWN]);
}

function startAttempt(model: VisitorModel, event: { count: number; size: number; hideIp: boolean; reading?: boolean }): Step {
    if (sendBlock({ count: event.count, size: event.size, hideIp: event.hideIp, reading: event.reading === true })) {
        return stay(model);
    }
    return {
        model: {
            ...initialModel,
            state: 'V6',
            roomId: model.roomId,
            attempt: model.attempt + 1,
            hideIp: event.hideIp,
            total: event.count,
            size: event.size,
            sealedOwnSeat: (model.signaled && !model.channelOpen) || (model.sealedOwnSeat && !model.joined),
        },
        effects: ['startAttempt'],
    };
}

/** A refusal before the first ack (V7, and V6 once sendFiles is running). */
function refusedBeforeAccept(model: VisitorModel, e: Extract<VisitorEvent, { type: 'INCOMPATIBLE' }>): Step {
    if (!e.rangeOverlaps) return end(model, 'V11b');
    if (e.refusal === 'declined') return end(model, 'V8a');
    if (e.refusal === 'expired') return end(model, 'V8b');
    // Nothing can have been saved before the first ack, whatever the frame
    // claims.
    return end(model, 'V11', { stop: { refusal: allowlisted(e.refusal), savedCount: 0 } });
}

/** The sender already allowlists the code (refusalCodeOf); this repeats the
 *  check against the same set on the page's side of the boundary, so a raw
 *  string (too-slow, a hostile one) that ever got here would still read as
 *  unknown. */
function allowlisted(refusal: unknown): RefusalCode | null {
    return typeof refusal === 'string' && REFUSAL_CODES.has(refusal) ? (refusal as RefusalCode) : null;
}

function clampCount(n: unknown, total: number): number {
    return typeof n === 'number' && Number.isInteger(n) ? Math.min(Math.max(n, 0), total) : 0;
}

export function reduce(model: VisitorModel, event: VisitorEvent): Step {
    const s = model.state;

    // E29: a different room id in the fragment reloads the page while no
    // attempt is live.
    if (event.type === 'HASHCHANGE') {
        if (!LIVE_ATTEMPT.includes(s) && event.roomId !== model.roomId) return { model, effects: ['reload'] };
        return stay(model);
    }
    // E28: the guards hook owns what visibility does; the state never moves.
    if (event.type === 'VISIBILITY') return stay(model);

    if (s === 'load') {
        if (event.type === 'LINK_OK') return to(model, 'V3', { roomId: event.roomId });
        if (event.type === 'LINK_INCOMPLETE') return to(model, 'V1');
        if (event.type === 'NO_WEBRTC') return to(model, 'V2');
        return stay(model);
    }

    if (READY_LIKE.includes(s)) {
        switch (event.type) {
            case 'FILES_ADDED':
            case 'CLEAR':
            case 'HIDE_IP_TOGGLED':
                return to(model, 'V3');
            case 'PICK_REFUSED':
                return to(model, 'V3c');
            case 'SEND':
                return startAttempt(model, event);
            case 'TRY_AGAIN':
                return s === 'V6d' ? startAttempt(model, event) : stay(model);
            default:
                return stay(model);
        }
    }

    if (RETRY_FROM.includes(s)) {
        if (event.type === 'TRY_AGAIN' || event.type === 'SEND') return startAttempt(model, event);
        if (event.type === 'BACK_TO_FILES' && (s === 'V8a' || s === 'V8b' || s === 'V9')) return to(model, 'V3');
        return stay(model);
    }

    if (s === 'V6' || s === 'V6c') return connecting(model, event);
    if (s === 'V7') return waiting(model, event);
    if (s === 'V10') return sending(model, event);

    // V1, V2, V5a to V5c, V11, V11a, V11b, V12, V13: terminal for this page.
    return stay(model);
}

function connecting(model: VisitorModel, event: VisitorEvent): Step {
    const open = model.channelOpen;
    switch (event.type) {
        case 'ICE_READY':
            if (model.hideIp && !event.hasTurn) return end(model, 'V6b');
            return to(model, 'V6', {}, ['buildPeer', 'connectSocket']);
        case 'SOCKET_CONNECTED':
            // request-join goes out once per attempt. A reconnect later in the
            // same attempt re-joins nothing.
            if (model.joinEmitted) return to(model, 'V6', {}, ['clearConnectTimer']);
            return to(model, 'V6', { joinEmitted: true }, ['clearConnectTimer', 'emitJoin']);
        case 'SOCKET_REFUSED':
            if (open) return stay(model);
            return to(model, 'V6c', {}, ['retryConnect']);
        case 'SOCKET_CONNECT_TIMEOUT':
            return end(model, 'V6a');
        case 'SIGNAL_SENT':
            return model.signaled ? stay(model) : { model: { ...model, signaled: true }, effects: [] };
        case 'JOIN_ANSWER':
            // The room seals when the channel opens; a late answer on the
            // socket must not tear down a channel that no longer needs it.
            if (open) return stay(model);
            switch (event.answer) {
                case 'request-joined':
                    return to(model, 'V6', { joined: true }, ['clearJoinTimer', 'armSetupTimer']);
                case 'host-absent':
                    return end(model, 'V4');
                case 'disabled':
                    return end(model, 'V5b');
                case 'error':
                    return end(model, 'V6a');
                case 'room-full': {
                    // R1: after request-joined, room-full is the host's
                    // request-reopen evicting this page (E-03).
                    if (model.joined) return end(model, 'V6a');
                    const since = event.sincePreviousAttemptMs;
                    // L1: an earlier attempt of this page signaled and never
                    // opened its channel, so the room may be sealed on that
                    // seat until the host reopens it. Retried in Connecting,
                    // bounded by time and by count, then the fixed V5a.
                    if (model.sealedOwnSeat) {
                        if (
                            model.sealedRetries < ROOM_FULL_SEALED_RETRIES &&
                            typeof since === 'number' &&
                            since >= 0 &&
                            since <= ROOM_FULL_SEALED_WINDOW_MS
                        ) {
                            return to(model, 'V6', { sealedRetries: model.sealedRetries + 1 }, [
                                'clearJoinTimer',
                                'retryJoin',
                            ]);
                        }
                        return end(model, 'V5a');
                    }
                    // R2: this page's own previous seat may still be held.
                    if (
                        !model.joinRetried &&
                        typeof since === 'number' &&
                        since >= 0 &&
                        since <= ROOM_FULL_RETRY_WINDOW_MS
                    ) {
                        return to(model, 'V6', { joinRetried: true }, ['clearJoinTimer', 'retryJoin']);
                    }
                    return end(model, 'V5a');
                }
            }
            return stay(model);
        case 'JOIN_NO_ANSWER':
            return end(model, 'V5c');
        case 'SETUP_TIMEOUT':
        case 'PEER_ERROR':
            return end(model, 'V6a');
        case 'SOCKET_LOST':
            // Before the channel opens the attempt is over; after, signaling is
            // done and a socket blip changes nothing.
            return open ? stay(model) : end(model, 'V6a');
        case 'PEER_DISCONNECTED':
            return stay(model);
        case 'CHANNEL_OPEN':
            if (open) return stay(model);
            return to(model, 'V6', { channelOpen: true }, ['clearSetupTimer', 'startBadgePoll', 'armProbe']);
        case 'RELAY_VERDICT': {
            if (!open || model.sendStarted) return stay(model);
            const route = event.isRelay ? 'relay' : 'direct';
            if (event.action === 'proceed') return to(model, 'V6', { sendStarted: true, route }, ['sendFiles']);
            // The fixed relay reason went out before this event (the probe
            // awaits it, then destroys the peer); what is left is the teardown.
            if (event.action === 'block-over-limit') return end(model, 'V9', { route });
            // relayEnabled is always true on /r, so this cannot happen; if it
            // ever did, nothing was sent.
            return end(model, 'V6a', { route });
        }
        case 'FIRST_METADATA_SENT':
            if (!model.sendStarted) return stay(model);
            return to(model, 'V7', { firstMetadataAt: event.now }, ['startCountdown']);
        case 'INCOMPATIBLE':
            // A refusal can only come from a running send; one that beats the
            // first metadata's own report is read as it would be in V7.
            return model.sendStarted ? refusedBeforeAccept(model, event) : stay(model);
        case 'ACK_TIMEOUT':
            return model.sendStarted ? end(model, 'V8b') : stay(model);
        case 'CHANNEL_CLOSED':
        case 'SEND_SETTLED_SILENT':
            // The channel went, or the send gave up, before any metadata:
            // nothing was sent, and Try again can pair again.
            return open ? end(model, 'V6a') : stay(model);
        case 'CANCEL':
            return to(model, 'V6d', {}, open ? [...CANCEL_TEARDOWN] : [...TEARDOWN]);
        default:
            return stay(model);
    }
}

function waiting(model: VisitorModel, event: VisitorEvent): Step {
    switch (event.type) {
        case 'ACK':
            if (event.index !== 1) return stay(model);
            return to(model, 'V10', { ackIndex: 1, acceptedAt: event.now });
        case 'INCOMPATIBLE':
            return refusedBeforeAccept(model, event);
        case 'ACK_TIMEOUT':
            return event.index === 1 ? end(model, 'V8b') : stay(model);
        case 'CHANNEL_CLOSED':
            return end(model, 'V12a');
        case 'SEND_SETTLED_SILENT':
            return end(model, 'V12', { lost: 'silent' });
        case 'UNREADABLE':
            // The frozen C-130 row: an unreadable file maps to V11 after the
            // first ack, which is every case the sender can report, since it
            // reads a file only after that file's ack.
            return end(model, 'V11', { stop: null, unreadableIndex: event.index });
        case 'CANCEL':
            return to(model, 'V6d', {}, [...CANCEL_TEARDOWN]);
        case 'VERIFIED_COUNT':
            return to(model, 'V7', { verifiedCount: event.verifiedCount });
        default:
            // E26 and E27 (and a reconnect's connect) change nothing once the
            // channel is open. E22 cannot mean delivery before any file was
            // accepted.
            return stay(model);
    }
}

function sending(model: VisitorModel, event: VisitorEvent): Step {
    switch (event.type) {
        case 'ACK': {
            // Only the next file, in order, moves the count.
            const next = model.ackIndex + 1;
            if (event.index !== next || next > model.total) return stay(model);
            return to(model, 'V10', { ackIndex: next, percent: 0 });
        }
        case 'PROGRESS':
            return to(model, 'V10', {
                percent:
                    typeof event.percent === 'number' && Number.isFinite(event.percent)
                        ? Math.min(Math.max(event.percent, 0), 100)
                        : model.percent,
                bytesPerSec: event.bytesPerSec ?? model.bytesPerSec,
                etaSeconds: event.etaSeconds ?? model.etaSeconds,
            });
        case 'RECEIVED':
            return end(model, 'V13', { deliveredAt: event.now, percent: 100 });
        case 'INCOMPATIBLE':
            return end(model, 'V11', {
                stop: { refusal: allowlisted(event.refusal), savedCount: clampCount(event.savedCount, model.total) },
            });
        case 'ACK_TIMEOUT':
            return end(model, 'V12', { lost: 'ack-timeout' });
        case 'CHANNEL_CLOSED':
            return end(model, 'V12', { lost: 'closed' });
        case 'SEND_SETTLED_SILENT':
            return end(model, 'V12', { lost: 'silent' });
        case 'UNREADABLE':
            // The frozen C-130 row: an unreadable file maps to V11 after the
            // first ack, which is every case the sender can report, since it
            // reads a file only after that file's ack.
            return end(model, 'V11', { stop: null, unreadableIndex: event.index });
        case 'CANCEL':
            return to(model, 'V11a', {}, [...CANCEL_TEARDOWN]);
        case 'VERIFIED_COUNT':
            // Display only: a host can send `received` at any moment of the
            // session, so this never ends the drop (E22 is onAllSent).
            return to(model, 'V10', { verifiedCount: event.verifiedCount });
        default:
            return stay(model);
    }
}
