/**
 * Location of the test CLI binary built by e2e/global-setup.ts.
 *
 * Lives in its own module with ONLY node builtin imports: global-setup and
 * global-teardown load in-process, and importing anything that transitively
 * pulls in @playwright/test there breaks Playwright's module transform.
 * helpers.ts re-exports these for specs.
 */

import { join } from 'path';
import { tmpdir, platform } from 'os';

/** Directory the test CLI binary is built into by e2e/global-setup.ts. */
export const CLI_BUILD_DIR = join(tmpdir(), 'floe-e2e-cli');

/** Where global-setup builds the binary (only global-setup should write it). */
export const CLI_BUILD_BINARY = join(
    CLI_BUILD_DIR,
    platform() === 'win32' ? 'floe-test.exe' : 'floe-test',
);
