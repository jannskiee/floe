// Screenshot matrix: captures every page/state of the audit grid at every
// viewport, with per-capture overflow numbers, for visual review at scale.
// Run:  node e2e/screenshot-matrix.mjs <outDir>
// Needs the dev client on :3000 and the signaling server on :3001.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID, randomBytes } from 'crypto';
import { tmpdir } from 'os';

const OUT = process.argv[2] || join(process.cwd(), 'shots');
const BASE = 'http://localhost:3000';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 414, height: 896 },
    { width: 430, height: 932 },
    { width: 480, height: 854 },
    { width: 640, height: 960 },
    { width: 568, height: 320 },
    { width: 844, height: 390 },
    { width: 768, height: 1024 },
    { width: 820, height: 1180 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3440, height: 1440 },
];
const KEY = (v) => `${v.width}x${v.height}`;
const SUBSET = ['320x568', '390x844', '768x1024', '1920x1080'];

const overflowEval = () => {
    const innerWidth = window.innerWidth;
    const doc = document.documentElement;
    const body = document.body;
    const limit = innerWidth + 1;
    const offenders = [];
    if (doc.scrollWidth > limit || body.scrollWidth > limit) {
        const isInsideScroller = (el) => {
            for (let a = el.parentElement; a && a !== body; a = a.parentElement) {
                const ox = getComputedStyle(a).overflowX;
                if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
            }
            return false;
        };
        for (const el of Array.from(body.querySelectorAll('*'))) {
            const r = el.getBoundingClientRect();
            if (r.width > 1 && r.right > limit && !isInsideScroller(el)) {
                const cls = typeof el.className === 'string'
                    ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).join('.')
                    : '';
                offenders.push(`<${el.tagName.toLowerCase()}${cls ? ` class~=${cls}` : ''}> right=${Math.round(r.right)}`);
                if (offenders.length >= 8) break;
            }
        }
    }
    const pill = document.querySelector('nav > div');
    const nav = pill
        ? (() => { const r = pill.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; })()
        : null;
    return { innerWidth, doc: doc.scrollWidth, body: body.scrollWidth, offenders, nav };
};

const index = [];
async function capture(page, name, vp) {
    await page.setViewportSize(vp);
    // Force every lazy image to finish loading (short landscape viewports can
    // otherwise capture an empty AppWindow frame), then settle at the top so
    // the fixed nav lands over the hero, not mid-page content.
    await page.evaluate(async () => {
        window.scrollTo(0, document.body.scrollHeight);
        await Promise.all(
            Array.from(document.images).map((img) => {
                img.loading = 'eager';
                return img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; });
            }),
        );
        window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
    const r = await page.evaluate(overflowEval);
    const file = `${name}--${KEY(vp)}.png`;
    await page.screenshot({ path: join(OUT, file), fullPage: true });
    const navBad = r.nav && (r.nav.left < -1 || r.nav.right > r.innerWidth + 1);
    const docBad = r.doc > r.innerWidth + 1 || r.body > r.innerWidth + 1;
    index.push({ file, page: name, ...vp, ...r, flag: navBad || docBad ? 'OVERFLOW' : 'ok' });
    process.stdout.write(`${navBad || docBad ? '!! ' : '   '}${file}  doc=${r.doc}/${r.innerWidth}${r.nav ? ` nav=[${r.nav.left},${r.nav.right}]` : ''}\n`);
}

const run = async () => {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    // Home, idle (terminal hydrated = widest static state)
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.getByText('Drop files or click to browse').waitFor();
    await page.getByText('floe send vacation-photos/').waitFor();
    for (const vp of VIEWPORTS) await capture(page, 'home', vp);

    // Home, FAQ open (longest answer) at the subset
    for (const vp of VIEWPORTS.filter((v) => SUBSET.includes(KEY(v)))) {
        await page.setViewportSize(vp);
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('button', { name: /how do i use floe/i }).click();
        await page.getByText(/no accounts needed, no waiting/i).waitFor();
        await capture(page, 'home-faq', vp);
    }

    // Sender flow staged + QR open at the subset
    const fixtureDir = join(tmpdir(), 'floe-shot-matrix');
    mkdirSync(fixtureDir, { recursive: true });
    const fixture = join(fixtureDir, 'fixture-1k.bin');
    writeFileSync(fixture, randomBytes(1024));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.getByText('Drop files or click to browse').waitFor();
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await page.locator('button', { hasText: /create secure link/i }).click();
    await page.locator('code').filter({ hasText: '#room=' }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Toggle QR code' }).click();
    await page.getByText('Scan to receive files').waitFor();
    for (const vp of VIEWPORTS.filter((v) => SUBSET.includes(KEY(v)))) await capture(page, 'sender-qr', vp);

    // Receiver view at six sizes
    await page.goto(`${BASE}/#room=${randomUUID()}`, { waitUntil: 'networkidle' });
    await page.getByText('Secure room joined').waitFor({ timeout: 15_000 });
    for (const vp of VIEWPORTS.filter((v) => ['320x568', '390x844', '430x932', '768x1024', '1024x768', '1920x1080'].includes(KEY(v)))) {
        await capture(page, 'receiver', vp);
    }

    // Download page (Windows arrangement = server-rendered default in chromium)
    await page.goto(BASE + '/download', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Floe Desktop' }).waitFor();
    for (const vp of VIEWPORTS) await capture(page, 'download', vp);

    // Download, non-Windows arrangement (mac UA) at the subset
    const macCtx = await browser.newContext({
        reducedMotion: 'reduce',
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    });
    const macPage = await macCtx.newPage();
    await macPage.goto(BASE + '/download', { waitUntil: 'networkidle' });
    await macPage.getByRole('heading', { name: 'Floe Desktop' }).waitFor();
    for (const vp of VIEWPORTS.filter((v) => ['320x568', '390x844', '414x896', '430x932', '480x854', '640x960', '768x1024', '1920x1080'].includes(KEY(v)))) {
        await capture(macPage, 'download-mac', vp);
    }

    // Retina pass. Every capture above runs at deviceScaleFactor 1, which is the
    // one density where an undersized image master looks fine, so a 1x-only
    // matrix cannot see blurry screenshots at all. These shots are for judging
    // image sharpness the way most laptops and phones actually render it.
    const hiCtx = await browser.newContext({
        reducedMotion: 'reduce',
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
    });
    const hiPage = await hiCtx.newPage();
    for (const [route, name, ready] of [
        ['/', 'home-2x', () => hiPage.getByText('Drop files or click to browse').waitFor()],
        ['/download', 'download-2x', () => hiPage.getByRole('heading', { name: 'Floe Desktop' }).waitFor()],
    ]) {
        await hiPage.goto(BASE + route, { waitUntil: 'networkidle' });
        await ready();
        for (const vp of VIEWPORTS.filter((v) => SUBSET.includes(KEY(v)))) await capture(hiPage, name, vp);
    }

    writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));
    const flagged = index.filter((i) => i.flag === 'OVERFLOW');
    process.stdout.write(`\n${index.length} captures, ${flagged.length} flagged\n`);
    await browser.close();
};

run().catch((e) => { console.error(e); process.exit(1); });
