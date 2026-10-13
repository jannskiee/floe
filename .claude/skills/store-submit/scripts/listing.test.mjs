/**
 * Tests for listing.mjs and for the listing folder itself.
 *
 * The first group reads the real folder, references/listing/en-US/: it is
 * the source of truth for what the Store listing says, so its text, its
 * images and manifest.json have to agree, and every field has to fit the
 * Store's form. The second group builds small folders in the temp directory
 * with one defect each and reads the finding.
 *
 * Pure file reads. No network, no Partner Center.
 *
 * Run: node --test .claude/skills/store-submit/scripts/listing.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
    DEFAULT_DIR,
    LIMITS,
    checkListing,
    normalize,
    pngSize,
    readListing,
    readManifest,
} from './listing.mjs';

const SCRIPT = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');
const made = [];
after(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

/** A copy of the real folder to break. */
function copy() {
    const dir = mkdtempSync(join(tmpdir(), 'store-listing-'));
    made.push(dir);
    cpSync(DEFAULT_DIR, dir, { recursive: true });
    return dir;
}
const findings = (dir) => checkListing(readListing(dir), readManifest(dir));
const thousands = (n) => n.toLocaleString('en-US');

test('the listing folder matches its manifest and fits the Store form', () => {
    assert.deepEqual(findings(DEFAULT_DIR), []);
    const { fields, screenshots } = readListing(DEFAULT_DIR);
    // The folder holds exactly these, so nothing rides along unrecorded.
    assert.deepEqual(readdirSync(DEFAULT_DIR).sort(), [
        'README.md',
        'captions.txt',
        'certification-notes.txt',
        'description.txt',
        'features.txt',
        'manifest.json',
        'screenshots',
    ]);
    assert.ok(fields.description.len <= LIMITS.description);
    assert.ok(fields['certification-notes'].len <= LIMITS.certificationNotes);
    assert.ok(fields.features.lines.length <= LIMITS.featureCount);
    assert.equal(fields.captions.lines.length, screenshots.length);
    for (const s of screenshots) {
        assert.ok(s.width >= 1366 && s.height >= 768, s.file);
        assert.match(s.file, /^screenshots\/\d\d-[a-z-]+\.png$/);
    }
    // Listing order is file order: the captions line up with it.
    assert.deepEqual(
        screenshots.map((s) => s.file),
        [...screenshots.map((s) => s.file)].sort()
    );
});

test('the manifest and the submission history record the same fingerprints', () => {
    // references/partner-center.md is the record of what each submission
    // saved; the manifest must not drift from it without a new row there.
    const manifest = readManifest(DEFAULT_DIR);
    const history = readFileSync(
        join(DEFAULT_DIR, '..', '..', 'partner-center.md'),
        'utf8'
    );
    const row = history
        .split(/\r?\n/)
        .find((l) => l.startsWith(`| ${manifest.saved.submission} `));
    assert.ok(row, `no history row for submission ${manifest.saved.submission}`);
    assert.ok(row.includes(manifest.saved.date));
    assert.ok(row.includes(manifest.saved.package));
    const d = manifest.fields.description;
    const n = manifest.fields['certification-notes'];
    assert.ok(row.includes(`description, ${thousands(d.len)} characters (djb2 ${d.djb2})`));
    assert.ok(row.includes(`certification notes, ${thousands(n.len)} characters (djb2 ${n.djb2})`));
    assert.ok(row.includes(`${manifest.fields.features.count} features`));
    // The captions the reference lists are the captions on file.
    const captions = readListing(DEFAULT_DIR).fields.captions.lines;
    captions.forEach((c, i) => assert.ok(history.includes(`${i + 1}. ${c}`), `caption ${i + 1}`));
});

test('normalize takes a CRLF checkout and a final newline for what the form holds', () => {
    assert.equal(normalize('a\r\nb\r\n'), 'a\nb');
    assert.equal(normalize('a\nb\n\n'), 'a\nb');
    assert.equal(normalize('a\nb'), 'a\nb');
    // The same folder checked out with CRLF measures the same.
    const dir = copy();
    for (const f of ['description.txt', 'features.txt', 'captions.txt', 'certification-notes.txt']) {
        const lf = readFileSync(join(dir, f), 'utf8');
        writeFileSync(join(dir, f), lf.replace(/\r?\n/g, '\r\n'));
    }
    assert.deepEqual(findings(dir), []);
});

test('a changed word, a changed image and a stale manifest are each named', () => {
    const edited = copy();
    writeFileSync(
        join(edited, 'description.txt'),
        readFileSync(join(edited, 'description.txt'), 'utf8').replace('Floe Desktop', 'Floe  Desktop')
    );
    assert.match(findings(edited).join('\n'), /description\.txt is 3,?297 characters .* manifest\.json says 3,?296/);

    const repainted = copy();
    const shot = join(repainted, 'screenshots', readdirSync(join(repainted, 'screenshots'))[0]);
    const buf = readFileSync(shot);
    buf[buf.length - 20] ^= 0xff;
    writeFileSync(shot, buf);
    assert.match(findings(repainted).join('\n'), /is not the image manifest\.json records/);

    const orphan = copy();
    const m = readManifest(orphan);
    m.screenshots.push({ file: 'screenshots/05-gone.png', width: 1366, height: 768, bytes: 1, sha256: 'x' });
    writeFileSync(join(orphan, 'manifest.json'), JSON.stringify(m));
    assert.match(findings(orphan).join('\n'), /names screenshots\/05-gone\.png, which is not in the folder/);

    const extra = copy();
    cpSync(shot.replace(repainted, extra), join(extra, 'screenshots', '09-extra.png'));
    const out = findings(extra).join('\n');
    assert.match(out, /09-extra\.png has no row in manifest\.json/);
    assert.match(out, /4 captions for 5 screenshots/);
});

test('a field the Store form would refuse is named', () => {
    const long = copy();
    writeFileSync(join(long, 'features.txt'), `${'x'.repeat(201)}\n- bulleted\n\nlast\n`);
    const out = findings(long).join('\n');
    assert.match(out, /features\.txt line 1 is 201 characters; a feature takes 200/);
    assert.match(out, /features\.txt line 2 starts with a bullet/);
    assert.match(out, /features\.txt line 3 is empty/);

    const many = copy();
    writeFileSync(join(many, 'features.txt'), Array.from({ length: 21 }, (_, i) => `feature ${i}`).join('\n'));
    assert.match(findings(many).join('\n'), /holds 21 features; the Store takes 20/);

    const dashed = copy();
    writeFileSync(join(dashed, 'captions.txt'), `one — two\nb\nc\nd\n`);
    assert.match(findings(dashed).join('\n'), /captions\.txt holds an em or en dash/);

    const big = copy();
    writeFileSync(join(big, 'description.txt'), 'x'.repeat(10_001));
    writeFileSync(join(big, 'certification-notes.txt'), 'x'.repeat(6_001));
    writeFileSync(join(big, 'captions.txt'), `${'c'.repeat(201)}\nb\nc\nd\n`);
    const refused = findings(big).join('\n');
    assert.match(refused, /description\.txt is 10001 characters; the Store takes 10000/);
    assert.match(refused, /certification-notes\.txt is 6001 characters; the field takes 6000/);
    assert.match(refused, /captions\.txt line 1 is 201 characters; a caption takes 200/);

    const gone = copy();
    rmSync(join(gone, 'certification-notes.txt'));
    assert.match(findings(gone).join('\n'), /certification-notes\.txt is missing/);
});

test('pngSize reads the header and refuses what is not a PNG', () => {
    const real = readFileSync(join(DEFAULT_DIR, 'screenshots', readdirSync(join(DEFAULT_DIR, 'screenshots'))[0]));
    assert.deepEqual(pngSize(real), { width: 1366, height: 768 });
    assert.equal(pngSize(Buffer.from('GIF89a' + 'x'.repeat(40))), null);
    assert.equal(pngSize(Buffer.alloc(4)), null);
    const dir = copy();
    writeFileSync(join(dir, 'screenshots', '01-send-share.png'), 'not an image');
    assert.match(findings(dir).join('\n'), /01-send-share\.png is not a PNG/);
});

test('the command prints the fingerprints and exits 0, 1 on a defect, 2 on bad usage', () => {
    const ok = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^description: 3296 characters, djb2 5e78a360, /m);
    assert.match(ok.stdout, /^listing: matches manifest\.json \(submission 15, 2026-10-09\)$/m);

    const dir = copy();
    writeFileSync(join(dir, 'captions.txt'), 'only one\n');
    const bad = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^HARD captions\.txt is /m);
    assert.match(bad.stdout, /^listing: \d+ hard$/m);

    const usage = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
});
