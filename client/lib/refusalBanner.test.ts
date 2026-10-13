import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFUSAL_BANNER, afterReconnect, withRefusalBanner, withoutRefusalBanner } from './refusalBanner';

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
        expect(page).toContain("import {afterReconnect, withRefusalBanner, withoutRefusalBanner} from '@/lib/refusalBanner';");
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
