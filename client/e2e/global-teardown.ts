/**
 * Global teardown: remove the CLI binary built by global-setup.
 *
 * Windows caveat: a CLI process killed at test teardown can hold the .exe
 * open for a moment, so rmSync may throw EBUSY/EPERM. maxRetries gives the
 * OS time to release the handle; any remaining error is swallowed. A leaked
 * temp directory must never fail an otherwise green suite.
 */

import { rmSync } from 'fs';
import { CLI_BUILD_DIR } from './helpers';

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
