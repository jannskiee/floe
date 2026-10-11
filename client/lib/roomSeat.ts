// What a receiver page knows about the room it joined, and when it should
// give its seat back.
//
// The signaling server seats by join order: the first peer into a room is
// named "sender" and is the one told when a second arrives (user-connected),
// and the sender page is the only one that reacts to that by making the WebRTC
// offer. Two things followed that no receiver page handled:
//
//   - A link nobody holds (the sender closed their page, or the link is old)
//     put the receiver page in the first seat, named "sender", and it waited
//     on "Waiting for the sender to start" forever.
//   - A sender whose signaling dropped during the handshake came back into the
//     SECOND seat, behind the receiver, so the arrival was announced to the
//     receiver page, which ignored it. Both pages then waited forever.
//
// The page cannot ask for a seat, but a join from a seated socket leaves
// first, telling nobody, and then takes the next free seat. So a receiver that
// is alone when a peer arrives re-joins: the newcomer becomes the first seat,
// this page the second, and the newcomer is told someone arrived.
//
// It yields ONCE per time the server says it is alone. Two receiver pages on a
// dead link would otherwise trade seats forever: each re-join is the other
// page's arrival. The other page's silent leave sends no "alone" notice, so a
// page that has yielded stays disarmed until the server says so again.
//
// Pure, and outside P2PTransfer.tsx, for the same reason receiverClose.ts and
// peerDisconnect.ts are: nothing in the suite mounts the component.

export interface SeatState {
    /** The last thing the server said leaves this page alone in the room. */
    alone: boolean;
    /** What the page shows: nobody is on the sending side right now. */
    senderAbsent: boolean;
}

export const INITIAL_SEAT: SeatState = { alone: false, senderAbsent: false };

export type SeatEvent =
    /** room-joined, with the role the server named. */
    | { type: 'joined'; role: string }
    /** peer-disconnected, when it tore the peer down (the channel was not open). */
    | { type: 'peer-left' }
    /** The first WebRTC signal from the other side: only a sender offers. */
    | { type: 'offer' }
    /** user-connected: a second peer took the seat behind this page. */
    | { type: 'peer-arrived'; connected: boolean; hasFile: boolean };

export interface SeatStep {
    state: SeatState;
    /** Re-join the room now, so the peer that arrived holds the first seat. */
    yieldSeat: boolean;
}

export function seatStep(state: SeatState, event: SeatEvent): SeatStep {
    switch (event.type) {
        case 'joined':
            // Only the literal name: any other answer means a peer was there.
            if (event.role === 'sender') return { state: { alone: true, senderAbsent: true }, yieldSeat: false };
            // Not proof of a sender. After a yield the peer in front may be
            // another receiver page, so what is shown waits for an offer.
            return { state: { alone: false, senderAbsent: state.senderAbsent }, yieldSeat: false };
        case 'peer-left':
            return { state: { alone: true, senderAbsent: true }, yieldSeat: false };
        case 'offer':
            return { state: { alone: state.alone, senderAbsent: false }, yieldSeat: false };
        case 'peer-arrived':
            // Never once the data channel is open or a file has landed: the
            // signaling is done, and a late joiner must not tear that down.
            if (!state.alone || event.connected || event.hasFile) return { state, yieldSeat: false };
            return { state: { alone: false, senderAbsent: state.senderAbsent }, yieldSeat: true };
    }
}
