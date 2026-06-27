import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
    testDir: './e2e',
    timeout: 90_000,
    expect: { timeout: 60_000 },
    // These are heavy WebRTC integration tests that share one signaling server
    // (which is per-IP rate limited) and move tens of MB each. Running them in
    // parallel on a 2-core CI runner starves the transfers and trips flaky
    // timeouts, so serialize on CI. Local runs keep Playwright's default workers.
    workers: process.env.CI ? 1 : undefined,
    // Retry once on CI to absorb transient WebRTC handshake hiccups. A genuine
    // protocol break fails every attempt; the unit tests are the real correctness
    // guard, this just stops infra jitter from reddening the build.
    retries: process.env.CI ? 1 : 0,
    use: {
        baseURL: 'http://localhost:3000',
        headless: true,
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: [
        {
            command: 'node server.js',
            cwd: path.resolve(__dirname, '../server'),
            port: 3001,
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
            },
        },
        {
            command: 'pnpm dev',
            cwd: __dirname,
            port: 3000,
            reuseExistingServer: true,
            timeout: 60_000,
            env: {
                NEXT_PUBLIC_SOCKET_URL: 'http://localhost:3001',
            },
        },
    ],
});
