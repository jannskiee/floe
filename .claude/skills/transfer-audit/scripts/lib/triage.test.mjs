/**
 * references/triage.md and TRIAGE_KEYS in cell.mjs must name the same keys: the
 * report prints its "no row" disclaimer from TRIAGE_KEYS, so a row added to the
 * table without the key (or the reverse) makes a documented FAIL read as
 * undocumented, or an undocumented one read as documented. cell.mjs has long
 * said this file asserts that; it did not exist until P0-27 added two keys and
 * the audit printed "no row" for a key the table documents.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/triage.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { TRIAGE_KEYS } from './triage.mjs';

/** Pure. The first backticked key in each row's first cell; `-` rows have none. */
function tableKeys(markdown) {
    const keys = new Set();
    for (const line of String(markdown).split(/\r?\n/)) {
        if (!line.startsWith('|')) continue;
        const first = line.split('|')[1] || '';
        const m = /`([a-z0-9][a-z0-9-]*)`/.exec(first);
        if (m) keys.add(m[1]);
    }
    return keys;
}

test('tableKeys reads the first backticked key and skips rows without one', () => {
    const md = [
        '| Key | Where |',
        '| --- | --- |',
        '| `room-full` | x |',
        '| `-` | a row with no key |',
        '| `rate-limit` (`code-registration-failed`) | y |',
        'not a row `ignored`',
    ].join('\n');
    assert.deepEqual([...tableKeys(md)].sort(), ['rate-limit', 'room-full']);
});

test('TRIAGE_KEYS and the triage table name exactly the same keys', () => {
    const md = readFileSync(
        new URL('../../references/triage.md', import.meta.url),
        'utf8'
    );
    const table = tableKeys(md);
    const missingFromTable = [...TRIAGE_KEYS].filter((k) => !table.has(k));
    const missingFromSet = [...table].filter((k) => !TRIAGE_KEYS.has(k));
    assert.deepEqual(missingFromTable, [], 'keys in TRIAGE_KEYS with no row');
    assert.deepEqual(missingFromSet, [], 'rows whose key TRIAGE_KEYS lacks');
});
