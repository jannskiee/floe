import { test, expect } from '@playwright/test';
import { createFixture } from './helpers';
import { join } from 'path';
import { tmpdir } from 'os';

// The sender seals its file set the moment "Create secure link" is clicked, but
// the link itself is not rendered until the server acknowledges the join (or a
// 3s fallback fires, whichever comes first). That gap used to render nothing at
// all: no button, no link, no spinner, on a card the user had just acted on.
//
// Blocking Socket.IO is what makes the gap deterministic. Without an ack the
// fallback governs the whole window, so the pending state is observable for a
// full three seconds instead of one loopback round trip.
const FIXTURE_DIR = join(tmpdir(), 'floe-e2e-pending');

test.describe('sender card while the link is being created', () => {
    test('shows a pending affordance until the link arrives', async ({ page }) => {
        const { path } = createFixture(FIXTURE_DIR, 1024);

        await page.route('**/socket.io/**', (route) => route.abort());
        await page.goto('/');
        await page.locator('input[type="file"]').setInputFiles(path);

        const createButton = page.locator('button', { hasText: /create secure link/i });
        await expect(createButton).toBeVisible();
        await createButton.click();

        // The regression: between the click and the link, this is the only
        // thing on the card that says anything is happening.
        const pending = page.getByText('Creating secure link...');
        await expect(pending).toBeVisible({ timeout: 2_000 });

        // ...and it is a genuine intermediate state, not a duplicate of either
        // neighbour. Both of those are gated on the same two flags.
        await expect(createButton).toBeHidden();
        await expect(page.locator('code').filter({ hasText: '#room=' })).toHaveCount(0);

        // The 3s fallback resolves it even though no ack ever arrives.
        await expect(page.locator('code').filter({ hasText: '#room=' })).toBeVisible({
            timeout: 10_000,
        });
        await expect(pending).toBeHidden();
    });

    test('never leaves the card with no button, no link and no affordance', async ({ page }) => {
        const { path } = createFixture(FIXTURE_DIR, 1024);

        await page.route('**/socket.io/**', (route) => route.abort());
        await page.goto('/');
        await page.locator('input[type="file"]').setInputFiles(path);

        // Sample the card across the whole pending window. Polling rather than a
        // MutationObserver because the dead state was a steady render, not a
        // transient one: any sample inside the window would have caught it.
        await page.locator('button', { hasText: /create secure link/i }).click();

        const deadFrames: string[] = [];
        for (let i = 0; i < 12; i++) {
            const state = await page.evaluate(() => {
                const text = document.body.innerText;
                return {
                    button: /create secure link/i.test(text),
                    link: text.includes('#room='),
                    affordance: text.includes('Creating secure link'),
                };
            });
            if (!state.button && !state.link && !state.affordance) {
                deadFrames.push(`sample ${i}: ${JSON.stringify(state)}`);
            }
            await page.waitForTimeout(250);
        }

        expect(deadFrames, `card had nothing to show at: ${deadFrames.join('; ')}`).toEqual([]);
    });
});
