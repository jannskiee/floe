/**
 * Tests for harness.mjs: the pure parts of the CLI-shaped sender that can lie
 * about a digest. The leg itself needs a real process and a real peer, so it is
 * exercised by the audit's own forced-mismatch cells, not here.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/harness.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HarnessLeg, lastEvent, lieFlag } from './harness.mjs';

test('lieFlag: only the two lying modes produce a flag', () => {
    assert.equal(lieFlag('corrupt'), '-corrupt-hash');
    assert.equal(lieFlag('malformed'), '-malformed-hash');
    assert.equal(lieFlag(null), null);
    assert.equal(lieFlag(undefined), null);
    assert.equal(lieFlag('anything-else'), null);
});

test('lastEvent reads the last matching event and ignores everything else', () => {
    const stdout = [
        '{"event":"joined","role":"sender","roomId":"r1"}',
        '{"event":"link","link":"http://localhost:3000/#room=r1"}',
        'not json at all',
        '{"event":"channel-open"}',
        '{"event":"peer-refused","code":"hash-mismatch"}',
        '{"event":"peer-refu',
    ].join('\n');
    assert.equal(lastEvent(stdout, 'link').link, 'http://localhost:3000/#room=r1');
    assert.equal(lastEvent(stdout, 'peer-refused').code, 'hash-mismatch');
    assert.equal(lastEvent(stdout, 'done'), null);
    // A half-written line while the process is still going must not throw.
    assert.equal(lastEvent('{"event":"link"', 'link'), null);
    // The newest one wins.
    const twice = '{"event":"peer-refused","code":"other"}\n{"event":"peer-refused","code":"hash-mismatch"}';
    assert.equal(lastEvent(twice, 'peer-refused').code, 'hash-mismatch');
});

test('argv: the mode, the two URLs, the lie and the files, in that order', () => {
    const leg = new HarnessLeg({
        role: 'sender',
        bin: 'floe-e2ehost.exe',
        server: 'http://localhost:3001',
        web: 'http://localhost:3000',
        room: '8b1d4d38-6a6a-4a7e-9b1d-2b5d6f0a1c2d',
        hashLie: 'corrupt',
        files: ['C:/tmp/a.bin'],
    });
    assert.deepEqual(leg.argv(), [
        'send',
        '-server',
        'http://localhost:3001',
        '-web',
        'http://localhost:3000',
        '-room',
        '8b1d4d38-6a6a-4a7e-9b1d-2b5d6f0a1c2d',
        '-corrupt-hash',
        'C:/tmp/a.bin',
    ]);

    // Without a lie the same leg sends the truth, and a missing room is left to
    // the harness to generate.
    const honest = new HarnessLeg({
        role: 'sender',
        bin: 'floe-e2ehost.exe',
        server: 'http://localhost:3001',
        web: 'http://localhost:3000',
        hashLie: null,
        files: ['C:/tmp/a.bin', 'C:/tmp/b.bin'],
    });
    assert.deepEqual(honest.argv(), [
        'send',
        '-server',
        'http://localhost:3001',
        '-web',
        'http://localhost:3000',
        'C:/tmp/a.bin',
        'C:/tmp/b.bin',
    ]);
    assert.ok(!honest.argv().some((a) => a.includes('hash')), 'no lying flag');
});

test('a harness leg offers no route evidence, and says so rather than guessing', async () => {
    const leg = new HarnessLeg({ role: 'sender', bin: 'x', files: ['f'] });
    assert.equal(leg.route(), null);
    assert.equal(await leg.awaitRoute(1000), null);
    assert.equal(leg.surface, 'harness');
    assert.deepEqual(await leg.outputs(), [], 'a sender writes nothing');
    assert.equal(await leg.code(), null, 'the harness never registers a code');
});
