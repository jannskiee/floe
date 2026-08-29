// Route classification. Pure. Both product classifiers OR the selected
// candidate pair (cli/engine/peer/connection.go ConnectionType and
// client/lib/relay.ts isRelayPair): any side of the nominated pair being a
// relay candidate means the path is relayed. The oracles, in order of
// trust: browser getStats samples taken while the transfer is live, the
// browser's floe-connection-status event, the pill text (web or desktop),
// and pion's `Set selected candidate pair:` trace line on a CLI leg.

const DECISIVE = new Set(['direct', 'relay']);

/**
 * classifyRoute({ samples, events, pill, pionLines, relayForced }) ->
 *   { verdict: 'direct'|'relay'|'unknown', source, local, remote,
 *     policyOk: boolean|null, at }
 * samples: [{ t, pcs: [{ policy, pair: { local, remote } | null }] }]
 * events:  [{ t, detail }] with detail 'direct'|'relay'|'connected'|'offline'
 * pill:    'Direct' | 'Relay' | 'Ready' | 'Active' | null
 * pionLines: stderr lines from PION_LOG_TRACE=ice
 */
export function classifyRoute({
    samples = [],
    events = [],
    pill = null,
    pionLines = [],
    relayForced = false,
} = {}) {
    let policyOk = null;
    if (relayForced) {
        const pcs = samples.flatMap((s) => s?.pcs || []);
        policyOk = pcs.length ? pcs.every((pc) => pc.policy === 'relay') : null;
    }
    for (const s of samples) {
        for (const pc of s?.pcs || []) {
            const pair = pc?.pair;
            if (!pair || (!pair.local && !pair.remote)) continue;
            const relay = pair.local === 'relay' || pair.remote === 'relay';
            return {
                verdict: relay ? 'relay' : 'direct',
                source: 'getStats',
                local: pair.local || null,
                remote: pair.remote || null,
                policyOk,
                at: s.t ?? null,
            };
        }
    }
    const last = [...events]
        .reverse()
        .find((e) => DECISIVE.has(String(e?.detail).toLowerCase()));
    if (last)
        return {
            verdict: String(last.detail).toLowerCase(),
            source: 'event',
            local: null,
            remote: null,
            policyOk,
            at: last.t ?? null,
        };
    const p = pill ? String(pill).trim().toLowerCase() : '';
    if (DECISIVE.has(p))
        return {
            verdict: p,
            source: 'pill',
            local: null,
            remote: null,
            policyOk,
            at: null,
        };
    const trace = pionLines.find((l) => /Set selected candidate pair:/.test(l));
    if (trace)
        return {
            verdict: / relay /.test(trace) ? 'relay' : 'direct',
            source: 'pion-trace',
            local: null,
            remote: null,
            policyOk,
            at: null,
        };
    return {
        verdict: 'unknown',
        source: 'none',
        local: null,
        remote: null,
        policyOk,
        at: null,
    };
}

const known = (r) => r && DECISIVE.has(r.verdict);

/**
 * classifyPair({ sender, receiver }, cell) -> {
 *   observed: 'direct'|'relay'|'unobserved'|'disagree',
 *   ok, reason, sides: ['W local', 'D'], label, sources: [...] }
 * cell: { path: 'DIR'|'REL', sender: { letter }, receiver: { letter },
 *         forcedSide: 'sender'|'receiver'|null, forcer,
 *         byConstruction: boolean }
 */
export function classifyPair(routes, cell) {
    const sides = [];
    const sources = [];
    const entries = [
        ['sender', routes?.sender, cell.sender],
        ['receiver', routes?.receiver, cell.receiver],
    ];
    const verdicts = [];
    for (const [side, r, leg] of entries) {
        if (!known(r)) continue;
        verdicts.push(r.verdict);
        const letter = leg?.letter || side[0].toUpperCase();
        sides.push(r.local === 'relay' ? `${letter} local` : letter);
        sources.push({
            side,
            surface: letter,
            oracle: r.source,
            value: r.verdict,
            local: r.local ?? null,
            remote: r.remote ?? null,
            at: r.at ?? null,
        });
    }
    let observed;
    if (!verdicts.length) observed = 'unobserved';
    else if (verdicts.every((v) => v === verdicts[0])) observed = verdicts[0];
    else observed = 'disagree';

    const byConstruction = Boolean(cell.byConstruction);
    let ok = true;
    let reason = null;
    let label;
    if (observed === 'disagree') {
        ok = false;
        reason = 'route-disagree';
        label = `disagree [${sides.join(',')}]`;
    } else if (cell.path === 'REL') {
        const forced = cell.forcedSide ? routes?.[cell.forcedSide] : null;
        const forcedLeg = cell.forcedSide ? cell[cell.forcedSide] : null;
        const isWeb = forcedLeg?.letter === 'W';
        const forcedProof = isWeb
            ? forced?.local === 'relay'
            : forced?.verdict === 'relay';
        if (cell.forcer === 'relayOnlyFlag') {
            // CLI --relay-only forces the sender; the peer's oracle or the
            // sender's own trace must read relay.
            if (observed !== 'relay') {
                ok = false;
                reason =
                    observed === 'unobserved'
                        ? 'route-unproven'
                        : 'forcer-ineffective';
            }
        } else if (!forcedProof) {
            ok = false;
            reason = 'forcer-ineffective';
        } else if (observed !== 'relay') {
            ok = false;
            reason = 'route-disagree';
        }
        label =
            observed === 'unobserved'
                ? 'unobserved'
                : `${observed} [${sides.join(',')}]`;
    } else {
        if (observed === 'relay') {
            ok = false;
            reason = 'route-mismatch';
            label = `relay [${sides.join(',')}]`;
        } else if (observed === 'unobserved') {
            label = byConstruction ? 'direct [--no-relay both]' : 'unobserved';
            if (!byConstruction) reason = 'route-unproven';
        } else {
            label = byConstruction
                ? `direct [${sides.join(',')}; --no-relay both]`
                : `direct [${sides.join(',')}]`;
        }
    }
    return { observed, ok, reason, sides, label, sources };
}
