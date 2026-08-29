// Tests for lib/wsl.mjs: the parsers over canned wsl.exe output (UTF-16LE,
// exactly as `wsl -l -v` prints it on this machine), the route line, the URL
// and path translation, the sideload script and its verify step, preflight
// with an injected exec, and the invocation built on lib/cli.mjs's own
// buildArgs/buildEnv (skipped with a note if cli.mjs is not there yet).
// Nothing here runs wsl.exe.
//
// Run: node --test .claude/skills/<skill>/scripts/lib/wsl.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PhaseError } from './surfaces.mjs';
import {
    DISTRO,
    WSL_EXE,
    WSL_ROOT,
    assetNames,
    buildWslInvocation,
    decodeWslOutput,
    distroStatus,
    linuxPaths,
    mergeWslEnv,
    needsHostIp,
    parseChecksumVerify,
    parseFloeVersion,
    HOST_IP_ARGS,
    parseHostIp,
    parseWslList,
    preflight,
    serverUrlFor,
    shellQuote,
    sideload,
    sideloadScript,
    toWslPath,
    createLeg,
} from './wsl.mjs';

// Measured `wsl.exe -l -v` on 2026-08-29 (UTF-16LE with a BOM).
const LIST_TEXT =
    '  NAME              STATE           VERSION\r\n' +
    '* docker-desktop    Running         2\r\n' +
    '  Ubuntu-22.04      Stopped         2\r\n';
const LIST_UTF16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(LIST_TEXT, 'utf16le'),
]);

test('decodeWslOutput handles UTF-16LE with BOM, UTF-8 and strings', () => {
    assert.equal(decodeWslOutput(LIST_UTF16), LIST_TEXT);
    assert.equal(
        decodeWslOutput(Buffer.from('192.168.160.1\n')),
        '192.168.160.1\n'
    );
    assert.equal(decodeWslOutput('a\u0000b'), 'ab');
    assert.equal(decodeWslOutput(null), '');
});

test('parseWslList reads the measured listing', () => {
    const rows = parseWslList(LIST_UTF16);
    assert.deepEqual(rows, [
        { name: 'docker-desktop', state: 'Running', version: 2, default: true },
        { name: 'Ubuntu-22.04', state: 'Stopped', version: 2, default: false },
    ]);
    assert.deepEqual(distroStatus(rows, DISTRO), {
        present: true,
        state: 'Stopped',
        version: 2,
        default: false,
    });
    assert.deepEqual(distroStatus(rows, 'Debian'), {
        present: false,
        state: null,
        version: null,
        default: false,
    });
    assert.equal(parseWslList('').length, 0);
});

test('parseHostIp reads the via address of the default route, or a bare IP line', () => {
    assert.equal(parseHostIp(Buffer.from('192.168.160.1\n')), '192.168.160.1');
    assert.equal(
        parseHostIp('default via 192.168.160.1 dev eth0 proto kernel \n'),
        '192.168.160.1',
        'the 2026-08-29 shape on this machine'
    );
    assert.equal(parseHostIp('default via 10.0.0.1 dev eth0\n'), '10.0.0.1');
    assert.equal(
        parseHostIp('172.17.0.0/16 dev docker0 proto kernel scope link\n'),
        null,
        'a non-default route never counts'
    );
    assert.deepEqual([...HOST_IP_ARGS], ['ip', 'route', 'show', 'default']);
    for (const a of HOST_IP_ARGS)
        assert.ok(!a.includes('$'), 'no $ reaches the login shell');
    const src = readFileSync(new URL('./wsl.mjs', import.meta.url), 'utf8');
    assert.ok(
        !/'-c',\s*\n?\s*["'][^"']*\$/.test(src),
        'no sh -c passthrough with a $ in it (wsl.exe expands it first)'
    );
    assert.equal(parseHostIp(''), null);
});

test('serverUrlFor rewrites loopback to the host IP and never yields localhost', () => {
    assert.equal(
        serverUrlFor('http://localhost:3001', '192.168.160.1'),
        'http://192.168.160.1:3001'
    );
    assert.equal(
        serverUrlFor('http://127.0.0.1:3001/', '192.168.160.1'),
        'http://192.168.160.1:3001'
    );
    assert.equal(
        serverUrlFor('https://api.floe.one', '192.168.160.1'),
        'https://api.floe.one'
    );
    assert.equal(
        serverUrlFor('https://api.floe.one/', null),
        'https://api.floe.one'
    );
    assert.throws(
        () => serverUrlFor('http://localhost:3001', null),
        PhaseError
    );
    assert.throws(() => serverUrlFor('', '1.2.3.4'), PhaseError);
    assert.throws(() => serverUrlFor('not a url', '1.2.3.4'), PhaseError);
});

test('toWslPath maps drive paths and refuses the rest', () => {
    assert.equal(
        toWslPath('C:\\Users\\alice\\x y\\f.bin'),
        '/mnt/c/Users/alice/x y/f.bin'
    );
    assert.equal(toWslPath('D:/a/b'), '/mnt/d/a/b');
    assert.throws(() => toWslPath('\\\\server\\share\\f'), PhaseError);
    assert.throws(() => toWslPath('relative\\f'), PhaseError);
});

test('assetNames and linuxPaths follow the GoReleaser and WSL_ROOT shapes', () => {
    assert.deepEqual(assetNames('v1.10.5'), {
        version: '1.10.5',
        asset: 'floe_1.10.5_linux_amd64.tar.gz',
        checksums: 'checksums.txt',
    });
    assert.throws(() => assetNames('desktop-v0.2.8'), PhaseError);
    assert.deepEqual(linuxPaths('v1.10.5'), {
        dir: `${WSL_ROOT}/v1.10.5`,
        bin: `${WSL_ROOT}/v1.10.5/floe`,
    });
});

test('sideloadScript verifies before extracting and uses no double quotes', () => {
    const s = sideloadScript({ tag: 'v1.10.5', wslDir: '/mnt/c/scratch/bin' });
    const lines = s.split('\n');
    assert.equal(lines[0], 'set -eu');
    assert.ok(
        lines.indexOf("sha256sum -c --ignore-missing 'checksums.txt'") <
            lines.findIndex((l) => l.startsWith('tar -xzf'))
    );
    assert.ok(
        s.includes(
            `tar -xzf 'floe_1.10.5_linux_amd64.tar.gz' -C '${WSL_ROOT}/v1.10.5'`
        )
    );
    assert.ok(s.includes(`chmod +x '${WSL_ROOT}/v1.10.5/floe'`));
    assert.ok(s.includes('FLOE_NO_UPDATE_CHECK=1'));
    assert.ok(!s.includes('"'));
    assert.ok(!s.includes('\r'));
});

test('parseChecksumVerify reads sha256sum -c output', () => {
    const asset = 'floe_1.10.5_linux_amd64.tar.gz';
    assert.deepEqual(
        parseChecksumVerify(`${asset}: OK\nfloe 1.10.5\n`, asset),
        { ok: true, line: `${asset}: OK` }
    );
    assert.deepEqual(
        parseChecksumVerify(
            `${asset}: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match\n`,
            asset
        ),
        {
            ok: false,
            line: `${asset}: FAILED`,
        }
    );
    assert.deepEqual(parseChecksumVerify('nothing here', asset), {
        ok: false,
        line: null,
    });
    assert.equal(parseFloeVersion(`${asset}: OK\nfloe 1.10.5\n`), '1.10.5');
});

test('mergeWslEnv appends names once and keeps flags', () => {
    assert.equal(mergeWslEnv('', ['A', 'B']), 'A:B');
    assert.equal(mergeWslEnv('A/p:C', ['A', 'B']), 'A/p:C:B');
    assert.equal(mergeWslEnv(undefined, []), '');
});

function fakeExec(script) {
    const calls = [];
    const exec = async (file, args, opts) => {
        calls.push({ file, args, opts });
        const r = script(file, args);
        return {
            code: 'code' in r ? r.code : 0,
            error: r.error ?? null,
            stdout: Buffer.isBuffer(r.stdout)
                ? r.stdout
                : Buffer.from(r.stdout ?? ''),
            stderr: Buffer.from(r.stderr ?? ''),
        };
    };
    return { exec, calls };
}

test('preflight reports wsl-stopped without starting the distro', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: LIST_UTF16 }));
    const r = await preflight({ exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wsl-stopped');
    assert.equal(r.detail.state, 'Stopped');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-l', '-v']);
});

test('preflight is green for a running distro and names the other failures', async () => {
    const running = Buffer.from(
        LIST_TEXT.replace(
            'Ubuntu-22.04      Stopped',
            'Ubuntu-22.04      Running'
        ),
        'utf16le'
    );
    assert.equal(
        (await preflight({ exec: fakeExec(() => ({ stdout: running })).exec }))
            .ok,
        true
    );
    const missing = await preflight({
        exec: fakeExec(() => ({ stdout: LIST_UTF16 })).exec,
        distro: 'Debian',
    });
    assert.equal(missing.reason, 'distro-missing');
    const none = await preflight({
        exec: fakeExec(() => ({ code: null, error: 'spawn wsl.exe ENOENT' }))
            .exec,
    });
    assert.equal(none.reason, 'wsl-missing');
});

test('sideload downloads once, runs the script through sh, and checks the verify line', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wsl-sideload-'));
    try {
        const asset = 'floe_1.10.5_linux_amd64.tar.gz';
        const { exec, calls } = fakeExec((file, args) => {
            if (file === 'gh') {
                writeFileSync(path.join(dir, asset), 'tar');
                writeFileSync(path.join(dir, 'checksums.txt'), 'sum');
                return { stdout: '' };
            }
            return { stdout: `${asset}: OK\nfloe 1.10.5\n` };
        });
        const r = await sideload({ tag: 'v1.10.5', dir, exec });
        assert.equal(r.verified, true);
        assert.equal(r.downloaded, true);
        assert.equal(r.floeVersion, '1.10.5');
        assert.equal(r.linuxBin, `${WSL_ROOT}/v1.10.5/floe`);
        assert.equal(calls[0].file, 'gh');
        assert.ok(calls[0].args.includes('--skip-existing'));
        assert.deepEqual(calls[1].args.slice(0, 3), ['-d', DISTRO, '--']);
        assert.equal(calls[1].args.length, 4, 'one command string after --');
        assert.match(calls[1].args[3], /^sh '\/mnt\/.*\.sh'$/);
        assert.ok(!readFileSync(r.script, 'utf8').includes('\r'));
        // Second call: files present, no gh call.
        const again = await sideload({ tag: 'v1.10.5', dir, exec });
        assert.equal(again.downloaded, false);
        assert.equal(calls.filter((c) => c.file === 'gh').length, 1);
        // A FAILED line is a hard stop even with exit 0.
        const bad = fakeExec((file) =>
            file === 'gh' ? { stdout: '' } : { stdout: `${asset}: FAILED\n` }
        );
        await assert.rejects(
            sideload({ tag: 'v1.10.5', dir, exec: bad.exec }),
            PhaseError
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('buildWslInvocation reuses cli.mjs buildArgs/buildEnv with translated paths and server', async () => {
    let cli;
    try {
        cli = await import('./cli.mjs');
    } catch (err) {
        if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
            console.log(
                'note: lib/cli.mjs not present yet; skipping the invocation test'
            );
            return;
        }
        throw err;
    }
    const opts = {
        role: 'sender',
        files: ['C:\\scratch\\fx\\a.bin', 'C:\\scratch\\fx\\b.bin'],
        infra: {
            name: 'local',
            server: 'http://localhost:3001',
            web: 'http://localhost:3000',
        },
        noRelay: true,
        evidenceDir: 'C:\\scratch\\ev',
    };
    const inv = buildWslInvocation(opts, {
        hostIp: '192.168.160.1',
        linuxBin: '/var/tmp/floe-lta/v1.10.5/floe',
        buildArgs: cli.buildArgs,
        buildEnv: cli.buildEnv,
        baseEnv: { PATH: 'x', PION_LOG_TRACE: 'all', WSLENV: 'FOO/p' },
    });
    assert.deepEqual(inv.argv.slice(0, 4), [
        '-d',
        DISTRO,
        '--',
        '/var/tmp/floe-lta/v1.10.5/floe',
    ]);
    assert.equal(inv.argv[4], 'send');
    assert.ok(inv.argv.includes('/mnt/c/scratch/fx/a.bin'));
    assert.ok(inv.argv.includes('/mnt/c/scratch/fx/b.bin'));
    assert.equal(
        inv.argv[inv.argv.indexOf('--server') + 1],
        'http://192.168.160.1:3001'
    );
    assert.equal(
        inv.argv[inv.argv.indexOf('--web') + 1],
        'http://192.168.160.1:3000'
    );
    assert.ok(inv.argv.includes('--no-relay'));
    assert.ok(!inv.argv.some((a) => /localhost/.test(a)));
    // What actually runs: one single-quoted command string after `--`,
    // passed verbatim, so the distro's login shell sees every word intact.
    assert.equal(inv.verbatim, true);
    assert.deepEqual(inv.spawnArgs.slice(0, 3), ['-d', DISTRO, '--']);
    assert.equal(inv.spawnArgs.length, 4);
    assert.equal(inv.spawnArgs[3], inv.command);
    assert.ok(
        inv.command.startsWith("'/var/tmp/floe-lta/v1.10.5/floe' 'send' "),
        inv.command
    );
    for (const word of inv.argv.slice(3))
        assert.ok(inv.command.includes(shellQuote(word)), word);
    assert.equal(shellQuote("a $b'c\\d"), "'a $b'\\''c\\d'");
    const spaced = buildWslInvocation(
        { ...opts, files: ['C:\\scratch\\f x\\a $b.bin'] },
        {
            hostIp: '192.168.160.1',
            linuxBin: '/var/tmp/floe-lta/v1.10.5/floe',
            buildArgs: cli.buildArgs,
            buildEnv: cli.buildEnv,
            baseEnv: {},
        }
    );
    assert.ok(
        spaced.command.includes("'/mnt/c/scratch/f x/a $b.bin'"),
        spaced.command
    );
    assert.equal(inv.env.FLOE_NO_UPDATE_CHECK, '1');
    assert.equal(inv.env.PION_LOG_TRACE, undefined);
    assert.equal(inv.env.WSLENV, 'FOO/p:FLOE_NO_UPDATE_CHECK:PION_LOG_TRACE');
    assert.throws(
        () =>
            buildWslInvocation(
                { ...opts, role: 'receiver' },
                {
                    hostIp: '1.2.3.4',
                    linuxBin: '/x',
                    buildArgs: cli.buildArgs,
                    buildEnv: cli.buildEnv,
                }
            ),
        PhaseError
    );
    const prod = buildWslInvocation(
        { ...opts, infra: { name: 'prod', server: 'https://api.floe.one' } },
        {
            hostIp: '192.168.160.1',
            linuxBin: '/x/floe',
            buildArgs: cli.buildArgs,
            buildEnv: cli.buildEnv,
            baseEnv: {},
        }
    );
    assert.equal(prod.server, 'https://api.floe.one');
});

test('WslLeg takes the side-loaded Linux path only, never the Windows exe', () => {
    const base = {
        role: 'sender',
        files: ['C:\\x\\a.bin'],
        infra: { server: 'https://api.floe.one' },
        evidenceDir: 'C:\\x\\ev',
    };
    assert.equal(
        createLeg({ ...base, build: { path: 'C:\\x\\floe.exe' } }).linuxBin,
        null,
        'build.path is a Windows exe and never a fallback'
    );
    assert.equal(
        createLeg({
            ...base,
            build: {
                path: 'C:\\x\\floe.exe',
                wslBin: '/var/tmp/floe-lta/v1.10.5/floe',
            },
        }).linuxBin,
        '/var/tmp/floe-lta/v1.10.5/floe'
    );
    assert.equal(
        createLeg({
            ...base,
            wslBin: '/tmp/x/floe',
            build: { wslBin: '/tmp/y/floe' },
        }).linuxBin,
        '/tmp/x/floe',
        'an explicit wslBin wins'
    );
});

test('needsHostIp: only a loopback server or web URL needs the Windows host IP', () => {
    assert.equal(needsHostIp({ server: 'https://api.floe.one' }), false);
    assert.equal(
        needsHostIp({
            server: 'https://api.floe.one',
            web: 'https://www.floe.one',
        }),
        false,
        'the shipped profile never resolves a host IP, so it can never fail on one'
    );
    assert.equal(needsHostIp({ server: 'http://localhost:3001' }), true);
    assert.equal(needsHostIp({ server: 'http://127.0.0.1:3001' }), true);
    assert.equal(needsHostIp({ server: 'http://[::1]:3001' }), true);
    assert.equal(
        needsHostIp({
            server: 'https://api.floe.one',
            web: 'http://localhost:3000',
        }),
        true,
        'either URL is enough'
    );
    assert.equal(needsHostIp({}), false);
    assert.equal(needsHostIp({ server: 'not a url' }), false);
    const src = readFileSync(new URL('./wsl.mjs', import.meta.url), 'utf8');
    assert.match(
        src,
        /if \(!this\.ip && needsHostIp\(this\.opts\.infra\)\)/,
        'the leg resolves the host IP lazily'
    );
});

test('the side-load passes one pre-quoted command, so an awkward dir still works', async () => {
    // The gate that rejected a space is gone: the transport that carries the
    // leg's argv carries this one too, and a temp path with a space is
    // ordinary on Windows.
    const calls = [];
    const dir = path.join(tmpdir(), 'lta side $load');
    await assert.rejects(
        () =>
            sideload({
                tag: 'v1.10.5',
                dir,
                exec: async (file, args, opts) => {
                    calls.push({ file, args, opts });
                    return {
                        code: 0,
                        stdout: Buffer.from('nothing verified'),
                        stderr: Buffer.alloc(0),
                    };
                },
            }),
        /verify or extract failed/
    );
    const gh = calls.find((c) => c.file === 'gh');
    assert.ok(gh, 'the release download ran');
    assert.deepEqual(
        gh.args.slice(gh.args.indexOf('--repo'), gh.args.indexOf('--repo') + 2),
        ['--repo', 'jannskiee/floe'],
        'the download is pinned to the repo, like every other one in the run'
    );
    const wsl = calls.find((c) => c.file === WSL_EXE);
    assert.ok(wsl, 'the extract ran inside the distro');
    assert.deepEqual(wsl.args.slice(0, 3), ['-d', DISTRO, '--']);
    assert.equal(wsl.args.length, 4, 'one command string after --');
    assert.equal(wsl.opts.verbatim, true, 'passed verbatim, not re-quoted');
    assert.match(
        wsl.args[3],
        /^sh '\/mnt\/c\/.*lta side \$load\/sideload-v1\.10\.5\.sh'$/,
        wsl.args[3]
    );
    rmSync(dir, { recursive: true, force: true });
});
