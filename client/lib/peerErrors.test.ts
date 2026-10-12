import { describe, it, expect } from 'vitest';
import { classifyPeerError, senderErrorBlamesRelay } from './peerErrors';

describe('classifyPeerError', () => {
    describe('receiver (relayEnabled defaulted to true)', () => {
        it('treats an ICE failure as expected', () => {
            expect(classifyPeerError('Ice connection failed.')).toEqual({
                isExpected: true,
                reason: 'ice-failed',
            });
        });

        it('treats a generic connection failure as expected', () => {
            expect(classifyPeerError('Connection failed.')).toEqual({
                isExpected: true,
                reason: 'conn-failed',
            });
        });

        it('treats a user-initiated abort (substring match) as expected', () => {
            expect(classifyPeerError('Error: User-Initiated Abort, reason=x')).toEqual({
                isExpected: true,
                reason: 'abort',
            });
        });

        it('treats any other message as an unexpected bug', () => {
            expect(classifyPeerError('RTCDataChannel send queue full')).toEqual({
                isExpected: false,
                reason: 'unknown',
            });
        });

        it('treats an undefined message as unexpected', () => {
            expect(classifyPeerError(undefined)).toEqual({
                isExpected: false,
                reason: 'unknown',
            });
        });

        it('never reports relay-disabled when relay is not a concern', () => {
            expect(classifyPeerError('Ice connection failed.', { relayEnabled: true }).reason).toBe(
                'ice-failed'
            );
        });
    });

    describe('sender with relay forced off', () => {
        it('marks every error expected and attributes it to relay-disabled', () => {
            expect(classifyPeerError('Ice connection failed.', { relayEnabled: false })).toEqual({
                isExpected: true,
                reason: 'relay-disabled',
            });
        });

        it('attributes even an otherwise-unknown error to relay-disabled', () => {
            expect(classifyPeerError('weird internal error', { relayEnabled: false })).toEqual({
                isExpected: true,
                reason: 'relay-disabled',
            });
        });
    });

    describe('sender with relay enabled', () => {
        it('classifies like the receiver does', () => {
            expect(classifyPeerError('Connection failed.', { relayEnabled: true })).toEqual({
                isExpected: true,
                reason: 'conn-failed',
            });
        });

        it('captures an unexpected error', () => {
            expect(classifyPeerError('boom', { relayEnabled: true })).toEqual({
                isExpected: false,
                reason: 'unknown',
            });
        });
    });
});

describe('senderErrorBlamesRelay', () => {
    it('blames the relay setting for a failure to connect with the box unchecked', () => {
        expect(senderErrorBlamesRelay('Ice connection failed.', false)).toBe(true);
        expect(senderErrorBlamesRelay('Connection failed.', false)).toBe(true);
        expect(senderErrorBlamesRelay('something else went wrong', false)).toBe(true);
        expect(senderErrorBlamesRelay(undefined, false)).toBe(true);
    });

    // With the box unchecked every early error took the relay sentence, and
    // that sentence now tells the sender to reload and make a new link. A
    // recipient who closed their tab during the handshake ends in an abort,
    // and for them the link still works.
    it('does not blame it when the other side simply left', () => {
        expect(senderErrorBlamesRelay('User-Initiated Abort, reason=Close called', false)).toBe(false);
    });

    it('never blames it while the box is checked', () => {
        expect(senderErrorBlamesRelay('Ice connection failed.', true)).toBe(false);
        expect(senderErrorBlamesRelay('User-Initiated Abort, reason=Close called', true)).toBe(false);
    });
});
