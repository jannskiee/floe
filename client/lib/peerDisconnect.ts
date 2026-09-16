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
 * Before that, the negotiation cannot finish without signaling, and the other
 * side re-offers after it rejoins, so today's teardown stays.
 */
export function peerDisconnectAction(inputs: PeerDisconnectInputs): PeerDisconnectAction {
    return inputs.hasPeer && inputs.peerConnected ? 'ignore' : 'teardown';
}
