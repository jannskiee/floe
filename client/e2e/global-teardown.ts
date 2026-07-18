/**
 * Global teardown: remove the CLI binary built by global-setup.
 *
 * Windows caveat: a CLI process killed at test teardown can hold the .exe
 * open for a moment, so rmSync may throw EBUSY/EPERM. maxRetries gives the
 * OS time to release the handle; any remaining error is swallowed. A leaked
 * temp directory must never fail an otherwise green suite.
 *
 * Self-contained for the same loader reason as global-setup.ts; the
 * constant mirrors e2e/cli-binary.ts - keep them in sync.
 */

import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CLI_BUILD_DIR = join(tmpdir(), 'floe-e2e-cli');

export default function globalTeardown(): void {
    try {
        rmSync(CLI_BUILD_DIR, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
        });
    } catch { /* ignore, see header comment */ }
}
