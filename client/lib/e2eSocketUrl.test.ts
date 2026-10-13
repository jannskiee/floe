import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCarriesE2eSocketUrl, E2E_SOCKET_URL } from '../e2e/socket-url';

// The e2e suite's guard against a client build that points somewhere else
// (e2e/global-setup.ts). It lives here because vitest reads lib/ and app/
// only, and a *.test.ts under e2e/ would be collected by Playwright.

const CLIENT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(?:ts|tsx|js|mjs|css)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('the e2e signaling address', () => {
    // The build check reads "the literal is in the output" as "the variable
    // put it there". That holds only while nothing the client bundles spells
    // it out. This file imports the constant and never types it.
    it('is spelled out in no source the client bundles', () => {
        const bundled = [
            ...['app', 'components', 'lib', 'hooks'].flatMap((d) => sourceFiles(join(CLIENT, d))),
            ...readdirSync(CLIENT, { withFileTypes: true })
                .filter((e) => e.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(e.name))
                .map((e) => join(CLIENT, e.name)),
        ];
        expect(bundled.length).toBeGreaterThan(100);
        const carrying = bundled.filter((f) => readFileSync(f, 'utf8').includes(E2E_SOCKET_URL));
        expect(carrying).toEqual([]);
    });

    it('is what the config starts the client with and what the setup checks for', () => {
        const config = readFileSync(join(CLIENT, 'playwright.config.ts'), 'utf8');
        expect(config).toContain('NEXT_PUBLIC_SOCKET_URL: E2E_SOCKET_URL,');
        // Adoption is off for both servers, and stays off.
        expect(config.match(/reuseExistingServer: false,/g)).toHaveLength(2);
        expect(config).not.toMatch(/reuseExistingServer:\s*true/);
        const setup = readFileSync(join(CLIENT, 'e2e', 'global-setup.ts'), 'utf8');
        expect(setup).toContain("process.env.CI && !buildCarriesE2eSocketUrl(join(__dirname, '..', '.next'))");
    });
});

describe('buildCarriesE2eSocketUrl', () => {
    const made: string[] = [];
    function build(files: Record<string, string>): string {
        const dir = mkdtempSync(join(tmpdir(), 'floe-e2e-build-'));
        made.push(dir);
        for (const [name, text] of Object.entries(files)) {
            const full = join(dir, name);
            mkdirSync(join(full, '..'), { recursive: true });
            writeFileSync(full, text);
        }
        return dir;
    }
    afterEach(() => {
        for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('accepts a build with the address compiled into a nested chunk', () => {
        const dir = build({
            'static/chunks/a.js': 'let x=1;',
            'static/chunks/app/deep/b.js': `let e="${E2E_SOCKET_URL}";`,
        });
        expect(buildCarriesE2eSocketUrl(dir)).toBe(true);
    });

    it('refuses a build compiled with the live server, or with the dev fallback', () => {
        expect(buildCarriesE2eSocketUrl(build({ 'static/chunks/a.js': 'let e="https://api.floe.one";' }))).toBe(false);
        expect(buildCarriesE2eSocketUrl(build({ 'static/chunks/a.js': 'let e="http://localhost:3001";' }))).toBe(false);
    });

    it('reads scripts under static only', () => {
        const dir = build({
            'server/app/page.js': `let e="${E2E_SOCKET_URL}";`,
            'static/chunks/a.js.map': E2E_SOCKET_URL,
            'static/media/note.txt': E2E_SOCKET_URL,
        });
        expect(buildCarriesE2eSocketUrl(dir)).toBe(false);
    });

    it('refuses a folder that holds no build', () => {
        expect(buildCarriesE2eSocketUrl(build({}))).toBe(false);
        expect(buildCarriesE2eSocketUrl(join(tmpdir(), 'floe-e2e-build-does-not-exist'))).toBe(false);
    });
});
