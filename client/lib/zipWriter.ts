/**
 * Download ZIP's archive writer: each received file is read a slice at a
 * time and written through fflate's streaming `Zip` as a stored (uncompressed)
 * entry, and the archive gathers into Blob parts the way the receiver gathers
 * a file (lib/transfer/receiver.ts, spill and probe).
 *
 * It replaced fflate's `zip()`, which needed every file in the tab as one
 * ArrayBuffer at once, deflated them (a large one in a worker, as a copy) and
 * returned the whole archive as one more buffer, so a large transfer could run
 * the tab out of memory before the archive existed. Here the tab holds one
 * slice and one part at a time, whatever the set's size.
 *
 * Stored, not deflated: deflating costs time on every byte (on the main
 * thread, or in a worker with a copy of each slice), and much of what people
 * send (photos, video, archives) is compressed already.
 * The archive is about the size of its files.
 *
 * fflate writes no ZIP64 and does not fail past its limits: every size and
 * offset goes through a 32-bit write that drops the high bits, and the entry
 * count is 16 bits, so a large archive comes out corrupt with no error
 * (measured at 5c40b30 through the old zip(): 65,536 files read back as none
 * in fflate and in .NET's ZipArchive, 70,000 as 4,464 in fflate and none in
 * .NET). `planZip` refuses those archives before a byte is read.
 */
import { Zip, ZipPassThrough } from 'fflate';
import { SPILL_BYTES } from './transfer/receiver';

/**
 * The largest archive this writer makes is one byte under this. Every size and
 * offset fflate writes is 32 bits, and 0xFFFFFFFF itself is the value that
 * tells a reader to look for ZIP64 fields, which this archive does not have:
 * the transfer audit's reader (fixtures.mjs, readCentralDirectory) refuses an
 * archive that has it with no ZIP64 record. Holding the whole archive under it
 * holds every entry's size, every local header's offset, the central
 * directory's offset and its size under it too.
 */
export const ZIP32_LIMIT = 0xffffffff;

/**
 * The most entries one archive holds. The end record's count is 16 bits, and
 * 0xFFFF is the same ZIP64 signal as above, so 65,535 is refused as well.
 */
export const ZIP_MAX_ENTRIES = 0xfffe;

/**
 * How much of a file is read into the tab at once. Large enough that the
 * per-read overhead is noise, small next to any device's memory.
 */
export const ZIP_SLICE_BYTES = 4 * 1024 * 1024;

/** Archive bytes gathered in the tab before they become one Blob part. */
export const ZIP_PART_BYTES = SPILL_BYTES;

// The fixed parts of a stored entry as fflate's streaming Zip writes them:
// a local header with no sizes (general purpose bit 3), the 16-byte data
// descriptor with its signature after the data, a central directory record,
// and the end record. No extra fields and no comments are written.
const LOCAL_HEADER = 30;
const DATA_DESCRIPTOR = 16;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_NAME_BYTES = 0xffff;

export type ZipRefusal = 'too-many-entries' | 'name-too-long' | 'too-large';

export type ZipPlan = { ok: true; bytes: number } | { ok: false; reason: ZipRefusal };

/** Thrown by `writeZip` before it reads anything, when `planZip` refuses. */
export class ZipLimitError extends Error {
    readonly reason: ZipRefusal;
    constructor(reason: ZipRefusal) {
        super(`zip refused: ${reason}`);
        this.name = 'ZipLimitError';
        this.reason = reason;
    }
}

const encoder = new TextEncoder();

/**
 * The exact size of the archive `writeZip` would make from these entries, or
 * why it will not make it. Names are measured as fflate encodes them (UTF-8
 * through TextEncoder, so a lone surrogate counts as the 3 bytes of U+FFFD).
 */
export function planZip(entries: readonly { name: string; size: number }[]): ZipPlan {
    if (entries.length > ZIP_MAX_ENTRIES) return { ok: false, reason: 'too-many-entries' };
    let bytes = END_RECORD;
    for (const { name, size } of entries) {
        const nameBytes = encoder.encode(name).length;
        // fflate reports this through the stream and then writes the header
        // anyway, with the length cut to 16 bits.
        if (nameBytes > MAX_NAME_BYTES) return { ok: false, reason: 'name-too-long' };
        bytes += LOCAL_HEADER + nameBytes + size + DATA_DESCRIPTOR + CENTRAL_HEADER + nameBytes;
        if (bytes >= ZIP32_LIMIT) return { ok: false, reason: 'too-large' };
    }
    return { ok: true, bytes };
}

export interface ZipSource {
    /** The entry path, already made safe and unique (buildZipEntries). */
    name: string;
    blob: Blob;
}

export interface WriteZipOptions {
    /** Before each entry is read: its 1-based position, the count, its name. */
    onEntry?: (index: number, count: number, name: string) => void;
    /** After the last entry, while the central directory is written and checked. */
    onFinish?: () => void;
    /** Stamped on every entry, in milliseconds. Defaults to now. */
    mtime?: number;
    sliceBytes?: number;
    partBytes?: number;
    /** Makes one Blob part; a test passes one whose read fails. */
    newPart?: (bytes: Uint8Array<ArrayBuffer>) => Blob;
}

export interface WrittenZip {
    archive: Blob;
    /**
     * Positions in the input of the entries left out because their first read
     * failed. Nothing of them is in the archive. A read that fails after an
     * entry has started fails the whole archive instead.
     */
    skipped: number[];
}

async function readSlice(blob: Blob, start: number, end: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    // A short read would leave the entry shorter than its plan and its CRC.
    if (bytes.length !== end - start) throw new Error('short read');
    return bytes;
}

// The receiver's spill and probe for the archive's own bytes. Every chunk
// fflate emits is copied into one staging buffer, which becomes a Blob part
// each time it fills, so the parts are few and even whatever the entry sizes.
// The Blob constructor copies a buffer's bytes (File API, "process blob
// parts"), so the stage is reused. In Chromium a part's bytes leave the tab
// for the browser's blob storage, which pages to disk past its memory share;
// when that storage is full, new Blob() still returns and only a read fails,
// so the last byte of every part is read back, as the receiver does, and a
// failed read fails the archive rather than handing over a broken one.
function createParts(partBytes: number, newPart: (bytes: Uint8Array<ArrayBuffer>) => Blob) {
    const parts: Blob[] = [];
    const probes: Promise<void>[] = [];
    const stage = new Uint8Array(partBytes);
    let used = 0;
    let broken: unknown = null;

    function spill(): void {
        if (used === 0) return;
        const part = newPart(stage.subarray(0, used));
        used = 0;
        parts.push(part);
        probes.push(
            part
                .slice(part.size - 1)
                .arrayBuffer()
                .then(
                    () => {},
                    (err: unknown) => {
                        broken ??= err ?? new Error('unreadable archive part');
                    }
                )
        );
    }

    return {
        write(chunk: Uint8Array): void {
            let off = 0;
            while (off < chunk.length) {
                const n = Math.min(chunk.length - off, partBytes - used);
                stage.set(chunk.subarray(off, off + n), used);
                used += n;
                off += n;
                if (used === partBytes) spill();
            }
        },
        broken(): unknown {
            return broken;
        },
        async finish(): Promise<Blob> {
            spill();
            // Every part's read-back, not only the newest: an earlier broken
            // part breaks the archive as surely as the last one.
            await Promise.all(probes);
            if (broken !== null) throw broken;
            // Composing Blobs from Blobs references their bytes, it copies nothing.
            return new Blob(parts, { type: 'application/zip' });
        },
    };
}

/**
 * Writes `entries` into one stored ZIP, in order. Throws `ZipLimitError`
 * before reading anything when `planZip` refuses, and any other error when a
 * read, a part or fflate fails; nothing it made is kept then.
 */
export async function writeZip(entries: readonly ZipSource[], opts: WriteZipOptions = {}): Promise<WrittenZip> {
    const plan = planZip(entries.map((e) => ({ name: e.name, size: e.blob.size })));
    if (!plan.ok) throw new ZipLimitError(plan.reason);

    const sliceBytes = opts.sliceBytes ?? ZIP_SLICE_BYTES;
    const out = createParts(opts.partBytes ?? ZIP_PART_BYTES, opts.newPart ?? ((bytes) => new Blob([bytes])));
    let zipError: unknown = null;
    // fflate hands an error to this callback and carries on (a name too long
    // for its header is one), so the first one is kept and stops the writer.
    const zip = new Zip((err, chunk) => {
        if (err) zipError ??= err;
        else out.write(chunk);
    });
    const check = () => {
        if (zipError !== null) throw zipError;
        const broken = out.broken();
        if (broken !== null) throw broken;
    };

    const mtime = opts.mtime ?? Date.now();
    const written: { name: string; size: number }[] = [];
    const skipped: number[] = [];

    for (let i = 0; i < entries.length; i++) {
        const { name, blob } = entries[i];
        const size = blob.size;
        opts.onEntry?.(i + 1, entries.length, name);

        // The first slice is read before the entry is added, so a file that
        // cannot be read at all is left out whole instead of failing the rest.
        let first: Uint8Array;
        try {
            first = await readSlice(blob, 0, Math.min(sliceBytes, size));
        } catch {
            skipped.push(i);
            continue;
        }
        const file = new ZipPassThrough(name);
        file.mtime = mtime;
        zip.add(file);
        let offset = first.length;
        file.push(first, offset === size);
        while (offset < size) {
            check();
            const end = Math.min(offset + sliceBytes, size);
            const bytes = await readSlice(blob, offset, end);
            offset = end;
            file.push(bytes, offset === size);
        }
        check();
        written.push({ name, size });
    }

    zip.end();
    check();
    opts.onFinish?.();
    const archive = await out.finish();

    // The archive is exactly what was planned for the entries written, or it
    // is not handed over: a layout that moved (a different fflate, say) could
    // otherwise pass the precheck and still overflow a field.
    const want = planZip(written);
    if (!want.ok || archive.size !== want.bytes) {
        throw new Error(`zip layout mismatch: wrote ${archive.size} bytes, planned ${want.ok ? want.bytes : want.reason}`);
    }
    return { archive, skipped };
}
