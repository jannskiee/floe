import { describe, it, expect } from 'vitest';
import {
    reduce,
    initialModel,
    arrivedCount,
    sendBlock,
    answerMinutesLeft,
    peerConfigFor,
    peerOptionsFor,
    lostRecordOf,
    ATTEMPT_ENDING_STATES,
    type VisitorEffect,
    type VisitorModel,
    type VisitorEvent,
    type VisitorState,
} from './visitorState';
import { EVERY_VISITOR_STATE } from './everyVisitorState';
import { announcement, statusCopy, type StatusContext } from './visitorCopy';
import { lostSyncStep } from './lostRecord';
import { RELAY_SIZE_LIMIT } from '../relay';
import {
    ANSWER_WINDOW_MS,
    MAX_REQUEST_FILES,
    ROOM_FULL_RETRY_DELAY_MS,
    ROOM_FULL_SEALED_RETRIES,
    ROOM_FULL_SEALED_WINDOW_MS,
} from './constants';

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
        const r = step(initialModel, { type: 'LINK_OK', roomId: ROOM, keyed: false });
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
    // The page could not read the server's ICE list (the request failed, was
    // refused, or did not parse), so it holds its own STUN defaults and does
    // not know whether the server has a relay. "This Floe server has no relay
    // right now" would be a guess there, and a wrong one whenever the server
    // was only limiting requests. V6e says what happened instead.
    it('V6 + E09 (Hide my IP on, the list unread) goes to V6e', () => {
        const r = step(modelIn('V6', { hideIp: true, joinEmitted: false }), {
            type: 'ICE_READY',
            hasTurn: false,
            listRead: false,
        });
        expect(r.model.state).toBe('V6e');
        // Stopped before any socket or peer exists, exactly as V6b is.
        expect(r.effects).not.toContain('buildPeer');
        expect(r.effects).not.toContain('connectSocket');
        expect(r.effects).toContain('releaseWakeLock');
    });
    it('V6 + E09 (Hide my IP on, the list read, no TURN in it) is still V6b', () => {
        const r = step(modelIn('V6', { hideIp: true, joinEmitted: false }), {
            type: 'ICE_READY',
            hasTurn: false,
            listRead: true,
        });
        expect(r.model.state).toBe('V6b');
    });
    it('V6 + E09 with Hide my IP off connects on the STUN defaults when the list is unread', () => {
        const r = step(modelIn('V6', { hideIp: false, joinEmitted: false }), {
            type: 'ICE_READY',
            hasTurn: false,
            listRead: false,
        });
        expect(r.model.state).toBe('V6');
        expect(r.effects).toEqual(['buildPeer', 'connectSocket']);
    });
    it('V6e is Ready again: Send starts a new attempt, which reads the list again', () => {
        const ended = step(modelIn('V6', { hideIp: true, joinEmitted: false }), {
            type: 'ICE_READY',
            hasTurn: false,
            listRead: false,
        }).model;
        const again = step(ended, { type: 'SEND', count: 1, size: 10, hideIp: true });
        expect(again.model.state).toBe('V6');
        expect(again.effects).toEqual(['startAttempt']);
        // And turning the switch off is an ordinary Ready edit.
        expect(step(ended, { type: 'HIDE_IP_TOGGLED' }).model.state).toBe('V3');
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
    // D-176: a link its host closed, or that reached its end, before anyone used it.
    it('V6 + E11 link-ended goes to V5d, which ends the attempt and stays', () => {
        const r = step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'link-ended' });
        expect(r.model.state).toBe('V5d');
        expect(r.effects).toContain('disconnectSocket');
        expect(step(r.model, { type: 'TRY_AGAIN', count: 1, size: 1, hideIp: false }).model.state).toBe('V5d');
    });
    it('V6 + E11 disabled goes to V5b', () => {
        expect(step(modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'disabled' }).model.state).toBe('V5b');
    });
    it('Try again from V5b and V5c asks the server again with the same selection (owner answer 18)', () => {
        for (const s of ['V5b', 'V5c'] as VisitorState[]) {
            const r = step(modelIn(s), TRY);
            expect(r.model.state).toBe('V6');
            expect(r.model.attempt).toBe(2);
            expect(r.model.total).toBe(3);
            expect(r.model.roomId).toBe(ROOM);
            expect(r.effects).toEqual(['startAttempt']);
        }
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

describe("visitor state: a room sealed on this page's own earlier seat (review 2a L1, D-116)", () => {
    // The server seals a request room once both seats have signaled. A page
    // whose socket goes after it answered, but before its channel opened, ends
    // that attempt in V6a; its Try again then meets room-full until the host
    // reopens. That room-full is retried in Connecting, bounded, and ends in
    // the fixed V5a once the bound passes.
    const FULL = (since: number | null): VisitorEvent => ({
        type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: since,
    });

    it('V6 + SIGNAL_SENT marks this attempt signaled, once, with no effect', () => {
        const r = step(modelIn('V6', { joined: true }), { type: 'SIGNAL_SENT' });
        expect(r.model.state).toBe('V6');
        expect(r.model.signaled).toBe(true);
        expect(r.effects).toEqual([]);
        const again = step(r.model, { type: 'SIGNAL_SENT' });
        expect(again).toEqual({ model: r.model, effects: [] });
    });

    it('Try again after an attempt that signaled and never opened carries the sealed seat', () => {
        for (const s of ['V6a', 'V6d'] as VisitorState[]) {
            const ev = s === 'V6d' ? SEND : TRY;
            const r = step(modelIn(s, { joinEmitted: true, joined: true, signaled: true }), ev);
            expect(r.model.state, s).toBe('V6');
            expect(r.model.sealedOwnSeat, s).toBe(true);
            // The new attempt's own facts start over.
            expect(r.model.signaled, s).toBe(false);
            expect(r.model.joined, s).toBe(false);
            expect(r.model.sealedRetries, s).toBe(0);
        }
    });

    it('an attempt whose channel opened, or that never signaled, carries nothing', () => {
        const opened = step(modelIn('V12a', { joined: true, signaled: true, channelOpen: true }), TRY);
        expect(opened.model.state).toBe('V6');
        expect(opened.model.sealedOwnSeat).toBe(false);
        const silent = step(modelIn('V6a', { joined: true }), TRY);
        expect(silent.model.sealedOwnSeat).toBe(false);
        // The first Send of the page carries nothing either.
        const first = step(modelIn('V3'), SEND);
        expect(first.model.sealedOwnSeat).toBe(false);
    });

    it('a retrying attempt that never joined keeps carrying the seal; one that joined does not', () => {
        const unjoined = step(modelIn('V6a', { sealedOwnSeat: true }), TRY);
        expect(unjoined.model.sealedOwnSeat).toBe(true);
        const joined = step(modelIn('V6a', { sealedOwnSeat: true, joined: true }), TRY);
        expect(joined.model.sealedOwnSeat).toBe(false);
    });

    it('V6 + E11 room-full on a sealed seat retries request-join in Connecting', () => {
        const r = step(modelIn('V6', { sealedOwnSeat: true }), FULL(20_000));
        expect(r.model.state).toBe('V6');
        expect(r.effects).toEqual(['clearJoinTimer', 'retryJoin']);
        expect(r.model.sealedRetries).toBe(1);
        // Past the 15 s R2 window, which alone would have ended in V5a.
        expect(step(modelIn('V6'), FULL(20_000)).model.state).toBe('V5a');
    });

    it('the sealed retries are bounded by count and never loop against a room that stays full', () => {
        let m = modelIn('V6', { sealedOwnSeat: true });
        let retries = 0;
        for (let i = 0; i < ROOM_FULL_SEALED_RETRIES * 3; i++) {
            const r = step(m, FULL(1_000));
            m = r.model;
            if (m.state !== 'V6') break;
            expect(r.effects).toEqual(['clearJoinTimer', 'retryJoin']);
            retries++;
        }
        expect(retries).toBe(ROOM_FULL_SEALED_RETRIES);
        expect(m.state).toBe('V5a');
    });

    it('the sealed retries are bounded by time: past the window it is the fixed V5a', () => {
        let since = 1_000;
        let last = step(modelIn('V6', { sealedOwnSeat: true }), FULL(since));
        while (last.model.state === 'V6') {
            since += ROOM_FULL_RETRY_DELAY_MS;
            last = step(last.model, FULL(since));
        }
        expect(last.model.state).toBe('V5a');
        expect(last.effects).toContain('disconnectSocket');
        expect(since).toBeGreaterThan(ROOM_FULL_SEALED_WINDOW_MS);
        const at = (ms: number) => step(modelIn('V6', { sealedOwnSeat: true }), FULL(ms)).model.state;
        expect(at(ROOM_FULL_SEALED_WINDOW_MS)).toBe('V6');
        expect(at(ROOM_FULL_SEALED_WINDOW_MS + 1)).toBe('V5a');
    });

    it('a sealed seat with no previous end, or a clock that went back, is the fixed V5a', () => {
        expect(step(modelIn('V6', { sealedOwnSeat: true }), FULL(null)).model.state).toBe('V5a');
        expect(step(modelIn('V6', { sealedOwnSeat: true }), FULL(-1)).model.state).toBe('V5a');
    });

    it('a room-full on the first join of the page stays the fixed V5a', () => {
        const r = step(modelIn('V3'), SEND);
        const full = step({ ...r.model, joinEmitted: true }, FULL(null));
        expect(full.model.state).toBe('V5a');
    });

    it('once the host reopens, a sealed retry pairs as any join does', () => {
        const retried = step(modelIn('V6', { sealedOwnSeat: true }), FULL(4_000));
        const joined = step(retried.model, { type: 'JOIN_ANSWER', answer: 'request-joined' });
        expect(joined.model.state).toBe('V6');
        expect(joined.model.joined).toBe(true);
        expect(joined.effects).toEqual(['clearJoinTimer', 'armSetupTimer']);
        // After request-joined, room-full is the eviction row R1 as before.
        expect(step(joined.model, FULL(8_000)).model.state).toBe('V6a');
    });

    it("the retry window covers the host's own connect wait", () => {
        // The host waits 30 s for the channel after the answer, then reopens
        // (connectTimeout in cli/engine/peer/connection.go).
        expect(ROOM_FULL_SEALED_WINDOW_MS).toBeGreaterThan(30_000);
        expect(ROOM_FULL_SEALED_RETRIES).toBe(Math.ceil(ROOM_FULL_SEALED_WINDOW_MS / ROOM_FULL_RETRY_DELAY_MS));
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
    it("a new file's ack drops the last file's time left and keeps the link's speed", () => {
        // The sender reports a file's own ETA only after its first second, so
        // until then the line showed the previous file's near-zero time left
        // beside "0 Bytes of" the new one (2026-10-08 QA, D16).
        let m = step(modelIn('V10'), { type: 'PROGRESS', percent: 100, bytesPerSec: 1000, etaSeconds: 1 }).model;
        m = step(m, { type: 'ACK', index: m.ackIndex + 1, now: 1 }).model;
        expect(m.percent).toBe(0);
        expect(m.etaSeconds).toBeNull();
        expect(m.bytesPerSec).toBe(1000);
        m = step(m, { type: 'PROGRESS', percent: 10, etaSeconds: 40 }).model;
        expect(m.etaSeconds).toBe(40);
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
    it('V10 + an unreadable file goes to V11 with the visitor\'s own index (the frozen C-130 mapping)', () => {
        // approved-copy-web.md C-130: "maps to V11 after the first ack". The
        // sender reads a file after its ack, so a file with bytes always
        // lands here.
        const r = step(modelIn('V10', { ackIndex: 2 }), { type: 'UNREADABLE', index: 2 });
        expect(r.model.state).toBe('V11');
        expect(r.model.stop).toBeNull();
        expect(r.model.unreadableIndex).toBe(2);
        expect(r.effects).toContain('disconnectSocket');
    });
    it('V6 + an unreadable file 1 goes to V11 once the send has started (W3 R3-01)', () => {
        // A zero-size file is read before its metadata (344eebb), so file 1 can
        // be reported while the page still shows Connecting.
        const r = step(modelIn('V6', { channelOpen: true, sendStarted: true }), { type: 'UNREADABLE', index: 1 });
        expect(r.model.state).toBe('V11');
        expect(r.model.stop).toBeNull();
        expect(r.model.unreadableIndex).toBe(1);
        expect(r.effects).toContain('disconnectSocket');
        // No send, nothing read: a stray report changes nothing.
        const idle = step(modelIn('V6', { channelOpen: true, sendStarted: false }), { type: 'UNREADABLE', index: 1 });
        expect(idle.model.state).toBe('V6');
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
            const r = step(modelIn(s), { type: 'HASHCHANGE', roomId: '11111111-1111-4111-8111-111111111111', keyChanged: false });
            expect(r.effects).toEqual(['reload']);
        });
    }
    // WP-W1 review F4: the idle states that show Ready or Try again. Ignoring a
    // changed fragment there let the next Send join the OLD room while the
    // address bar showed the new one.
    for (const s of ['V6a', 'V6b', 'V6d', 'V6e', 'V6f', 'V6g', 'V12a', 'V11', 'V11a', 'V11b', 'V12', 'V13'] as VisitorState[]) {
        it(`${s} + E29 (different roomId) reloads`, () => {
            const r = step(modelIn(s), { type: 'HASHCHANGE', roomId: '11111111-1111-4111-8111-111111111111', keyChanged: false });
            expect(r.effects).toEqual(['reload']);
        });
    }
    it('E29 with the same roomId changes nothing', () => {
        expect(step(modelIn('V3'), { type: 'HASHCHANGE', roomId: ROOM, keyChanged: false }).effects).toEqual([]);
    });
    it('E29 in V1 with a link that now parses reloads', () => {
        const v1 = { ...initialModel, state: 'V1' as const };
        expect(step(v1, { type: 'HASHCHANGE', roomId: ROOM, keyChanged: false }).effects).toEqual(['reload']);
    });
    it('E29 never reloads a live attempt', () => {
        for (const s of ['V6', 'V6c', 'V7', 'V10'] as VisitorState[]) {
            expect(step(modelIn(s), { type: 'HASHCHANGE', roomId: null, keyChanged: false }).effects).toEqual([]);
        }
    });
});

describe("visitor state: a discarded tab's reload (FT-R-DISCARD)", () => {
    // Chrome reloads a tab it discarded mid-drop, and the page reads the
    // counts the tab kept (lostRecord.ts) right after the link: Ready, then
    // RESTORE_LOST, before anything else can happen.
    const OTHER_ROOM = '11111111-1111-4111-8111-111111111111';
    const CTX: StatusContext = { pathAt: () => undefined, route: null, now: 0 };
    const ready = () => step(initialModel, { type: 'LINK_OK', roomId: ROOM, keyed: false }).model;
    const EVERY_STATE = EVERY_VISITOR_STATE;

    it('V3 + RESTORE_LOST goes to V12 with the counts and no effects', () => {
        const r = step(ready(), { type: 'RESTORE_LOST', arrived: 1, total: 2 });
        expect(r.model.state).toBe('V12');
        expect(r.model.lost).toBe('discarded');
        expect(r.model.total).toBe(2);
        expect(r.model.ackIndex).toBe(2);
        expect(arrivedCount(r.model)).toBe(1);
        expect(r.model.roomId).toBe(ROOM);
        // Nothing is live and nothing is sent: no attempt, no teardown.
        expect(r.effects).toEqual([]);
        expect(r.model.attempt).toBe(0);
    });

    it('statusCopy gives C-110 and C-111, with no button and no names', () => {
        const lost = step(ready(), { type: 'RESTORE_LOST', arrived: 1, total: 2 }).model;
        expect(statusCopy(lost, CTX)).toMatchObject({
            marker: 'ended',
            title: 'Connection lost',
            lines: ['1 of 2 files arrived. Ask them for a new link to send the other one.'],
            action: null,
        });
        expect(announcement(lost, CTX)).toBe('Connection lost. 1 of 2 files arrived.');
        // Singular when N is 1 (D-123).
        const one = step(ready(), { type: 'RESTORE_LOST', arrived: 0, total: 1 }).model;
        expect(statusCopy(one, CTX)?.lines).toEqual(['0 of 1 file arrived. Ask them for a new link to send it.']);
        expect(announcement(one, CTX)).toBe('Connection lost. 0 of 1 file arrived.');
    });

    it('V6 and V10 ignore RESTORE_LOST, as every state but V3 does', () => {
        for (const s of EVERY_STATE.filter((x) => x !== 'V3')) {
            const before = modelIn(s);
            expect(step(before, { type: 'RESTORE_LOST', arrived: 1, total: 2 }), s).toEqual({
                model: before,
                effects: [],
            });
        }
    });

    it('a pair the Lost card cannot show is ignored', () => {
        const bad: Array<[number, number]> = [[2, 2], [3, 2], [-1, 2], [0, 0], [1.5, 3], [0, MAX_REQUEST_FILES + 1]];
        for (const [arrived, total] of bad) {
            const before = ready();
            expect(step(before, { type: 'RESTORE_LOST', arrived, total }), `${arrived} of ${total}`).toEqual({
                model: before,
                effects: [],
            });
        }
    });

    it('the page keeps a record only in Sending, while the fragment names its room', () => {
        expect(lostRecordOf(modelIn('V10'), ROOM)).toEqual({ arrived: 0, total: 3 });
        expect(lostRecordOf(modelIn('V10', { ackIndex: 3 }), ROOM)).toEqual({ arrived: 2, total: 3 });
        for (const s of EVERY_STATE.filter((x) => x !== 'V10')) {
            expect(lostRecordOf(modelIn(s, { ackIndex: 2 }), ROOM), s).toBeNull();
        }
        // E29 keeps a live drop in the room it joined, and Chrome reloads a
        // discarded tab at the address it shows: another room, or none, gets
        // no record.
        expect(lostRecordOf(modelIn('V10'), OTHER_ROOM)).toBeNull();
        expect(lostRecordOf(modelIn('V10'), null)).toBeNull();
        expect(lostRecordOf(modelIn('V10', { roomId: null }), null)).toBeNull();
    });

    it('the record follows each ack, keeps on a progress tick, and clears on a room change and at the end', () => {
        // The page's syncLost, step by step (review 1 F1): lostRecordOf for the
        // model and the fragment, then lostSyncStep against the key last written.
        let model = modelIn('V10', { ackIndex: 1 });
        let fragment: string | null = ROOM;
        let written: string | null = null;
        const ops: string[] = [];
        const sync = () => {
            const s = lostSyncStep(written, lostRecordOf(model, fragment));
            written = s.written;
            ops.push(s.op === 'write' ? `write ${s.written}` : s.op);
        };
        const on = (event: VisitorEvent) => {
            if (event.type === 'HASHCHANGE') fragment = event.roomId;
            model = step(model, event).model;
            sync();
        };
        sync(); // Sending at the first ack: 0 of 3
        on({ type: 'ACK', index: 2, now: 1 });
        on({ type: 'PROGRESS', percent: 40 });
        on({ type: 'HASHCHANGE', roomId: OTHER_ROOM, keyChanged: false });
        on({ type: 'HASHCHANGE', roomId: ROOM, keyChanged: false });
        on({ type: 'ACK', index: 3, now: 2 });
        on({ type: 'RECEIVED', now: 3 });
        expect(ops).toEqual(['write 0/3', 'write 1/3', 'keep', 'clear', 'write 1/3', 'write 2/3', 'clear']);
    });

    it('every way out of Sending clears the record', () => {
        const endings: VisitorEvent[] = [
            { type: 'RECEIVED', now: 1 },
            { type: 'CANCEL' },
            { type: 'INCOMPATIBLE', refusal: 'over-approved', savedCount: 1, rangeOverlaps: true },
            { type: 'UNREADABLE', index: 2 },
            { type: 'ACK_TIMEOUT', index: 3 },
            { type: 'CHANNEL_CLOSED' },
            { type: 'SEND_SETTLED_SILENT' },
        ];
        for (const ending of endings) {
            const after = step(modelIn('V10', { ackIndex: 2 }), ending).model;
            expect(after.state, ending.type).not.toBe('V10');
            expect(lostSyncStep('1/3', lostRecordOf(after, ROOM)), ending.type).toEqual({ op: 'clear', written: null });
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
            { type: 'LINK_OK', roomId: ROOM, keyed: false },
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
        for (const s of ['V5a', 'V5b', 'V5c', 'V6f', 'V6g', 'V11', 'V11a', 'V11b', 'V12', 'V13'] as VisitorState[]) {
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
            [modelIn('V6'), { type: 'JOIN_ANSWER', answer: 'link-ended' }], // V5d
            [modelIn('V6'), { type: 'JOIN_NO_ANSWER' }], // V5c
            [modelIn('V6'), { type: 'SETUP_TIMEOUT' }], // V6a
            [modelIn('V6'), { type: 'PEER_ERROR' }], // V6a
            [modelIn('V6'), { type: 'SOCKET_LOST' }], // V6a
            [modelIn('V6'), { type: 'SOCKET_CONNECT_TIMEOUT' }], // V6a
            [modelIn('V6', { joined: true }), { type: 'JOIN_ANSWER', answer: 'room-full', sincePreviousAttemptMs: 0 }], // V6a
            [modelIn('V6', { hideIp: true, joinEmitted: false }), { type: 'ICE_READY', hasTurn: false }], // V6b
            [modelIn('V6', { hideIp: true, joinEmitted: false }), { type: 'ICE_READY', hasTurn: false, listRead: false }], // V6e
            [modelIn('V6'), { type: 'CANCEL' }], // V6d
            [modelIn('V7'), { type: 'CANCEL' }], // V6d
            [modelIn('V6', { keyed: true, channelOpen: true }), { type: 'KEY_CHECK_FAILED' }], // V6f
            [modelIn('V6', { keyed: true, channelOpen: true }), { type: 'KEY_CHECK_UNAVAILABLE' }], // V6g
            [modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'unverified', savedCount: 0, rangeOverlaps: true }], // V1
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
            expect(
                r.effects.includes('destroyPeer') || r.effects.includes('sendCancelAbort') || r.effects.includes('sendKeyAbort')
            ).toBe(true);
            reached.add(r.model.state);
        }
        expect([...reached].sort()).toEqual(
            ['V1', 'V4', 'V5a', 'V5b', 'V5c', 'V5d', 'V6a', 'V6b', 'V6d', 'V6e', 'V6f', 'V6g', 'V8a', 'V8b', 'V9', 'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13'].sort()
        );
        expect([...ATTEMPT_ENDING_STATES].sort()).toEqual([...reached].sort());
    });
});

describe('visitor state: the link key', () => {
    // A keyed link's visitor names no file until the host has proved the key, and the
    // model knows that much and no more: a boolean for the link, one for the proof, and
    // one for the relay's answer while it waits. The key itself is the controller's
    // (RequestVisitor.tsx), which is what visitorBoundaries.test.ts holds.
    const PROCEED: VisitorEvent = { type: 'RELAY_VERDICT', action: 'proceed', isRelay: false, routeKnown: true };
    const keyed = (state: VisitorState = 'V6', patch: Partial<VisitorModel> = {}) => modelIn(state, { keyed: true, ...patch });
    const FIRED: VisitorEffect[] = ['sendKeyAbort', 'clearTimers', 'disconnectSocket', 'releaseWakeLock'];
    const OTHER_ROOM = '11111111-1111-4111-8111-111111111111';

    it('(load) + E01 carries whether the link holds a key', () => {
        expect(step(initialModel, { type: 'LINK_OK', roomId: ROOM, keyed: true }).model.keyed).toBe(true);
        expect(step(initialModel, { type: 'LINK_OK', roomId: ROOM, keyed: false }).model.keyed).toBe(false);
        expect(initialModel).toMatchObject({ keyed: false, keyVerified: false, relayProceed: false });
    });

    // Or a keyed visitor silently turns keyless on Send: no wait, no check, and the file
    // goes to whoever answered.
    describe('an attempt keeps the link and starts the proof again', () => {
        const fromReady: VisitorState[] = ['V3', 'V3c', 'V6b', 'V6d', 'V6e'];
        const fromRetry: VisitorState[] = ['V4', 'V5b', 'V5c', 'V8a', 'V8b', 'V9', 'V6a', 'V12a'];
        for (const s of fromReady) {
            it(`${s} + Send keeps keyed`, () => {
                const r = step(keyed(s, { keyVerified: true, relayProceed: true }), SEND);
                expect(r.model.state).toBe('V6');
                expect(r.model).toMatchObject({ keyed: true, keyVerified: false, relayProceed: false, sendStarted: false });
                expect(r.effects).toEqual(['startAttempt']);
            });
        }
        for (const s of [...fromRetry, 'V6d' as const]) {
            it(`${s} + Try again keeps keyed`, () => {
                const r = step(keyed(s, { keyVerified: true, relayProceed: true }), TRY);
                expect(r.model.state).toBe('V6');
                expect(r.model).toMatchObject({ keyed: true, keyVerified: false, relayProceed: false, sendStarted: false });
            });
        }
        it('a keyless attempt stays keyless', () => {
            expect(step(modelIn('V3'), SEND).model.keyed).toBe(false);
            expect(step(modelIn('V4'), TRY).model.keyed).toBe(false);
        });
    });

    describe('sendFiles runs only when the relay verdict and the key check both say go', () => {
        it('CHANNEL_OPEN arms the wait on a keyed visitor with no proof yet', () => {
            const r = step(keyed(), { type: 'CHANNEL_OPEN' });
            expect(r.effects).toEqual(['clearSetupTimer', 'startBadgePoll', 'armProbe', 'armKeyTimer']);
            expect(r.model).toMatchObject({ state: 'V6', channelOpen: true, keyVerified: false });
        });

        it('CHANNEL_OPEN arms no wait once the proof is in: it usually beats connect', () => {
            const r = step(keyed('V6', { keyVerified: true }), { type: 'CHANNEL_OPEN' });
            expect(r.effects).toEqual(['clearSetupTimer', 'startBadgePoll', 'armProbe']);
        });

        it('a bare link arms no wait, as today', () => {
            const r = step(modelIn('V6'), { type: 'CHANNEL_OPEN' });
            expect(r.effects).toEqual(['clearSetupTimer', 'startBadgePoll', 'armProbe']);
        });

        it('the proof ahead of the channel is held, and sends nothing', () => {
            const r = step(keyed(), { type: 'KEY_CHECK_PASSED' });
            expect(r.model).toMatchObject({ state: 'V6', keyVerified: true, sendStarted: false });
            expect(r.effects).not.toContain('sendFiles');
        });

        it('the relay verdict ahead of the proof is held, and sends nothing', () => {
            const r = step(keyed('V6', { channelOpen: true }), PROCEED);
            expect(r.model).toMatchObject({ state: 'V6', relayProceed: true, route: 'direct', sendStarted: false });
            expect(r.effects).toEqual([]);
        });

        it('the proof after the verdict starts the send and ends the wait', () => {
            const r = step(keyed('V6', { channelOpen: true, relayProceed: true }), { type: 'KEY_CHECK_PASSED' });
            expect(r.model).toMatchObject({ state: 'V6', keyVerified: true, sendStarted: true });
            expect(r.effects).toEqual(['clearKeyTimer', 'sendFiles']);
        });

        it('the verdict after the proof starts the send', () => {
            const r = step(keyed('V6', { channelOpen: true, keyVerified: true }), PROCEED);
            expect(r.model).toMatchObject({ state: 'V6', sendStarted: true, route: 'direct' });
            expect(r.effects).toEqual(['sendFiles']);
        });

        it('a bare link proceeds at the verdict, as today', () => {
            const r = step(modelIn('V6', { channelOpen: true }), PROCEED);
            expect(r.model.sendStarted).toBe(true);
            expect(r.effects).toEqual(['sendFiles']);
        });

        // Every order the three can arrive in. The verdict only counts on an open channel,
        // which the probe guarantees (it is armed by CHANNEL_OPEN).
        const orders: VisitorEvent[][] = [
            [{ type: 'KEY_CHECK_PASSED' }, { type: 'CHANNEL_OPEN' }, PROCEED],
            [{ type: 'CHANNEL_OPEN' }, { type: 'KEY_CHECK_PASSED' }, PROCEED],
            [{ type: 'CHANNEL_OPEN' }, PROCEED, { type: 'KEY_CHECK_PASSED' }],
        ];
        for (const order of orders) {
            it(`in the order ${order.map((e) => e.type).join(', ')} it starts exactly once, last`, () => {
                let m = keyed();
                const started: boolean[] = [];
                for (const e of order) {
                    const r = step(m, e);
                    started.push(r.effects.includes('sendFiles'));
                    m = r.model;
                }
                expect(started).toEqual([false, false, true]);
                expect(m.sendStarted).toBe(true);
                // And a repeat of any of them starts nothing more.
                for (const e of order) expect(step(m, e).effects).not.toContain('sendFiles');
            });
        }

        it('the first metadata moves on to Waiting, as today', () => {
            const r = step(keyed('V6', { channelOpen: true, keyVerified: true, sendStarted: true }), {
                type: 'FIRST_METADATA_SENT',
                now: 5,
            });
            expect(r.model.state).toBe('V7');
        });
    });

    describe('a check that failed', () => {
        it('V6 + KEY_CHECK_FAILED goes to V6f: the abort, then every teardown but the destroy it does itself', () => {
            const r = step(keyed('V6', { channelOpen: true }), { type: 'KEY_CHECK_FAILED' });
            expect(r.model.state).toBe('V6f');
            expect(r.effects).toEqual(FIRED);
        });

        it('ahead of the channel too: a bad proof usually beats connect', () => {
            const r = step(keyed(), { type: 'KEY_CHECK_FAILED' });
            expect(r.model.state).toBe('V6f');
            expect(r.effects).toEqual(FIRED);
        });

        it('V6c + KEY_CHECK_FAILED goes to V6f', () => {
            expect(step(keyed('V6c'), { type: 'KEY_CHECK_FAILED' }).model.state).toBe('V6f');
        });

        it('after the relay verdict too, with nothing started', () => {
            const r = step(keyed('V6', { channelOpen: true, relayProceed: true }), { type: 'KEY_CHECK_FAILED' });
            expect(r.model.state).toBe('V6f');
            expect(r.effects).not.toContain('sendFiles');
        });

        it('has no say once the proof stood or the send started, or on a bare link', () => {
            for (const m of [
                keyed('V6', { keyVerified: true, channelOpen: true }),
                keyed('V6', { keyVerified: true, sendStarted: true, channelOpen: true }),
                // Unreachable through the reducer, and held all the same: a started send names a file.
                keyed('V6', { sendStarted: true, channelOpen: true }),
                modelIn('V6', { channelOpen: true }),
                keyed('V7', { keyVerified: true }),
                keyed('V10', { keyVerified: true }),
            ]) {
                expect(step(m, { type: 'KEY_CHECK_FAILED' })).toEqual({ model: m, effects: [] });
            }
        });

        it('is the end of this page: V6f takes no Send, no Try again and nothing late', () => {
            // A retry goes through the same server, so it cannot help (RETRY_FROM).
            const v6f = keyed('V6f');
            const late: VisitorEvent[] = [
                SEND, TRY, { type: 'BACK_TO_FILES' }, { type: 'CANCEL' }, { type: 'CHANNEL_CLOSED' }, { type: 'PEER_ERROR' },
                { type: 'KEY_CHECK_PASSED' }, { type: 'KEY_CHECK_FAILED' }, { type: 'KEY_CHECK_REFUSED' }, PROCEED,
                { type: 'ACK', index: 1, now: 1 }, { type: 'RECEIVED', now: 1 }, { type: 'SETUP_TIMEOUT' },
                { type: 'INCOMPATIBLE', refusal: 'unverified', savedCount: 0, rangeOverlaps: true },
            ];
            for (const e of late) expect(step(v6f, e), e.type).toEqual({ model: v6f, effects: [] });
        });

        it('V6f holds no guard and holds its place: it is an ending, and an announced one', () => {
            expect(ATTEMPT_ENDING_STATES).toContain('V6f');
        });
    });

    // D17: a browser that cannot read the certificates has its own card, because a new link
    // will not help it. Everything else about the ending is V6f's.
    describe('a browser that cannot check', () => {
        it('V6 + KEY_CHECK_UNAVAILABLE goes to V6g: the same abort and teardown as a failed check', () => {
            const r = step(keyed('V6', { channelOpen: true }), { type: 'KEY_CHECK_UNAVAILABLE' });
            expect(r.model.state).toBe('V6g');
            expect(r.effects).toEqual(FIRED);
        });

        it('ahead of the channel, in V6c, and after the relay verdict, with nothing started', () => {
            expect(step(keyed(), { type: 'KEY_CHECK_UNAVAILABLE' }).model.state).toBe('V6g');
            expect(step(keyed('V6c'), { type: 'KEY_CHECK_UNAVAILABLE' }).model.state).toBe('V6g');
            const r = step(keyed('V6', { channelOpen: true, relayProceed: true }), { type: 'KEY_CHECK_UNAVAILABLE' });
            expect(r.model.state).toBe('V6g');
            expect(r.effects).not.toContain('sendFiles');
        });

        it('has no say once the proof stood or the send started, or on a bare link', () => {
            for (const m of [
                keyed('V6', { keyVerified: true, channelOpen: true }),
                keyed('V6', { keyVerified: true, sendStarted: true, channelOpen: true }),
                keyed('V6', { sendStarted: true, channelOpen: true }),
                modelIn('V6', { channelOpen: true }),
                keyed('V7', { keyVerified: true }),
                keyed('V10', { keyVerified: true }),
            ]) {
                expect(step(m, { type: 'KEY_CHECK_UNAVAILABLE' })).toEqual({ model: m, effects: [] });
            }
        });

        it('is the end of this page: V6g takes no Send, no Try again and nothing late', () => {
            const v6g = keyed('V6g');
            const late: VisitorEvent[] = [
                SEND, TRY, { type: 'BACK_TO_FILES' }, { type: 'CANCEL' }, { type: 'CHANNEL_CLOSED' }, { type: 'PEER_ERROR' },
                { type: 'KEY_CHECK_PASSED' }, { type: 'KEY_CHECK_FAILED' }, { type: 'KEY_CHECK_UNAVAILABLE' }, { type: 'KEY_CHECK_REFUSED' }, PROCEED,
                { type: 'ACK', index: 1, now: 1 }, { type: 'RECEIVED', now: 1 }, { type: 'SETUP_TIMEOUT' },
                { type: 'INCOMPATIBLE', refusal: 'unverified', savedCount: 0, rangeOverlaps: true },
            ];
            for (const e of late) expect(step(v6g, e), e.type).toEqual({ model: v6g, effects: [] });
        });

        it('V6g is an ending, as V6f is', () => {
            expect(ATTEMPT_ENDING_STATES).toContain('V6g');
        });

        it('a later verdict does not move V6f to V6g, or back', () => {
            expect(step(keyed('V6f'), { type: 'KEY_CHECK_UNAVAILABLE' }).model.state).toBe('V6f');
            expect(step(keyed('V6g'), { type: 'KEY_CHECK_FAILED' }).model.state).toBe('V6g');
        });
    });

    describe('what the wait leaves as it was', () => {
        it('Cancel in the wait is an ordinary Cancel: the fixed reason, and Ready', () => {
            const r = step(keyed('V6', { channelOpen: true }), { type: 'CANCEL' });
            expect(r.model.state).toBe('V6d');
            expect(r.effects).toEqual(['sendCancelAbort', 'clearTimers', 'disconnectSocket', 'releaseWakeLock']);
        });

        it('the channel going in the wait is an ordinary lost connection, with a Try again', () => {
            const r = step(keyed('V6', { channelOpen: true }), { type: 'CHANNEL_CLOSED' });
            expect(r.model.state).toBe('V6a');
            expect(r.effects).toContain('clearTimers');
        });

        it('a relay block in the wait is V9, as today', () => {
            const r = step(keyed('V6', { channelOpen: true }), {
                type: 'RELAY_VERDICT',
                action: 'block-over-limit',
                isRelay: true,
            });
            expect(r.model.state).toBe('V9');
        });

        it('a bare link hears none of it', () => {
            for (const e of [{ type: 'KEY_CHECK_PASSED' }, { type: 'KEY_CHECK_FAILED' }, { type: 'KEY_CHECK_REFUSED' }] as VisitorEvent[]) {
                const m = modelIn('V6', { channelOpen: true });
                expect(step(m, e), e.type).toEqual({ model: m, effects: [] });
            }
        });

        it('a second proof changes nothing', () => {
            const m = keyed('V6', { keyVerified: true, channelOpen: true });
            expect(step(m, { type: 'KEY_CHECK_PASSED' })).toEqual({ model: m, effects: [] });
        });
    });

    describe('the host refused this page before any file was named', () => {
        it('V6 + KEY_CHECK_REFUSED ends on the refusal card, with nothing saved', () => {
            const r = step(keyed('V6', { channelOpen: true }), { type: 'KEY_CHECK_REFUSED' });
            expect(r.model.state).toBe('V11');
            expect(r.model.stop).toEqual({ refusal: 'unverified', savedCount: 0 });
            expect(r.effects).toEqual(['clearTimers', 'disconnectSocket', 'releaseWakeLock', 'destroyPeer']);
        });

        it('with a proof in hand, and ahead of the channel', () => {
            expect(step(keyed('V6', { keyVerified: true }), { type: 'KEY_CHECK_REFUSED' }).model.state).toBe('V11');
            expect(step(keyed('V6'), { type: 'KEY_CHECK_REFUSED' }).model.state).toBe('V11');
        });

        it('leaves a running send to the send: its report carries the count', () => {
            for (const m of [
                keyed('V6', { keyVerified: true, sendStarted: true, channelOpen: true }),
                keyed('V7', { keyVerified: true }),
                keyed('V10', { keyVerified: true }),
            ]) {
                expect(step(m, { type: 'KEY_CHECK_REFUSED' })).toEqual({ model: m, effects: [] });
            }
        });
    });

    describe('a host that refuses as unverified', () => {
        const UNVERIFIED: VisitorEvent = { type: 'INCOMPATIBLE', refusal: 'unverified', savedCount: 5, rangeOverlaps: true };

        it('a visitor with no key has a link that was cut: V1, the existing card', () => {
            const running = modelIn('V6', { channelOpen: true, sendStarted: true });
            for (const m of [running, modelIn('V7')]) {
                const r = step(m, UNVERIFIED);
                expect(r.model.state, m.state).toBe('V1');
                expect(r.effects).toEqual(['clearTimers', 'disconnectSocket', 'releaseWakeLock', 'destroyPeer']);
            }
            expect(ATTEMPT_ENDING_STATES).toContain('V1');
        });

        it('a visitor that holds a key gets the row of its own, with nothing saved before accept', () => {
            const running = keyed('V6', { keyVerified: true, channelOpen: true, sendStarted: true });
            for (const m of [running, keyed('V7', { keyVerified: true })]) {
                const r = step(m, UNVERIFIED);
                expect(r.model.state, m.state).toBe('V11');
                expect(r.model.stop).toEqual({ refusal: 'unverified', savedCount: 0 });
            }
        });

        it('past the first ack it is a stop like any other, with the count it carried', () => {
            for (const m of [keyed('V10', { keyVerified: true }), modelIn('V10')]) {
                const r = step(m, UNVERIFIED);
                expect(r.model.state).toBe('V11');
                expect(r.model.stop).toEqual({ refusal: 'unverified', savedCount: 3 });
            }
        });

        it('a version range miss is read first, as it is for every code', () => {
            expect(step(modelIn('V7'), { ...UNVERIFIED, rangeOverlaps: false } as VisitorEvent).model.state).toBe('V11b');
        });

        it('every other code reads as it did on a visitor with no key', () => {
            const r = step(modelIn('V7'), { type: 'INCOMPATIBLE', refusal: 'disk-full', savedCount: 0, rangeOverlaps: true });
            expect(r.model.state).toBe('V11');
        });

        it('V1 reached this way is the end of the page, as V1 at load is', () => {
            const v1 = step(modelIn('V7'), UNVERIFIED).model;
            expect(step(v1, TRY)).toEqual({ model: v1, effects: [] });
            expect(step(v1, SEND)).toEqual({ model: v1, effects: [] });
            // The whole link pasted into this tab: the same room, and now a key.
            expect(step(v1, { type: 'HASHCHANGE', roomId: ROOM, keyChanged: true }).effects).toEqual(['reload']);
        });
    });

    describe('E29: a fragment whose key alone changed', () => {
        const idle: VisitorState[] = [
            'V1', 'V2', 'V3', 'V3c', 'V4', 'V5a', 'V5b', 'V5c', 'V5d', 'V6a', 'V6b', 'V6d', 'V6e', 'V6f', 'V6g',
            'V8a', 'V8b', 'V9', 'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13',
        ];
        for (const s of idle) {
            it(`${s}: reloads like a changed room`, () => {
                expect(step(modelIn(s), { type: 'HASHCHANGE', roomId: ROOM, keyChanged: true }).effects).toEqual(['reload']);
            });
        }
        it('the same room and the same key change nothing', () => {
            expect(step(modelIn('V3'), { type: 'HASHCHANGE', roomId: ROOM, keyChanged: false }).effects).toEqual([]);
        });
        it('another room still reloads, whatever the key did', () => {
            expect(step(modelIn('V3'), { type: 'HASHCHANGE', roomId: OTHER_ROOM, keyChanged: false }).effects).toEqual(['reload']);
        });
        it('a live attempt stays in the link it joined', () => {
            for (const s of ['V6', 'V6c', 'V7', 'V10'] as VisitorState[]) {
                expect(step(modelIn(s), { type: 'HASHCHANGE', roomId: ROOM, keyChanged: true }).effects, s).toEqual([]);
            }
        });
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

describe('visitor state: a route the probe could not read (owner answer 27)', () => {
    const open = () => modelIn('V6', { joinEmitted: true, joined: true, channelOpen: true });

    it('stays unknown, so the Arrived line names none', () => {
        const r = step(open(), { type: 'RELAY_VERDICT', action: 'proceed', isRelay: false, routeKnown: false });
        expect(r.model.route).toBeNull();
        expect(r.model.sendStarted).toBe(true);
    });

    it('keeps a route the probe read', () => {
        expect(step(open(), { type: 'RELAY_VERDICT', action: 'proceed', isRelay: false, routeKnown: true }).model.route).toBe('direct');
        expect(step(open(), { type: 'RELAY_VERDICT', action: 'proceed', isRelay: true, routeKnown: true }).model.route).toBe('relay');
    });
});
