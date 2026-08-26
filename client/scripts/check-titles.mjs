#!/usr/bin/env node
/**
 * Asserts the page titles Next actually rendered.
 *
 * Why this reads built HTML instead of importing metadata: the tab title is
 * assembled at render time from `title.template` in app/layout.tsx and a bare
 * `title` on each page, so nothing that imports a module can see the string a
 * visitor gets. The page exports 'Download', the layout exports a template, and
 * the join happens inside Next's metadata resolver during the build. The
 * prerendered HTML is the only place the two halves have met.
 *
 * Why it exists at all: the suffix used to be hand-written on every page and it
 * drifted. /download and /how-it-works shipped "| Floe" while /privacy and
 * /terms shipped "· Floe" (U+00B7 MIDDLE DOT), and the repo had zero assertions
 * on any title, so nothing caught it.
 *
 * The COUNT matters as much as the string. /_not-found used to emit two <title>
 * elements: the root layout's, then Next's built-in fallback hoisted into <head>
 * after it. document.title is the first in tree order, so the tab read "Floe"
 * and the 404 string sat inert. A check that only compared strings would have
 * missed it, or matched the wrong one.
 *
 * Run from client/ after `next build`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = join(process.cwd(), '.next', 'server', 'app');

// The full expected set. Every prerendered route must appear here, and the
// arrays are the titles in document order, so a length of 1 is itself an
// assertion. The two Next-owned strings are pinned deliberately: if a Next
// upgrade changes them, that shows up here as a visible CI failure rather than
// as a surprise found in production months later.
const EXPECTED = {
    index: ['Floe'],
    download: ['Download - Floe'],
    'how-it-works': ['How It Works - Floe'],
    privacy: ['Privacy Policy - Floe'],
    terms: ['Terms of Use - Floe'],
    '_not-found': ['Page Not Found - Floe'],
    // Next built-in. app/global-error.tsx renders its own <html>, so the root
    // layout's metadata never reaches it and it cannot be templated.
    '_global-error': ['500: This page couldn’t load'],
};

// The suffix is " - " because the docs at /docs are a Mintlify deployment that
// renders "{page title} - {name}" and offers no way to configure the separator.
// These are the characters that have been wrongly used as one here before.
const FORBIDDEN_SEPARATORS = /[|·–—]/;

function titlesIn(html) {
    // Only <head>. Both of the /_not-found titles landed there, while an SVG
    // <title> in the body is not a document title and must not be counted.
    const head = html.split(/<\/head>/i)[0];
    return [...head.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) =>
        m[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#x27;|&#39;/g, "'")
            .trim()
    );
}

function metaContent(html, selector) {
    const re = new RegExp(`<meta[^>]*${selector}[^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    return tag?.match(/content="([^"]*)"/i)?.[1] ?? null;
}

const failures = [];
const ogTitles = new Map();

for (const [route, expected] of Object.entries(EXPECTED)) {
    const file = join(APP_DIR, `${route}.html`);
    if (!existsSync(file)) {
        failures.push(`${route}: no prerendered HTML at ${file}. Did \`next build\` run?`);
        continue;
    }
    const html = readFileSync(file, 'utf8');
    const actual = titlesIn(html);

    if (actual.length !== expected.length) {
        failures.push(
            `${route}: expected ${expected.length} <title> in <head>, found ${actual.length}` +
                ` -> ${JSON.stringify(actual)}`
        );
    }
    expected.forEach((want, i) => {
        if (actual[i] !== want) {
            failures.push(`${route}: title[${i}] expected ${JSON.stringify(want)}, got ${JSON.stringify(actual[i] ?? null)}`);
        }
    });

    // No page may hand-write the suffix, and none may reintroduce an old
    // separator. Skipped for the two Next-owned error strings.
    if (!route.startsWith('_')) {
        for (const t of actual) {
            if (FORBIDDEN_SEPARATORS.test(t)) {
                failures.push(`${route}: title contains a forbidden separator -> ${JSON.stringify(t)}`);
            }
            if (t.split(' - Floe').length - 1 > 1) {
                failures.push(`${route}: suffix appears more than once -> ${JSON.stringify(t)}`);
            }
        }
    }

    // Every route used to ship the same og:title, because no page declared one
    // and shallow metadata merging carried the root's block through untouched.
    if (route !== '_global-error' && route !== '_not-found') {
        const og = metaContent(html, 'property="og:title"');
        const tw = metaContent(html, 'name="twitter:title"');
        if (!og) {
            failures.push(`${route}: no og:title`);
        } else if (ogTitles.has(og)) {
            failures.push(`${route}: og:title duplicates ${ogTitles.get(og)} -> ${JSON.stringify(og)}`);
        } else {
            ogTitles.set(og, route);
        }
        if (og && tw !== og) {
            failures.push(`${route}: twitter:title disagrees with og:title -> ${JSON.stringify(tw)}`);
        }
        // The spread-not-replace invariant from lib/socialMetadata.ts. A page
        // that wrote `openGraph: { title }` without the spread would silently
        // drop these, and nothing else would notice.
        if (metaContent(html, 'property="og:site_name"') !== 'Floe') {
            failures.push(`${route}: og:site_name missing or not "Floe" (openGraph spread dropped?)`);
        }
        if (metaContent(html, 'property="og:type"') !== 'website') {
            failures.push(`${route}: og:type missing or not "website" (openGraph spread dropped?)`);
        }
    }
}

if (failures.length) {
    console.error('Page title check FAILED:\n');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
}

console.log(`Page title check passed: ${Object.keys(EXPECTED).length} routes.`);
for (const [route, titles] of Object.entries(EXPECTED)) {
    console.log(`  ${route.padEnd(14)} ${titles.join(' | ')}`);
}
