import { describe, it, expect } from 'vitest';
import { peerDisconnectAction, teardownClaimsClose } from './peerDisconnect';

describe('peerDisconnectAction', () => {
    it('ignores the notice while the peer is connected', () => {
        // The reported bug: a blip on the far side's signaling socket destroyed
        // a healthy peer mid-transfer.
        expect(peerDisconnectAction({ hasPeer: true, peerConnected: true })).toBe('ignore');
    });

    it('tears down before the peer connects', () => {
        // Still negotiating: the offer and answer need signaling, and the other
        // side re-offers after it rejoins.
        expect(peerDisconnectAction({ hasPeer: true, peerConnected: false })).toBe('teardown');
    });

    it('tears down when there is no peer', () => {
        // A sender still waiting for a receiver has no peer yet. A connected
        // flag without a peer is not a reason to keep anything.
        expect(peerDisconnectAction({ hasPeer: false, peerConnected: false })).toBe('teardown');
        expect(peerDisconnectAction({ hasPeer: false, peerConnected: true })).toBe('teardown');
    });

    it('tears down a peer that is not yet connected', () => {
        // Only an open data channel keeps the peer: every input without one
        // takes the teardown path, with or without a peer instance.
        for (const hasPeer of [true, false]) {
            expect(peerDisconnectAction({ hasPeer, peerConnected: false })).toBe('teardown');
        }
    });
});

describe('teardownClaimsClose', () => {
    it('claims a half-negotiated peer, so the close that rebuilds it stays quiet', () => {
        expect(teardownClaimsClose({ hasPeer: true, peerDestroyed: false, receivedCount: 0 })).toBe(true);
    });

    it('does not claim a peer that has already closed', () => {
        // The sender vanished while this side was still checking a file's
        // SHA-256. The peer's close handler waits for that check before it
        // says how the receive ended, and the server's notice arrives in
        // between. Claiming the dead peer here turned that answer silent: a
        // receive of 2 of 3 files stayed on "Waiting for the rest", with
        // the connected badge, for as long as the page was open.
        expect(teardownClaimsClose({ hasPeer: true, peerDestroyed: true, receivedCount: 0 })).toBe(false);
        expect(teardownClaimsClose({ hasPeer: true, peerDestroyed: true, receivedCount: 2 })).toBe(false);
    });

    it('does not claim the close of a receiver that already holds a file', () => {
        // It will not rejoin, so nothing is being rebuilt, and the close
        // handler is the one place that reports how far the receive got.
        expect(teardownClaimsClose({ hasPeer: true, peerDestroyed: false, receivedCount: 1 })).toBe(false);
    });

    it('claims nothing when there is no peer', () => {
        expect(teardownClaimsClose({ hasPeer: false, peerDestroyed: false, receivedCount: 0 })).toBe(false);
        expect(teardownClaimsClose({ hasPeer: false, peerDestroyed: true, receivedCount: 0 })).toBe(false);
    });
});
