import { describe, it, expect } from 'vitest';
import { classifyPeerError } from './peerErrors';

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
