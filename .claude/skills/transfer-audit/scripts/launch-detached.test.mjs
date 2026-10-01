// launch-detached.mjs on fixtures (FU-26): an injected detach and lister,
// so nothing starts and no process list is read.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { SPEC_VAR, SW, logWrapped } from './lib/detached.mjs';
import { main, parseArgs, startsFloe } from './launch-detached.mjs';

function io() {
    const o = { out: [], err: [], calls: [] };
    o.detach = async (spec) => {
        o.calls.push(spec);
        return { pid: 3131 };
    };
    return o;
}

test('parseArgs: options before --, the command and its args after, usage errors named', () => {
    const p = parseArgs(['--cwd', 'desktop', '--log', 'dev.log', '--', 'wails', 'dev']);
    assert.equal(p.cwd, path.resolve('desktop'));
    assert.equal(p.log, path.resolve('dev.log'));
    assert.equal(p.command, 'wails');
    assert.deepEqual(p.args, ['dev']);
    assert.match(parseArgs(['--', ]).error, /no command/);
    assert.match(parseArgs(['--cwd']).error, /--cwd needs a value/);
    assert.match(parseArgs(['wails', 'dev']).error, /unknown argument wails/);
});

test('startsFloe: the desktop exes and wails dev, nothing else', () => {
    assert.ok(startsFloe('C:\\b\\floe-desktop.exe', []));
    assert.ok(startsFloe('floe-desktop-dev.exe', []));
    assert.ok(startsFloe('wails', ['dev']));
    assert.ok(startsFloe('C:\\go\\bin\\wails.exe', ['dev', '-loglevel', 'Info']));
    assert.ok(!startsFloe('wails', ['build']));
    assert.ok(!startsFloe('C:\\x\\fg-probe.exe', ['window', '5']));
    assert.ok(!startsFloe('floe.exe', ['receive']));
});

test('logWrapped: a hidden cmd.exe appending both streams, and no cmd.exe metacharacter ever reaches it', () => {
    assert.deepEqual(logWrapped('wails', ['dev'], 'C:\\l\\dev.log'), {
        rawCommandLine: 'cmd.exe /d /s /c "wails dev >> "C:\\l\\dev.log" 2>&1"',
        show: SW.HIDE,
    });
    assert.equal(
        logWrapped('C:\\Program Files\\x.exe', ['a b'], 'C:\\l.log').rawCommandLine,
        'cmd.exe /d /s /c ""C:\\Program Files\\x.exe" "a b" >> "C:\\l.log" 2>&1"'
    );
    for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', 'a"b'])
        assert.throws(() => logWrapped('wails', ['dev', bad], 'C:\\l.log'), /cmd\.exe would read/);
    assert.throws(() => logWrapped('wails', ['dev'], 'C:\\l&x.log'), /cmd\.exe would read/);
});

test('main: a GUI exe starts directly with the whole env and no spec variable; wails dev with --log goes through the hidden wrapper', async () => {
    const a = io();
    const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\w', [SPEC_VAR]: 'stale' };
    assert.equal(await main(['--', 'C:\\x\\fg-probe.exe', 'window', '5'], { detach: a.detach, env, out: (s) => a.out.push(s), err: (s) => a.err.push(s) }), 0);
    assert.deepEqual(a.out, ['pid 3131']);
    assert.deepEqual(a.calls[0], {
        command: 'C:\\x\\fg-probe.exe',
        args: ['window', '5'],
        cwd: null,
        env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\w' },
    });
    const b = io();
    const code = await main(['--cwd', 'C:\\r\\desktop', '--log', 'C:\\l\\dev.log', '--', 'wails', 'dev'], {
        detach: b.detach,
        lister: async () => [],
        env: { PATH: 'C:\\w' },
        out: (s) => b.out.push(s),
        err: (s) => b.err.push(s),
    });
    assert.equal(code, 0, b.err.join('\n'));
    assert.equal(b.calls[0].rawCommandLine, 'cmd.exe /d /s /c "wails dev >> "C:\\l\\dev.log" 2>&1"');
    assert.equal(b.calls[0].show, SW.HIDE);
    assert.equal(b.calls[0].cwd, 'C:\\r\\desktop');
});

test('main refuses a second Floe instance (exit 3) and names what runs; a refused create is exit 1; usage is exit 2', async () => {
    const a = io();
    const code = await main(['--', 'wails', 'dev'], {
        detach: a.detach,
        lister: async () => [{ image: 'floe-desktop.exe', pid: 77 }],
        out: (s) => a.out.push(s),
        err: (s) => a.err.push(s),
    });
    assert.equal(code, 3);
    assert.equal(a.calls.length, 0, 'nothing was started');
    assert.match(a.err.join('\n'), /floe-desktop\.exe pid 77 already runs/);
    const b = io();
    const failing = async () => {
        throw new Error('detached launch: Win32_Process.Create returned 9 (path not found)');
    };
    assert.equal(await main(['--', 'C:\\nope\\x.exe'], { detach: failing, out: () => {}, err: (s) => b.err.push(s) }), 1);
    assert.match(b.err.join('\n'), /returned 9 \(path not found\)/);
    assert.equal(await main(['nope'], { detach: a.detach, out: () => {}, err: () => {} }), 2);
    assert.equal(await main(['--log', 'C:\\l.log', '--', 'wails', 'dev', 'a&b'], { detach: a.detach, lister: async () => [], out: () => {}, err: () => {} }), 2);
});
