import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Malformed room-link guard.
//
// A share link always carries a valid UUID room id (the sender generates it
// with uuidv4). A hand-edited or truncated fragment can carry a malformed one.
// The client mirrors the signaling server's UUID_REGEX and rejects a bad id up
// front, showing the existing "Link Invalid" card, instead of emitting a join
// the server refuses with an 'error' event the browser does not listen for
// (which would otherwise leave the receiver waiting on the sender forever).
// ---------------------------------------------------------------------------

test('a malformed room id shows the Link Invalid card, not an endless wait', async ({
    page,
}) => {
    await page.goto('/#room=not-a-valid-uuid');

    await expect(page.getByRole('heading', { name: 'Link Invalid' })).toBeVisible();
    // The receiver handshake pipeline must never appear for a rejected link.
    await expect(page.getByText(/waiting for the sender/i)).toHaveCount(0);
});

test('a well-formed room id is not rejected and reaches the handshake pipeline', async ({
    page,
}) => {
    // Guards against over-rejection: a syntactically valid id must still join and
    // wait for a sender rather than tripping the client-side validity check.
    await page.goto('/#room=6f207790-92a6-4662-bb68-4c4059f75139');

    await expect(page.getByText('Secure room joined')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Link Invalid' })).toHaveCount(0);
});
