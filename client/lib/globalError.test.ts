import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The whole-page error screen (app/global-error.tsx) replaces the root layout,
// so it has to bring the site's look with it: Next's built-in it used to
// render was a white page with Next's own words, on a dark site (A9-B12).
// Read as text, because a page cannot run under this vitest (vitest.config.ts).
// What it renders was checked on a production build with a route that throws
// while rendering (2026-10-14): status 500, this title, the dark shell, no
// sideways scroll at 390 px. The prerendered .next/server/app/_global-error.html
// is not this component: Next writes its own built-in page there, which is why
// scripts/check-titles.mjs still expects Next's title for it.
const SRC = readFileSync(fileURLToPath(new URL('../app/global-error.tsx', import.meta.url)), 'utf8');

describe('app/global-error.tsx', () => {
    it("renders the site's own screen, not Next's built-in", () => {
        expect(SRC).not.toContain('next/error');
        expect(SRC).not.toContain('<NextError');
        expect(SRC).toContain("import './globals.css'");
        expect(SRC).toContain('bg-zinc-950');
    });

    it('offers a reload, in few plain words', () => {
        expect(SRC).toContain('window.location.reload()');
        expect(SRC).toContain('Something went wrong');
        expect(SRC).toContain('Reload the page to try again.');
        expect(SRC).toContain('>Reload page<');
    });

    it('names itself in the tab like every other page', () => {
        expect(SRC).toContain('<title>Something Went Wrong - Floe</title>');
    });

    it('still reports the error', () => {
        expect(SRC).toContain('Sentry.captureException(error)');
    });
});
