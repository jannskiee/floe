#!/usr/bin/env node
/**
 * A stand-in for the floe-run skill script so stack.test.mjs can exercise
 * ensureStack / stopStack without binding :3001. It speaks floe-run's
 * contract: `check --json` prints the report with the exit code taken from
 * FAKE_FLOE_RUN_CHECK (2 clear, 0 owned, 1 refuse), `start` prints the
 * READY block (floe-run.mjs:478-500) and then waits until the file named by
 * FAKE_FLOE_RUN_STOPFILE appears, `stop` creates that file.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [mode = 'start', ...flags] = process.argv.slice(2);
const stopFile = process.env.FAKE_FLOE_RUN_STOPFILE || '';
const checkCode = Number(process.env.FAKE_FLOE_RUN_CHECK ?? 2);

if (mode === 'check') {
    const report = {
        serverBound: checkCode !== 2,
        healthy: checkCode === 0,
        totalBytes: checkCode === 0 ? 0 : null,
        clientBound: process.env.FAKE_FLOE_RUN_CLIENT === '1',
        owned: checkCode === 0,
        ownership: checkCode === 0 ? 'pid 4242' : 'no pidfile',
        pidfile: 'C:\\Temp\\floe-run.json',
        root: process.cwd(),
        verdict:
            checkCode === 2
                ? 'nothing is bound on :3001'
                : checkCode === 0
                  ? 'owned by this script (pid 4242) and /api/stats reads 0'
                  : ':3001 is bound but not by this script (no pidfile); zero is necessary, not sufficient. Find the owner with: netstat -ano | findstr :3001',
        exitCode: checkCode,
    };
    if (flags.includes('--json')) console.log(JSON.stringify(report, null, 4));
    else console.log(`verdict: ${report.verdict}`);
    process.exit(checkCode);
}

if (mode === 'stop') {
    if (stopFile) writeFileSync(stopFile, 'stop');
    console.log('stopped server (pid 4242)');
    process.exit(0);
}

const client = flags.includes('--client');
const relaxed = flags.includes('--relaxed');
console.log('[server] (nothing: server.js prints no startup line)');
console.log('READY');
console.log(
    'stats: sentinel http://127.0.0.1:9, totalBytes=0, server pid 4242'
);
console.log(
    'server: http://localhost:3001  (/health, /api/stats, /api/turn-credentials)'
);
console.log(
    client
        ? 'web: http://localhost:3000  (corepack pnpm dev, NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001, pid 4343)'
        : 'web: not started (pass --client for next dev on :3000)'
);
console.log(
    'cli: floe send <file> --server http://localhost:3001 --web http://localhost:3000'
);
console.log('     floe receive <code> --server http://localhost:3001');
console.log(
    `limiters: ${relaxed ? 'relaxed to 1000/min per IP' : 'server defaults'}`
);
console.log(`pidfile: C:\\Temp\\floe-run.json (wrapper pid ${process.pid})`);
console.log('stop: node .claude/skills/floe-run/scripts/floe-run.mjs stop');
for (;;) {
    if (stopFile && existsSync(stopFile)) {
        console.log('floe-run: stopped');
        process.exit(0);
    }
    await sleep(100);
}
