// node --test .claude/skills/<skill>/scripts/lib/args.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
    FLAGS,
    SUBCOMMANDS,
    USAGE,
    UsageError,
    parseArgs,
    parseCellPatterns,
} from './args.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'lta-args-'));
writeFileSync(path.join(root, 'CLAUDE.md'), '# fake');
mkdirSync(path.join(root, 'client'));
writeFileSync(path.join(root, 'client', 'package.json'), '{}');
const fs = await import('node:fs');
after(() => rmSync(root, { recursive: true, force: true }));

const parse = (argv) => parseArgs(argv, { defaultRoot: root, fs });

test('subcommands and defaults', () => {
    for (const cmd of SUBCOMMANDS) {
        const { cmd: c, opts } = parse([cmd]);
        assert.equal(c, cmd);
        assert.equal(opts.profile, 'shipped');
        assert.equal(opts.desktop, 'auto');
        assert.equal(opts.subset, 'default');
        assert.equal(opts.pauseMaxMin, 10);
        assert.equal(opts.root, path.resolve(root));
        assert.equal(opts.clientDir, path.join(path.resolve(root), 'client'));
    }
});

test('every flag on run parses', () => {
    const { opts } = parse([
        'run',
        '--profile',
        'head',
        '--quick',
        '--cells',
        'S-DIR-*,H-REL-W2C',
        '--desktop',
        'portable',
        '--bin-dir',
        'bin',
        '--pin',
        '--strict',
        '--pion-trace',
        '--user-away',
        '--pause-max',
        '5',
        '--web-sha',
        'ABCDEF1',
        '--server-sha',
        '0123456789abcdef',
        '--keep',
        '--dry-run',
        '--relaxed',
        '--out',
        'out',
        '--json',
    ]);
    assert.equal(opts.profile, 'head');
    assert.equal(opts.subset, 'quick');
    assert.deepEqual(opts.cells, ['S-DIR-*', 'H-REL-W2C']);
    assert.equal(opts.desktop, 'portable');
    assert.equal(opts.binDir, path.resolve('bin'));
    assert.ok(
        opts.pin &&
            opts.strict &&
            opts.pionTrace &&
            opts.userAway &&
            opts.keep &&
            opts.dryRun &&
            opts.relaxed &&
            opts.json
    );
    assert.equal(opts.pauseMaxMin, 5);
    assert.equal(opts.webSha, 'abcdef1');
    assert.equal(opts.serverSha, '0123456789abcdef');
    assert.equal(opts.out, path.resolve('out'));
});

test('--deep sets the deep subset', () => {
    assert.equal(parse(['run', '--deep']).opts.subset, 'deep');
});

test('usage errors carry exit 2', () => {
    const bad = [
        [],
        ['bogus'],
        ['--json'],
        ['run', '--quick', '--deep'],
        ['run', '--nope'],
        ['run', '--profile', 'prod'],
        ['run', '--desktop', 'phone'],
        ['run', '--pause-max', '0'],
        ['run', '--web-sha', 'xyz'],
        ['run', '--web-sha', 'abcdef1', '--web-sha-file', 'x.json'],
        ['run', '--relaxed'],
        ['run', '--cells'],
        ['run', '--cells', 'S-DIR-W2W;drop'],
        ['run', '--json', '--json'],
        ['versions', '--quick'],
        ['cleanup', '--profile', 'head'],
        ['probe', '--dry-run'],
        ['cleanup', '--run', 'bad id'],
        ['run', '--root', path.join(root, 'nowhere')],
    ];
    for (const argv of bad) {
        if (argv.length === 0) {
            assert.equal(parse(argv).cmd, 'help');
            continue;
        }
        assert.throws(
            () => parse(argv),
            (e) => e instanceof UsageError && e.exitCode === 2,
            argv.join(' ')
        );
    }
});

test('cleanup --last names the newest run; --last is cleanup-only and excludes --run', () => {
    const { opts } = parse(['cleanup', '--last']);
    assert.equal(opts.last, true);
    assert.equal(opts.run, null);
    assert.equal(parse(['cleanup', '--run', 'abc']).opts.last, false);
    for (const argv of [
        ['run', '--last'],
        ['cleanup', '--run', 'abc', '--last'],
    ])
        assert.throws(
            () => parse(argv),
            (e) => e instanceof UsageError && e.exitCode === 2,
            argv.join(' ')
        );
    assert.match(USAGE, /--run <id> \| --last/);
});

test('common flags parse on every subcommand; cleanup takes --desktop and --bin-dir; profileGiven is recorded', () => {
    // One flag set can be reused across probe, run, versions and cleanup.
    const common = [
        '--root',
        root,
        '--client-dir',
        path.join(root, 'client'),
        '--out',
        path.join(root, 'out'),
        '--json',
    ];
    for (const cmd of SUBCOMMANDS) {
        const { opts } = parse([cmd, ...common]);
        assert.equal(opts.json, true, cmd);
        assert.equal(
            opts.clientDir,
            path.join(path.resolve(root), 'client'),
            cmd
        );
    }
    const c = parse(['cleanup', '--desktop', 'none', '--bin-dir', root]).opts;
    assert.equal(c.desktop, 'none');
    assert.equal(c.binDir, path.resolve(root));
    assert.equal(
        parse(['versions', '--desktop', 'store']).opts.desktop,
        'store'
    );
    assert.equal(parse(['run']).opts.profileGiven, false);
    assert.equal(
        parse(['run', '--profile', 'shipped']).opts.profileGiven,
        true
    );
    assert.equal(parse(['probe', '--profile', 'head']).opts.profileGiven, true);
    assert.match(USAGE, /accepted on every subcommand/);
});

test('--self-test wins over everything', () => {
    assert.equal(parse(['run', '--self-test']).cmd, 'self-test');
    assert.equal(parse(['--self-test']).cmd, 'self-test');
});

test('--root without CLAUDE.md is refused; --client-dir must hold package.json', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'lta-args-nowhere-'));
    try {
        assert.throws(() => parse(['run', '--root', other]), /CLAUDE\.md/);
        assert.throws(
            () => parse(['run', '--client-dir', other]),
            /package\.json/
        );
        assert.equal(parse(['versions', '--root', root]).cmd, 'versions');
    } finally {
        rmSync(other, { recursive: true, force: true });
    }
});

test('cell patterns and flag table are consistent', () => {
    assert.deepEqual(parseCellPatterns(' S-DIR-W2W , S-REL-* '), [
        'S-DIR-W2W',
        'S-REL-*',
    ]);
    assert.throws(() => parseCellPatterns(' , '), UsageError);
    for (const [flag, spec] of Object.entries(FLAGS)) {
        assert.ok(flag.startsWith('--'));
        assert.ok(
            spec.cmds.every((c) => SUBCOMMANDS.includes(c)),
            flag
        );
        assert.ok(USAGE.includes(flag), `${flag} missing from USAGE`);
    }
    assert.ok(USAGE.includes('130 interrupted'));
});

test('--monitor takes secondary, primary, off or an index, and defaults to secondary', () => {
    const R = ['--root', process.cwd()];
    const run = (...extra) => parseArgs(['run', ...R, ...extra]).opts;
    assert.equal(run().monitor, 'secondary');
    for (const v of ['secondary', 'primary', 'off', '1', '2', '10'])
        assert.equal(run('--monitor', v).monitor, v, v);
    for (const v of ['0', '-1', 'left', 'Secondary', '1.5'])
        assert.throws(
            () => run('--monitor', v),
            /--monitor wants/,
            JSON.stringify(v)
        );
    assert.throws(() => parseArgs(['run', ...R, '--monitor']), /--monitor/);
    // The purge is on by default; --keep-data opts out and is run-only.
    assert.equal(run().keepData, false);
    assert.equal(run('--keep-data').keepData, true);
    assert.throws(
        () => parseArgs(['versions', ...R, '--keep-data']),
        /--keep-data/
    );
});
