#!/usr/bin/env node
/**
 * Measures the version-pin surface of a Floe release, before the tag (prep)
 * and after it (follow-up).
 *
 * Why measure instead of list: the set of files carrying the current version
 * string has changed on every release so far, and docs/reference/
 * transfer-protocol.mdx held five copies of it that no prep PR ever touched.
 * A hand-maintained "files to bump" list is exactly the thing that goes
 * stale, so this walks the tree for the OLD strings and reports every
 * survivor, plus a short list of files that must carry the NEW one.
 *
 * Why two phases: client/lib/desktopRelease.ts is the one pin that must NOT
 * move in the prep PR. /download derives every desktop asset URL from it, so
 * a bump that lands before the desktop-v* release exists points the page at
 * 404s; the 0.2.3 bump landed 15 minutes after its assets, and that margin is
 * the whole reason for the order. In prep the file must still hold the old
 * version; in follow-up it must hold the new one, and DESKTOP_RELEASE_DATE
 * must be the tag's UTC date, because desktopRelease.test.ts compares that
 * date against the CI runner's UTC clock (#324 needed a second commit for
 * exactly this).
 *
 * Usage, from the repo root:
 *   node .claude/skills/floe-release/scripts/check-version-pins.mjs
 *       --cli vX.Y.Z and/or --desktop desktop-vX.Y.Z [--phase prep|follow-up]
 *       [--old-cli vA.B.C] [--old-desktop desktop-vA.B.C] [--allow <path>]...
 *       [--json]
 *   node .claude/skills/floe-release/scripts/check-version-pins.mjs --self-test
 * Exit: 0 green, 1 findings, 2 usage or git errors.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/ -> floe-release/ -> skills/ -> .claude/ -> repo root.
const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..'
);
const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    '.next',
    'dist',
    'dist-msix',
    'build',
    'out',
    'coverage',
    '.idea',
]);
const SKIP_PATHS = new Set([
    'desktop/frontend/wailsjs',
    'desktop/frontend/dist',
    '.claude/skills/floe-release',
    // Shipped labels are history; the contract at the top forbids editing them.
    'docs/changelog.mdx',
    // Its version strings are fixtures for the comparison logic.
    'desktop/updatecheck_test.go',
]);
const SKIP_NAMES = new Set([
    'pnpm-lock.yaml',
    'package-lock.json',
    'go.sum',
    'go.work.sum',
]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|exe|zip|msix|woff2?|ttf|pdf)$/i;
const MAX_BYTES = 2 * 1024 * 1024;
const PIN_FILE = 'client/lib/desktopRelease.ts';
const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
];

// A version is a pin when it is not embedded in a longer identifier or a
// longer version. Letters, digits and a dot may not precede it (`x1.10.1`,
// `10.0.2.7`); a letter, a digit or `.digit` may not follow it (`1.10.10`,
// `1.10.1.5`). Underscores, hyphens and punctuation may, which is what makes
// `floe_1.10.4_linux_amd64.tar.gz` and `floe-desktop-setup-0.2.7.exe` pins.
const BEFORE = '(?<![A-Za-z\\d.])';
const AFTER = '(?![A-Za-z\\d]|\\.\\d)';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionRe = (kind, num) =>
    new RegExp(
        `${BEFORE}${kind === 'cli' ? 'v?' : '(desktop-v)?'}${escapeRe(num)}${AFTER}`
    );

// [kind, old version, text, must match]. Run with --self-test.
const SELF_TEST = [
    ['cli', '1.10.1', 'prints `floe 1.10.1`', true],
    ['cli', '1.10.1', 'a v1.10.1 tag', true],
    ['cli', '1.10.4', 'floe_1.10.4_linux_amd64.tar.gz', true],
    ['cli', '1.10.1', '1.10.10', false],
    ['cli', '1.10.1', '1.10.1.5', false],
    ['cli', '1.10.1', 'x1.10.1', false],
    ['cli', '1.10.1', 'v1.10.15', false],
    ['desktop', '0.2.7', 'floe-desktop-setup-0.2.7.exe', true],
    ['desktop', '0.2.7', 'reads `desktop-v0.2.7`', true],
    ['desktop', '0.2.7', '"productVersion": "0.2.7",', true],
    ['desktop', '0.2.7', '0.2.70', false],
    ['desktop', '0.2.7', '10.0.2.7', false],
    ['desktop', '0.2.7', '0.2.7.0', false],
    ['desktop', '0.2.7', 'desktop-v0.2.71', false],
];

function selfTest() {
    let failed = 0;
    for (const [kind, old, text, want] of SELF_TEST) {
        const got = versionRe(kind, old).test(text);
        if (got !== want) failed += 1;
        console.log(
            `${got === want ? 'ok  ' : 'FAIL'} ${kind} ${old} ${want ? 'matches' : 'ignores'} ${JSON.stringify(text)}`
        );
    }
    console.log(
        `check-version-pins: self-test ${failed ? `${failed} failure(s)` : 'green'} (${SELF_TEST.length} fixtures)`
    );
    process.exit(failed ? 1 : 0);
}

function usage(message) {
    console.error(`check-version-pins: ${message}`);
    process.exit(2);
}

function parseArgs(argv) {
    const opts = {
        cli: null,
        desktop: null,
        oldCli: null,
        oldDesktop: null,
        phase: 'prep',
        allow: [],
        json: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) usage(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === '--cli') opts.cli = value();
        else if (arg === '--desktop') opts.desktop = value();
        else if (arg === '--old-cli') opts.oldCli = value();
        else if (arg === '--old-desktop') opts.oldDesktop = value();
        else if (arg === '--phase') opts.phase = value();
        else if (arg === '--allow')
            opts.allow.push(value().replace(/\\/g, '/').replace(/\/$/, ''));
        else if (arg === '--json') opts.json = true;
        else usage(`unknown argument ${arg}`);
    }
    if (!opts.cli && !opts.desktop)
        usage(
            'pass --cli vX.Y.Z and/or --desktop desktop-vX.Y.Z, or --self-test'
        );
    for (const [flag, tag] of [
        ['--cli', opts.cli],
        ['--old-cli', opts.oldCli],
    ]) {
        if (tag && !/^v\d+\.\d+\.\d+$/.test(tag))
            usage(`${flag} wants vX.Y.Z, got ${tag}`);
    }
    for (const [flag, tag] of [
        ['--desktop', opts.desktop],
        ['--old-desktop', opts.oldDesktop],
    ]) {
        if (tag && !/^desktop-v\d+\.\d+\.\d+$/.test(tag))
            usage(`${flag} wants desktop-vX.Y.Z, got ${tag}`);
    }
    if (!['prep', 'follow-up'].includes(opts.phase))
        usage(`--phase wants prep or follow-up, got ${opts.phase}`);
    return opts;
}

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch (err) {
        return usage(
            `git ${args.join(' ')} failed: ${(err.stderr || err.message).toString().trim()}`
        );
    }
}

// The newest tag in the series that is not the one being cut, so the answer
// is the same before the new tag exists and when rerun after it does.
function previousTag(pattern, newTag) {
    const tags = git(['tag', '--list', pattern, '--sort=-v:refname'])
        .split(/\r?\n/)
        .filter(Boolean);
    const prev = tags.find((tag) => tag !== newTag);
    if (!prev)
        usage(
            `no ${pattern} tag other than ${newTag} is known here; run git fetch --tags`
        );
    return prev;
}

function tagUtcDate(tag) {
    const out = git([
        'for-each-ref',
        '--format=%(taggerdate:iso8601-strict) %(creatordate:iso8601-strict)',
        `refs/tags/${tag}`,
    ]);
    // taggerdate is empty for a lightweight tag; creatordate then stands in.
    const iso = out.split(' ').find(Boolean);
    if (!iso) usage(`tag ${tag} is not known here; run git fetch --tags`);
    return new Date(iso);
}

const utcParts = (d) => [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
const localParts = (d) => [d.getFullYear(), d.getMonth(), d.getDate()];
const monthDayYear = ([y, m, d]) => `${MONTHS[m]} ${d}, ${y}`;

function readText(rel) {
    try {
        return readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
        return null;
    }
}

const warnings = [];

function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(rel)) continue;
            yield* walk(abs);
        } else if (entry.isFile()) {
            if (
                SKIP_PATHS.has(rel) ||
                SKIP_NAMES.has(entry.name) ||
                BINARY.test(entry.name)
            )
                continue;
            const size = statSync(abs).size;
            if (size > MAX_BYTES) {
                warnings.push(
                    `${rel}: not scanned, ${size} bytes is over the 2 MiB text cap`
                );
                continue;
            }
            yield { abs, rel };
        }
    }
}

if (process.argv.includes('--self-test')) selfTest();
const opts = parseArgs(process.argv.slice(2));
const series = [];
if (opts.cli) {
    const oldTag = opts.oldCli || previousTag('v*', opts.cli);
    const num = (tag) => tag.slice(1);
    series.push({
        name: 'cli',
        newTag: opts.cli,
        oldTag,
        newNum: num(opts.cli),
        oldNum: num(oldTag),
        oldRe: versionRe('cli', num(oldTag)),
        newRe: versionRe('cli', num(opts.cli)),
    });
}
if (opts.desktop) {
    const oldTag = opts.oldDesktop || previousTag('desktop-v*', opts.desktop);
    const num = (tag) => tag.replace(/^desktop-v/, '');
    series.push({
        name: 'desktop',
        newTag: opts.desktop,
        oldTag,
        newNum: num(opts.desktop),
        oldNum: num(oldTag),
        oldRe: versionRe('desktop', num(oldTag)),
        newRe: versionRe('desktop', num(opts.desktop)),
    });
}
const desktop = series.find((s) => s.name === 'desktop');
const findings = { stale: [], wrongPhase: [], missing: [], date: [] };
const allowed = (rel) =>
    opts.allow.some((a) => rel === a || rel.startsWith(`${a}/`));

// STALE: every surviving old string. In prep the pin file is exempt for the
// desktop series, because holding the old version there is the point.
for (const { abs, rel } of walk(ROOT)) {
    if (allowed(rel)) continue;
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        const hit = series.some((s) => {
            if (
                rel === PIN_FILE &&
                s.name === 'desktop' &&
                opts.phase === 'prep'
            )
                return false;
            return s.oldRe.test(line);
        });
        if (hit) findings.stale.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
}

// The pin file: old in prep, new plus the tag's UTC date in follow-up.
if (desktop) {
    const pin = readText(PIN_FILE) || '';
    const version = pin.match(/DESKTOP_VERSION = '([^']*)'/)?.[1];
    const date = pin.match(/DESKTOP_RELEASE_DATE = '([^']*)'/)?.[1];
    if (!version || !date) {
        findings.missing.push(
            `${PIN_FILE}: DESKTOP_VERSION or DESKTOP_RELEASE_DATE not found`
        );
    } else if (opts.phase === 'prep') {
        if (version === desktop.newNum) {
            findings.wrongPhase.push(
                `${PIN_FILE}: DESKTOP_VERSION is already '${version}'; bump it in the follow-up PR, after the assets exist`
            );
        } else if (version !== desktop.oldNum) {
            warnings.push(
                `${PIN_FILE}: DESKTOP_VERSION is '${version}', expected the previous release '${desktop.oldNum}'`
            );
        }
    } else {
        if (version !== desktop.newNum) {
            findings.missing.push(
                `${PIN_FILE}: DESKTOP_VERSION is '${version}', want '${desktop.newNum}'`
            );
        }
        const want = utcParts(tagUtcDate(desktop.newTag));
        const parsed = new Date(date);
        const got = Number.isNaN(parsed.getTime()) ? null : localParts(parsed);
        if (!got || got.join('-') !== want.join('-')) {
            findings.date.push(
                `${PIN_FILE}: DESKTOP_RELEASE_DATE is '${date}', the UTC date of ${desktop.newTag} is '${monthDayYear(want)}'`
            );
        }
    }
}

// MISSING: the few files that must already carry the new string.
function expectNew(rel, s, filter, what) {
    const text = readText(rel);
    if (text === null) return findings.missing.push(`${rel}: file not found`);
    const lines = text.split(/\r?\n/).filter(filter);
    if (!lines.some((line) => s.newRe.test(line)))
        findings.missing.push(`${rel}: ${what} does not mention ${s.newTag}`);
}
for (const s of series) {
    expectNew('CLAUDE.md', s, () => true, 'the version example');
    expectNew(
        '.github/ISSUE_TEMPLATE/bug_report.yml',
        s,
        (line) => line.includes('placeholder:'),
        'the version placeholder'
    );
    // A missing entry is a warning, not a finding: contract rule 7 says a
    // release with nothing user-visible gets none, and only a reader can tell.
    const changelog = readText('docs/changelog.mdx') || '';
    const labeled = changelog.includes(`label="${s.newTag}"`);
    const unreleased = changelog.includes('label="Unreleased"');
    if (labeled) continue;
    if (unreleased && opts.phase === 'prep') {
        warnings.push(
            `docs/changelog.mdx: no label="${s.newTag}" yet; an Unreleased entry exists, relabel it at tag time`
        );
    } else if (unreleased) {
        findings.missing.push(
            `docs/changelog.mdx: an Unreleased label remains; relabel it ${s.newTag}`
        );
    } else {
        warnings.push(
            `docs/changelog.mdx: no entry with label="${s.newTag}"; right only if nothing user-visible shipped (rule 7)`
        );
    }
}
if (desktop) {
    expectNew(
        'DESKTOP.md',
        desktop,
        (line) => line.startsWith('Current release:'),
        'the "Current release:" line'
    );
    let productVersion;
    try {
        productVersion = JSON.parse(readText('desktop/wails.json')).info
            .productVersion;
    } catch {
        productVersion = undefined;
    }
    if (productVersion !== desktop.newNum) {
        findings.missing.push(
            `desktop/wails.json: productVersion is '${productVersion}', want '${desktop.newNum}'`
        );
    }
}

const groups = [
    ['STALE', findings.stale],
    ['WRONG-PHASE', findings.wrongPhase],
    ['MISSING', findings.missing],
    ['DATE', findings.date],
];
const total = groups.reduce((n, [, items]) => n + items.length, 0);
const scope = series.map((s) => `${s.oldTag} -> ${s.newTag}`).join(', ');
const summary = `check-version-pins: ${opts.phase} for ${scope}: ${total ? `${total} finding(s)` : 'green'}`;
if (opts.json) {
    const report = {
        phase: opts.phase,
        series: series.map((s) => ({
            ...s,
            oldRe: s.oldRe.source,
            newRe: s.newRe.source,
        })),
        findings,
        warnings,
        summary,
        exitCode: total ? 1 : 0,
    };
    console.log(JSON.stringify(report, null, 4));
} else {
    for (const [label, items] of groups)
        for (const item of items) console.log(`${label} ${item}`);
    for (const warning of warnings) console.log(`WARN ${warning}`);
    console.log(summary);
}
process.exit(total ? 1 : 0);
