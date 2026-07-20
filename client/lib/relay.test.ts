import { describe, it, expect } from 'vitest';
import {
    RELAY_SIZE_LIMIT,
    filterIceServers,
    evaluateRelayGate,
    isRelayPair,
} from './relay';

const STUN: RTCIceServer = { urls: 'stun:stun.l.google.com:19302' };
const TURN: RTCIceServer = { urls: 'turn:turn.example.com:3478' };
const TURNS: RTCIceServer = { urls: 'turns:turn.example.com:5349' };
const MIXED: RTCIceServer = {
    urls: ['stun:stun.example.com:3478', 'turn:turn.example.com:3478'],
};

describe('filterIceServers', () => {
    it('returns the list unchanged when relay is enabled', () => {
        const servers = [STUN, TURN, TURNS];
        expect(filterIceServers(servers, true)).toBe(servers);
    });

    it('strips turn: and turns: servers when relay is disabled', () => {
        expect(filterIceServers([STUN, TURN, TURNS], false)).toEqual([STUN]);
    });

    it('drops an entry whose urls array contains any turn url', () => {
        // MIXED bundles a STUN and a TURN url; with relay off the whole entry goes.
        expect(filterIceServers([STUN, MIXED], false)).toEqual([STUN]);
    });

    it('keeps every stun server when relay is disabled', () => {
        const stunOnly = [STUN, { urls: 'stun:stun1.l.google.com:19302' }];
        expect(filterIceServers(stunOnly, false)).toEqual(stunOnly);
    });
});

describe('isRelayPair', () => {
    it('classifies host and reflexive pairs as direct', () => {
        expect(isRelayPair('host', 'host')).toBe(false);
        expect(isRelayPair('srflx', 'srflx')).toBe(false);
        expect(isRelayPair('srflx', 'host')).toBe(false);
        expect(isRelayPair('host', 'prflx')).toBe(false);
    });

    it('reports relay when either side connects through TURN', () => {
        expect(isRelayPair('relay', 'host')).toBe(true);
        expect(isRelayPair('srflx', 'relay')).toBe(true);
        expect(isRelayPair('relay', 'relay')).toBe(true);
    });

    it('treats missing candidate types as not relay', () => {
        expect(isRelayPair(undefined, undefined)).toBe(false);
        expect(isRelayPair('host', undefined)).toBe(false);
    });
});

describe('evaluateRelayGate', () => {
    it('proceeds on a direct connection regardless of the other flags', () => {
        expect(
            evaluateRelayGate({ isRelay: false, relayEnabled: false, totalSize: RELAY_SIZE_LIMIT * 10 })
        ).toEqual({ action: 'proceed' });
    });

    it('blocks a relayed connection when relay fallback is disabled', () => {
        expect(
            evaluateRelayGate({ isRelay: true, relayEnabled: false, totalSize: 1 })
        ).toEqual({ action: 'block-relay-disabled' });
    });

    it('proceeds on a relayed connection under the size limit', () => {
        expect(
            evaluateRelayGate({ isRelay: true, relayEnabled: true, totalSize: RELAY_SIZE_LIMIT - 1 })
        ).toEqual({ action: 'proceed' });
    });

    it('blocks a relayed connection over the size limit', () => {
        expect(
            evaluateRelayGate({ isRelay: true, relayEnabled: true, totalSize: RELAY_SIZE_LIMIT + 1 })
        ).toEqual({ action: 'block-over-limit', totalSize: RELAY_SIZE_LIMIT + 1 });
    });

    it('proceeds at exactly the size limit (boundary is strictly greater-than)', () => {
        expect(
            evaluateRelayGate({ isRelay: true, relayEnabled: true, totalSize: RELAY_SIZE_LIMIT })
        ).toEqual({ action: 'proceed' });
    });
});
