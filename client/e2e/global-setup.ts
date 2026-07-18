/**
 * Global setup: build the Go CLI once per Playwright run.
 *
 * The binary lands in its own temp directory instead of a bare file in
 * tmpdir() so teardown can remove one directory, and so no spec-level
 * cleanup can race the binary another spec is still using. Specs read the
 * path back via the FLOE_E2E_CLI_BINARY environment variable
 * (helpers.cliBinary()); Playwright worker processes inherit the runner's
 * environment, so setting it here reaches every spec.
 *
 * Deliberately self-contained (builtin imports only): Playwright loads
 * global setup in-process, where relative TypeScript imports break its
 * module transform on some Node versions. The two constants below mirror
 * e2e/cli-binary.ts - keep them in sync.
 */

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, platform } from 'os';

const CLI_BUILD_DIR = join(tmpdir(), 'floe-e2e-cli');
const CLI_BUILD_BINARY = join(
    CLI_BUILD_DIR,
    platform() === 'win32' ? 'floe-test.exe' : 'floe-test',
);

export default function globalSetup(): void {
    mkdirSync(CLI_BUILD_DIR, { recursive: true });
    const cliDir = join(__dirname, '..', '..', 'cli');
    execSync(`go build -o "${CLI_BUILD_BINARY}" ./cmd/floe`, {
        cwd: cliDir,
        stdio: 'inherit',
    });
    process.env.FLOE_E2E_CLI_BINARY = CLI_BUILD_BINARY;
}
