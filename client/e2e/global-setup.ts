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
 *
 * Last, it asks the client for every image its pages name, one at a time
 * (warm-images.ts). A test that closes a page while the image optimizer is
 * still working on an image leaves that image unanswerable for minutes, and
 * a later test then times out waiting for it. An image that is already in the
 * optimizer's cache is not affected, so no test may be the first to ask.
 */

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { FullConfig } from '@playwright/test';
import { CLI_BUILD_BINARY, CLI_BUILD_DIR, E2E_HOST_BINARY } from './cli-binary';
import { bundleLoopbackSender } from './loopback/bundle';
import { buildCarriesE2eSocketUrl, E2E_SOCKET_URL } from './socket-url';
import { warmImages } from './warm-images';

export default async function globalSetup(config: FullConfig): Promise<void> {
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

    // The address the tests themselves load pages from.
    const base = config.projects[0]?.use.baseURL;
    if (!base) throw new Error('playwright.config.ts gives no baseURL to warm the image optimizer at');
    const warmed = await warmImages(base);
    console.log(`warmed the image optimizer: ${warmed} addresses`);
}
