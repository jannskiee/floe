// Child process for desktop.test.mjs: a Store-mode DesktopLeg on a scratch
// APPDATA, with a fake UIA client and a launcher that starts nothing, so the
// real DesktopConfigGuard edits <scratch>/floe/desktop.json the way a live
// cell does; then the interrupt path under test:
//   sigint  the shape audit.mjs uses on Ctrl+C: the signal handler awaits
//           shutdown() (every leg stopped, every guard restored) and exits 130
//   exit    process.exit(130) with no shutdown: the 'exit' hook restores
//   crash   an uncaught exception: Node exits 1, the 'exit' hook restores
// argv: <mode> <scratch> <original desktop.json bytes, base64>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [mode, scratch, originalB64] = process.argv.slice(2);
process.env.APPDATA = scratch;
const { DesktopLeg, activeGuards, activeLegs, shutdown } =
    await import('../desktop.mjs');
const { installSignalTeardown } = await import('../proc.mjs');

const cfg = path.join(scratch, 'floe', 'desktop.json');
mkdirSync(path.dirname(cfg), { recursive: true });
writeFileSync(cfg, Buffer.from(originalB64, 'base64'));

const manifestPath = path.join(scratch, 'manifest.json');
const manifest = {
    desktop: { backup: null, configPath: null, sha256: null, restored: null },
    pids: [],
};
const writeManifest = () =>
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

let closed = false;
const notAWindow = () =>
    Object.assign(new Error('not-a-window'), { reason: 'not-a-window' });
const fakeClient = {
    log() {},
    async findWindow() {
        return {
            hwnd: 4242,
            pid: 0,
            exe: 'C:\\Program Files\\WindowsApps\\x\\floe-desktop.exe',
            minimized: false,
            visible: true,
        };
    },
    async waitTree() {
        return { ready: true };
    },
    async readText() {
        return { texts: [], count: 0 };
    },
    async request(cmd) {
        if (closed) throw notAWindow();
        if (cmd === 'foreground-check')
            return { foreground: false, idleSeconds: 999 };
        return {};
    },
    async capture(_, file) {
        return { path: file, w: 1, h: 1 };
    },
    async closeWindow() {
        closed = true;
        return { posted: true };
    },
    async show() {
        return { wasIconic: false, iconic: false };
    },
    async foregroundCheck() {
        return { foreground: false, idleSeconds: 999 };
    },
    async close() {
        return null;
    },
};

const leg = new DesktopLeg({
    role: 'receiver',
    cellId: 'T-INTERRUPT',
    input: 'code',
    code: 'amber-otter-cloud',
    outDir: path.join(scratch, 'out'),
    build: { launch: 'store' },
    evidenceDir: path.join(scratch, 'evidence'),
    uia: fakeClient,
    launcher: async () => ({ child: null, pid: null }),
    lister: async () => [],
    infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
    shared: { manifest, writeManifest },
});
await leg.launch([]);
process.stdout.write(
    JSON.stringify({
        launched: true,
        activeLeg: activeLegs.has(leg),
        activeGuards: activeGuards.size,
        edited: readFileSync(cfg, 'utf8'),
    }) + '\n'
);

if (mode === 'sigint') {
    installSignalTeardown(() => shutdown({ manifest, log: () => {} }));
    process.emit('SIGINT');
} else if (mode === 'exit') {
    process.exit(130);
} else if (mode === 'crash') {
    throw new Error('boom: simulated harness crash');
} else {
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
}
