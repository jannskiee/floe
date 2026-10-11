#!/usr/bin/env node
/**
 * Rendered audit of the docs: what Mintlify does to a page that no check of
 * the source can see. It loads every page in the navigation from a preview or
 * from production and measures:
 *
 *   tables     rendered tables against the tables in the source (a table whose
 *              delimiter row is wrong renders as a paragraph of raw pipes), and
 *              tables wider than the box they sit in (the theme's cell floor
 *              cuts a wide table with no scrollbar shown)
 *   quotes     curly quotation marks that point the wrong way (the smart-quote
 *              pass guesses direction from the neighboring character)
 *   chips      inline code broken across two lines, and how many of those are
 *              a single token (a flag or a variable name split mid-word)
 *   toc        visible entries in the right-hand table of contents
 *   contrast   small accent-colored text against its background
 *   width      a page wider than the viewport (sideways scroll on a phone)
 *
 * Usage:
 *   node render-audit.mjs --base <url> [--root <repo>] [--out <file.json>]
 *        [--engines chromium,firefox,webkit] [--widths 1280,390]
 *        [--themes light,dark] [--pages a,b,c] [--jobs 4] [--css <file>]
 *
 * --base is the docs root: https://www.floe.one/docs for production, or the
 * preview origin from the PR's deployment status (previews serve at the root).
 * Playwright is taken from client/node_modules, so run `pnpm install` there
 * first. Read-only: it loads pages and never writes to the site.
 * Exit 1 when a table is missing or a delimiter row shows as text; every other
 * number is for the reader to judge against the last run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
};
const here = dirname(fileURLToPath(import.meta.url));
let root = opt('root', null);
if (!root) {
    // Default: the repo this script lives in (.claude/skills/docs-verify/scripts).
    root = resolve(here, '..', '..', '..', '..');
}
const base = (opt('base', '') || '').replace(/\/+$/, '');
if (!base || !existsSync(join(root, 'docs', 'docs.json'))) {
    console.error('usage: node render-audit.mjs --base <docs root url> [--root <repo>] [--out file.json] [--engines ...] [--widths ...] [--themes ...] [--pages ...] [--jobs n] [--css file]');
    process.exit(2);
}
const engines = opt('engines', 'chromium').split(',');
const widths = opt('widths', '1280,390').split(',').map(Number);
const themes = opt('themes', 'light,dark').split(',');
const jobs = Number(opt('jobs', '4'));
const outFile = opt('out', null);
// A stylesheet to add to every page before measuring: how a candidate
// docs/style.css rule is tried against production without a deploy.
const cssFile = opt('css', null);
const extraCss = cssFile ? readFileSync(cssFile, 'utf8') : null;

const require = createRequire(pathToFileURL(join(root, 'client', 'package.json')));
let pw;
try {
    pw = require('@playwright/test');
} catch {
    console.error(
        `render-audit: no Playwright under ${join(root, 'client', 'node_modules')}. Run the client install there first, or pass --root <a checkout that has it>.`
    );
    process.exit(2);
}

// ---------------------------------------------------------------------------
// Source side: the pages in the navigation and how many tables each one holds.
// ---------------------------------------------------------------------------

const docsDir = join(root, 'docs');
// A byte order mark and CRLF are normalized on read, as in docs-check.mjs.
const read = (f) => {
    const text = readFileSync(f, 'utf8');
    return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n');
};

function navPages(node, inPages = false, out = []) {
    if (typeof node === 'string') {
        if (inPages) out.push(node);
    } else if (Array.isArray(node)) node.forEach((n) => navPages(n, inPages, out));
    else if (node && typeof node === 'object')
        for (const [k, v] of Object.entries(node)) navPages(v, k === 'pages', out);
    return out;
}

function blank(mdx) {
    let inFence = false;
    return mdx
        .split('\n')
        .map((l) => {
            if (/^\s*```/.test(l)) {
                inFence = !inFence;
                return '';
            }
            return inFence ? '' : l;
        })
        .join('\n')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ''));
}

function tablesInSource(mdx) {
    const lines = blank(mdx).split('\n');
    let n = 0;
    for (let i = 1; i < lines.length; i++) {
        const d = lines[i].trim();
        if (d.includes('|') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(d) && lines[i - 1].includes('|')) n++;
    }
    return n;
}

function expectedTables(page) {
    const text = read(join(docsDir, `${page}.mdx`));
    let n = tablesInSource(text);
    for (const m of blank(text).matchAll(/^import\s+([A-Za-z_]\w*)\s+from\s+['"](\/[^'"]+)['"]/gm)) {
        const file = join(docsDir, m[2].slice(1));
        if (!existsSync(file)) continue;
        const uses = (blank(text).match(new RegExp(`<${m[1]}[\\s/>]`, 'g')) || []).length;
        n += uses * tablesInSource(read(file));
    }
    return n;
}

const docsJson = JSON.parse(read(join(docsDir, 'docs.json')));
const allPages = [...new Set(navPages(docsJson.navigation))];
const pages = opt('pages', null) ? opt('pages').split(',') : allPages;

// ---------------------------------------------------------------------------
// Page side: one function, evaluated in the page, per theme.
// ---------------------------------------------------------------------------

function measure() {
    const area = document.querySelector('#content-area') || document.body;
    const inCode = (el) => !!el.closest('pre, code');

    // Tables.
    const tables = [...area.querySelectorAll('table')].map((t) => {
        const box = t.closest('[data-component-part="scroll-area-viewport"]') || t.parentElement;
        const rowHeights = [...t.querySelectorAll('tbody tr')].map((r) => r.offsetHeight);
        return {
            cols: t.querySelectorAll('thead th').length,
            cut: Math.max(0, box.scrollWidth - box.clientWidth),
            height: t.offsetHeight,
            tallestRow: rowHeights.length ? Math.max(...rowHeights) : 0,
        };
    });
    const pipeText = [...area.querySelectorAll('p, li, td')]
        .filter((el) => !inCode(el) && /\|\s*:?-{3,}:?\s*\|/.test(el.textContent))
        .map((el) => el.textContent.slice(0, 80));

    // Quotation marks. A closing mark cannot follow a space or open a block;
    // an opening mark cannot end one or follow a letter, a colon or a bracket.
    // The article's rendered text, one block or table cell at a time: innerText
    // puts a newline between blocks and a tab between cells.
    const quotes = { total: 0, wrong: [] };
    for (const text of (area.innerText || '').split(/[\n\t]/)) {
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c !== '“' && c !== '”') continue;
            quotes.total++;
            const prev = i ? text[i - 1] : '';
            const next = text[i + 1] ?? '';
            const bad =
                c === '”'
                    ? prev === '' || /[\s(\[{]/.test(prev)
                    : next === '' || /\s/.test(next) || /[A-Za-z0-9:;,.!?)\]]/.test(prev);
            if (bad && quotes.wrong.length < 400)
                quotes.wrong.push(text.slice(Math.max(0, i - 22), i + 24).replace(/\s+/g, ' '));
        }
    }

    // Inline code chips broken across lines.
    const chips = { total: 0, split: 0, splitTokens: [], splitFlags: [] };
    for (const c of area.querySelectorAll('code')) {
        if (c.closest('pre')) continue;
        chips.total++;
        // Inline code breaks into one box per line. A chip made unbreakable
        // (inline-block) has one box however it wraps inside, so that case
        // is read from its height instead.
        const twoLines = c.offsetHeight > parseFloat(getComputedStyle(c).fontSize) * 2.2;
        if (c.getClientRects().length < 2 && !twoLines) continue;
        chips.split++;
        const text = c.textContent.trim();
        if (!/\s/.test(text) && chips.splitTokens.length < 200) chips.splitTokens.push(text.slice(0, 60));
        // A command-line flag broken at its hyphens reads as two things.
        if (/(^|\s)--?[a-z]/.test(text) && chips.splitFlags.length < 200) chips.splitFlags.push(text.slice(0, 60));
    }

    // Table of contents.
    const tocItems = [...document.querySelectorAll('#table-of-contents .toc-item')];
    const toc = {
        entries: tocItems.length,
        visible: tocItems.filter((li) => li.offsetParent !== null && li.getClientRects().length).length,
    };

    // Small accent-colored text against what is behind it.
    const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const bgOf = (el) => {
        for (let e = el; e; e = e.parentElement) {
            const c = parse(getComputedStyle(e).backgroundColor);
            if (c.length >= 3 && (c.length === 3 || c[3] > 0.95)) return c.slice(0, 3);
        }
        return document.documentElement.classList.contains('dark') ? [9, 9, 11] : [255, 255, 255];
    };
    const ratio = (el) => {
        if (!el) return null;
        const fg = parse(getComputedStyle(el).color).slice(0, 3);
        const bg = bgOf(el);
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return { ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, color: `rgb(${fg.join(',')})`, on: `rgb(${bg.join(',')})` };
    };
    const contrast = {
        eyebrow: ratio(document.querySelector('#header .eyebrow')),
        fieldName: ratio(area.querySelector('[data-component-part="field-name"]')),
        codeTab: ratio(area.querySelector('[role="tablist"] [role="tab"][aria-selected="true"] > div')),
    };

    return {
        h1: document.querySelector('#page-title')?.textContent ?? null,
        tables,
        pipeText,
        quotes,
        chips,
        toc,
        contrast,
        articleHeight: (document.querySelector('#content') || area).scrollHeight,
        docWidth: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
    };
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const results = [];
let hard = 0;

for (const engineName of engines) {
    const browser = await pw[engineName].launch();
    for (const width of widths) {
        const queue = [...pages];
        async function worker() {
            const ctx = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await ctx.newPage();
            for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
                const url = `${base}/${p}`;
                let status = 0;
                try {
                    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
                    status = resp ? resp.status() : 0;
                } catch (e) {
                    results.push({ engine: engineName, width, page: p, error: String(e.message).split('\n')[0] });
                    continue;
                }
                if (extraCss) await page.addStyleTag({ content: extraCss });
                for (const theme of themes) {
                    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
                    await page.waitForTimeout(150);
                    const m = await page.evaluate(measure);
                    results.push({ engine: engineName, width, theme, page: p, status, expectedTables: expectedTables(p), ...m });
                }
            }
            await ctx.close();
        }
        await Promise.all(Array.from({ length: jobs }, worker));
    }
    await browser.close();
}

const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
for (const engineName of engines)
    for (const width of widths)
        for (const theme of themes) {
            const rows = results.filter((r) => r.engine === engineName && r.width === width && r.theme === theme);
            if (!rows.length) continue;
            const missing = rows.filter((r) => r.tables.length !== r.expectedTables);
            const pipes = rows.filter((r) => r.pipeText.length);
            const cut = rows.flatMap((r) => r.tables.filter((t) => t.cut > 1).map((t) => `${r.page} (${t.cols} columns, ${t.cut}px)`));
            const wide = rows.filter((r) => r.docWidth > r.viewport + 1);
            const not200 = rows.filter((r) => r.status !== 200);
            hard += missing.length + pipes.length + not200.length;
            console.log(`\n== ${engineName} ${width} ${theme}: ${rows.length} pages ==`);
            console.log(`  status not 200: ${not200.length}${not200.length ? '  ' + not200.map((r) => `${r.page}=${r.status}`).join(' ') : ''}`);
            console.log(`  tables: ${sum(rows, (r) => r.tables.length)} rendered, ${sum(rows, (r) => r.expectedTables)} in the source; pages that differ: ${missing.length}${missing.length ? '  ' + missing.map((r) => `${r.page} ${r.tables.length}/${r.expectedTables}`).join(' ') : ''}`);
            console.log(`  delimiter rows shown as text: ${pipes.length} page(s)${pipes.length ? '  ' + pipes.map((r) => r.page).join(' ') : ''}`);
            console.log(`  tables wider than their box: ${cut.length}${cut.length ? '\n    ' + cut.join('\n    ') : ''}`);
            console.log(`  quotation marks: ${sum(rows, (r) => r.quotes.total)}, wrong way: ${sum(rows, (r) => r.quotes.wrong.length)}`);
            console.log(`  inline code: ${sum(rows, (r) => r.chips.total)}, split across lines: ${sum(rows, (r) => r.chips.split)}, of those a single token: ${sum(rows, (r) => r.chips.splitTokens.length)}, naming a flag: ${sum(rows, (r) => r.chips.splitFlags.length)}`);
            console.log(`  pages wider than the viewport: ${wide.length}${wide.length ? '  ' + wide.map((r) => `${r.page} ${r.docWidth}`).join(' ') : ''}`);
            const tocBig = rows.filter((r) => r.toc.visible > 30).map((r) => `${r.page} ${r.toc.visible}`);
            console.log(`  contents lists over 30 visible entries: ${tocBig.length ? tocBig.join(', ') : 'none'}`);
            const worst = (key) => {
                const v = rows.map((r) => r.contrast[key]).filter(Boolean);
                if (!v.length) return 'not on these pages';
                const w = v.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
                return `${w.ratio}:1 (${w.color} on ${w.on}), ${v.length} page(s)`;
            };
            console.log(`  contrast, lowest: page label ${worst('eyebrow')}; field name ${worst('fieldName')}; selected code tab ${worst('codeTab')}`);
        }
const errors = results.filter((r) => r.error);
if (errors.length) {
    hard += errors.length;
    console.log(`\n${errors.length} page load(s) failed: ${errors.map((r) => `${r.page} (${r.error})`).join('; ')}`);
}
if (outFile) writeFileSync(outFile, JSON.stringify({ base, engines, widths, themes, pages: pages.length, results }, null, 1));
console.log(`\nrender-audit: ${pages.length} pages, ${hard} hard`);
process.exit(hard ? 1 : 0);
