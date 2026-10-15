#!/usr/bin/env node
/**
 * Writes references/released-strings.json: which messages of the CLI and of
 * Floe Desktop are in the source of the RELEASED apps.
 *
 * Why a snapshot: the docs describe the apps people have installed, and main
 * runs ahead of them between releases. A message reworded on main is still
 * what the released app prints, so a docs page that quotes the old wording is
 * right and a check against the working tree would call it stale; a message
 * added on main is in no released app, and a check against the working tree
 * would call a docs page complete that explains words nobody can see yet. The
 * web app and the server have no such gap (floe.one serves main), so their
 * rows are read from the working tree and are not in this file.
 *
 * Each surface is read at its own ref because the two apps release apart: a
 * shared engine file (cli/engine/...) can differ between the newest `v*` tag
 * and the newest `desktop-v*` tag, so the file is keyed by surface first.
 * A capture manifest under docs/images/desktop or docs/images/cli records
 * strings seen in a picture of a released app; those are held to the same
 * refs and kept in the same lists. Under `copy` it also records every copy
 * line of the released apps' copy modules (COPY_FILES in message-match.mjs)
 * as the tag has them, which is what the `messages` check holds the rows of
 * those files to: every line needs a row.
 *
 * Run it at release prep, with the two tags the docs are about to describe,
 * and at no other time: between releases the file is supposed to stay behind
 * main. It reads git only (`git show <ref>:<path>`) and writes this one file.
 *
 * Usage:
 *   node released-strings.mjs --cli <ref> --desktop <ref> [--root <repo>]
 * Exit 0 written, 2 usage or a ref git does not know. A row whose text is not
 * at its ref is listed and left out; the `messages` check then reports it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    COPY_FILES,
    copyLines,
    haystack,
    textOccurs,
} from './message-match.mjs';
import { MESSAGES_FILE } from './messages-index.mjs';

export const RELEASED_FILE =
    '.claude/skills/docs-verify/references/released-strings.json';
// The surfaces that are released by tag, which is also the name of the
// docs/images directory that holds pictures of each.
export const RELEASED_SURFACES = ['cli', 'desktop'];

// A row is held to a release when its surface is released by tag and its file
// ships in that release. The CLI's install scripts are the case that is not:
// they are cli rows typed in client/public, which floe.one serves from main,
// so a person runs main's wording. Those rows, and a cli or desktop row whose
// words are typed by the server, are read from the working tree.
export function heldToRelease(row) {
    return (
        RELEASED_SURFACES.includes(row.surface) &&
        /^(cli|desktop)\//.test(row.source)
    );
}

/**
 * rows: messages.json. captures: [{ surface, string, sources }] from the
 * manifests of the released apps. show(ref, path) returns the file's text at
 * that ref, or null. Returns the snapshot and what was not found.
 */
export function buildSnapshot({ refs, rows, captures = [], show }) {
    const hays = new Map();
    const hayAt = (surface, path) => {
        const key = `${surface}\u0000${path}`;
        if (!hays.has(key)) {
            const text = show(refs[surface], path);
            hays.set(key, text === null ? null : haystack(text));
        }
        return hays.get(key);
    };
    const found = { cli: new Map(), desktop: new Map() };
    const add = (surface, path, text) => {
        if (!found[surface].has(path)) found[surface].set(path, new Set());
        found[surface].get(path).add(text);
    };
    const missing = [];
    for (const row of rows) {
        if (!heldToRelease(row)) continue;
        const hay = hayAt(row.surface, row.source);
        if (hay && textOccurs(row.text, hay))
            add(row.surface, row.source, row.text);
        else
            missing.push({
                surface: row.surface,
                text: row.text,
                source: row.source,
                why: hay ? 'the text is not in the file' : 'no such file',
            });
    }
    for (const c of captures) {
        const path = c.sources.find((p) => {
            const hay = hayAt(c.surface, p);
            return hay && textOccurs(c.string, hay);
        });
        if (path) add(c.surface, path, c.string);
        else
            missing.push({
                surface: c.surface,
                text: c.string,
                source: c.sources.join(', '),
                why: 'in none of the files the picture names',
            });
    }
    // The copy lines of each released copy module, in source order.
    const copy = { cli: {}, desktop: {} };
    for (const { surface, file } of COPY_FILES) {
        if (!heldToRelease({ surface, source: file })) continue;
        const text = show(refs[surface], file);
        if (text === null)
            missing.push({
                surface,
                text: '(its copy lines)',
                source: file,
                why: 'no such file',
            });
        else copy[surface][file] = copyLines(text, file);
    }
    // Sorted, so a regenerated file differs only where a string did.
    const listed = (map) =>
        Object.fromEntries(
            [...map.keys()]
                .sort()
                .map((path) => [path, [...map.get(path)].sort()])
        );
    return {
        snapshot: {
            refs,
            cli: listed(found.cli),
            desktop: listed(found.desktop),
            copy,
        },
        missing,
    };
}

// The strings recorded for pictures of a released app.
export function releasedCaptures(root) {
    const out = [];
    for (const surface of RELEASED_SURFACES) {
        const file = join(
            root,
            'docs',
            'images',
            surface,
            'capture-manifest.json'
        );
        if (!existsSync(file)) continue;
        const manifest = JSON.parse(
            readFileSync(file, 'utf8').replace(/^\ufeff/, '')
        );
        for (const shot of manifest.shots || [])
            for (const string of shot.strings || [])
                out.push({ surface, string, sources: shot.sources || [] });
    }
    return out;
}

function git(root, args) {
    return spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
}

function main(args) {
    let root = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..'
    );
    const refs = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--root') root = resolve(args[++i] || '');
        else if (args[i] === '--cli') refs.cli = args[++i];
        else if (args[i] === '--desktop') refs.desktop = args[++i];
        else refs.bad = true;
    }
    if (
        refs.bad ||
        !refs.cli ||
        !refs.desktop ||
        !existsSync(join(root, MESSAGES_FILE))
    ) {
        console.error(
            'usage: node released-strings.mjs --cli <ref> --desktop <ref> [--root <repo>]'
        );
        console.error(`(the repo must hold ${MESSAGES_FILE})`);
        process.exit(2);
    }
    for (const ref of [refs.cli, refs.desktop]) {
        if (
            git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
                .status === 0
        )
            continue;
        console.error(`released-strings: git does not know the ref "${ref}"`);
        process.exit(2);
    }
    const rows = JSON.parse(
        readFileSync(join(root, MESSAGES_FILE), 'utf8').replace(/^\ufeff/, '')
    );
    const { snapshot, missing } = buildSnapshot({
        refs: { cli: refs.cli, desktop: refs.desktop },
        rows,
        captures: releasedCaptures(root),
        show: (ref, path) => {
            // No spelling of an environment file is read, at any ref.
            if (
                /^\.env(\.|$)/.test(basename(path)) &&
                !path.endsWith('.example')
            )
                return null;
            const r = git(root, ['show', `${ref}:${path}`]);
            return r.status === 0 ? r.stdout : null;
        },
    });
    writeFileSync(
        join(root, RELEASED_FILE),
        `${JSON.stringify(snapshot, null, 4)}\n`
    );
    const count = (surface) =>
        Object.values(snapshot[surface]).reduce(
            (n, list) => n + list.length,
            0
        );
    console.log(`released-strings: wrote ${RELEASED_FILE}`);
    for (const surface of RELEASED_SURFACES)
        console.log(
            `  ${surface} at ${refs[surface]}: ${count(surface)} texts in ${Object.keys(snapshot[surface]).length} files`
        );
    console.log(`  ${missing.length} not at their ref, left out:`);
    for (const m of missing)
        console.log(
            `    [${m.surface}] ${m.source}: ${m.text.replace(/\s+/g, ' ')} (${m.why})`
        );
}

function realPath(p) {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
}
const invokedDirectly =
    process.argv[1] &&
    realPath(resolve(process.argv[1])).toLowerCase() ===
        realPath(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedDirectly) main(process.argv.slice(2));
