// node --test .claude/skills/<skill>/scripts/lib/release.test.mjs
// gh is faked: "download" writes a zip built here plus a checksum file, so
// the verify-then-extract path runs without a network. Versions are
// 3.4.5 so no shipped number is pinned by a test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import zlib from 'node:zlib';

import {
    assertSafeCliPath,
    buildHeadCli,
    cliZipName,
    desktopZipName,
    findStagedDesktop,
    headDesktopCommands,
    selectCli,
    sideloadCli,
    sideloadDesktop,
    verifyAsset,
    versionOfTag,
} from './release.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'lta-release-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
const WIN = process.platform === 'win32';

function storedZip(entries) {
    const parts = [];
    let offset = 0;
    const central = [];
    const push = (b) => {
        parts.push(b);
        offset += b.length;
    };
    for (const [name, data] of entries) {
        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const lho = offset;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        push(local);
        push(nameBuf);
        push(data);
        central.push({ nameBuf, crc, len: data.length, lho });
    }
    const cdOff = offset;
    for (const c of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(20, 6);
        h.writeUInt32LE(c.crc, 16);
        h.writeUInt32LE(c.len, 20);
        h.writeUInt32LE(c.len, 24);
        h.writeUInt16LE(c.nameBuf.length, 28);
        h.writeUInt32LE(c.lho, 42);
        push(h);
        push(c.nameBuf);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdOff, 12);
    eocd.writeUInt32LE(cdOff, 16);
    push(eocd);
    return Buffer.concat(parts);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

function fakeGh({ corrupt = false } = {}) {
    const calls = [];
    const gh = (args) => {
        calls.push(args);
        assert.equal(args[0], 'release');
        assert.equal(args[1], 'download');
        const tag = args[2];
        const dest = args[args.indexOf('--dir') + 1];
        const patterns = args.filter((a, i) => args[i - 1] === '--pattern');
        mkdirSync(dest, { recursive: true });
        const v = versionOfTag(tag);
        for (const p of patterns) {
            if (p === cliZipName(v)) {
                const zip = storedZip([
                    [WIN ? 'floe.exe' : 'floe', Buffer.from(`fake floe ${v}`)],
                ]);
                writeFileSync(path.join(dest, p), zip);
                writeFileSync(
                    path.join(dest, 'checksums.txt'),
                    `${corrupt ? '0'.repeat(64) : sha(zip)}  ${p}\n${'1'.repeat(64)}  other.tar.gz\n`
                );
            } else if (p === desktopZipName(v)) {
                const zip = storedZip([
                    ['floe-desktop.exe', Buffer.from(`fake desktop ${v}`)],
                    ['LICENSE', Buffer.from('MIT')],
                ]);
                writeFileSync(path.join(dest, p), zip);
                writeFileSync(
                    path.join(dest, 'SHA256SUMS.txt'),
                    `${sha(zip)}  ${p}\r\n${'2'.repeat(64)}  floe-desktop-setup-${v}.exe\r\n`
                );
            }
        }
        return '';
    };
    gh.calls = calls;
    return gh;
}

test('names and tag parsing', () => {
    assert.equal(cliZipName('3.4.5'), 'floe_3.4.5_windows_amd64.zip');
    assert.equal(
        desktopZipName('3.4.5'),
        'floe-desktop-3.4.5-windows-amd64.zip'
    );
    assert.equal(versionOfTag('v3.4.5'), '3.4.5');
    assert.equal(versionOfTag('desktop-v3.4.5'), '3.4.5');
    assert.equal(versionOfTag('nope'), null);
});

test('assertSafeCliPath refuses managed-install substrings', () => {
    for (const bad of [
        'C:\\Users\\x\\scoop\\apps\\floe',
        '/opt/homebrew/Cellar/floe',
        'C:\\winget\\x',
        '/usr/local/Cellar/x',
    ])
        assert.throws(
            () => assertSafeCliPath(bad),
            /scoop\|winget\|homebrew\|cellar/
        );
    assert.equal(assertSafeCliPath('C:\\tmp\\lta\\bin'), 'C:\\tmp\\lta\\bin');
});

test('selectCli prefers PATH when current, side-loads otherwise or under --pin', () => {
    assert.equal(
        selectCli({ pathVersion: '3.4.5', latestTag: 'v3.4.5' }).source,
        'path'
    );
    assert.equal(
        selectCli({ pathVersion: '3.4.4', latestTag: 'v3.4.5' }).source,
        'sideload'
    );
    assert.equal(
        selectCli({ pathVersion: null, latestTag: 'v3.4.5' }).source,
        'sideload'
    );
    assert.equal(
        selectCli({ pathVersion: '3.4.5', latestTag: 'v3.4.5', pin: true })
            .source,
        'sideload'
    );
    assert.equal(
        selectCli({ pathVersion: '3.4.5', latestTag: 'latest' }).source,
        'sideload'
    );
});

test('sideloadCli downloads by tag, verifies checksums.txt and extracts', () => {
    const gh = fakeGh();
    const r = sideloadCli({ tag: 'v3.4.5', dest: path.join(dir, 'bin'), gh });
    assert.equal(r.version, '3.4.5');
    assert.ok(existsSync(r.path));
    assert.equal(readFileSync(r.path, 'utf8'), 'fake floe 3.4.5');
    assert.equal(r.sha256, sha(Buffer.from('fake floe 3.4.5')));
    assert.equal(gh.calls[0][2], 'v3.4.5');
    assert.ok(gh.calls[0].includes('--pattern'));
    assert.ok(!/scoop|winget|homebrew|cellar/i.test(r.path));
    const again = sideloadCli({
        tag: 'v3.4.5',
        dest: path.join(dir, 'bin'),
        gh,
    });
    assert.equal(again.reused, true);
    assert.equal(gh.calls.length, 1);
    assert.throws(
        () => sideloadCli({ tag: 'desktop-v3.4.5', dest: dir, gh }),
        /vX\.Y\.Z/
    );
    assert.throws(
        () => sideloadCli({ tag: 'v3.4.5', dest: path.join(dir, 'scoop'), gh }),
        /scoop/
    );
});

test('a checksum mismatch stops the side-load', () => {
    assert.throws(
        () =>
            sideloadCli({
                tag: 'v3.4.6',
                dest: path.join(dir, 'bad'),
                gh: fakeGh({ corrupt: true }),
            }),
        /checksum mismatch/
    );
    assert.ok(
        !existsSync(
            path.join(dir, 'bad', 'floe-3.4.6', WIN ? 'floe.exe' : 'floe')
        )
    );
});

test('sideloadDesktop verifies SHA256SUMS.txt with CR stripping and extracts', () => {
    const r = sideloadDesktop({
        tag: 'desktop-v3.4.5',
        dest: path.join(dir, 'bin'),
        gh: fakeGh(),
    });
    assert.equal(r.isPackaged, false);
    assert.ok(existsSync(r.path));
    assert.equal(readFileSync(r.path, 'utf8'), 'fake desktop 3.4.5');
    assert.ok(existsSync(path.join(path.dirname(r.path), 'LICENSE')));
    assert.throws(
        () => sideloadDesktop({ tag: 'v3.4.5', dest: dir, gh: fakeGh() }),
        /desktop-vX/
    );
});

test('findStagedDesktop finds the side-load and by-hand layouts and verifies both hashes', () => {
    const bin = path.join(dir, 'bin');
    const found = findStagedDesktop(bin, 'desktop-v3.4.5');
    assert.equal(found.layout, 'sideload');
    assert.equal(found.verified, true);
    assert.equal(found.isPackaged, false);
    assert.ok(existsSync(found.path));
    const bin2 = path.join(dir, 'bin2');
    const hand = path.join(bin2, 'desktop-v3.4.5');
    mkdirSync(path.join(hand, 'extracted'), { recursive: true });
    const exeBytes = Buffer.from('fake desktop 3.4.5');
    const zip = storedZip([
        ['floe-desktop.exe', exeBytes],
        ['LICENSE', Buffer.from('MIT')],
    ]);
    writeFileSync(path.join(hand, desktopZipName('3.4.5')), zip);
    writeFileSync(
        path.join(hand, 'SHA256SUMS.txt'),
        `${sha(zip)}  ${desktopZipName('3.4.5')}\n`
    );
    writeFileSync(path.join(hand, 'extracted', 'floe-desktop.exe'), exeBytes);
    const h = findStagedDesktop(bin2, 'desktop-v3.4.5');
    assert.equal(h.layout, 'extracted');
    assert.equal(h.verified, true);
    assert.equal(h.sha256, sha(exeBytes));
    assert.equal(h.zipSha256, sha(zip));
    writeFileSync(
        path.join(hand, 'extracted', 'floe-desktop.exe'),
        Buffer.from('tampered')
    );
    assert.throws(
        () => findStagedDesktop(bin2, 'desktop-v3.4.5'),
        /is not the floe-desktop\.exe inside/
    );
    rmSync(path.join(hand, 'SHA256SUMS.txt'));
    assert.equal(findStagedDesktop(bin2, 'desktop-v3.4.5').verified, false);
    assert.equal(findStagedDesktop(bin2, 'desktop-v9.9.9'), null);
    assert.equal(findStagedDesktop(bin2, 'v3.4.5'), null);
    assert.equal(findStagedDesktop(null, 'desktop-v3.4.5'), null);
});

test('verifyAsset needs the asset present', () => {
    assert.throws(
        () =>
            verifyAsset({
                dir,
                assetName: 'missing.zip',
                checksumFile: 'checksums.txt',
            }),
        /asset missing/
    );
});

test('buildHeadCli runs go build with the version stamped and no shell', async () => {
    const calls = [];
    const exec = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        mkdirSync(path.dirname(args[args.indexOf('-o') + 1]), {
            recursive: true,
        });
        writeFileSync(args[args.indexOf('-o') + 1], 'built');
        return '';
    };
    const r = await buildHeadCli({
        root: path.join(dir, 'repo'),
        sha7: 'abc1234',
        binDir: path.join(dir, 'head-bin'),
        exec,
    });
    assert.equal(r.version, 'head-abc1234');
    assert.equal(calls[0].cmd, 'go');
    assert.deepEqual(calls[0].args.slice(0, 3), [
        'build',
        '-ldflags',
        '-X main.version=head-abc1234',
    ]);
    assert.equal(calls[0].args.at(-1), './cmd/floe');
    assert.equal(calls[0].opts.cwd, path.join(dir, 'repo', 'cli'));
    assert.ok(existsSync(r.path));
});

test('headDesktopCommands: npm run build in desktop/frontend, then wails build', () => {
    const plan = headDesktopCommands({
        root: path.join(dir, 'repo'),
        sha7: 'abc1234',
        wails: 'C:\\go\\bin\\wails.exe',
    });
    assert.equal(plan.version, 'head-abc1234');
    assert.equal(plan.steps.length, 2);
    assert.deepEqual(plan.steps[0].args, ['run', 'build']);
    assert.equal(
        plan.steps[0].cwd,
        path.join(dir, 'repo', 'desktop', 'frontend')
    );
    assert.equal(plan.steps[1].cmd, 'C:\\go\\bin\\wails.exe');
    assert.ok(plan.steps[1].args.includes('-X main.version=head-abc1234'));
    assert.equal(plan.steps[1].cwd, path.join(dir, 'repo', 'desktop'));
    assert.ok(plan.exe.endsWith(path.join('build', 'bin', 'floe-desktop.exe')));
});

test('sideloadCli reuse re-verifies the exe against the zip entry and re-extracts a tampered one', () => {
    const dest = path.join(dir, 'reuse');
    const first = sideloadCli({ tag: 'v3.4.5', dest, gh: fakeGh() });
    assert.equal(first.reused, false);
    assert.equal(first.reextracted, false);
    writeFileSync(first.path, 'MZ TAMPERED or truncated build');
    const noGh = () => {
        throw new Error('gh must not be called on reuse');
    };
    const second = sideloadCli({ tag: 'v3.4.5', dest, gh: noGh });
    assert.equal(second.reextracted, true);
    assert.equal(second.reused, false);
    assert.equal(second.sha256, first.sha256, 'the checksummed bytes again');
    assert.equal(readFileSync(first.path, 'utf8'), 'fake floe 3.4.5');
    const third = sideloadCli({ tag: 'v3.4.5', dest, gh: noGh });
    assert.equal(third.reused, true);
    assert.equal(third.reextracted, false);
    assert.equal(third.sha256, first.sha256);
});
