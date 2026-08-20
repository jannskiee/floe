// Visual QA for the docs, against a local `mint dev`.
//
// Run:  node e2e/docs-visual-qa.mjs [baseUrl]        (default http://localhost:3333)
//
// Renders every page in the sidebar in both themes and checks the things that
// are easy to break and hard to notice:
//
//   * no page scrolls sideways at any width
//   * every screenshot fits its column, is not broken, is not shrunk to a
//     thumbnail, and has rounded corners
//   * nothing in the sidebar is painted in the accent colour, at rest or on
//     hover, and an icon chip is never the same colour as the glyph inside it
//
// Setting the theme is the part that is easy to get wrong. Three approaches
// look right and are not:
//
//   * flipping `data-theme` in the page leaves Mintlify's painted surfaces
//     stale, which reports an accent colour that is not really there
//   * Playwright's `colorScheme` emulation does nothing, because docs.json
//     pins the default appearance to dark
//   * clicking the toggle works at desktop width and silently fails on a phone,
//     where it is not rendered
//
// So the preference is seeded directly and then asserted after load. If that
// assert ever fails the run says so, rather than quietly testing dark twice.
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';

const BASE = process.argv[2] || 'http://localhost:3333';
const THEME_KEY = 'isDarkMode';
const VIEWPORTS = [
    { name: 'phone', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'laptop', width: 1280, height: 800 },
    { name: 'desktop', width: 1920, height: 1080 },
];
const ACCENT = [0, 163, 201];
const NEAR_BLACK = /rgb\(1[0-9],\s*1[0-9],\s*1[0-9]\)/;
const WHITE = /rgb\(255,\s*255,\s*255\)/;

function isAccent(v) {
    const m = (v || '').match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const got = m.slice(1, 4).map(Number);
    return ACCENT.every((c, i) => Math.abs(got[i] - c) < 40);
}

const cfg = JSON.parse(
    readFileSync(new URL('../../docs/docs.json', import.meta.url), 'utf8')
);
const collected = [];
(function walk(n) {
    if (typeof n === 'string') collected.push('/' + n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object')
        ['pages', 'groups'].forEach((k) => n[k] && walk(n[k]));
})(cfg.navigation);
const ALL = [...new Set(collected)];
const IMAGE_PAGES = ALL.filter((p) => p.startsWith('/web-app/'));

const problems = [];
const browser = await chromium.launch();

async function open(theme, viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(
        ([k, v]) => {
            try {
                localStorage.setItem(k, v);
            } catch {}
        },
        [THEME_KEY, theme]
    );
    return { ctx, page: await ctx.newPage() };
}

async function assertTheme(page, want, where) {
    const got = (await page.evaluate(() =>
        document.documentElement.classList.contains('dark')
    ))
        ? 'dark'
        : 'light';
    if (got !== want)
        problems.push(
            `${where}: asked for ${want} but the page rendered ${got}`
        );
    return got === want;
}

function measure(page) {
    return page.evaluate(() => {
        const doc = document.documentElement;
        const area = document.querySelector('#content-area') || document.body;
        const ar = area.getBoundingClientRect();
        const sidebarColors = [];
        const sb = document.querySelector('#sidebar');
        if (sb) {
            for (const el of sb.querySelectorAll('a, a *, button')) {
                const cs = getComputedStyle(el);
                sidebarColors.push(cs.color, cs.backgroundColor);
            }
        }
        return {
            overflow: doc.scrollWidth > doc.clientWidth + 1,
            content: Math.round(ar.width),
            sidebarColors: [...new Set(sidebarColors)],
            images: [...area.querySelectorAll('img')].map((img) => {
                const r = img.getBoundingClientRect();
                return {
                    src: (img.getAttribute('src') || '').split('/').pop(),
                    width: Math.round(r.width),
                    radius: getComputedStyle(img).borderTopLeftRadius,
                    wider: r.width > ar.width + 1,
                    tiny: r.width > 0 && r.width < 120,
                    broken: img.complete && img.naturalWidth === 0,
                };
            }),
        };
    });
}

// Pass 1: every page, both themes, at phone and desktop width.
for (const theme of ['dark', 'light']) {
    for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
        const { ctx, page } = await open(theme, {
            width: vp.width,
            height: vp.height,
        });
        await page.goto(BASE + '/introduction', {
            waitUntil: 'load',
            timeout: 45_000,
        });
        await assertTheme(page, theme, `pass 1 ${theme}/${vp.name}`);
        for (const path of ALL) {
            try {
                const res = await page.goto(BASE + path, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });
                if (!res || res.status() >= 400) {
                    problems.push(
                        `${theme}/${vp.name} ${path}: HTTP ${res && res.status()}`
                    );
                    continue;
                }
                await page.waitForTimeout(180);
                const r = await measure(page);
                if (r.overflow)
                    problems.push(
                        `${theme}/${vp.name} ${path}: page scrolls sideways`
                    );
                for (const c of r.sidebarColors) {
                    if (isAccent(c))
                        problems.push(
                            `${theme} ${path}: sidebar paints accent ${c}`
                        );
                }
            } catch (e) {
                problems.push(
                    `${theme}/${vp.name} ${path}: ${String(e).split('\n')[0].slice(0, 70)}`
                );
            }
        }
        await ctx.close();
        console.log(`swept ${ALL.length} pages  ${theme.padEnd(5)} ${vp.name}`);
    }
}

// Pass 2: the pages carrying screenshots, every viewport, both themes.
for (const theme of ['dark', 'light']) {
    for (const vp of VIEWPORTS) {
        const { ctx, page } = await open(theme, {
            width: vp.width,
            height: vp.height,
        });
        await page.goto(BASE + IMAGE_PAGES[0], {
            waitUntil: 'load',
            timeout: 45_000,
        });
        await assertTheme(page, theme, `pass 2 ${theme}/${vp.name}`);
        for (const path of IMAGE_PAGES) {
            await page.goto(BASE + path, {
                waitUntil: 'load',
                timeout: 30_000,
            });
            await page.waitForTimeout(350);
            const r = await measure(page);
            for (const im of r.images) {
                if (im.broken)
                    problems.push(
                        `${theme}/${vp.name} ${im.src}: failed to load`
                    );
                if (im.wider)
                    problems.push(
                        `${theme}/${vp.name} ${im.src}: wider than its column`
                    );
                if (im.tiny)
                    problems.push(
                        `${theme}/${vp.name} ${im.src}: only ${im.width}px wide`
                    );
                if (im.radius === '0px')
                    problems.push(
                        `${theme}/${vp.name} ${im.src}: square corners`
                    );
                const pct = Math.round((im.width / r.content) * 100);
                console.log(
                    `  ${theme.padEnd(5)} ${vp.name.padEnd(7)} ${im.src.padEnd(28)} ${String(im.width).padStart(4)}px  ${String(pct).padStart(3)}% of ${r.content}px  r=${im.radius}`
                );
            }
        }
        await ctx.close();
    }
}

// Pass 3: sidebar hover. The icon is a chip with a masked glyph inside it, and
// the accent lands on the CHIP, so checking only the glyph misses it entirely.
for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open(theme, { width: 1280, height: 800 });
    await page.goto(BASE + '/quickstart', { waitUntil: 'load' });
    if (!(await assertTheme(page, theme, `pass 3 ${theme}`))) {
        await ctx.close();
        continue;
    }
    const links = page.locator('#sidebar a');
    const n = Math.min(await links.count(), 14);
    for (let i = 0; i < n; i += 1) {
        const a = links.nth(i);
        await page.mouse.move(4, 4);
        await page.waitForTimeout(40);
        await a.hover({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(90);
        const s = await a.evaluate((el) => {
            const svg = el.querySelector('svg');
            const chip = svg ? svg.parentElement : null;
            return {
                text: (el.textContent || '').trim().slice(0, 24),
                color: getComputedStyle(el).color,
                glyph: svg ? getComputedStyle(svg).backgroundColor : null,
                chip: chip ? getComputedStyle(chip).backgroundColor : null,
            };
        });
        for (const [what, v] of [
            ['text', s.color],
            ['glyph', s.glyph],
            ['chip', s.chip],
        ]) {
            if (v && isAccent(v))
                problems.push(
                    `${theme} hover "${s.text}": ${what} is accent ${v}`
                );
        }
        if (s.chip && s.glyph) {
            if (WHITE.test(s.chip) && WHITE.test(s.glyph)) {
                problems.push(
                    `${theme} hover "${s.text}": white glyph on a white chip`
                );
            }
            if (NEAR_BLACK.test(s.chip) && NEAR_BLACK.test(s.glyph)) {
                problems.push(
                    `${theme} hover "${s.text}": black glyph on a black chip`
                );
            }
            const wantWhiteChip = theme === 'dark';
            if (WHITE.test(s.chip) !== wantWhiteChip) {
                problems.push(
                    `${theme} hover "${s.text}": chip is ${s.chip}, expected ${wantWhiteChip ? 'white' : 'near-black'}`
                );
            }
        }
    }
    await ctx.close();
    console.log(`checked sidebar hover  ${theme}`);
}

await browser.close();

console.log('');
if (problems.length) {
    const unique = [...new Set(problems)];
    console.log(`${unique.length} problems:`);
    unique.slice(0, 40).forEach((p) => console.log('  ' + p));
    if (unique.length > 40) console.log(`  ... and ${unique.length - 40} more`);
    process.exit(1);
}
console.log(
    'No sideways scroll, no broken or mis-sized images, no accent in the sidebar, both themes.'
);
