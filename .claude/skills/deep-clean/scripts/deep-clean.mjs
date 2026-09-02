#!/usr/bin/env node
/**
 * deep-clean.mjs - find and remove what a finished task left behind.
 *
 * Commands
 *   survey  Read-only. Enumerate leftovers under the two allowed roots
 *           (this checkout, and the OS temp dir), classify each one into
 *           safe / ask / held, and print a table with sizes and reasons.
 *   sweep   Delete the safe bucket. Requires --apply; without it the
 *           command prints exactly what it would remove and removes
 *           nothing.
 *
 * Why it exists
 *   Seven skills in this repo create artifacts, and two of them
 *   (floe-run, transfer-audit) already own their own teardown. What had
 *   no owner was the residue nothing tracks: client/.next, the session
 *   scratchpads under the OS temp dir, stray go and wails binaries,
 *   Playwright reports. Sweeping those by hand means re-deriving the
 *   never-delete list every time, and that list has teeth. server/.env
 *   holds live Upstash write credentials. %APPDATA%\floe is the desktop
 *   app's real user data, not install debris. desktop/frontend/dist is
 *   gitignored but embedded by //go:embed, so deleting it breaks every
 *   go command in desktop/ until the frontend is rebuilt.
 *
 * Why a fence and not a checklist
 *   The never-delete list is enforced in code, at classify time and again
 *   immediately before every removal, because a prose checklist is only
 *   as good as the reader's attention. Deny beats allow, always.
 *
 * The five invariants, and what each one cost to learn
 *   1. Nothing is reached through a link. The fence refuses a candidate
 *      whose leaf OR any ancestor is a symlink or junction. An earlier
 *      version resolved the candidate for the deny check but passed the
 *      unresolved path to the git-tracked check and to rmSync, so a
 *      junction at client/ made tracked, committed files look disposable
 *      and a sweep deleted five of them. Resolve once, use it everywhere.
 *   2. A directory is only as safe as its contents, and severity beats
 *      traversal order. rmSync is recursive, so permitting a directory
 *      permits everything inside it. Every directory is scanned before
 *      removal and refused if it carries a denied name or a link leaving
 *      the allowed roots. A soft hit (a nested .git) found early must not
 *      mask a hard hit (a .env) found deeper, which is the layout of every
 *      copy of this repo and was reachable through --include.
 *   3. An unknown age is not a young age. The mtime walk is uncapped; if
 *      it ever hits the ceiling the item cannot be safe, because a
 *      truncated walk reads a stale timestamp and that is exactly how a
 *      live session's scratchpad would get swept out from under it.
 *   5. A git boundary hides files the same way a link does. git ls-files
 *      stops at a submodule gitlink, so a submodule, linked worktree or
 *      nested clone between the root and a candidate made committed files
 *      look untracked. ancestorGitDir refuses those, mirroring invariant 1.
 *
 *   4. --root cannot move the fence. Deny entries are anchored at both
 *      the given root and this script's own checkout, and a root with no
 *      CLAUDE.md is refused, so pointing --root one level up cannot
 *      unfence server/.env.
 *
 * Why it kills no processes
 *   floe-run stop and transfer-audit cleanup already verify a pid's
 *   process image and creation time before touching it, and both refuse
 *   a pidfile from another checkout. This script only reports what is
 *   listening and names the command that owns it. Measured on this box
 *   on 2026-09-02: every node.exe running was an MCP server or a Claude
 *   Code session, so a "kill stray node" step would have broken the
 *   running session's own tools.
 *
 * What a clean survey does NOT prove
 *   Nothing about state this script cannot see, or deliberately leaves to
 *   its owner: the desktop app's History rows, a Partner Center draft,
 *   bytes already counted by the production stats counter, Docker images,
 *   or WSL scratch under /var/tmp/floe-lta. Sizes are lower bounds on a
 *   pnpm tree, where node_modules is mostly links into a shared store, and
 *   a trailing + marks a size that stopped counting. The reported extras
 *   (go build cache, stashes, local-only branches, worktrees) are
 *   read-only notes and are never swept.
 *
 * Usage:
 *   node .claude/skills/deep-clean/scripts/deep-clean.mjs survey [options]
 *   node .claude/skills/deep-clean/scripts/deep-clean.mjs sweep --apply [options]
 *
 *   --root <dir>        checkout to operate on (default: this one)
 *   --age-minutes <n>   hold anything touched this recently (default 30)
 *   --scratch-days <n>  scratchpad sessions older than this are safe (default 7)
 *   --include <id>      promote one ask candidate into the sweep, repeatable
 *   --keep <path>       force-protect a path, repeatable, only ever restrictive
 *   --firewall          also report firewall rules naming a missing file
 *   --verbose           list grouped items individually instead of collapsed
 *   --temp-root <dir>   scan this instead of the OS temp dir (test seam)
 *   --json              machine-readable output
 *   --self-test         run the built-in fence assertions and exit
 *
 * Exit 0 nothing to do, 1 candidates found or removed, 2 usage,
 *      3 precondition, 4 fence tripped, 5 a removal failed.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> deep-clean/ -> skills/ -> .claude/ -> repo root.
const DEFAULT_ROOT = path.resolve(HERE, '..', '..', '..', '..');

const WIN = process.platform === 'win32';
/** Byte accounting stops here. Age accounting never does; see WALK_CEILING. */
const SIZE_CAP = 4000;
/** A walk this large is treated as unmeasurable, never as young. */
const WALK_CEILING = 250000;

/* ---------------------------------------------------------------- paths */

function norm(p) {
    const r = path.resolve(p);
    return WIN ? r.replace(/\\/g, '/').toLowerCase() : r;
}

function isUnder(child, parent) {
    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

function exists(p) {
    try {
        fs.lstatSync(p);
        return true;
    } catch {
        return false;
    }
}

function isLink(p) {
    try {
        return fs.lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * Canonical form. Falls back to path.resolve when the path does not exist,
 * which is why no caller may treat equality with the input as proof that no
 * link was involved. Use ancestorLink for that.
 */
function realOrSelf(p) {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return path.resolve(p);
    }
}

/**
 * The first link found at the leaf or any ancestor, or null. Invariant 1:
 * checking only the leaf is what let a junction at client/ carry a sweep
 * into a tracked directory.
 */
function ancestorLink(p, stopAt) {
    let cur = path.resolve(p);
    const stop = stopAt ? norm(stopAt) : null;
    for (;;) {
        if (stop && norm(cur) === stop) return null;
        if (isLink(cur)) return cur;
        const up = path.dirname(cur);
        if (up === cur) return null;
        cur = up;
    }
}

/**
 * The first ancestor between the candidate and the allow root that holds its
 * own .git, or null. git ls-files stops at a submodule gitlink, so a
 * submodule, a linked worktree or a nested clone between --root and a
 * candidate hides its committed files from the tracked check. Same shape as
 * the link defect: a boundary at client/ laundering committed files into the
 * safe bucket.
 */
function ancestorGitDir(p, stopAt) {
    let cur = path.dirname(path.resolve(p));
    const stop = stopAt ? norm(stopAt) : null;
    for (;;) {
        if (stop && norm(cur) === stop) return null;
        if (exists(path.join(cur, '.git'))) return cur;
        const up = path.dirname(cur);
        if (up === cur) return null;
        cur = up;
    }
}

/* ---------------------------------------------------------------- fence */

/**
 * True when a basename hits a deny rule. Returns the rule, or null.
 * A name is tested as-is and with trailing dots and spaces stripped:
 * Windows drops those on create, but an extended-length path keeps them,
 * and ".env " was classified safe and deleted.
 */
function denyRuleFor(name) {
    const forms = new Set([name, name.replace(/[. ]+$/, '')]);
    for (const d of DENY_NAME) {
        for (const f of forms) {
            if (f && d.re.test(f)) return d;
        }
    }
    return null;
}

/** Basenames denied wherever they appear, at any depth. */
const DENY_NAME = [
    // .env.example and .env.docker.example are committed, public templates,
    // so they are deliberately not secrets. Denying them fenced 319 MB of
    // dead scratchpads that merely contained a copy of the repo.
    {
        re: /^(?!.*\.example$)\.env($|[^A-Za-z0-9])/i,
        why: 'environment file',
        hard: true,
    },
    {
        re: /^floe_transfer_.*\.zip$/i,
        why: 'received personal media, not an artifact',
        hard: true,
    },
    { re: /^\.envrc$/i, why: 'direnv environment file', hard: true },
    { re: /^turnserver\.conf$/i, why: 'coturn secret', hard: true },
    // A git repo inside a scratch directory is a judgment call rather than
    // a hard no: it may hold unpushed work, or it may be a test fixture.
    { re: /^\.git$/i, why: 'a git repository', hard: false },
];

/**
 * Absolute deny list. Every entry is a thing that looks like debris to a
 * naive sweep and is not. Anchored at both the operating root and this
 * script's own checkout so --root cannot relocate it (invariant 4).
 */
function denyList(roots, tempRoot) {
    const home = os.homedir();
    const appdata =
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localapp =
        process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const out = [
        // Desktop app user data. MSIX does not virtualize %APPDATA%, so this
        // is the real settings, history and webview store.
        {
            path: path.join(appdata, 'floe'),
            why: "the desktop app's real settings, history and webview data",
        },
        {
            path: path.join(localapp, 'ms-playwright'),
            why: 'shared Playwright browser install',
        },
        // The stable operator --bin-dir. Deleting it re-arms the Windows
        // firewall consent dialog on the next audit round.
        {
            path: path.join(tempRoot, 'floe-audit', 'bin'),
            why: 'stable operator --bin-dir; deleting it re-triggers firewall consent',
        },
        // Unbacked-up, belong to no repo.
        {
            path: path.join(home, '.claude', 'plans'),
            why: 'unbacked-up plan files',
        },
        {
            path: path.join(home, '.claude', 'projects'),
            why: 'transcripts and auto memory; use claude project purge instead',
        },
    ];
    for (const root of new Set(roots.map((r) => path.resolve(r)))) {
        out.push(
            {
                path: path.join(root, 'server', '.env'),
                why: 'live Upstash write credentials',
            },
            {
                path: path.join(root, 'client', '.env.local'),
                why: 'local dev config, not an artifact',
            },
            {
                path: path.join(root, 'coturn', 'turnserver.conf'),
                why: 'coturn secret (root .gitignore)',
            },
            {
                path: path.join(root, 'desktop', 'frontend', 'dist'),
                why: 'embedded by //go:embed; deleting it breaks every go command in desktop/',
            },
            { path: path.join(root, 'go.work'), why: 'workspace file' },
            {
                path: path.join(root, 'go.work.sum'),
                why: 'untracked on purpose, locally useful',
            },
            {
                path: path.join(root, '.claude', 'settings.local.json'),
                why: 'accumulated permission allowlist',
            }
        );
    }
    return out;
}

export function makeFence(root, keeps, tempRoot = os.tmpdir()) {
    const allowRoots = [
        ...new Set([path.resolve(root), path.resolve(tempRoot)]),
    ];
    const deny = denyList([root, DEFAULT_ROOT], tempRoot).concat(
        keeps.map((k) => ({ path: k, why: 'protected by --keep' }))
    );

    /** @returns {null | string} null when deletable, else the refusal reason. */
    return function fence(candidate) {
        const literal = path.resolve(candidate);
        const real = realOrSelf(literal);

        // Invariant 1. Refuse rather than resolve: a link is never a route.
        const owner = allowRoots.find((a) => isUnder(literal, a));
        const link = ancestorLink(literal, owner);
        if (link) {
            return norm(link) === norm(literal)
                ? 'is a symlink'
                : `reached through a link at ${link}`;
        }
        const nested = ancestorGitDir(literal, owner);
        if (nested) {
            return `inside a nested git repository at ${nested}, whose files git ls-files cannot see`;
        }

        // Denied names bind on both spellings, at any depth.
        for (const form of new Set([norm(literal), norm(real)])) {
            for (const seg of form.split('/')) {
                const d = denyRuleFor(seg);
                if (d) return d.why;
            }
        }

        for (const d of deny) {
            for (const form of [literal, real]) {
                if (isUnder(form, d.path)) return d.why;
                // Reporting a descendant's reason as if it were the
                // candidate's read as nonsense ("untracked:client refused as
                // local dev config"), so name what it contains instead.
                if (isUnder(d.path, form)) {
                    return `contains ${d.path} (${d.why})`;
                }
            }
        }
        // Both spellings must live inside an allow root.
        for (const form of [literal, real]) {
            if (!allowRoots.some((a) => isUnder(form, a))) {
                return 'outside the allowed roots (this checkout and the temp dir)';
            }
            if (allowRoots.some((a) => norm(form) === norm(a))) {
                return 'is an allow root itself';
            }
        }
        return null;
    };
}

/**
 * Invariant 2. rmSync is recursive, so a directory is only as safe as what
 * it holds. Returns the first offending descendant, or null.
 */
export function scanContents(dir, allowRoots) {
    let st;
    try {
        st = fs.lstatSync(dir);
    } catch {
        return null;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const stack = [dir];
    let seen = 0;
    let soft = null;
    while (stack.length) {
        if (++seen > WALK_CEILING) {
            return {
                path: dir,
                why: `too large to verify (over ${WALK_CEILING} entries)`,
                hard: false,
            };
        }
        const cur = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            const d = denyRuleFor(e.name);
            if (d) {
                const hit = { path: p, why: d.why, hard: d.hard !== false };
                // Severity, not traversal order, decides. A soft .git met
                // early used to mask a hard .env met deeper, and that is the
                // layout of every copy of this repo.
                if (hit.hard) return hit;
                if (!soft) soft = hit;
                continue;
            }
            if (e.isSymbolicLink()) {
                const target = realOrSelf(p);
                if (!allowRoots.some((a) => isUnder(target, a))) {
                    return {
                        path: p,
                        why: `link leaving the allowed roots (-> ${target})`,
                        hard: true,
                    };
                }
                continue; // never descend a link
            }
            if (e.isDirectory()) stack.push(p);
        }
    }
    return soft;
}

/* ------------------------------------------------------------ git state */

function git(root, args) {
    try {
        return execFileSync('git', ['-C', root, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch {
        return null;
    }
}

function trackedPaths(root) {
    const out = git(root, ['ls-files', '-z']);
    if (out === null) return null;
    return out
        .split('\0')
        .filter(Boolean)
        .map((rel) => norm(path.join(root, rel)));
}

function tracksAnything(tracked, p) {
    const n = norm(p);
    const prefix = n.endsWith('/') ? n : n + '/';
    return tracked.some((t) => t === n || t.startsWith(prefix));
}

/* ------------------------------------------------------------ measuring */

/**
 * Invariant 3. Byte accounting stops at SIZE_CAP because a size is only a
 * report, but the mtime walk runs to completion because an age decides a
 * deletion. A walk that hits WALK_CEILING reports capped, and a capped item
 * can never be safe.
 */
function measure(p) {
    let bytes = 0;
    let files = 0;
    let newest = 0;
    let capped = false;
    let counted = 0;
    const stack = [p];
    while (stack.length) {
        if (counted > WALK_CEILING) {
            capped = true;
            break;
        }
        const cur = stack.pop();
        let st;
        try {
            st = fs.lstatSync(cur);
        } catch {
            continue;
        }
        counted += 1;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (st.isSymbolicLink()) {
            files += 1;
            continue;
        }
        if (st.isDirectory()) {
            let entries = [];
            try {
                entries = fs.readdirSync(cur);
            } catch {
                continue;
            }
            for (const e of entries) stack.push(path.join(cur, e));
            continue;
        }
        files += 1;
        if (files <= SIZE_CAP) bytes += st.size;
    }
    return { bytes, files, newest, capped, sizeIsLowerBound: files > SIZE_CAP };
}

function human(bytes) {
    const u = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i += 1;
    }
    return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`;
}

/* --------------------------------------------------------------- rules */

function repoRules(root) {
    const j = (...s) => path.join(root, ...s);
    return [
        [
            'next-build',
            j('client', '.next'),
            'safe',
            'Next.js build cache; rebuilt by pnpm dev or pnpm build',
        ],
        [
            'next-out',
            j('client', 'out'),
            'safe',
            'Next.js static export output',
        ],
        [
            'next-tsbuildinfo',
            j('client', 'tsconfig.tsbuildinfo'),
            'safe',
            'TypeScript incremental cache',
        ],
        [
            'pw-results',
            j('client', 'test-results'),
            'safe',
            'Playwright run output',
        ],
        [
            'pw-report',
            j('client', 'playwright-report'),
            'safe',
            'Playwright HTML report',
        ],
        [
            'pw-blob',
            j('client', 'blob-report'),
            'safe',
            'Playwright blob report',
        ],
        [
            'pw-cache',
            j('client', '.playwright'),
            'safe',
            'Playwright local cache',
        ],
        [
            'wails-installer-tmp',
            j('desktop', 'build', 'windows', 'installer', 'tmp'),
            'safe',
            're-downloaded by wails build -nsis',
        ],
        [
            'desktop-stray-exe',
            j('desktop', 'desktop.exe'),
            'safe',
            'stray go build output; wails build writes build/bin',
        ],
        ['cli-exe', j('cli', 'floe.exe'), 'safe', 'stray go build output'],
        ['cli-bin', j('cli', 'floe'), 'safe', 'stray go build output'],
        [
            'cli-cmd-exe',
            j('cli', 'cmd', 'floe', 'floe.exe'),
            'safe',
            'stray go build output',
        ],
        [
            'cli-cmd-bin',
            j('cli', 'cmd', 'floe', 'floe'),
            'safe',
            'stray go build output',
        ],
        ['cli-output', j('cli', 'output'), 'safe', 'CLI test output'],
        // next dev upserts these two rather than owning them outright, and
        // AGENTS.md invites hand-written content outside its managed block,
        // so they are a decision rather than debris.
        [
            'next-agents',
            j('client', 'AGENTS.md'),
            'ask',
            'written by next dev, but it can carry hand-written content outside the managed block',
        ],
        [
            'next-claude',
            j('client', 'CLAUDE.md'),
            'ask',
            'written by next dev, but it can carry hand-written content',
        ],
        [
            'desktop-build-bin',
            j('desktop', 'build', 'bin'),
            'ask',
            'wails build output, and the release artifact until it is uploaded',
        ],
        ['dist-msix', j('dist-msix'), 'ask', 'MSIX packaging output'],
        [
            'root-exe',
            j('floe.exe'),
            'ask',
            'shadows the scoop shim when cwd is the repo root',
        ],
        [
            'root-bin',
            j('floe'),
            'ask',
            'shadows the scoop shim when cwd is the repo root',
        ],
        [
            'desktop-dist',
            j('desktop', 'frontend', 'dist'),
            'never',
            'embedded by //go:embed; go commands in desktop/ fail without it',
        ],
        [
            'nm-root',
            j('node_modules'),
            'ask',
            'reinstall needed before anything runs; on a pnpm tree most of it is links, so the reclaim is smaller than the size shown',
        ],
        [
            'nm-client',
            j('client', 'node_modules'),
            'ask',
            'reinstall needed before next dev runs; mostly pnpm links',
        ],
        [
            'nm-server',
            j('server', 'node_modules'),
            'ask',
            'reinstall needed before the signaling server runs',
        ],
        [
            'nm-desktop',
            j('desktop', 'frontend', 'node_modules'),
            'ask',
            'reinstall needed before the desktop frontend builds',
        ],
    ].map(([id, p, bucket, why]) => ({ id, path: p, bucket, why }));
}

function repoGlobCandidates(root) {
    const out = [];
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (/\.local\.mjs$/i.test(e.name) || /^\..*-tmp\.mjs$/i.test(e.name)) {
            out.push({
                id: `scratch-script:${e.name}`,
                path: path.join(root, e.name),
                bucket: 'safe',
                why: 'throwaway script (root .gitignore)',
            });
        }
    }
    let cliEntries = [];
    try {
        cliEntries = fs.readdirSync(path.join(root, 'cli'), {
            withFileTypes: true,
        });
    } catch {
        cliEntries = [];
    }
    for (const e of cliEntries) {
        if (e.isDirectory() && /^received/i.test(e.name)) {
            out.push({
                id: `cli-received:${e.name}`,
                path: path.join(root, 'cli', e.name),
                bucket: 'ask',
                why: 'CLI receive output, which means files somebody actually sent you',
            });
        }
    }
    return out;
}

function untrackedDirs(root, tracked) {
    const out = git(root, [
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
    ]);
    if (out === null) return [];
    const seen = new Set();
    const res = [];
    for (const line of out.split(/\r?\n/)) {
        if (!line.startsWith('?? ')) continue;
        let rel = line.slice(3).trim();
        if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
        const top = rel.split('/')[0];
        if (!top || seen.has(top)) continue;
        seen.add(top);
        const p = path.join(root, top);
        // A top-level dir that also holds tracked files is a working
        // directory with one stray file in it, not an untracked artifact.
        if (tracksAnything(tracked, p)) continue;
        res.push({
            id: `untracked:${top}`,
            path: p,
            bucket: 'ask',
            why: 'untracked and not ignored; one git add -A from landing in a commit',
        });
    }
    return res;
}

function tempCandidates(root, scratchDays, tempRoot) {
    const out = [];
    let entries = [];
    try {
        entries = fs.readdirSync(tempRoot, { withFileTypes: true });
    } catch {
        return out;
    }
    const stray =
        /^(floe-(doc|win|win-fixed|staged|shipped|head|on|off)\.exe|floe-run-t.*\.log|floeprobe.*|floetrav.*)$/i;
    for (const e of entries) {
        if (stray.test(e.name)) {
            out.push({
                id: `tmp:${e.name}`,
                path: path.join(tempRoot, e.name),
                bucket: 'safe',
                why: 'orphaned build or probe scratch',
                group: 'tmp-scratch',
            });
        }
    }
    if (exists(path.join(tempRoot, 'floe-run.json'))) {
        out.push({
            id: 'floe-run-pidfile',
            path: path.join(tempRoot, 'floe-run.json'),
            bucket: 'never',
            why: 'a live stack pidfile; run floe-run stop, do not delete it',
        });
    }
    for (const dir of ['lta-runs', path.join('floe-audit', 'out')]) {
        const p = path.join(tempRoot, dir);
        if (exists(p)) {
            out.push({
                id: `audit-evidence:${dir.replace(/[\\/]/g, '-')}`,
                path: p,
                bucket: 'ask',
                why: 'transfer-audit evidence, and the manifest cleanup replays; run cleanup first',
            });
        }
    }
    out.push(...scratchpadCandidates(root, scratchDays, tempRoot));
    return out;
}

function scratchpadCandidates(root, scratchDays, tempRoot) {
    const base = path.join(tempRoot, 'claude');
    const want = path
        .resolve(root)
        .replace(/[:\\/]/g, '-')
        .toLowerCase();
    let projects = [];
    try {
        projects = fs.readdirSync(base, { withFileTypes: true });
    } catch {
        return [];
    }
    const hit = projects.find(
        (d) => d.isDirectory() && d.name.toLowerCase() === want
    );
    if (!hit) return [];
    const projectDir = path.join(base, hit.name);
    let sessions = [];
    try {
        sessions = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const cutoff = Date.now() - scratchDays * 86400000;
    const out = [];
    for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const p = path.join(projectDir, s.name);
        const m = measure(p);
        const empty = m.files === 0 && !m.capped;
        const old = !m.capped && m.newest > 0 && m.newest < cutoff;
        out.push({
            id: `scratchpad:${s.name}`,
            path: p,
            bucket: empty || old ? 'safe' : 'ask',
            why: empty
                ? 'empty session scratchpad'
                : old
                  ? `session scratchpad, untouched for over ${scratchDays} days`
                  : 'recent session scratchpad; another session may still be using it',
            group: 'scratchpad',
        });
    }
    return out;
}

/* ------------------------------------------------------------- reports */

function listeners() {
    if (!WIN) return [];
    try {
        const ps =
            'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
            'Where-Object { $_.LocalPort -in 3000,3001,34115 } | ' +
            'ForEach-Object { [pscustomobject]@{ Port = $_.LocalPort; ' +
            'Proc = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; ' +
            'Pid = $_.OwningProcess } } | ConvertTo-Json -Compress';
        const out = execFileSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', ps],
            { encoding: 'utf8', timeout: 20000 }
        ).trim();
        if (!out) return [];
        const parsed = JSON.parse(out);
        return (Array.isArray(parsed) ? parsed : [parsed]).filter((r) =>
            [3000, 3001, 34115].includes(Number(r.Port))
        );
    } catch {
        return [];
    }
}

export function parseFirewall(json) {
    let rows;
    try {
        rows = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(rows)) rows = [rows];
    return rows
        .filter((r) => r && typeof r.Program === 'string')
        .map((r) => ({
            name: String(r.Name ?? ''),
            action: String(r.Action ?? ''),
            enabled: String(r.Enabled ?? ''),
            program: r.Program,
        }))
        .filter((r) => !exists(r.program));
}

function firewallReport() {
    if (!WIN) return [];
    try {
        const ps =
            'Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | ' +
            "Where-Object { $_.Program -match 'floe' } | ForEach-Object { " +
            '$r = $_ | Get-NetFirewallRule; [pscustomobject]@{ Name = $r.DisplayName; ' +
            'Action = [string]$r.Action; Enabled = [string]$r.Enabled; Program = $_.Program } } | ' +
            'ConvertTo-Json -Compress';
        const out = execFileSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', ps],
            { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 }
        ).trim();
        return out ? parseFirewall(out) : [];
    } catch {
        return [];
    }
}

/** Read-only notes on state this skill deliberately does not sweep. */
function externals(root) {
    const notes = [];
    const cache =
        process.env.GOCACHE ||
        path.join(os.homedir(), 'AppData', 'Local', 'go-build');
    if (exists(cache)) {
        notes.push({
            what: 'go build cache',
            detail: `${cache} (go clean -cache owns it)`,
        });
    }
    const stash = git(root, ['stash', 'list']);
    if (stash && stash.trim()) {
        notes.push({
            what: 'git stashes',
            detail: `${stash.trim().split(/\r?\n/).length} entry(ies), never dropped by this skill`,
        });
    }
    const branches = git(root, [
        'for-each-ref',
        '--format=%(refname:short) %(upstream)',
        'refs/heads',
    ]);
    if (branches) {
        const local = branches
            .split(/\r?\n/)
            .filter((l) => l.trim() && l.trim().split(' ').length === 1)
            .map((l) => l.trim());
        if (local.length) {
            notes.push({
                what: 'local-only branches',
                detail: `${local.join(', ')} (these exist on this disk only)`,
            });
        }
    }
    const wt = git(root, ['worktree', 'list']);
    if (wt && wt.trim().split(/\r?\n/).length > 1) {
        notes.push({
            what: 'git worktrees',
            detail: `${wt.trim().split(/\r?\n/).length} checked out`,
        });
    }
    return notes;
}

/* --------------------------------------------------------------- survey */

export function buildCandidates(opts) {
    const { root, ageMinutes, scratchDays } = opts;
    const tempRoot = opts.tempRoot ?? os.tmpdir();
    const keeps = (opts.keeps ?? []).map((k) =>
        realOrSelf(path.resolve(root, k))
    );
    const fence = makeFence(root, keeps, tempRoot);
    const allowRoots = [
        ...new Set([path.resolve(root), path.resolve(tempRoot)]),
    ];
    const tracked = trackedPaths(root);
    if (tracked === null) return { error: 'not a git checkout' };

    const raw = [
        ...repoRules(root),
        ...repoGlobCandidates(root),
        ...untrackedDirs(root, tracked),
        ...tempCandidates(root, scratchDays, tempRoot),
    ];

    const ageCut = Date.now() - ageMinutes * 60000;
    const seen = new Set();
    const items = [];
    for (const c of raw) {
        if (!exists(c.path)) continue;
        const key = norm(c.path);
        if (seen.has(key)) continue;
        seen.add(key);

        const real = realOrSelf(c.path);
        const m = measure(c.path);
        const item = {
            id: c.id,
            path: c.path,
            realPath: norm(real) === norm(c.path) ? null : real,
            bucket: c.bucket,
            why: c.why,
            bytes: m.bytes,
            files: m.files,
            newest: m.newest,
            capped: m.capped,
            sizeIsLowerBound: m.sizeIsLowerBound,
            group: c.group ?? null,
            recent: m.newest > ageCut,
        };

        const refusal = fence(c.path);
        const carried = refusal ? null : scanContents(c.path, allowRoots);
        if (refusal) {
            item.bucket = 'never';
            item.why = refusal;
        } else if (
            tracksAnything(tracked, real) ||
            tracksAnything(tracked, c.path)
        ) {
            item.bucket = 'never';
            item.why = 'tracked by git';
        } else if (carried) {
            item.bucket = carried.hard ? 'never' : 'ask';
            item.why = `carries ${carried.why}: ${carried.path}`;
        } else if (m.capped && item.bucket === 'safe') {
            item.bucket = 'ask';
            item.why = `age unknown: the walk hit ${WALK_CEILING} entries`;
        } else if (item.bucket === 'safe' && item.recent) {
            item.bucket = 'held';
            item.why = `touched in the last ${ageMinutes} min; another session may be using it`;
        }
        items.push(item);
    }
    items.sort((a, b) => b.bytes - a.bytes);
    return { items, fence, allowRoots, tracked, ageCut };
}

/* ---------------------------------------------------------------- sweep */

/**
 * Re-checks every invariant immediately before each removal, not just the
 * path fence: a candidate can become tracked, gain a denied child, or be
 * touched by another session between survey and sweep. Failures are
 * collected per item so one locked file cannot abort the rest or erase the
 * record of what already went.
 */
function sweep(items, ctx, apply, includeIds, onRemove) {
    const targets = items.filter(
        (i) =>
            i.bucket === 'safe' || (i.bucket === 'ask' && includeIds.has(i.id))
    );
    const removed = [];
    const failed = [];
    const vanished = [];
    for (const t of targets) {
        if (!exists(t.path)) {
            vanished.push(t);
            continue;
        }
        const carried = scanContents(t.path, ctx.allowRoots);
        const refusal =
            ctx.fence(t.path) ??
            (tracksAnything(ctx.tracked, t.path)
                ? 'became tracked by git'
                : null) ??
            (carried && carried.hard ? `now carries ${carried.why}` : null) ??
            (measure(t.path).newest > ctx.ageCut && !includeIds.has(t.id)
                ? 'was touched since the survey'
                : null);
        if (refusal) {
            const err = new Error(`fence tripped on ${t.path}: ${refusal}`);
            err.code = 4;
            err.removed = removed;
            throw err;
        }
        if (!apply) {
            removed.push(t);
            continue;
        }
        try {
            fs.rmSync(t.path, { recursive: true, force: true, maxRetries: 3 });
            if (exists(t.path)) throw new Error('still present after rmSync');
            removed.push(t);
            if (onRemove) onRemove(t);
        } catch (e) {
            failed.push({ ...t, error: e.message });
        }
    }
    return { removed, failed, vanished };
}

/* ----------------------------------------------------------- self-test */

function selfTest(root) {
    const tmp = os.tmpdir();
    const fence = makeFence(root, [], tmp);
    const home = os.homedir();
    const appdata =
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localapp =
        process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const cases = [
        [path.join(root, 'server', '.env'), true],
        [path.join(root, 'server', '.env.example'), false],
        [path.join(root, 'client', '.env.local'), true],
        [path.join(root, 'coturn', 'turnserver.conf'), true],
        [path.join(appdata, 'floe'), true],
        [path.join(appdata, 'floe', 'desktop.json'), true],
        [path.join(localapp, 'ms-playwright', 'chromium-1234'), true],
        [path.join(home, 'floe_transfer_1779272746482.zip'), true],
        [path.join(root, 'desktop', 'frontend', 'dist'), true],
        [path.join(tmp, 'floe-audit', 'bin'), true],
        [path.join(home, '.claude', 'plans'), true],
        [path.join(home, '.claude', 'projects', 'x', 'memory'), true],
        [path.join(root, 'client', '.next', '.env.local'), true],
        [path.join(root, 'client', '.next', 'cache', '.git'), true],
        [root, true],
        [tmp, true],
        [home, true],
        [path.join(home, 'Documents'), true],
        [path.join(root, '.git', 'config'), true],
        [path.join(root, 'client', '.next'), false],
        [path.join(root, 'client', 'playwright-report'), false],
        [path.join(tmp, 'floe-win-fixed.exe'), false],
    ];
    let bad = 0;
    for (const [p, shouldRefuse] of cases) {
        const refused = fence(p) !== null;
        if (refused !== shouldRefuse) {
            bad += 1;
            console.log(
                `FAIL ${p}\n     expected ${shouldRefuse ? 'refuse' : 'allow'}, got ${refused ? 'refuse' : 'allow'}`
            );
        }
    }
    console.log(
        bad === 0
            ? `self-test ok (${cases.length} fence assertions)`
            : `self-test FAILED (${bad} of ${cases.length})`
    );
    return bad === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ cli */

function parseArgs(argv) {
    const o = {
        cmd: 'survey',
        root: DEFAULT_ROOT,
        ageMinutes: 30,
        scratchDays: 7,
        includes: [],
        keeps: [],
        apply: false,
        json: false,
        firewall: false,
        verbose: false,
        tempRoot: os.tmpdir(),
        selfTest: false,
    };
    const rest = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            i += 1;
            if (i >= argv.length) throw new Error(`${a} needs a value`);
            return argv[i];
        };
        if (a === '--root') o.root = realOrSelf(path.resolve(next()));
        else if (a === '--temp-root')
            o.tempRoot = realOrSelf(path.resolve(next()));
        else if (a === '--age-minutes') o.ageMinutes = Number(next());
        else if (a === '--scratch-days') o.scratchDays = Number(next());
        else if (a === '--include') o.includes.push(next());
        else if (a === '--keep') o.keeps.push(next());
        else if (a === '--apply') o.apply = true;
        else if (a === '--json') o.json = true;
        else if (a === '--firewall') o.firewall = true;
        else if (a === '--verbose') o.verbose = true;
        else if (a === '--self-test') o.selfTest = true;
        else if (a === '-h' || a === '--help') o.help = true;
        else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        else rest.push(a);
    }
    if (rest.length > 1) throw new Error(`unexpected argument ${rest[1]}`);
    if (rest.length === 1) o.cmd = rest[0];
    if (!['survey', 'sweep'].includes(o.cmd))
        throw new Error(`unknown command ${o.cmd}`);
    if (!Number.isFinite(o.ageMinutes) || o.ageMinutes < 0) {
        throw new Error('--age-minutes must be a non-negative number');
    }
    if (!Number.isFinite(o.scratchDays) || o.scratchDays < 0) {
        throw new Error('--scratch-days must be a non-negative number');
    }
    return o;
}

function render(items, opts, result, extras) {
    const by = (b) => items.filter((i) => i.bucket === b);
    const sum = (a) => a.reduce((n, i) => n + i.bytes, 0);

    const line = (i) => {
        const via = i.realPath ? ` -> ${i.realPath}` : '';
        const approx = i.sizeIsLowerBound ? '+' : ' ';
        return (
            `  ${i.id.padEnd(34)} ${(human(i.bytes) + approx).padStart(10)}  ${i.path}${via}\n` +
            `  ${' '.repeat(34)} ${' '.repeat(10)}  ${i.why}`
        );
    };

    const section = (title, list) => {
        console.log(`${title} (${list.length}, ${human(sum(list))})`);
        const groups = new Map();
        const solo = [];
        for (const i of list) {
            if (!i.group || opts.verbose) {
                solo.push(i);
                continue;
            }
            if (!groups.has(i.group)) groups.set(i.group, []);
            groups.get(i.group).push(i);
        }
        for (const [name, members] of [...groups]) {
            if (members.length <= 3) {
                solo.push(...members);
                groups.delete(name);
            }
        }
        for (const i of solo.sort((a, b) => b.bytes - a.bytes)) {
            console.log(line(i));
        }
        for (const [name, members] of groups) {
            const reasons = new Map();
            for (const m of members) {
                reasons.set(m.why, (reasons.get(m.why) ?? 0) + 1);
            }
            console.log(
                `  ${name.padEnd(34)} ${human(sum(members)).padStart(10)}  ${members.length} items`
            );
            for (const [why, n] of reasons) {
                console.log(
                    `  ${' '.repeat(34)} ${' '.repeat(10)}  ${n} x ${why}`
                );
            }
            console.log(
                `  ${' '.repeat(34)} ${' '.repeat(10)}  --verbose to list them individually`
            );
        }
    };

    if (result) {
        const { removed, failed, vanished } = result;
        console.log(
            opts.apply
                ? `removed ${removed.length} item(s), ${human(sum(removed))} reclaimed`
                : `would remove ${removed.length} item(s), ${human(sum(removed))} (dry run, pass --apply)`
        );
        for (const i of removed) console.log(`  ${i.path}`);
        for (const i of vanished) {
            console.log(`  gone before the sweep reached it: ${i.path}`);
        }
        for (const i of failed) console.log(`  FAILED ${i.path}: ${i.error}`);
        console.log('');
    }

    section('safe', by('safe'));
    console.log('');
    section('ask first', by('ask'));
    console.log('');
    section('held', by('held'));
    console.log(`\nfenced (${by('never').length}) - considered and refused`);
    for (const i of by('never')) console.log(`  ${i.id.padEnd(34)} ${i.why}`);

    if (extras.listeners.length) {
        console.log('\nlisteners (this skill never kills anything)');
        for (const l of extras.listeners) {
            console.log(`  :${l.Port} ${l.Proc ?? '?'} pid ${l.Pid}`);
        }
        console.log(
            '  owner: node .claude/skills/floe-run/scripts/floe-run.mjs stop'
        );
    }
    if (extras.externals.length) {
        console.log('\nnot swept, reported only');
        for (const n of extras.externals) {
            console.log(`  ${n.what.padEnd(22)} ${n.detail}`);
        }
    }
    if (opts.firewall) {
        console.log(
            `\nfirewall rules naming a missing file (${extras.firewall.length})`
        );
        for (const f of extras.firewall) {
            console.log(
                `  ${f.action.padEnd(5)} ${f.enabled.padEnd(5)} ${f.program}`
            );
        }
        if (extras.firewall.length) {
            console.log(
                '  removing these needs an elevated shell and is your call.'
            );
        }
    }
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`usage error: ${e.message}`);
        return 2;
    }
    if (opts.help) {
        console.log(
            'usage: deep-clean.mjs [survey|sweep] [--apply] [--root dir]\n' +
                '       [--age-minutes n] [--scratch-days n] [--include id]\n' +
                '       [--keep path] [--firewall] [--verbose] [--json] [--self-test]'
        );
        return 0;
    }
    if (opts.selfTest) return selfTest(opts.root);

    // Invariant 4: a root that is not a Floe checkout cannot move the fence.
    if (!exists(path.join(opts.root, '.git'))) {
        console.error(`precondition: ${opts.root} is not a git checkout`);
        return 3;
    }
    if (!exists(path.join(opts.root, 'CLAUDE.md'))) {
        console.error(
            `precondition: ${opts.root} has no CLAUDE.md, so it does not look like a Floe checkout.\n` +
                '  Refusing, because --root also decides where the deny list is anchored.'
        );
        return 3;
    }
    for (const k of opts.keeps) {
        const resolved = path.resolve(opts.root, k);
        if (!exists(resolved)) {
            console.error(
                `usage error: --keep ${k} does not exist (resolved to ${resolved})`
            );
            return 2;
        }
    }

    const built = buildCandidates(opts);
    if (built.error) {
        console.error(`precondition: ${built.error}`);
        return 3;
    }
    const { items } = built;

    const includeIds = new Set(opts.includes);
    for (const id of includeIds) {
        const hit = items.find((i) => i.id === id);
        if (!hit) {
            console.error(`usage error: --include ${id} matches no candidate`);
            return 2;
        }
        if (hit.bucket !== 'ask') {
            console.error(
                `usage error: --include ${id} is in the ${hit.bucket} bucket, only ask items can be promoted`
            );
            return 2;
        }
        if (hit.recent) {
            console.error(
                `usage error: --include ${id} was touched in the last ${opts.ageMinutes} min.\n` +
                    '  Another session may be writing to it. Wait, or re-run with an explicit\n' +
                    '  --age-minutes if you are certain nothing else is using it.'
            );
            return 2;
        }
    }

    let result = null;
    if (opts.cmd === 'sweep') {
        try {
            result = sweep(items, built, opts.apply, includeIds, (t) =>
                console.log(`removed ${t.path}`)
            );
        } catch (e) {
            console.error(e.message);
            for (const r of e.removed ?? []) {
                console.error(`  already removed: ${r.path}`);
            }
            return Number.isInteger(e.code) ? e.code : 1;
        }
        if (opts.apply) {
            const gone = new Set(result.removed.map((i) => i.id));
            for (const i of items) if (gone.has(i.id)) i.bucket = 'swept';
        }
    }

    const extras = {
        listeners: listeners(),
        externals: externals(opts.root),
        firewall: opts.firewall ? firewallReport() : [],
    };

    if (opts.json) {
        console.log(
            JSON.stringify({ root: opts.root, items, result, extras }, null, 2)
        );
    } else {
        render(items, opts, result, extras);
    }

    if (opts.cmd === 'sweep') {
        if (result.failed.length) return 5;
        return result.removed.length ? 1 : 0;
    }
    return items.filter((i) => i.bucket === 'safe' || i.bucket === 'ask').length
        ? 1
        : 0;
}

if (
    import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1] === fileURLToPath(import.meta.url)
) {
    process.exit(main());
}
