import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(tmpdir(), 'floe-e2e');

function createFixture(size: number): { path: string; sha256: string } {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const data = size > 0 ? randomBytes(size) : Buffer.alloc(0);
    const filePath = join(FIXTURE_DIR, `fixture-${size}.bin`);
    writeFileSync(filePath, data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    return { path: filePath, sha256 };
}

async function sha256OfBlobUrl(page: Page, blobUrl: string): Promise<string> {
    return page.evaluate(async (url) => {
        const buf = await fetch(url).then((r) => r.arrayBuffer());
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }, blobUrl);
}

async function byteLengthOfBlobUrl(page: Page, blobUrl: string): Promise<number> {
    return page.evaluate(
        async (url) => fetch(url).then((r) => r.arrayBuffer()).then((b) => b.byteLength),
        blobUrl,
    );
}

/** Load the sender page, pick a file, create the link, and return the room URL. */
async function senderSetup(
    senderPage: Page,
    fixturePath: string,
): Promise<string> {
    await senderPage.goto('/');

    // The file input is absolutely positioned (opacity:0) over the drop zone.
    // setInputFiles works on non-visible inputs.
    const fileInput = senderPage.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    // Button text contains "Create secure link" — file count varies
    await senderPage.locator('button', { hasText: /create secure link/i }).click();

    // Generated link appears in the <code> element
    const linkEl = senderPage.locator('code').filter({ hasText: '#room=' });
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    return (await linkEl.textContent())!.trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.afterAll(() => {
    try {
        rmSync(FIXTURE_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
});

test('transfers a 50 MB binary file with SHA-256 integrity check', async ({ browser }) => {
    // 50 MB exercises the real fast path: multiple 4 MB slab reads and the
    // 8 MB high-water backpressure loop (a small file would touch neither).
    const SIZE = 50 * 1024 * 1024;
    const { path: fixturePath, sha256: expectedHash } = createFixture(SIZE);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await senderSetup(senderPage, fixturePath);
        expect(link).toContain('#room=');

        await receiverPage.goto(link);

        // Measure once the receiver reports it is actively receiving, so the
        // throughput figure reflects the data path rather than connection setup.
        // .first(): the status line and the in-progress file row can both show
        // "Receiving file 1 of 1" at the same time.
        await expect(receiverPage.getByText(/Receiving file/i).first()).toBeVisible({ timeout: 30_000 });
        const transferStart = Date.now();

        // Wait for the download button to appear — file is fully in memory as a blob
        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 60_000 });
        const transferMs = Date.now() - transferStart;

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        const receivedHash = await sha256OfBlobUrl(receiverPage, blobUrl);

        expect(receivedHash).toBe(expectedHash);

        // Log throughput so before/after speed is visible in the test report
        const mbps = (SIZE / (transferMs / 1000) / 1024 / 1024).toFixed(2);
        console.log(`  Transfer: 50 MB in ${transferMs} ms (${mbps} MB/s)`);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('transfers a 0-byte empty file', async ({ browser }) => {
    const { path: fixturePath } = createFixture(0);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await senderSetup(senderPage, fixturePath);
        await receiverPage.goto(link);

        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        const byteLength = await byteLengthOfBlobUrl(receiverPage, blobUrl);
        expect(byteLength).toBe(0);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});

test('transfers a 512-byte file (framing guard: chunk fits under 1 KB threshold)', async ({ browser }) => {
    const { path: fixturePath, sha256: expectedHash } = createFixture(512);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        const link = await senderSetup(senderPage, fixturePath);
        await receiverPage.goto(link);

        const downloadLink = receiverPage.locator('a[download]').first();
        await expect(downloadLink).toBeVisible({ timeout: 30_000 });

        const blobUrl = (await downloadLink.getAttribute('href'))!;
        const receivedHash = await sha256OfBlobUrl(receiverPage, blobUrl);
        expect(receivedHash).toBe(expectedHash);
    } finally {
        await senderCtx.close();
        await receiverCtx.close();
    }
});
