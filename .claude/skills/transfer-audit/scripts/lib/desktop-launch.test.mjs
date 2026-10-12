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

function portableLeg(dir, { lister, launcher, secondInstanceWaitMs, cellId = 'T-FU26-SECOND', userAway = false, uia = null }) {
    return new DesktopLeg({
        role: 'receiver',
        cellId,
        input: 'code',
        code: 'a-b-c',
        outDir: path.join(dir, 'out'),
        build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
        scratch: dir,
        userAway,
        uia: uia ?? {
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
    // F1: the one direct start is lib/detached.mjs launchDirect, reached from
    // one place, behind the three conditions and the away gate.
    assert.equal(
        (body.match(/await direct\(/g) || []).length,
        1,
        'one fallback call site'
    );
    assert.match(body, /direct = launchDirect/);
    assert.match(
        body,
        /err\.returnValue === 2 &&\s+plan\.mode === 'store' &&\s+plan\.filesStaged/
    );
    const lib = readFileSync(path.join(HERE, 'detached.mjs'), 'utf8');
    assert.equal(
        (lib.match(/\bspawnImpl\(/g) || []).length,
        1,
        'one spawn in the launch library'
    );
});

test('with --user-away every exe leg re-reads the idle time before each UIA pattern call; without it the leg does not (FU-28, G2-F1)', async () => {
    const dir = tmp();
    try {
        const calls = [];
        const client = {
            idle: 10,
            log() {},
            async findWindow() {
                return { hwnd: 7, pid: 8282, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
            },
            async waitTree() {
                return { ready: true };
            },
            async foregroundCheck() {
                calls.push('foreground-check');
                return { idleSeconds: this.idle, foreground: false };
            },
            async retry(cmd) {
                calls.push(cmd);
                return { ok: true };
            },
        };
        const away = portableLeg(dir, {
            cellId: 'T-FU28-AWAY',
            lister: async () => [],
            launcher: async () => ({ child: null, pid: 8282 }),
            userAway: true,
            uia: client,
        });
        await away.launch([]);
        assert.equal(away.driver.awayOnly, true);
        await assert.rejects(away.driver.click('Send'), (e) => e.verdict === 'SKIP' && e.reason === 'present');
        assert.deepEqual(calls, ['foreground-check'], 'the idle read came first and nothing was clicked');
        client.idle = 300;
        await away.driver.click('Send');
        assert.deepEqual(calls, ['foreground-check', 'foreground-check', 'click']);
        activeLegs.delete(away);
        started.delete(8282);

        calls.length = 0;
        const present = portableLeg(dir, {
            cellId: 'T-FU28-PRESENT',
            lister: async () => [],
            launcher: async () => ({ child: null, pid: 8383 }),
            uia: { ...client, async findWindow() { return { hwnd: 7, pid: 8383, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false }; } },
        });
        await present.launch([]);
        assert.equal(present.driver.awayOnly, false, 'no --user-away: the old presence model, unchanged');
        activeLegs.delete(present);
        started.delete(8383);
    } finally {
        for (const l of activeLegs) if (/^T-FU28/.test(l.opts.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

// F1 (field run 2026-10-11): Win32_Process.Create refuses the Store package's
// exe when it carries files (return value 2, access denied), which is how a
// Store sender cell stages them. That one launch, and no other, falls back to
// a direct spawn, and only with the owner away: a child of this process can
// take the foreground, which is the very thing the detached launch exists to
// prevent.
const STORE_EXE =
    'C:\\Program Files\\WindowsApps\\JanCarloParedes.FloeDesktop_1.3.0.0_x64__r1y5w9chaxnzc\\floe-desktop.exe';

function refusing(code) {
    const calls = [];
    const detach = async (o) => {
        calls.push(o);
        throw Object.assign(
            new Error(`detached launch: Win32_Process.Create returned ${code}`),
            { returnValue: code }
        );
    };
    return { calls, detach };
}

function directRecorder(pid = 7373) {
    const calls = [];
    const direct = async (o) => {
        calls.push(o);
        return { pid };
    };
    return { calls, direct };
}

test('launchProcess falls back to a direct spawn exactly once, and only for the Store exe with files refused as access denied while the owner is away', async () => {
    const dir = tmp();
    try {
        const plan = planLaunch({
            mode: 'store',
            storeExe: STORE_EXE,
            files: ['C:\\in\\a.bin'],
            env: { APPDATA: 'C:\\u\\AppData\\Roaming' },
        });
        assert.equal(plan.filesStaged, true);
        const wmi = refusing(2);
        const d = directRecorder();
        const out = await launchProcess(plan, {
            evidenceDir: path.join(dir, 'ev'),
            detach: wmi.detach,
            direct: d.direct,
            allowDirect: true,
        });
        assert.deepEqual(out, {
            child: null,
            pid: 7373,
            detached: false,
            direct: true,
        });
        assert.equal(
            wmi.calls.length,
            1,
            'the detached launch was tried first, once'
        );
        assert.deepEqual(d.calls, [
            {
                command: STORE_EXE,
                args: ['C:\\in\\a.bin'],
                cwd: path.dirname(STORE_EXE),
            },
        ]);
        const note = readFileSync(
            path.join(dir, 'ev', 'desktop.launch.txt'),
            'utf8'
        );
        assert.match(
            note,
            /^direct launch \(F1\): Win32_Process\.Create returned 2 \(access denied\) for the Store exe with files, so this process spawned it itself, pid 7373/
        );
        assert.ok(
            !/detached launch \(FU-26\)/.test(note),
            'the file names the path that was taken, not both'
        );

        // The same refusal with the owner at the PC: nothing is spawned.
        const present = directRecorder();
        await assert.rejects(
            launchProcess(plan, {
                evidenceDir: path.join(dir, 'ev2'),
                detach: refusing(2).detach,
                direct: present.direct,
            }),
            (e) => {
                assert.ok(e instanceof PhaseError, e.stack);
                assert.equal(e.verdict, 'SKIP');
                assert.equal(e.reason, 'present');
                assert.equal(e.phase, 'start');
                assert.match(e.message, /--user-away/);
                return true;
            }
        );
        assert.equal(present.calls.length, 0);
        assert.ok(
            !existsSync(path.join(dir, 'ev2', 'desktop.launch.txt')),
            'no launch, no launch note'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('launchProcess never falls back for a portable exe, for the AUMID form, for another return value, or when the detached launch works', async () => {
    const dir = tmp();
    try {
        const none = directRecorder();
        const opts = (code) => ({
            detach: refusing(code).detach,
            direct: none.direct,
            allowDirect: true,
        });
        const portable = planLaunch({
            mode: 'portable',
            exe: 'C:\\s\\floe-desktop.exe',
            files: ['C:\\in\\a.bin'],
            scratch: dir,
            env: { SystemRoot: 'C:\\Windows' },
        });
        await assert.rejects(
            launchProcess(portable, opts(2)),
            (e) => e.returnValue === 2 && e.verdict === undefined
        );
        const aumid = planLaunch({
            mode: 'store',
            env: { APPDATA: 'C:\\u\\AppData\\Roaming' },
        });
        assert.equal(aumid.command, 'explorer.exe');
        await assert.rejects(
            launchProcess(aumid, opts(2)),
            (e) => e.returnValue === 2
        );
        const store = planLaunch({
            mode: 'store',
            storeExe: STORE_EXE,
            files: ['C:\\in\\a.bin'],
            env: { APPDATA: 'C:\\u\\AppData\\Roaming' },
        });
        await assert.rejects(
            launchProcess(store, opts(9)),
            (e) => e.returnValue === 9,
            'path not found is not a reason to try again'
        );
        // And when Win32_Process.Create takes the Store exe, that is the launch.
        const fine = recorder(6262);
        assert.deepEqual(
            await launchProcess(store, {
                detach: fine.detach,
                direct: none.direct,
                allowDirect: true,
            }),
            { child: null, pid: 6262, detached: true }
        );
        assert.equal(
            none.calls.length,
            0,
            'no direct spawn in any of the four'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a leg allows the direct fallback only on a --user-away run', async () => {
    const dir = tmp();
    try {
        for (const [userAway, pid] of [
            [true, 8484],
            [false, 8585],
        ]) {
            const seen = [];
            const leg = portableLeg(dir, {
                cellId: `T-F1-${userAway ? 'AWAY' : 'PRESENT'}`,
                lister: async () => [],
                userAway,
                launcher: async (plan, o) => {
                    seen.push(o);
                    return { child: null, pid };
                },
                uia: {
                    log() {},
                    async findWindow() {
                        return {
                            hwnd: 7,
                            pid,
                            exe: 'C:\\bogus\\floe-desktop.exe',
                            minimized: false,
                        };
                    },
                    async waitTree() {
                        return { ready: true };
                    },
                },
            });
            await leg.launch([]);
            assert.equal(seen.length, 1);
            assert.equal(seen[0].allowDirect, userAway);
            activeLegs.delete(leg);
            started.delete(pid);
        }
    } finally {
        for (const l of activeLegs)
            if (/^T-F1/.test(l.opts.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a leg notes a direct start and reports which way it launched', async () => {
    const dir = tmp();
    try {
        const leg = portableLeg(dir, {
            cellId: 'T-F1-NOTE',
            lister: async () => [],
            userAway: true,
            launcher: async () => ({
                child: null,
                pid: 8686,
                detached: false,
                direct: true,
            }),
            uia: {
                log() {},
                async findWindow() {
                    return {
                        hwnd: 7,
                        pid: 8686,
                        exe: 'C:\\bogus\\floe-desktop.exe',
                        minimized: false,
                    };
                },
                async waitTree() {
                    return { ready: true };
                },
            },
        });
        await leg.launch([]);
        assert.equal(leg.evidence().launch.started, 'direct');
        assert.ok(
            leg.notes.some((n) => /started directly/.test(n)),
            leg.notes.join('\n')
        );
        activeLegs.delete(leg);
        started.delete(8686);
    } finally {
        for (const l of activeLegs)
            if (/^T-F1/.test(l.opts.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});
