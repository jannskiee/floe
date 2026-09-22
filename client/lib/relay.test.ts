import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RELAY_SIZE_LIMIT, filterIceServers, evaluateRelayGate, isRelayPair, probeIsRelay, readConnectionType, type RelayGateVerdict } from './relay';
import { RELAY_BLOCK_REASON, RELAY_PROBE_DELAY_MS } from './request/constants';

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

describe('probeIsRelay', () => {
    // A minimal stand-in for RTCStatsReport: the real one is a Map with an
    // extra forEach signature, and only get/forEach are used.
    const report = (entries: Record<string, unknown>) =>
        new Map(Object.entries(entries)) as unknown as RTCStatsReport;

    const pair = (id: string, local: string, remote: string, over: Record<string, unknown> = {}) => ({
        [`p-${id}`]: {
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            localCandidateId: `l-${id}`,
            remoteCandidateId: `r-${id}`,
            ...over,
        },
        [`l-${id}`]: { type: 'local-candidate', candidateType: local },
        [`r-${id}`]: { type: 'remote-candidate', candidateType: remote },
    });

    it('reports direct for a host-to-host pair', () => {
        expect(probeIsRelay(report(pair('a', 'host', 'srflx')))).toBe(false);
    });

    it('reports relay when either side is a relay candidate', () => {
        expect(probeIsRelay(report(pair('a', 'relay', 'host')))).toBe(true);
        expect(probeIsRelay(report(pair('a', 'host', 'relay')))).toBe(true);
    });

    it('LATCHES: one relay pair wins over any number of direct pairs', () => {
        // This is the case the two previous implementations disagreed on. The
        // gate latched; the badge took whichever pair the iterator yielded
        // last, so the badge could read Direct while the gate blocked the
        // transfer as relay. Latching is the conservative direction, because
        // the reading gates the 2 GB relay cap.
        const both = report({ ...pair('direct', 'host', 'host'), ...pair('relay', 'relay', 'host') });
        expect(probeIsRelay(both)).toBe(true);
        // ...and independent of insertion order.
        const reversed = report({ ...pair('relay', 'relay', 'host'), ...pair('direct', 'host', 'host') });
        expect(probeIsRelay(reversed)).toBe(true);
    });

    it('ignores pairs that are not both nominated and succeeded', () => {
        expect(probeIsRelay(report(pair('a', 'relay', 'host', { nominated: false })))).toBe(false);
        expect(probeIsRelay(report(pair('a', 'relay', 'host', { state: 'failed' })))).toBe(false);
    });

    it('ignores reports that are not candidate pairs', () => {
        expect(
            probeIsRelay(report({ t: { type: 'transport', selectedCandidatePairId: 'p-a' } }))
        ).toBe(false);
    });

    it('reports direct for an empty report rather than throwing', () => {
        expect(probeIsRelay(report({}))).toBe(false);
    });

    it('survives a pair whose candidates are missing from the report', () => {
        expect(
            probeIsRelay(
                report({
                    'p-a': {
                        type: 'candidate-pair',
                        state: 'succeeded',
                        nominated: true,
                        localCandidateId: 'gone',
                        remoteCandidateId: 'also-gone',
                    },
                })
            )
        ).toBe(false);
    });
});

describe('readConnectionType', () => {
    const report = (entries: Record<string, unknown>) =>
        new Map(Object.entries(entries)) as unknown as RTCStatsReport;

    const pair = (id: string, local: string, remote: string, over: Record<string, unknown> = {}) => ({
        [`p-${id}`]: {
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            localCandidateId: `l-${id}`,
            remoteCandidateId: `r-${id}`,
            ...over,
        },
        [`l-${id}`]: { type: 'local-candidate', candidateType: local },
        [`r-${id}`]: { type: 'remote-candidate', candidateType: remote },
    });

    it('answers null until ICE has nominated something', () => {
        // The badge polls from the moment the peer connects. probeIsRelay says
        // false here, which is right for the gate and wrong for the badge:
        // reporting "direct" now would flash the wrong route on a connection
        // that turns out to be relayed.
        expect(readConnectionType(report({}))).toBeNull();
        expect(readConnectionType(report(pair('a', 'relay', 'host', { nominated: false })))).toBeNull();
        expect(readConnectionType(report(pair('a', 'host', 'host', { state: 'failed' })))).toBeNull();
    });

    it('agrees with the gate once a pair is nominated', () => {
        const direct = report(pair('a', 'host', 'srflx'));
        expect(readConnectionType(direct)).toBe('direct');
        expect(probeIsRelay(direct)).toBe(false);

        const relayed = report(pair('a', 'relay', 'host'));
        expect(readConnectionType(relayed)).toBe('relay');
        expect(probeIsRelay(relayed)).toBe(true);
    });

    it('cannot disagree with the gate on a mixed multi-pair report', () => {
        // This is the whole bug: the badge used to take the last pair the
        // iterator yielded, so it could read direct while the gate blocked as
        // relay. Both readings now come from one scan.
        for (const entries of [
            { ...pair('d', 'host', 'host'), ...pair('r', 'relay', 'host') },
            { ...pair('r', 'relay', 'host'), ...pair('d', 'host', 'host') },
        ]) {
            const stats = report(entries);
            expect(readConnectionType(stats)).toBe('relay');
            expect(probeIsRelay(stats)).toBe(true);
        }
    });
});

// The request link visitor duplicates the main page's relay probe and abort
// rather than sharing a function with it (OD-13: the main page's inline relay
// block is never edited). What keeps the two copies from drifting apart is
// this table, which both callers depend on, and the source pin below it.
describe('relay gate verdict table shared by P2PTransfer and RequestVisitor', () => {
    const rows: Array<[string, Parameters<typeof evaluateRelayGate>[0], RelayGateVerdict]> = [
        ['direct, any size, relay on', { isRelay: false, relayEnabled: true, totalSize: RELAY_SIZE_LIMIT * 100 }, { action: 'proceed' }],
        ['direct, any size, relay off', { isRelay: false, relayEnabled: false, totalSize: RELAY_SIZE_LIMIT * 100 }, { action: 'proceed' }],
        ['relay on, exactly the limit', { isRelay: true, relayEnabled: true, totalSize: RELAY_SIZE_LIMIT }, { action: 'proceed' }],
        ['relay on, limit + 1', { isRelay: true, relayEnabled: true, totalSize: RELAY_SIZE_LIMIT + 1 }, { action: 'block-over-limit', totalSize: RELAY_SIZE_LIMIT + 1 }],
        ['relay off on a relayed path', { isRelay: true, relayEnabled: false, totalSize: 1 }, { action: 'block-relay-disabled' }],
    ];
    for (const [name, input, verdict] of rows) {
        it(name, () => {
            expect(evaluateRelayGate(input)).toEqual(verdict);
        });
    }

    const source = (rel: string) =>
        readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

    /** The body of `if (verdict.action === 'block-over-limit') { ... }`. */
    function blockBranch(src: string): string {
        const head = "if (verdict.action === 'block-over-limit') {";
        const at = src.indexOf(head);
        expect(at, 'block-over-limit branch').toBeGreaterThan(-1);
        let depth = 0;
        for (let i = at + head.length - 1; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
        }
        throw new Error('unbalanced branch');
    }

    it('both callers probe after 2000 ms and await the TEXT abort before destroy', () => {
        const main = source('components/P2PTransfer.tsx');
        const visitor = source('components/RequestVisitor.tsx');
        for (const [name, src] of [['main page', main], ['visitor', visitor]] as const) {
            expect(src, name).toContain('probeIsRelay(');
            expect(src, name).toContain('evaluateRelayGate(');
            const branch = blockBranch(src);
            const abort = branch.indexOf('await sendAbortReason(');
            const destroy = branch.indexOf('.destroy()');
            expect(abort, `${name}: abort`).toBeGreaterThan(-1);
            expect(destroy, `${name}: destroy`).toBeGreaterThan(abort);
        }
        // The delay: a literal on the main page, the named constant on /r.
        expect(main).toContain('}, 2000);');
        expect(visitor).toContain('RELAY_PROBE_DELAY_MS');
        expect(RELAY_PROBE_DELAY_MS).toBe(2000);
        // The reason: the main page splits it into two concatenated literals;
        // joined, they are the visitor's constant, and the visitor's branch
        // passes that constant and nothing else.
        const mainBranch = blockBranch(main);
        const call = mainBranch.slice(mainBranch.indexOf('await sendAbortReason('), mainBranch.indexOf('.destroy()'));
        const literals = [...call.matchAll(/'([^']*)'/g)].map((m) => m[1]);
        expect(literals).toHaveLength(2);
        const joined = literals.join('');
        expect(joined).toBe(RELAY_BLOCK_REASON);
        expect(blockBranch(visitor)).toMatch(/sendAbortReason\([^;]*RELAY_BLOCK_REASON\s*\)/);
        // relayEnabled is always true on /r: there is no relay-off toggle.
        expect(visitor).toMatch(/evaluateRelayGate\(\{[^}]*relayEnabled: true/);
    });
});
