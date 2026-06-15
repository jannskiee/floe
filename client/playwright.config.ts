import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
    testDir: './e2e',
    timeout: 90_000,
    expect: { timeout: 60_000 },
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
