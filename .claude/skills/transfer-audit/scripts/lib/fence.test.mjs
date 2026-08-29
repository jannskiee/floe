// node --test .claude/skills/<skill>/scripts/lib/fence.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { Fence, createFence, hasDotDot, isUnder } from './fence.mjs';
import { SafetyError } from './surfaces.mjs';

const WIN = process.platform === 'win32';
const base = WIN ? 'C:\\lta-test' : '/lta-test';
const j = (...p) => path.join(base, ...p);
const out = j('out');
const bin = j('bin');
const mainCheckout = j('WebstormProjects', 'p2p-file-share');
const worktree = j('WebstormProjects', 'floe-lta');
const appData = j('Users', 'someone', 'AppData', 'Roaming');

const fence = createFence({
    allow: [out, bin],
    repoRoots: [mainCheckout, worktree],
    appData,
});

test('allowed dirs are writable', () => {
    assert.equal(
        fence.assertWritable(j('out', 'run', 'audit.md')),
        path.resolve(j('out', 'run', 'audit.md'))
    );
    assert.ok(fence.isWritable(j('bin', 'floe-1.0.0', 'floe.exe')));
    assert.ok(fence.isWritable(out));
});

test('refuses server/.env and every .env variant, even under an allowed dir', () => {
    for (const p of [
        j('WebstormProjects', 'p2p-file-share', 'server', '.env'),
        j('out', '.env'),
        j('out', '.env.local'),
        j('out', 'x', '.env.production'),
    ]) {
        assert.throws(
            () => fence.assertWritable(p),
            (e) =>
                e instanceof SafetyError && /env file|checkout/.test(e.message),
            p
        );
    }
});

test('refuses the WebView2 profile and the real Floe app data', () => {
    assert.throws(
        () =>
            fence.assertWritable(
                path.join(appData, 'floe', 'webview', 'EBWebView', 'x')
            ),
        /WebView2/
    );
    assert.throws(
        () => fence.assertWritable(path.join(appData, 'floe', 'history.json')),
        /app data/
    );
    assert.throws(
        () => fence.assertWritable(path.join(appData, 'floe')),
        /app data/
    );
});

test('desktop.json only through the guard', () => {
    const cfg = path.join(appData, 'floe', 'desktop.json');
    assert.throws(() => fence.assertWritable(cfg), /config guard/);
    assert.equal(
        fence.assertWritable(cfg, { viaGuard: true }),
        path.resolve(cfg)
    );
});

test('refuses the main checkout and the worktree', () => {
    assert.throws(
        () =>
            fence.assertWritable(
                path.join(mainCheckout, 'client', 'next-env.d.ts')
            ),
        /checkout/
    );
    assert.throws(
        () => fence.assertWritable(path.join(worktree, 'README.md')),
        /checkout/
    );
    assert.throws(() => fence.assertWritable(mainCheckout), /checkout/);
});

test('an allowed dir inside a checkout (HEAD build output) is writable', () => {
    const f = new Fence({ allow: [out], repoRoots: [worktree], appData });
    const dist = path.join(worktree, 'desktop', 'frontend', 'dist');
    assert.throws(
        () => f.assertWritable(path.join(dist, 'index.html')),
        /checkout/
    );
    f.allowDir(dist);
    assert.ok(f.isWritable(path.join(dist, 'index.html')));
    assert.throws(
        () => f.assertWritable(path.join(worktree, 'desktop', 'app.go')),
        /checkout/
    );
});

test('refuses .. segments and empty paths and anything outside the allowlist', () => {
    assert.throws(
        () => fence.assertWritable(`${out}${path.sep}..${path.sep}escape.txt`),
        /\.\. segment/
    );
    assert.throws(() => fence.assertWritable(''), /empty/);
    assert.throws(
        () => fence.assertWritable(j('elsewhere', 'x.txt')),
        /outside every allowed dir/
    );
    assert.ok(hasDotDot('a/../b'));
    assert.ok(!hasDotDot('a/b..c'));
});

test('refusals are recorded for the safety section', () => {
    const f = createFence({ allow: [out], repoRoots: [], appData });
    assert.throws(() => f.assertWritable(j('x', '.env')));
    assert.equal(f.refusals.length, 1);
    assert.match(f.refusals[0], /env file/);
});

test('isUnder is case-insensitive on Windows and separator-tolerant', () => {
    assert.ok(isUnder(j('out', 'a'), out));
    assert.ok(!isUnder(j('outside'), out));
    if (WIN) assert.ok(isUnder(out.toUpperCase() + '\\A', out.toLowerCase()));
});
