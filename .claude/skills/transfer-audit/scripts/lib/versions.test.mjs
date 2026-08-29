// node --test .claude/skills/<skill>/scripts/lib/versions.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
    checksumFor,
    cliUnderTestOracle,
    collectVersions,
    commitCurrency,
    compareQuad,
    compareVersions,
    gatingDrift,
    identityVersion,
    inverseIdentity,
    parseAppx,
    parseDisplayVersion,
    parseFloeVersion,
    parseTag,
    parseWebShaFile,
    pickLatestDesktop,
    protocolParity,
    touchesDir,
    versionStatus,
} from './versions.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'lta-versions-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('head profile: the web row carries the served checkout sha and a go build oracle names root and sha', async () => {
    const v = await collectVersions({
        root,
        gh: () => {
            throw new Error('gh auth');
        },
        exec: () => '',
        fetchImpl: async () => {
            throw new Error('offline');
        },
        profile: 'head',
        localSha7: 'aaaaaaa',
        webLocalSha7: 'bbbbbbb',
        cliUnderTest: {
            version: 'head-aaaaaaa',
            source: 'go build',
            root: 'C:\\r',
            sha7: 'aaaaaaa',
        },
        log: () => {},
    });
    const by = Object.fromEntries(v.rows.map((r) => [r.surface, r]));
    assert.equal(by['Web floe.one'].installed, 'local HEAD bbbbbbb');
    assert.equal(by['CLI under test'].latest, 'local HEAD aaaaaaa');
    assert.equal(by['CLI under test'].oracle, 'go build from C:\\r (aaaaaaa)');
    assert.equal(by['CLI under test'].status, 'INFO');
    assert.equal(cliUnderTestOracle({ source: 'path' }), 'floe --version');
    assert.equal(
        cliUnderTestOracle({ source: 'release' }),
        'checksums.txt sha256 match'
    );
    assert.equal(
        cliUnderTestOracle({ source: 'go build', version: 'head-abc1234' }),
        'go build from ? (abc1234)'
    );
    assert.equal(cliUnderTestOracle(null), null);
});

test('parseFloeVersion', () => {
    assert.equal(parseFloeVersion('floe 3.4.5\n'), '3.4.5');
    assert.equal(parseFloeVersion('floe dev'), 'dev');
    assert.equal(parseFloeVersion('floe head-abc1234'), 'head-abc1234');
    assert.equal(parseFloeVersion('nope'), null);
});

test('identity mapping round trip on non-shipped numbers', () => {
    assert.equal(identityVersion('desktop-v3.4.5'), '4.4.5.0');
    assert.equal(inverseIdentity('4.4.5.0'), '3.4.5');
    assert.equal(identityVersion('desktop-v3.4.5-rc1'), null);
    assert.equal(identityVersion('v3.4.5'), null);
    assert.equal(inverseIdentity('0.1.0.0'), null);
    assert.equal(inverseIdentity('1.2'), null);
    assert.equal(parseTag('desktop-v3.4.5').version, '3.4.5');
});

test('compareVersions and versionStatus', () => {
    assert.equal(compareVersions('v3.4.5', '3.4.5'), 0);
    assert.equal(compareVersions('3.4.5', 'v3.4.6'), -1);
    assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
    assert.equal(compareVersions('dev', '3.4.5'), null);
    assert.equal(versionStatus(null, 'v3.4.5'), 'NOT_INSTALLED');
    assert.equal(versionStatus('3.4.4', 'v3.4.5'), 'STALE');
    assert.equal(versionStatus('3.4.5', 'v3.4.5'), 'CURRENT');
    assert.equal(versionStatus('dev', 'v3.4.5'), 'UNKNOWN');
    assert.equal(versionStatus('3.4.5', null), 'UNKNOWN');
});

test('pickLatestDesktop ignores drafts and CLI tags and orders by version', () => {
    const releases = [
        { tag_name: 'v9.9.9', draft: false },
        { tag_name: 'desktop-v3.4.5', draft: false },
        { tag_name: 'desktop-v3.4.10', draft: true },
        {
            tag_name: 'desktop-v3.4.9',
            draft: false,
            published_at: '2020-01-01',
        },
        { tag_name: 'desktop-v3.4.6-rc1', draft: false },
    ];
    assert.equal(pickLatestDesktop(releases), 'desktop-v3.4.9');
    assert.equal(
        pickLatestDesktop([{ tagName: 'desktop-v3.4.5', isDraft: false }]),
        'desktop-v3.4.5'
    );
    assert.equal(pickLatestDesktop([]), null);
});

test('parseAppx and parseDisplayVersion', () => {
    const one = parseAppx(
        '{"Name":"X.Y","Version":"4.4.5.0","InstallLocation":"C:\\\\P","PackageFullName":"X.Y_4.4.5.0_x64__abc"}'
    );
    assert.equal(one.version, '4.4.5.0');
    assert.equal(one.pfn, 'X.Y_4.4.5.0_x64__abc');
    assert.equal(parseAppx('[{"Version":"4.4.5.0"}]').version, '4.4.5.0');
    assert.equal(parseAppx(''), null);
    assert.equal(parseAppx('garbage'), null);
    assert.equal(parseDisplayVersion('3.4.5\r\n'), '3.4.5');
    assert.equal(parseDisplayVersion(''), null);
});

test('protocolParity on equal, drifted, missing and desktop readings', () => {
    const go = 'const (\n\tProtocolVersion    = 2\n\tMinProtocolVersion = 1\n)';
    const ts =
        'export const PROTOCOL_VERSION = 2;\nexport const MIN_PROTOCOL_VERSION = 1;';
    assert.equal(protocolParity(go, ts).status, 'PARITY');
    assert.equal(protocolParity(go, ts.replace('= 2', '= 3')).status, 'DRIFT');
    assert.equal(protocolParity(go, '').status, 'UNKNOWN');
    assert.equal(protocolParity(go, ts, 'Version 2').status, 'PARITY');
    assert.equal(protocolParity(go, ts, 'Version 1').status, 'DRIFT');
    assert.equal(protocolParity(go, ts, 'Transfer protocol: 2').desktop, 2);
});

test('checksumFor tolerates CRLF, two spaces and the binary marker', () => {
    const text =
        'aa'.repeat(32) +
        '  floe_3.4.5_windows_amd64.zip\r\n' +
        'bb'.repeat(32) +
        ' *floe-desktop-3.4.5-windows-amd64.zip\n';
    assert.equal(
        checksumFor(text, 'floe_3.4.5_windows_amd64.zip'),
        'aa'.repeat(32)
    );
    assert.equal(
        checksumFor(text, 'floe-desktop-3.4.5-windows-amd64.zip'),
        'bb'.repeat(32)
    );
    assert.throws(() => checksumFor(text, 'other.zip'), /no checksum line/);
});

test('commitCurrency, touchesDir, parseWebShaFile, gatingDrift', () => {
    assert.equal(
        commitCurrency({
            deployed: 'abcdef1',
            main: 'abcdef1234567',
            touched: null,
        }),
        'CURRENT'
    );
    assert.equal(
        commitCurrency({
            deployed: '1111111',
            main: '2222222',
            touched: false,
        }),
        'CURRENT'
    );
    assert.equal(
        commitCurrency({ deployed: '1111111', main: '2222222', touched: true }),
        'STALE'
    );
    assert.equal(
        commitCurrency({ deployed: '1111111', main: '2222222', touched: null }),
        'UNKNOWN'
    );
    assert.equal(
        commitCurrency({ deployed: null, main: '2222222', touched: false }),
        'UNKNOWN'
    );
    assert.ok(touchesDir(['client/app/page.tsx', 'docs/x.mdx'], 'client'));
    assert.ok(!touchesDir(['clientele/x', 'docs/x.mdx'], 'client'));
    assert.equal(parseWebShaFile('{"githubCommitSha":"ABCDEF1"}'), 'abcdef1');
    assert.equal(parseWebShaFile({ sha: 'zz' }), null);
    const rows = [
        { gate: true, status: 'STALE' },
        { gate: false, status: 'STALE' },
        { gate: true, status: 'CURRENT' },
        { gate: true, status: 'UNKNOWN' },
    ];
    assert.equal(gatingDrift(rows).length, 2);
});

test('collectVersions with injected gh, exec and fetch', async () => {
    mkdirSync(path.join(root, 'cli', 'engine', 'transfer'), {
        recursive: true,
    });
    mkdirSync(path.join(root, 'client', 'lib', 'transfer'), {
        recursive: true,
    });
    writeFileSync(
        path.join(root, 'cli', 'engine', 'transfer', 'protocol.go'),
        'ProtocolVersion    = 1\nMinProtocolVersion = 1\n'
    );
    writeFileSync(
        path.join(root, 'client', 'lib', 'transfer', 'protocol.ts'),
        'export const PROTOCOL_VERSION = 1;\nexport const MIN_PROTOCOL_VERSION = 1;\n'
    );
    const calls = [];
    const gh = (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key.startsWith('release view')) return 'v3.4.5';
        if (key.startsWith('api repos/jannskiee/floe/releases'))
            return JSON.stringify([
                { tag_name: 'desktop-v3.4.5', draft: false },
                { tag_name: 'v3.4.5', draft: false },
            ]);
        if (key.startsWith('api repos/jannskiee/floe/commits/main'))
            return 'ffffffffffffffffffffffffffffffffffffffff';
        if (key.startsWith('api repos/jannskiee/floe/compare/'))
            return JSON.stringify(['docs/changelog.mdx']);
        throw new Error(`unexpected gh ${key}`);
    };
    const exec = (cmd, args, opts) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'where' || cmd === 'which')
            return 'C:\\Users\\x\\scoop\\shims\\floe.exe';
        if (args[0] === '--version') {
            assert.equal(opts.env.FLOE_NO_UPDATE_CHECK, '1');
            return 'floe 3.4.4';
        }
        if (cmd === 'powershell.exe' && /Get-AppxPackage/.test(args.at(-1)))
            return '{"Name":"JanCarloParedes.FloeDesktop","Version":"4.4.5.0","InstallLocation":"C:\\\\WA","PackageFullName":"pfn"}';
        if (cmd === 'powershell.exe') return '';
        if (cmd === 'git' && args[0] === 'log')
            return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2026-01-01T00:00:00Z';
        if (cmd === 'git' && args[1] === 'HEAD')
            return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        if (cmd === 'git') return 'main';
        throw new Error(`unexpected exec ${cmd}`);
    };
    const fetchImpl = async (url) => ({
        status: 200,
        ok: true,
        url,
        headers: new Map(),
        text: async () =>
            url.endsWith('/api/config')
                ? '{"socketUrl":""}'
                : '{"status":"healthy","uptime":100}',
    });
    const v = await collectVersions({
        root,
        gh,
        exec,
        fetchImpl,
        webUrl: 'https://web.invalid',
        serverUrl: 'https://api.invalid',
        profile: 'shipped',
        storeUsed: true,
        log: () => {},
    });
    const by = Object.fromEntries(v.rows.map((r) => [r.surface, r]));
    assert.equal(by['CLI on PATH'].status, 'STALE');
    assert.match(by['CLI on PATH'].installed, /scoop/);
    assert.match(by['CLI on PATH'].suggest, /bucket/);
    assert.equal(by['CLI on PATH'].gate, false);
    assert.equal(by['CLI under test'].status, 'CURRENT');
    assert.equal(by['CLI under test'].gate, true);
    assert.equal(by['Desktop Store'].status, 'CURRENT');
    assert.equal(by['Desktop Store'].installed, '3.4.5 (4.4.5.0)');
    assert.equal(by['Desktop GitHub'].status, 'NOT_INSTALLED');
    assert.equal(by['Web floe.one'].status, 'UNKNOWN');
    assert.match(by['Web floe.one'].oracle, /no commit field/);
    assert.equal(by['Server api.floe.one'].status, 'INFO');
    assert.match(by['Server api.floe.one'].installed, /up 0\.0 d/);
    assert.equal(by['Protocol'].status, 'PARITY');
    assert.deepEqual(v.latest, { cli: 'v3.4.5', desktop: 'desktop-v3.4.5' });
    assert.ok(!calls.some((c) => /floe version/.test(c)), 'never floe version');
    assert.ok(
        !calls.some((c) => /compare/.test(c)),
        'no compare without a deployed sha'
    );

    // With --web-sha and --server-sha the compare runs and gates.
    const v2 = await collectVersions({
        root,
        gh,
        exec,
        fetchImpl,
        webSha: '1234567',
        serverSha: '89abcde',
        profile: 'shipped',
        log: () => {},
    });
    const by2 = Object.fromEntries(v2.rows.map((r) => [r.surface, r]));
    assert.equal(by2['Web floe.one'].status, 'CURRENT');
    assert.equal(by2['Server api.floe.one'].status, 'CURRENT');
    assert.equal(by2['Server api.floe.one'].gate, true);
    assert.ok(calls.some((c) => /compare\/1234567\.\.\./.test(c)));

    // gh failure degrades to UNKNOWN with the auth hint, never a throw.
    const v3 = await collectVersions({
        root,
        gh: () => {
            throw new Error('gh auth');
        },
        exec,
        fetchImpl,
        profile: 'shipped',
        log: () => {},
    });
    assert.equal(v3.ghOk, false);
    assert.equal(
        v3.rows.find((r) => r.surface === 'CLI under test').status,
        'UNKNOWN'
    );
    assert.equal(
        v3.rows.find((r) => r.surface === 'CLI under test').suggest,
        'gh auth login'
    );
});

test('parseAppx picks the highest Version when several packages match', () => {
    const two = parseAppx(
        JSON.stringify([
            { Name: 'X', Version: '1.2.7.0' },
            { Name: 'X', Version: '1.2.8.0' },
        ])
    );
    assert.equal(two.version, '1.2.8.0');
    assert.equal(
        parseAppx(
            JSON.stringify([
                { Version: '1.2.10.0' },
                { Version: '1.2.9.0' },
                null,
            ])
        ).version,
        '1.2.10.0'
    );
    assert.equal(compareQuad('1.2.10.0', '1.2.9.0'), 1);
    assert.equal(compareQuad('1.2.8', '1.2.8.0'), 0);
    assert.equal(compareQuad('0.9.9.9', '1.0.0.0'), -1);
});
