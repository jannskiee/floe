// What to do when the server says the other side left the room.
//
// Pure, and outside P2PTransfer.tsx, for the same reason receiverClose.ts is:
// nothing in the suite mounts the component, and this branch is the one that
// was wrong. The server sends `peer-disconnected` whenever the other side's
// signaling socket goes away (a Socket.IO blip, a proxy idle reap, a CLI's /ws
// closing), which says nothing about the WebRTC connection. The handler used to
// destroy the peer unconditionally, so a signaling hiccup on the far side ended
// a healthy transfer mid-file.
//
// The caller owns every side effect (destroy, status, wake lock, Sentry).

export type PeerDisconnectAction = 'ignore' | 'teardown';

export interface PeerDisconnectInputs {
    /** A peer instance exists on this side. */
    hasPeer: boolean;
    /**
     * simple-peer's `connected`: true only while the data channel is open. It
     * reads false again once the peer is destroyed.
     */
    peerConnected: boolean;
}

/**
 * Decides whether a `peer-disconnected` notice may tear the peer down.
 *
 * Once the data channel is open, signaling has done its job and the notice is
 * ignored. A peer that really died is still ended by WebRTC itself (an ICE
 * failure or a channel close surfaces as simple-peer `close` or `error`).
 * Before that, the negotiation cannot finish without signaling, so today's
 * teardown stays. A sender re-offers after its receiver rejoins. The other
 * order needs help: a sender that rejoins lands in the seat behind a waiting
 * receiver and is never told to offer, so the receiver gives the first seat
 * back (lib/roomSeat.ts).
 */
export function peerDisconnectAction(inputs: PeerDisconnectInputs): PeerDisconnectAction {
    return inputs.hasPeer && inputs.peerConnected ? 'ignore' : 'teardown';
}

/**
 * Whether the teardown may mark the peer as closed by this side, which keeps
 * the close that follows quiet.
 *
 * The quiet close is for a peer that is torn down to be rebuilt: still
 * negotiating, nothing received. Two cases must stay loud, because the close
 * handler is what tells a receiver its transfer is over:
 *
 * - A peer that has already closed. Its close handler defers its answer while
 *   a file's SHA-256 is checked, and the server's notice can land in between.
 *   Claiming the dead peer then turned that answer silent: a receive that had
 *   ended short stayed on "Waiting for the rest", with the connected
 *   badge, for as long as the page was open.
 * - A receiver that already holds a file. It does not rejoin, so nothing is
 *   rebuilt, and the same handler has to report how far the receive got. It
 *   does so after any pending check, which is why the teardown does not report
 *   it itself: saying "ended" while the last file was still being checked would
 *   show a complete transfer as cut short for as long as the check took.
 */
export function teardownClaimsClose(inputs: { hasPeer: boolean; peerDestroyed: boolean; receivedCount: number }): boolean {
    return inputs.hasPeer && !inputs.peerDestroyed && inputs.receivedCount === 0;
}
