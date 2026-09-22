import { describe, it, expect } from 'vitest';
import {
    reduce,
    initialModel,
    arrivedCount,
    sendBlock,
    answerMinutesLeft,
    peerConfigFor,
    peerOptionsFor,
    ATTEMPT_ENDING_STATES,
    type VisitorModel,
    type VisitorEvent,
    type VisitorState,
} from './visitorState';
import { RELAY_SIZE_LIMIT } from '../relay';
import { ANSWER_WINDOW_MS } from './constants';

// The visitor's state machine, spec 07 4.12.4, one `it` per row, named
// `<From> + <Event> goes to <To>`. The reducer is pure: every test hands it a
// model and an event and reads back the next model and the effects the page
// must run. Nothing here opens a socket.
//
// Peer-derived counts in these events are spelled savedCount and
// verifiedCount on purpose: the consumer checker counts the wire field names
// anywhere in a test file, and the page's own names for the clamped values are
// what the reducer reads anyway.

const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const SEND: VisitorEvent = { type: 'SEND', count: 3, size: 3000, hideIp: false };
const TRY: VisitorEvent = { type: 'TRY_AGAIN', count: 3, size: 3000, hideIp: false };

/** A model sitting in `state` with the attempt facts that state implies. */
function modelIn(state: VisitorState, patch: Partial<VisitorModel> = {}): VisitorModel {
    const base: VisitorModel = { ...initialModel, state, roomId: ROOM, attempt: 1, total: 3, size: 3000 };
    const inAttempt: Partial<VisitorModel> = {
        V6: { joinEmitted: true },
        V6c: {},
        V7: { joinEmitted: true, joined: true, channelOpen: true, sendStarted: true, firstMetadataAt: 1000 },
        V10: {
            joinEmitted: true, joined: true, channelOpen: true, sendStarted: true,
            firstMetadataAt: 1000, ackIndex: 1, acceptedAt: 2000,
        },
    }[state as 'V6' | 'V6c' | 'V7' | 'V10'] ?? {};
    return { ...base, ...inAttempt, ...patch };
}

function step(model: VisitorModel, event: VisitorEvent) {
    return reduce(model, event);
}

describe('visitor state: load rows', () => {
    it('(load) + E01 goes to V3', () => {
        const r = step(initialModel, { type: 'LINK_OK', roomId: ROOM });
        expect(r.model.state).toBe('V3');
        expect(r.effects).toEqual([]);
    });
    it('(load) + E02 goes to V1', () => {
        expect(step(initialModel, { type: 'LINK_INCOMPLETE' }).model.state).toBe('V1');
    });
    it('(load) + E03 goes to V2', () => {
        expect(step(initialModel, { type: 'NO_WEBRTC' }).model.state).toBe('V2');
    });
});

describe('visitor state: Ready rows', () => {
    it('V3 + E04 goes to V3', () => {
        expect(step(modelIn('V3'), { type: 'FILES_ADDED' }).model.state).toBe('V3');
    });
    it('V3 + E06 goes to V3', () => {
        expect(step(modelIn('V3'), { type: 'CLEAR' }).model.state).toBe('V3');
        expect(step(modelIn('V3c'), { type: 'CLEAR' }).model.state).toBe('V3');
    });
    it('V3 + E07 goes to V3', () => {
        expect(step(modelIn('V3'), { type: 'HIDE_IP_TOGGLED' }).model.state).toBe('V3');
    });
    it('V3 + E05 goes to V3c', () => {
        const r = step(modelIn('V3'), { type: 'PICK_REFUSED' });
        expect(r.model.state).toBe('V3c');
        expect(r.effects).toEqual([]);
    });
    it('V3 + E08 goes to V6', () => {
        const r = step(modelIn('V3', { attempt: 0 }), SEND);
        expect(r.model.state).toBe('V6');
        expect(r.model.attempt).toBe(1);
        expect(r.model.total).toBe(3);
        expect(r.effects).toEqual(['startAttempt']);
    });

    const retryFrom: VisitorState[] = ['V4', 'V8a', 'V8b', 'V9', 'V6a', 'V6d', 'V12a'];
    for (const from of retryFrom) {
        for (const [label, event] of [['E25', TRY], ['E08', SEND]] as const) {
            it(`${from} + ${label} goes to V6`, () => {
                const before = modelIn(from, { attempt: 4, ackIndex: 2, joined: true, channelOpen: true });
                const r = step(before, event);
                expect(r.model.state).toBe('V6');
                expect(r.model.attempt).toBe(5);
                // A new attempt starts clean: nothing from the last one leaks in.
                expect(r.model.ackIndex).toBe(0);
                expect(r.model.joined).toBe(false);
                expect(r.model.channelOpen).toBe(false);
                expect(r.effects).toEqual(['startAttempt']);
            });
        }
    }

    it('V8a + Back to files goes to V3', () => {
        for (const from of ['V8a', 'V8b', 'V9'] as VisitorState[]) {
            const r = step(modelIn(from), { type: 'BACK_TO_FILES' });
            expect(r.model.state).toBe('V3');
            expect(r.effects).toEqual([]);
        }
    });

    it('Send is refused while Hide my IP is on and the drop is over 2 GB', () => {
        const over = { type: 'SEND', count: 1, size: RELAY_SIZE_LIMIT + 1, hideIp: true } as const;
        const r = step(modelIn('V3'), over);
        expect(r.model.state).toBe('V3');
        expect(r.effects).toEqual([]);
        expect(sendBlock({ count: 1, size: RELAY_SIZE_LIMIT + 1, hideIp: true, reading: false })).toBe('relay-cap');
    });

    it('exactly 2 GB with Hide my IP on is allowed', () => {
        expect(sendBlock({ count: 1, size: RELAY_SIZE_LIMIT, hideIp: true, reading: false })).toBeNull();
        const r = step(modelIn('V3'), { type: 'SEND', count: 1, size: RELAY_SIZE_LIMIT, hideIp: true });
        expect(r.model.state).toBe('V6');
    });

    it('Send is refused with no files or while a drop is still being read', () => {
        expect(sendBlock({ count: 0, size: 0, hideIp: false, reading: false })).toBe('empty');
        expect(sendBlock({ count: 2, size: 10, hideIp: false, reading: true })).toBe('reading');
        expect(step(modelIn('V3'), { type: 'SEND', count: 0, size: 0, hideIp: false }).model.state).toBe('V3');
        expect(
            step(modelIn('V3'), { type: 'SEND', count: 2, size: 10, hideIp: false, reading: true }).model.state
        ).toBe('V3');
        // Over 2 GB is fine with Hide my IP off: the relay cap is the gate's
        // business after the route is known.
        expect(sendBlock({ count: 1, size: RELAY_SIZE_LIMIT * 4, hideIp: false, reading: false })).toBeNull();
    });
});

describe('visitor state: Connecting rows', () => {
    it('V6 + E09 (Hide my IP on, no TURN) goes to V6b', () => {
        const r = step(modelIn('V6', { hideIp: true, joinEmitted: false }), { type: 'ICE_READY', hasTurn: false });
        expect(r.model.state).toBe('V6b');
        // Stopped before any socket or peer exists: nothing that joins.
        expect(r.effects).not.toContain('buildPeer');
        expect(r.effects).not.toContain('connectSocket');
        expect(r.effects).toContain('releaseWakeLock');
    });
    it('V6 + E09 (ok) goes to V6', () => {
        const r = step(modelIn('V6', { hideIp: true, joinEmitted: false }), { type: 'ICE_READY', hasTurn: true });
        expect(r.model.state).toBe('V6');
        // The peer is built BEFORE the socket joins, so an early offer always
        // finds one.
        expect(r.effects).toEqual(['buildPeer', 'connectSocket']);
    });
    it('V6 + E09 with Hide my IP off never needs a relay', () => {
        const r = step(modelIn('V6', { hideIp: false, joinEmitted: false }), { type: 'ICE_READY', hasTurn: false });
        expect(r.model.state).toBe('V6');
        expect(r.effects).toEqual(['buildPeer', 'connectSocket']);
    });
    it('V6 + E10 goes to V6c', () => {
        const r = step(modelIn('V6'), { type: 'SOCKET_REFUSED' });
        expect(r.model.state).toBe('V6c');
        expect(r.effects).toEqual(['retryConnect']);
    });
    it('V6c + a socket connect goes back to V6 and joins', () => {
        const r = step(modelIn('V6c', { joinEmitted: false }), { type: 'SOCKET_CONNECTED' });
        expect(r.model.state).toBe('V6');
        expect(r.effects).toEqual(['clearConnectTimer', 'emitJoin']);
    });
    it('V6 + E11 host-absent goes to V4', () => {
        const r = step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'host-absent' });
        expect(r.model.state).toBe('V4');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V6 + E11 room-full goes to V5a', () => {
        const r = step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: null });
        expect(r.model.state).toBe('V5a');
    });
    it('V6 + E11 disabled goes to V5b', () => {
        expect(step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'disabled' }).model.state).toBe('V5b');
    });
    it('V6 + E12 goes to V5c', () => {
        expect(step(modelIn('V6'), { type: 'JOIN_NO_ANSWER' }).model.state).toBe('V5c');
    });
    it('V6 + E11 request-joined goes to V6', () => {
        const r = step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'request-joined' });
        expect(r.model.state).toBe('V6');
        expect(r.model.joined).toBe(true);
        expect(r.effects).toEqual(['clearJoinTimer', 'armSetupTimer']);
    });
    it('V6 + E13 goes to V6a', () => {
        expect(step(modelIn('V6', { joined: true }), { type: 'SETUP_TIMEOUT' }).model.state).toBe('V6a');
    });
    it('V6 + E14 goes to V6a', () => {
        expect(step(modelIn('V6', { joined: true }), { type: 'PEER_ERROR' }).model.state).toBe('V6a');
    });
    it('V6 + E26 goes to V6a', () => {
        expect(step(modelIn('V6'), { type: 'SOCKET_LOST' }).model.state).toBe('V6a');
    });
    it('V6 + E15 goes to V6', () => {
        const r = step(modelIn('V6', { joined: true }), { type: 'CHANNEL_OPEN' });
        expect(r.model.state).toBe('V6');
        expect(r.model.channelOpen).toBe(true);
        expect(r.effects).toEqual(['clearSetupTimer', 'startBadgePoll', 'armProbe']);
    });
    it('V6 + E16 block-over-limit goes to V9', () => {
        const r = step(modelIn('V6', { joined: true, channelOpen: true }), {
            type: 'RELAY_VERDICT', action: 'block-over-limit', isRelay: true,
        });
        expect(r.model.state).toBe('V9');
        expect(r.model.route).toBe('relay');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V6 + E16 proceed goes to V6', () => {
        const r = step(modelIn('V6', { joined: true, channelOpen: true }), {
            type: 'RELAY_VERDICT', action: 'proceed', isRelay: false,
        });
        expect(r.model.state).toBe('V6');
        expect(r.model.sendStarted).toBe(true);
        expect(r.model.route).toBe('direct');
        expect(r.effects).toEqual(['sendFiles']);
    });
    it('V6 + E16 block-relay-disabled goes to V6a (it cannot occur on /r)', () => {
        const r = step(modelIn('V6', { joined: true, channelOpen: true }), {
            type: 'RELAY_VERDICT', action: 'block-relay-disabled', isRelay: true,
        });
        expect(r.model.state).toBe('V6a');
    });
    it('V6 + E17 goes to V7', () => {
        const r = step(modelIn('V6', { joined: true, channelOpen: true, sendStarted: true }), {
            type: 'FIRST_METADATA_SENT', now: 5000,
        });
        expect(r.model.state).toBe('V7');
        expect(r.model.firstMetadataAt).toBe(5000);
        expect(r.effects).toEqual(['startCountdown']);
    });
    it('V6 + E24 goes to V6d', () => {
        const r = step(modelIn('V6'), { type: 'CANCEL' });
        expect(r.model.state).toBe('V6d');
        // Before the channel opens there is nobody to tell.
        expect(r.effects).not.toContain('sendCancelAbort');
        expect(r.effects).toContain('destroyPeer');
    });
    it('V7 + E24 goes to V6d', () => {
        const r = step(modelIn('V7'), { type: 'CANCEL' });
        expect(r.model.state).toBe('V6d');
        // With the channel open the fixed abort goes first, and it owns the
        // destroy, so no second effect tears the peer down under it.
        expect(r.effects[0]).toBe('sendCancelAbort');
        expect(r.effects).not.toContain('destroyPeer');
    });
});

describe('visitor state: errata rows R1 to R6', () => {
    it('V6 + E11 room-full after request-joined goes to V6a (eviction)', () => {
        const r = step(modelIn('V6', { joined: true }), {
            type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 1000,
        });
        expect(r.model.state).toBe('V6a');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V6 + E11 room-full within 15 s retries request-join once', () => {
        const r = step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 15_000 });
        expect(r.model.state).toBe('V6');
        expect(r.model.joinRetried).toBe(true);
        expect(r.effects).toEqual(['clearJoinTimer', 'retryJoin']);
        // Just outside the window it is a used link.
        expect(
            step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 15_001 }).model.state
        ).toBe('V5a');
    });
    it('a second room-full goes to V5a', () => {
        const once = step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 2000 });
        const twice = step(once.model, { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 5000 });
        expect(twice.model.state).toBe('V5a');
        expect(twice.effects).toContain('disconnectSocket');
    });
    it('E19 time-limit goes to V11 with the time-limit copy', () => {
        const r = step(modelIn('V10', { ackIndex: 3 }), {
            type: 'INCOMPATIBLE', refusal: 'time-limit', savedCount: 2, rangeOverlaps: true,
        });
        expect(r.model.state).toBe('V11');
        expect(r.model.stop).toEqual({ refusal: 'time-limit', savedCount: 2 });
    });
    it('E19 too-slow goes to V11 with the unknown-code copy', () => {
        // The sender's allowlist already turns too-slow into null; a page fed
        // the raw string anyway must still land on the unknown-code row.
        const r = step(modelIn('V10'), {
            type: 'INCOMPATIBLE', refusal: 'too-slow' as never, savedCount: 0, rangeOverlaps: true,
        });
        expect(r.model.state).toBe('V11');
        expect(r.model.stop?.refusal).toBeNull();
    });
    it('E30 goes to V6a', () => {
        expect(step(modelIn('V6'), { type: 'SOCKET_CONNECT_TIMEOUT' }).model.state).toBe('V6a');
        expect(step(modelIn('V6c'), { type: 'SOCKET_CONNECT_TIMEOUT' }).model.state).toBe('V6a');
    });
    it('R5: the Arrived count after ack N is N-1 and ignores any peer count', () => {
        let m = modelIn('V7');
        m = step(m, { type: 'ACK', index: 1, now: 10 }).model;
        expect(arrivedCount(m)).toBe(0);
        // A hostile ack cannot carry a count into the reducer: extra fields on
        // the event are ignored, and only the sender's own index moves Arrived.
        m = step(m, { type: 'ACK', index: 2, now: 20, savedCount: 3, verifiedCount: 3 } as VisitorEvent).model;
        expect(arrivedCount(m)).toBe(1);
        m = step(m, { type: 'ACK', index: 3, now: 30 }).model;
        expect(arrivedCount(m)).toBe(2);
    });
    it('R5: an ack index out of order or out of range moves nothing', () => {
        const m = modelIn('V10', { ackIndex: 2 });
        for (const index of [2, 4, 0, -1, 1.5, Number.NaN, 99]) {
            expect(step(m, { type: 'ACK', index, now: 1 }).model.ackIndex).toBe(2);
        }
    });
    it('R6: host-absent after the owner closed the link goes to V4', () => {
        // A waiting page whose owner pressed Close link gets host-absent, not
        // room-full (OD-28): the same Host absent row as a closed Floe.
        const r = step(modelIn('V6', { joined: true }), { type: 'JOIN_ANSWER', answer: 'host-absent' });
        expect(r.model.state).toBe('V4');
    });
});

describe('visitor state: Waiting rows', () => {
    it('V7 + E18 (index 1) goes to V10', () => {
        const r = step(modelIn('V7'), { type: 'ACK', index: 1, now: 9000 });
        expect(r.model.state).toBe('V10');
        expect(r.model.acceptedAt).toBe(9000);
        expect(r.effects).toEqual([]);
    });
    it('V7 + E19 declined goes to V8a', () => {
        const r = step(modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'declined', savedCount: 0, rangeOverlaps: true });
        expect(r.model.state).toBe('V8a');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V7 + E19 expired goes to V8b', () => {
        expect(
            step(modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'expired', savedCount: 0, rangeOverlaps: true }).model.state
        ).toBe('V8b');
    });
    it('V7 + E20 (index 1) goes to V8b', () => {
        expect(step(modelIn('V7'), { type: 'ACK_TIMEOUT', index: 1 }).model.state).toBe('V8b');
    });
    it('V7 + E19 other code, overlapping range goes to V11 (saved 0)', () => {
        const r = step(modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'disk-full', savedCount: 7, rangeOverlaps: true });
        expect(r.model.state).toBe('V11');
        // Nothing can have been saved before the first ack, whatever the
        // frame claims.
        expect(r.model.stop).toEqual({ refusal: 'disk-full', savedCount: 0 });
    });
    it('V7 + E19 non-overlapping range goes to V11b', () => {
        const r = step(modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'declined', savedCount: 0, rangeOverlaps: false });
        expect(r.model.state).toBe('V11b');
    });
    it('V7 + E23 goes to V12a', () => {
        const r = step(modelIn('V7'), { type: 'CHANNEL_CLOSED' });
        expect(r.model.state).toBe('V12a');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V7 + E26 goes to V7', () => {
        const r = step(modelIn('V7'), { type: 'SOCKET_LOST' });
        expect(r.model.state).toBe('V7');
        expect(r.effects).toEqual([]);
    });
    it('V7 + E27 goes to V7', () => {
        expect(step(modelIn('V7'), { type: 'PEER_DISCONNECTED' })).toEqual({ model: modelIn('V7'), effects: [] });
    });
    it('V7 + E31 goes to V12', () => {
        const r = step(modelIn('V7'), { type: 'SEND_SETTLED_SILENT' });
        expect(r.model.state).toBe('V12');
        expect(r.model.lost).toBe('silent');
    });
});

describe('visitor state: Sending rows', () => {
    it('V10 + E18 (index > 1) goes to V10', () => {
        const r = step(modelIn('V10'), { type: 'ACK', index: 2, now: 1 });
        expect(r.model.state).toBe('V10');
        expect(r.model.ackIndex).toBe(2);
    });
    it('V10 + E21 goes to V10', () => {
        const r = step(modelIn('V10'), { type: 'PROGRESS', percent: 48, bytesPerSec: 1000, etaSeconds: 34 });
        expect(r.model.state).toBe('V10');
        expect(r.model.percent).toBe(48);
        expect(r.model.bytesPerSec).toBe(1000);
    });
    it('V10 + E22 goes to V13', () => {
        const r = step(modelIn('V10'), { type: 'RECEIVED', now: 99_000 });
        expect(r.model.state).toBe('V13');
        expect(r.model.deliveredAt).toBe(99_000);
        expect(arrivedCount(r.model)).toBe(3);
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V10 + E19 any code goes to V11', () => {
        const r = step(modelIn('V10', { ackIndex: 3 }), {
            type: 'INCOMPATIBLE', refusal: 'hash-mismatch', savedCount: 2, rangeOverlaps: true,
        });
        expect(r.model.state).toBe('V11');
        expect(r.model.stop).toEqual({ refusal: 'hash-mismatch', savedCount: 2 });
        const unknown = step(modelIn('V10'), { type: 'INCOMPATIBLE', refusal: null, savedCount: 0, rangeOverlaps: false });
        expect(unknown.model.state).toBe('V11');
    });
    it('V10 + E20 (index > 1) goes to V12', () => {
        const r = step(modelIn('V10', { ackIndex: 2 }), { type: 'ACK_TIMEOUT', index: 3 });
        expect(r.model.state).toBe('V12');
        expect(r.model.lost).toBe('ack-timeout');
    });
    it('V10 + E23 goes to V12', () => {
        const r = step(modelIn('V10'), { type: 'CHANNEL_CLOSED' });
        expect(r.model.state).toBe('V12');
        expect(r.model.lost).toBe('closed');
    });
    it('V10 + E31 goes to V12', () => {
        const r = step(modelIn('V10'), { type: 'SEND_SETTLED_SILENT' });
        expect(r.model.state).toBe('V12');
        expect(r.model.lost).toBe('silent');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V10 + E24 goes to V11a', () => {
        const r = step(modelIn('V10', { ackIndex: 3 }), { type: 'CANCEL' });
        expect(r.model.state).toBe('V11a');
        expect(r.effects[0]).toBe('sendCancelAbort');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V10 + E26 goes to V10', () => {
        expect(step(modelIn('V10'), { type: 'SOCKET_LOST' }).model.state).toBe('V10');
    });
    it('V10 + E27 goes to V10', () => {
        expect(step(modelIn('V10'), { type: 'PEER_DISCONNECTED' }).model.state).toBe('V10');
    });
    it('V10 + an unreadable file goes to V12 with the visitor\'s own index', () => {
        const r = step(modelIn('V10', { ackIndex: 2 }), { type: 'UNREADABLE', index: 2 });
        expect(r.model.state).toBe('V12');
        expect(r.model.lost).toBe('unreadable');
        expect(r.model.unreadableIndex).toBe(2);
    });
});

describe('visitor state: visibility and hash rows', () => {
    for (const s of ['V6', 'V7', 'V10'] as VisitorState[]) {
        it(`${s} + E28 visible goes to ${s}`, () => {
            const before = modelIn(s);
            // The guards hook owns what visibility does (S1-WEB-04); the
            // reducer's row is that the state does not move.
            expect(step(before, { type: 'VISIBILITY', visible: true })).toEqual({ model: before, effects: [] });
        });
    }
    const reloadFrom: VisitorState[] = ['V1', 'V2', 'V3', 'V3c', 'V4', 'V5a', 'V5b', 'V5c', 'V8a', 'V8b', 'V9'];
    for (const s of reloadFrom) {
        it(`${s} + E29 (different roomId) reloads`, () => {
            const r = step(modelIn(s), { type: 'HASHCHANGE', roomId: '11111111-1111-4111-8111-111111111111' });
            expect(r.effects).toEqual(['reload']);
        });
    }
    it('E29 with the same roomId changes nothing', () => {
        expect(step(modelIn('V3'), { type: 'HASHCHANGE', roomId: ROOM }).effects).toEqual([]);
    });
    it('E29 in V1 with a link that now parses reloads', () => {
        const v1 = { ...initialModel, state: 'V1' as const };
        expect(step(v1, { type: 'HASHCHANGE', roomId: ROOM }).effects).toEqual(['reload']);
    });
    it('E29 never reloads a live attempt', () => {
        for (const s of ['V6', 'V7', 'V10'] as VisitorState[]) {
            expect(step(modelIn(s), { type: 'HASHCHANGE', roomId: null }).effects).toEqual([]);
        }
    });
});

describe('visitor state: the rules carried from the reviews', () => {
    it('E26 and E27 are ignored after E15', () => {
        const open = modelIn('V6', { joined: true, channelOpen: true });
        expect(step(open, { type: 'SOCKET_LOST' })).toEqual({ model: open, effects: [] });
        expect(step(open, { type: 'PEER_DISCONNECTED' })).toEqual({ model: open, effects: [] });
    });
    it('E26 before E15 goes to V6a', () => {
        const r = step(modelIn('V6', { joined: true, channelOpen: false }), { type: 'SOCKET_LOST' });
        expect(r.model.state).toBe('V6a');
        expect(r.effects).toContain('disconnectSocket');
    });
    it('a server answer after E15 is ignored', () => {
        // The room seals at channel open; a late answer on the socket must not
        // tear down a channel that no longer needs the server.
        const open = modelIn('V6', { joined: true, channelOpen: true });
        for (const answer of ['host-absent', 'room-full', 'disabled', 'error'] as const) {
            expect(step(open, { type: 'JOIN_ANSWER', answer, sincePreviousAttemptMs: 0 })).toEqual({
                model: open, effects: [],
            });
        }
    });
    it('a server error answer before E15 goes to V6a', () => {
        expect(step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'error' }).model.state).toBe('V6a');
    });
    it('a verified report never ends the drop (E22 comes only from onAllSent)', () => {
        for (const s of ['V7', 'V10'] as VisitorState[]) {
            const r = step(modelIn(s), { type: 'VERIFIED_COUNT', verifiedCount: 3 });
            expect(r.model.state).toBe(s);
            expect(r.model.verifiedCount).toBe(3);
            expect(r.effects).toEqual([]);
        }
        // And RECEIVED before the first ack is not a delivery either.
        expect(step(modelIn('V7'), { type: 'RECEIVED', now: 1 }).model.state).toBe('V7');
    });
    it('a silent settlement counts as Lost (E31)', () => {
        expect(step(modelIn('V10', { ackIndex: 1 }), { type: 'SEND_SETTLED_SILENT' }).model.state).toBe('V12');
    });
    it('the channel closing before any metadata goes to V6a', () => {
        const open = modelIn('V6', { joined: true, channelOpen: true });
        expect(step(open, { type: 'CHANNEL_CLOSED' }).model.state).toBe('V6a');
        expect(step({ ...open, sendStarted: true }, { type: 'SEND_SETTLED_SILENT' }).model.state).toBe('V6a');
    });
    it('a refusal that beats the first metadata is read as in V7', () => {
        const sending = modelIn('V6', { joined: true, channelOpen: true, sendStarted: true });
        expect(
            step(sending, { type: 'INCOMPATIBLE', refusal: 'declined', savedCount: 0, rangeOverlaps: true }).model.state
        ).toBe('V8a');
    });
    it('request-join is emitted once per attempt and never after the channel opens', () => {
        const first = step(modelIn('V6', { joinEmitted: false }), { type: 'SOCKET_CONNECTED' });
        expect(first.effects).toEqual(['clearConnectTimer', 'emitJoin']);
        expect(first.model.joinEmitted).toBe(true);
        // A reconnect in the same attempt: the seat is ours or it is not, and
        // a second request-join would only confuse the server.
        expect(step(first.model, { type: 'SOCKET_CONNECTED' }).effects).not.toContain('emitJoin');
        for (const s of ['V7', 'V10'] as VisitorState[]) {
            expect(step(modelIn(s), { type: 'SOCKET_CONNECTED' }).effects).toEqual([]);
        }
    });
    it('nothing before Send opens a socket or fetches ICE', () => {
        const opening = ['startAttempt', 'buildPeer', 'connectSocket', 'emitJoin', 'retryJoin', 'retryConnect'];
        const idle: VisitorEvent[] = [
            { type: 'LINK_OK', roomId: ROOM },
            { type: 'FILES_ADDED' },
            { type: 'PICK_REFUSED' },
            { type: 'CLEAR' },
            { type: 'HIDE_IP_TOGGLED' },
            { type: 'ICE_READY', hasTurn: true },
            { type: 'SOCKET_CONNECTED' },
            { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 0 },
            { type: 'SOCKET_REFUSED' },
            { type: 'CHANNEL_OPEN' },
            { type: 'VISIBILITY', visible: true },
            { type: 'SEND', count: 0, size: 0, hideIp: false },
        ];
        let m: VisitorModel = initialModel;
        for (const e of idle) {
            const r = step(m, e);
            for (const eff of r.effects) expect(opening).not.toContain(eff);
            m = r.model;
        }
        expect(m.state).toBe('V3');
    });
    it('a terminal state ignores every late event', () => {
        const late: VisitorEvent[] = [
            { type: 'CHANNEL_CLOSED' }, { type: 'SEND_SETTLED_SILENT' }, { type: 'PEER_ERROR' },
            { type: 'ACK', index: 2, now: 1 }, { type: 'RECEIVED', now: 1 },
            { type: 'INCOMPATIBLE', refusal: 'stopped', savedCount: 1, rangeOverlaps: true },
            { type: 'CANCEL' }, { type: 'SETUP_TIMEOUT' }, { type: 'SOCKET_CONNECTED' },
        ];
        for (const s of ['V5a', 'V5b', 'V5c', 'V11', 'V11a', 'V11b', 'V12', 'V13'] as VisitorState[]) {
            const before = modelIn(s);
            for (const e of late) expect(step(before, e)).toEqual({ model: before, effects: [] });
        }
    });

    it('every attempt-ending transition requests a socket disconnect', () => {
        // Every way into each attempt-ending or terminal state, driven through
        // the reducer rather than asserted from a table, so a new row that
        // forgets the teardown fails here.
        const routes: Array<[VisitorModel, VisitorEvent]> = [
            [modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'host-absent' }], // V4
            [modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: null }], // V5a
            [modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'disabled' }], // V5b
            [modelIn('V6'), { type: 'JOIN_NO_ANSWER' }], // V5c
            [modelIn('V6'), { type: 'SETUP_TIMEOUT' }], // V6a
            [modelIn('V6'), { type: 'PEER_ERROR' }], // V6a
            [modelIn('V6'), { type: 'SOCKET_LOST' }], // V6a
            [modelIn('V6'), { type: 'SOCKET_CONNECT_TIMEOUT' }], // V6a
            [modelIn('V6', { joined: true }), { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 0 }], // V6a
            [modelIn('V6', { hideIp: true, joinEmitted: false }), { type: 'ICE_READY', hasTurn: false }], // V6b
            [modelIn('V6'), { type: 'CANCEL' }], // V6d
            [modelIn('V7'), { type: 'CANCEL' }], // V6d
            [modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'declined', savedCount: 0, rangeOverlaps: true }], // V8a
            [modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'expired', savedCount: 0, rangeOverlaps: true }], // V8b
            [modelIn('V7'), { type: 'ACK_TIMEOUT', index: 1 }], // V8b
            [modelIn('V6', { channelOpen: true }), { type: 'RELAY_VERDICT', action: 'block-over-limit', isRelay: true }], // V9
            [modelIn('V10'), { type: 'INCOMPATIBLE', refusal: 'stopped', savedCount: 1, rangeOverlaps: true }], // V11
            [modelIn('V10'), { type: 'CANCEL' }], // V11a
            [modelIn('V7'), { type: 'INCOMPATIBLE', refusal: null, savedCount: 0, rangeOverlaps: false }], // V11b
            [modelIn('V10'), { type: 'CHANNEL_CLOSED' }], // V12
            [modelIn('V10'), { type: 'SEND_SETTLED_SILENT' }], // V12
            [modelIn('V10'), { type: 'UNREADABLE', index: 1 }], // V12
            [modelIn('V7'), { type: 'CHANNEL_CLOSED' }], // V12a
            [modelIn('V10'), { type: 'RECEIVED', now: 1 }], // V13
        ];
        const reached = new Set<string>();
        for (const [model, event] of routes) {
            const r = step(model, event);
            expect(ATTEMPT_ENDING_STATES).toContain(r.model.state);
            expect(r.effects, `${model.state} + ${event.type} -> ${r.model.state}`).toContain('disconnectSocket');
            expect(r.effects).toContain('clearTimers');
            expect(r.effects).toContain('releaseWakeLock');
            // The peer goes too, either at once or after the fixed abort.
            expect(r.effects.includes('destroyPeer') || r.effects.includes('sendCancelAbort')).toBe(true);
            reached.add(r.model.state);
        }
        expect([...reached].sort()).toEqual(
            ['V4', 'V5a', 'V5b', 'V5c', 'V6a', 'V6b', 'V6d', 'V8a', 'V8b', 'V9', 'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13'].sort()
        );
        expect([...ATTEMPT_ENDING_STATES].sort()).toEqual([...reached].sort());
    });
});

describe('visitor state: helpers', () => {
    it('the countdown starts at 9 min and never reads 0 min', () => {
        expect(answerMinutesLeft(0)).toBe(9);
        expect(answerMinutesLeft(ANSWER_WINDOW_MS - 60_000)).toBe(1);
        expect(answerMinutesLeft(ANSWER_WINDOW_MS - 59_999)).toBe(0);
        expect(answerMinutesLeft(ANSWER_WINDOW_MS + 30_000)).toBe(0);
        expect(answerMinutesLeft(-5)).toBe(9);
    });
    it('the peer is built answering, trickling and with the relay policy the switch asks for', () => {
        const servers = [{ urls: 'stun:s.example:3478' }, { urls: 'turn:t.example:3478' }];
        const hidden = peerOptionsFor(servers, true);
        expect(hidden).toMatchObject({ initiator: false, trickle: true, readableObjectMode: true });
        expect(hidden.config).toEqual({ iceServers: servers, iceTransportPolicy: 'relay' });
        expect(peerOptionsFor(servers, false).config.iceTransportPolicy).toBe('all');
    });
    it('Hide my IP asks for relay candidates only and keeps TURN in the list', () => {
        const servers = [{ urls: 'stun:stun.example:3478' }, { urls: ['turn:t.example:3478', 'turns:t.example:443'] }];
        const hidden = peerConfigFor(servers, true);
        expect(hidden.iceTransportPolicy).toBe('relay');
        // Never filtered: stripping TURN is what the main page's relay-off
        // toggle does, and it is the opposite of hiding an address.
        expect(hidden.iceServers).toEqual(servers);
        expect(hidden.iceServers).not.toBe(servers);
        expect(peerConfigFor(servers, false).iceTransportPolicy).toBe('all');
    });
});
