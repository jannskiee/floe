import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The main page's root element, read as TEXT: client/vitest.config.ts runs in
// node, where a page cannot be mounted (next/font is an empty shim outside
// next build). The ring as drawn is measured by e2e/main-page-focus.spec.ts.
// The /r twin of this file is lib/request/requestShell.test.ts.

const PAGE = fileURLToPath(new URL('../app/page.tsx', import.meta.url));

/** The class list of the first element Home returns. */
function homeRootClasses(): string[] {
    const src = readFileSync(PAGE, 'utf8');
    const body = src.slice(src.indexOf('export default function Home'));
    const match = /className="([^"]*)"/.exec(body);
    return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

describe('the main page shell', () => {
    it('gives every control on / the ice focus ring', () => {
        // The page has no .dark, so --ring is :root's gray oklch(0.708 0 0).
        // Every control with no focus style of its own (a Learn more link, a
        // file's Remove) shows focus through the base outline-ring/50: gray
        // at 50% is about 2.7:1 against the card, under the 3:1 WCAG 1.4.11
        // asks of a focus indicator (Chromium adds a white outer ring to that
        // outline, see e2e/main-page-focus.spec.ts), and ice at 50% about
        // 4:1, the color the Buttons, drop zones and checkboxes already draw.
        // It is set on the
        // children, as RequestShell does, so a .dark on the root could not
        // override it.
        const classes = homeRootClasses();
        expect(classes).toContain('*:[--ring:var(--color-ice)]');
        expect(classes).not.toContain('[--ring:var(--color-ice)]');
        // Still the page's own shell, not some other element's class list.
        expect(classes).toContain('bg-zinc-950');
        expect(classes).toContain('min-h-dvh');
    });
});
