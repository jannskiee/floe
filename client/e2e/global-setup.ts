/**
 * Global setup: build the Go CLI once per Playwright run.
 *
 * Requires the Go toolchain on PATH (the whole e2e suite now depends on it,
 * browser-only specs included). The binary lands in its own temp directory
 * so teardown can remove one directory, and so no spec-level cleanup can
 * race the binary another spec is still using. Specs read the path back via
 * the FLOE_E2E_CLI_BINARY environment variable (helpers.cliBinary());
 * Playwright worker processes inherit the runner's environment, so setting
 * it here reaches every spec.
 *
 * The relative import below needs @playwright/test 1.61.1+: 1.61.0's
 * in-process module hooks broke on relative TypeScript imports under
 * Node 22.18.
 */

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { CLI_BUILD_BINARY, CLI_BUILD_DIR } from './cli-binary';

export default function globalSetup(): void {
    mkdirSync(CLI_BUILD_DIR, { recursive: true });
    const cliDir = join(__dirname, '..', '..', 'cli');
    execSync(`go build -o "${CLI_BUILD_BINARY}" ./cmd/floe`, {
        cwd: cliDir,
        stdio: 'inherit',
    });
    process.env.FLOE_E2E_CLI_BINARY = CLI_BUILD_BINARY;
}
