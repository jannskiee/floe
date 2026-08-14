import { describe, it, expect } from 'vitest';
import { verifyCode, extractFingerprint } from './verify';

describe('verifyCode', () => {
    it('matches the Go engine canonical vector (cli/engine/verify TestCodeKnownVector)', async () => {
        // If this changes, update knownVector in verify_test.go too.
        expect(await verifyCode('sha-256 AA:BB:CC:DD', 'sha-256 11:22:33:44')).toBe('1337 5359');
    });

    it('is order-independent', async () => {
        const a = 'sha-256 AB:CD:EF:00';
        const b = 'sha-256 99:88:77:66';
        expect(await verifyCode(a, b)).toBe(await verifyCode(b, a));
    });

    it('is case-insensitive', async () => {
        const a = 'sha-256 AB:CD:EF:00';
        const b = 'sha-256 99:88:77:66';
        expect(await verifyCode(a.toLowerCase(), b)).toBe(await verifyCode(a, b));
    });

    it('changes if a fingerprint is swapped (MITM detection)', async () => {
        const a = 'sha-256 AB:CD:EF';
        const b = 'sha-256 99:88:77';
        const mitm = 'sha-256 DE:AD:BE';
        expect(await verifyCode(a, mitm)).not.toBe(await verifyCode(mitm, b));
    });
});

describe('extractFingerprint', () => {
    it('pulls the fingerprint line from an SDP', () => {
        const sdp = 'v=0\r\na=fingerprint:sha-256 AB:CD:EF\r\na=setup:actpass\r\n';
        expect(extractFingerprint(sdp)).toBe('sha-256 AB:CD:EF');
    });

    it('returns empty when absent or missing', () => {
        expect(extractFingerprint('v=0\r\n')).toBe('');
        expect(extractFingerprint(undefined)).toBe('');
        expect(extractFingerprint(null)).toBe('');
    });
});
