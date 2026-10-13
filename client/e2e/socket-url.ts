/**
 * The signaling address the e2e client runs with, and the check that a build
 * served to the suite was made for it.
 *
 * Node builtins only, for the reason cli-binary.ts gives: playwright.config.ts
 * and global-setup.ts both load this in-process.
 *
 * 127.0.0.1 and not localhost: see the webServer env note in
 * playwright.config.ts.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** What NEXT_PUBLIC_SOCKET_URL is for every e2e run, local and CI. */
export const E2E_SOCKET_URL = 'http://127.0.0.1:3001';

/**
 * Whether a `next build` output was built for the suite: some script under
 * `<nextDir>/static` carries E2E_SOCKET_URL as a literal.
 *
 * NEXT_PUBLIC_SOCKET_URL is inlined at build time, and `next start` serves
 * whatever build is on disk. One made with the live server's address
 * (`https://api.floe.one`, what the Build & Lint step and ship-it's local lane
 * compile in) would run the browser side of the suite through production, and
 * its receives would be added to the public counter, which only ever takes
 * INCRBY. No source file under app, components, lib or hooks contains the
 * literal (lib/e2eSocketUrl.test.ts pins that), so it can only be in the
 * output because the variable put it there.
 */
export function buildCarriesE2eSocketUrl(nextDir: string): boolean {
    const root = join(nextDir, 'static');
    if (!existsSync(root)) return false;
    const pending = [root];
    while (pending.length > 0) {
        const dir = pending.pop() as string;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) pending.push(full);
            else if (entry.name.endsWith('.js') && readFileSync(full, 'utf8').includes(E2E_SOCKET_URL)) return true;
        }
    }
    return false;
}
