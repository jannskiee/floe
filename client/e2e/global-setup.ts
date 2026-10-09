/**
 * Global setup: build the Go CLI, the Go host harness and the loopback sender
 * bundle once per Playwright run.
 *
 * Requires the Go toolchain on PATH (the whole e2e suite now depends on it,
 * browser-only specs included). Everything lands in one temp directory so
 * teardown can remove one directory, and so no spec-level cleanup can race a
 * binary another spec is still using. Specs read the paths back via the
 * FLOE_E2E_CLI_BINARY and FLOE_E2E_HOST_BINARY environment variables;
 * Playwright worker processes inherit the runner's environment, so setting
 * them here reaches every spec.
 *
 * The harness (cli/internal/e2ehost) is test-only: .goreleaser.yml builds
 * only ./cmd/floe, so it never ships.
 *
 * The relative import below needs @playwright/test 1.61.1+: 1.61.0's
 * in-process module hooks broke on relative TypeScript imports under
 * Node 22.18.
 */

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { CLI_BUILD_BINARY, CLI_BUILD_DIR, E2E_HOST_BINARY } from './cli-binary';
import { bundleLoopbackSender } from './loopback/bundle';

export default function globalSetup(): void {
    mkdirSync(CLI_BUILD_DIR, { recursive: true });
    const cliDir = join(__dirname, '..', '..', 'cli');
    execSync(`go build -o "${CLI_BUILD_BINARY}" ./cmd/floe`, {
        cwd: cliDir,
        stdio: 'inherit',
    });
    process.env.FLOE_E2E_CLI_BINARY = CLI_BUILD_BINARY;
    execSync(`go build -o "${E2E_HOST_BINARY}" ./internal/e2ehost`, {
        cwd: cliDir,
        stdio: 'inherit',
    });
    process.env.FLOE_E2E_HOST_BINARY = E2E_HOST_BINARY;
    bundleLoopbackSender();
}
