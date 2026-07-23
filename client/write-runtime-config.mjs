import { writeFile } from 'node:fs/promises';

const config = {
    socketUrl: process.env.FLOE_SOCKET_URL?.trim() || '',
    socketPort: process.env.FLOE_SOCKET_PORT?.trim() || '3001',
};

await writeFile(
    '/app/public/runtime-config.js',
    `window.__FLOE_CONFIG__ = ${JSON.stringify(config)};\n`,
    'utf8'
);
