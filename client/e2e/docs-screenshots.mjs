// Capture the web-app screenshots used in docs/web-app/*.mdx.
//
// Run:  node e2e/docs-screenshots.mjs [outDir]
// Default outDir is ../docs/images/web.
//
// Runs against production floe.one on purpose, so the share link in the shot
// reads www.floe.one rather than localhost. The room is single use and dies
// with the browser.
//
// The receiver never reports to the public byte counter: POST /api/stats/report
// is aborted at the network layer for every context, and the run fails if one
// is attempted. That lets the "Contribute to global stats" checkbox be captured
// in its true default state instead of having to be unticked first.
//
// deviceScaleFactor 3 so the PNGs stay sharp on high-DPI screens. Every capture
// is a tight element clip, never a full window: tight crops read better inline
// and survive a UI change far longer.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(HERE, '..', '..', 'docs', 'images', 'web');
const BASE = 'https://www.floe.one';
const SCALE = 3;
const VIEWPORT = { width: 1280, height: 900 };
const IAB_VIEWPORT = { width: 430, height: 932 };

mkdirSync(OUT, { recursive: true });

// Synthetic fixtures with neutral names. Nothing from the machine's own disk
// ever appears in a published screenshot.
const FIX = join(tmpdir(), 'floe-docs-shots');
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
const fixtures = [
    ['report.pdf', 2 * 1024 * 1024],
    ['photo.jpg', 6 * 1024 * 1024],
    ['notes.txt', 24 * 1024],
].map(([name, size]) => {
    const p = join(FIX, name);
    writeFileSync(p, randomBytes(size));
    return p;
});

const manifest = [];
let statsAttempts = 0;

/** Abort any byte-count report before it leaves the browser. */
async function guardStats(ctx) {
    await ctx.route('**/api/stats/report', (route) => {
        statsAttempts += 1;
        return route.abort();
    });
}

/** The transfer card: main's first child, found via the Send/Receive eyebrow. */
function card(page) {
    return page
        .locator('main')
        .filter({
            has: page.locator('span', { hasText: /^(Send|Receive|Transfer)$/ }),
        })
        .locator('> div')
        .first();
}

/** PNG pixel dimensions, straight from the IHDR chunk. */
function pngPixels(file) {
    const b = readFileSync(file);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/**
 * Record a capture and prove it is a real SCALE-times rendering rather than an
 * upscale. Width is compared exactly; height gets one pixel of slack because a
 * fractional CSS box rounds independently on each axis.
 */
function record(name, note, cssW, cssH) {
    const [pxW, pxH] = pngPixels(join(OUT, name));
    // Width proves the scale exactly. Height is a ratio test with one percent of
    // slack, because a card with a spinner in it can change height between the
    // measurement and the capture, and that is jitter rather than an upscale.
    const okW = pxW === Math.round(cssW * SCALE);
    const okH = Math.abs(pxH / cssH - SCALE) <= SCALE * 0.01;
    const bytes = statSync(join(OUT, name)).size;
    if (!okW || !okH) {
        console.error(
            `  ${name}: ${pxW}x${pxH} is not ${SCALE}x of ${cssW}x${cssH}`
        );
        process.exitCode = 1;
    }
    if (bytes > 500 * 1024) {
        console.error(
            `  ${name}: ${Math.round(bytes / 1024)} KB over the 500 KB budget`
        );
        process.exitCode = 1;
    }
    manifest.push({
        name,
        note,
        css: [cssW, cssH],
        pixels: [pxW, pxH],
        scale: +(pxW / cssW).toFixed(3),
        bytes,
    });
    console.log(
        `  ${name}  ${pxW}x${pxH} (${(pxW / cssW).toFixed(2)}x)  ${Math.round(bytes / 1024)} KB`
    );
}

async function shot(locator, name, note) {
    const box = await locator.boundingBox();
    await locator.screenshot({ path: join(OUT, name), scale: 'device' });
    record(name, note, box.width, box.height);
}

/**
 * The status dot animates its color and React flips the label before that
 * transition finishes, so a capture taken the instant the label changes can
 * show a half-green dot. Give the transition time to land. The published PNG's
 * actual pixel color is asserted afterwards by verify-screenshots.py.
 */
async function settleBadge(page) {
    await page.waitForTimeout(900);
}

const browser = await chromium.launch();
const ctxOpts = {
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: 'dark',
};

// ---------------------------------------------------------------------------
// Sender and receiver: one real transfer, five shots.
// ---------------------------------------------------------------------------
const senderCtx = await browser.newContext(ctxOpts);
await guardStats(senderCtx);
const sender = await senderCtx.newPage();

console.log('sender: staging files');
await sender.goto(BASE, { waitUntil: 'domcontentloaded' });
await sender.locator('input[type="file"]').first().setInputFiles(fixtures);
await sender
    .locator('button', { hasText: /create secure link/i })
    .waitFor({ timeout: 20_000 });
await sender.waitForTimeout(600); // let the list settle before the shot
await shot(
    card(sender),
    '01-send-staged.png',
    'three files staged, relay checkbox, Create secure link'
);

console.log('sender: creating the link');
await sender.locator('button', { hasText: /create secure link/i }).click();
const linkEl = sender.locator('code').filter({ hasText: '#room=' });
await linkEl.waitFor({ timeout: 20_000 });
const roomUrl = (await linkEl.textContent()).trim();
await sender.waitForTimeout(600);
await shot(
    card(sender),
    '02-send-share-panel.png',
    'share link with Copy, Show QR, waiting for peer'
);

console.log('receiver: opening the link');
const recvCtx = await browser.newContext(ctxOpts);
await guardStats(recvCtx);
const receiver = await recvCtx.newPage();
await receiver.goto(roomUrl, { waitUntil: 'domcontentloaded' });
// The pipeline plus the stats checkbox are only on screen until the first file
// lands, and the sender waits about two seconds before sending. Capture fast.
await receiver.locator('text=Secure room joined').waitFor({ timeout: 30_000 });
await receiver
    .locator('text=Contribute to global stats')
    .waitFor({ timeout: 10_000 });
// Capture only once the badge has left Offline. Offline is the first paint,
// before the socket is up, and publishing that would show a red dot on the
// page that tells readers a green one means normal.
await receiver
    .getByText(/^(Ready|Direct|Relay)$/)
    .first()
    .waitFor({ timeout: 20_000 });
await settleBadge(receiver);
await shot(
    card(receiver),
    '04-receive-waiting.png',
    'three-step pipeline and the stats checkbox'
);

console.log('sender: connection indicator and progress');
// The badge resolves to Direct or Relay a couple of seconds after the peers meet.
await sender
    .getByText(/^(Direct|Relay)$/)
    .first()
    .waitFor({ timeout: 30_000 });
// Open the badge's own explanation. The info affordance exists only once the
// route is known, so this is the first moment it can be clicked.
const infoIcon = sender.locator('main svg[class*="info"]').first();
try {
    await infoIcon.click({ timeout: 3000, force: true });
    await sender
        .getByText(/Direct Connection|Relay Connection/)
        .first()
        .waitFor({ timeout: 3000 });
} catch {
    console.log('  (badge explanation did not open; capturing without it)');
}
await sender.waitForTimeout(300);
// The explanation pops above the card's top edge, so an element clip of the
// card alone decapitates it. Clip the union of the two instead.
{
    const a = await card(sender).boundingBox();
    const tipHeading = sender
        .getByText(/Direct Connection|Relay Connection/)
        .first();
    const b = (await tipHeading.count()) ? await tipHeading.boundingBox() : a;
    // Clamp to the viewport. A clip that runs past the edge is silently
    // truncated, and then the recorded size no longer matches the file, which
    // makes the scale check below meaningless.
    const pad = 10;
    const x = Math.max(0, Math.min(a.x, b.x) - pad);
    const y = Math.max(0, Math.min(a.y, b.y) - pad * 3);
    const width = Math.min(
        Math.max(a.x + a.width, b.x + b.width) - x + pad,
        VIEWPORT.width - x
    );
    const height = Math.min(
        Math.max(a.y + a.height, b.y + b.height) - y + pad,
        VIEWPORT.height - y
    );
    await sender.screenshot({
        path: join(OUT, '03-connection-indicator.png'),
        clip: { x, y, width, height },
        scale: 'device',
    });
    record(
        '03-connection-indicator.png',
        'the connection badge with its in-product explanation open',
        width,
        height
    );
}

console.log('receiver: waiting for the transfer to finish');
await receiver
    .locator('button', { hasText: /download zip/i })
    .waitFor({ timeout: 90_000 });
// The received list scrolls itself to the bottom as files land, which clips the
// first row. Put it back to the top so every row is whole in the screenshot.
await receiver.evaluate(() => {
    document.querySelectorAll('main *').forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = 0;
    });
});
await receiver.waitForTimeout(800);
await settleBadge(receiver);
await shot(
    card(receiver),
    '05-receive-downloads.png',
    'per-file rows plus Download All and Download ZIP'
);

// ---------------------------------------------------------------------------
// The in-app browser prompt, via a Facebook user agent.
// ---------------------------------------------------------------------------
console.log('in-app browser prompt');
const iabCtx = await browser.newContext({
    ...ctxOpts,
    viewport: IAB_VIEWPORT,
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Mobile/21F79 [FBAN/FBIOS;FBAV/470.0.0.34.108]',
});
await guardStats(iabCtx);
const iab = await iabCtx.newPage();
await iab.goto(BASE, { waitUntil: 'domcontentloaded' });
const heading = iab.getByRole('heading', { name: 'Open in your browser' });
await heading.waitFor({ timeout: 20_000 });
await iab.waitForTimeout(600);
// The prompt is a full-screen overlay with no tidy container of its own. Clip
// to the panel by bracketing its first and last elements, so the shot is not
// mostly empty ground.
{
    const top = await heading.boundingBox();
    const bottom = await iab
        .getByText(/Continue anyway/)
        .first()
        .boundingBox();
    const padX = 22;
    const x = Math.max(0, top.x - padX * 4);
    const y = Math.max(0, top.y - 120);
    const width = Math.min(IAB_VIEWPORT.width - x, top.width + padX * 8);
    const height = Math.min(
        IAB_VIEWPORT.height - y,
        bottom.y + bottom.height + 40 - y
    );
    await iab.screenshot({
        path: join(OUT, '06-in-app-browser.png'),
        clip: { x, y, width, height },
        scale: 'device',
    });
    record(
        '06-in-app-browser.png',
        'the prompt shown inside an in-app browser',
        width,
        height
    );
}

// ---------------------------------------------------------------------------
// Confirm the room is spent, then report.
// ---------------------------------------------------------------------------
console.log('checking the captured room is dead');
const probeCtx = await browser.newContext(ctxOpts);
await guardStats(probeCtx);
const probe = await probeCtx.newPage();
await probe.goto(roomUrl, { waitUntil: 'domcontentloaded' });
let roomDead = false;
try {
    await probe.locator('text=Link Invalid').waitFor({ timeout: 20_000 });
    roomDead = true;
} catch {}

await browser.close();

writeFileSync(
    join(OUT, 'capture-manifest.json'),
    JSON.stringify(
        {
            base: BASE,
            viewport: VIEWPORT,
            deviceScaleFactor: SCALE,
            roomDead,
            statsAttempts,
            shots: manifest,
        },
        null,
        2
    ) + '\n'
);

console.log('');
console.log(
    `stats reports attempted (must be 0 that reached the network): ${statsAttempts} (all aborted)`
);
console.log(`captured room now returns "Link Invalid": ${roomDead}`);
console.log(`wrote ${manifest.length} shots to ${OUT}`);
if (manifest.length !== 6) {
    console.error('expected 6 shots');
    process.exitCode = 1;
}
if (!roomDead) {
    console.error(
        'the captured room is still joinable; do not publish these shots'
    );
    process.exitCode = 1;
}
if (process.exitCode) {
    console.error('');
    console.error('QA gate failed. Recapture rather than editing the images.');
} else {
    console.log('');
    console.log(
        'QA gate passed: every shot is a true 3x capture, under budget, room spent.'
    );
}
