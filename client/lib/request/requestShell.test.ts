import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The /r shell's theme, read as TEXT: client/vitest.config.ts runs in node and
// collects lib/ and app/ only, so the component cannot be mounted here (see
// visitorBoundaries.test.ts). The rendered colors are checked by
// e2e/request-look.spec.ts.

const SHELL = fileURLToPath(new URL('../../components/request/RequestShell.tsx', import.meta.url));

/** The class list of the first element RequestShell returns. */
function shellRootClasses(): string[] {
    const src = readFileSync(SHELL, 'utf8');
    const body = src.slice(src.indexOf('export function RequestShell'), src.indexOf('function RequestFooter'));
    const match = /className="([^"]*)"/.exec(body);
    return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

describe('the /r shell', () => {
    it('puts the whole page in the dark theme', () => {
        // Nothing else on /r sets .dark: the root layout gives <html> only
        // scroll-smooth, and the main page overrides every Button's colors by
        // hand. Without it the shadcn Button read the light :root tokens:
        // Choose files and every other outline button were near-white slabs
        // under the shell's near-white text (1.03:1), Send was near-black on
        // the near-black card (R4 F1, captured in CP-UI 01-visitor-open.png).
        // scheme-dark is the native half: the Hide my IP checkbox drew as a
        // bright white square (R4 F2).
        const classes = shellRootClasses();
        expect(classes).toContain('bg-zinc-950');
        expect(classes).toContain('dark');
        expect(classes).toContain('scheme-dark');
    });

    it('gives every control on /r the ice focus ring', () => {
        // The dark ring token, oklch(0.556 0 0), drawn at 50% by the Button's
        // ring-ring/50, is 1.88:1 against the card; WCAG 1.4.11 asks 3:1 of a
        // focus indicator. Ice at 50% is 3.99:1. It is set on the shell's
        // children, not on the shell: .dark sets --ring on its own element
        // from an unlayered rule, which beats any utility there.
        // e2e/request-look.spec.ts measures the ring as drawn.
        const classes = shellRootClasses();
        expect(classes).toContain('*:[--ring:var(--color-ice)]');
        expect(classes).not.toContain('[--ring:var(--color-ice)]');
    });
});
