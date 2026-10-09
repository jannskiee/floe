import { describe, it, expect } from 'vitest';
import { peerDisconnectAction } from './peerDisconnect';

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
