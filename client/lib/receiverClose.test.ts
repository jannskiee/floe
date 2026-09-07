import { describe, it, expect } from 'vitest';
import { decideReceiverClose, RECEIVER_CLOSED_EARLY } from './receiverClose';

const base = { closedByUs: false, replaced: false, wireReason: false, receivedCount: 0 };

describe('decideReceiverClose', () => {
    it('reports a failure when the sender walks away with nothing delivered', () => {
        // The reported bug: this used to be silent, so the connected badge and
        // the previous status line stayed on screen.
        expect(decideReceiverClose(base)).toEqual({ kind: 'failed', error: RECEIVER_CLOSED_EARLY });
    });

    it('stays quiet for a teardown this side asked for', () => {
        expect(decideReceiverClose({ ...base, closedByUs: true })).toEqual({ kind: 'silent' });
    });

    it('stays quiet when a replacement peer is already in place', () => {
        // The Socket.IO rejoin path destroys the receiver's peer and builds a
        // new one. Reporting the old peer's close would pin a permanent failure
        // on a transfer that is fine, which a shared boolean latch could not
        // prevent because the replacement clears it while the close is still in
        // flight.
        expect(decideReceiverClose({ ...base, replaced: true })).toEqual({ kind: 'silent' });
    });

    it('stays quiet when the peer already said why', () => {
        // peer.destroy() raises "User-Initiated Abort" on this side a moment
        // later; the reason has to win.
        expect(decideReceiverClose({ ...base, wireReason: true })).toEqual({ kind: 'silent' });
    });

    it('reports the outcome, not a failure, once any file has landed', () => {
        // Reachability is the point. Gating this on a transferComplete ref made
        // it dead code, because that ref is set by the FIRST completed file and
        // never cleared.
        expect(decideReceiverClose({ ...base, receivedCount: 1 })).toEqual({ kind: 'outcome' });
        expect(decideReceiverClose({ ...base, receivedCount: 3 })).toEqual({ kind: 'outcome' });
    });

    it('lets an explanation win over a delivered-files outcome', () => {
        expect(decideReceiverClose({ ...base, receivedCount: 2, wireReason: true })).toEqual({ kind: 'silent' });
        expect(decideReceiverClose({ ...base, receivedCount: 2, closedByUs: true })).toEqual({ kind: 'silent' });
    });

    it('never returns an empty error string', () => {
        const d = decideReceiverClose(base);
        expect(d.kind).toBe('failed');
        if (d.kind === 'failed') expect(d.error.length).toBeGreaterThan(0);
    });
});
