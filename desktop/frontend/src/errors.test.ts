import {describe, expect, it} from 'vitest';
import {friendlyError} from './errors';

describe('friendlyError', () => {
    it('always starts with the Error prefix StatusLine keys its styling off', () => {
        const samples = [
            'transfer failed: connection closed mid-transfer: a.bin (10 of 20 bytes)',
            'anything unknown at all',
            'relay connections are capped at 2 GB (selected relay)',
        ];
        for (const s of samples) {
            expect(friendlyError(s).startsWith('Error: ')).toBe(true);
        }
    });

    it('maps a wrapped engine error through the backend prefixes', () => {
        expect(friendlyError('transfer failed: error sending a.bin: failed to send chunk: x')).toBe(
            'Error: The connection was lost before the transfer finished. Start it again.',
        );
    });

    it('maps the backpressure stall to the connection-lost sentence', () => {
        expect(friendlyError('backpressure stall: peer not draining (8388608 bytes buffered)')).toBe(
            'Error: The connection was lost before the transfer finished. Start it again.',
        );
    });

    it('keeps the specific closed-before-any-file diagnosis out of the generic bucket', () => {
        expect(
            friendlyError('connection closed before any file arrived (the sender cancelled, or the transfer was blocked)'),
        ).toBe('Error: The sender cancelled, or the transfer was blocked before it started.');
    });

    it('keeps the receiver-left diagnosis out of the generic bucket', () => {
        expect(
            friendlyError('transfer failed: connection closed while waiting for the receiver (transfer declined or receiver exited)'),
        ).toBe('Error: The receiver left or declined before the transfer started.');
    });

    it('routes a wrapped network failure to the server bucket, not the typo bucket', () => {
        expect(friendlyError('could not resolve "olive-tiger": could not reach signaling server: dial tcp: refused')).toBe(
            'Error: Could not reach the server. Check your internet connection.',
        );
    });

    it('maps a malformed room id in a pasted link to the incomplete-link sentence', () => {
        expect(friendlyError('server error: Invalid room ID')).toBe(
            'Error: That link looks incomplete. Copy the whole share link and try again.',
        );
    });

    it('treats a server rejection as a rejection, not a connectivity problem', () => {
        expect(friendlyError('server error: too many requests')).toBe(
            'Error: The server rejected the request. Try again in a minute.',
        );
    });

    it('maps stall, timeout, server, and write-error buckets', () => {
        expect(friendlyError('transfer stalled: no data for 1m0s (5 of 10 bytes of "a")')).toBe(
            'Error: The transfer stalled and gave up. Start it again.',
        );
        expect(friendlyError('timed out establishing a connection')).toBe(
            'Error: A connection could not be established. Check that both devices are online and try again.',
        );
        expect(friendlyError('failed to connect to signaling server: dial tcp: refused')).toBe(
            'Error: Could not reach the server. Check your internet connection.',
        );
        expect(friendlyError('write error: disk full')).toBe(
            'Error: Could not write to the save folder. Check that it exists and has free space.',
        );
        expect(friendlyError('could not resolve "olive-tiger": 404')).toBe(
            'Error: That code was not recognized. Check it for typos, or ask the sender for a new one.',
        );
    });

    it('passes hand-written actionable messages through verbatim', () => {
        const relay = 'transfer blocked: relay connections are capped at 2 GB (selected relay). Turn off Hide my IP to send larger files';
        expect(friendlyError(relay)).toBe('Error: ' + relay);
        const code = 'this code is no longer active; ask for a new one';
        expect(friendlyError(code)).toBe('Error: ' + code);
    });

    it('passes unknown errors through unchanged for bug reports', () => {
        expect(friendlyError('some novel failure nobody mapped')).toBe('Error: some novel failure nobody mapped');
    });

    it('does not double the prefix when the input already carries one', () => {
        expect(friendlyError('Error: some novel failure')).toBe('Error: some novel failure');
    });
});
