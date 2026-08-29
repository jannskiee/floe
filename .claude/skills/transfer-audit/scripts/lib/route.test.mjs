// node --test .claude/skills/<skill>/scripts/lib/route.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyPair, classifyRoute } from './route.mjs';

const sample = (local, remote, policy = null) => ({
    t: 1,
    pcs: [{ policy, pair: { local, remote } }],
});

test('classifyRoute: getStats decides first, relay on either side', () => {
    assert.equal(
        classifyRoute({ samples: [sample('relay', 'srflx')] }).verdict,
        'relay'
    );
    assert.equal(
        classifyRoute({ samples: [sample('srflx', 'relay')] }).verdict,
        'relay'
    );
    const d = classifyRoute({ samples: [sample('host', 'host')] });
    assert.equal(d.verdict, 'direct');
    assert.equal(d.source, 'getStats');
    assert.equal(d.local, 'host');
    // An empty PC list before the first pair does not decide.
    const later = classifyRoute({
        samples: [
            { t: 0, pcs: [{ policy: null, pair: null }] },
            sample('srflx', 'srflx'),
        ],
    });
    assert.equal(later.verdict, 'direct');
});

test('classifyRoute: event, pill and pion fallbacks, then unknown', () => {
    const ev = classifyRoute({
        events: [
            { t: 1, detail: 'connected' },
            { t: 2, detail: 'relay' },
        ],
    });
    assert.deepEqual([ev.verdict, ev.source], ['relay', 'event']);
    const pill = classifyRoute({ pill: 'Direct' });
    assert.deepEqual([pill.verdict, pill.source], ['direct', 'pill']);
    assert.equal(classifyRoute({ pill: 'Active' }).verdict, 'unknown');
    const pion = classifyRoute({
        pionLines: [
            'ice TRACE: Set selected candidate pair: prflx 1.2.3.4:5 <-> relay 5.6.7.8:9',
        ],
    });
    assert.deepEqual([pion.verdict, pion.source], ['relay', 'pion-trace']);
    assert.equal(
        classifyRoute({
            pionLines: ['Set selected candidate pair: host a <-> srflx b'],
        }).verdict,
        'direct'
    );
    assert.deepEqual(classifyRoute({}).verdict, 'unknown');
});

test('classifyRoute: policyOk on a relay-forced leg', () => {
    assert.equal(
        classifyRoute({
            samples: [sample('relay', 'srflx', 'relay')],
            relayForced: true,
        }).policyOk,
        true
    );
    assert.equal(
        classifyRoute({
            samples: [sample('relay', 'srflx', 'all')],
            relayForced: true,
        }).policyOk,
        false
    );
    assert.equal(
        classifyRoute({ samples: [], relayForced: true }).policyOk,
        null
    );
    assert.equal(
        classifyRoute({ samples: [sample('host', 'host', 'all')] }).policyOk,
        null
    );
});

const relCell = (forcedSide, letters = ['W', 'C']) => ({
    path: 'REL',
    sender: { letter: letters[0] },
    receiver: { letter: letters[1] },
    forcedSide,
    forcer: 'initScript',
    byConstruction: false,
});
const dirCell = (letters = ['W', 'C'], byConstruction = false) => ({
    path: 'DIR',
    sender: { letter: letters[0] },
    receiver: { letter: letters[1] },
    forcedSide: null,
    forcer: 'none',
    byConstruction,
});
const r = (verdict, source = 'getStats', local = null, remote = null) => ({
    verdict,
    source,
    local,
    remote,
});

test('classifyPair: OR semantics and side labels', () => {
    const ok = classifyPair(
        { sender: r('relay', 'getStats', 'relay', 'srflx'), receiver: null },
        relCell('sender')
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.observed, 'relay');
    assert.equal(ok.label, 'relay [W local]');
    assert.equal(ok.sources.length, 1);
    const both = classifyPair(
        {
            sender: r('direct', 'getStats', 'host', 'host'),
            receiver: r('direct', 'pill'),
        },
        dirCell(['W', 'D'])
    );
    assert.equal(both.ok, true);
    assert.equal(both.label, 'direct [W,D]');
});

test('classifyPair: DIR cell with any relay is route-mismatch', () => {
    const p = classifyPair(
        { sender: r('relay', 'getStats', 'srflx', 'relay'), receiver: null },
        dirCell()
    );
    assert.equal(p.ok, false);
    assert.equal(p.reason, 'route-mismatch');
});

test('classifyPair: disagreement is route-disagree', () => {
    const p = classifyPair(
        { sender: r('direct'), receiver: r('relay', 'pill') },
        dirCell(['W', 'D'])
    );
    assert.equal(p.reason, 'route-disagree');
    assert.equal(p.observed, 'disagree');
});

test('classifyPair: REL cell needs the forced side proof', () => {
    // Forced web sender shows remote relay only: forcer did not take.
    const weak = classifyPair(
        { sender: r('relay', 'getStats', 'srflx', 'relay'), receiver: null },
        relCell('sender')
    );
    assert.equal(weak.reason, 'forcer-ineffective');
    // Forced desktop receiver: pill Relay is the proof.
    const d = classifyPair(
        { sender: null, receiver: r('relay', 'pill') },
        { ...relCell('receiver', ['C', 'D']), forcer: 'hideIP' }
    );
    assert.equal(d.ok, true);
    assert.equal(d.label, 'relay [D]');
    const none = classifyPair(
        { sender: null, receiver: null },
        relCell('sender')
    );
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'forcer-ineffective');
    assert.equal(none.label, 'unobserved');
});

test('classifyPair: direct by construction and unproven', () => {
    const c2c = classifyPair(
        { sender: null, receiver: null },
        dirCell(['C', 'C'], true)
    );
    assert.equal(c2c.ok, true);
    assert.equal(c2c.label, 'direct [--no-relay both]');
    assert.equal(c2c.reason, null);
    const unproven = classifyPair(
        { sender: null, receiver: null },
        dirCell(['C', 'D'])
    );
    assert.equal(unproven.ok, true);
    assert.equal(unproven.reason, 'route-unproven');
    assert.equal(unproven.label, 'unobserved');
    const traced = classifyPair(
        { sender: r('direct', 'pion-trace'), receiver: null },
        dirCell(['C', 'C'], true)
    );
    assert.equal(traced.label, 'direct [C; --no-relay both]');
});

test('classifyPair: CLI --relay-only forcer accepts any relay observation', () => {
    const cell = { ...relCell('sender', ['C', 'C']), forcer: 'relayOnlyFlag' };
    assert.equal(
        classifyPair({ sender: r('relay', 'pion-trace'), receiver: null }, cell)
            .ok,
        true
    );
    assert.equal(
        classifyPair(
            { sender: r('direct', 'pion-trace'), receiver: null },
            cell
        ).reason,
        'forcer-ineffective'
    );
    assert.equal(
        classifyPair({ sender: null, receiver: null }, cell).reason,
        'route-unproven'
    );
});
