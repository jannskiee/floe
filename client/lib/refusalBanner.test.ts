import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFUSAL_BANNER, withRefusalBanner, withoutRefusalBanner } from './refusalBanner';

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
        expect(page).toMatch(/import \{withRefusalBanner, withoutRefusalBanner\} from '@\/lib\/refusalBanner';/);
        expect(page).toMatch(/^\s+setError\(withRefusalBanner\);$/m);
        expect(page).not.toContain("'Too many refreshes");
    });

    // A retry that the server admits has already carried the page's join: the
    // socket buffers it while it is not connected and sends it before
    // 'connect' fires. A join from this callback would be a second one, and a
    // seated socket that joins again leaves its seat first (lib/rejoinRetry.ts).
    it('P2PTransfer does nothing on connect but take the banner down', () => {
        const page = read('../components/P2PTransfer.tsx');
        expect(page).toMatch(/^\s+onConnect: \(\) => setError\(withoutRefusalBanner\),$/m);
    });
});
