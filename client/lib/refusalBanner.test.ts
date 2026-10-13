import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    LINK_INVALID,
    REFUSAL_BANNER,
    afterReconnect,
    isLinkInvalid,
    peerBanner,
    withRefusalBanner,
    withoutRefusalBanner,
} from './refusalBanner';

describe('the refusal banner', () => {
    // The docs quote it as a heading and the transfer audit matches it.
    it('keeps the words the page has always shown', () => {
        expect(REFUSAL_BANNER).toBe('Too many refreshes. Reconnecting');
    });

    it('goes up over an empty banner and over any other message', () => {
        expect(withRefusalBanner('')).toBe(REFUSAL_BANNER);
        expect(withRefusalBanner('Connection lost. The other device may have closed the tab.')).toBe(REFUSAL_BANNER);
        expect(withRefusalBanner(REFUSAL_BANNER)).toBe(REFUSAL_BANNER);
    });

    // An incomplete link sets this value before the page ever connects, and
    // the card is drawn only while the banner state holds it. Writing over it
    // left "Access Denied" on screen with nothing to explain it.
    it('never replaces the value the Link Invalid card is drawn from', () => {
        expect(withRefusalBanner('Link Expired or Busy')).toBe('Link Expired or Busy');
    });

    it('comes down when the retry connects', () => {
        expect(withoutRefusalBanner(REFUSAL_BANNER)).toBe('');
    });

    it('takes no other message down with it', () => {
        for (const other of [
            '',
            'Link Expired or Busy',
            'This link stopped working. Reload the page, add the files again, and share the new link.',
            'The connection closed before the transfer finished.',
            `${REFUSAL_BANNER}.`,
        ]) {
            expect(withoutRefusalBanner(other)).toBe(other);
        }
    });
});

// What a reconnect does to whatever the banner state holds. The handler used
// to clear it outright, and for a page on an incomplete link that state IS the
// page: the Link Invalid card is drawn from it, and that page never joined a
// room, so nothing was coming to replace it. After any blip the card was gone
// and the page read "Secure room joined" over a room it was never in.
describe('the banner after a reconnect', () => {
    it('keeps the Link Invalid card when the page has no room to go back to', () => {
        expect(afterReconnect('Link Expired or Busy', false)).toBe('Link Expired or Busy');
    });

    // A receiver whose join was refused holds the same value and a room. Its
    // reconnect is a new attempt at that room, and the card must not sit over it.
    it('clears it when the page is about to join its room again', () => {
        expect(afterReconnect('Link Expired or Busy', true)).toBe('');
    });

    it('clears every other message, as it always has', () => {
        for (const rejoining of [true, false]) {
            expect(afterReconnect(REFUSAL_BANNER, rejoining)).toBe('');
            expect(afterReconnect('Connection lost. The other device may have closed the tab.', rejoining)).toBe('');
            expect(afterReconnect('', rejoining)).toBe('');
        }
    });
});

// Neither file can be mounted here (vitest runs in node, with no DOM), so the
// wiring is read as text, as sentryIntegrations.test.ts reads the Sentry
// configs. client/e2e/refused-connect.spec.ts drives the real thing.
describe('how the banner is wired', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

    it('useSignaling tells the component each time the socket connects', () => {
        const hook = read('../hooks/useSignaling.ts');
        expect(hook).toMatch(/^\s+onConnect: \(\) => void;$/m);
        expect(hook).toMatch(/socket\.on\('connect', \(\) => \{[^}]*cbRef\.current\.onConnect\(\);[^}]*\}\);/);
    });

    it('P2PTransfer sets and clears it through these two functions only', () => {
        const page = read('../components/P2PTransfer.tsx');
        expect(page).toContain("import {LINK_INVALID, afterReconnect, isLinkInvalid, peerBanner, withRefusalBanner, withoutRefusalBanner} from '@/lib/refusalBanner';");
        expect(page).toMatch(/^\s+setError\(withRefusalBanner\);$/m);
        expect(page).not.toContain("'Too many refreshes");
    });

    // A retry that the server admits has already carried the page's join: the
    // socket buffers it while it is not connected and sends it before
    // 'connect' fires. A join from this callback would be a second one, and a
    // seated socket that joins again leaves its seat first (lib/rejoinRetry.ts).
    it('P2PTransfer hands a reconnect the banner and whether it has a room', () => {
        const page = read('../components/P2PTransfer.tsx');
        expect(page).toContain('setError((prev) => afterReconnect(prev, joinedRoomRef.current !== null));');
    });

    it('P2PTransfer does nothing on connect but take the banner down', () => {
        const page = read('../components/P2PTransfer.tsx');
        expect(page).toMatch(/^\s+onConnect: \(\) => setError\(withoutRefusalBanner\),$/m);
    });
});

// The Link Invalid card is drawn from one value of the banner state. Every
// site used to ask whether the state CONTAINED the words "Link Expired", and
// other peers' words reach that state: a refusal reason is the whole banner,
// and a version string or a file name sits inside one. So the other peer
// could switch a page to the card, on a link that was perfectly good.
describe('the Link Invalid card answers to one value only', () => {
    it('is that value and nothing that merely contains it', () => {
        expect(LINK_INVALID).toBe('Link Expired or Busy');
        expect(isLinkInvalid(LINK_INVALID)).toBe(true);
        for (const other of [
            '',
            'Link Expired',
            'Link Expired or Busy.',
            ' Link Expired or Busy',
            'link expired or busy',
            'The sender stopped: Link Expired or Busy',
            'Incomplete file "Link Expired or Busy": received 1 of 2 bytes',
            'The sender is running Floe Link Expired or Busy, which is too old for this page.',
        ]) {
            expect(isLinkInvalid(other)).toBe(false);
        }
    });

    it('lets the refusal banner go up over a message that only mentions the words', () => {
        expect(withRefusalBanner('Incomplete file "Link Expired": received 1 of 2 bytes')).toBe(REFUSAL_BANNER);
        expect(withRefusalBanner(LINK_INVALID)).toBe(LINK_INVALID);
    });

    it('clears such a message on a reconnect, like every other message', () => {
        expect(afterReconnect('Incomplete file "Link Expired": received 1 of 2 bytes', false)).toBe('');
        expect(afterReconnect(LINK_INVALID, false)).toBe(LINK_INVALID);
    });

    // The two places a peer's reason becomes the whole banner
    // (lib/transfer/receiver.ts and compatErrorFromIncompatible in protocol.ts
    // hand it over cleaned, capped and otherwise as sent).
    it('never lets a peer message be the card value itself', () => {
        expect(peerBanner(LINK_INVALID, 'The sender stopped the transfer.')).toBe('The sender stopped the transfer.');
        expect(peerBanner(LINK_INVALID, 'The other side rejected the transfer.')).toBe(
            'The other side rejected the transfer.'
        );
        for (const text of ['receiver ran out of disk space', 'Link Expired', '', 'x'.repeat(300)]) {
            expect(peerBanner(text, 'fallback')).toBe(text);
        }
    });

    it('P2PTransfer asks through isLinkInvalid at every site and never by substring', () => {
        const page = readFileSync(fileURLToPath(new URL('../components/P2PTransfer.tsx', import.meta.url)), 'utf8');
        expect(page).not.toContain("includes('Link Expired')");
        expect(page).not.toContain("'Link Expired or Busy'");
        expect(page.match(/isLinkInvalid\(/g)).toHaveLength(4);
        expect(page.match(/setError\(LINK_INVALID\);/g)).toHaveLength(2);
        // By identifier, so a new site cannot bring the substring back under
        // another spelling: the constant is imported and written twice and
        // compared nowhere by hand, and the banner state is never searched.
        expect(page.match(/\bLINK_INVALID\b/g)).toHaveLength(3);
        expect(page).not.toMatch(/\b(?:error|prev)\.(?:includes|startsWith|endsWith|indexOf|search|match)\(/);
        // Both sinks of a peer's own words go through peerBanner.
        expect(page).toContain("setError(peerBanner(msg, 'The sender stopped the transfer.'));");
        expect(page).toContain("setError(peerBanner(msg, 'The other side rejected the transfer.'));");
        expect(page).not.toMatch(/^\s+setError\(msg\);$/m);
    });

    // The card is an error, and it wore a shield with a check mark in a red
    // circle: the mark for "this is safe" on the one card that says the link
    // cannot be used. It names what is wrong instead, the link.
    it('the card wears a broken link, not a shield with a check mark', () => {
        const page = readFileSync(fileURLToPath(new URL('../components/P2PTransfer.tsx', import.meta.url)), 'utf8');
        expect(page).toContain('<Link2Off className="h-8 w-8 text-red-500" />');
        expect(page).not.toContain('ShieldCheck');
    });
});
