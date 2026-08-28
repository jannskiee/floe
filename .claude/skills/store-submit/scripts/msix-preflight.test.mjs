/**
 * Fixture tests for msix-preflight.mjs.
 *
 * The package under test is built here the way makeappx builds one: a Zip64
 * end-of-central-directory record and locator, general-purpose flag bit 3
 * with data descriptors (so every local header says crc and sizes 0), the
 * manifest deflated, assets stored, and the 24-byte 0x0001 extra field on
 * every central entry. A reader that only handles a classic zip would pass
 * on a naive fixture and fail on the real thing, which is the wrong way
 * round, so makeZip builds both shapes and the baseline runs the makeappx
 * one. The manifest fixture is the repo template with __IDENTITY_VERSION__
 * stamped everywhere it appears (comment included), exactly what pack.ps1's
 * .Replace() does, so the expected values come from the same file the script
 * reads at runtime. The tag is desktop-v3.4.5 (identity 4.4.5.0) so no
 * shipped number is pinned by a test.
 *
 * Each package test injects one defect and asserts on the exit code and the
 * printed line a reader would see. The live 2026-08-27 artifact is the
 * integration proof and runs only with STORE_SUBMIT_LIVE=1 (it needs gh, the
 * network, and about 8 MB).
 *
 * Run: node --test .claude/skills/store-submit/scripts/msix-preflight.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import {
    chooseRun,
    describeArtifact,
    identityVersion,
    parseArgs,
    parseManifest,
    parseTag,
    pickArtifact,
    readZipEntry,
} from './msix-preflight.mjs';

const SCRIPT = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');
const REPO = resolve(dirname(SCRIPT), '..', '..', '..', '..');
const TEMPLATE = readFileSync(
    join(REPO, 'desktop/build/msix/AppxManifest.xml'),
    'utf8'
);
const TAG = 'desktop-v3.4.5';
const IDENTITY = '4.4.5.0';
const FILE = `FloeDesktop_${IDENTITY}_x64.msix`;
const MAKEAPPX = { zip64: true, descriptor: true, deflate: true };
const made = [];

function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'msix-preflight-'));
    made.push(dir);
    return dir;
}

// A freshly written .msix can still hold a delete-pending handle on Windows,
// so the wipe retries instead of failing the run on the last step.
after(() => {
    for (const d of made)
        rmSync(d, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
        });
});

// A valid zip in memory, in either shape. Returns the bytes plus where each
// entry's (possibly compressed) data starts, so a test can corrupt it.
function makeZip(
    entries,
    { zip64 = false, descriptor = false, deflate = false }
) {
    const parts = [];
    let offset = 0;
    const push = (b) => {
        parts.push(b);
        offset += b.length;
    };
    const central = [];
    const offsets = {};
    const version = zip64 ? 45 : 20;
    for (const { name, data, store = false } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const method = deflate && !store ? 8 : 0;
        const payload = method === 8 ? zlib.deflateRawSync(data) : data;
        const crc = zlib.crc32(data);
        const flags = descriptor ? 0x0008 : 0;
        const lho = offset;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(version, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(descriptor ? 0 : crc, 14);
        local.writeUInt32LE(descriptor ? 0 : payload.length, 18);
        local.writeUInt32LE(descriptor ? 0 : data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        push(local);
        push(nameBuf);
        offsets[name] = { dataStart: offset, csz: payload.length };
        push(payload);
        if (descriptor) {
            const d = Buffer.alloc(zip64 ? 24 : 16);
            d.writeUInt32LE(0x08074b50, 0);
            d.writeUInt32LE(crc, 4);
            if (zip64) {
                d.writeBigUInt64LE(BigInt(payload.length), 8);
                d.writeBigUInt64LE(BigInt(data.length), 16);
            } else {
                d.writeUInt32LE(payload.length, 8);
                d.writeUInt32LE(data.length, 12);
            }
            push(d);
        }
        central.push({
            nameBuf,
            method,
            flags,
            crc,
            csz: payload.length,
            usz: data.length,
            lho,
        });
    }
    const cdOff = offset;
    for (const c of central) {
        const extra = Buffer.alloc(zip64 ? 28 : 0);
        if (zip64) {
            extra.writeUInt16LE(0x0001, 0);
            extra.writeUInt16LE(24, 2);
            extra.writeBigUInt64LE(BigInt(c.usz), 4);
            extra.writeBigUInt64LE(BigInt(c.csz), 12);
            extra.writeBigUInt64LE(BigInt(c.lho), 20);
        }
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(version, 4);
        h.writeUInt16LE(version, 6);
        h.writeUInt16LE(c.flags, 8);
        h.writeUInt16LE(c.method, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt16LE(0x21, 14);
        h.writeUInt32LE(c.crc, 16);
        h.writeUInt32LE(zip64 ? 0xffffffff : c.csz, 20);
        h.writeUInt32LE(zip64 ? 0xffffffff : c.usz, 24);
        h.writeUInt16LE(c.nameBuf.length, 28);
        h.writeUInt16LE(extra.length, 30);
        h.writeUInt16LE(0, 32);
        h.writeUInt16LE(0, 34);
        h.writeUInt16LE(0, 36);
        h.writeUInt32LE(0, 38);
        h.writeUInt32LE(zip64 ? 0xffffffff : c.lho, 42);
        push(h);
        push(c.nameBuf);
        push(extra);
    }
    const cdSize = offset - cdOff;
    if (zip64) {
        const recOff = offset;
        const rec = Buffer.alloc(56);
        rec.writeUInt32LE(0x06064b50, 0);
        rec.writeBigUInt64LE(44n, 4);
        rec.writeUInt16LE(45, 12);
        rec.writeUInt16LE(45, 14);
        rec.writeUInt32LE(0, 16);
        rec.writeUInt32LE(0, 20);
        rec.writeBigUInt64LE(BigInt(central.length), 24);
        rec.writeBigUInt64LE(BigInt(central.length), 32);
        rec.writeBigUInt64LE(BigInt(cdSize), 40);
        rec.writeBigUInt64LE(BigInt(cdOff), 48);
        push(rec);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0);
        loc.writeUInt32LE(0, 4);
        loc.writeBigUInt64LE(BigInt(recOff), 8);
        loc.writeUInt32LE(1, 16);
        push(loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(zip64 ? 0xffff : central.length, 8);
    eocd.writeUInt16LE(zip64 ? 0xffff : central.length, 10);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : cdSize, 12);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : cdOff, 16);
    eocd.writeUInt16LE(0, 20);
    push(eocd);
    return { buf: Buffer.concat(parts), offsets };
}

const manifest = (version = IDENTITY, edit = (s) => s) =>
    Buffer.from(edit(TEMPLATE.replaceAll('__IDENTITY_VERSION__', version)));

function entries({ manifestText = manifest(), blockMap = true } = {}) {
    const list = [
        { name: 'AppxManifest.xml', data: manifestText },
        {
            name: '[Content_Types].xml',
            data: Buffer.from(
                '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png" /><Default Extension="xml" ContentType="application/vnd.ms-appx.manifest+xml" /></Types>'
            ),
        },
        {
            name: 'Assets/StoreLogo.png',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            store: true,
        },
    ];
    if (blockMap) {
        list.splice(1, 0, {
            name: 'AppxBlockMap.xml',
            data: Buffer.from(
                '<?xml version="1.0" encoding="UTF-8"?><BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256"></BlockMap>'
            ),
        });
    }
    return list;
}

function pack(dir, { name = FILE, list = entries(), shape = MAKEAPPX } = {}) {
    const { buf, offsets } = makeZip(list, shape);
    const file = join(dir, name);
    writeFileSync(file, buf);
    return { file, buf, offsets };
}

function run(args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

const fileMode = (file) => ['--desktop', TAG, '--file', file, '--root', REPO];

test('a makeappx-shaped package (Zip64, data descriptors, deflate) is ready with the identity from the tag', () => {
    const { file } = pack(fresh());
    const r = run(fileMode(file));
    assert.equal(r.status, 0, r.out);
    assert.match(
        r.out,
        /^msix-preflight: desktop-v3\.4\.5 -> identity 4\.4\.5\.0, file FloeDesktop_4\.4\.5\.0_x64\.msix$/m
    );
    assert.match(r.out, /^ok    package   Zip64, 4 entries/m);
    assert.match(r.out, /^ok    manifest  AppxManifest\.xml \(deflate, /m);
    assert.match(r.out, /^ok    Identity  Version 4\.4\.5\.0$/m);
    assert.match(r.out, /^ok    Properties DisplayName "Floe Desktop"/m);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.match(r.out, new RegExp(`^ok    sha256    ${sha}$`, 'm'));
    assert.match(r.out, /^READY$/m);
    assert.match(r.out, new RegExp(`^  sha256    ${sha}$`, 'm'));
    assert.match(
        r.out,
        /^  identity  JanCarloParedes\.FloeDesktop 4\.4\.5\.0 x64$/m
    );
    assert.match(r.out, /^msix-preflight: desktop-v3\.4\.5 ready$/m);
    assert.doesNotMatch(r.out, /^FAIL/m);
});

test('a plain stored classic zip with the same layout is ready too', () => {
    const { file } = pack(fresh(), { shape: {} });
    const r = run(fileMode(file));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^ok    package   classic zip, 4 entries/m);
    assert.match(r.out, /^ok    manifest  AppxManifest\.xml \(stored, /m);
    assert.match(r.out, /^READY$/m);
});

test('--json reports the same verdict as an object', () => {
    const { file } = pack(fresh());
    const r = run([...fileMode(file), '--json']);
    assert.equal(r.status, 0, r.out);
    const report = JSON.parse(r.stdout);
    assert.equal(report.tag, TAG);
    assert.equal(report.identityVersion, IDENTITY);
    assert.equal(report.mode, 'file');
    assert.equal(report.manifest.Version, IDENTITY);
    assert.equal(report.expected.Version, IDENTITY);
    assert.equal(report.findings.length, 0);
    assert.equal(report.exitCode, 0);
    assert.equal(report.msix.path, file);
});

test('a manifest stamped with the previous identity version is a Version finding', () => {
    const { file } = pack(fresh(), {
        list: entries({ manifestText: manifest('4.4.4.0') }),
    });
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  Identity  Version 4\.4\.4\.0, expected 4\.4\.5\.0 from desktop-v3\.4\.5$/m
    );
    assert.match(r.out, /^msix-preflight: desktop-v3\.4\.5: 1 finding\(s\)$/m);
    assert.doesNotMatch(r.out, /^READY$/m);
});

test('a manifest whose Publisher differs from the template is a Publisher finding', () => {
    const { file } = pack(fresh(), {
        list: entries({
            manifestText: manifest(IDENTITY, (s) =>
                s.replace(
                    'Publisher="CN=5D497A40-D927-4850-8A83-E21F677E80E3"',
                    'Publisher="CN=00000000-0000-0000-0000-000000000000"'
                )
            ),
        }),
    });
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  Identity  Publisher CN=00000000-0000-0000-0000-000000000000, expected CN=5D497A40-D927-4850-8A83-E21F677E80E3/m
    );
});

test('a package without AppxManifest.xml is a manifest finding', () => {
    const { file } = pack(fresh(), {
        list: entries().filter((e) => e.name !== 'AppxManifest.xml'),
    });
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  manifest  AppxManifest\.xml is not in the package \(3 entries\)$/m
    );
});

test('a package with two AppxManifest.xml entries is a package finding, not a read of whichever copy comes first', () => {
    const { file } = pack(fresh(), {
        list: [
            ...entries(),
            { name: 'AppxManifest.xml', data: manifest('4.4.4.0') },
        ],
    });
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  package   duplicate entries: AppxManifest\.xml \(/m
    );
    assert.doesNotMatch(r.out, /^ok    package/m);
    assert.doesNotMatch(r.out, /^READY$/m);
});

test('a text file renamed .msix is not a zip', () => {
    const dir = fresh();
    const file = join(dir, FILE);
    writeFileSync(file, 'this is not a package\n'.repeat(40));
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  package   not a zip: no end-of-central-directory record$/m
    );
});

test('one flipped byte inside the deflated manifest is a crc or inflate finding', () => {
    const dir = fresh();
    const { file, buf, offsets } = pack(dir);
    const { dataStart, csz } = offsets['AppxManifest.xml'];
    assert.ok(csz > 16, 'the deflated manifest must be long enough to hit');
    const at = dataStart + Math.floor(csz / 2);
    buf[at] ^= 0xff;
    writeFileSync(file, buf);
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^FAIL  manifest  AppxManifest\.xml: .*(crc|inflate)/m);
});

test('one flipped byte inside a stored asset is an integrity finding', () => {
    const dir = fresh();
    const { file, buf, offsets } = pack(dir);
    const asset = offsets['Assets/StoreLogo.png'];
    assert.ok(asset && asset.csz > 0, 'the fixture carries a stored asset');
    buf[asset.dataStart] ^= 0xff;
    writeFileSync(file, buf);
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  integrity 1 of \d+ entries fail: Assets\/StoreLogo\.png: crc32/m
    );
    assert.match(r.out, /^ok    manifest  AppxManifest\.xml/m);
});

test('a zip without AppxBlockMap.xml is not a makeappx package', () => {
    const { file } = pack(fresh(), { list: entries({ blockMap: false }) });
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  package   not a makeappx package: AppxBlockMap\.xml missing/m
    );
});

test('a file named for the previous identity while the manifest says the new one is a file-name finding', () => {
    const { file } = pack(fresh(), { name: 'FloeDesktop_4.4.4.0_x64.msix' });
    const r = run(fileMode(file));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^FAIL  msix      .*: file name FloeDesktop_4\.4\.4\.0_x64\.msix, expected FloeDesktop_4\.4\.5\.0_x64\.msix$/m
    );
    assert.match(r.out, /^ok    Identity  Version 4\.4\.5\.0$/m);
});

test('usage errors exit 2 before anything is read', () => {
    const { file } = pack(fresh());
    const cases = [
        ['--desktop', 'desktop-v3.4.5-rc1', '--file', file],
        ['--desktop', 'v3.4.5', '--file', file],
        ['--desktop', TAG, '--file', file, '--out', fresh()],
        ['--file', file],
        ['--desktop', TAG],
        ['--desktop', TAG, '--file', file, '--root', fresh()],
    ];
    for (const args of cases) {
        const r = run(args);
        assert.equal(r.status, 2, `${args.join(' ')}\n${r.out}`);
        assert.match(r.out, /^msix-preflight: /m);
    }
});

test('--file on a directory or a missing path is a usage error, not a stack trace', () => {
    const dir = fresh();
    const r = run(['--desktop', TAG, '--file', dir, '--root', REPO, '--json']);
    assert.equal(r.status, 2, r.out);
    assert.match(
        r.out,
        /^msix-preflight: --file .* is a directory, not a file$/m
    );
    assert.doesNotMatch(r.out, /EISDIR/);
    assert.equal(
        r.stdout,
        '',
        '--json prints nothing on stdout on a usage error'
    );
    const missing = run([
        '--desktop',
        TAG,
        '--file',
        join(dir, 'nope.msix'),
        '--root',
        REPO,
    ]);
    assert.equal(missing.status, 2, missing.out);
    assert.match(missing.out, /^msix-preflight: --file .* does not exist$/m);
    assert.throws(
        () => parseArgs(['--desktop', TAG, '--file', dir, '--root', REPO]),
        /is a directory, not a file/
    );
});

test('--out pointing at an existing file is a usage error before any gh call', () => {
    const file = join(fresh(), 'notes.txt');
    writeFileSync(file, 'x\n');
    assert.throws(
        () => parseArgs(['--desktop', TAG, '--out', file, '--root', REPO]),
        /--out .* is a file, not a directory/
    );
    const r = run(['--desktop', TAG, '--out', file, '--root', REPO]);
    assert.equal(r.status, 2, r.out);
    assert.match(
        r.out,
        /^msix-preflight: --out .* is a file, not a directory$/m
    );
    assert.doesNotMatch(r.out, /^(ok|WARN|FAIL) /m);
});

test('--self-test is green', () => {
    const r = run(['--self-test']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /self-test green \(6 fixtures\)/);
    assert.doesNotMatch(r.out, /^FAIL/m);
});

test('parseTag and identityVersion accept only strictly numeric desktop-v tags', () => {
    assert.deepEqual(parseTag('desktop-v0.10.0'), {
        tag: 'desktop-v0.10.0',
        version: '0.10.0',
        major: 0,
        minor: 10,
        patch: 0,
    });
    assert.equal(identityVersion('desktop-v0.10.0'), '1.10.0.0');
    assert.equal(identityVersion('desktop-v1.0.0'), '2.0.0.0');
    assert.equal(identityVersion('desktop-v0.2'), null);
    assert.equal(identityVersion('desktop-v0.2.8-rc1'), null);
    assert.equal(identityVersion('v0.2.8'), null);
    assert.equal(identityVersion(undefined), null);
});

test('parseArgs throws on every malformed combination and resolves the rest', () => {
    const { file } = pack(fresh());
    const a = parseArgs(['--desktop', TAG, '--file', file, '--root', REPO]);
    assert.equal(a.file, file);
    assert.equal(a.root, REPO);
    assert.equal(a.json, false);
    assert.throws(() => parseArgs([]), /--desktop/);
    assert.throws(
        () => parseArgs(['--desktop', 'v1.2.3', '--out', 'x']),
        /strictly numeric/
    );
    assert.throws(() => parseArgs(['--desktop', TAG]), /--out/);
    assert.throws(
        () => parseArgs(['--desktop', TAG, '--file', file, '--out', 'x']),
        /exclusive/
    );
    assert.throws(
        () => parseArgs(['--desktop', TAG, '--file', file, '--repo', 'o/r']),
        /--repo only applies/
    );
    assert.throws(() => parseArgs(['--desktop']), /needs a value/);
    assert.throws(() => parseArgs(['--desktop', TAG, '--bogus']), /unknown/);
});

// The recorded 2026-08-27 shapes: `gh run list` for desktop-v0.2.8 and the
// artifacts endpoint of each run. Run 13 was created one second after run 12
// and holds nothing.
const RUN_12 = {
    databaseId: 33109830152,
    number: 12,
    conclusion: 'success',
    status: 'completed',
    createdAt: '2026-08-27T19:43:39Z',
    headSha: '608dee7a9abc446b6cbb744aedefe3236847d332',
};
const RUN_13 = {
    databaseId: 33109832188,
    number: 13,
    conclusion: 'cancelled',
    status: 'completed',
    createdAt: '2026-08-27T19:43:40Z',
    headSha: '608dee7a9abc446b6cbb744aedefe3236847d332',
};
const ARTIFACT_12 = {
    id: 9662107967,
    name: 'floe-desktop-msix-0.2.8-run12',
    size_in_bytes: 7471955,
    expired: false,
    created_at: '2026-08-27T19:46:11Z',
    expires_at: '2026-11-25T19:43:39Z',
};

test('chooseRun picks the successful run with the artifact and lists the canceled twin', () => {
    const byRun = new Map([
        [RUN_13.databaseId, []],
        [RUN_12.databaseId, [ARTIFACT_12]],
    ]);
    const c = chooseRun([RUN_13, RUN_12], byRun, '0.2.8');
    assert.equal(c.chosen.databaseId, 33109830152);
    assert.equal(c.artifact.name, 'floe-desktop-msix-0.2.8-run12');
    assert.equal(c.twins.length, 1);
    assert.equal(c.twins[0].run.databaseId, 33109832188);
    assert.deepEqual(c.warnings, [
        'twin 33109832188 (number 13, cancelled, 2026-08-27T19:43:40Z, sha 608dee7) holds 0 artifacts; ignored',
    ]);
    assert.equal(c.message, null);
    // A plain object keyed by id works as well as a Map.
    const viaObject = chooseRun(
        [RUN_13, RUN_12],
        { [RUN_12.databaseId]: [ARTIFACT_12], [RUN_13.databaseId]: [] },
        '0.2.8'
    );
    assert.equal(viaObject.chosen.databaseId, 33109830152);
});

test('chooseRun with no candidate says so and names floe-release step 4', () => {
    const inProgress = { ...RUN_12, status: 'in_progress', conclusion: '' };
    const c = chooseRun(
        [RUN_13, inProgress],
        new Map([
            [RUN_13.databaseId, []],
            [RUN_12.databaseId, []],
        ]),
        '0.2.8'
    );
    assert.equal(c.chosen, null);
    assert.equal(c.twins.length, 2);
    assert.equal(
        c.message,
        'no successful desktop-release.yml run with a floe-desktop-msix-0.2.8 artifact for desktop-v0.2.8; a run still in progress or a failed run points at floe-release step 4 (re-cut, never rerun)'
    );
    // A success run whose artifact is for another version is not a candidate.
    const other = chooseRun(
        [RUN_12],
        new Map([[RUN_12.databaseId, [ARTIFACT_12]]]),
        '0.2.9'
    );
    assert.equal(other.chosen, null);
    assert.equal(chooseRun([], new Map(), '0.2.8').chosen, null);
});

test('chooseRun with two candidates keeps the newest and warns about the older', () => {
    const older = {
        ...RUN_12,
        databaseId: 1,
        number: 11,
        createdAt: '2026-08-27T19:00:00Z',
    };
    const c = chooseRun(
        [older, RUN_12],
        new Map([
            [1, [{ ...ARTIFACT_12, name: 'floe-desktop-msix-0.2.8-run11' }]],
            [RUN_12.databaseId, [ARTIFACT_12]],
        ]),
        '0.2.8'
    );
    assert.equal(c.chosen.databaseId, 33109830152);
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /^older candidate 1 \(number 11/);
});

test('pickArtifact reports an expired artifact with its date and the guidance', () => {
    const now = Date.parse('2026-08-28T12:00:00Z');
    const live = pickArtifact([ARTIFACT_12], '0.2.8', now);
    assert.equal(live.expired, false);
    assert.equal(live.daysLeft, 89);
    assert.equal(live.guidance, null);
    const flagged = pickArtifact(
        [{ ...ARTIFACT_12, expired: true }],
        '0.2.8',
        now
    );
    assert.equal(flagged.expired, true);
    assert.equal(flagged.expiresAt, '2026-11-25T19:43:39Z');
    assert.equal(
        flagged.guidance,
        'artifact floe-desktop-msix-0.2.8-run12 expired on 2026-11-25T19:43:39Z: do not rerun or dispatch desktop-release.yml (a rerun is refused after 30 days; a dispatch stamps main.version=dev and reuses the committed wails.json version); cut the next number with floe-release'
    );
    const past = pickArtifact(
        [ARTIFACT_12],
        '0.2.8',
        Date.parse('2026-12-01T00:00:00Z')
    );
    assert.equal(past.expired, true);
    assert.ok(past.daysLeft < 0);
    assert.equal(pickArtifact([ARTIFACT_12], '0.2.9', now).artifact, null);
    assert.equal(pickArtifact([], '0.2.8', now).artifact, null);
});

test('describeArtifact says expires unknown when GitHub sends no expires_at', () => {
    const now = Date.parse('2026-08-28T12:00:00Z');
    assert.equal(
        describeArtifact(
            ARTIFACT_12,
            pickArtifact([ARTIFACT_12], '0.2.8', now)
        ),
        'floe-desktop-msix-0.2.8-run12 (id 9662107967, 7,471,955 bytes, expires 2026-11-25T19:43:39Z, 89 days left)'
    );
    const bare = { ...ARTIFACT_12 };
    delete bare.expires_at;
    const picked = pickArtifact([bare], '0.2.8', now);
    assert.equal(picked.expiresAt, null);
    assert.equal(picked.daysLeft, null);
    assert.equal(picked.expired, false);
    assert.equal(
        describeArtifact(bare, picked),
        'floe-desktop-msix-0.2.8-run12 (id 9662107967, 7,471,955 bytes, expires unknown)'
    );
    assert.doesNotMatch(describeArtifact(bare, picked), /null/);
});

test('readZipEntry verifies an entry in both builder shapes', () => {
    const list = entries();
    for (const shape of [MAKEAPPX, {}, { zip64: true }, { descriptor: true }]) {
        const { buf } = makeZip(list, shape);
        const e = readZipEntry(buf, 'AppxManifest.xml');
        assert.equal(e.entries, 4, JSON.stringify(shape));
        assert.deepEqual(e.names, [
            'AppxManifest.xml',
            'AppxBlockMap.xml',
            '[Content_Types].xml',
            'Assets/StoreLogo.png',
        ]);
        assert.equal(e.method, shape.deflate ? 8 : 0);
        assert.equal(e.zip64, Boolean(shape.zip64));
        assert.equal(e.usz, manifest().length);
        assert.ok(e.data.equals(manifest()), JSON.stringify(shape));
        const png = readZipEntry(buf, 'Assets/StoreLogo.png');
        assert.equal(png.method, 0);
        assert.equal(png.data.length, 8);
        assert.throws(
            () => readZipEntry(buf, 'nope.xml'),
            (err) =>
                err.message.includes('not in the package') &&
                err.names.length === 4
        );
    }
    assert.throws(
        () =>
            readZipEntry(Buffer.from('not a zip at all, not even close'), 'x'),
        /not a zip/
    );
});

test('parseManifest reads only the Identity element and the Properties block', () => {
    const m = parseManifest(
        `\uFEFF${TEMPLATE.replaceAll('__IDENTITY_VERSION__', '9.9.9.0')}`
    );
    assert.equal(m.Name, 'JanCarloParedes.FloeDesktop');
    assert.equal(m.Publisher, 'CN=5D497A40-D927-4850-8A83-E21F677E80E3');
    assert.equal(m.Version, '9.9.9.0');
    assert.equal(m.ProcessorArchitecture, 'x64');
    assert.equal(m.DisplayName, 'Floe Desktop');
    assert.equal(m.PublisherDisplayName, 'Jan Carlo Paredes');
    assert.equal(m.MinVersion, '10.0.19041.0');
    // Attribute order and line breaks inside the element do not matter.
    const reordered = parseManifest(
        '<Package><Identity ProcessorArchitecture="x64"\n  Version="1.0.0.0" Publisher="CN=x" Name="A.B"/><Properties><DisplayName>D</DisplayName><PublisherDisplayName>P</PublisherDisplayName></Properties><Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.0.0" /></Dependencies></Package>'
    );
    assert.deepEqual(reordered, {
        Name: 'A.B',
        Publisher: 'CN=x',
        Version: '1.0.0.0',
        ProcessorArchitecture: 'x64',
        DisplayName: 'D',
        PublisherDisplayName: 'P',
        MinVersion: '10.0.0.0',
    });
    assert.equal(parseManifest('<Package></Package>').Name, null);
});

const REAL = {
    Name: 'A.B',
    Publisher: 'CN=x',
    Version: '1.0.0.0',
    ProcessorArchitecture: 'x64',
    DisplayName: 'D',
    PublisherDisplayName: 'P',
    MinVersion: '10.0.0.0',
};

test('parseManifest skips a commented-out Identity ahead of the real one', () => {
    const m = parseManifest(
        [
            '<Package>',
            '<!-- <Identity Name="Old.App" Publisher="CN=old" Version="0.0.0.1"',
            '  ProcessorArchitecture="x86" /> -->',
            '<Identity Name="A.B" Publisher="CN=x" Version="1.0.0.0" ProcessorArchitecture="x64"/>',
            '<Properties><!-- <DisplayName>Old</DisplayName> --><DisplayName>D</DisplayName><PublisherDisplayName>P</PublisherDisplayName></Properties>',
            '<Dependencies><!-- <TargetDeviceFamily Name="Windows.Desktop" MinVersion="1.0.0.0" /> --><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.0.0" /></Dependencies>',
            '</Package>',
        ].join('\n')
    );
    assert.deepEqual(m, REAL);
    // The same defect inside a package still comes out READY.
    const { file } = pack(fresh(), {
        list: entries({
            manifestText: manifest(IDENTITY, (s) =>
                s.replace(
                    '<Identity',
                    '<!-- <Identity Name="Old.App" Version="0.0.0.1" /> -->\n  <Identity'
                )
            ),
        }),
    });
    const r = run(fileMode(file));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^ok    Identity  Name JanCarloParedes\.FloeDesktop$/m);
});

test('parseManifest accepts single-quoted attributes, in either mix', () => {
    const single = parseManifest(
        "<Package><Identity Name='A.B' Publisher='CN=x' Version='1.0.0.0' ProcessorArchitecture='x64'/><Properties><DisplayName>D</DisplayName><PublisherDisplayName>P</PublisherDisplayName></Properties><Dependencies><TargetDeviceFamily Name='Windows.Desktop' MinVersion='10.0.0.0' /></Dependencies></Package>"
    );
    assert.deepEqual(single, REAL);
    // Mixed quotes, with each style's opposite quote inside a value.
    const mixed = parseManifest(
        `<Package><Identity Name='A.B' Publisher="CN=O'Brien" Version='1.0.0.0' ProcessorArchitecture='x"64'/><Properties><DisplayName>D</DisplayName><PublisherDisplayName>P</PublisherDisplayName></Properties><Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion='10.0.0.0' /></Dependencies></Package>`
    );
    assert.equal(mixed.Publisher, "CN=O'Brien");
    assert.equal(mixed.ProcessorArchitecture, 'x"64');
    assert.equal(mixed.MinVersion, '10.0.0.0');
});

test(
    'the live 2026-08-27 artifact passes gh mode end to end',
    { skip: !process.env.STORE_SUBMIT_LIVE },
    () => {
        const out = fresh();
        const r = run([
            '--desktop',
            'desktop-v0.2.8',
            '--out',
            out,
            '--root',
            REPO,
        ]);
        assert.ok([0, 4].includes(r.status), r.out);
        if (r.status === 0) {
            assert.match(
                r.out,
                /^ok    run       33109830152 \(number 12, success/m
            );
            assert.match(
                r.out,
                /^WARN  run       twin 33109832188 \(number 13, cancelled/m
            );
            assert.match(r.out, /^ok    Identity  Version 1\.2\.8\.0$/m);
            assert.match(r.out, /^READY$/m);
        } else {
            assert.match(
                r.out,
                /^FAIL  artifact  artifact floe-desktop-msix-0\.2\.8-run12 expired on/m
            );
        }
    }
);
