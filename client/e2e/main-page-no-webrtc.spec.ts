import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { browserSenderSetup, createFixture, fixtureDir, removeFixtureDir } from './helpers';
import { forwardSocketFrames, framesFor } from './request-helpers';

// ---------------------------------------------------------------------------
// The main page in a browser with no WebRTC data channels.
//
// Tor Browser, Mullvad Browser and Firefox with media.peerconnection.enabled
// off have no RTCPeerConnection, and new SimplePeer throws there. A receiving
// page used to join its room first and then throw, so it held the seat while
// the sender waited on a peer that was never built; a sending page found out
// only once a receiver joined. Each now says so in the red banner, and a
// receiving page never joins, so the seat stays free for a browser that can
// take it.
//
// Deleting the constructor in an init script is what such a browser looks
// like from the page, the same probe as the /r page's E2E-12.
// ---------------------------------------------------------------------------

const RECEIVING =
    'This browser cannot receive files through Floe because WebRTC is missing or turned off. Open the link in a current version of Chrome, Edge, Firefox or Safari.';
const SENDING =
    'This browser cannot send files through Floe because WebRTC is missing or turned off. Use a current version of Chrome, Edge, Firefox or Safari.';

async function withoutWebRtc(page: Page): Promise<string[]> {
    await page.addInitScript(() => {
        delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
    });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    return errors;
}

test('a receiving page without WebRTC never takes its seat and says why', async ({ page }) => {
    const errors = await withoutWebRtc(page);
    const frames = await forwardSocketFrames(page);

    await page.goto(`/#room=${randomUUID()}`);

    // The socket is up and the page has run for a ping interval, so a join
    // made on load would be on the wire by now.
    await expect.poll(() => framesFor(frames.outgoing, 'ping').length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(framesFor(frames.outgoing, 'join-room')).toEqual([]);

    await expect(page.getByText(RECEIVING)).toBeVisible();
    // The banner is the whole account: no joining steps under it, and no
    // keep-open line for a tab that nothing depends on.
    await expect(page.getByText('Secure room joined')).toHaveCount(0);
    await expect(page.getByText(/closing it interrupts the download/i)).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('a sending page without WebRTC says why on load', async ({ page }) => {
    const errors = await withoutWebRtc(page);

    await page.goto('/');

    // The banner is an alert, so a screen reader says the sentence without
    // the user hunting for it, and its X is named instead of a bare
    // "button". Filter by the sentence: Next.js's route announcer is a
    // second alert on the page.
    const banner = page.getByRole('alert').filter({ hasText: SENDING });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.getByText(SENDING)).toHaveCount(0);
    expect(errors).toEqual([]);
});

const FIXTURE_DIR = fixtureDir('floe-e2e-no-webrtc');

test.afterAll(() => {
    removeFixtureDir(FIXTURE_DIR);
});

test('a sending page without WebRTC keeps its sentence when a receiver joins', async ({ page, browser }) => {
    // Its errors are not asserted: the peer it then tries to build still
    // throws there, and the sentence is what says why.
    await withoutWebRtc(page);
    const { path } = createFixture(FIXTURE_DIR, 1024);
    // Relay fallback off keeps the 2 s before the first byte (lib/relay.ts
    // relayProbeDelayMs). Chromium keeps webkitRTCPeerConnection, which
    // simple-peer falls back to, so the peer still connects here, and with
    // fallback on this 1 KB is sent before 'Peer joined' can be read.
    const link = await browserSenderSetup(page, path, { relayFallback: false });
    await expect(page.getByText(SENDING)).toBeVisible();

    const ctx = await browser.newContext();
    try {
        const receiver = await ctx.newPage();
        await receiver.goto(link);
        // The reset for a new recipient used to take the sentence down here.
        await expect(page.getByText('Peer joined. Starting transfer')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(SENDING), 'the sentence was lost when a receiver joined').toBeVisible();
    } finally {
        await ctx.close();
    }
});

// Dismiss goes away with the banner it closes. Keyboard focus went with it,
// to the page body: Enter and Space pressed nothing, and a screen reader had
// no control. Focus now moves to the control that followed the banner, the
// first one in the card's content. Only while the page body holds focus, as
// elsewhere on the page: focus held somewhere else stays there.

const dismiss = (page: Page, sentence: string) =>
    page.getByRole('alert').filter({ hasText: sentence }).getByRole('button', { name: 'Dismiss', exact: true });

/** Waits for focus to land on a control, and fails with "focus fell to the
 *  page" while the page body keeps it. */
const focusNotOnPage = (page: Page) =>
    expect
        .poll(() => page.evaluate(() => document.activeElement === document.body), {
            message: 'focus fell to the page',
            timeout: 2_000,
        })
        .toBe(false);

/** Lets the render that took the banner down run its effects before focus is
 *  read, so a test that expects no move cannot pass ahead of one. */
const settle = (page: Page) =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));

/** Whether the focused element draws its focus ring. */
const focusRingShown = (page: Page) => page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

test('Dismiss hands keyboard focus to the control that followed the banner', async ({ page }) => {
    await withoutWebRtc(page);
    const choose = page.getByLabel('Choose files to send');

    // A sending page: the drop zone's Choose files to send.
    await page.goto('/');
    await dismiss(page, SENDING).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(SENDING)).toHaveCount(0);
    await focusNotOnPage(page);
    await expect(choose, 'after Enter on Dismiss on a sending page').toBeFocused({ timeout: 2_000 });
    expect(await focusRingShown(page), 'a focus ring after Enter').toBe(true);

    // A mouse click moves focus the same way, and draws no ring.
    await page.reload();
    await dismiss(page, SENDING).click();
    await expect(page.getByText(SENDING)).toHaveCount(0);
    await focusNotOnPage(page);
    await expect(choose, 'after a click on Dismiss').toBeFocused({ timeout: 2_000 });
    expect(await focusRingShown(page), 'a focus ring after a click').toBe(false);

    // A press that leaves focus on another control leaves it there: a click
    // event with no focus change, as a Safari mouse click gives.
    await page.reload();
    const home = page.getByRole('button', { name: 'Floe home' });
    await home.focus();
    await dismiss(page, SENDING).dispatchEvent('click');
    await expect(page.getByText(SENDING)).toHaveCount(0);
    await settle(page);
    await expect(home, 'focus held on Floe home').toBeFocused({ timeout: 2_000 });

    // A receiving page: the Contribute to global stats checkbox. A page of its
    // own, since going from / to /#room= only changes the fragment.
    const receiving = await page.context().newPage();
    await withoutWebRtc(receiving);
    await receiving.goto(`/#room=${randomUUID()}`);
    await dismiss(receiving, RECEIVING).focus();
    await receiving.keyboard.press('Enter');
    await expect(receiving.getByText(RECEIVING)).toHaveCount(0);
    await focusNotOnPage(receiving);
    await expect(
        receiving.getByRole('checkbox', { name: 'Contribute to global stats' }),
        'after Enter on Dismiss on a receiving page'
    ).toBeFocused({ timeout: 2_000 });
});

test('Dismiss over a share link hands focus to Copy link, never to the badge in the card header', async ({ page, browser }) => {
    await withoutWebRtc(page);
    const { path } = createFixture(FIXTURE_DIR, 1024);
    const link = await browserSenderSetup(page, path, { relayFallback: false });

    const ctx = await browser.newContext();
    try {
        await ctx.addInitScript(() => {
            try { localStorage.setItem('floe:report-stats', 'false'); } catch { /* ignore */ }
        });
        const receiver = await ctx.newPage();
        await receiver.goto(link);
        // The peer connects here, as in the test above, so the banner stands
        // over a connected card, and the badge in the card's header holds a
        // Learn more link: the first control in <main>.
        await expect(page.getByText('All Files Sent!')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('main').getByRole('link', { name: 'Learn more' })).toBeAttached();

        await dismiss(page, SENDING).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByText(SENDING)).toHaveCount(0);
        await focusNotOnPage(page);
        await expect(page.getByRole('button', { name: 'Copy link' }), 'after Enter on Dismiss over the link').toBeFocused({ timeout: 2_000 });
    } finally {
        await ctx.close();
    }
});
