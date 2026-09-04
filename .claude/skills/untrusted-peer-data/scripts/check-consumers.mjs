#!/usr/bin/env node
/**
 * Staleness check for references/consumer-map.md.
 *
 * Why it exists: three PRs (#310, #311, #314) each hardened the one sink that
 * was in front of them and never looked at the others, and the 2026-08-28
 * hardening found the Go terminal, the desktop GUI and the browser error
 * banners still rendering raw peer strings. The map lists every file that
 * touches a peer-chosen value and the treatment each sink applies; this script
 * keeps the map honest by failing when a file starts referencing a peer field
 * without a row, when a row names a file that is gone, or when a row's anchor
 * symbol no longer exists (the code moved and the row now describes nothing).
 *
 * What green does NOT prove: that the rows are right, or that a new sink
 * inside an already-mapped file was classified. A file earns a row by matching
 * one token; every sink inside it is a human's job.
 *
 * Token limitation, stated on purpose: the wire fields `total`, `index`, `id`
 * and `offset` ride along with the named fields below. A file that read only
 * those (and none of fileName, fileSize, totalBytes, ver, reason or the message
 * struct names) would be invisible to this check.
 *
 * Anchors are substring matches. A second pass warns (never fails) when an
 * anchor is found only inside a longer identifier, so a row pinned to
 * `byteCount` that really matched `byteCountTotal` is visible; prefer the
 * definition form (`func name(`, `function name(`) for a function anchor.
 *
 * Usage:
 *   node check-consumers.mjs [--map <path>] [--root <dir>] [--json] [--strict-tests]
 * Exit 0 clean, 1 any UNMAPPED / STALE / ANCHOR-MISSING, 2 usage, missing
 * root, or map parse error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'wailsjs', 'dist', '.next']);
const EXTS = ['.go', '.ts', '.tsx'];
const COLUMNS = ['Field', 'File', 'Anchor', 'Sink', 'Treatment', 'Peer?'];

// The identifiers that mark a file as a consumer. A new wire field goes here
// (both spellings) in the same PR that adds it to the wire structs: as a
// `word` token when its name is wire-unique, as a `member` token (matched only
// as `.name`) when the bare word is too common to search for, which is why
// `ver` and `reason` live there.
export const FIELDS = {
    go: {
        word: [
            'FileName',
            'FileSize',
            'TotalBytes',
            'FirstName',
            'SavedName',
            'metadataMsg',
            'ackMsg',
            'incompatibleMsg',
            'endMsg',
            'IncomingInfo',
            'FileInfo',
        ],
        member: ['Ver', 'Reason'],
    },
    ts: {
        word: [
            'fileName',
            'fileSize',
            'totalBytes',
            'firstName',
            'savedName',
            'Metadata',
            'Ack',
            'End',
            'Incompatible',
        ],
        member: ['ver', 'reason'],
    },
};
// Files the map keeps although no token appears in them, for either of two
// reasons: they receive peer text under another name (`raw`, `names`, an SDP
// string), or every row they hold is a `none` row recording a sink that was
// checked and found peer-free. Both would otherwise draw a permanent
// obsolete-row warning that trains people to ignore warnings. A STALE still
// fires if one of them is deleted.
//
// desktop/app.go is the second kind, since #405 split the peer-handling half
// out to transfer.go and reveal.go. What is left there is `notify` and
// `notifyTransferFailed`, whose every call site passes a literal string
// ("Floe - send failed", "Floe"), so nothing peer-chosen reaches an OS
// notification. That is worth keeping as a row rather than deleting.
export const TOKEN_FREE = new Set([
    'desktop/frontend/src/errors.ts',
    'desktop/frontend/src/history.ts',
    'cli/engine/peer/connection.go',
    'desktop/app.go',
]);
const tokenRegex = (f) =>
    new RegExp(`\\b(${f.word.join('|')})\\b|\\.(${f.member.join('|')})\\b`);
const GO_TOKEN = tokenRegex(FIELDS.go);
const TS_TOKEN = tokenRegex(FIELDS.ts);

function parseArgs(argv) {
    const opts = {
        map: resolve(SCRIPT_DIR, '..', 'references', 'consumer-map.md'),
        root: resolve(SCRIPT_DIR, '..', '..', '..', '..'),
        json: false,
        strictTests: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--map') opts.map = resolve(argv[++i] || '');
        else if (a === '--root') opts.root = resolve(argv[++i] || '');
        else if (a === '--json') opts.json = true;
        else if (a === '--strict-tests') opts.strictTests = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return opts;
}

function rel(root, file) {
    return relative(root, file).split('\\').join('/');
}

function walk(dir, skip, out = []) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (skip(full)) continue;
        if (statSync(full).isDirectory()) walk(full, skip, out);
        else if (EXTS.includes(extname(name))) out.push(full);
    }
    return out;
}

function scanFiles(root) {
    const files = [];
    for (const r of [
        'cli/engine',
        'cli/cmd',
        'client/lib',
        'client/components',
        'client/hooks',
    ]) {
        files.push(...walk(join(root, r), () => false));
    }
    // desktop/ holds the Go app; its frontend is scanned separately so the
    // build output and the generated bindings never count.
    const frontend = join(root, 'desktop', 'frontend');
    const build = join(root, 'desktop', 'build');
    files.push(
        ...walk(join(root, 'desktop'), (p) => p === frontend || p === build)
    );
    files.push(...walk(join(root, 'desktop', 'frontend', 'src'), () => false));
    return files;
}

function isTest(relPath) {
    return /_test\.go$|\.test\.tsx?$|(^|\/)e2e\//.test(relPath);
}

// First token hit with its 1-based line, or null.
function firstToken(text, ext) {
    const re = ext === '.go' ? GO_TOKEN : TS_TOKEN;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) return { token: m[0], line: i + 1 };
    }
    return null;
}

// True when the anchor occurs only glued to other identifier characters, so
// the row is really pinned to a longer name. Boundaries are checked only on
// the sides where the anchor itself ends in an identifier character, so a
// definition-shaped anchor like `func byteCount(` is judged on its left edge.
function weakAnchor(text, anchor) {
    const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /\w/.test(anchor[0]) ? '(^|[^A-Za-z0-9_])' : '';
    const right = /\w/.test(anchor[anchor.length - 1])
        ? '(?=$|[^A-Za-z0-9_])'
        : '';
    return !new RegExp(left + esc + right, 'm').test(text);
}

export function parseMap(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex((l) => /^##\s+Map\s*$/.test(l));
    if (start < 0) throw new Error('consumer-map.md has no "## Map" heading');
    let i = start + 1;
    while (i < lines.length && !lines[i].startsWith('|')) i++;
    if (i >= lines.length) throw new Error('no table after "## Map"');
    const header = lines[i]
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
    if (header.join(',') !== COLUMNS.join(',')) {
        throw new Error(
            `map header must be | ${COLUMNS.join(' | ')} |, found | ${header.join(' | ')} |`
        );
    }
    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
        const line = lines[j];
        if (!line.startsWith('|')) break;
        const cells = line
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim());
        if (cells.length !== COLUMNS.length)
            throw new Error(
                `row ${j + 1}: expected ${COLUMNS.length} cells, found ${cells.length}`
            );
        const strip = (s) => s.replace(/^`|`$/g, '');
        rows.push({
            field: cells[0],
            file: strip(cells[1]).split('\\').join('/'),
            anchor: strip(cells[2]),
            sink: cells[3],
            treatment: cells[4],
            peer: cells[5],
            line: j + 1,
        });
    }
    if (!rows.length) throw new Error('the map table has no rows');
    return rows;
}

function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        console.error(e.message);
        return 2;
    }
    if (!existsSync(opts.root) || !statSync(opts.root).isDirectory()) {
        console.error(`root not found: ${opts.root}`);
        return 2;
    }
    if (!existsSync(opts.map)) {
        console.error(`map not found: ${opts.map}`);
        return 2;
    }
    let rows;
    try {
        rows = parseMap(readFileSync(opts.map, 'utf8'));
    } catch (e) {
        console.error(`map parse error: ${e.message}`);
        return 2;
    }
    const mapped = new Map();
    for (const r of rows) {
        if (!mapped.has(r.file)) mapped.set(r.file, []);
        mapped.get(r.file).push(r);
    }

    const result = { unmapped: [], stale: [], anchorMissing: [], warnings: [] };
    const matched = new Set();
    for (const file of scanFiles(opts.root)) {
        const relPath = rel(opts.root, file);
        const hit = firstToken(readFileSync(file, 'utf8'), extname(file));
        if (!hit) continue;
        matched.add(relPath);
        if (mapped.has(relPath)) continue;
        if (isTest(relPath) && !opts.strictTests) {
            result.warnings.push(
                `WARN unmapped-test ${relPath} (${hit.token} at :${hit.line})`
            );
        } else {
            result.unmapped.push(
                `UNMAPPED ${relPath} (${hit.token} at :${hit.line})`
            );
        }
    }
    for (const [file, fileRows] of mapped) {
        const full = join(opts.root, file);
        if (!existsSync(full)) {
            result.stale.push(`STALE ${file}`);
            continue;
        }
        const text = readFileSync(full, 'utf8');
        for (const r of fileRows) {
            if (!text.includes(r.anchor))
                result.anchorMissing.push(
                    `ANCHOR-MISSING ${file} ${r.anchor} (map line ${r.line})`
                );
            else if (weakAnchor(text, r.anchor))
                result.warnings.push(
                    `WARN weak-anchor ${file} ${r.anchor} matches only inside a longer identifier (map line ${r.line})`
                );
        }
        if (!matched.has(file) && !TOKEN_FREE.has(file))
            result.warnings.push(
                `WARN obsolete-row ${file} no longer references a peer field`
            );
    }

    const failing =
        result.unmapped.length +
        result.stale.length +
        result.anchorMissing.length;
    if (opts.json) {
        console.log(
            JSON.stringify(
                { ...result, rows: rows.length, ok: failing === 0 },
                null,
                2
            )
        );
    } else {
        for (const l of [
            ...result.unmapped,
            ...result.stale,
            ...result.anchorMissing,
            ...result.warnings,
        ])
            console.log(l);
        console.log(
            `check-consumers: ${rows.length} rows, ${result.unmapped.length} unmapped, ${result.stale.length} stale, ${result.anchorMissing.length} anchor-missing, ${result.warnings.length} warnings`
        );
    }
    return failing ? 1 : 0;
}

const invokedDirectly =
    process.argv[1] &&
    resolve(process.argv[1]).toLowerCase() ===
        fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
