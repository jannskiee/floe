#!/usr/bin/env node

    /**
 * Tests for deep-clean.mjs.
 *
 * The suite builds a synthetic checkout and a synthetic temp dir, both
 * seeded with decoys: files that look exactly like debris and must never
 * be swept. Every assertion that matters is of the form "this decoy still
 * exists after sweep --apply", because the failure this script must never
 * have is deleting something precious, not missing some junk.
 *
 * The fixture is a real git repo (git init plus git add, no commit) so the
 * tracked-file check is exercised for real rather than mocked.
 *
 * The "regressions" block is the important one. Every case in it is a
 * defect a red-team agent actually reproduced against an earlier version
 * of this script on 2026-09-02, most of them ending in real deletion of
 * committed files. They are written as tests so they cannot come back.
 *
 * Run: node --test .claude/skills/deep-clean/scripts/deep-clean.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as deepClean from './deep-clean.mjs';
import { makeFence, parseFirewall, scanContents } from './deep-clean.mjs';

const SCRIPT = fileURLToPath(new URL('./deep-clean.mjs', import.meta.url));
const DAY = 86400000;

let BASE;
let REPO;
let TEMP;
let LINK;
let DECOYS;

function w(p, body = 'x') {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
}

function walk(p) {
    const out = [];
    let st;
    try {
        st = fs.lstatSync(p);
    } catch {
        return out;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return out;
    for (const e of fs.readdirSync(p)) {
        const c = path.join(p, e);
        out.push(c, ...walk(c));
    }
    return out;
}

function age(p, days) {
    const t = new Date(Date.now() - days * DAY);
    for (const f of [...walk(p), p]) {
        try {
            fs.utimesSync(f, t, t);
        } catch {
            /* best effort */
        }
    }
}

/** Try to make a directory link. Returns the path, or null if unprivileged. */
function tryLink(target, linkPath) {
    try {
        fs.symlinkSync(target, linkPath, 'junction');
        return linkPath;
    } catch {
        try {
            fs.symlinkSync(target, linkPath, 'dir');
            return linkPath;
        } catch {
            return null;
        }
    }
}

/**
 * Run the script. Never throws on a non-zero exit. `home` points the child's
 * home directory at a fixture, for the rules that are anchored there.
 */
function run(args, home = null) {
    const env = home
        ? { ...process.env, USERPROFILE: home, HOME: home }
        : process.env;
    try {
        const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env,
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return {
            code: e.status ?? -1,
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
        };
    }
}

function inRepo(repo, temp, args) {
    return run([...args, '--root', repo, '--temp-root', temp]);
}

function survey(extra = []) {
    const r = inRepo(REPO, TEMP, [
        'survey',
        '--json',
        '--age-minutes',
        '0',
        ...extra,
    ]);
    return { code: r.code, data: JSON.parse(r.stdout) };
}

function bucketOf(data, id) {
    return data.items.find((i) => i.id === id)?.bucket ?? '(absent)';
}

/** A minimal repo that passes the --root marker check. */
function newRepo(base, name) {
    const repo = path.join(base, name);
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    w(path.join(repo, 'CLAUDE.md'), '# marker');
    execFileSync('git', ['add', 'CLAUDE.md'], { cwd: repo });
    return repo;
}

/* ------------------------------------------------------------- fixture */

function build() {
    BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-clean-test-'));
    REPO = newRepo(BASE, 'repo');
    TEMP = path.join(BASE, 'temp');
    fs.mkdirSync(TEMP, { recursive: true });

    const tracked = w(path.join(REPO, 'keeper.txt'), 'tracked');
    const trackedDecoy = w(
        path.join(REPO, 'client', 'tsconfig.tsbuildinfo'),
        'tracked'
    );
    execFileSync('git', ['add', 'keeper.txt', 'client/tsconfig.tsbuildinfo'], {
        cwd: REPO,
    });

    // Fenced decoys.
    const env = w(path.join(REPO, 'server', '.env'), 'UPSTASH_TOKEN=live');
    const envLocal = w(path.join(REPO, 'client', '.env.local'), 'x');
    const turn = w(path.join(REPO, 'coturn', 'turnserver.conf'), 'secret');
    const dist = w(
        path.join(REPO, 'desktop', 'frontend', 'dist', 'index.html')
    );
    const goWorkSum = w(path.join(REPO, 'go.work.sum'), 'x');
    const auditBin = w(path.join(TEMP, 'floe-audit', 'bin', 'floe.exe'));

    // A denied file buried inside an otherwise safe directory. rmSync is
    // recursive, so this is the one that used to die silently.
    const buriedEnv = w(
        path.join(REPO, 'client', '.next', 'cache', '.env.production'),
        'SECRET=1'
    );
    const buriedZip = w(
        path.join(REPO, 'client', 'playwright-report', 'floe_transfer_9.zip'),
        'media'
    );

    // Safe artifacts.
    w(path.join(REPO, 'client', '.next', 'build.bin'), 'z'.repeat(4096));
    w(path.join(REPO, 'client', 'test-results', '.last-run.json'));
    w(path.join(REPO, 'desktop', 'desktop.exe'));
    w(path.join(TEMP, 'floe-win-fixed.exe'));

    // Ask items.
    w(path.join(REPO, 'floe.exe'));
    w(path.join(REPO, '.refactor-audit', 'notes.md'));
    w(path.join(TEMP, 'floe-audit', 'out', 'report.md'));
    w(path.join(REPO, 'node_modules', 'pkg', 'index.js'));

    // Scratchpads: empty, stale, fresh.
    const slug = path.resolve(REPO).replace(/[:\\/]/g, '-');
    const scratch = path.join(TEMP, 'claude', slug);
    fs.mkdirSync(path.join(scratch, 'empty-session'), { recursive: true });
    const stale = path.join(scratch, 'stale-session');
    w(path.join(stale, 'old.bin'), 'y'.repeat(2048));
    age(stale, 30);
    const fresh = path.join(scratch, 'fresh-session');
    w(path.join(fresh, 'live.bin'), 'y'.repeat(2048));

    LINK = tryLink(
        path.join(REPO, 'server'),
        path.join(TEMP, 'floeprobe_link')
    );

    DECOYS = [
        tracked,
        trackedDecoy,
        env,
        envLocal,
        turn,
        dist,
        goWorkSum,
        auditBin,
        buriedEnv,
        buriedZip,
        path.join(fresh, 'live.bin'),
    ];
}

before(build);

after(() => {
    try {
        fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5 });
    } catch {
        /* windows may hold a handle briefly; the temp dir is disposable */
    }
});

/* --------------------------------------------------------------- tests */

describe('fence', () => {
    it('refuses every never-touch path', () => {
        const fence = makeFence(REPO, [], TEMP);
        const home = os.homedir();
        const appdata =
            process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        const localapp =
            process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        for (const p of [
            path.join(REPO, 'server', '.env'),
            path.join(REPO, 'client', '.env.local'),
            path.join(REPO, 'coturn', 'turnserver.conf'),
            path.join(REPO, 'desktop', 'frontend', 'dist'),
            path.join(REPO, 'go.work'),
            path.join(REPO, 'go.work.sum'),
            path.join(REPO, '.claude', 'settings.local.json'),
            path.join(REPO, '.git', 'config'),
            path.join(REPO, 'client', '.next', 'x', '.env.local'),
            path.join(appdata, 'floe'),
            path.join(appdata, 'floe', 'desktop.json'),
            path.join(localapp, 'ms-playwright', 'chromium-1234'),
            path.join(home, 'floe_transfer_1779272746482.zip'),
            path.join(home, '.claude', 'plans'),
            path.join(home, '.claude', 'projects', 'p', 'memory'),
            path.join(TEMP, 'floe-audit', 'bin'),
            path.join(TEMP, 'floe-audit', 'bin', 'floe.exe'),
            REPO,
            TEMP,
            home,
            path.join(home, 'Documents'),
            'C:\\Windows\\System32',
            '/etc/passwd',
        ]) {
            assert.notEqual(fence(p), null, `fence should refuse ${p}`);
        }
    });

    it('allows genuine artifacts', () => {
        const fence = makeFence(REPO, [], TEMP);
        for (const p of [
            path.join(REPO, 'client', '.next'),
            path.join(REPO, 'client', 'playwright-report'),
            path.join(TEMP, 'floe-win-fixed.exe'),
        ]) {
            assert.equal(fence(p), null, `fence should allow ${p}`);
        }
    });

    /**
     * .env.example and .env.docker.example are committed public templates,
     * so the deny-by-name rule deliberately exempts them. Denying them
     * fenced 319 MB of dead scratchpads that held nothing but a copy of the
     * repo. The tracked-file check is what protects the real ones.
     */
    it('exempts .env.example from the environment-file rule', () => {
        const fence = makeFence(REPO, [], TEMP);
        assert.equal(fence(path.join(REPO, 'x', '.env.example')), null);
        assert.equal(fence(path.join(REPO, 'x', '.env.docker.example')), null);
        assert.notEqual(fence(path.join(REPO, 'x', '.env')), null);
        assert.notEqual(fence(path.join(REPO, 'x', '.env.production')), null);
        // and a name that merely starts with the same letters is not a match
        assert.equal(fence(path.join(REPO, 'x', '.environment')), null);
    });

    it('refuses a link at the leaf', () => {
        if (!LINK) return;
        assert.notEqual(makeFence(REPO, [], TEMP)(LINK), null);
    });

    it('honours --keep, which is only ever restrictive', () => {
        const target = path.join(REPO, 'client', '.next');
        assert.equal(makeFence(REPO, [], TEMP)(target), null);
        assert.notEqual(makeFence(REPO, [target], TEMP)(target), null);
    });
});

describe('scanContents', () => {
    it('finds a denied name at any depth', () => {
        const hit = scanContents(path.join(REPO, 'client', '.next'), [
            REPO,
            TEMP,
        ]);
        assert.ok(hit, 'a buried .env must be found');
        assert.match(hit.path, /\.env\.production$/);
    });

    it('passes a clean directory', () => {
        assert.equal(
            scanContents(path.join(REPO, 'client', 'test-results'), [
                REPO,
                TEMP,
            ]),
            null
        );
    });

    it('marks a secret hard and a nested git repo soft', () => {
        const hard = scanContents(path.join(REPO, 'client', '.next'), [
            REPO,
            TEMP,
        ]);
        assert.equal(hard.hard, true, 'a buried .env is a hard refusal');

        const dir = path.join(TEMP, 'carrier');
        w(path.join(dir, 'sub', '.git', 'HEAD'), 'ref');
        const soft = scanContents(dir, [REPO, TEMP]);
        assert.ok(soft);
        assert.equal(soft.hard, false, 'a nested git repo is a judgment call');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('survey', () => {
    it('classifies artifacts as safe', () => {
        const { data } = survey();
        for (const id of ['pw-results', 'desktop-stray-exe']) {
            assert.equal(bucketOf(data, id), 'safe', id);
        }
        assert.equal(bucketOf(data, 'tmp:floe-win-fixed.exe'), 'safe');
    });

    it('never puts a tracked file in the safe bucket', () => {
        const hit = survey().data.items.find(
            (i) => i.id === 'next-tsbuildinfo'
        );
        assert.equal(hit.bucket, 'never');
        assert.equal(hit.why, 'tracked by git');
    });

    it('fences the embedded desktop dist', () => {
        assert.equal(bucketOf(survey().data, 'desktop-dist'), 'never');
    });

    it('refuses a safe directory that carries a denied file', () => {
        const { data } = survey();
        for (const id of ['next-build', 'pw-report']) {
            const hit = data.items.find((i) => i.id === id);
            assert.equal(hit.bucket, 'never', id);
            assert.match(hit.why, /^carries /);
        }
    });

    it('puts reinstall-cost and ambiguous items in ask', () => {
        const { data } = survey();
        for (const id of [
            'nm-root',
            'root-exe',
            'untracked:.refactor-audit',
            'next-agents',
            'next-claude',
        ]) {
            if (bucketOf(data, id) === '(absent)') continue;
            assert.equal(bucketOf(data, id), 'ask', id);
        }
    });

    it('sorts scratchpads by age, not by name', () => {
        const { data } = survey();
        assert.equal(bucketOf(data, 'scratchpad:empty-session'), 'safe');
        assert.equal(bucketOf(data, 'scratchpad:stale-session'), 'safe');
        assert.equal(bucketOf(data, 'scratchpad:fresh-session'), 'ask');
    });

    it('holds a recently touched artifact when the age guard is armed', () => {
        const r = inRepo(REPO, TEMP, [
            'survey',
            '--json',
            '--age-minutes',
            '600',
        ]);
        const data = JSON.parse(r.stdout);
        assert.equal(bucketOf(data, 'pw-results'), 'held');
    });

    it('exits 1 when there is something to do', () => {
        assert.equal(survey().code, 1);
    });
});

describe('sweep', () => {
    it('deletes nothing without --apply', () => {
        const r = inRepo(REPO, TEMP, ['sweep', '--age-minutes', '0']);
        assert.equal(r.code, 1);
        assert.ok(fs.existsSync(path.join(REPO, 'desktop', 'desktop.exe')));
        assert.match(r.stdout, /dry run/);
    });

    it('refuses to promote a fenced or tracked id', () => {
        for (const id of ['desktop-dist', 'next-tsbuildinfo', 'next-build']) {
            const r = inRepo(REPO, TEMP, [
                'sweep',
                '--age-minutes',
                '0',
                '--include',
                id,
                '--apply',
            ]);
            assert.equal(r.code, 2, `--include ${id} must be a usage error`);
        }
    });

    it('refuses to promote an item another session may be writing', () => {
        const r = inRepo(REPO, TEMP, [
            'sweep',
            '--age-minutes',
            '600',
            '--include',
            'scratchpad:fresh-session',
            '--apply',
        ]);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /touched in the last/);
    });

    it('removes the safe bucket and nothing else', () => {
        const r = inRepo(REPO, TEMP, [
            'sweep',
            '--age-minutes',
            '0',
            '--apply',
        ]);
        assert.equal(r.code, 1);
        for (const p of [
            path.join(REPO, 'client', 'test-results'),
            path.join(REPO, 'desktop', 'desktop.exe'),
            path.join(TEMP, 'floe-win-fixed.exe'),
        ]) {
            assert.ok(!fs.existsSync(p), `${p} should have been swept`);
        }
        for (const p of DECOYS) {
            assert.ok(fs.existsSync(p), `DECOY DESTROYED: ${p}`);
        }
        for (const p of [
            path.join(REPO, 'floe.exe'),
            path.join(REPO, '.refactor-audit', 'notes.md'),
            path.join(REPO, 'node_modules', 'pkg', 'index.js'),
            path.join(TEMP, 'floe-audit', 'out', 'report.md'),
        ]) {
            assert.ok(fs.existsSync(p), `${p} is ask, it must survive`);
        }
    });

    it('is idempotent', () => {
        const r = inRepo(REPO, TEMP, [
            'sweep',
            '--age-minutes',
            '0',
            '--apply',
        ]);
        assert.equal(r.code, 0, 'a second sweep has nothing left to do');
    });

    it('promotes a single ask item by id when told to', () => {
        const target = path.join(REPO, 'floe.exe');
        assert.ok(fs.existsSync(target));
        const r = inRepo(REPO, TEMP, [
            'sweep',
            '--age-minutes',
            '0',
            '--include',
            'root-exe',
            '--apply',
        ]);
        assert.equal(r.code, 1);
        assert.ok(!fs.existsSync(target));
        assert.ok(
            fs.existsSync(path.join(REPO, 'node_modules', 'pkg', 'index.js'))
        );
        for (const p of DECOYS) assert.ok(fs.existsSync(p), `DECOY: ${p}`);
    });
});

describe('regressions (each one was a real, reproduced deletion)', () => {
    /**
     * An ancestor junction at client/ used to make tracked, committed files
     * classify as safe, because the fence resolved the path but the git
     * check and rmSync did not. Five committed files died.
     */
    it('an ancestor link cannot launder a tracked path into the safe bucket', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-anc-'));
        try {
            const repo = newRepo(base, 'repo');
            const temp = path.join(base, 'temp');
            fs.mkdirSync(temp, { recursive: true });
            w(
                path.join(repo, 'apps', 'web', 'test-results', 'baseline.png'),
                'p'
            );
            execFileSync('git', ['add', '-A'], { cwd: repo });
            const linked = tryLink(
                path.join(repo, 'apps', 'web'),
                path.join(repo, 'client')
            );
            if (!linked) return; // unprivileged box, nothing to assert

            const r = run([
                'survey',
                '--root',
                repo,
                '--temp-root',
                temp,
                '--json',
                '--age-minutes',
                '0',
            ]);
            const data = JSON.parse(r.stdout);
            const hit = data.items.find((i) => i.id === 'pw-results');
            if (hit) {
                assert.equal(
                    hit.bucket,
                    'never',
                    'must not be swept via a link'
                );
                assert.match(hit.why, /link|tracked/);
            }
            run([
                'sweep',
                '--root',
                repo,
                '--temp-root',
                temp,
                '--age-minutes',
                '0',
                '--apply',
            ]);
            assert.ok(
                fs.existsSync(
                    path.join(
                        repo,
                        'apps',
                        'web',
                        'test-results',
                        'baseline.png'
                    )
                ),
                'the committed file behind the link must survive'
            );
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });

    /** --root one level up used to widen the allow root and move the deny list. */
    it('refuses a --root that is not a Floe checkout', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-root-'));
        try {
            execFileSync('git', ['init', '-q'], { cwd: base });
            w(path.join(base, 'server', '.env'), 'SECRET');
            const r = run(['sweep', '--root', base, '--apply']);
            assert.equal(r.code, 3, 'no CLAUDE.md means refuse');
            assert.match(r.stderr, /does not look like a Floe checkout/);
            assert.ok(fs.existsSync(path.join(base, 'server', '.env')));
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });

    /** --keep used to be matched as a raw string against canonical paths. */
    it('--keep protects across equivalent spellings', () => {
        const target = path.join(REPO, 'client', 'blob-report');
        w(path.join(target, 'x.json'));
        const spellings = [
            target,
            target.replace(/\\/g, '/'),
            path.join(REPO, 'client', '..', 'client', 'blob-report'),
            'client/blob-report',
        ];
        for (const s of spellings) {
            const r = inRepo(REPO, TEMP, [
                'sweep',
                '--age-minutes',
                '0',
                '--keep',
                s,
                '--apply',
            ]);
            assert.notEqual(r.code, 2, `--keep ${s} should be accepted`);
            assert.ok(fs.existsSync(target), `--keep ${s} failed to protect`);
        }
        fs.rmSync(target, { recursive: true, force: true });
    });

    it('rejects a --keep that does not exist rather than silently ignoring it', () => {
        const r = inRepo(REPO, TEMP, ['survey', '--keep', 'no/such/path']);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /does not exist/);
    });

    /** A vanished candidate used to be counted as reclaimed bytes. */
    it('reports a vanished candidate honestly instead of claiming it', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-van-'));
        try {
            const repo = newRepo(base, 'repo');
            const temp = path.join(base, 'temp');
            fs.mkdirSync(temp, { recursive: true });
            w(path.join(repo, 'client', 'test-results', 'a.json'));
            const r = run([
                'sweep',
                '--root',
                repo,
                '--temp-root',
                temp,
                '--age-minutes',
                '0',
                '--apply',
            ]);
            assert.equal(r.code, 1);
            assert.match(r.stdout, /removed 1 item/);
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });
});

describe('regressions found by the second red team', () => {
    /**
     * scanContents returned the FIRST deny hit, so a soft .git met early
     * masked a hard .env met deeper. That is the layout of every copy of
     * this repo, and it downgraded never to ask, after which the documented
     * --include promotion deleted the secret.
     */
    it('severity, not traversal order, decides a carried refusal', () => {
        const dir = path.join(TEMP, 'masker');
        w(path.join(dir, '.git', 'HEAD'), 'ref');
        w(path.join(dir, 'sub', 'server', '.env'), 'SECRET');
        const hit = scanContents(dir, [REPO, TEMP]);
        assert.ok(hit, 'something must be found');
        assert.equal(hit.hard, true, 'the .env must win over the .git');
        assert.match(hit.path, /\.env$/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a masked secret keeps its directory out of the sweep entirely', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mask-'));
        try {
            const repo = newRepo(base, 'repo');
            const temp = path.join(base, 'temp');
            // The backslash matters: without it the slug keeps its separators,
            // path.join reads them as separators again, and the session is
            // never found. This assertion passed for months on that basis,
            // proving nothing about the mask it was written to catch.
            const slug = path.resolve(repo).replace(/[:\\/]/g, '-');
            const sess = path.join(temp, 'claude', slug, 'old-session');
            w(path.join(sess, '.git', 'HEAD'), 'ref');
            const secret = w(
                path.join(sess, 'fixture', 'server', '.env'),
                'LIVE'
            );
            age(sess, 30);
            const r = run([
                'sweep',
                '--root',
                repo,
                '--temp-root',
                temp,
                '--age-minutes',
                '0',
                '--include',
                `scratchpad:old-session`,
                '--apply',
            ]);
            assert.notEqual(r.code, 1, 'must not report a successful removal');
            assert.ok(fs.existsSync(secret), 'SECRET DESTROYED via the mask');
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });

    /** ".env " and ".env~" were classified safe and deleted. */
    it('catches editor backups and trailing-space spellings of .env', () => {
        const fence = makeFence(REPO, [], TEMP);
        for (const n of ['.env~', '.env.', '.env.swp', '.env.bak', '.envrc']) {
            assert.notEqual(
                fence(path.join(REPO, 'x', n)),
                null,
                `${n} must be refused`
            );
        }
        for (const n of [
            '.env.example',
            '.env.docker.example',
            '.environment',
        ]) {
            assert.equal(fence(path.join(REPO, 'x', n)), null, `${n} is fine`);
        }
    });

    /**
     * git ls-files stops at a submodule gitlink, so committed files under a
     * nested repo at client/ classified as safe. Four of them were deleted.
     */
    it('refuses a candidate inside a nested git repository', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sub-'));
        try {
            const repo = newRepo(base, 'repo');
            const temp = path.join(base, 'temp');
            fs.mkdirSync(temp, { recursive: true });
            const inner = path.join(repo, 'client');
            fs.mkdirSync(inner, { recursive: true });
            execFileSync('git', ['init', '-q'], { cwd: inner });
            const committed = w(
                path.join(inner, 'test-results', 'baseline.png'),
                'PNG'
            );
            execFileSync('git', ['add', '-A'], { cwd: inner });

            const r = run([
                'survey',
                '--root',
                repo,
                '--temp-root',
                temp,
                '--json',
                '--age-minutes',
                '0',
            ]);
            const hit = JSON.parse(r.stdout).items.find(
                (i) => i.id === 'pw-results'
            );
            if (hit) {
                assert.equal(hit.bucket, 'never');
                assert.match(hit.why, /nested git repository/);
            }
            run([
                'sweep',
                '--root',
                repo,
                '--temp-root',
                temp,
                '--age-minutes',
                '0',
                '--apply',
            ]);
            assert.ok(
                fs.existsSync(committed),
                'a file committed to the nested repo must survive'
            );
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });

    /** Invariant 2 leans on rmSync never following a link. Assert it. */
    it('rmSync unlinks a link without following it', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-rm-'));
        try {
            const victim = path.join(base, 'victim');
            const payload = w(path.join(victim, 'keep.txt'), 'KEEP');
            const holder = path.join(base, 'holder');
            fs.mkdirSync(holder);
            const link = tryLink(victim, path.join(holder, 'link'));
            if (!link) return;
            fs.rmSync(holder, { recursive: true, force: true });
            assert.ok(!fs.existsSync(holder), 'the holder is gone');
            assert.ok(fs.existsSync(payload), 'the link target must survive');
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });
});

describe('preconditions and usage', () => {
    it('exits 3 outside a git checkout', () => {
        assert.equal(inRepo(BASE, TEMP, ['survey']).code, 3);
    });

    it('exits 2 on an unknown command or option', () => {
        assert.equal(run(['scrub', '--root', REPO]).code, 2);
        assert.equal(run(['survey', '--root', REPO, '--wat']).code, 2);
    });

    it('exits 2 when --include names nothing', () => {
        const r = inRepo(REPO, TEMP, ['sweep', '--include', 'nope', '--apply']);
        assert.equal(r.code, 2);
    });

    it('self-test passes', () => {
        const r = run(['--self-test']);
        assert.equal(r.code, 0);
        assert.match(r.stdout, /self-test ok/);
    });
});

describe('parseFirewall', () => {
    it('keeps only rules whose program is gone', () => {
        const present = SCRIPT.replace(/\\/g, '\\\\');
        const rows = parseFirewall(`[
            {"Name":"gone","Action":"Block","Enabled":"False","Program":"C:\\\\nope\\\\floe.exe"},
            {"Name":"here","Action":"Allow","Enabled":"True","Program":"${present}"}
        ]`);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, 'gone');
        assert.equal(rows[0].action, 'Block');
    });

    it('tolerates a single object and malformed input', () => {
        assert.deepEqual(parseFirewall('not json'), []);
        assert.equal(
            parseFirewall('{"Name":"x","Program":"C:\\\\nope\\\\a.exe"}')
                .length,
            1
        );
    });
});

describe('the regression CI found on the skills job first real run', () => {
    /**
     * The allow roots were recorded under one spelling while every candidate
     * was matched under two, so a temp root whose real path differs from the
     * name it is reached by refused everything inside it. GitHub's Windows
     * runner hits this because os.tmpdir() reads %TEMP%, which Windows spells
     * C:\Users\RUNNER~1\... for the account runneradmin; macOS hits it
     * because os.tmpdir() returns /var/folders/... whose realpath is
     * /private/var/folders/.... Four tests failed on 2026-09-04 with one cause
     * between them: every candidate under the temp dir read as "outside the
     * allowed roots", which took the whole scratchpad bucket and --include
     * with it. The fence failed closed, so nothing was ever wrongly deleted.
     *
     * A directory reached through a link stands in for the short name: both
     * are one directory under two names, which is the property that broke,
     * and unlike an 8.3 name a link can be built on every platform.
     */
    it('allows a temp root reached by a name that is not its real path', () => {
        const real = path.join(BASE, 'aliased-real');
        const alias = path.join(BASE, 'aliased-link');
        fs.mkdirSync(path.join(real, 'work'), { recursive: true });
        try {
            fs.symlinkSync(
                real,
                alias,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch {
            return; // no symlink rights; the fixture cannot be built here
        }
        assert.notEqual(
            path.resolve(alias),
            fs.realpathSync.native(alias),
            'fixture is void unless the root has two spellings'
        );

        const fence = makeFence(REPO, [], alias);
        assert.equal(
            fence(path.join(alias, 'work')),
            null,
            'a candidate inside the temp root must not read as outside it'
        );
        // The same spelling-independence, in the direction where getting it
        // wrong deletes something: a denied path must bind under both names.
        for (const spelling of [alias, real]) {
            assert.notEqual(
                fence(path.join(spelling, 'floe-audit', 'bin')),
                null,
                `deny must bind through ${spelling}`
            );
        }
    });
/**
     * The same mismatch one function along. --root is realpathed on the way
     * in, but the scratchpad directory is named for the path the harness was
     * given, so the slug the lookup built could not match the slug on disk and
     * the whole bucket came back absent. That is what failed the age-sort and
     * the --include guard on CI, with the fence failure sitting on top of it.
     */
    it('finds the scratchpad when --root is not spelled as its real path', () => {
        const alias = tryLink(REPO, path.join(BASE, 'repo-alias'));
        if (!alias) return; // no symlink rights here
        const slug = path.resolve(alias).replace(/[:\\/]/g, '-');
        fs.mkdirSync(path.join(TEMP, 'claude', slug, 'aliased-session'), {
            recursive: true,
        });
        const r = run([
            'survey',
            '--json',
            '--age-minutes',
            '0',
            '--root',
            alias,
            '--temp-root',
            TEMP,
        ]);
        assert.equal(
            bucketOf(JSON.parse(r.stdout), 'scratchpad:aliased-session'),
            'safe'
        );
    });
});

describe('DC2: the request-link default folder, Downloads/Floe under the home directory', () => {
    /**
     * Floe Desktop saves each request-link drop in a new folder under
     * Downloads/Floe unless the owner picks another (requestDefaultDirFn in
     * desktop/requestlink.go). A drop is somebody's files under whatever
     * names the sender gave them, so no name rule can protect it, and until
     * this rule the folder was safe only because it happened to sit outside
     * both allow roots. The fixtures below put it inside one, which is the
     * only way to tell a rule from an accident. withHome points the home
     * directory at a fixture while fn runs, then puts it back.
     */
    function withHome(home, fn) {
        const saved = {
            USERPROFILE: process.env.USERPROFILE,
            HOME: process.env.HOME,
        };
        process.env.USERPROFILE = home;
        process.env.HOME = home;
        try {
            assert.equal(os.homedir(), home, 'fixture: the home moved');
            return fn();
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    }

    it('refuses the folder and everything under it, and nothing beside it', () => {
        // A home inside the fixture, with nothing in it: the fence only
        // reads, and the real Downloads folder plays no part.
        const home = path.join(BASE, 'home-plain');
        const downloads = path.join(home, 'Downloads');
        withHome(home, () => {
            const fence = makeFence(REPO, [], downloads);
            for (const p of [
                path.join(downloads, 'Floe'),
                path.join(downloads, 'Floe', 'floeprobe-holiday'),
                path.join(downloads, 'Floe', 'From Ana', 'IMG_0001.jpg'),
            ]) {
                assert.match(
                    String(fence(p)),
                    /^request-link drops/,
                    `fence should refuse ${p} by rule`
                );
            }
            // A folder that holds it is refused for holding it.
            assert.match(
                String(makeFence(REPO, [], home)(downloads)),
                /^contains .*request-link drops/
            );
            // The rule is the folder, not the word: its neighbors read as
            // they did before it existed.
            for (const p of [
                path.join(downloads, 'Floe-old'),
                path.join(downloads, 'Floe.zip'),
                path.join(downloads, 'floeprobe-x'),
            ]) {
                assert.equal(fence(p), null, `the rule must not reach ${p}`);
            }
        });
    });

    it('a debris-shaped name inside it is never swept, even when the folder is the temp root', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-drop-'));
        try {
            const repo = newRepo(base, 'repo');
            const home = path.join(base, 'home');
            const drops = path.join(home, 'Downloads', 'Floe');
            const media = w(path.join(drops, 'floeprobe-holiday.bin'), 'media');
            const folder = w(
                path.join(drops, 'floe-cmd-test-home-2333580544', 'IMG.jpg'),
                'media'
            );
            age(drops, 30);
            const args = [
                '--root',
                repo,
                '--temp-root',
                drops,
                '--age-minutes',
                '0',
            ];
            const data = JSON.parse(
                run(['survey', '--json', ...args], home).stdout
            );
            for (const id of [
                'tmp:floeprobe-holiday.bin',
                'tmp:floe-cmd-test-home-2333580544',
            ]) {
                const hit = data.items.find((i) => i.id === id);
                assert.ok(hit, `${id} should be considered and refused`);
                assert.equal(hit.bucket, 'never', id);
                assert.match(hit.why, /request-link drops/);
            }
            run(['sweep', '--apply', ...args], home);
            assert.ok(
                fs.existsSync(media),
                `RECEIVED FILE DESTROYED: ${media}`
            );
            assert.ok(
                fs.existsSync(folder),
                `RECEIVED FILE DESTROYED: ${folder}`
            );
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });

    /**
     * The direction that deletes something: a rule generated under one
     * spelling of the home directory does not bind a path reached under the
     * other, and with Downloads as an allow root that path would be
     * deletable. Downloads/Floe itself is deliberately absent from this
     * fixture, because realpath hands a missing path back as it was spelled,
     * which is exactly why the rule is generated per spelling and not
     * realpathed afterwards.
     */
    it('binds under both spellings of the home directory', () => {
        const made = path.join(BASE, 'home-real');
        fs.mkdirSync(path.join(made, 'Downloads'), { recursive: true });
        // The real spelling is what realpath gives, not what os.tmpdir()
        // handed out: on a GitHub Windows runner the temp directory comes as
        // an 8.3 short name (C:\Users\RUNNER~1), a third spelling that is
        // under neither allow root, so the fence refused it for that and the
        // rule was never the reason (the skills job, PR #538).
        const real = fs.realpathSync.native(made);
        const alias = tryLink(real, path.join(BASE, 'home-alias'));
        if (!alias) return; // no symlink rights here
        withHome(alias, () => {
            const fence = makeFence(REPO, [], path.join(alias, 'Downloads'));
            for (const spelling of [alias, real]) {
                const drop = path.join(
                    spelling,
                    'Downloads',
                    'Floe',
                    'drop',
                    'a.jpg'
                );
                assert.match(
                    String(fence(drop)),
                    /^request-link drops/,
                    `deny must bind through ${spelling}`
                );
            }
        });
    });

    it('is asserted by the built-in self-test', () => {
        const r = run(['--self-test']);
        assert.equal(r.code, 0, r.stdout);
        const count = Number(
            /self-test ok \((\d+) fence assertions\)/.exec(r.stdout)?.[1]
        );
        // 22 before the rule; it adds two against the default fence, three
        // against a fence whose temp root is Downloads, and three more for
        // the fallback folder against a fence whose temp root is the home.
        assert.ok(count >= 30, `only ${count} assertions: ${r.stdout}`);
    });

    /**
     * defaultReceiveDir in desktop/reveal.go returns the home directory
     * itself when it has no Downloads folder, so the default drop folder is
     * then Floe directly under the home directory. The same rule, the same
     * reason, and the same two ways to get it wrong.
     */
    it('Y2-2: the fallback folder, Floe directly under the home directory, is refused the same way', () => {
        const home = path.join(BASE, 'home-no-downloads');
        withHome(home, () => {
            const fence = makeFence(REPO, [], home);
            for (const p of [
                path.join(home, 'Floe'),
                path.join(home, 'Floe', 'floeprobe-holiday'),
                path.join(home, 'Floe', 'From Ana', 'IMG_0001.jpg'),
            ]) {
                assert.match(
                    String(fence(p)),
                    /^request-link drops/,
                    `fence should refuse ${p} by rule`
                );
            }
            for (const p of [
                path.join(home, 'Floe-old'),
                path.join(home, 'Floes'),
                path.join(home, 'Floe.zip'),
                path.join(home, 'floeprobe-x'),
            ]) {
                assert.equal(fence(p), null, `the rule must not reach ${p}`);
            }
        });
    });

    it('Y2-2: a debris-shaped name inside the fallback folder is never swept', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-drop2-'));
        try {
            const repo = newRepo(base, 'repo');
            // No Downloads folder in this home: the case the app falls back in.
            const home = path.join(base, 'home');
            const drops = path.join(home, 'Floe');
            const media = w(path.join(drops, 'floeprobe-holiday.bin'), 'media');
            age(drops, 30);
            const args = [
                '--root',
                repo,
                '--temp-root',
                drops,
                '--age-minutes',
                '0',
            ];
            const data = JSON.parse(
                run(['survey', '--json', ...args], home).stdout
            );
            const hit = data.items.find(
                (i) => i.id === 'tmp:floeprobe-holiday.bin'
            );
            assert.ok(hit, 'the file should be considered and refused');
            assert.equal(hit.bucket, 'never');
            assert.match(hit.why, /request-link drops/);
            run(['sweep', '--apply', ...args], home);
            assert.ok(
                fs.existsSync(media),
                `RECEIVED FILE DESTROYED: ${media}`
            );
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });

    it('Y2-2: the fallback rule binds under both spellings of the home directory', () => {
        const made = path.join(BASE, 'home2-real');
        fs.mkdirSync(made, { recursive: true });
        // realpath, for the reason the Downloads test above gives.
        const real = fs.realpathSync.native(made);
        const alias = tryLink(real, path.join(BASE, 'home2-alias'));
        if (!alias) return; // no symlink rights here
        withHome(alias, () => {
            // The home is the temp root, so both spellings are allow roots
            // and only the rule stands between a drop and a sweep.
            const fence = makeFence(REPO, [], alias);
            for (const spelling of [alias, real]) {
                assert.match(
                    String(fence(path.join(spelling, 'Floe', 'drop', 'a.jpg'))),
                    /^request-link drops/,
                    `deny must bind through ${spelling}`
                );
            }
        });
    });

    /**
     * On a case-insensitive disk a clone made in the home directory is
     * <home>/floe, which is the fallback folder's own path. Fencing it would
     * refuse every candidate in that checkout, so the fallback rule stands
     * down there and nowhere else; a drop inside such a checkout is an
     * untracked top-level folder, which is an ask item.
     */
    it('Y2-2: a checkout that itself is <home>/Floe is not fenced whole, and Downloads/Floe still is', () => {
        const home = path.join(BASE, 'home-with-clone');
        withHome(home, () => {
            const checkout = path.join(home, 'Floe');
            const fence = makeFence(checkout, [], path.join(home, 'tmp'));
            assert.equal(fence(path.join(checkout, 'client', '.next')), null);
            assert.match(
                String(
                    makeFence(
                        checkout,
                        [],
                        home
                    )(path.join(home, 'Downloads', 'Floe', 'drop'))
                ),
                /^request-link drops/
            );
        });
    });
});

describe('DC3: temp leftovers of test runs and audit runs', () => {
    let base;
    let repo;
    let temp;
    const OLD = [
        'floe-cmd-test-home-2333580544',
        'floe-desktop-test-home-3019364254',
    ];
    // What Node's mkdtemp leaves, and three names a person could have typed
    // that have the same shape: a six-letter word is six letters or digits.
    // No pattern can tell them apart, so the shape is never safe.
    const AUDIT_SHAPED = [
        'lta-cell-b8mOU7',
        'lta-request-XFjmPc',
        'lta-cell-backup',
        'lta-cell-traces',
        'lta-request-report',
    ];
    const FRESH = 'floe-cmd-test-home-777';
    // Names a person could have made. None may become a candidate.
    const LOOKALIKE_DIRS = [
        'floe-cmd-test-home',
        'floe-cmd-test-home-keep',
        'floe-desktop-test-home-12ab',
        'floe-web-test-home-123',
        'my-floe-cmd-test-home-123',
        'lta-cell-notes',
        'lta-cell-evidence-2026',
        'lta-cellar-abc123',
        'my-lta-cell-b8mOU7',
        'lta-request-XFjmPc-keep',
        'floe-audit-bin',
        'floe-audit-013205',
    ];
    const LOOKALIKE_FILES = [
        'floe-cmd-test-home-456',
        'lta-cell-AbCd12',
        'lta-request-XFjmPc.zip',
        path.join('floe-audit', 'notes.txt'),
    ];
    const RUN = 'shipped-20261011-1830';

    before(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-left-'));
        repo = newRepo(base, 'repo');
        temp = path.join(base, 'temp');
        for (const name of [...OLD, ...AUDIT_SHAPED]) {
            w(path.join(temp, name, 'floe', 'desktop.json'), '{}');
            age(path.join(temp, name), 2);
        }
        w(path.join(temp, FRESH, 'tmp', 'x'));
        for (const name of LOOKALIKE_DIRS) {
            w(path.join(temp, name, 'mine.txt'), 'mine');
            age(path.join(temp, name), 2);
        }
        for (const name of LOOKALIKE_FILES) {
            w(path.join(temp, name), 'mine');
            age(path.join(temp, name), 2);
        }
        w(path.join(temp, 'floe-audit', 'bin', 'floe.exe'));
        w(path.join(temp, 'floe-audit', 'out', 'report.md'));
        w(path.join(temp, 'floe-audit', RUN, 'r1', 'manifest.json'), '{}');
    });

    after(() => {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    });

    const surveyAt = (minutes) =>
        JSON.parse(
            run([
                'survey',
                '--json',
                '--root',
                repo,
                '--temp-root',
                temp,
                '--age-minutes',
                String(minutes),
            ]).stdout
        );

    it('an old go test home is safe, and a fresh one is held by the age guard', () => {
        const data = surveyAt(600);
        for (const name of OLD) {
            assert.equal(bucketOf(data, `tmp:${name}`), 'safe', name);
        }
        assert.equal(bucketOf(data, `tmp:${FRESH}`), 'held');
    });

    it('Y2-1: an lta-shaped folder is ask at any age, never safe', () => {
        for (const minutes of [0, 600]) {
            const data = surveyAt(minutes);
            for (const name of AUDIT_SHAPED) {
                assert.equal(
                    bucketOf(data, `tmp:${name}`),
                    'ask',
                    `${name} at --age-minutes ${minutes}`
                );
            }
        }
    });

    it('a look-alike the user owns is not a candidate at all', () => {
        const data = surveyAt(0);
        for (const name of [...LOOKALIKE_DIRS, ...LOOKALIKE_FILES]) {
            const p = path.join(temp, name);
            assert.equal(
                data.items.find(
                    (i) => path.resolve(i.path) === path.resolve(p)
                ),
                undefined,
                `${name} must not be matched`
            );
        }
    });

    it('an audit run folder under floe-audit is ask, and its bin is never a candidate', () => {
        const data = surveyAt(0);
        const hit = data.items.find((i) => i.id === `audit-run:${RUN}`);
        assert.ok(hit, 'the run folder is listed');
        assert.equal(hit.bucket, 'ask');
        assert.match(hit.why, /cleanup/);
        assert.equal(bucketOf(data, 'audit-evidence:floe-audit-out'), 'ask');
        assert.equal(bucketOf(data, 'audit-run:bin'), '(absent)');
        assert.equal(bucketOf(data, 'audit-run:out'), '(absent)');
        assert.notEqual(
            makeFence(repo, [], temp)(path.join(temp, 'floe-audit', 'bin')),
            null
        );
        // The age guard holds for a promotion too.
        const r = run([
            'sweep',
            '--root',
            repo,
            '--temp-root',
            temp,
            '--include',
            `audit-run:${RUN}`,
            '--apply',
        ]);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /touched in the last/);
    });

    it('Y2-1: a sweep removes the old go test homes, and no lta-shaped folder or look-alike', () => {
        const r = run([
            'sweep',
            '--root',
            repo,
            '--temp-root',
            temp,
            '--age-minutes',
            '600',
            '--apply',
        ]);
        assert.equal(r.code, 1, r.stdout + r.stderr);
        for (const name of OLD) {
            assert.ok(
                !fs.existsSync(path.join(temp, name)),
                `${name} should have been swept`
            );
        }
        for (const name of [
            FRESH,
            ...AUDIT_SHAPED,
            ...LOOKALIKE_DIRS,
            ...LOOKALIKE_FILES,
            path.join('floe-audit', 'bin', 'floe.exe'),
            path.join('floe-audit', 'out', 'report.md'),
            path.join('floe-audit', RUN, 'r1', 'manifest.json'),
        ]) {
            assert.ok(
                fs.existsSync(path.join(temp, name)),
                `DECOY DESTROYED: ${name}`
            );
        }
    });
});

describe('DC3: clones, worktrees and merged branches are reported, never swept', () => {
    const ORIGIN = 'https://example.invalid/jannskiee/floe.git';
    let base;
    let repo;
    let temp;
    let home;
    let kept;
    let family;
    let strangers;

    const git = (cwd, ...args) =>
        execFileSync(
            'git',
            [
                '-c',
                'commit.gpgsign=false',
                '-c',
                'user.name=deep-clean test',
                '-c',
                'user.email=test@example.invalid',
                ...args,
            ],
            { cwd, encoding: 'utf8' }
        );

    function clone(dir, origin) {
        fs.mkdirSync(dir, { recursive: true });
        git(dir, 'init', '-q');
        if (origin) git(dir, 'remote', 'add', 'origin', origin);
        w(path.join(dir, 'work.txt'), 'unpushed work');
        return dir;
    }

    before(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-clones-'));
        repo = newRepo(base, 'repo');
        temp = path.join(base, 'temp');
        home = path.join(base, 'home');
        fs.mkdirSync(temp, { recursive: true });
        git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        git(repo, 'remote', 'add', 'origin', ORIGIN);
        git(repo, 'commit', '-q', '-m', 'first');
        git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
        git(repo, 'branch', 'merged-topic');
        git(repo, 'branch', 'open-topic');
        git(
            repo,
            'worktree',
            'add',
            '-q',
            path.join(base, 'wt-open'),
            'open-topic'
        );
        w(path.join(base, 'wt-open', 'new.txt'), 'new');
        git(path.join(base, 'wt-open'), 'add', 'new.txt');
        git(path.join(base, 'wt-open'), 'commit', '-q', '-m', 'not merged');
        // A task branch with no commit yet sits on origin/main, and it is the
        // branch being worked on: it must not read as finished.
        git(repo, 'checkout', '-q', '-b', 'task-branch');
        // Neither must one that is being worked on in ANOTHER worktree.
        git(
            repo,
            'worktree',
            'add',
            '-q',
            path.join(base, 'wt-fresh'),
            '-b',
            'fresh-task'
        );
        w(path.join(base, 'wt-fresh', 'work.txt'), 'unpushed work');

        const slashed = (p) => p.replace(/\\/g, '/');
        // A clone of a clone: its origin is a folder, not the URL. Each one
        // is found only after the clone it points at, so the names are
        // chosen to be read in the wrong order.
        family = [
            // The way git records a local source on Windows.
            clone(
                path.join(base, 'clone-of-clone'),
                slashed(path.join(base, 'clone-same'))
            ),
            // Two steps from the URL, under the home directory, and on
            // Windows in the other case with native separators.
            clone(
                path.join(home, 'clone-of-clone-2'),
                process.platform === 'win32'
                    ? path.join(base, 'clone-of-clone').toUpperCase()
                    : path.join(base, 'clone-of-clone')
            ),
            // A file URL to the root itself.
            clone(path.join(base, 'clone-of-root'), pathToFileURL(repo).href),
        ];
        strangers = [
            // A clone of some other repository's clone, and of nothing.
            clone(
                path.join(base, 'clone-of-other'),
                slashed(path.join(base, 'clone-other'))
            ),
            clone(
                path.join(base, 'clone-of-gone'),
                slashed(path.join(base, 'gone'))
            ),
        ];

        kept = [
            ...family,
            ...strangers,
            path.join(base, 'wt-fresh'),
            // Same origin, next to the root: spelled without .git and in
            // another case, as a hand-typed clone URL can be.
            clone(
                path.join(base, 'clone-same'),
                'https://example.invalid/Jannskiee/floe'
            ),
            // Same origin, directly under the home directory.
            clone(path.join(home, 'clone-in-home'), ORIGIN),
            // Not this repository, or not a clone, or too deep to be listed.
            clone(
                path.join(base, 'clone-other'),
                'https://example.invalid/jannskiee/other.git'
            ),
            clone(path.join(base, 'clone-no-origin'), null),
            clone(path.join(home, 'nested', 'deeper-clone'), ORIGIN),
            path.join(base, 'wt-open'),
        ];
        fs.mkdirSync(path.join(base, 'not-a-repo'));
    });

    after(() => {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    });

    const args = () => [
        '--root',
        repo,
        '--temp-root',
        temp,
        '--age-minutes',
        '0',
    ];
    const note = (data, what) =>
        data.extras.externals.find((n) => n.what === what);
    // Compared as real paths: git and the temp directory do not always spell
    // one folder the same way (an 8.3 short name on a CI runner).
    const canon = (p) => fs.realpathSync.native(p).toLowerCase();
    const same = (a, b) =>
        assert.deepEqual(a.map(canon).sort(), b.map(canon).sort());

    it('lists clones of this repository beside the root and under the home directory', () => {
        const data = JSON.parse(
            run(['survey', '--json', ...args()], home).stdout
        );
        const clones = note(data, 'sibling clones');
        assert.ok(clones, 'the note exists');
        const listed = clones.list.map(canon);
        for (const p of [
            path.join(base, 'clone-same'),
            path.join(home, 'clone-in-home'),
        ]) {
            assert.ok(listed.includes(canon(p)), `${p} should be listed`);
        }
        assert.match(clones.detail, /never swept/);
    });

    it('Y2-4: lists a clone of a clone, however many steps from the URL, and no stranger', () => {
        const data = JSON.parse(
            run(['survey', '--json', ...args()], home).stdout
        );
        same(note(data, 'sibling clones').list, [
            path.join(base, 'clone-same'),
            path.join(home, 'clone-in-home'),
            ...family,
        ]);
    });

    it('Y2-3: lists linked worktrees, and as merged only a branch no worktree has checked out', () => {
        const data = JSON.parse(
            run(['survey', '--json', ...args()], home).stdout
        );
        same(note(data, 'git worktrees').list, [
            path.join(base, 'wt-open'),
            path.join(base, 'wt-fresh'),
        ]);
        const merged = note(data, 'merged branches');
        assert.ok(merged, 'the note exists');
        // Not main, not the unmerged open-topic, not task-branch, which is
        // checked out here, and not fresh-task, which is checked out in
        // another worktree.
        assert.deepEqual(merged.list, ['merged-topic']);
        assert.match(merged.detail, /squash/);
    });

    it('Y2-3: a checkout with no origin/main says nothing about merged branches, on either stream', () => {
        const plain = newRepo(base, 'no-remote');
        const r = spawnSync(
            process.execPath,
            [SCRIPT, 'survey', '--json', '--root', plain, '--temp-root', temp],
            {
                encoding: 'utf8',
                env: { ...process.env, USERPROFILE: home, HOME: home },
            }
        );
        assert.equal(r.stderr, '', 'nothing git said may reach the reader');
        assert.equal(note(JSON.parse(r.stdout), 'merged branches'), undefined);
    });

    it('none of it is a candidate, so no sweep and no --include can remove it', () => {
        const data = JSON.parse(
            run(['survey', '--json', ...args()], home).stdout
        );
        for (const p of kept) {
            assert.equal(
                data.items.find(
                    (i) =>
                        path.resolve(i.path).toLowerCase() ===
                        path.resolve(p).toLowerCase()
                ),
                undefined,
                `${p} must not be a candidate`
            );
        }
        for (const id of [
            'clone-same',
            'sibling clones',
            'git worktrees',
            'merged-topic',
            path.join(base, 'clone-same'),
        ]) {
            const r = run(
                ['sweep', '--include', id, '--apply', ...args()],
                home
            );
            assert.equal(r.code, 2, `--include ${id} must be a usage error`);
            assert.match(r.stderr, /matches no candidate/);
        }
        run(['sweep', '--apply', ...args()], home);
        for (const p of kept) {
            assert.ok(
                fs.existsSync(path.join(p, 'work.txt')) ||
                    fs.existsSync(path.join(p, 'new.txt')),
                `CLONE DESTROYED: ${p}`
            );
        }
        const branches = git(repo, 'branch', '--format=%(refname:short)')
            .split(/\r?\n/)
            .filter(Boolean)
            .sort();
        assert.deepEqual(branches, [
            'fresh-task',
            'main',
            'merged-topic',
            'open-topic',
            'task-branch',
        ]);
    });

    it('prints the three notes under "not swept, reported only"', () => {
        const r = run(['survey', ...args()], home);
        const tail = r.stdout.slice(
            r.stdout.indexOf('not swept, reported only')
        );
        assert.match(tail, /^ {2}sibling clones +5 clone\(s\) /m);
        assert.match(tail, /clone-same$/m);
        assert.match(tail, /^ {2}merged branches +1 local branch\(es\) /m);
        assert.match(tail, /^ {2}git worktrees +3 checked out$/m);
    });
});

describe('Y2-5: the listeners note names an owner only when floe-run left a pidfile', () => {
    const LISTENERS = [{ Port: 3001, Proc: 'node', Pid: 4242 }];

    it('with a pidfile, it points at floe-run stop', () => {
        const lines = deepClean.listenerNote(LISTENERS, true);
        assert.ok(lines.some((l) => l.includes(':3001 node pid 4242')));
        assert.ok(
            lines.some((l) =>
                l.includes(
                    'owner: node .claude/skills/floe-run/scripts/floe-run.mjs stop'
                )
            ),
            lines.join('\n')
        );
    });

    it('without one, it names no owner and says whose stack this is not', () => {
        const lines = deepClean.listenerNote(LISTENERS, false);
        assert.ok(lines.some((l) => l.includes(':3001 node pid 4242')));
        assert.ok(
            !lines.some((l) => l.includes('floe-run.mjs stop')),
            lines.join('\n')
        );
        assert.ok(
            lines.some((l) => /no floe-run pidfile/.test(l)),
            lines.join('\n')
        );
        assert.ok(lines.some((l) => /never kills/.test(l)));
    });

    it('prints nothing when nothing is listening', () => {
        assert.deepEqual(deepClean.listenerNote([], true), []);
        assert.deepEqual(deepClean.listenerNote([], false), []);
    });

    it('the survey reads the pidfile from the temp root it was given', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pid-'));
        try {
            const repo = newRepo(base, 'repo');
            const temp = path.join(base, 'temp');
            fs.mkdirSync(temp, { recursive: true });
            const pidfile = () =>
                JSON.parse(
                    run([
                        'survey',
                        '--json',
                        '--root',
                        repo,
                        '--temp-root',
                        temp,
                    ]).stdout
                ).extras.floeRunPidfile;
            assert.equal(pidfile(), false);
            w(path.join(temp, 'floe-run.json'), '{}');
            assert.equal(pidfile(), true);
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
        }
    });
});

describe('the entry point', () => {
    // node keeps a junction (or a symlinked folder) in argv[1] and resolves it
    // in import.meta.url. A guard that compared the two unresolved skipped
    // main and exited 0, which is deep-clean's "nothing to do".
    it('runs main when started through a junction (usage error, exit 2)', (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-entry-'));
        const link = path.join(dir, 'scripts');
        try {
            if (!tryLink(path.dirname(SCRIPT), link)) {
                t.skip('cannot make a directory link here');
                return;
            }
            const r = spawnSync(
                process.execPath,
                [path.join(link, 'deep-clean.mjs'), '--age-minutes'],
                { encoding: 'utf8', windowsHide: true }
            );
            assert.equal(r.status, 2, r.stdout + r.stderr);
            assert.match(
                r.stderr,
                /^usage error: --age-minutes needs a value/m
            );
        } finally {
            try {
                fs.unlinkSync(link);
            } catch {
                // never made
            }
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
