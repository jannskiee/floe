// node --test .claude/skills/<skill>/scripts/lib/adapters.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    adapterNames,
    getAdapter,
    isSurfaceAdapter,
    resetAdapters,
    setAdapter,
    tryAdapter,
} from './adapters.mjs';

test('registry names and override lifecycle', async () => {
    assert.deepEqual(adapterNames(), [
        'web',
        'cli',
        'desktop',
        'wsl',
        'proc',
        'stack',
    ]);
    const fake = {
        createLeg: () => ({}),
        preflight: async () => ({ ok: true }),
    };
    setAdapter('web', fake);
    assert.equal(await getAdapter('web'), fake);
    assert.ok(isSurfaceAdapter(fake));
    assert.ok(!isSurfaceAdapter({ createLeg: () => ({}) }));
    setAdapter('web', null);
    resetAdapters();
    assert.throws(() => setAdapter('bogus', fake), /unknown adapter/);
    await assert.rejects(getAdapter('bogus'), /unknown adapter/);
});

test('a missing sibling module reports missing instead of crashing', async () => {
    resetAdapters();
    // Every registered module either loads or is reported as missing.
    for (const name of adapterNames()) {
        try {
            const mod = await getAdapter(name);
            assert.equal(typeof mod, 'object');
        } catch (e) {
            assert.equal(e.missing, true, `${name}: ${e.message}`);
            assert.equal(e.adapter, name);
            assert.equal(await tryAdapter(name), null);
        }
    }
});
