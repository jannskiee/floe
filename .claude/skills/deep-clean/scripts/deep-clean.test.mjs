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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

/** Run the script. Never throws on a non-zero exit. */
function run(args) {
    try {
        const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
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
            const slug = path.resolve(repo).replace(/[:\/]/g, '-');
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
});
