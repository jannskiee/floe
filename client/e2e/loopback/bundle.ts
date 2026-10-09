/**
 * Bundles the browser sender for the loopback spec (loopback-host.spec.ts).
 *
 * Imports ONLY esbuild and node builtins, for the reason cli-binary.ts gives:
 * global-setup loads in-process, and anything that pulls in @playwright/test
 * there breaks Playwright's module transform.
 *
 * The bundle lands in CLI_BUILD_DIR (the OS temp directory global-teardown
 * removes), never under client/, so nothing test-only reaches a production
 * build. The page itself is a page.route fulfilment, so client/app gains no
 * route either.
 */

import { buildSync } from 'esbuild';
import { join } from 'path';
import { LOOPBACK_BUNDLE } from '../cli-binary';

export function bundleLoopbackSender(): void {
    buildSync({
        entryPoints: [join(__dirname, 'entry.ts')],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'chrome120',
        outfile: LOOPBACK_BUNDLE,
        logLevel: 'error',
    });
}
