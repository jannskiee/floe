#!/usr/bin/env node
/**
 * The Store listing's source of truth, read and checked.
 *
 * references/listing/en-US/ holds the words and images the en-US listing of
 * Floe Desktop (9NBQ8ZQ1065L) carries: the description, the product features,
 * the screenshot captions, the screenshots and the certification notes, with
 * manifest.json recording each one's length and fingerprint and which
 * submission saved it. This script reads that folder, measures it, and says
 * where it and the manifest disagree or where a field would not fit the
 * Store's form.
 *
 * It never writes and never touches the network. The live listing is read in
 * Partner Center (SKILL.md step 5a); the fingerprint printed here is the one
 * to compare with a field read back there, since djb2 is the loop
 * release-notes.mjs documents for a browser snippet.
 *
 * usage: node .claude/skills/store-submit/scripts/listing.mjs [--dir <listing folder>]
 * exit:  0 the folder matches its manifest and fits the Store's limits
 *        1 a HARD finding
 *        2 usage
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { djb2 } from './release-notes.mjs';

export const DEFAULT_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'references',
    'listing',
    'en-US'
);

/**
 * What the Store's form takes. Description, features and captions are from
 * Microsoft Learn, "Add and edit Store listing info for MSIX app" (read
 * 2026-10-13): a description of up to 10,000 characters, up to 20 features of
 * at most 200 characters each (the Store adds the bullets), captions of 200
 * characters or less. The notes limit is the field's own, read in Partner
 * Center on 2026-10-09 (references/partner-center.md). Screenshots: PNG, at
 * least 1366 x 768 for desktop and at most 3840 x 2160, under 50 MB.
 */
export const LIMITS = Object.freeze({
    description: 10_000,
    featureCount: 20,
    featureEach: 200,
    captionEach: 200,
    certificationNotes: 6_000,
    shotMin: [1366, 768],
    shotMax: [3840, 2160],
    shotBytes: 50 * 1024 * 1024,
});

const TEXT_FIELDS = ['description', 'features', 'captions', 'certification-notes'];
const DASH = /[–—]/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A field as the Store form holds it: LF line ends and no final newline. A
 * checkout under core.autocrlf=true hands these files over with CRLF, and an
 * editor adds the last newline; neither is part of the text.
 */
export function normalize(text) {
    return String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/** { width, height } from a PNG's IHDR, or null when it is not a PNG. */
export function pngSize(buf) {
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Everything measured from the folder: no judgment, no manifest. */
export function readListing(dir = DEFAULT_DIR) {
    const fields = {};
    for (const name of TEXT_FIELDS) {
        const file = path.join(dir, `${name}.txt`);
        if (!existsSync(file)) {
            fields[name] = null;
            continue;
        }
        const text = normalize(readFileSync(file, 'utf8'));
        fields[name] = {
            text,
            len: [...text].length,
            djb2: djb2(text),
            lines: text === '' ? [] : text.split('\n'),
        };
    }
    const shotDir = path.join(dir, 'screenshots');
    const screenshots = existsSync(shotDir)
        ? readdirSync(shotDir)
              .sort()
              .map((name) => {
                  const buf = readFileSync(path.join(shotDir, name));
                  const size = pngSize(buf);
                  return {
                      file: `screenshots/${name}`,
                      bytes: buf.length,
                      width: size ? size.width : null,
                      height: size ? size.height : null,
                      sha256: createHash('sha256').update(buf).digest('hex'),
                  };
              })
        : [];
    return { fields, screenshots };
}

/** HARD findings, one sentence each; empty when the folder is sound. */
export function checkListing(listing, manifest) {
    const hard = [];
    const { fields, screenshots } = listing;
    for (const name of TEXT_FIELDS) {
        const f = fields[name];
        if (!f) {
            hard.push(`${name}.txt is missing`);
            continue;
        }
        if (DASH.test(f.text)) hard.push(`${name}.txt holds an em or en dash`);
        const m = manifest?.fields?.[name];
        if (!m) hard.push(`manifest.json has no row for ${name}`);
        else if (m.len !== f.len || m.djb2 !== f.djb2)
            hard.push(
                `${name}.txt is ${f.len} characters (djb2 ${f.djb2}) and manifest.json says ${m.len} (djb2 ${m.djb2}): a listing change updates both, in the same change`
            );
    }
    const { description, features, captions } = fields;
    const notes = fields['certification-notes'];
    if (description && description.len > LIMITS.description)
        hard.push(`description.txt is ${description.len} characters; the Store takes ${LIMITS.description}`);
    if (notes && notes.len > LIMITS.certificationNotes)
        hard.push(`certification-notes.txt is ${notes.len} characters; the field takes ${LIMITS.certificationNotes}`);
    if (features) {
        if (features.lines.length > LIMITS.featureCount)
            hard.push(`features.txt holds ${features.lines.length} features; the Store takes ${LIMITS.featureCount}`);
        features.lines.forEach((line, i) => {
            const n = [...line].length;
            if (n === 0) hard.push(`features.txt line ${i + 1} is empty`);
            if (n > LIMITS.featureEach)
                hard.push(`features.txt line ${i + 1} is ${n} characters; a feature takes ${LIMITS.featureEach}`);
            // The Store draws the bullets itself.
            if (/^\s*[-*•]\s/.test(line)) hard.push(`features.txt line ${i + 1} starts with a bullet`);
        });
    }
    if (captions) {
        captions.lines.forEach((line, i) => {
            const n = [...line].length;
            if (n === 0) hard.push(`captions.txt line ${i + 1} is empty`);
            if (n > LIMITS.captionEach)
                hard.push(`captions.txt line ${i + 1} is ${n} characters; a caption takes ${LIMITS.captionEach}`);
        });
        if (captions.lines.length !== screenshots.length)
            hard.push(
                `captions.txt holds ${captions.lines.length} captions for ${screenshots.length} screenshots: one line per image, in listing order`
            );
    }
    if (screenshots.length === 0) hard.push('screenshots/ holds no image');
    const known = new Map((manifest?.screenshots ?? []).map((s) => [s.file, s]));
    for (const s of screenshots) {
        if (s.width === null) {
            hard.push(`${s.file} is not a PNG`);
            continue;
        }
        if (s.width < LIMITS.shotMin[0] || s.height < LIMITS.shotMin[1])
            hard.push(`${s.file} is ${s.width} x ${s.height}; a desktop screenshot is at least ${LIMITS.shotMin.join(' x ')}`);
        if (s.width > LIMITS.shotMax[0] || s.height > LIMITS.shotMax[1])
            hard.push(`${s.file} is ${s.width} x ${s.height}; the Store takes at most ${LIMITS.shotMax.join(' x ')}`);
        if (s.bytes >= LIMITS.shotBytes) hard.push(`${s.file} is ${s.bytes} bytes; the Store takes under 50 MB`);
        const m = known.get(s.file);
        if (!m) hard.push(`${s.file} has no row in manifest.json`);
        else if (m.sha256 !== s.sha256 || m.width !== s.width || m.height !== s.height)
            hard.push(`${s.file} is not the image manifest.json records (sha256 ${s.sha256.slice(0, 12)}, ${s.width} x ${s.height})`);
        known.delete(s.file);
    }
    for (const file of known.keys()) hard.push(`manifest.json names ${file}, which is not in the folder`);
    return hard;
}

export function readManifest(dir = DEFAULT_DIR) {
    const file = path.join(dir, 'manifest.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}

export function main(argv) {
    let dir = DEFAULT_DIR;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dir' && argv[i + 1]) dir = path.resolve(argv[++i]);
        else {
            console.error('usage: listing.mjs [--dir <listing folder>]');
            return 2;
        }
    }
    const listing = readListing(dir);
    const manifest = readManifest(dir);
    for (const name of TEXT_FIELDS) {
        const f = listing.fields[name];
        console.log(
            f
                ? `${name}: ${f.len} characters, djb2 ${f.djb2}, ${f.lines.length} line(s)`
                : `${name}: missing`
        );
    }
    for (const s of listing.screenshots)
        console.log(`${s.file}: ${s.width} x ${s.height}, ${s.bytes} bytes, sha256 ${s.sha256}`);
    const hard = manifest ? checkListing(listing, manifest) : ['manifest.json is missing'];
    for (const h of hard) console.log(`HARD ${h}`);
    console.log(
        hard.length
            ? `listing: ${hard.length} hard`
            : `listing: matches manifest.json (submission ${manifest.saved?.submission}, ${manifest.saved?.date})`
    );
    return hard.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    process.exit(main(process.argv.slice(2)));
