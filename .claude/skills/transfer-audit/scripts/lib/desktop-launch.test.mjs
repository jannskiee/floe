// The desktop leg's launch on fixtures (FU-26): every exe and the Store
// AUMID start detached (no foreground rights, first window
// SW_SHOWNOACTIVATE), and a leg never starts a second instance. An injected
// detach and lister stand in for WMI and tasklist, so nothing starts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SW } from './detached.mjs';
import {
    AUMID,
    DEV_EXE_NAME,
    DesktopLeg,
    EXE_NAME,
    ShellMenuGuard,
    activeLegs,
    launchProcess,
    listDesktopProcesses,
    planLaunch,
} from './desktop.mjs';
import { started } from './proc.mjs';
import { PhaseError } from './surfaces.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(path.join(tmpdir(), 'fu26-launch-'));

function recorder(pid = 6161) {
    const calls = [];
    const detach = async (o) => {
        calls.push(o);
        return { pid };
    };
    return { calls, detach };
}

test('launchProcess starts a portable or head exe detached, with its whole planned env and SW_SHOWNOACTIVATE, and notes the launch', async () => {
    const dir = tmp();
    try {
        const plan = planLaunch({
            mode: 'portable',
            exe: 'C:\\s\\floe-desktop.exe',
            files: ['C:\\in\\a.bin'],
            scratch: dir,
            env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\w', PION_LOG_TRACE: 'all' },
        });
        const r = recorder();
        const out = await launchProcess(plan, { evidenceDir: path.join(dir, 'ev'), detach: r.detach });
        assert.deepEqual(out, { child: null, pid: 6161, detached: true });
        assert.equal(r.calls.length, 1);
        const [c] = r.calls;
        assert.equal(c.command, 'C:\\s\\floe-desktop.exe');
        assert.deepEqual(c.args, ['C:\\in\\a.bin']);
        assert.equal(c.cwd, 'C:\\s');
        assert.equal(c.show, SW.SHOWNOACTIVATE);
        // The whole env the plan built: a detached env replaces the process's
        // environment outright, so it must carry everything (measured).
        assert.equal(c.env.SystemRoot, 'C:\\Windows');
        assert.equal(c.env.APPDATA, path.join(dir, 'appdata'));
        assert.equal(c.env.FLOE_NO_UPDATE_CHECK, '1');
        assert.equal(c.env.PION_LOG_TRACE, undefined, 'PION_LOG_* still stripped');
        const note = readFileSync(path.join(dir, 'ev', 'desktop.launch.txt'), 'utf8');
        assert.match(note, /detached launch \(FU-26\): Win32_Process\.Create pid 6161, first window SW_SHOWNOACTIVATE; no stdout or stderr pipe/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('launchProcess sends the Store AUMID through a detached explorer.exe with the user default env; wailsdev starts nothing', async () => {
    const plan = planLaunch({ mode: 'store', env: { APPDATA: 'C:\\u\\AppData\\Roaming' } });
    const r = recorder(7070);
    const out = await launchProcess(plan, { detach: r.detach });
    assert.deepEqual(out, { child: null, pid: null, launcherPid: 7070, detached: true });
    assert.deepEqual(r.calls, [
        { command: 'explorer.exe', args: [`shell:AppsFolder\\${AUMID}`], env: null, show: SW.SHOWNOACTIVATE },
    ]);
    const dev = recorder();
    assert.deepEqual(await launchProcess({ mode: 'wailsdev' }, { detach: dev.detach }), { child: null, pid: null });
    assert.equal(dev.calls.length, 0);
});

test('listDesktopProcesses counts the wails dev app beside floe-desktop.exe, and nothing else', async () => {
    const rows = [
        { image: EXE_NAME, pid: 1 },
        { image: DEV_EXE_NAME, pid: 2 },
        { image: 'floe.exe', pid: 3 },
        { image: 'floe-g2-helper.exe', pid: 4 },
        { image: 'wails.exe', pid: 5 },
    ];
    assert.deepEqual(
        (await listDesktopProcesses(async () => rows)).map((r) => r.pid),
        [1, 2]
    );
});

function portableLeg(dir, { lister, launcher, secondInstanceWaitMs, cellId = 'T-FU26-SECOND' }) {
    return new DesktopLeg({
        role: 'receiver',
        cellId,
        input: 'code',
        code: 'a-b-c',
        outDir: path.join(dir, 'out'),
        build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
        scratch: dir,
        uia: {
            log() {},
            async findWindow() {
                return { hwnd: 7, pid: 8181, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
            },
            async waitTree() {
                return { ready: true };
            },
        },
        lister,
        launcher,
        secondInstanceWaitMs,
        monitor: 'off',
        shellMenu: new ShellMenuGuard({ platform: 'linux' }),
        infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
    });
}

test('a leg never starts a second instance: a running floe-desktop.exe or wails dev app is SKIP desktop-running before anything is seeded or launched', async () => {
    for (const image of [EXE_NAME, DEV_EXE_NAME]) {
        const dir = tmp();
        let launched = 0;
        try {
            const leg = portableLeg(dir, {
                lister: async () => [{ image, pid: 9090 }],
                launcher: async () => {
                    launched += 1;
                    return { child: null, pid: 1 };
                },
            });
            await assert.rejects(leg.launch([]), (e) => {
                assert.ok(e instanceof PhaseError, e.stack);
                assert.equal(e.verdict, 'SKIP');
                assert.equal(e.reason, 'desktop-running');
                assert.equal(e.phase, 'start');
                assert.match(e.message, new RegExp(`${image.replace('.', '\\.')} pid 9090 already runs`));
                return true;
            });
            assert.equal(launched, 0, 'no launcher ran');
            assert.ok(!existsSync(path.join(dir, 'appdata', 'floe', 'desktop.json')), 'nothing was seeded');
            assert.ok(!activeLegs.has(leg), 'nothing for shutdown() to own');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('an instance this process started and is still closing gets the wait; one that outlives it is SKIP desktop-running', async () => {
    const own = 9191;
    started.set(own, { image: EXE_NAME, label: 'T-FU26:earlier', argv: [], exited: null });
    const dir = tmp();
    try {
        let polls = 0;
        let launched = 0;
        const leg = portableLeg(dir, {
            cellId: 'T-FU26-CLOSING',
            lister: async () => (++polls <= 2 ? [{ image: EXE_NAME, pid: own }] : []),
            launcher: async () => {
                launched += 1;
                return { child: null, pid: 8181 };
            },
            secondInstanceWaitMs: 5_000,
        });
        await leg.launch([]);
        assert.equal(launched, 1, 'launched once the earlier instance was gone');
        assert.ok(polls >= 3);
        activeLegs.delete(leg);
        started.delete(8181);

        const stuck = portableLeg(dir, {
            cellId: 'T-FU26-STUCK',
            lister: async () => [{ image: EXE_NAME, pid: own }],
            launcher: async () => {
                throw new Error('must not launch');
            },
            secondInstanceWaitMs: 300,
        });
        const t0 = Date.now();
        await assert.rejects(stuck.launch([]), (e) => e.reason === 'desktop-running');
        assert.ok(Date.now() - t0 >= 250, 'it waited before refusing');
    } finally {
        started.delete(own);
        for (const l of activeLegs) if (/^T-FU26/.test(l.opts.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the wailsdev lane launches nothing, so it never asks for the process list', async () => {
    const leg = new DesktopLeg({
        role: 'sender',
        cellId: 'T-FU26-DEV',
        files: ['a'],
        build: { launch: 'wailsdev' },
        infra: { server: 'http://localhost:3001', web: 'http://localhost:3000' },
        lister: async () => {
            throw new Error('the wailsdev lane must not list processes');
        },
        shellMenu: new ShellMenuGuard({ platform: 'linux' }),
        openDriver: async () => ({
            async waitTree() {
                return { ready: true };
            },
            async settings() {
                return { reportStats: true, migrated: true, server: 'http://localhost:3001' };
            },
        }),
    });
    assert.ok(await leg.launch());
    activeLegs.delete(leg);
});

test('desktop.mjs starts no exe itself: no spawn import, no visible window option, every launch through launchDetached', () => {
    const src = readFileSync(path.join(HERE, 'desktop.mjs'), 'utf8');
    assert.match(src, /^import \{ execFile \} from 'node:child_process';$/m);
    assert.ok(!/\bspawn\(/.test(src), 'no spawn( call left in desktop.mjs');
    assert.ok(!/windowsHide:\s*false/.test(src), 'no child is started visible');
    const body = src.slice(src.indexOf('export async function launchProcess('), src.indexOf('function taskkill(pid)'));
    assert.equal((body.match(/await detach\(/g) || []).length, 2, 'the AUMID form and the exe form');
    assert.match(body, /detach = launchDetached/);
});
