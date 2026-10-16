import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';
import { unzipSync, Zip, ZipPassThrough } from 'fflate';
import { buildZipEntries } from './download';
import {
    planZip,
    writeZip,
    ZipLimitError,
    ZIP32_LIMIT,
    ZIP_MAX_ENTRIES,
    type ZipSource,
} from './zipWriter';

// The transfer audit's zero-dependency reader (fixtures.mjs), loaded from the
// skill by path, so the archive is held to the same reader the audit's
// Download ZIP cell uses.
type AuditReader = {
    readCentralDirectory: (buf: Buffer) => { zip64: boolean; entries: number; names: string[] };
    verifyEntries: (buf: Buffer, cd?: unknown) => { checked: number; failures: unknown[] };
    readZip: (buf: Buffer) => { rel: string; sha256: string }[];
};
let auditReaderLoaded: AuditReader | null = null;
async function auditReader(): Promise<AuditReader> {
    if (auditReaderLoaded === null) {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const file = path.resolve(here, '../../.claude/skills/transfer-audit/scripts/lib/fixtures.mjs');
        auditReaderLoaded = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as AuditReader;
    }
    return auditReaderLoaded;
}

// The fixed bytes of one stored entry as fflate's streaming Zip writes it:
// local header 30, data descriptor 16, central directory record 46, plus the
// name twice; and the 22-byte end record once.
const PER_ENTRY = 30 + 16 + 46;
const END = 22;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

// Deterministic, non-repeating content, so a slice written twice or out of
// order changes the digest.
function patterned(n: number, seed: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let x = seed * 2654435761 + 1;
    for (let i = 0; i < n; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        out[i] = x >>> 24;
    }
    return out;
}

// What the receiving page hands Download ZIP, peer names included: two
// dotfiles that collide (#615), folders, a non-ASCII name, an empty file, and
// files that span several slices and several parts at the small sizes below.
function fixture(): { fileName: string; data: Uint8Array<ArrayBuffer> }[] {
    return [
        { fileName: 'report.pdf', data: patterned(10_000, 1) },
        { fileName: '.env', data: patterned(37, 2) },
        { fileName: '.env', data: patterned(38, 3) },
        { fileName: 'project/src/main.go', data: patterned(4096, 4) },
        { fileName: 'project/.gitignore', data: patterned(5, 5) },
        { fileName: 'данные/写真 1.jpg', data: patterned(9_999, 6) },
        { fileName: 'empty.txt', data: new Uint8Array(0) },
        { fileName: 'a:b?.txt', data: patterned(1, 7) },
    ];
}

const SMALL = { sliceBytes: 1000, partBytes: 4096, mtime: Date.UTC(2026, 9, 16, 12, 0, 0) };

async function build(items = fixture(), opts = SMALL) {
    const entries = buildZipEntries(items.map((f) => ({ fileName: f.fileName, blob: new Blob([f.data]) })));
    const parts: number[] = [];
    const written = await writeZip(entries, {
        ...opts,
        newPart: (bytes) => {
            parts.push(bytes.length);
            return new Blob([bytes]);
        },
    });
    const expected = new Map(entries.map((e, i) => [e.name, items[i].data]));
    return { entries, expected, parts, ...written, buf: await bytesOf(written.archive) };
}

// A Blob stand-in whose reads fail the way a broken Chromium blob does, after
// `okReads` successful slices. `slices` counts every slice taken.
function failingBlob(size: number, okReads: number) {
    const real = new Blob([patterned(size, 9)]);
    let reads = 0;
    const blob = {
        size,
        slices: 0,
        slice(start?: number, end?: number) {
            blob.slices++;
            const part = real.slice(start, end);
            return {
                size: part.size,
                arrayBuffer: () =>
                    reads++ < okReads ? part.arrayBuffer() : Promise.reject(new Error('NotReadableError')),
            };
        },
    };
    return blob;
}

describe('planZip', () => {
    it('counts exactly what writeZip writes', async () => {
        const { archive, entries } = await build();
        const plan = planZip(entries.map((e) => ({ name: e.name, size: e.blob.size })));
        expect(plan).toEqual({ ok: true, bytes: archive.size });
    });

    it('measures names in UTF-8 as fflate encodes them', () => {
        expect(planZip([{ name: 'a', size: 0 }])).toEqual({ ok: true, bytes: END + PER_ENTRY + 2 });
        // é is two bytes, 写 three, and a lone surrogate the three of U+FFFD.
        expect(planZip([{ name: 'é写\ud800', size: 0 }])).toEqual({ ok: true, bytes: END + PER_ENTRY + 2 * 8 });
    });

    it('allows 65,534 entries and refuses 65,535, whose count is the ZIP64 signal', () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, size: 1 }));
        expect(ZIP_MAX_ENTRIES).toBe(65_534);
        expect(planZip(many(65_534)).ok).toBe(true);
        expect(planZip(many(65_535))).toEqual({ ok: false, reason: 'too-many-entries' });
        expect(planZip(many(70_000))).toEqual({ ok: false, reason: 'too-many-entries' });
    });

    it('keeps the whole archive one byte under 0xFFFFFFFF', () => {
        const overhead = END + PER_ENTRY + 2;
        expect(planZip([{ name: 'a', size: ZIP32_LIMIT - overhead - 1 }])).toEqual({ ok: true, bytes: ZIP32_LIMIT - 1 });
        expect(planZip([{ name: 'a', size: ZIP32_LIMIT - overhead }])).toEqual({ ok: false, reason: 'too-large' });
    });

    it('refuses one entry of 0xFFFFFFFF bytes or more', () => {
        expect(planZip([{ name: 'a', size: ZIP32_LIMIT }])).toEqual({ ok: false, reason: 'too-large' });
        expect(planZip([{ name: 'a', size: 5 * 2 ** 30 }])).toEqual({ ok: false, reason: 'too-large' });
    });

    it('refuses when the running offset reaches 0xFFFFFFFF across entries', () => {
        // Two files of 2 GiB: each fits, the second one's header would not.
        const two = [
            { name: 'a.bin', size: 2 ** 31 },
            { name: 'b.bin', size: 2 ** 31 },
        ];
        expect(planZip(two.slice(0, 1)).ok).toBe(true);
        expect(planZip(two)).toEqual({ ok: false, reason: 'too-large' });
    });

    it('refuses a name longer than its 16-bit header field', () => {
        expect(planZip([{ name: 'n'.repeat(65_535), size: 0 }]).ok).toBe(true);
        expect(planZip([{ name: 'n'.repeat(65_536), size: 0 }])).toEqual({ ok: false, reason: 'name-too-long' });
        // 21,846 three-byte characters are 65,538 bytes.
        expect(planZip([{ name: '写'.repeat(21_846), size: 0 }])).toEqual({ ok: false, reason: 'name-too-long' });
    });
});

describe('writeZip', () => {
    it('writes every file, byte for byte, readable by fflate', async () => {
        const { buf, expected } = await build();
        const back = unzipSync(buf);
        expect(Object.keys(back).sort()).toEqual([...expected.keys()].sort());
        for (const [name, data] of expected) expect(sha256(back[name])).toBe(sha256(data));
        expect([...expected.keys()]).toEqual([
            'report.pdf',
            '.env',
            '.env (1)',
            'project/src/main.go',
            'project/.gitignore',
            'данные/写真 1.jpg',
            'empty.txt',
            'a_b_.txt',
        ]);
    });

    it('records each entry as stored, with its CRC-32 and size in the central directory', async () => {
        const { buf, expected } = await build();
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const end = buf.length - END;
        expect(view.getUint32(end, true)).toBe(0x06054b50);
        expect(view.getUint16(end + 10, true)).toBe(expected.size);
        let p = view.getUint32(end + 16, true);
        const decoder = new TextDecoder();
        for (const [name, data] of expected) {
            expect(view.getUint32(p, true)).toBe(0x02014b50);
            expect(view.getUint16(p + 10, true)).toBe(0); // stored
            expect(view.getUint32(p + 16, true)).toBe(crc32(data));
            expect(view.getUint32(p + 20, true)).toBe(data.length);
            expect(view.getUint32(p + 24, true)).toBe(data.length);
            const nameLen = view.getUint16(p + 28, true);
            expect(decoder.decode(buf.subarray(p + 46, p + 46 + nameLen))).toBe(name);
            p += 46 + nameLen;
        }
    });

    it('is read by the transfer audit central-directory reader with no failures', async () => {
        const { buf, expected } = await build();
        const audit = await auditReader();
        const nodeBuf = Buffer.from(buf);
        const cd = audit.readCentralDirectory(nodeBuf);
        expect(cd.zip64).toBe(false);
        expect(cd.entries).toBe(expected.size);
        expect(audit.verifyEntries(nodeBuf, cd)).toEqual({ checked: expected.size, failures: [] });
        const got = new Map(audit.readZip(nodeBuf).map((f) => [f.rel, f.sha256]));
        for (const [name, data] of expected) expect(got.get(name)).toBe(sha256(data));
    });

    it('gathers the archive into parts of the given size, never more at once', async () => {
        const { archive, parts } = await build();
        expect(parts.reduce((a, b) => a + b, 0)).toBe(archive.size);
        expect(parts.length).toBe(Math.ceil(archive.size / SMALL.partBytes));
        for (const n of parts.slice(0, -1)) expect(n).toBe(SMALL.partBytes);
    });

    it('reads each file a slice at a time', async () => {
        const blob = failingBlob(10_000, Infinity);
        const { archive } = await writeZip([{ name: 'big.bin', blob: blob as unknown as Blob }], SMALL);
        expect(blob.slices).toBe(10);
        expect(archive.size).toBe(END + PER_ENTRY + 2 * 'big.bin'.length + 10_000);
    });

    it('refuses before reading a byte when the archive would not fit', async () => {
        const huge = { size: 2 ** 32, slice: vi.fn() } as unknown as Blob;
        await expect(writeZip([{ name: 'a', blob: huge }])).rejects.toBeInstanceOf(ZipLimitError);
        expect((huge as unknown as { slice: ReturnType<typeof vi.fn> }).slice).not.toHaveBeenCalled();

        const tooMany: ZipSource[] = Array.from({ length: 65_535 }, (_, i) => ({ name: `f${i}`, blob: huge }));
        await expect(writeZip(tooMany)).rejects.toMatchObject({ reason: 'too-many-entries' });
        expect((huge as unknown as { slice: ReturnType<typeof vi.fn> }).slice).not.toHaveBeenCalled();
    });

    it('writes and reads back the largest entry count it allows', async () => {
        const one = new Blob([new Uint8Array([42])]);
        const entries: ZipSource[] = Array.from({ length: ZIP_MAX_ENTRIES }, (_, i) => ({ name: `f${i}`, blob: one }));
        const { archive, skipped } = await writeZip(entries);
        expect(skipped).toEqual([]);
        const buf = await bytesOf(archive);
        expect(Object.keys(unzipSync(buf)).length).toBe(ZIP_MAX_ENTRIES);
        expect((await auditReader()).readCentralDirectory(Buffer.from(buf)).entries).toBe(ZIP_MAX_ENTRIES);
    }, 60_000);

    it('leaves out a file that cannot be read at all, and says which', async () => {
        const broken = failingBlob(3000, 0);
        const good = new Blob([patterned(10, 1)]);
        const { archive, skipped } = await writeZip(
            [
                { name: 'good.bin', blob: good },
                { name: 'broken.bin', blob: broken as unknown as Blob },
                { name: 'also.bin', blob: good },
            ],
            SMALL
        );
        expect(skipped).toEqual([1]);
        const back = unzipSync(await bytesOf(archive));
        expect(Object.keys(back).sort()).toEqual(['also.bin', 'good.bin']);
    });

    it('fails the whole archive when a read fails partway through a file', async () => {
        const broken = failingBlob(3000, 1);
        await expect(
            writeZip([{ name: 'broken.bin', blob: broken as unknown as Blob }], SMALL)
        ).rejects.toThrow('NotReadableError');
    });

    it('fails on a short read rather than writing an entry shorter than its plan', async () => {
        const real = new Blob([patterned(3000, 3)]);
        const short = {
            size: 3000,
            // The first slice whole, so the entry starts; every later one a byte short.
            slice: (start = 0, end = 3000) => real.slice(start, start === 0 ? end : end - 1),
        } as unknown as Blob;
        await expect(writeZip([{ name: 's.bin', blob: short }], SMALL)).rejects.toThrow('short read');
    });

    it('fails the archive when a part cannot be read back, as a full blob store does', async () => {
        let made = 0;
        const brokenSecond = (bytes: Uint8Array<ArrayBuffer>) => {
            const part = new Blob([bytes]);
            if (++made !== 2) return part;
            return {
                size: part.size,
                slice: () => ({ arrayBuffer: () => Promise.reject(new Error('blob storage full')) }),
            } as unknown as Blob;
        };
        const items = fixture();
        const entries = buildZipEntries(items.map((f) => ({ fileName: f.fileName, blob: new Blob([f.data]) })));
        await expect(writeZip(entries, { ...SMALL, newPart: brokenSecond })).rejects.toThrow('blob storage full');
    });
});

describe('fflate, pinned', () => {
    it('writes a count of 65,535 as the ZIP64 signal, which the audit reader refuses', async () => {
        // Why ZIP_MAX_ENTRIES is 65,534, one under the plan's first bound.
        const chunks: Uint8Array[] = [];
        const zip = new Zip((err, chunk) => {
            if (!err) chunks.push(chunk);
        });
        for (let i = 0; i < 0xffff; i++) {
            const file = new ZipPassThrough(`f${i}`);
            zip.add(file);
            file.push(new Uint8Array([i & 255]), true);
        }
        zip.end();
        const buf = Buffer.concat(chunks);
        const audit = await auditReader();
        expect(() => audit.readCentralDirectory(buf)).toThrow(/zip64/);
    }, 60_000);

    it('writes no ZIP64 and truncates a size past 32 bits without an error', () => {
        // Why planZip refuses first: nothing else would. If a future fflate
        // starts to report this or writes ZIP64, this test says so.
        const chunks: Uint8Array[] = [];
        let error: unknown = null;
        const zip = new Zip((err, chunk) => {
            if (err) error = err;
            else chunks.push(chunk);
        });
        const file = new ZipPassThrough('big.bin');
        zip.add(file);
        file.size = 2 ** 32; // as if 4 GiB had already passed through
        file.push(new Uint8Array([1]), true);
        zip.end();
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
            out.set(c, o);
            o += c.length;
        }
        const view = new DataView(out.buffer);
        const central = out.length - END - (46 + 'big.bin'.length);
        expect(error).toBeNull();
        expect(view.getUint32(central, true)).toBe(0x02014b50);
        expect(view.getUint32(central + 24, true)).toBe(1); // 2 ** 32 + 1, cut to 32 bits
    });
});

// PowerShell's Expand-Archive, the reader a Windows user is most likely to
// meet (System.IO.Compression), on a file written to the OS temp folder.
// powershell.exe on Windows, pwsh elsewhere; skipped where neither runs.
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasShell =
    spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30_000 }).status === 0;

describe.skipIf(!hasShell)('Expand-Archive', () => {
    it('extracts every file, folders, dotfiles and names intact', async () => {
        const { buf, expected } = await build();
        const dir = mkdtempSync(path.join(tmpdir(), 'floe-zip-'));
        try {
            const zipPath = path.join(dir, 'floe_transfer.zip');
            const outDir = path.join(dir, 'out');
            writeFileSync(zipPath, buf);
            const run = spawnSync(
                shell,
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; " +
                        'Expand-Archive -LiteralPath $env:FLOE_ZIP -DestinationPath $env:FLOE_OUT',
                ],
                { env: { ...process.env, FLOE_ZIP: zipPath, FLOE_OUT: outDir }, encoding: 'utf8', timeout: 60_000 }
            );
            expect(run.status, run.stderr).toBe(0);
            for (const [name, data] of expected) {
                expect(sha256(readFileSync(path.join(outDir, ...name.split('/'))))).toBe(sha256(data));
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 90_000);
});
