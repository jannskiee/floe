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
    RELEASE_FIND_MS,
    ShellMenuGuard,
    UNFOUND_BORN_MS,
    UNFOUND_LOOK_MS,
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

// A leg launches only on a run that said the owner is away or accepted the
// focus change (DesktopLeg.refuseUnlessAllowed), so the helper passes one of
// the two; and an away leg reads the idle time before it launches, which a
// fake helper answers with a long idle unless the test gives its own.
const withIdle = (client) =>
    typeof client.idleSeconds === 'function'
        ? client
        : Object.assign(client, { idleSeconds: async () => 300 });
function portableLeg(dir, { lister, launcher, secondInstanceWaitMs, cellId = 'T-FU26-SECOND', userAway = false, allowForeground = !userAway, noIdleCheck = false, shared = undefined, uia = null }) {
    return new DesktopLeg({
        role: 'receiver',
        cellId,
        input: 'code',
        code: 'a-b-c',
        outDir: path.join(dir, 'out'),
        build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
        scratch: dir,
        userAway,
        allowForeground,
        noIdleCheck,
        shared,
        uia: withIdle(uia ?? {
            log() {},
            async findWindow() {
                return { hwnd: 7, pid: 8181, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
            },
            async waitTree() {
                return { ready: true };
            },
        }),
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

// ------------------------------------------------ the launcher's own stops

// The planner SKIPs every desktop cell of a run that said neither that the
// owner is away nor that the focus change is accepted (lib/matrix.mjs
// foregroundRefused). That gate lives in the plan; this one lives in the
// thing that launches, so a leg built any other way still reaches no window.
test('an exe leg of a run that carried neither --user-away nor --allow-foreground launches nothing and changes nothing', async () => {
    const dir = tmp();
    try {
        let launched = 0;
        const leg = portableLeg(dir, {
            cellId: 'T-GATE-NONE',
            allowForeground: false,
            lister: async () => {
                throw new Error('not even the process list is read');
            },
            launcher: async () => {
                launched++;
                return { child: null, pid: 9191 };
            },
        });
        await assert.rejects(leg.launch([]), (e) => {
            assert.equal(e.verdict, 'SKIP');
            assert.equal(e.reason, 'present');
            assert.match(e.message, /neither --user-away nor --allow-foreground/);
            return true;
        });
        assert.equal(launched, 0);
        assert.equal(existsSync(path.join(dir, 'appdata')), false, 'no profile was seeded');
        assert.equal(leg.driver, null);
        assert.equal(activeLegs.has(leg), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('with --user-away the idle time is read before anything is seeded or launched; an idle that is short or cannot be read stops the leg as SKIP present', async () => {
    const dir = tmp();
    try {
        const client = (idleSeconds) => ({
            log() {},
            idleSeconds,
            async findWindow() {
                return { hwnd: 7, pid: 9292, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
            },
            async waitTree() {
                return { ready: true };
            },
        });
        for (const [what, idleSeconds, shown] of [
            ['the owner typed 10 s ago', async () => 10, /input idle 10 s \(< 120\)/],
            [
                'the helper cannot say',
                async () => {
                    throw new Error('helper gone');
                },
                /input idle unknown s/,
            ],
            ['the helper answers nonsense', async () => 'soon', /input idle unknown s/],
        ]) {
            let launched = 0;
            const leg = portableLeg(dir, {
                cellId: 'T-GATE-IDLE',
                userAway: true,
                lister: async () => [],
                launcher: async () => {
                    launched++;
                    return { child: null, pid: 9292 };
                },
                uia: client(idleSeconds),
            });
            await assert.rejects(
                leg.launch([]),
                (e) => {
                    assert.equal(e.verdict, 'SKIP', what);
                    assert.equal(e.reason, 'present', what);
                    assert.match(e.message, shown, what);
                    assert.match(e.message, /nothing was launched or changed/, what);
                    return true;
                },
                what
            );
            assert.equal(launched, 0, what);
            assert.equal(existsSync(path.join(dir, 'appdata')), false, `${what}: no profile was seeded`);
            activeLegs.delete(leg);
        }
        // Idle long enough: the same leg launches.
        let launched = 0;
        const ok = portableLeg(dir, {
            cellId: 'T-GATE-IDLE-OK',
            userAway: true,
            lister: async () => [],
            launcher: async () => {
                launched++;
                return { child: null, pid: 9292 };
            },
            uia: client(async () => 120),
        });
        await ok.launch([]);
        assert.equal(launched, 1);
        assert.equal(ok.driver.awayOnly, true);
        activeLegs.delete(ok);
        started.delete(9292);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('--no-idle-check: the leg launches and clicks without one read of the idle time', async () => {
    const dir = tmp();
    try {
        const calls = [];
        const leg = portableLeg(dir, {
            cellId: 'T-GATE-NOIDLE',
            userAway: true,
            noIdleCheck: true,
            lister: async () => [],
            launcher: async () => ({ child: null, pid: 9393 }),
            uia: {
                log() {},
                async idleSeconds() {
                    throw new Error('the idle time must not be read');
                },
                async foregroundCheck() {
                    throw new Error('the idle time must not be read');
                },
                async findWindow() {
                    return { hwnd: 7, pid: 9393, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
                },
                async waitTree() {
                    return { ready: true };
                },
                async retry(cmd) {
                    calls.push(cmd);
                    return { ok: true };
                },
            },
        });
        await leg.launch([]);
        assert.equal(leg.driver.awayOnly, false);
        await leg.driver.click('Send');
        assert.deepEqual(calls, ['click']);
        activeLegs.delete(leg);
        started.delete(9393);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

// Putting the owner's app back is the one thing an away-only leg does with
// less than 120 s of idle input: an owner who came back mid-cell would
// otherwise be left with what the cell changed.
test('a release step waits for a short pause in input instead of being refused, and is not sent into continuous typing', async () => {
    const dir = tmp();
    try {
        const calls = [];
        const client = {
            idle: 10,
            log() {},
            async idleSeconds() {
                return 300;
            },
            async findWindow() {
                return { hwnd: 7, pid: 9494, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
            },
            async waitTree() {
                return { ready: true };
            },
            async foregroundCheck() {
                calls.push('foreground-check');
                return { idleSeconds: typeof this.idle === 'function' ? this.idle() : this.idle, foreground: false };
            },
            async retry(cmd) {
                calls.push(cmd);
                return { ok: true };
            },
            // A release call goes out through request, one attempt at a time.
            sent: [],
            answers: [],
            async request(cmd, params) {
                calls.push(cmd);
                this.sent.push({ cmd, timeoutMs: params.timeoutMs });
                const next = this.answers.shift();
                if (next) throw next;
                return { ok: true };
            },
        };
        const leg = portableLeg(dir, {
            cellId: 'T-GATE-RELEASE',
            userAway: true,
            lister: async () => [],
            launcher: async () => ({ child: null, pid: 9494 }),
            uia: client,
        });
        await leg.launch([]);
        const d = leg.driver;
        // Mid-cell, the owner 10 s back: an ordinary step is refused.
        await assert.rejects(d.click('Make link'), (e) => e.verdict === 'SKIP' && e.reason === 'present');
        assert.deepEqual(calls, ['foreground-check']);
        // The same moment, releasing: 10 s is pause enough.
        calls.length = 0;
        d.releasing = true;
        await d.click('Close link');
        assert.deepEqual(calls, ['foreground-check', 'click']);
        // And the helper is given a second to find the element, not its
        // usual five: the call lands next to the pause that allowed it
        // (second review of #542, finding C).
        assert.deepEqual(client.sent, [{ cmd: 'click', timeoutMs: RELEASE_FIND_MS }]);
        assert.equal(RELEASE_FIND_MS, 1_000);

        // An element that is not there yet is tried once more, and the pause
        // is read again first: a retry that read nothing could land in typing.
        calls.length = 0;
        client.sent.length = 0;
        const missing = () => Object.assign(new Error('no such element'), { reason: 'not-found' });
        client.answers = [missing()];
        await d.click('Make another link');
        assert.deepEqual(calls, ['foreground-check', 'click', 'foreground-check', 'click']);
        // Twice missing is the helper's own refusal, after two reads.
        calls.length = 0;
        client.answers = [missing(), missing()];
        await assert.rejects(d.click('Make another link'), (e) => e.reason === 'not-found');
        assert.deepEqual(calls, ['foreground-check', 'click', 'foreground-check', 'click']);
        // Any other refusal is not tried again, and a set is sent once.
        calls.length = 0;
        client.answers = [Object.assign(new Error('greyed'), { reason: 'disabled' })];
        await assert.rejects(d.click('Close link'), (e) => e.reason === 'disabled');
        assert.deepEqual(calls, ['foreground-check', 'click']);
        calls.length = 0;
        client.sent.length = 0;
        client.answers = [missing()];
        await assert.rejects(d.setValue('Downloads\\Floe', 'D:\\owner'), (e) => e.reason === 'not-found');
        assert.deepEqual(calls, ['foreground-check', 'set-value']);
        assert.deepEqual(client.sent, [{ cmd: 'set-value', timeoutMs: RELEASE_FIND_MS }]);
        // The owner back in the middle of the two attempts: the second is
        // never sent.
        calls.length = 0;
        client.answers = [missing()];
        const seen = [10, 0];
        client.idle = () => (seen.length > 1 ? seen.shift() : seen[0]);
        d._releaseUntil = null;
        d.releaseWaitMs = 30;
        d.releasePollMs = 5;
        await assert.rejects(d.click('Make another link'), /did not pause for 3 s/);
        assert.equal(calls.filter((c) => c === 'click').length, 1);
        client.idle = 10;

        // Typing now, then a pause: the step waits and goes out after it.
        calls.length = 0;
        d._releaseUntil = null;
        d.releaseWaitMs = 2_000;
        d.releasePollMs = 5;
        const readings = [0, 1, 2, 3];
        client.idle = () => (readings.length > 1 ? readings.shift() : readings[0]);
        await d.click('Close link');
        assert.deepEqual(calls, [
            'foreground-check',
            'foreground-check',
            'foreground-check',
            'foreground-check',
            'click',
        ]);

        // Typing through the whole release: not sent, not a SKIP, and the
        // deadline is one for the release, not one per step.
        calls.length = 0;
        client.idle = 1;
        d._releaseUntil = null;
        d.releaseWaitMs = 40;
        await assert.rejects(d.click('Close link'), (e) => {
            assert.equal(e.verdict, undefined, 'a release that could not be sent is not a SKIP');
            assert.match(e.message, /did not pause for 3 s within/);
            assert.match(e.message, /this step was not sent/);
            return true;
        });
        assert.ok(!calls.includes('click'));
        const t0 = Date.now();
        await assert.rejects(d.setValue('Downloads\\Floe', 'D:\\owner'), /did not pause for 3 s/);
        assert.ok(Date.now() - t0 < 30, 'the second step does not start a new wait');
        // An unreadable idle time counts as input.
        client.foregroundCheck = async () => {
            throw new Error('helper gone');
        };
        await assert.rejects(d.click('Close link'), /did not pause for 3 s/);
        // A window that is gone is not somebody typing: said at once, with
        // no wait, and not as a pause that never came.
        client.foregroundCheck = async () => {
            throw Object.assign(new Error('hwnd 7'), { reason: 'not-a-window' });
        };
        d._releaseUntil = null;
        d.releaseWaitMs = 60_000;
        const g0 = Date.now();
        await assert.rejects(d.click('Close link'), /the Floe window is gone, so this step of the release could not be sent/);
        assert.ok(Date.now() - g0 < 1_000, 'no polling for a window that is not there');
        activeLegs.delete(leg);
        started.delete(9494);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('once a cell could not put the app back, no later exe leg of the run launches', async () => {
    const dir = tmp();
    try {
        for (const flags of [{ userAway: true }, { allowForeground: true }, { userAway: true, noIdleCheck: true }]) {
            let launched = 0;
            const leg = portableLeg(dir, {
                cellId: 'T-GATE-LATCH',
                ...flags,
                shared: { desktopNotReleased: 'host release: the link this cell made still reads waiting' },
                lister: async () => [],
                launcher: async () => {
                    launched++;
                    return { child: null, pid: 9595 };
                },
            });
            await assert.rejects(leg.launch([]), (e) => {
                assert.equal(e.verdict, 'SKIP');
                assert.equal(e.reason, 'desktop-not-released');
                assert.match(e.message, /the link this cell made still reads waiting/);
                return true;
            });
            assert.equal(launched, 0, JSON.stringify(flags));
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ------------------------------------------------ review of #542, findings 2 and 8

test('a leg does not launch into another leg that is still stopping: it waits for that stop, inside a bound', async () => {
    const dir = tmp();
    try {
        const order = [];
        let release;
        const stopping = {
            opts: { cellId: 'T-GATE-STOPPING' },
            _stopPromise: new Promise((r) => (release = r)).then(() => order.push('stop finished')),
        };
        activeLegs.add(stopping);
        const leg = portableLeg(dir, {
            cellId: 'T-GATE-AFTER-STOP',
            lister: async () => {
                order.push('process list read');
                return [];
            },
            launcher: async () => {
                order.push('launched');
                return { child: null, pid: 9696 };
            },
        });
        const launching = leg.launch([]);
        await new Promise((r) => setTimeout(r, 30));
        assert.deepEqual(order, [], 'nothing yet: the other leg is still stopping');
        release();
        await launching;
        assert.deepEqual(order.slice(0, 2), ['stop finished', 'process list read']);
        assert.ok(order.includes('launched'));
        activeLegs.delete(stopping);
        activeLegs.delete(leg);
        started.delete(9696);

        // A stop that never ends does not hold the run forever.
        const stuck = { opts: { cellId: 'T-GATE-STUCK' }, _stopPromise: new Promise(() => {}) };
        activeLegs.add(stuck);
        const late = new DesktopLeg({
            role: 'receiver',
            cellId: 'T-GATE-AFTER-STUCK',
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, 'out2'),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            allowForeground: true,
            stopWaitMs: 40,
            uia: {
                log() {},
                async findWindow() {
                    return { hwnd: 7, pid: 9797, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
                },
                async waitTree() {
                    return { ready: true };
                },
            },
            lister: async () => [],
            launcher: async () => ({ child: null, pid: 9797 }),
            monitor: 'off',
            shellMenu: new ShellMenuGuard({ platform: 'linux' }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        const t0 = Date.now();
        await late.launch([]);
        assert.ok(Date.now() - t0 < 5_000, 'the bound, not the stuck stop');
        activeLegs.delete(stuck);
        activeLegs.delete(late);
        started.delete(9797);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

// The wait for an earlier leg is longer than the start phase it runs inside.
// A cell's start timed out, its teardown stopped the leg, and the launch then
// went ahead anyway: an app nothing closed until finalize killed it (second
// review of #542, finding B).
test('a leg stopped while its launch waited launches nothing', async () => {
    const dir = tmp();
    try {
        const stuck = { opts: { cellId: 'T-GATE-STUCK2' }, _stopPromise: new Promise(() => {}) };
        activeLegs.add(stuck);
        let launches = 0;
        const leg = portableLeg(dir, {
            cellId: 'T-GATE-STOPPED-WAITING',
            lister: async () => [],
            launcher: async () => {
                launches += 1;
                return { child: null, pid: 9898 };
            },
        });
        leg.opts.stopWaitMs = 150;
        const launching = leg.launch([]);
        const seen = launching.then(
            () => null,
            (e) => e
        );
        await new Promise((r) => setTimeout(r, 30));
        // The cell's teardown, while the launch still waits for the other leg.
        const stopping = leg.stop('timeout');
        const err = await seen;
        await stopping;
        assert.ok(err instanceof PhaseError, String(err));
        assert.match(err.message, /stopped while it was starting/);
        assert.equal(launches, 0, 'nothing was launched after the stop');
        assert.equal(leg.driver, null);
        assert.equal(activeLegs.has(leg), false);
        activeLegs.delete(stuck);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a leg stopped during its launch call has that app ended by the stop', async () => {
    const dir = tmp();
    try {
        let up = false;
        let letGo;
        const killed = [];
        const leg = new DesktopLeg({
            role: 'receiver',
            cellId: 'T-GATE-STOPPED-LAUNCHING',
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, 'out'),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            allowForeground: true,
            uia: {
                log() {},
                async findWindow() {
                    throw new Error('the window search must not start after a stop');
                },
                async close() {},
            },
            lister: async () => (up ? [{ image: EXE_NAME, pid: 4545 }] : []),
            launcher: () =>
                new Promise((resolve) => {
                    letGo = () => {
                        up = true;
                        resolve({ child: null, pid: 4545 });
                    };
                }),
            kill: async (pid) => {
                killed.push(pid);
                up = false;
            },
            monitor: 'off',
            shellMenu: new ShellMenuGuard({ platform: 'linux' }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        const seen = leg.launch([]).then(
            () => null,
            (e) => e
        );
        // Until the launch call is in flight.
        const until = Date.now() + 5_000;
        while (!letGo && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
        assert.equal(typeof letGo, 'function');
        const stopping = leg.stop('timeout');
        await new Promise((r) => setTimeout(r, 30));
        assert.deepEqual(killed, [], 'the stop waits for the launch call');
        letGo();
        const err = await seen;
        await stopping;
        assert.match(String(err && err.message), /stopped while it was starting/);
        assert.deepEqual(killed, [4545], 'the app the launch started is ended');
        assert.equal(activeLegs.has(leg), false);
        started.delete(4545);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a launch whose window is never found is still ended at stop, by the process list', async () => {
    const dir = tmp();
    try {
        let up = false;
        const killed = [];
        const leg = new DesktopLeg({
            role: 'receiver',
            cellId: 'T-GATE-UNFOUND',
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, 'out'),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            allowForeground: true,
            uia: {
                log() {},
                async findWindow() {
                    throw new Error('no window within the timeout');
                },
                async close() {},
            },
            // Nothing runs before the launch; the app does afterwards.
            lister: async () => (up ? [{ image: EXE_NAME, pid: 4321 }] : []),
            launcher: async () => {
                up = true;
                return { child: null, pid: null };
            },
            kill: async (pid) => {
                killed.push(pid);
                up = false;
            },
            // The launch returned no pid, so the creation time is the proof.
            creationTime: async () => new Date().toISOString(),
            monitor: 'off',
            shellMenu: new ShellMenuGuard({ platform: 'linux' }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        await assert.rejects(leg.launch([]), /no window within the timeout/);
        assert.equal(leg.driver, null);
        await leg.stop('failed');
        assert.deepEqual(killed, [4321]);
        assert.ok(leg.notes.some((n) => /unfound app: ended floe-desktop\.exe pid 4321/.test(n)), leg.notes.join('\n'));
        // A leg that never launched ends nothing.
        const never = portableLeg(dir, {
            cellId: 'T-GATE-NEVER',
            allowForeground: false,
            lister: async () => [{ image: EXE_NAME, pid: 999 }],
            launcher: async () => ({ child: null, pid: null }),
        });
        await assert.rejects(never.launch([]), (e) => e.reason === 'present');
        await never.stop('failed');
        assert.deepEqual(killed, [4321], "the owner's own app is never ended");
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

// "Nothing ran before this launch" does not make every process that runs
// afterwards this leg's. The owner can open Floe in the half minute the window
// search takes, and a `wails dev` app has an image of its own; the stop used
// to end all of them (second review of #542, finding D).
test('a launch that never found its window ends only the process it can show is its own', async () => {
    const dir = tmp();
    const unfound = (over) => {
        const killed = [];
        let up = false;
        const leg = new DesktopLeg({
            role: 'receiver',
            cellId: `T-GATE-OWN-${over.id}`,
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, `out-${over.id}`),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            allowForeground: true,
            uia: {
                log() {},
                async findWindow() {
                    throw new Error('no window within the timeout');
                },
                async close() {},
            },
            lister: async () => (up ? over.rows : []),
            launcher: async () => {
                up = true;
                return { child: null, pid: over.launchPid ?? null };
            },
            kill: async (pid) => {
                killed.push(pid);
            },
            creationTime: over.creationTime,
            monitor: 'off',
            shellMenu: new ShellMenuGuard({ platform: 'linux' }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        return { leg, killed };
    };
    const run = async (over) => {
        const { leg, killed } = unfound(over);
        await assert.rejects(leg.launch([]), /no window within the timeout/);
        await leg.stop('failed');
        return { killed, notes: leg.notes.join('\n') };
    };
    const now = () => new Date().toISOString();
    try {
        // A wails dev app is never an exe lane's.
        let r = await run({
            id: 'dev',
            rows: [{ image: DEV_EXE_NAME, pid: 11 }],
            creationTime: async () => now(),
        });
        assert.deepEqual(r.killed, []);
        assert.match(r.notes, /left floe-desktop-dev\.exe pid 11 running \(not the image an exe lane launches\)/);

        // With a pid from the launch call, only that pid.
        r = await run({
            id: 'pid',
            launchPid: 21,
            rows: [
                { image: EXE_NAME, pid: 21 },
                { image: EXE_NAME, pid: 22 },
            ],
            creationTime: async () => now(),
        });
        assert.deepEqual(r.killed, [21]);
        assert.match(r.notes, /left floe-desktop\.exe pid 22 running \(not pid 21, which the launch returned\)/);

        // Without one, the creation time decides: before the launch, long
        // after it, and unreadable all leave the process alone.
        const at = (deltaMs) => async () => new Date(Date.now() + deltaMs).toISOString();
        r = await run({ id: 'before', rows: [{ image: EXE_NAME, pid: 31 }], creationTime: at(-60_000) });
        assert.deepEqual(r.killed, []);
        assert.match(r.notes, /pid 31 running \(created before this launch\)/);

        r = await run({ id: 'after', rows: [{ image: EXE_NAME, pid: 32 }], creationTime: at(UNFOUND_BORN_MS + 30_000) });
        assert.deepEqual(r.killed, []);
        assert.match(r.notes, /pid 32 running \(created more than 15 s after this launch returned\)/);

        for (const unreadable of [async () => null, async () => 'not a date', async () => { throw new Error('wmi'); }]) {
            r = await run({ id: 'unread', rows: [{ image: EXE_NAME, pid: 33 }], creationTime: unreadable });
            assert.deepEqual(r.killed, []);
            assert.match(r.notes, /pid 33 running \(its creation time could not be read\)/);
        }

        // Inside the window it is the leg's, and ended.
        r = await run({ id: 'own', rows: [{ image: EXE_NAME, pid: 34 }], creationTime: at(1_000) });
        assert.deepEqual(r.killed, [34]);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

// Second review of #542, finding H. The Store lane never armed the Explorer
// verb guard. A packaged launch does not touch the key, but the Store exe
// started directly is the one launch whose package identity no run has shown,
// and a Floe without identity registers the verb for itself at startup.
test('the Store lane arms the Explorer verb guard too, naming the package exe', () => {
    const dir = tmp();
    try {
        const calls = [];
        const fakeMenu = (state) => ({
            take(note) {
                calls.push('take');
                note(`explorer verb: ${state}`);
                return state;
            },
            own(exe) {
                calls.push(`own ${exe}`);
            },
            restore() {
                calls.push('restore');
                return { wrote: false, match: true };
            },
        });
        const leg = (state) =>
            new DesktopLeg({
                role: 'sender',
                cellId: 'T-GATE-MENU',
                outDir: path.join(dir, 'out'),
                build: { launch: 'store' },
                scratch: dir,
                allowForeground: true,
                uia: { log() {} },
                lister: async () => [],
                launcher: async () => ({ child: null, pid: null }),
                monitor: 'off',
                shellMenu: fakeMenu(state),
                infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
            });
        const exe = 'C:\\Program Files\\WindowsApps\\Floe_1.3.0.0_x64__abc\\floe-desktop.exe';
        for (const state of ['absent', 'armed']) {
            calls.length = 0;
            const l = leg(state);
            l.armShellMenu(exe);
            assert.equal(l.shellMenuArmed, true, state);
            assert.deepEqual(calls, ['take', `own ${exe}`]);
        }
        // A registry that cannot be read, or holds half a key, is left alone.
        for (const state of ['unreadable', 'incomplete', 'off']) {
            calls.length = 0;
            const l = leg(state);
            l.armShellMenu(exe);
            assert.equal(l.shellMenuArmed, false, state);
            assert.deepEqual(calls, ['take']);
        }
        // An AUMID launch has no exe path to name before the window is found.
        calls.length = 0;
        const plain = leg('absent');
        plain.armShellMenu(null);
        assert.equal(plain.shellMenuArmed, true);
        assert.deepEqual(calls, ['take']);

        // Both exe lanes go through it, each after its own config step. The
        // source is read by single lines only: a Windows runner checks the
        // file out with CRLF, and a search across a line break found nothing
        // there (the first CI run of this test).
        const src = readFileSync(fileURLToPath(new URL('./desktop.mjs', import.meta.url)), 'utf8');
        const launch = src.slice(src.indexOf('    async _launch(files = []) {'), src.indexOf('    spend(kind) {'));
        assert.ok(launch.length > 1000 && launch.indexOf('this.guard = new DesktopConfigGuard(') > 0);
        const store = launch.slice(launch.indexOf('this.guard = new DesktopConfigGuard('), launch.indexOf('seedRedirectedConfig('));
        assert.ok(store.length > 100, 'the Store branch was found');
        assert.ok(store.includes('this.armShellMenu(storeExe);'), 'the Store lane arms it');
        assert.ok(store.indexOf('await this.guard.apply();') < store.indexOf('this.armShellMenu(storeExe);'));
        const rest = launch.slice(launch.indexOf('seedRedirectedConfig('));
        assert.ok(rest.includes('this.armShellMenu(this.plan.command);'), 'and so does a portable or head exe');
        assert.ok(rest.includes('if (this.shellMenuArmed) this.shellMenu.own(win.exe);'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Second review of #542, finding E: "desktop app put back as found" read yes
// on a run that had measured nothing. The leg now counts its own launch and
// answers it from its own stop, with what that stop saw.
test('a built app counts as put back only once its own stop has closed it', async () => {
    const dir = tmp();
    try {
        const legs = { launched: 0, stopped: 0, problems: [] };
        let up = false;
        const record = { remember: () => true, recall: () => null };
        const clean = portableLeg(dir, {
            cellId: 'T-GATE-COUNT-CLEAN',
            shared: { desktopLegs: legs, ownerState: record },
            lister: async () => (up ? [{ image: EXE_NAME, pid: 8181 }] : []),
            launcher: async () => {
                up = true;
                return { child: null, pid: 8181 };
            },
            uia: {
                log() {},
                async findWindow() {
                    return { hwnd: 7, pid: 8181, exe: 'C:\\bogus\\floe-desktop.exe', minimized: false };
                },
                async waitTree() {
                    return { ready: true };
                },
                async closeWindow() {
                    up = false;
                    return { posted: true };
                },
                async close() {},
            },
        });
        await clean.launch([]);
        assert.deepEqual(legs, { launched: 1, stopped: 0, problems: [] }, 'launched, not yet answered');
        // The run's record of the owner's folders reaches the leg, but a
        // portable exe has a profile of its own: its driver never gets it,
        // so nothing it reads there can be kept as the owner's.
        assert.equal(clean.ownerState, record);
        assert.equal(clean.driver.ownerState, null);
        await clean.stop('done');
        assert.deepEqual(legs, { launched: 1, stopped: 1, problems: [] });
        // A second stop() is the same promise and counts nothing twice.
        await clean.stop('again');
        assert.equal(legs.stopped, 1);
        started.delete(8181);

        // A leg that was refused before its launch counts nothing at all.
        const refused = portableLeg(dir, {
            cellId: 'T-GATE-COUNT-REFUSED',
            allowForeground: false,
            shared: { desktopLegs: legs },
            lister: async () => [],
            launcher: async () => ({ child: null, pid: null }),
        });
        await assert.rejects(refused.launch([]), (e) => e.reason === 'present');
        await refused.stop('failed');
        assert.deepEqual(legs, { launched: 1, stopped: 1, problems: [] });
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('leftBehind names what a stop left: a forced close, a folder not put back, a Save to that moved', () => {
    const dir = tmp();
    try {
        const leg = portableLeg(dir, {
            cellId: 'T-GATE-LEFT',
            lister: async () => [],
            launcher: async () => ({ child: null, pid: null }),
        });
        // No driver and nothing started: nothing to say.
        assert.deepEqual(leg.leftBehind(null, null), []);
        leg._unfoundNotEnded.push(77);
        assert.deepEqual(leg.leftBehind(null, null), ['an app this leg started could not be ended (pid 77)']);
        leg._unfoundNotEnded.length = 0;

        leg.driver = {};
        assert.deepEqual(leg.leftBehind({ closed: true, how: 'wm-close-1' }, null), []);
        assert.deepEqual(leg.leftBehind({ closed: true, how: 'already-closed' }, null), []);
        assert.deepEqual(leg.leftBehind({ closed: true, how: 'taskkill' }, null), [
            'the app did not close by itself and was ended with taskkill',
        ]);
        assert.deepEqual(leg.leftBehind({ closed: false, how: 'still-running' }, null), [
            'the app was still running after the close',
        ]);
        assert.deepEqual(leg.leftBehind(null, null), ['the stop ended before the app was closed']);

        leg.saveDir = { original: 'D:\\owner', changed: true, restored: false };
        leg._saveToDrift = { before: 'D:\\owner', now: 'D:\\ownerx' };
        assert.deepEqual(
            leg.leftBehind({ closed: true, how: 'wm-close-1' }, new Error('restore mismatch\nsecond line')),
            [
                'the save folder of a code Receive was not put back',
                'the Make link form\'s Save to field read "D:\\ownerx" at the close, not "D:\\owner"',
                'restore mismatch',
            ]
        );
        // Restored, or never changed, is not a problem.
        leg._saveToDrift = null;
        leg.saveDir = { original: 'D:\\owner', changed: true, restored: true };
        assert.deepEqual(leg.leftBehind({ closed: true, how: 'wm-close-1' }, null), []);
        leg.saveDir = { original: null, changed: false, restored: null };
        assert.deepEqual(leg.leftBehind({ closed: true, how: 'wm-close-1' }, null), []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Finding C, last part: the release reads the Save to field back, but the
// window is active after that call and the form's fields take keys.
test('the last look before the close catches a Save to field that moved after it was put back, on the Store lane only', async () => {
    const dir = tmp();
    try {
        const driverWith = (before, now) => ({
            reads: 0,
            requestSaveDirBefore: () => before,
            async readRequestSaveDir() {
                this.reads += 1;
                return now;
            },
        });
        const leg = (mode) =>
            new DesktopLeg({
                role: 'receiver',
                cellId: `T-GATE-LOOK-${mode}`,
                input: 'code',
                code: 'a-b-c',
                outDir: path.join(dir, 'out'),
                build:
                    mode === 'store'
                        ? { launch: 'store' }
                        : { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
                scratch: dir,
                allowForeground: true,
                uia: { log() {} },
                lister: async () => [],
                launcher: async () => ({ child: null, pid: null }),
                monitor: 'off',
                shellMenu: new ShellMenuGuard({ platform: 'linux' }),
                infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
            });
        // As it was put back: nothing to say.
        let l = leg('store');
        l.driver = driverWith('D:\\owner', 'D:\\owner');
        await l.lastLookAtSaveTo();
        assert.equal(l._saveToDrift, null);
        assert.equal(l.driver.reads, 1);
        // Moved since: on record, with the manual step.
        l = leg('store');
        l.driver = driverWith('D:\\owner', 'D:\\ownerx');
        await l.lastLookAtSaveTo();
        assert.deepEqual(l._saveToDrift, { before: 'D:\\owner', now: 'D:\\ownerx' });
        assert.ok(
            l.notes.some((n) => n.includes('last look:') && n.includes('reads "D:\\ownerx", not "D:\\owner", just before the close; set it by hand')),
            l.notes.join(' | ')
        );
        // The form is not on screen, or the driver never set the field: no finding.
        l = leg('store');
        l.driver = driverWith('D:\\owner', null);
        await l.lastLookAtSaveTo();
        assert.equal(l._saveToDrift, null);
        l = leg('store');
        l.driver = driverWith(null, 'D:\\anything');
        await l.lastLookAtSaveTo();
        assert.equal(l._saveToDrift, null);
        assert.equal(l.driver.reads, 0, 'nothing is read when nothing was set');
        // A portable exe has a profile of its own: never read.
        l = leg('portable');
        l.driver = driverWith('D:\\owner', 'D:\\ownerx');
        await l.lastLookAtSaveTo();
        assert.equal(l._saveToDrift, null);
        assert.equal(l.driver.reads, 0);

        // It is the last thing the stop does before the capture and the close.
        const src = readFileSync(fileURLToPath(new URL('./desktop.mjs', import.meta.url)), 'utf8');
        const stop = src.slice(src.indexOf('    async _stop(reason) {'), src.indexOf('    async endUnfoundApp() {'));
        const order = [
            'await this.restoreSaveDir();',
            'await this.lastLookAtSaveTo();',
            "await this.capture('stop');",
            'closeResult = await closeAndWait(',
        ].map((t) => stop.indexOf(t));
        assert.ok(order.every((i) => i > 0), JSON.stringify(order));
        assert.deepEqual([...order].sort((a, b) => a - b), order);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Third review of #542, findings 2 and 3. A launch that never showed a window
// read "yes, closed by itself" in the Safety row whatever became of its
// process, and a Store start through the shell returns before the app's
// process exists, so a stop that looked once found nothing and ended nothing.
test('a launch that never showed a window is never reported as closed by itself', async () => {
    const dir = tmp();
    const unfound = (over) => {
        const legs = { launched: 0, stopped: 0, problems: [] };
        const killed = [];
        let listed = 0;
        const leg = new DesktopLeg({
            role: 'receiver',
            cellId: `T-GATE-NOWIN-${over.id}`,
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, `out-${over.id}`),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            allowForeground: true,
            shared: { desktopLegs: legs },
            unfoundLookMs: over.lookMs ?? 0,
            uia: {
                log() {},
                async findWindow() {
                    throw new Error('no window within the timeout');
                },
                async close() {},
            },
            lister: async () => {
                listed += 1;
                if (over.listFails && listed > 1) throw new Error('tasklist exited 1');
                return over.rows(listed);
            },
            launcher: async () => ({ child: null, pid: over.launchPid ?? null }),
            kill: async (pid) => {
                if (over.killFails) throw new Error('access denied');
                killed.push(pid);
            },
            creationTime: over.creationTime ?? (async () => new Date().toISOString()),
            monitor: 'off',
            shellMenu: new ShellMenuGuard({ platform: 'linux' }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        return { leg, legs, killed, listings: () => listed };
    };
    const run = async (over) => {
        const u = unfound(over);
        await assert.rejects(u.leg.launch([]), /no window within the timeout/);
        await u.leg.stop('failed');
        return u;
    };
    // The first listing is the second-instance check before the launch.
    const after = (rows) => (n) => (n > 1 ? rows : []);
    try {
        // Ended with taskkill: counted as stopped, and said.
        let u = await run({ id: 'ended', launchPid: 21, rows: after([{ image: EXE_NAME, pid: 21 }]) });
        assert.deepEqual(u.killed, [21]);
        assert.deepEqual(u.legs, {
            launched: 1,
            stopped: 1,
            problems: ['T-GATE-NOWIN-ended: the launch showed no window and its process was ended with taskkill (pid 21)'],
        });

        // Left running because it cannot be shown to be this leg's: said.
        u = await run({ id: 'left', rows: after([{ image: EXE_NAME, pid: 31 }]), creationTime: async () => null });
        assert.deepEqual(u.killed, []);
        assert.deepEqual(u.legs.problems, [
            "T-GATE-NOWIN-left: the launch showed no window, and a Floe process that may be its own was left running (pid 31)",
        ]);

        // The kill failed: said, once.
        u = await run({ id: 'failed', launchPid: 41, rows: after([{ image: EXE_NAME, pid: 41 }]), killFails: true });
        assert.deepEqual(u.legs.problems, ['T-GATE-NOWIN-failed: an app this leg started could not be ended (pid 41)']);

        // The list could not be read: not a yes.
        u = await run({ id: 'nolist', launchPid: 51, rows: () => [], listFails: true });
        assert.deepEqual(u.legs.problems, [
            'T-GATE-NOWIN-nolist: the launch showed no window and the process list could not be read',
        ]);

        // No process at all, with a pid from the launch: nothing was left,
        // and one look is enough.
        // (a look of 1.5 s is on offer here, and must not be taken)
        u = await run({ id: 'none', launchPid: 61, rows: () => [], lookMs: 1500 });
        assert.deepEqual(u.legs.problems, []);
        assert.equal(u.listings(), 2, 'no polling when the launch returned a pid');
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a start through the shell whose process appears after the stop began is still found and ended', async () => {
    const dir = tmp();
    try {
        assert.equal(UNFOUND_LOOK_MS, 6_000);
        const killed = [];
        let listed = 0;
        const leg = new DesktopLeg({
            role: 'receiver',
            cellId: 'T-GATE-LATE-PROCESS',
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, 'out'),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            allowForeground: true,
            unfoundLookMs: 5_000,
            uia: {
                log() {},
                async findWindow() {
                    throw new Error('no window within the timeout');
                },
                async close() {},
            },
            // Nothing before the launch, nothing at the stop's first two
            // looks, then the process the shell started.
            lister: async () => {
                listed += 1;
                return listed >= 4 && !killed.length ? [{ image: EXE_NAME, pid: 7171 }] : [];
            },
            // No pid: what a start through explorer.exe returns.
            launcher: async () => ({ child: null, pid: null }),
            kill: async (pid) => void killed.push(pid),
            creationTime: async () => new Date().toISOString(),
            monitor: 'off',
            shellMenu: new ShellMenuGuard({ platform: 'linux' }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        await assert.rejects(leg.launch([]), /no window within the timeout/);
        await leg.stop('failed');
        assert.deepEqual(killed, [7171], 'found on a later look and ended');
        assert.ok(listed >= 4);

        // With no process ever, the look ends at its bound and ends nothing.
        const never = new DesktopLeg({
            role: 'receiver',
            cellId: 'T-GATE-NO-PROCESS',
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, 'out2'),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            allowForeground: true,
            unfoundLookMs: 700,
            uia: {
                log() {},
                async findWindow() {
                    throw new Error('no window within the timeout');
                },
                async close() {},
            },
            lister: async () => [],
            launcher: async () => ({ child: null, pid: null }),
            kill: async (pid) => void killed.push(pid),
            monitor: 'off',
            shellMenu: new ShellMenuGuard({ platform: 'linux' }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        await assert.rejects(never.launch([]), /no window within the timeout/);
        const t0 = Date.now();
        await never.stop('failed');
        const took = Date.now() - t0;
        assert.ok(took >= 600 && took < 4_000, `looked for ${took} ms`);
        assert.deepEqual(killed, [7171]);
    } finally {
        for (const l of activeLegs) if (/^T-GATE/.test(l.opts?.cellId ?? '')) activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

// Third review: six of the eight checks could be removed one at a time with
// every test still green. Each sits after one await of the launch, and what
// it guards is in the comment beside it; the count and the two that matter
// most are pinned here.
test('every await of a launch is followed by its stopped-while-starting check', () => {
    const src = readFileSync(fileURLToPath(new URL('./desktop.mjs', import.meta.url)), 'utf8');
    const launch = src.slice(src.indexOf('    async _launch(files = []) {'), src.indexOf('    spend(kind) {'));
    assert.equal(launch.split('this.haltIfStopped();').length - 1, 8);
    const at = (text) => {
        const i = launch.indexOf(text);
        assert.ok(i > 0, `not found in the launch: ${text}`);
        return i;
    };
    const next = (from) => launch.indexOf('this.haltIfStopped();', from);
    // Before desktop.json is edited: after the idle read.
    assert.ok(next(at('const idle = await this.idleSeconds();')) < at('await this.guard.apply();'));
    // After the edit and its record, before anything is launched.
    assert.ok(next(at('this.recordGuard();')) < at('const launched = await this.launcher('));
    // After the helper is up, still before the launch call.
    assert.ok(next(at('const client = await this.uia();')) < at('const launched = await this.launcher('));
    // After the launch call, before the window search.
    assert.ok(next(at('this.registerPid(this.pid);')) < at('const win = await client.findWindow('));
    // After the window search, once the driver exists for the stop to close.
    // (the wailsdev branch above has a waitTree of its own, so the last one)
    assert.ok(next(at('this.driver = new UiaDriver(')) < launch.lastIndexOf('await this.driver.waitTree('));
});
