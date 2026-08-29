// node --test .claude/skills/<skill>/scripts/lib/fixtures.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import zlib from 'node:zlib';

import {
    BOUNDARY_SIZES,
    EMPTY_SHA256,
    FOLDER_LAYOUT,
    compareOutputs,
    ensureFixture,
    extractZipEntry,
    formatBytes,
    makeRandomFile,
    makeSparseFile,
    readCentralDirectory,
    readZip,
    readZipEntry,
    sha256OfFile,
    verifyEntries,
    walkOutputs,
} from './fixtures.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'lta-fixtures-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

// Classic zip builder (stored or deflated), enough for readZip.
function makeZip(entries, { deflate = false } = {}) {
    const parts = [];
    let offset = 0;
    const central = [];
    const push = (b) => {
        parts.push(b);
        offset += b.length;
    };
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const method = deflate ? 8 : 0;
        const payload = deflate ? zlib.deflateRawSync(data) : data;
        const crc = zlib.crc32(data);
        const lho = offset;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        push(local);
        push(nameBuf);
        push(payload);
        central.push({
            nameBuf,
            method,
            crc,
            csz: payload.length,
            usz: data.length,
            lho,
        });
    }
    const cdOff = offset;
    for (const c of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(20, 6);
        h.writeUInt16LE(c.method, 10);
        h.writeUInt32LE(c.crc, 16);
        h.writeUInt32LE(c.csz, 20);
        h.writeUInt32LE(c.usz, 24);
        h.writeUInt16LE(c.nameBuf.length, 28);
        h.writeUInt32LE(c.lho, 42);
        push(h);
        push(c.nameBuf);
    }
    const cdSize = offset - cdOff;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOff, 16);
    push(eocd);
    return Buffer.concat(parts);
}

test('makeRandomFile streams and its sha256 matches sha256OfFile', async () => {
    const p = path.join(dir, 'rand.bin');
    const made = await makeRandomFile(p, 5 * 1024 * 1024 + 7);
    assert.equal(statSync(p).size, 5 * 1024 * 1024 + 7);
    assert.equal(made.sha256, await sha256OfFile(p));
    const empty = await makeRandomFile(path.join(dir, 'empty.bin'), 0);
    assert.equal(empty.sha256, EMPTY_SHA256);
});

test('makeSparseFile reports the requested size', () => {
    const p = path.join(dir, 'sparse.bin');
    const made = makeSparseFile(p, 1024 * 1024);
    assert.equal(made.bytes, 1024 * 1024);
    assert.equal(statSync(p).size, 1024 * 1024);
    assert.equal(made.sha256, null);
    assert.equal(typeof made.sparse, 'boolean');
});

test('ensureFixture: single, batch, folder, sparse', async () => {
    const single = await ensureFixture(
        { kind: 'single', bytes: 4096 },
        path.join(dir, 'single')
    );
    assert.equal(single.files[0].name, 'fixture-4096.bin');
    assert.equal(single.totalBytes, 4096);
    const batch = await ensureFixture(
        { kind: 'batch' },
        path.join(dir, 'batch')
    );
    assert.deepEqual(
        batch.files.map((f) => f.bytes),
        [...BOUNDARY_SIZES]
    );
    assert.equal(batch.files[0].sha256, EMPTY_SHA256);
    const folder = await ensureFixture(
        { kind: 'folder' },
        path.join(dir, 'folder')
    );
    assert.deepEqual(
        folder.files.map((f) => f.rel),
        FOLDER_LAYOUT.map((f) => f.rel)
    );
    assert.equal(folder.paths.length, 1);
    assert.ok(folder.paths[0].endsWith('send-root'));
    const sparse = await ensureFixture(
        { kind: 'sparse', bytes: 2048 },
        path.join(dir, 'sparse')
    );
    assert.equal(sparse.files[0].sha256, null);
    await assert.rejects(
        ensureFixture({ kind: 'nope' }, dir),
        /unknown fixture kind/
    );
});

test('walkOutputs hashes files and refuses .part unless allowed', async () => {
    const out = path.join(dir, 'out');
    const a = await makeRandomFile(path.join(out, 'a.bin'), 100);
    await makeRandomFile(path.join(out, 'nested', 'b.bin'), 10);
    const list = await walkOutputs(out);
    assert.deepEqual(
        list.map((f) => f.rel),
        ['a.bin', 'nested/b.bin']
    );
    assert.equal(list[0].sha256, a.sha256);
    writeFileSync(path.join(out, 'c.bin.part'), 'x');
    await assert.rejects(walkOutputs(out), /stale \.part/);
    const withPart = await walkOutputs(out, { allowPart: true });
    assert.equal(withPart.filter((f) => f.part).length, 1);
});

test('compareOutputs: flat names, nested rel and the CLI send-root prefix', () => {
    const expected = [
        { name: 'a.txt', rel: 'send-root/a.txt', sha256: 'aa' },
        { name: 'c.bin', rel: 'send-root/nested/c.bin', sha256: 'cc' },
    ];
    const flat = compareOutputs(expected, [
        { name: 'a.txt', rel: 'a.txt', sha256: 'aa' },
        { name: 'c.bin', rel: 'c.bin', sha256: 'cc' },
    ]);
    assert.equal(flat.ok, true);
    const nested = compareOutputs(expected, [
        { name: 'a.txt', rel: 'send-root/a.txt', sha256: 'aa' },
        { name: 'c.bin', rel: 'send-root/nested/c.bin', sha256: 'cc' },
    ]);
    assert.equal(nested.ok, true);
    const bad = compareOutputs(expected, [
        { name: 'a.txt', rel: 'send-root/a.txt', sha256: 'xx' },
        { name: 'z.bin', rel: 'z.bin', sha256: 'zz' },
    ]);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.missing, ['send-root/nested/c.bin']);
    assert.deepEqual(bad.extra, ['z.bin']);
    assert.equal(bad.mismatched.length, 1);
    const renamed = compareOutputs(
        [{ name: 'f.bin', rel: 'f.bin', sha256: 'ff' }],
        [{ name: 'f (1).bin', rel: 'f (1).bin', sha256: 'ff' }],
        { nameMap: () => 'f (1).bin' }
    );
    assert.equal(renamed.ok, true);
    const nullSha = compareOutputs(
        [{ name: 's.bin', rel: 's.bin', sha256: null }],
        [{ name: 's.bin', rel: 's.bin', sha256: 'whatever' }]
    );
    assert.equal(nullSha.ok, true);
});

test('zip reader: stored and deflated entries, central directory, extract', () => {
    const data = {
        'send-root/a.txt': Buffer.from('hello'),
        'send-root/nested/c.bin': Buffer.alloc(3000, 7),
    };
    for (const deflate of [false, true]) {
        const buf = makeZip(
            Object.entries(data).map(([name, d]) => ({ name, data: d })),
            { deflate }
        );
        const cd = readCentralDirectory(buf);
        assert.equal(cd.entries, 2);
        assert.equal(cd.zip64, false);
        const list = readZip(buf);
        assert.deepEqual(
            list.map((e) => e.rel),
            Object.keys(data)
        );
        assert.equal(
            list[0].sha256,
            createHash('sha256').update('hello').digest('hex')
        );
        assert.equal(list[0].name, 'a.txt');
        assert.equal(list[1].bytes, 3000);
        assert.equal(verifyEntries(buf).failures.length, 0);
        const entry = readZipEntry(buf, 'send-root/a.txt');
        assert.equal(entry.data.toString(), 'hello');
        assert.throws(() => readZipEntry(buf, 'missing'), /not in the archive/);
        const dest = path.join(dir, `x-${deflate}.txt`);
        extractZipEntry(buf, 'send-root/a.txt', dest);
        assert.equal(readFileSync(dest, 'utf8'), 'hello');
        // Corrupt one byte and the crc catches it.
        const bad = Buffer.from(buf);
        bad[30 + 'send-root/a.txt'.length + 1] ^= 0xff;
        assert.equal(verifyEntries(bad).failures.length, 1);
    }
    assert.throws(() => readCentralDirectory(Buffer.alloc(10)), /not a zip/);
});

test('formatBytes', () => {
    assert.equal(formatBytes(12 * 1024 * 1024), '12 MiB');
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3 GiB');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(null), '-');
});
