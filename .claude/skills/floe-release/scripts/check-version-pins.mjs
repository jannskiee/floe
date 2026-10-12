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
 * survivor, plus a short list of files that must carry the NEW one. The
 * sweep covers the three newest tags of each series, not only the previous
 * one: example pins in .env.docker.example and docker-compose.yml sat on
 * 1.10.1 through three releases because each run only looked one tag back.
 *
 * Why floors are reported apart: a sentence such as "1.11.0 or later",
 * "version 1.11.0 or earlier", "since 1.11.0" or "## Upgrading to 1.11.0"
 * measures FROM a version. It stays true when the next tag ships, and
 * bumping it would turn a true statement into a false one. On the day after
 * v1.11.0 a pretend next tag printed 128 STALE lines and more than half were
 * such sentences, which buries the real pins. A line is a FLOOR only when
 * every old version on it carries that wording right beside it (isFloor);
 * anything less certain stays STALE, because a floor does not fail the run
 * and a real pin read as one would ship stale. A FLOOR line is still worth
 * a re-read: "1.11.0 or earlier shows nothing" is only right while the next
 * release changes what it says changed.
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
 * Usage (the current directory does not matter; the tree measured is the one
 * this script lives in, or the one --root names):
 *   node .claude/skills/floe-release/scripts/check-version-pins.mjs
 *       --cli vX.Y.Z and/or --desktop desktop-vX.Y.Z [--phase prep|follow-up]
 *       [--root <dir>] [--old-cli vA.B.C[,vD.E.F...]]
 *       [--old-desktop desktop-vA.B.C[,...]] [--allow <path>]... [--json]
 *   node .claude/skills/floe-release/scripts/check-version-pins.mjs --self-test
 * Tests:
 *   node --test .claude/skills/floe-release/scripts/check-version-pins.test.mjs
 * Exit: 0 green, 1 findings, 2 usage or git errors. FLOOR and WARN lines are
 * not findings and never change the exit code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/ -> floe-release/ -> skills/ -> .claude/ -> repo root.
const DEFAULT_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..'
);
let ROOT = DEFAULT_ROOT;
const SWEEP = 3;
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
// The one directory named `build` that is source, not output: the MSIX
// manifest, pack.ps1, the NSIS project and a README are tracked there, and
// the name-based skip above hid all of them. Its bin/ is what wails build
// writes, so that stays skipped by path.
const SCAN_ANYWAY = new Set(['desktop/build']);
const SKIP_PATHS = new Set([
    'desktop/build/bin',
    'desktop/frontend/wailsjs',
    'desktop/frontend/dist',
    '.claude/skills/floe-release',
    // Its SKILL.md examples, the submission history in references/ and the
    // version-mapping self-test all name shipped versions on purpose.
    '.claude/skills/store-submit',
    // Its triage table names the early-message-race fix boundary (v1.10.2,
    // desktop-v0.2.5) and its runbook names the bucket version it verified.
    '.claude/skills/transfer-audit',
    // Shipped labels are history; the contract at the top forbids editing them.
    'docs/changelog.mdx',
    // Its version strings are fixtures for the comparison logic.
    'desktop/updatecheck_test.go',
]);
// Lockfiles and dependency manifests carry other projects' versions: cobra
// sat at v1.10.2 while Floe shipped v1.10.2, and no Floe pin lives in them.
// Test fixtures carry example versions, never pins: a Go table row that
// says "v1.10.4" is test data, and a slug fixture is not a download link.
const TEST_FIXTURE = /(_test\.go|\.test\.(ts|tsx|mjs|js))$/;
const SKIP_NAMES = new Set([
    'pnpm-lock.yaml',
    'package-lock.json',
    'package.json',
    'go.sum',
    'go.work.sum',
    'go.mod',
    'go.work',
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

// A FLOOR is a version a sentence measures from: "X or later", "X or
// earlier", "since X", "older than X", "## Upgrading to X". The wording has
// to touch the version. Between the phrase and the number only a product
// word may stand ("older than `floe` 1.11.0", "arrived with server 1.11.0"),
// or one more version joined by a comma, "and" or "or" ("before `floe`
// 1.11.0 and Floe Desktop 0.3.0", "1.11.0 or Floe Desktop 0.3.0, or later").
// Left out on purpose, because each of them introduces a pin as readily as
// a floor: "from" ("the compose file from v1.11.0 on GitHub"; only "from X
// onward" counts), "up to", "as of", "in", a bare "to" outside "versions
// X to Y", and "above" and "below", which say where on a page as often as
// which version.
//
// A comparison after the version ("or later", "and earlier") counts only
// when it ENDS its clause: at the end of the text, at a period, comma,
// semicolon or colon, at a bracket, or at a conjunction that starts the
// next clause. "Set the tag to 1.11.0 or newer images will be pulled" and
// "reads 1.11.0 and later the hint" run on, and each is a sentence about a
// pin. The price is a true floor that runs on into its verb ("1.11.0 or
// earlier shows nothing"): it stays STALE, which costs a re-read and never
// a stale release. Three shapes are never a floor, whatever their wording:
//   - a bracket between the version and the comparison, as in "v1.11.0 (or
//     later, once tagged)": an aside on a version that is being shown;
//   - a version inside a code span, as in "reads `floe 1.11.0` and later,
//     after an update, ...": a quoted literal is shown, not measured from,
//     and the words around it are a sentence about it;
//   - anything inside a fenced code block, which is sample text, not prose.
const NOUNS =
    /(?:(?:the|a|an|floe|desktop|servers?|clients?|web|app|cli|versions?|releases?|images?)\s+){0,3}/;
const ANY_VERSION = /(?:desktop-)?v?\d+\.\d+\.\d+/;
const AND_OR = /(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)/;
const LATER = /(?:later|earlier|newer|older|higher|lower)\b/;
const CLAUSE_END =
    /(?=\s*(?:$|[.,;:()[\]]|(?:and|or|but|so|because|while|when|if|unless|which|who)\b))/;
const joinRe = (...parts) =>
    new RegExp(
        parts.map((p) => (typeof p === 'string' ? p : p.source)).join(''),
        'i'
    );
const FLOOR_BEFORE = joinRe(
    /\b(?:since|before|until|through|older than|newer than|earlier than|later than|prior to|shipped in|shipped with|arrived in|arrived with|introduced in|added in|new in|upgrading to|moving to|migrating to)\s+/,
    NOUNS,
    '(?:',
    ANY_VERSION,
    AND_OR,
    NOUNS,
    ')?$'
);
const FLOOR_AFTER = joinRe(/^\s*,?\s*(?:or|and)\s+/, LATER, CLAUSE_END);
const FLOOR_AFTER_NEXT = joinRe(
    '^',
    AND_OR,
    NOUNS,
    ANY_VERSION,
    /\s*,?\s*(?:or|and)\s+/,
    LATER,
    CLAUSE_END
);
const FROM_BEFORE = joinRe(/\bfrom\s+/, NOUNS, '$');
const ONWARD_AFTER = /^\s+onwards?\b/i;
const RANGE_END_BEFORE = joinRe(
    /\b(?:versions|releases)\s+/,
    ANY_VERSION,
    /\s+(?:to|through)\s+$/
);
const RANGE_START_BEFORE = /\b(?:versions|releases)\s+$/i;
const RANGE_START_AFTER = joinRe(/^\s+(?:to|through)\s+/, ANY_VERSION);
// Markdown marks and brackets between a phrase and its version are not
// wording: "older than `floe` 1.11.0", "(since 0.3.0;", "[Moving to 1.11.0]".
// After the version the brackets stay: one in front of the comparison makes
// it an aside, and one behind it ends its clause.
const tidy = (s) => s.replace(/[`*"()[\]]/g, '').replace(/\s+/g, ' ');
const tidyAfter = (s) => s.replace(/[`*"]/g, '').replace(/\s+/g, ' ');

// `before` and `after` are the text on either side of one version mention;
// `quoted` says the mention sits inside a code span.
function isFloor(before, after, quoted) {
    if (quoted) return false;
    const b = tidy(before);
    const a = tidyAfter(after);
    return (
        FLOOR_BEFORE.test(b) ||
        FLOOR_AFTER.test(a) ||
        FLOOR_AFTER_NEXT.test(a) ||
        (FROM_BEFORE.test(b) && ONWARD_AFTER.test(a)) ||
        RANGE_END_BEFORE.test(b) ||
        (RANGE_START_BEFORE.test(b) && RANGE_START_AFTER.test(a))
    );
}

// A hard-wrapped sentence keeps half of its floor wording on the line above
// or below ("...A floe CLI older than" / "1.11.0 or a Floe Desktop..."), so
// a neighbor is read too, but only as running prose. A heading, a table row,
// a fence, a tag or a code comment is a block of its own and lends nothing; a
// list item or a quote opens a block, so it can lend its text to the line
// below and never borrows from the line above. Inside a fenced block nothing
// is prose.
const OWN_BLOCK = /^\s*(?:#{1,6}\s|\||```|~~~|<|\{\/\*|\/\/|\/\*|\*\s|\*\/)/;
const OPENS_BLOCK = /^\s*(?:[-+]\s|\d+[.)]\s|>)/;
const FENCE = /^\s*(?:```|~~~)/;

// fenced[i] is true for a line inside a fenced code block, fence lines
// included.
function fencedLines(lines) {
    let inside = false;
    return lines.map((line) => {
        const fence = FENCE.test(line);
        const was = inside;
        if (fence) inside = !inside;
        return was || fence;
    });
}

// True when every mention `re` finds on lines[i] is a floor.
function everyMentionIsFloor(lines, i, re, fenced) {
    // Sample output and config, never a sentence that measures.
    if (fenced[i]) return false;
    const line = lines[i];
    const prose = (j) =>
        j >= 0 &&
        j < lines.length &&
        !fenced[j] &&
        lines[j].trim() !== '' &&
        !OWN_BLOCK.test(lines[j]) &&
        !OWN_BLOCK.test(line);
    const above =
        prose(i - 1) && !OPENS_BLOCK.test(line) ? lines[i - 1].trim() : '';
    const below =
        prose(i + 1) && !OPENS_BLOCK.test(lines[i + 1])
            ? lines[i + 1].trim()
            : '';
    for (const m of line.matchAll(new RegExp(re.source, 'g'))) {
        const head = line.slice(0, m.index);
        const before = `${above} ${head}`;
        const after = `${line.slice(m.index + m[0].length)} ${below}`;
        // An odd number of backticks in front: the mention is inside a span.
        const quoted = head.split('`').length % 2 === 0;
        if (!isFloor(before, after, quoted)) return false;
    }
    return true;
}

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

// [kind, old version, line, is a floor]. Every line mentions the version; the
// question is whether its wording makes it a floor (re-read, never bump) or
// leaves it a pin (STALE). The second half is the direction that matters: a
// pin must never read as a floor.
const FLOOR_SELF_TEST = [
    ['cli', '1.11.0', '`--to` needs `floe` 1.11.0 or later', true],
    ['cli', '1.11.0', 'needs `floe` 1.11.0 or later (see Install).', true],
    ['cli', '1.11.0', 'a client image of 1.11.0 or later). An older', true],
    ['cli', '1.11.0', '1.11.0 or later or Floe Desktop 0.3.0 or later;', true],
    ['cli', '1.11.0', 'Since 1.11.0 the server checks the `Origin`.', true],
    ['cli', '1.11.0', 'a server older than 1.11.0 does', true],
    ['cli', '1.11.0', '## Upgrading to 1.11.0', true],
    ['cli', '1.11.0', '### Moving to 1.11.0 {#moving-to-1-11-0}', true],
    ['cli', '1.11.0', 'The rule arrived with server 1.11.0.', true],
    ['cli', '1.11.0', 'on versions 1.10.8 to 1.11.0 sends it', true],
    ['desktop', '0.3.0', 'need Floe Desktop 0.3.0 or later.', true],
    ['desktop', '0.3.0', 'before `floe` 1.11.0 and Floe Desktop 0.3.0.', true],
    ['desktop', '0.3.0', 'its own AppUserModelID (since 0.3.0; before', true],
    // A comparison that runs on, a bracketed aside, a quoted literal: each
    // was once read as a floor and is the shape of a real pin.
    ['cli', '1.11.0', 'Set `FLOE_IMAGE_TAG=1.11.0` or newer images', false],
    ['cli', '1.11.0', 'reads `floe 1.11.0` and below it the hint', false],
    ['cli', '1.11.0', 'Latest: `v1.11.0` (or later, once tagged)', false],
    ['cli', '1.11.0', 'sets the tag to 1.11.0 or newer images', false],
    ['cli', '1.11.0', 'Latest: v1.11.0 (or later, once tagged)', false],
    ['cli', '1.11.0', 'prints `floe 1.11.0` and later, after', false],
    // True floors given up for the same rule: they run on into a verb.
    [
        'cli',
        '1.11.0',
        'A web app on version 1.11.0 or earlier shows it.',
        false,
    ],
    ['cli', '1.10.11', '1.10.11 and earlier tried to save such paths.', false],
    ['cli', '1.11.0', 'for example FLOE_IMAGE_TAG=1.11.0,', false],
    ['cli', '1.11.0', 'prints `Already up to date (1.11.0)` and stops', false],
    ['cli', '1.11.0', 'Update available: 1.10.11 -> v1.11.0', false],
    ['cli', '1.11.0', 'FLOE_IMAGE_TAG=1.11.0 # or later', false],
    ['cli', '1.11.0', 'Needs 1.11.0 or later, as in `floe 1.11.0`', false],
    ['cli', '1.11.0', 'the compose file from v1.11.0 on GitHub', false],
    ['cli', '1.11.0', 'A web app on version 1.11.0 ends the line', false],
    ['cli', '1.11.0', 'Since the last release it prints `floe 1.11.0`', false],
    ['desktop', '0.3.0', '"productVersion": "0.3.0",', false],
    ['desktop', '0.3.0', 'Current release: `desktop-v0.3.0` (Store', false],
    ['desktop', '0.3.0', 'Get-FileHash floe-desktop-setup-0.3.0.exe', false],
    ['desktop', '0.3.0', 'for example `Peer version: desktop-v0.3.0`', false],
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
    for (const [kind, old, text, want] of FLOOR_SELF_TEST) {
        const re = versionRe(kind, old);
        // A fixture the version pattern does not find tests nothing.
        const got = re.test(text)
            ? everyMentionIsFloor([text], 0, re, [false])
            : null;
        if (got !== want) failed += 1;
        console.log(
            `${got === want ? 'ok  ' : 'FAIL'} ${want ? 'floor' : 'pin'} ${kind} ${old} ${JSON.stringify(text)}`
        );
    }
    const count = SELF_TEST.length + FLOOR_SELF_TEST.length;
    console.log(
        `check-version-pins: self-test ${failed ? `${failed} failure(s)` : 'green'} (${count} fixtures)`
    );
    process.exit(failed ? 1 : 0);
}

function usage(message) {
    console.error(`check-version-pins: ${message}`);
    process.exit(2);
}

const CLI_TAG = /^v\d+\.\d+\.\d+$/;
const DESKTOP_TAG = /^desktop-v\d+\.\d+\.\d+$/;

function parseArgs(argv) {
    const opts = {
        cli: null,
        desktop: null,
        oldCli: [],
        oldDesktop: [],
        phase: 'prep',
        root: null,
        allow: [],
        json: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) usage(`${arg} needs a value`);
            return argv[++i];
        };
        const list = () =>
            value()
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        if (arg === '--cli') opts.cli = value();
        else if (arg === '--desktop') opts.desktop = value();
        else if (arg === '--old-cli') opts.oldCli.push(...list());
        else if (arg === '--old-desktop') opts.oldDesktop.push(...list());
        else if (arg === '--phase') opts.phase = value();
        else if (arg === '--root') opts.root = value();
        else if (arg === '--allow')
            opts.allow.push(value().replace(/\\/g, '/').replace(/\/$/, ''));
        else if (arg === '--json') opts.json = true;
        else usage(`unknown argument ${arg}`);
    }
    if (!opts.cli && !opts.desktop)
        usage(
            'pass --cli vX.Y.Z and/or --desktop desktop-vX.Y.Z, or --self-test'
        );
    for (const tag of [opts.cli, ...opts.oldCli]) {
        if (tag && !CLI_TAG.test(tag))
            usage(`--cli and --old-cli want vX.Y.Z, got ${tag}`);
    }
    for (const tag of [opts.desktop, ...opts.oldDesktop]) {
        if (tag && !DESKTOP_TAG.test(tag))
            usage(
                `--desktop and --old-desktop want desktop-vX.Y.Z, got ${tag}`
            );
    }
    if (!['prep', 'follow-up'].includes(opts.phase))
        usage(`--phase wants prep or follow-up, got ${opts.phase}`);
    if (opts.root) {
        opts.root = path.resolve(opts.root);
        if (!existsSync(path.join(opts.root, 'CLAUDE.md')))
            usage(`--root ${opts.root} does not look like a Floe checkout`);
    }
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

// The newest tags in the series other than the one being cut, so the answer
// is the same before the new tag exists and when rerun after it does.
function previousTags(pattern, newTag) {
    const tags = git(['tag', '--list', pattern, '--sort=-v:refname'])
        .split(/\r?\n/)
        .filter((tag) => tag && tag !== newTag)
        .slice(0, SWEEP);
    if (!tags.length)
        usage(
            `no ${pattern} tag other than ${newTag} is known here; run git fetch --tags`
        );
    return tags;
}

function tagUtcDate(tag) {
    const out = git([
        'for-each-ref',
        '--format=%(taggerdate:iso8601-strict) %(creatordate:iso8601-strict)',
        `refs/tags/${tag}`,
    ]);
    // taggerdate is empty for a lightweight tag; creatordate then stands in.
    const iso = out.split(' ').find(Boolean);
    if (!iso) {
        usage(
            `tag ${tag} is not known here: either run git fetch --tags, or you are running follow-up before step 3 (the tag must exist first)`
        );
    }
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
            if (SKIP_PATHS.has(rel)) continue;
            if (SKIP_DIRS.has(entry.name) && !SCAN_ANYWAY.has(rel)) continue;
            yield* walk(abs);
        } else if (entry.isFile()) {
            if (
                SKIP_PATHS.has(rel) ||
                SKIP_NAMES.has(entry.name) ||
                TEST_FIXTURE.test(entry.name) ||
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
if (opts.root) ROOT = opts.root;

function makeSeries(name, newTag, overrides, pattern, num) {
    const oldTags = overrides.length
        ? overrides
        : previousTags(pattern, newTag);
    return {
        name,
        newTag,
        newNum: num(newTag),
        newRe: versionRe(name, num(newTag)),
        olds: oldTags.map((tag) => ({
            tag,
            num: num(tag),
            re: versionRe(name, num(tag)),
        })),
    };
}
const series = [];
if (opts.cli)
    series.push(
        makeSeries('cli', opts.cli, opts.oldCli, 'v*', (tag) => tag.slice(1))
    );
if (opts.desktop) {
    series.push(
        makeSeries(
            'desktop',
            opts.desktop,
            opts.oldDesktop,
            'desktop-v*',
            (tag) => tag.replace(/^desktop-v/, '')
        )
    );
}
const desktop = series.find((s) => s.name === 'desktop');
const findings = { stale: [], wrongPhase: [], missing: [], date: [] };
// Reported, never counted: see "Why floors are reported apart" above.
const floors = [];
const allowed = (rel) =>
    opts.allow.some((a) => rel === a || rel.startsWith(`${a}/`));

// STALE: every surviving old string, labeled with the tag it belongs to. In
// prep the pin file is exempt for the desktop series, because holding the old
// version there is the point. A line whose every mention is a floor goes to
// FLOOR instead; one mention that is not keeps the whole line STALE.
for (const { abs, rel } of walk(ROOT)) {
    if (allowed(rel)) continue;
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    const fenced = fencedLines(lines);
    lines.forEach((line, i) => {
        const hits = [];
        let floor = true;
        for (const s of series) {
            if (
                rel === PIN_FILE &&
                s.name === 'desktop' &&
                opts.phase === 'prep'
            )
                continue;
            for (const old of s.olds) {
                if (!old.re.test(line)) continue;
                hits.push(old.tag);
                floor = floor && everyMentionIsFloor(lines, i, old.re, fenced);
            }
        }
        if (hits.length)
            (floor ? floors : findings.stale).push(
                `${rel}:${i + 1} (${hits.join(', ')}): ${line.trim()}`
            );
    });
}

// The pin file: the previous release in prep, the new one plus the tag's UTC
// date in follow-up.
if (desktop) {
    const previous = desktop.olds[0].num;
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
        } else if (version !== previous) {
            warnings.push(
                `${PIN_FILE}: DESKTOP_VERSION is '${version}', expected the previous release '${previous}'`
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
    // The entry takes its final label in the prep PR, not after the tag:
    // .goreleaser.yml and desktop-release.yml write changelog#<anchor> into
    // the release body when they publish, and the anchor is the label with
    // its dots as hyphens, so a label that arrives later leaves that link at
    // the top of the page.
    const changelog = readText('docs/changelog.mdx') || '';
    const labeled = changelog.includes(`label="${s.newTag}"`);
    const unreleased = changelog.includes('label="Unreleased"');
    const anchor = `changelog#${s.newTag.replace(/\./g, '-')}`;
    if (labeled) continue;
    if (unreleased && opts.phase === 'prep') {
        warnings.push(
            `docs/changelog.mdx: no label="${s.newTag}" yet; an Unreleased entry exists: rename it in the prep PR, before the tag (the release body links ${anchor} when it is published), unless none of its bullets ship in ${s.newTag} (rule 7)`
        );
    } else if (unreleased) {
        findings.missing.push(
            `docs/changelog.mdx: an Unreleased label remains and no entry is labeled ${s.newTag}; the rename belonged in the prep PR (floe-release step 2), and the release body already links ${anchor}`
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
const scope = series
    .map((s) => `${s.olds.map((o) => o.tag).join(', ')} -> ${s.newTag}`)
    .join('; ');
const floorNote = floors.length
    ? `; ${floors.length} floor line(s) to re-read, never bump`
    : '';
const summary = `check-version-pins: ${opts.phase} for ${scope} in ${ROOT}: ${total ? `${total} finding(s)` : 'green'}${floorNote}`;
if (opts.json) {
    const report = {
        phase: opts.phase,
        root: ROOT,
        series: series.map((s) => ({
            ...s,
            newRe: s.newRe.source,
            olds: s.olds.map((o) => ({ ...o, re: o.re.source })),
        })),
        findings,
        floors,
        warnings,
        summary,
        exitCode: total ? 1 : 0,
    };
    console.log(JSON.stringify(report, null, 4));
} else {
    for (const [label, items] of groups)
        for (const item of items) console.log(`${label} ${item}`);
    for (const floor of floors) console.log(`FLOOR ${floor}`);
    for (const warning of warnings) console.log(`WARN ${warning}`);
    console.log(summary);
}
process.exit(total ? 1 : 0);
