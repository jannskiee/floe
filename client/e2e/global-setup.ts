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
 * The relative imports below need @playwright/test 1.61.1+: 1.61.0's
 * in-process module hooks broke on relative TypeScript imports under
 * Node 22.18.
 *
 * Before any of that, with CI set, it refuses a client build that was not
 * made for the suite. Playwright has already started both servers by the time
 * this runs (the webServer plugins set up before globalSetup), and no test has
 * run yet, so throwing here stops the run with nothing sent anywhere.
 */

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { CLI_BUILD_BINARY, CLI_BUILD_DIR, E2E_HOST_BINARY } from './cli-binary';
import { bundleLoopbackSender } from './loopback/bundle';
import { buildCarriesE2eSocketUrl, E2E_SOCKET_URL } from './socket-url';

export default function globalSetup(): void {
    // With CI set the client is `next start` over whatever build is on disk
    // (playwright.config.ts), and the signaling address is compiled into it.
    // Without CI the client is `next dev`, which takes the address from the
    // environment the config gives it, so there is no build to check.
    if (process.env.CI && !buildCarriesE2eSocketUrl(join(__dirname, '..', '.next'))) {
        throw new Error(
            `client/.next was not built for the e2e suite: no script under .next/static carries ${E2E_SOCKET_URL}. ` +
            `Build it with NEXT_PUBLIC_SOCKET_URL=${E2E_SOCKET_URL} first, or unset CI to run against next dev. ` +
            'A build made with another signaling address runs the browser side of the suite through that server.',
        );
    }
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
