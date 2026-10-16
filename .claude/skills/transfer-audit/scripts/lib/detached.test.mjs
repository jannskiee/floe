// lib/detached.mjs on fixtures (FU-26): the command line, the spec, the
// hidden PowerShell side and every answer, with an injected execFile, so
// nothing is ever started. The live proof (a harmless probe exe, fg-logger)
// is plan-folder evidence, not a test: it needs the owner away.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ACTIVATE_PS,
    ACTIVATE_SPEC_VAR,
    CREATE_RESULTS,
    DETACHED_PS,
    SPEC_VAR,
    SW,
    commandLine,
    detachedArgs,
    detachedSpec,
    envList,
    launchActivated,
    launchDetached,
    launchDirect,
    parseActivateOutput,
    parseDetachedOutput,
    quoteArg,
} from './detached.mjs';

test('quoteArg and commandLine write what CommandLineToArgvW reads back', () => {
    assert.equal(quoteArg('plain'), 'plain');
    assert.equal(quoteArg(''), '""');
    assert.equal(quoteArg('a b'), '"a b"');
    assert.equal(quoteArg('C:\\Program Files\\Floe\\floe-desktop.exe'), '"C:\\Program Files\\Floe\\floe-desktop.exe"');
    // A backslash run is literal unless a quote or the closing quote follows it.
    assert.equal(quoteArg('ends\\'), 'ends\\');
    assert.equal(quoteArg('dir with space\\'), '"dir with space\\\\"');
    assert.equal(quoteArg('q"uote'), '"q\\"uote"');
    assert.equal(quoteArg('back\\\\"q'), '"back\\\\\\\\\\"q"');
    assert.equal(
        commandLine('C:\\x y\\floe-desktop.exe', ['C:\\f 1.bin', 'b']),
        '"C:\\x y\\floe-desktop.exe" "C:\\f 1.bin" b'
    );
});

test('envList keeps NAME=value pairs and drops the per-drive and empty entries', () => {
    assert.deepEqual(
        envList({ PATH: 'C:\\w', '=C:': 'C:\\x', '': 'y', APPDATA: 'C:\\s\\appdata', GONE: undefined, NIL: null }),
        ['PATH=C:\\w', 'APPDATA=C:\\s\\appdata']
    );
});

test('detachedSpec: SW_SHOWNOACTIVATE by default, env null means the user default environment, a bad show or no command throws', () => {
    const s = detachedSpec({ command: 'C:\\a b\\x.exe', args: ['f'], cwd: 'C:\\a b' });
    assert.deepEqual(s, { commandLine: '"C:\\a b\\x.exe" f', cwd: 'C:\\a b', env: null, show: SW.SHOWNOACTIVATE });
    assert.deepEqual(detachedSpec({ command: 'x', env: { A: '1' }, show: SW.HIDE }).env, ['A=1']);
    assert.throws(() => detachedSpec({ command: 'x', show: 5 }), /show 5/);
    assert.throws(() => detachedSpec({ args: ['a'] }), /a command is required/);
});

test('the PowerShell side reads the spec from its own environment and calls Win32_Process.Create with the startup info', () => {
    assert.match(DETACHED_PS, new RegExp(`\\$env:${SPEC_VAR}`));
    assert.match(DETACHED_PS, /\[wmiclass\]'Win32_ProcessStartup'/);
    assert.match(DETACHED_PS, /\$startup\.ShowWindow = \[uint16\]\$spec\.show/);
    assert.match(DETACHED_PS, /\$startup\.EnvironmentVariables = \[string\[\]\]@\(\$spec\.env\)/);
    assert.match(DETACHED_PS, /\[wmiclass\]'Win32_Process'\)\.Create\(\[string\]\$spec\.commandLine, \$cwd, \$startup\)/);
    const args = detachedArgs();
    assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    assert.equal(Buffer.from(args[5], 'base64').toString('utf16le'), DETACHED_PS);
});

test('parseDetachedOutput finds the one answer line and nothing else', () => {
    assert.deepEqual(parseDetachedOutput('noise\n{"returnValue":0,"pid":4321}'), { returnValue: 0, pid: 4321 });
    assert.deepEqual(parseDetachedOutput('{"returnValue":9,"pid":0}'), { returnValue: 9, pid: 0 });
    assert.equal(parseDetachedOutput(''), null);
    assert.equal(parseDetachedOutput('{"pid":1}'), null);
});

function fakeExec(stdout, err = null) {
    const calls = [];
    const impl = (file, args, opts, cb) => {
        calls.push({ file, args, opts });
        setImmediate(() => cb(err, stdout, ''));
        return { on() {} };
    };
    return { impl, calls };
}

test('launchDetached runs one hidden powershell.exe whose spec rides its env, never its command line, and resolves the pid', async () => {
    const f = fakeExec('{"returnValue":0,"pid":5150}');
    const env = { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\s\\appdata', SECRETISH: 'value-that-must-stay-off-argv' };
    const r = await launchDetached(
        { command: 'C:\\s\\floe-desktop.exe', args: ['C:\\in\\a.bin'], cwd: 'C:\\s', env },
        { execFileImpl: f.impl, baseEnv: { SystemRoot: 'C:\\Windows' } }
    );
    assert.deepEqual(r, { pid: 5150 });
    assert.equal(f.calls.length, 1);
    const [c] = f.calls;
    assert.equal(c.file, 'powershell.exe');
    assert.equal(c.opts.windowsHide, true, 'the launcher itself never shows a console (FU-02)');
    assert.ok(c.opts.timeout > 0);
    const argv = c.args.join(' ');
    assert.ok(!argv.includes('floe-desktop.exe') && !argv.includes('value-that-must-stay-off-argv'), argv);
    const spec = JSON.parse(Buffer.from(c.opts.env[SPEC_VAR], 'base64').toString('utf8'));
    assert.equal(spec.commandLine, 'C:\\s\\floe-desktop.exe C:\\in\\a.bin');
    assert.equal(spec.cwd, 'C:\\s');
    assert.equal(spec.show, SW.SHOWNOACTIVATE);
    assert.deepEqual(spec.env, ['SystemRoot=C:\\Windows', 'APPDATA=C:\\s\\appdata', 'SECRETISH=value-that-must-stay-off-argv']);
    assert.equal(c.opts.env.SystemRoot, 'C:\\Windows', 'the powershell child keeps its own base env');
});

test('launchDetached rejects a refused create or a missing answer with the reason and never the spec', async () => {
    const env = { TOKENISH: 'abc123-never-in-an-error' };
    const refused = fakeExec('{"returnValue":9,"pid":0}');
    await assert.rejects(
        launchDetached({ command: 'C:\\nope\\x.exe', env }, { execFileImpl: refused.impl, baseEnv: {} }),
        (e) => {
            assert.match(e.message, /returned 9 \(path not found\)/);
            assert.ok(!e.message.includes('abc123') && !e.message.includes('nope'), e.message);
            return true;
        }
    );
    const silent = fakeExec('', new Error('Command failed: powershell.exe\nsome detail'));
    await assert.rejects(
        launchDetached({ command: 'x.exe', env }, { execFileImpl: silent.impl, baseEnv: {} }),
        /gave no answer \(Command failed: powershell\.exe\)/
    );
    assert.equal(CREATE_RESULTS[2], 'access denied');
});

// F1 (field run 2026-10-11): Win32_Process.Create answered 2 (access denied)
// for the Store package's exe when it carried files. The caller decides what
// to do with that, so the number rides the rejection.
test('launchDetached puts the Win32_Process.Create return value on its rejection, and none on a missing answer', async () => {
    for (const code of [2, 9]) {
        const refused = fakeExec(`{"returnValue":${code},"pid":0}`);
        await assert.rejects(
            launchDetached(
                { command: 'C:\\x\\floe-desktop.exe' },
                { execFileImpl: refused.impl, baseEnv: {} }
            ),
            (e) => {
                assert.equal(e.returnValue, code);
                assert.match(
                    e.message,
                    new RegExp(`returned ${code} \\(${CREATE_RESULTS[code]}\\)`)
                );
                return true;
            }
        );
    }
    const silent = fakeExec('', new Error('Command failed: powershell.exe'));
    await assert.rejects(
        launchDetached(
            { command: 'x.exe' },
            { execFileImpl: silent.impl, baseEnv: {} }
        ),
        (e) => {
            assert.equal(
                e.returnValue,
                undefined,
                'no answer is not an answer of 2'
            );
            return true;
        }
    );
});

// F1b (2026-10-16): the Store exe with files, started the way Start starts it.
test('launchActivated sends the AUMID and the quoted files through its env, never its command line, and resolves the pid', async () => {
    const f = fakeExec('{"pid":8484}');
    const r = await launchActivated(
        { aumid: 'Pkg_r1y5w9chaxnzc!App', args: ['C:\\in\\a b.bin', 'C:\\in\\c.bin'] },
        { execFileImpl: f.impl, baseEnv: { SystemRoot: 'C:\\Windows' } }
    );
    assert.deepEqual(r, { pid: 8484 });
    const [c] = f.calls;
    assert.equal(c.file, 'powershell.exe');
    assert.equal(c.opts.windowsHide, true);
    assert.ok(!c.args.join(' ').includes('a b.bin'), 'no file name on the command line');
    const spec = JSON.parse(Buffer.from(c.opts.env[ACTIVATE_SPEC_VAR], 'base64').toString('utf8'));
    assert.deepEqual(spec, { aumid: 'Pkg_r1y5w9chaxnzc!App', arguments: '"C:\\in\\a b.bin" C:\\in\\c.bin' });
    assert.match(ACTIVATE_PS, /IApplicationActivationManager/);
    assert.match(ACTIVATE_PS, /\[PreserveSig\] int ActivateApplication/);
    assert.match(ACTIVATE_PS, /^'@$/m, 'the here-string closes at column 0');
});

test('launchActivated rejects a failed activation with its HRESULT and a missing answer with the reason, never the files', async () => {
    const failed = fakeExec('{"hresult":"0x80073CF1"}');
    await assert.rejects(
        launchActivated({ aumid: 'X!Y', args: ['C:\\secret-name.bin'] }, { execFileImpl: failed.impl, baseEnv: {} }),
        (e) => {
            assert.equal(e.message, 'package activation failed (0x80073CF1)');
            return true;
        }
    );
    const silent = fakeExec('', new Error('Command failed: powershell.exe\nmore'));
    await assert.rejects(
        launchActivated({ aumid: 'X!Y', args: [] }, { execFileImpl: silent.impl, baseEnv: {} }),
        /^Error: package activation gave no answer \(Command failed: powershell\.exe\)$/
    );
    assert.throws(() => launchActivated({ aumid: '' }), /an AUMID is required/);
    assert.deepEqual(parseActivateOutput('noise {"pid":7} noise'), { pid: 7 });
    assert.deepEqual(parseActivateOutput('{"hresult":"0x80070005"}'), { hresult: '0x80070005' });
    assert.equal(parseActivateOutput('{"pid":"7"}'), null);
});

function fakeSpawn({ pid = 7272, fail = null } = {}) {
    const calls = [];
    const impl = (command, args, options) => {
        const handlers = {};
        const child = {
            pid: fail ? undefined : pid,
            unrefs: 0,
            unref() {
                child.unrefs += 1;
            },
            once(ev, fn) {
                handlers[ev] = fn;
                return child;
            },
        };
        calls.push({ command, args, options, child });
        setImmediate(() => (fail ? handlers.error(fail) : handlers.spawn()));
        return child;
    };
    return { impl, calls };
}

test('launchDirect spawns the exe itself, detached with no pipes, lets go of it and resolves the pid', async () => {
    const f = fakeSpawn();
    const r = await launchDirect(
        {
            command: 'C:\\Program Files\\WindowsApps\\Floe\\floe-desktop.exe',
            args: ['C:\\in\\a b.bin'],
            cwd: 'C:\\Program Files\\WindowsApps\\Floe',
        },
        { spawnImpl: f.impl }
    );
    assert.deepEqual(r, { pid: 7272 });
    assert.equal(f.calls.length, 1);
    const [c] = f.calls;
    assert.equal(
        c.command,
        'C:\\Program Files\\WindowsApps\\Floe\\floe-desktop.exe'
    );
    assert.deepEqual(
        c.args,
        ['C:\\in\\a b.bin'],
        'argv as an array: no shell, no quoting'
    );
    assert.deepEqual(c.options, {
        cwd: 'C:\\Program Files\\WindowsApps\\Floe',
        detached: true,
        stdio: 'ignore',
    });
    assert.equal(c.child.unrefs, 1, 'the audit never waits on the app');
});

test('launchDirect rejects a spawn that fails with its code and never the command or its arguments', async () => {
    const boom = Object.assign(
        new Error('spawn C:\\secret\\floe-desktop.exe EACCES'),
        { code: 'EACCES' }
    );
    const f = fakeSpawn({ fail: boom });
    await assert.rejects(
        launchDirect(
            {
                command: 'C:\\secret\\floe-desktop.exe',
                args: ['C:\\in\\private.bin'],
            },
            { spawnImpl: f.impl }
        ),
        (e) => {
            assert.match(e.message, /^direct launch: spawn failed \(EACCES\)$/);
            assert.ok(
                !e.message.includes('secret') && !e.message.includes('private'),
                e.message
            );
            return true;
        }
    );
    assert.equal(f.calls[0].child.unrefs, 0);
    assert.throws(
        () => launchDirect({ args: ['a'] }, { spawnImpl: f.impl }),
        /a command is required/
    );
});
