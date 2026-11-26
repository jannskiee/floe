import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newestFileScroll } from './fileListScroll';

// The receiving page scrolls its list to the bottom each time a file lands
// (components/P2PTransfer.tsx). A behavior passed to scrollTo outranks the
// list's CSS, so that value is the one place the page can honor a system
// that asks for reduced motion, as its own scrolling does since #858.
describe('the scroll to the newest received file', () => {
    it('is smooth, and at once when the system asks for reduced motion', () => {
        expect(newestFileScroll(false)).toBe('smooth');
        expect(newestFileScroll(true)).toBe('auto');
    });
});

// The page cannot be mounted here (vitest runs in node, with no DOM), so its
// wiring is read as text, as refusalBanner.test.ts reads it.
describe('how P2PTransfer scrolls the received list', () => {
    const page = readFileSync(fileURLToPath(new URL('../components/P2PTransfer.tsx', import.meta.url)), 'utf8');

    it('asks about reduced motion each time it scrolls, and still scrolls', () => {
        const start = page.indexOf('const timer = setTimeout(() => {');
        expect(start).toBeGreaterThan(-1);
        const timer = page.slice(start, page.indexOf('}, 100);', start)).replace(/\s+/g, ' ');
        expect(timer).toBe(
            'const timer = setTimeout(() => { const container = fileListRef.current; ' +
                'if (container && !isSender) { container.scrollTo({ top: container.scrollHeight, ' +
                "behavior: newestFileScroll(window.matchMedia('(prefers-reduced-motion: reduce)').matches), }); } "
        );
    });

    it('takes the answer from lib/fileListScroll', () => {
        const imported = /^import \{\s*newestFileScroll\s*\} from '@\/lib\/fileListScroll';\r?$/m.test(page);
        expect(imported, 'P2PTransfer imports newestFileScroll from lib/fileListScroll').toBe(true);
    });

    it('passes no fixed smooth behavior to any scroll', () => {
        expect(page.match(/behavior:\s*['"]smooth['"]/g) ?? []).toEqual([]);
    });
});
