import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
    testDir: './e2e',
    timeout: 90_000,
    expect: { timeout: 60_000 },
    // Build the Go CLI once per run for the CLI interop / CLI-CLI specs
    // (paths resolve relative to this config file).
    globalSetup: './e2e/global-setup.ts',
    globalTeardown: './e2e/global-teardown.ts',
    // These are heavy WebRTC integration tests that share one signaling server
    // (which is per-IP rate limited) and move tens of MB each. Running them in
    // parallel on a 2-core CI runner starves the transfers and trips flaky
    // timeouts, so serialize on CI. Local runs keep Playwright's default workers.
    workers: process.env.CI ? 1 : undefined,
    // Retry once on CI to absorb transient WebRTC handshake hiccups. A genuine
    // protocol break fails every attempt; the unit tests are the real correctness
    // guard, this just stops infra jitter from reddening the build.
    retries: process.env.CI ? 1 : 0,
    // Terminal output stays list; the HTML report additionally persists every
    // attempt's attachments (the stamped CLI transcripts from e2e/helpers.ts)
    // and retried-test traces, so a flaky first attempt inside a green run
    // leaves evidence in the uploaded CI artifact instead of vanishing.
    // open: 'never' keeps local runs from popping a browser after failures.
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://localhost:3000',
        headless: true,
        // On the CI retry, record a trace so a cross-OS-only failure is
        // debuggable from the uploaded artifact instead of being unreproducible.
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // macOS CI runners cannot resolve peer mDNS .local ICE candidates,
                // so browser-to-browser pairs (both Chromium sides obfuscating
                // their host IPs) never connect there; CLI pairs are unaffected
                // because pion publishes real IPs. Expose real host IPs on macOS
                // CI only - ubuntu/windows CI and every local run (including
                // local Macs, where Bonjour works) keep the production
                // mDNS-obfuscated path and keep covering it. Note: this replaces
                // Playwright's own --disable-features list on that one leg
                // (Chromium takes the last occurrence); validated green in CI.
                launchOptions: process.platform === 'darwin' && !!process.env.CI
                    ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
                    : {},
            },
        },
    ],
    webServer: [
        {
            command: 'node server.js',
            cwd: path.resolve(__dirname, '../server'),
            // Poll /health instead of the bare port so tests only start once
            // Express is actually routing requests, not merely listening.
            url: 'http://localhost:3001/health',
            reuseExistingServer: true,
            timeout: 30_000,
            env: {
                CLIENT_URL: 'http://localhost:3000',
                PORT: '3001',
                // The whole e2e suite drives many Socket.IO/WebSocket connections
                // from one IP; lift the per-IP connection cap so the shared signaling
                // server does not rate-limit a peer mid-suite and stall a transfer.
                MAX_CONNECTIONS_PER_IP: '1000',
                // Same reasoning for the code endpoint limiter: keep it well clear of
                // the suite's /api/code traffic so a growing suite can never trip it.
                MAX_CODE_REQUESTS_PER_IP: '1000',
                // Every browser page load and CLI spawn fetches /api/turn-credentials
                // once; keep the suite clear of the 20/min default so a 429 can never
                // silently reroute the CLI onto public Google STUN mid-test.
                MAX_TURN_REQUESTS_PER_IP: '1000',
            },
        },
        {
            // CI serves the production build (created by the "Build client
            // (production)" workflow step): next dev compiles routes on
            // demand, and on macOS runners that first compile repeatedly
            // blew the 120s startup budget below. Local runs keep next dev
            // so the edit-refresh flow is untouched.
            command: process.env.CI ? 'pnpm start' : 'pnpm dev',
            cwd: __dirname,
            // URL readiness makes Playwright issue a real GET / before tests
            // start. Under next dev that forces the home page to compile up
            // front so the first test's timeout never pays for it; under
            // next start it just confirms the server is routing.
            url: 'http://localhost:3000',
            reuseExistingServer: true,
            timeout: 120_000,
            env: {
                // 127.0.0.1 (not localhost) so engine.io-client registers its
                // window 'offline' listener, which reconnect.spec.ts relies on:
                // the client hardcodes a skip of that listener for the literal
                // host "localhost", and setOffline alone never tears down an
                // established WebSocket. Also the production code path, since
                // real deployments never use "localhost".
                // NEXT_PUBLIC_* is inlined at BUILD time, so this value only
                // takes effect through next dev (local runs). On CI the same
                // value is baked in by the "Build client (production)" step
                // and next start ignores this block. reconnect.spec.ts
                // asserts the effective value at runtime either way.
                NEXT_PUBLIC_SOCKET_URL: 'http://127.0.0.1:3001',
            },
        },
    ],
});
