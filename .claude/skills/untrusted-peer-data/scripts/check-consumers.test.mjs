/**
 * The entry point of check-consumers.mjs. Repo guardrails runs the checker on
 * every pull request; this file pins only that it runs at all when its path
 * holds a junction or a symlinked folder, where a guard that compared argv[1]
 * with import.meta.url unresolved once skipped main and exited 0 (#528).
 *
 * Run: node --test .claude/skills/untrusted-peer-data/scripts/check-consumers.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const usageRun = (dir) =>
    spawnSync(
        process.execPath,
        [path.join(dir, 'check-consumers.mjs'), '--nope'],
        { encoding: 'utf8', windowsHide: true }
    );

test('check-consumers.mjs answers a usage error through a junction as it does by its real path', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-consumers-link-'));
    const link = path.join(dir, 'scripts');
    try {
        try {
            symlinkSync(
                HERE,
                link,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch {
            t.skip('cannot make a directory link here');
            return;
        }
        const real = usageRun(HERE);
        assert.equal(real.status, 2, real.stdout + real.stderr);
        assert.match(real.stderr, /^unknown argument --nope$/m);
        const linked = usageRun(link);
        assert.equal(linked.status, real.status, linked.stdout + linked.stderr);
        assert.equal(linked.stdout, real.stdout);
        assert.equal(linked.stderr, real.stderr);
    } finally {
        try {
            unlinkSync(link);
        } catch {
            // never made
        }
        rmSync(dir, { recursive: true, force: true });
    }
});
