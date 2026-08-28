#!/usr/bin/env node
/**
 * Measures whether the MSIX a desktop-v* tag produced is the one to hand to
 * Partner Center: the right desktop-release.yml run, an artifact that still
 * exists, a package makeappx built, and a manifest whose Identity matches the
 * Store product and the tag.
 *
 * Why the run is chosen instead of taken from `gh run list --limit 1`: the
 * 2026-08-27 release pushed two tags in one push and every tag workflow fired
 * twice. desktop-release.yml run 33109832188 (number 13) was created one
 * second after run 33109830152 (number 12), was canceled, and holds zero
 * artifacts, yet it is the newest run for desktop-v0.2.8. A candidate here
 * must be status completed, conclusion success, AND carry the
 * floe-desktop-msix-<X.Y.Z>-run<N> artifact; every other run for the tag is
 * reported as a twin so the reader sees why it lost.
 *
 * Why an expired artifact is a hard stop with its own exit: the MSIX is only
 * a workflow artifact (path dist-msix/, 90 days from the run's createdAt),
 * never a release asset, and both ways of getting it back produce the wrong
 * package. A rerun is refused after 30 days, and a workflow_dispatch stamps
 * main.version=dev and reuses the committed wails.json version. The remedy
 * is the next number with floe-release, so the script says so and stops.
 *
 * Why the package is read in-process: makeappx writes Zip64 with data
 * descriptors (general-purpose flag bit 3), so every local header carries
 * crc and sizes of 0 and the real values sit in the central directory's
 * 0x0001 extra field. Nothing on PATH validates that (tar.exe streams an
 * entry but checks no crc), so this is a reader over the central directory
 * only, with zlib.inflateRawSync and zlib.crc32 from Node 22. The manifest is
 * compared attribute by attribute against desktop/build/msix/
 * AppxManifest.xml, not byte for byte, because the packed copy carries the
 * line endings of the runner's checkout (CRLF on the 2026-08-27 build,
 * 2,740 bytes; an LF checkout stamps 2,676) and pack.ps1 stamps the version
 * into the template's comment as well as the Identity.
 *
 * Why --out must sit under a scratchpad: the browser file_upload tool refused
 * every other path on 2026-08-02 and 2026-08-14, and that upload is the step
 * this preflight exists for.
 *
 * Green does NOT prove that the exe inside is the tagged commit's build, that
 * the package installs (it is unsigned by design; only Partner Center's
 * re-signed copy installs), that Partner Center accepts the Identity (it
 * validates Name and Publisher against the product on upload), or that the
 * version is higher than the one the Store lists today.
 *
 * Usage:
 *   node .claude/skills/store-submit/scripts/msix-preflight.mjs
 *       --desktop desktop-vX.Y.Z --out <dir> [--repo owner/name]
 *       [--root <dir>] [--json]
 *   node .claude/skills/store-submit/scripts/msix-preflight.mjs
 *       --desktop desktop-vX.Y.Z --file <path.msix> [--root <dir>] [--json]
 *   node .claude/skills/store-submit/scripts/msix-preflight.mjs --self-test
 * Tests:
 *   node --test .claude/skills/store-submit/scripts/msix-preflight.test.mjs
 * Exit: 0 ready, 1 findings, 2 usage, 3 no successful run or no artifact,
 * 4 artifact expired, 5 gh failure. A usage error prints its message on
 * stderr and nothing on stdout, --json included, so a caller parsing stdout
 * sees an empty document with exit 2.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// scripts/ -> store-submit/ -> skills/ -> .claude/ -> repo root.
const DEFAULT_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..'
);
const TEMPLATE = 'desktop/build/msix/AppxManifest.xml';
const PIN_FILE = 'client/lib/desktopRelease.ts';
const WORKFLOW = 'desktop-release.yml';
const MANIFEST = 'AppxManifest.xml';
// makeappx writes these two next to the manifest in every package; a zip
// without them was not packed by makeappx, whatever its extension says.
const REQUIRED = ['AppxBlockMap.xml', '[Content_Types].xml'];
// Mirrors the "Derive version" step of desktop-release.yml: strictly numeric
// X.Y.Z after the prefix, no suffix (NSIS VIProductVersion rejects one).
const DESKTOP_TAG = /^desktop-v(\d+)\.(\d+)\.(\d+)$/;
// The 0.2.8 package is 7,587,775 bytes; anything under a mebibyte is a
// download that stopped early, not a package.
const MIN_MSIX_BYTES = 1024 * 1024;
const EXPIRY_WARN_DAYS = 7;
const DAY_MS = 86400000;
// The zip comment can be up to 64 KiB, so the EOCD record can sit that far
// from the end of the file.
const EOCD_SCAN = 65536 + 22;
const SIG = {
    local: 0x04034b50,
    central: 0x02014b50,
    eocd: 0x06054b50,
    zip64Locator: 0x07064b50,
    zip64Record: 0x06064b50,
};
const IDENTITY_KEYS = ['Name', 'Publisher', 'Version', 'ProcessorArchitecture'];
const PROPERTY_KEYS = ['DisplayName', 'PublisherDisplayName', 'MinVersion'];

// [tag, identity version, or null when the tag is refused]. Run with
// --self-test.
const SELF_TEST = [
    ['desktop-v0.2.8', '1.2.8.0'],
    ['desktop-v1.0.0', '2.0.0.0'],
    ['desktop-v0.10.0', '1.10.0.0'],
    ['desktop-v0.2.8-rc1', null],
    ['v0.2.8', null],
    ['desktop-v0.2', null],
];

export function parseTag(tag) {
    const m = DESKTOP_TAG.exec(tag || '');
    if (!m) return null;
    const [major, minor, patch] = m.slice(1).map(Number);
    return { tag, version: `${major}.${minor}.${patch}`, major, minor, patch };
}

// pack.ps1's rule: the Store rejects an Identity Version whose first octet
// is 0 and reserves the fourth, so (major+1).minor.patch.0 keeps the mapping
// mechanical and monotonic (0.2.8 -> 1.2.8.0, 1.0.0 -> 2.0.0.0).
export function identityVersion(tag) {
    const t = parseTag(tag);
    return t ? `${t.major + 1}.${t.minor}.${t.patch}.0` : null;
}

export const fileNameFor = (identity) => `FloeDesktop_${identity}_x64.msix`;

function selfTest() {
    let failed = 0;
    for (const [tag, want] of SELF_TEST) {
        const got = identityVersion(tag);
        const pass = got === want;
        if (!pass) failed += 1;
        console.log(
            `${pass ? 'ok  ' : 'FAIL'} ${tag} -> ${want === null ? 'refused' : want}${pass ? '' : `, got ${got}`}`
        );
    }
    console.log(
        `msix-preflight: self-test ${failed ? `${failed} failure(s)` : 'green'} (${SELF_TEST.length} fixtures)`
    );
    process.exit(failed ? 1 : 0);
}

function usage(message) {
    console.error(`msix-preflight: ${message}`);
    return 2;
}

export function parseArgs(argv, { root = DEFAULT_ROOT } = {}) {
    const opts = {
        desktop: null,
        out: null,
        file: null,
        repo: null,
        root,
        json: false,
    };
    const value = (flag, v) => {
        if (v === undefined || v.startsWith('--'))
            throw new Error(`${flag} needs a value`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--desktop') opts.desktop = value(a, argv[++i]);
        else if (a === '--out') opts.out = value(a, argv[++i]);
        else if (a === '--file') opts.file = value(a, argv[++i]);
        else if (a === '--repo') opts.repo = value(a, argv[++i]);
        else if (a === '--root') opts.root = value(a, argv[++i]);
        else if (a === '--json') opts.json = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (!opts.desktop)
        throw new Error(
            'pass --desktop desktop-vX.Y.Z (no default: a stale local tag list would silently pick the previous release), or --self-test'
        );
    if (!parseTag(opts.desktop))
        throw new Error(
            `--desktop wants desktop-vX.Y.Z, strictly numeric, got ${opts.desktop}`
        );
    if (opts.file && opts.out)
        throw new Error(
            '--file and --out are exclusive: --file skips gh, --out is where gh downloads'
        );
    if (!opts.file && !opts.out)
        throw new Error(
            'pass --out <dir> (download the artifact with gh) or --file <path.msix> (a package already on disk)'
        );
    if (opts.repo && opts.file)
        throw new Error('--repo only applies with --out');
    opts.root = path.resolve(opts.root);
    if (!existsSync(path.join(opts.root, TEMPLATE)))
        throw new Error(`--root ${opts.root} has no ${TEMPLATE}`);
    // Both paths are stat-checked here so a directory or a stray file is a
    // usage error, not an EISDIR from readFileSync (--file) or an ENOTDIR
    // from mkdirSync after three gh calls have already run (--out).
    if (opts.file) {
        opts.file = path.resolve(opts.file);
        const st = statSync(opts.file, { throwIfNoEntry: false });
        if (!st) throw new Error(`--file ${opts.file} does not exist`);
        if (st.isDirectory())
            throw new Error(`--file ${opts.file} is a directory, not a file`);
        if (!st.isFile())
            throw new Error(`--file ${opts.file} is not a regular file`);
    }
    if (opts.out) {
        opts.out = path.resolve(opts.out);
        const st = statSync(opts.out, { throwIfNoEntry: false });
        if (st && !st.isDirectory())
            throw new Error(`--out ${opts.out} is a file, not a directory`);
    }
    return opts;
}

class GhError extends Error {}

// argv arrays and no shell: PowerShell 5.1 mangles quoted arguments to
// native executables, and jq is absent here, so JSON is parsed in Node.
function gh(args, cwd) {
    try {
        return execFileSync('gh', args, {
            cwd,
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch (e) {
        const detail = (e.stderr || e.message || '').toString().trim();
        throw new GhError(
            `gh ${args.join(' ')} failed: ${JSON.stringify(detail)}; run gh auth status`
        );
    }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const artifactRe = (version) =>
    new RegExp(`^floe-desktop-msix-${escapeRe(version)}-run\\d+$`);
const num = (n) => n.toLocaleString('en-US');
const describeRun = (run) =>
    `${run.databaseId} (number ${run.number}, ${run.conclusion || run.status}, ${run.createdAt}, sha ${(run.headSha || '').slice(0, 7) || '?'})`;

// The artifact for this version among a run's artifacts, with its expiry
// read the way GitHub reports it: `expired` flips to true after the fact and
// `expires_at` is the deadline, so both are honored.
export function pickArtifact(artifacts, version, now = Date.now()) {
    const re = artifactRe(version);
    const artifact = (artifacts || []).find((a) => re.test(a.name)) || null;
    if (!artifact) {
        return {
            artifact: null,
            expired: false,
            expiresAt: null,
            daysLeft: null,
            guidance: null,
        };
    }
    const expiresAt = artifact.expires_at || null;
    const ms = expiresAt ? Date.parse(expiresAt) : NaN;
    const daysLeft = Number.isNaN(ms) ? null : Math.floor((ms - now) / DAY_MS);
    const expired =
        artifact.expired === true || (!Number.isNaN(ms) && ms <= now);
    const guidance = expired
        ? `artifact ${artifact.name} expired on ${expiresAt || 'an unknown date'}: do not rerun or dispatch desktop-release.yml (a rerun is refused after 30 days; a dispatch stamps main.version=dev and reuses the committed wails.json version); cut the next number with floe-release`
        : null;
    return { artifact, expired, expiresAt, daysLeft, guidance };
}

// The artifact line of the report. An artifact record without expires_at
// (GitHub omits it on some listings) says "expires unknown" and carries no
// days-left clause, rather than "expires null, null days left".
export function describeArtifact(a, picked) {
    const days =
        picked.daysLeft === null ? '' : `, ${picked.daysLeft} days left`;
    const expiry = picked.expiresAt
        ? `expires ${picked.expiresAt}${days}`
        : 'expires unknown';
    return `${a.name} (id ${a.id}, ${num(a.size_in_bytes)} bytes, ${expiry})`;
}

// Pure decision over the runs for a tag and their artifact lists (a Map or
// an object keyed by databaseId). Exported so msix-preflight.test.mjs can
// replay the 2026-08-27 twin without a network.
export function chooseRun(runs, artifactsByRun, version) {
    const lookup = (id) =>
        artifactsByRun instanceof Map
            ? (artifactsByRun.get(id) ?? artifactsByRun.get(String(id)))
            : artifactsByRun?.[id];
    const candidates = [];
    const twins = [];
    for (const run of runs || []) {
        const artifacts = lookup(run.databaseId) || [];
        const picked = pickArtifact(artifacts, version);
        if (
            run.status === 'completed' &&
            run.conclusion === 'success' &&
            picked.artifact
        ) {
            candidates.push({ run, artifacts, artifact: picked.artifact });
        } else {
            twins.push({
                run,
                artifacts,
                line: `twin ${describeRun(run)} holds ${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}; ignored`,
            });
        }
    }
    candidates.sort(
        (a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt)
    );
    const chosen = candidates[0] || null;
    const warnings = twins.map((t) => t.line);
    for (const c of candidates.slice(1)) {
        warnings.push(
            `older candidate ${describeRun(c.run)} also holds ${c.artifact.name}; the newest run wins`
        );
    }
    const message = chosen
        ? null
        : `no successful ${WORKFLOW} run with a floe-desktop-msix-${version} artifact for desktop-v${version}; a run still in progress or a failed run points at floe-release step 4 (re-cut, never rerun)`;
    return {
        chosen: chosen ? chosen.run : null,
        artifact: chosen ? chosen.artifact : null,
        artifacts: chosen ? chosen.artifacts : [],
        candidates: candidates.map((c) => c.run),
        twins,
        warnings,
        message,
    };
}

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);
function u64(b, o, what) {
    const v = b.readBigUInt64LE(o);
    if (v >= 2n ** 53n)
        throw new Error(`${what} ${v} is beyond 2^53; refusing to address it`);
    return Number(v);
}
const hex8 = (n) => n.toString(16).padStart(8, '0');

// The central directory of a zip, classic or Zip64. Every size and offset
// comes from here and never from a local header: under flag bit 3 the local
// header carries zeros and the truth follows the data in a descriptor.
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
                // Only the saturated fields are present, in this order.
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

// One entry's bytes, verified: sizes from the central directory, method 0
// as-is, method 8 through inflateRawSync, then length and crc32 checked.
// Throws a reader-facing message; a missing entry carries `names` on the
// error so the caller can still say what the package does contain.
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
            `${name} is not in the package (${cd.entries} entries)`
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

// Every entry, not only the manifest: a package whose entries all inflate
// and match their crc32 is the package CI built, and a flipped byte inside
// a stored asset is invisible to the manifest check (measured 2026-08-28:
// offset 600 of the 1.2.8.0 package passed the manifest-only version).
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

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) =>
    s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e]);
// XML allows either quote style around an attribute value; makeappx keeps
// the template's double quotes, a hand-edited manifest may not.
function attrsOf(s) {
    const attrs = {};
    for (const m of s.matchAll(
        /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    ))
        attrs[m[1]] = decodeXml(m[2] ?? m[3]);
    return attrs;
}

// The Identity element's own attributes (the template's comment above it
// mentions versions too, so a whole-file search would be wrong), the two
// Properties names, and the TargetDeviceFamily MinVersion. Comments go
// first: a commented-out <Identity> ahead of the real one would otherwise
// be the one read.
export function parseManifest(text) {
    const src = String(text)
        .replace(/^\uFEFF/, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    const identity = attrsOf(src.match(/<Identity\b([\s\S]*?)\/?>/)?.[1] ?? '');
    const props =
        src.match(/<Properties\b[^>]*>([\s\S]*?)<\/Properties>/)?.[1] ?? '';
    const element = (tag) => {
        const m = props.match(
            new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`)
        );
        return m ? decodeXml(m[1].trim()) : null;
    };
    const family = attrsOf(
        src.match(/<TargetDeviceFamily\b([\s\S]*?)\/?>/)?.[1] ?? ''
    );
    return {
        Name: identity.Name ?? null,
        Publisher: identity.Publisher ?? null,
        Version: identity.Version ?? null,
        ProcessorArchitecture: identity.ProcessorArchitecture ?? null,
        DisplayName: element('DisplayName'),
        PublisherDisplayName: element('PublisherDisplayName'),
        MinVersion: family.MinVersion ?? null,
    };
}

function walkFiles(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(abs, out);
        else if (entry.isFile()) out.push(abs);
    }
    return out;
}

const fmt = (status, check, message) =>
    `${status.padEnd(4)}  ${check.padEnd(9)} ${message}`;
const quoted = (v) => (v === null ? '(missing)' : `"${v}"`);
const plain = (v) => (v === null ? '(missing)' : v);

function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        return usage(e.message);
    }
    const tag = opts.desktop;
    const { version } = parseTag(tag);
    const identity = identityVersion(tag);
    const fileName = fileNameFor(identity);
    const report = {
        tag,
        version,
        identityVersion: identity,
        fileName,
        mode: opts.file ? 'file' : 'gh',
        run: null,
        twins: [],
        artifact: null,
        msix: null,
        manifest: null,
        expected: null,
        checks: [],
        findings: [],
        warnings: [],
        summary: '',
        exitCode: 0,
    };
    const lines = [
        `msix-preflight: ${tag} -> identity ${identity}, file ${fileName}`,
    ];
    const say = (status, check, message) => {
        lines.push(fmt(status, check, message));
        report.checks.push({ status, check, message });
        if (status === 'FAIL') report.findings.push(`${check}: ${message}`);
        if (status === 'WARN') report.warnings.push(`${check}: ${message}`);
    };
    const finish = (code, summary) => {
        report.summary = summary;
        report.exitCode = code;
        if (opts.json) {
            console.log(JSON.stringify(report, null, 4));
        } else {
            for (const line of lines) console.log(line);
            console.log(summary);
        }
        return code;
    };
    const findingsSummary = () =>
        `msix-preflight: ${tag}: ${report.findings.length} finding(s)`;

    // The template is the source of every expected value except Version.
    const templatePath = path.join(opts.root, TEMPLATE);
    const expected = parseManifest(readFileSync(templatePath, 'utf8'));
    for (const key of [...IDENTITY_KEYS, ...PROPERTY_KEYS]) {
        if (key !== 'Version' && !expected[key])
            return usage(
                `${templatePath} has no ${key}; cannot know what to expect`
            );
    }
    expected.Version = identity;
    expected.fileName = fileName;
    report.expected = expected;

    let msixPath;
    if (opts.file) {
        msixPath = opts.file;
    } else {
        if (!/scratchpad/i.test(opts.out)) {
            say(
                'WARN',
                'out',
                `${opts.out} is not under a scratchpad directory; the browser file_upload tool refuses other paths (2026-08-02, 2026-08-14)`
            );
        }
        let repo = opts.repo;
        let runs;
        const artifactsByRun = new Map();
        try {
            if (!repo) {
                repo = gh(
                    [
                        'repo',
                        'view',
                        '--json',
                        'nameWithOwner',
                        '--jq',
                        '.nameWithOwner',
                    ],
                    opts.root
                );
            }
            runs = JSON.parse(
                gh(
                    [
                        'run',
                        'list',
                        '--workflow',
                        WORKFLOW,
                        '--branch',
                        tag,
                        '--event',
                        'push',
                        '--limit',
                        '50',
                        '--json',
                        'databaseId,number,conclusion,status,createdAt,headSha',
                        '--repo',
                        repo,
                    ],
                    opts.root
                )
            );
            for (const run of runs) {
                const body = JSON.parse(
                    gh(
                        [
                            'api',
                            `repos/${repo}/actions/runs/${run.databaseId}/artifacts`,
                        ],
                        opts.root
                    )
                );
                artifactsByRun.set(run.databaseId, body.artifacts || []);
            }
        } catch (e) {
            if (!(e instanceof GhError)) throw e;
            say('FAIL', 'gh', e.message);
            return finish(5, `msix-preflight: ${tag}: gh failed`);
        }
        const choice = chooseRun(runs, artifactsByRun, version);
        report.twins = choice.twins.map((t) => ({
            ...t.run,
            artifacts: t.artifacts.length,
        }));
        if (!choice.chosen) {
            for (const w of choice.warnings) say('WARN', 'run', w);
            say('FAIL', 'run', choice.message);
            return finish(3, `msix-preflight: ${tag}: ${choice.message}`);
        }
        const run = choice.chosen;
        report.run = run;
        say('ok', 'run', describeRun(run));
        for (const w of choice.warnings) say('WARN', 'run', w);
        const picked = pickArtifact(choice.artifacts, version);
        const a = picked.artifact;
        report.artifact = {
            id: a.id,
            name: a.name,
            size: a.size_in_bytes,
            expiresAt: picked.expiresAt,
            daysLeft: picked.daysLeft,
            expired: picked.expired,
        };
        if (picked.expired) {
            say('FAIL', 'artifact', picked.guidance);
            return finish(4, `msix-preflight: ${tag}: artifact expired`);
        }
        const detail = describeArtifact(a, picked);
        if (picked.daysLeft !== null && picked.daysLeft < EXPIRY_WARN_DAYS) {
            say(
                'WARN',
                'artifact',
                `${detail}; under ${EXPIRY_WARN_DAYS} days, upload before it is gone`
            );
        } else {
            say('ok', 'artifact', detail);
        }
        // A directory this script names, never --out itself, so a rerun can
        // wipe it without touching anything else the caller keeps there.
        const dir = path.join(opts.out, a.name);
        try {
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: true });
            gh(
                [
                    'run',
                    'download',
                    String(run.databaseId),
                    '-n',
                    a.name,
                    '--dir',
                    dir,
                    '--repo',
                    repo,
                ],
                opts.root
            );
        } catch (e) {
            if (!(e instanceof GhError)) {
                say('FAIL', 'download', `${dir}: ${e.message}`);
                return finish(1, findingsSummary());
            }
            say('FAIL', 'gh', e.message);
            return finish(5, `msix-preflight: ${tag}: gh failed`);
        }
        say('ok', 'download', dir);
        // gh extracts the artifact flat into --dir today; walk anyway in
        // case a later gh nests it under the artifact name.
        const found = walkFiles(dir).filter((f) =>
            f.toLowerCase().endsWith('.msix')
        );
        msixPath = found.find((f) => path.basename(f) === fileName) || null;
        for (const other of found) {
            if (other !== msixPath)
                say('WARN', 'msix', `also found ${other}; ignored`);
        }
        if (!msixPath) {
            say(
                'FAIL',
                'msix',
                found.length
                    ? `${fileName} not in ${dir}; found ${found.map((f) => path.basename(f)).join(', ')}`
                    : `no .msix under ${dir}`
            );
            return finish(1, findingsSummary());
        }
    }

    let buf;
    try {
        buf = readFileSync(msixPath);
    } catch (e) {
        say('FAIL', 'msix', `${msixPath}: ${e.message}`);
        return finish(1, findingsSummary());
    }
    const size = buf.length;
    const sha256 = createHash('sha256').update(buf).digest('hex');
    report.msix = { path: msixPath, size, sha256 };
    const base = path.basename(msixPath);
    if (base !== fileName) {
        say(
            'FAIL',
            'msix',
            `${msixPath} (${num(size)} bytes): file name ${base}, expected ${fileName}`
        );
    } else if (!opts.file && size < MIN_MSIX_BYTES) {
        say(
            'FAIL',
            'msix',
            `${msixPath} (${num(size)} bytes): truncated download, under 1 MiB`
        );
    } else {
        say('ok', 'msix', `${msixPath} (${num(size)} bytes)`);
    }
    say('ok', 'sha256', sha256);

    let cd;
    try {
        cd = readCentralDirectory(buf);
    } catch (e) {
        say('FAIL', 'package', e.message);
        return finish(1, findingsSummary());
    }
    const kind = cd.zip64 ? 'Zip64' : 'classic zip';
    // readZipEntry takes the first record with a name, so a second
    // AppxManifest.xml would be read or ignored by position alone. makeappx
    // never writes a name twice, and which copy Partner Center reads is
    // undefined, so duplicates fail closed here.
    const seen = new Set();
    const dupes = new Set();
    for (const n of cd.names) (seen.has(n) ? dupes : seen).add(n);
    if (dupes.size) {
        say(
            'FAIL',
            'package',
            `duplicate entries: ${[...dupes].join(', ')} (${kind}, ${num(cd.entries)} entries; makeappx never writes a name twice, and which copy Partner Center reads is undefined)`
        );
    }
    const missing = REQUIRED.filter((n) => !cd.names.includes(n));
    if (missing.length) {
        say(
            'FAIL',
            'package',
            `not a makeappx package: ${missing.join(' and ')} missing (${kind}, ${num(cd.entries)} entries)`
        );
    } else if (!dupes.size) {
        say(
            'ok',
            'package',
            `${kind}, ${num(cd.entries)} entries, ${REQUIRED.join(' and ')} present`
        );
    }
    const integrity = verifyEntries(buf, cd);
    if (integrity.failures.length) {
        say(
            'FAIL',
            'integrity',
            `${integrity.failures.length} of ${num(integrity.checked)} entries fail: ${integrity.failures[0].message}`
        );
    } else {
        say(
            'ok',
            'integrity',
            `${num(integrity.checked)} entries inflate and match their crc32`
        );
    }
    let entry;
    try {
        entry = readZipEntry(buf, MANIFEST);
    } catch (e) {
        say('FAIL', 'manifest', e.message);
        return finish(1, findingsSummary());
    }
    say(
        'ok',
        'manifest',
        `${MANIFEST} (${entry.method === 8 ? 'deflate' : 'stored'}, ${num(entry.usz)} bytes, crc ok)`
    );
    const manifest = parseManifest(entry.data.toString('utf8'));
    report.manifest = manifest;
    for (const key of IDENTITY_KEYS) {
        if (manifest[key] === expected[key]) {
            say('ok', 'Identity', `${key} ${manifest[key]}`);
        } else {
            say(
                'FAIL',
                'Identity',
                `${key} ${plain(manifest[key])}, expected ${expected[key]} from ${key === 'Version' ? tag : TEMPLATE}`
            );
        }
    }
    const badProps = PROPERTY_KEYS.filter((k) => manifest[k] !== expected[k]);
    if (!badProps.length) {
        say(
            'ok',
            'Properties',
            `DisplayName ${quoted(manifest.DisplayName)}, PublisherDisplayName ${quoted(manifest.PublisherDisplayName)}, MinVersion ${manifest.MinVersion}`
        );
    }
    for (const key of badProps) {
        const show = key === 'MinVersion' ? plain : quoted;
        say(
            'FAIL',
            'Properties',
            `${key} ${show(manifest[key])}, expected ${show(expected[key])} from ${TEMPLATE}`
        );
    }

    // The pin moves in floe-release step 6, after the assets exist, so a
    // mismatch is expected during a rehearsal and only a warning here.
    let pin = null;
    try {
        pin =
            readFileSync(path.join(opts.root, PIN_FILE), 'utf8').match(
                /DESKTOP_VERSION = '([^']*)'/
            )?.[1] ?? null;
    } catch {
        pin = null;
    }
    if (pin === version) {
        say('ok', 'pin', `${PIN_FILE} DESKTOP_VERSION ${pin}`);
    } else {
        say(
            'WARN',
            'pin',
            `${PIN_FILE} DESKTOP_VERSION is ${pin === null ? 'missing' : `'${pin}'`}, the tag says ${version}; floe-release step 6 has not merged, or this is a rehearsal`
        );
    }

    if (report.findings.length) return finish(1, findingsSummary());
    lines.push(
        'READY',
        `  ${'upload'.padEnd(10)}${msixPath}`,
        `  ${'identity'.padEnd(10)}${manifest.Name} ${manifest.Version} ${manifest.ProcessorArchitecture}`,
        `  ${'sha256'.padEnd(10)}${sha256}`,
        `  ${'replaces'.padEnd(10)}the package Partner Center lists today; expect it struck through after upload`
    );
    return finish(0, `msix-preflight: ${tag} ready`);
}

const invokedDirectly =
    process.argv[1] &&
    path.resolve(process.argv[1]).toLowerCase() ===
        fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
    if (process.argv.includes('--self-test')) selfTest();
    process.exit(main(process.argv.slice(2)));
}
