/**
 * Global setup: build the Go CLI once per Playwright run.
 *
 * The binary lands in its own temp directory (CLI_BUILD_DIR) instead of a
 * bare file in tmpdir() so teardown can remove one directory, and so no
 * spec-level cleanup can race the binary another spec is still using.
 * Specs read the path back via the FLOE_E2E_CLI_BINARY environment variable
 * (helpers.cliBinary()); Playwright worker processes inherit the runner's
 * environment, so setting it here reaches every spec.
 */

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { CLI_BUILD_BINARY, CLI_BUILD_DIR } from './helpers';

export default function globalSetup(): void {
    mkdirSync(CLI_BUILD_DIR, { recursive: true });
    const cliDir = join(__dirname, '..', '..', 'cli');
    execSync(`go build -o "${CLI_BUILD_BINARY}" ./cmd/floe`, {
        cwd: cliDir,
        stdio: 'inherit',
    });
    process.env.FLOE_E2E_CLI_BINARY = CLI_BUILD_BINARY;
}
