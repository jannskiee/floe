import { describe, it, expect } from 'vitest';
import { INITIAL_SEAT, MAX_SEAT_YIELDS, seatStep, type SeatEvent, type SeatState } from './roomSeat';

const waiting = { connected: false, hasFile: false };

function run(events: SeatEvent[], from: SeatState = INITIAL_SEAT) {
    let state = from;
    const yields: boolean[] = [];
    for (const event of events) {
        const step = seatStep(state, event);
        state = step.state;
        yields.push(step.yieldSeat);
    }
    return { state, yields };
}

describe('seatStep: what the server said', () => {
    it('starts with a sender assumed present', () => {
        expect(INITIAL_SEAT).toEqual({ alone: false, senderAbsent: false, yields: 0 });
    });

    it('being handed the sender role means nobody is sending', () => {
        // The first peer into a room is called "sender" whoever it is, and a
        // receiver page that gets the name opened a link nobody holds.
        expect(run([{ type: 'joined', role: 'sender' }]).state).toEqual({ alone: true, senderAbsent: true, yields: 0 });
    });

    it('the receiver role means someone was already there', () => {
        expect(run([{ type: 'joined', role: 'receiver' }]).state).toEqual({ alone: false, senderAbsent: false, yields: 0 });
    });

    it('only the literal role sender arms', () => {
        for (const role of ['receiver', 'host', 'visitor', 'Sender', '', 'SENDER']) {
            expect(run([{ type: 'joined', role }]).state.alone).toBe(false);
        }
    });

    it('the other side leaving before the connection is up leaves this page alone', () => {
        const { state } = run([{ type: 'joined', role: 'receiver' }, { type: 'peer-left' }]);
        expect(state).toEqual({ alone: true, senderAbsent: true, yields: 0 });
    });

    it('an offer means a sender is there', () => {
        const { state } = run([{ type: 'joined', role: 'sender' }, { type: 'offer' }]);
        expect(state.senderAbsent).toBe(false);
    });

    it('never reports a yield for anything but an arrival', () => {
        const { yields } = run([
            { type: 'joined', role: 'sender' },
            { type: 'peer-left' },
            { type: 'offer' },
            { type: 'joined', role: 'receiver' },
        ]);
        expect(yields).toEqual([false, false, false, false]);
    });
});

describe('seatStep: an arrival', () => {
    it('behind a receiver that is alone yields the seat, once', () => {
        const alone = run([{ type: 'joined', role: 'sender' }]).state;
        const first = seatStep(alone, { type: 'peer-arrived', ...waiting });
        expect(first.yieldSeat).toBe(true);
        expect(first.state.alone).toBe(false);
        // Still shown as absent: the arrival may be another receiver page, and
        // only an offer says a sender is really there.
        expect(first.state.senderAbsent).toBe(true);
        // A second notice with nothing in between does not yield again.
        expect(seatStep(first.state, { type: 'peer-arrived', ...waiting }).yieldSeat).toBe(false);
    });

    it('behind a receiver that was not alone changes nothing', () => {
        const seated = run([{ type: 'joined', role: 'receiver' }]).state;
        const step = seatStep(seated, { type: 'peer-arrived', ...waiting });
        expect(step).toEqual({ state: seated, yieldSeat: false });
    });

    it('never yields once the channel is open or a file has landed', () => {
        const alone = run([{ type: 'joined', role: 'receiver' }, { type: 'peer-left' }]).state;
        for (const guard of [
            { connected: true, hasFile: false },
            { connected: false, hasFile: true },
            { connected: true, hasFile: true },
        ]) {
            const step = seatStep(alone, { type: 'peer-arrived', ...guard });
            expect(step.yieldSeat).toBe(false);
            expect(step.state).toEqual(alone);
        }
    });

    it('yields again after the server says this page is alone again', () => {
        const { yields } = run([
            { type: 'joined', role: 'sender' },
            { type: 'peer-arrived', ...waiting },
            { type: 'joined', role: 'receiver' },
            { type: 'peer-left' },
            { type: 'peer-arrived', ...waiting },
        ]);
        expect(yields).toEqual([false, true, false, false, true]);
    });

    // The server says 'alone' on the word of whoever else holds the link: a
    // peer that joins and then joins another room leaves silently, and this
    // page is seated first again and re-armed. Without a budget that peer
    // could make this page tear down and rebuild its connection once per
    // round trip for as long as it liked, at no cost to itself.
    it('stops yielding after a fixed number of times in one page load', () => {
        let state = INITIAL_SEAT;
        let yielded = 0;
        for (let i = 0; i < MAX_SEAT_YIELDS + 10; i++) {
            state = seatStep(state, { type: 'joined', role: 'sender' }).state;
            const step = seatStep(state, { type: 'peer-arrived', ...waiting });
            state = step.state;
            if (step.yieldSeat) yielded += 1;
        }
        expect(yielded).toBe(MAX_SEAT_YIELDS);
        expect(MAX_SEAT_YIELDS).toBe(5);
        // Out of budget, the page is back to what it did before it could
        // yield at all: it keeps its seat and still says nobody is sending.
        expect(state.senderAbsent).toBe(true);
    });

    it('counts a yield only when one happens', () => {
        const { state } = run([
            { type: 'joined', role: 'sender' },
            { type: 'peer-arrived', ...waiting },
            { type: 'peer-arrived', ...waiting },
            { type: 'offer' },
            { type: 'joined', role: 'receiver' },
        ]);
        expect(state.yields).toBe(1);
    });
});

/**
 * The signaling server's seating, as server/server.js handleJoinRoom and
 * handleDisconnect do it: seats by join order, a join from a seated socket
 * leaves first and tells nobody, the second joiner's arrival is announced to
 * the first seat, and a disconnect tells whoever is left.
 *
 * Two receiver pages on a link nobody holds is the case the obvious fix gets
 * wrong: if a page gave its seat up on every arrival, each rejoin would be the
 * other page's arrival, forever, at round-trip speed.
 */
function model() {
    const room: string[] = [];
    const pages = new Map<string, SeatState>();
    const inbox: Array<[string, SeatEvent]> = [];
    let yields = 0;

    const join = (id: string) => {
        const seated = room.indexOf(id);
        if (seated >= 0) room.splice(seated, 1); // leave first, silently
        if (room.length === 0) {
            room.push(id);
            inbox.push([id, { type: 'joined', role: 'sender' }]);
        } else if (room.length === 1) {
            room.push(id);
            inbox.push([id, { type: 'joined', role: 'receiver' }]);
            inbox.push([room[0], { type: 'peer-arrived', ...waiting }]);
        }
    };
    const leave = (id: string) => {
        const seated = room.indexOf(id);
        if (seated < 0) return;
        room.splice(seated, 1);
        pages.delete(id);
        if (room.length === 1) inbox.push([room[0], { type: 'peer-left' }]);
    };
    /** A receiver page: it runs the reducer. */
    const open = (id: string) => {
        pages.set(id, INITIAL_SEAT);
        join(id);
    };
    /** A sender page: it joins, and its messages are not this module's to handle. */
    const openSender = (id: string) => join(id);
    /** Delivers every queued message; fails the test if the pages never settle. */
    const settle = () => {
        for (let steps = 0; inbox.length > 0; steps++) {
            if (steps > 50) throw new Error('the pages never settle');
            const [id, event] = inbox.shift()!;
            const state = pages.get(id);
            if (!state) continue; // a page that left
            const step = seatStep(state, event);
            pages.set(id, step.state);
            if (step.yieldSeat) {
                yields += 1;
                join(id);
            }
        }
    };
    return { open, openSender, leave, settle, room, pages, yields: () => yields };
}

describe('seatStep against the server seating rules', () => {
    it('two receiver pages on a dead link trade seats once and stop', () => {
        const m = model();
        m.open('a');
        m.settle();
        m.open('b');
        m.settle();
        expect(m.yields()).toBe(1);
        expect(m.room).toEqual(['b', 'a']);
        // The page that was alone knows nobody is sending. The second opener
        // was told "receiver" and cannot know: the known gap.
        expect(m.pages.get('a')!.senderAbsent).toBe(true);
        expect(m.pages.get('b')!.senderAbsent).toBe(false);
    });

    it('a page that reconnects under a new socket costs one more trade, not a loop', () => {
        const m = model();
        m.open('a');
        m.open('b');
        m.settle();
        // Page b drops and comes back as a new socket.
        m.leave('b');
        m.settle();
        m.open('b2');
        m.settle();
        expect(m.yields()).toBe(2);
        expect(m.room).toHaveLength(2);
    });

    it('a sender that comes back behind a waiting receiver gets the first seat', () => {
        const m = model();
        m.openSender('sender');
        m.open('receiver');
        m.settle();
        expect(m.yields()).toBe(0);
        // The sender's socket drops during the handshake and returns.
        m.leave('sender');
        m.settle();
        expect(m.pages.get('receiver')).toEqual({ alone: true, senderAbsent: true, yields: 0 });
        m.openSender('sender2');
        m.settle();
        // The receiver gave the first seat back, so the arrival that follows
        // is announced to the sender, which is the page that offers.
        expect(m.yields()).toBe(1);
        expect(m.room).toEqual(['sender2', 'receiver']);
    });
});
