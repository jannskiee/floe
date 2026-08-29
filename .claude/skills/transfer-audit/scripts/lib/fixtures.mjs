// Fixtures and integrity: random files with a streaming sha256, a sparse
// file for the relay-cap cell, the folder fixture the e2e suite uses,
// chunk-boundary sizes, output walking (refusing stale .part files), the
// expected-vs-received comparison, and a zero-dependency zip reader for
// the browser's Download ZIP path and the release side-load.
//
// The zip reader (readCentralDirectory, readZipEntry, verifyEntries) is
// copied from .claude/skills/store-submit/scripts/msix-preflight.mjs, where
// it reads makeappx's Zip64 packages with data descriptors; every size and
// offset comes from the central directory, never from a local header.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    closeSync,
    createReadStream,
    createWriteStream,
    ftruncateSync,
    mkdirSync,
    openSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const WIN = process.platform === 'win32';
export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;
export const DIR_BYTES = 12 * MiB;
/**
 * Default-matrix DIR cells with a desktop side. At loopback speed a 12 MiB
 * transfer is busy for about 0.4 s (measured 2026-08-28: avg 29 MB/s), too
 * short for the pill, which shows DIRECT or RELAY only while busy, and for
 * the completion oracle; 64 MiB keeps the window at about 2 s.
 */
export const DESKTOP_DIR_BYTES = 64 * MiB;
export const REL_BYTES = 4 * MiB;
export const CAP_BYTES = 3 * GiB;
export const THROUGHPUT_BYTES = 500 * MiB;
export const KILL_BYTES = 200 * MiB;
export const KILL_AT_BYTES = 50 * MiB;
// Chunk boundaries: 0, tiny, and one below, at and above 16 KiB and 256 KiB
// (client/lib/transfer/protocol.ts DEFAULT_CHUNK/MAX_CHUNK neighborhoods).
export const BOUNDARY_SIZES = Object.freeze([
    0, 512, 16383, 16384, 16385, 262143, 262144, 262145,
]);
/**
 * A deliberate spread from one byte to a large file, sent as ONE batch, so
 * a single cell exercises the whole range a user actually has: the tiny end
 * where per-file framing dominates, the chunk sizes either side of 64 KiB
 * and 1 MiB, and a file big enough to spend real time under backpressure.
 * BOUNDARY_SIZES covers the exact chunk edges; this covers the spread.
 */
export const SIZE_LADDER = Object.freeze([
    1,
    1024,
    64 * 1024,
    MiB,
    10 * MiB,
    100 * MiB,
]);
export const EMPTY_SHA256 =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const FOLDER_LAYOUT = Object.freeze([
    { rel: 'send-root/a.txt', bytes: 1024 },
    { rel: 'send-root/b.bin', bytes: 262157 },
    { rel: 'send-root/nested/c.bin', bytes: MiB },
]);

const CHUNK = 4 * MiB;

export function sha256Buffer(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/** Streaming sha256 of a file. */
export function sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(filePath)
            .on('data', (c) => h.update(c))
            .on('error', reject)
            .on('end', () => resolve(h.digest('hex')));
    });
}

/** Random bytes streamed in 4 MiB slabs; returns { path, bytes, sha256 }. */
export function makeRandomFile(filePath, bytes) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        const ws = createWriteStream(filePath);
        let left = bytes;
        ws.on('error', reject);
        ws.on('finish', () =>
            resolve({ path: filePath, bytes, sha256: h.digest('hex') })
        );
        const pump = () => {
            while (left > 0) {
                const n = Math.min(CHUNK, left);
                const buf = randomBytes(n);
                h.update(buf);
                left -= n;
                if (!ws.write(buf)) {
                    ws.once('drain', pump);
                    return;
                }
            }
            ws.end();
        };
        pump();
    });
}

/**
 * Sparse file of `bytes` for the relay-cap cell: the sender's gate sums
 * sizes only, so the bytes never have to exist. Best effort
 * `fsutil sparse setflag` on Windows, then a truncate to size.
 */
export function makeSparseFile(filePath, bytes, { exec = execFileSync } = {}) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    closeSync(openSync(filePath, 'w'));
    let sparse = false;
    if (WIN) {
        try {
            exec('fsutil', ['sparse', 'setflag', filePath], {
                stdio: 'ignore',
                windowsHide: true,
            });
            sparse = true;
        } catch {
            sparse = false;
        }
    }
    const fd = openSync(filePath, 'r+');
    try {
        ftruncateSync(fd, bytes);
    } finally {
        closeSync(fd);
    }
    const st = statSync(filePath);
    return { path: filePath, bytes: st.size, sparse, sha256: null };
}

export async function makeFolderFixture(dir) {
    const files = [];
    for (const f of FOLDER_LAYOUT) {
        const p = path.join(dir, ...f.rel.split('/'));
        const made = await makeRandomFile(p, f.bytes);
        files.push({
            name: path.basename(p),
            rel: f.rel,
            path: p,
            bytes: f.bytes,
            sha256: made.sha256,
        });
    }
    return {
        root: path.join(dir, 'send-root'),
        files,
        totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    };
}

export function fixtureName(bytes, suffix = '') {
    return `fixture-${bytes}${suffix}.bin`;
}

/**
 * ensureFixture(spec, dir) -> { kind, dir, paths, files, totalBytes }
 * spec: { kind: 'single'|'batch'|'folder'|'sparse', bytes?, sizes? }
 * `paths` is the sender's argv; `files` carries name, rel, bytes, sha256.
 */
export async function ensureFixture(spec, dir) {
    mkdirSync(dir, { recursive: true });
    const kind = spec.kind || 'single';
    if (kind === 'single') {
        const p = path.join(dir, fixtureName(spec.bytes));
        const made = await makeRandomFile(p, spec.bytes);
        const file = {
            name: path.basename(p),
            rel: path.basename(p),
            path: p,
            bytes: spec.bytes,
            sha256: made.sha256,
        };
        return { kind, dir, paths: [p], files: [file], totalBytes: spec.bytes };
    }
    if (kind === 'batch') {
        const files = [];
        for (const bytes of spec.sizes || BOUNDARY_SIZES) {
            const p = path.join(dir, fixtureName(bytes));
            const made = await makeRandomFile(p, bytes);
            files.push({
                name: path.basename(p),
                rel: path.basename(p),
                path: p,
                bytes,
                sha256: made.sha256,
            });
        }
        return {
            kind,
            dir,
            paths: files.map((f) => f.path),
            files,
            totalBytes: files.reduce((a, f) => a + f.bytes, 0),
        };
    }
    if (kind === 'folder') {
        const f = await makeFolderFixture(dir);
        return {
            kind,
            dir,
            paths: [f.root],
            files: f.files,
            totalBytes: f.totalBytes,
        };
    }
    if (kind === 'sparse') {
        const p = path.join(dir, fixtureName(spec.bytes, '-sparse'));
        const made = makeSparseFile(p, spec.bytes);
        const file = {
            name: path.basename(p),
            rel: path.basename(p),
            path: p,
            bytes: made.bytes,
            sha256: null,
            sparse: made.sparse,
        };
        return { kind, dir, paths: [p], files: [file], totalBytes: made.bytes };
    }
    throw new Error(`unknown fixture kind ${kind}`);
}

/**
 * Every file under dir: [{ name, rel, bytes, sha256, path, part }].
 * Throws on a `.part` file unless allowPart (a receiver that finished
 * cleanly never leaves one; the kill cells inspect them on purpose).
 */
export async function walkOutputs(dir, { allowPart = false } = {}) {
    const out = [];
    const walk = async (d, relBase) => {
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const abs = path.join(d, e.name);
            const rel = relBase ? `${relBase}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(abs, rel);
            else if (e.isFile()) {
                const part = /\.part$/i.test(e.name);
                if (part && !allowPart)
                    throw new Error(`stale .part file in output dir: ${rel}`);
                out.push({
                    name: e.name,
                    rel,
                    bytes: statSync(abs).size,
                    sha256: part ? null : await sha256OfFile(abs),
                    path: abs,
                    part,
                });
            }
        }
    };
    await walk(dir, '');
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const norm = (s) =>
    String(s || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');

/**
 * compareOutputs(expected, got) -> { ok, missing, extra, mismatched, files }
 * A received file matches an expected one by rel path, by the CLI's
 * `send-root/<rel>` suffix, or by flat name (browser downloads and the
 * "name (1).ext" retry landing are matched by the caller's `nameMap`).
 */
export function compareOutputs(expected, got, { nameMap = null } = {}) {
    const remaining = [...(got || [])].filter((g) => !g.part);
    const missing = [];
    const mismatched = [];
    const files = [];
    for (const e of expected || []) {
        const wantRel = norm(e.rel || e.name);
        const wantName = nameMap ? nameMap(e.name) : e.name;
        const idx = remaining.findIndex((g) => {
            const gr = norm(g.rel || g.name);
            return (
                gr === wantRel ||
                gr.endsWith('/' + wantRel) ||
                g.name === wantName ||
                (g.rel &&
                    path.posix.basename(gr) === wantName &&
                    !/\//.test(wantRel))
            );
        });
        if (idx < 0) {
            missing.push(wantRel);
            files.push({
                name: e.name,
                expected: e.sha256,
                actual: null,
                where: null,
            });
            continue;
        }
        const g = remaining.splice(idx, 1)[0];
        const same = e.sha256 === null || e.sha256 === g.sha256;
        if (!same)
            mismatched.push({
                rel: wantRel,
                expected: e.sha256,
                actual: g.sha256,
            });
        files.push({
            name: e.name,
            expected: e.sha256,
            actual: g.sha256,
            where: g.path || g.where || g.rel,
        });
    }
    const extra = remaining.map((g) => norm(g.rel || g.name));
    return {
        ok: !missing.length && !mismatched.length && !extra.length,
        missing,
        extra,
        mismatched,
        files,
    };
}

// ---------------------------------------------------------------------------
// Zip reader, copied from msix-preflight.mjs (store-submit skill).
// ---------------------------------------------------------------------------

const EOCD_SCAN = 65536 + 22;
const SIG = {
    local: 0x04034b50,
    central: 0x02014b50,
    eocd: 0x06054b50,
    zip64Locator: 0x07064b50,
    zip64Record: 0x06064b50,
};
const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);
function u64(b, o, what) {
    const v = b.readBigUInt64LE(o);
    if (v >= 2n ** 53n)
        throw new Error(`${what} ${v} is beyond 2^53; refusing to address it`);
    return Number(v);
}
const hex8 = (n) => n.toString(16).padStart(8, '0');

export function readCentralDirectory(buf) {
    const len = buf.length;
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - EOCD_SCAN); i--) {
        if (u32(buf, i) === SIG.eocd) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('not a zip: no end-of-central-directory record');
    let entries = u16(buf, eocd + 10);
    let cdSize = u32(buf, eocd + 12);
    let cdOff = u32(buf, eocd + 16);
    const locator = eocd - 20;
    const hasLocator = locator >= 0 && u32(buf, locator) === SIG.zip64Locator;
    const saturated =
        entries === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff;
    let zip64 = false;
    if (saturated || hasLocator) {
        if (!hasLocator)
            throw new Error(
                'zip64 sizes in the end-of-central-directory record but no zip64 locator before it'
            );
        const rec = u64(buf, locator + 8, 'zip64 record offset');
        if (rec + 56 > len || u32(buf, rec) !== SIG.zip64Record)
            throw new Error(
                `no zip64 end-of-central-directory record at offset ${rec}`
            );
        entries = u64(buf, rec + 32, 'zip64 entry count');
        cdSize = u64(buf, rec + 40, 'zip64 central directory size');
        cdOff = u64(buf, rec + 48, 'zip64 central directory offset');
        zip64 = true;
    }
    if (cdOff + cdSize > len)
        throw new Error(
            `central directory (${cdSize} bytes at ${cdOff}) runs past the end of the ${len}-byte file`
        );
    const records = [];
    let p = cdOff;
    for (let i = 0; i < entries; i++) {
        if (p + 46 > len || u32(buf, p) !== SIG.central)
            throw new Error(
                `central directory entry ${i} at offset ${p} has no 0x02014b50 signature`
            );
        const flags = u16(buf, p + 8);
        const method = u16(buf, p + 10);
        const crc = u32(buf, p + 16);
        let csz = u32(buf, p + 20);
        let usz = u32(buf, p + 24);
        const nameLen = u16(buf, p + 28);
        const extraLen = u16(buf, p + 30);
        const commentLen = u16(buf, p + 32);
        let lho = u32(buf, p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        let q = p + 46 + nameLen;
        const qEnd = q + extraLen;
        while (q + 4 <= qEnd) {
            const id = u16(buf, q);
            const size = u16(buf, q + 2);
            const fieldEnd = q + 4 + size;
            if (id === 0x0001) {
                let r = q + 4;
                const take = (what) => {
                    if (r + 8 > fieldEnd)
                        throw new Error(
                            `${name}: zip64 extra field is too short for its ${what}`
                        );
                    const v = u64(buf, r, `${name} zip64 ${what}`);
                    r += 8;
                    return v;
                };
                if (usz === 0xffffffff) usz = take('uncompressed size');
                if (csz === 0xffffffff) csz = take('compressed size');
                if (lho === 0xffffffff) lho = take('local header offset');
            }
            q = fieldEnd;
        }
        records.push({ name, flags, method, crc, csz, usz, lho });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { zip64, entries, names: records.map((r) => r.name), records };
}

function extractRecord(buf, rec) {
    const { name, lho, csz, usz, crc, method } = rec;
    if (lho + 30 > buf.length || u32(buf, lho) !== SIG.local)
        throw new Error(`${name}: no 0x04034b50 local header at offset ${lho}`);
    const start = lho + 30 + u16(buf, lho + 26) + u16(buf, lho + 28);
    if (start + csz > buf.length)
        throw new Error(`${name}: data runs past the end of the file`);
    const raw = buf.subarray(start, start + csz);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
        try {
            data = zlib.inflateRawSync(raw);
        } catch (e) {
            throw new Error(`${name}: inflate failed: ${e.message}`);
        }
    } else {
        throw new Error(
            `${name}: compression method ${method} is neither stored (0) nor deflate (8)`
        );
    }
    if (data.length !== usz)
        throw new Error(
            `${name}: ${method === 8 ? 'inflated to' : 'holds'} ${data.length} bytes, the central directory says ${usz}`
        );
    const got = zlib.crc32(data);
    if (got !== crc)
        throw new Error(
            `${name}: crc32 ${hex8(got)} does not match the central directory's ${hex8(crc)}`
        );
    return data;
}

export function readZipEntry(buf, name) {
    const cd = readCentralDirectory(buf);
    const rec = cd.records.find((r) => r.name === name);
    if (!rec) {
        const err = new Error(
            `${name} is not in the archive (${cd.entries} entries)`
        );
        err.names = cd.names;
        err.entries = cd.entries;
        throw err;
    }
    const data = extractRecord(buf, rec);
    return {
        data,
        method: rec.method,
        csz: rec.csz,
        usz: rec.usz,
        crc: rec.crc,
        entries: cd.entries,
        names: cd.names,
        zip64: cd.zip64,
    };
}

export function verifyEntries(buf, cd = readCentralDirectory(buf)) {
    const failures = [];
    for (const rec of cd.records) {
        try {
            extractRecord(buf, rec);
        } catch (e) {
            failures.push({ name: rec.name, message: e.message });
        }
    }
    return { checked: cd.records.length, failures };
}

/** Every file entry hashed: [{ name, rel, bytes, sha256, where }]. */
export function readZip(buf) {
    const cd = readCentralDirectory(buf);
    const out = [];
    for (const rec of cd.records) {
        if (rec.name.endsWith('/')) continue;
        const data = extractRecord(buf, rec);
        out.push({
            name: path.posix.basename(rec.name),
            rel: rec.name,
            bytes: data.length,
            sha256: sha256Buffer(data),
            where: `zip:${rec.name}`,
        });
    }
    return out;
}

/** Write one entry to destPath; returns { bytes, sha256 }. */
export function extractZipEntry(buf, name, destPath) {
    const entry = readZipEntry(buf, name);
    mkdirSync(path.dirname(destPath), { recursive: true });
    writeFileSync(destPath, entry.data);
    return { bytes: entry.data.length, sha256: sha256Buffer(entry.data) };
}

export const formatBytes = (n) => {
    if (n === null || n === undefined) return '-';
    if (n >= GiB) return `${(n / GiB).toFixed(n % GiB ? 1 : 0)} GiB`;
    if (n >= MiB) return `${(n / MiB).toFixed(n % MiB ? 1 : 0)} MiB`;
    if (n >= 1024) return `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} KiB`;
    return `${n} B`;
};
