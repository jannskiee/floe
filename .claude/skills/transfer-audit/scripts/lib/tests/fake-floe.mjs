#!/usr/bin/env node
/**
 * A scripted stand-in for floe.exe so proc.test.mjs and cli.test.mjs run
 * without the real binary. It prints the shipped 1.10.5 shapes: the share
 * box with Code and Link rows (cli/cmd/floe/main.go:200-208), the
 * "  Waiting for peer..." / "  Connecting..." / "  Connected" markers, a
 * progress bar that redraws with a bare \r (format.go newProgressBar), the
 * summary box (sender.go:319-323, receiver.go:548-552) and the cobra
 * "Error: " line on stderr with exit 1, or "  Canceled." with exit 130.
 *
 * Driven by the environment:
 *   FAKE_FLOE_MODE      normal | stall | refusal | race | exit130 | nocode | part
 *   FAKE_FLOE_DELAY_MS  pause between steps (default 20)
 *   FAKE_FLOE_RELAY_ONLY=1   list --relay-only in `send --help`
 *   FAKE_FLOE_SUFFIX=relay|direct   print "  Connected (relay)" style
 *   FAKE_FLOE_PAIR=relay|direct     with PION_LOG_TRACE=ice, emit a pion
 *                                   "Set selected candidate pair:" line
 *   FAKE_FLOE_ICEWARN=1  print the STUN fallback warning first
 *
 * The receiver writes fixture.bin (1 KiB of 0x5a) into --output; `part`
 * mode also leaves fixture.bin.part behind. The room id and code are fixed
 * synthetic values.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DIVIDER = '  ─────────────────────────────────────────────────';
const MODE = process.env.FAKE_FLOE_MODE || 'normal';
const DELAY = Number(process.env.FAKE_FLOE_DELAY_MS || 20);
const VERSION = '1.10.5-fake';
const ROOM = '11111111-2222-4333-8444-555555555555';
const CODE = 'amber-otter-cloud';
const FAKE_NAME = 'fixture.bin';
const FAKE_BYTES = Buffer.alloc(1024, 0x5a);

const GLOBAL_FLAGS = [
    'Global Flags:',
    '      --iface strings   restrict WebRTC to network interfaces matching these names (repeatable, e.g. --iface Ethernet); use when a VPN/VM adapter slows connection setup',
    '      --no-relay        disable TURN relay (direct connections only)',
    '      --server string   signaling server URL (use http://localhost:3001 for local testing) [env: FLOE_SERVER] (default "https://api.floe.one")',
    '      --web string      web app URL shown in the browser link (auto-detected if not set) [env: FLOE_WEB]',
];

const SEND_HELP = [
    'Send files or folders to a peer',
    '',
    'Usage:',
    '  floe send <file|folder> [file|folder...] [flags]',
    '',
    'Flags:',
    '  -h, --help   help for send',
    ...(process.env.FAKE_FLOE_RELAY_ONLY === '1'
        ? ['      --relay-only   force the TURN relay path (relay only)']
        : []),
    '',
    ...GLOBAL_FLAGS,
];

const RECEIVE_HELP = [
    'Receive files from a peer using a code or link.',
    '',
    'After a successful transfer the receiver posts only the total byte count to',
    "Floe's signaling server to power the public global-transfer counter. No file",
    'names, contents, or identities are included. To opt out of this report, use',
    '--no-report or set FLOE_NO_STATS=1 in your environment.',
    '',
    'Usage:',
    '  floe receive <code | link> [flags]',
    '',
    'Flags:',
    '  -h, --help            help for receive',
    "      --no-report       do not report transferred bytes to Floe's public global counter",
    '  -o, --output string   directory to save received files (default ".")',
    '  -y, --yes             auto-accept incoming files without confirmation',
    '',
    ...GLOBAL_FLAGS,
];

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
};

function box(rows) {
    const w = Math.max(...rows.map((r) => r[0].length));
    out(DIVIDER);
    for (const [k, v] of rows) out(`  ${k}${' '.repeat(w - k.length)}   ${v}`);
    out(DIVIDER);
}

async function progress(name) {
    const total = FAKE_BYTES.length;
    for (const pct of [0, 25, 50, 75, 100]) {
        const filled = Math.round(pct / 10);
        const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
        const done = Math.round((total * pct) / 100);
        process.stdout.write(
            `\r  [1/1] ${name}  ${pct}% [${bar}] (${done}/${total} B)`
        );
        await sleep(DELAY);
    }
    out();
}

function pionLine() {
    if (process.env.PION_LOG_TRACE !== 'ice') return;
    const pair = process.env.FAKE_FLOE_PAIR || 'direct';
    const local = pair === 'relay' ? 'relay' : 'host';
    err(
        `ice TRACE: 12:00:00.000000 agent.go:780: Set selected candidate pair: prio 9 (local, prio 9) udp4 ${local} 203.0.113.9:40000 related 0.0.0.0:0 (resolved: <nil>) <-> udp4 srflx 198.51.100.7:50000 related 0.0.0.0:0 (resolved: <nil>) (remote, prio 9), state: succeeded, nominated: true, nominateOnBindingSuccess: false`
    );
}

// A pending promise alone does not keep Node alive (it exits 13 on an
// unsettled top-level await), so the stall modes pin the event loop.
const forever = () =>
    new Promise(() => {
        setInterval(() => {}, 1 << 30);
    });

async function tail(role) {
    if (MODE === 'stall' || (MODE === 'race' && role === 'sender'))
        return forever();
    if (MODE === 'exit130') {
        err('\n  Canceled.');
        process.exit(130);
    }
    if (MODE === 'refusal') {
        err(
            role === 'sender'
                ? 'Error: transfer blocked: relay connections are capped at 2 GB (selected 3.0 GB)'
                : 'Error: connection closed before any file arrived (the sender canceled, or the transfer was blocked)'
        );
        process.exit(1);
    }
    if (MODE === 'race') {
        await sleep(DELAY);
        err('Error: connected, but no data arrived from the sender within 30s');
        process.exit(1);
    }
    return null;
}

async function send() {
    const paths = [];
    for (const a of argv.slice(1)) {
        if (a.startsWith('--')) break;
        paths.push(a);
    }
    if (!paths.length) {
        err('Error: requires at least 1 arg(s), only received 0');
        process.exit(1);
    }
    const web = flag('--web') || 'http://127.0.0.1:3000';
    out();
    if (process.env.FAKE_FLOE_ICEWARN === '1')
        out(
            '  Warning: could not reach signaling server for TURN credentials. Using STUN only.'
        );
    const rows = [];
    if (MODE === 'nocode')
        out(
            '  Warning: could not generate short code: server returned 503 when registering code'
        );
    else rows.push(['Code', CODE]);
    rows.push(['Link', `${web}/#room=${ROOM}`]);
    out(`  Sending   ${FAKE_NAME} · 1.0 KB`);
    box(rows);
    out();
    out('  Waiting for peer...');
    await sleep(DELAY);
    out('  Connecting...');
    await sleep(DELAY);
    const suffix = process.env.FAKE_FLOE_SUFFIX;
    out(suffix ? `  Connected (${suffix})` : '  Connected');
    out();
    pionLine();
    await tail('sender');
    await progress(FAKE_NAME);
    out();
    box([
        ['Sent', '1 file (1.0 KB)'],
        ['Time', '0s · avg 1.0 MB/s'],
    ]);
    process.exit(0);
}

async function receive() {
    const outDir = resolve(flag('--output') || '.');
    out();
    out('  Connecting to sender...');
    await sleep(DELAY);
    const suffix = process.env.FAKE_FLOE_SUFFIX;
    out(suffix ? `  Connected (${suffix})` : '  Connected');
    pionLine();
    out();
    box([['Incoming', `${FAKE_NAME} · 1.0 KB`]]);
    out();
    await tail('receiver');
    mkdirSync(outDir, { recursive: true });
    await progress(FAKE_NAME);
    writeFileSync(join(outDir, FAKE_NAME), FAKE_BYTES);
    if (MODE === 'part')
        writeFileSync(join(outDir, `${FAKE_NAME}.part`), FAKE_BYTES);
    out();
    box([
        ['Received', '1 file (1.0 KB)'],
        ['Time', '0s · avg 1.0 MB/s'],
        ['Saved to', outDir],
    ]);
    process.exit(0);
}

if (argv.includes('--version') || argv[0] === '-v') {
    out(`floe ${VERSION}`);
    process.exit(0);
}
if (argv[0] === 'send' && (argv.includes('--help') || argv.includes('-h'))) {
    for (const l of SEND_HELP) out(l);
    process.exit(0);
}
if (argv[0] === 'receive' && (argv.includes('--help') || argv.includes('-h'))) {
    for (const l of RECEIVE_HELP) out(l);
    process.exit(0);
}
if (argv[0] === 'send') await send();
else if (argv[0] === 'receive') await receive();
else {
    err(`Error: unknown command "${argv[0] ?? ''}" for "floe"`);
    process.exit(1);
}
