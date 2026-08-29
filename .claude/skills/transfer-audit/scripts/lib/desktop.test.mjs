// Tests for lib/desktop.mjs with no Floe and no window: the pure pieces
// (identity mapping, editDesktopJson, launch plans per mode, status and pill
// classification, tasklist parsing), the desktop.json guard with temp files
// (byte-identical restore, the mismatch SafetyError, the foreign-process
// refusal with an injected lister, never creating the file), the save-dir
// restore logic and the sender/receiver flows against a scripted driver.
//
// Run: node --test .claude/skills/<skill>/scripts/lib/desktop.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFence } from './fence.mjs';
import { started } from './proc.mjs';
import { PhaseError, SafetyError, sleep } from './surfaces.mjs';
import {
    AUMID,
    COMPLETION_PILL_READY,
    DesktopConfigGuard,
    DesktopLeg,
    EXE_NAME,
    FAST_SAMPLE_MS,
    FAST_SAMPLE_WINDOW_MS,
    LAUNCH_MODES,
    PROBE_NAMES,
    PreconditionError,
    RE,
    READY_AFTER_DECISIVE_MS,
    SAMPLE_MS,
    STRINGS,
    USER_AWAY_IDLE_S,
    WINDOWS_APPS,
    activeGuards,
    activeLegs,
    aggregateProbes,
    classifyStatus,
    createLeg,
    editDesktopJson,
    identityVersion,
    listDesktopProcesses,
    parseTag,
    parseTasklist,
    pillVerdict,
    planLaunch,
    probe,
    receiverTarget,
    redirectedAppData,
    resolveMode,
    restoreConfig,
    sameText,
    seedRedirectedConfig,
    sendButtonName,
    sha256,
    shutdown,
    statsProofFor,
    tagForIdentity,
    versionForIdentity,
    withDesktopConfig,
} from './desktop.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'desktop-test-'));
const INTERRUPT_CHILD = fileURLToPath(
    new URL('./tests/fake-desktop-interrupt.mjs', import.meta.url)
);

test('identity mapping round-trips pack.ps1 (tag <-> identity)', () => {
    assert.equal(identityVersion('desktop-v0.2.8'), '1.2.8.0');
    assert.equal(identityVersion('desktop-v1.0.0'), '2.0.0.0');
    assert.equal(identityVersion('v0.2.8'), null);
    assert.equal(tagForIdentity('1.2.8.0'), 'desktop-v0.2.8');
    assert.equal(tagForIdentity('1.2.5.0'), 'desktop-v0.2.5');
    assert.equal(tagForIdentity('0.2.8.0'), null);
    assert.equal(tagForIdentity('1.2.8.1'), null);
    assert.equal(tagForIdentity('junk'), null);
    assert.equal(versionForIdentity('1.2.8.0'), '0.2.8');
    assert.deepEqual(parseTag('desktop-v0.10.3'), {
        tag: 'desktop-v0.10.3',
        version: '0.10.3',
        major: 0,
        minor: 10,
        patch: 3,
    });
    for (const t of ['desktop-v0.2.8', 'desktop-v3.4.5'])
        assert.equal(tagForIdentity(identityVersion(t)), t);
});

test('editDesktopJson keeps the record and forces the five keys', () => {
    const original = Buffer.from(
        '{"server":"","web":"","hideIP":false,"reportStats":true,"noUpdateCheck":false,"migrated":true}\n'
    );
    const out = editDesktopJson(original, {
        server: 'http://localhost:3001',
        web: 'http://localhost:3000',
        hideIP: true,
    });
    assert.ok(out.endsWith('\n'));
    assert.deepEqual(JSON.parse(out), {
        server: 'http://localhost:3001',
        web: 'http://localhost:3000',
        hideIP: true,
        reportStats: false,
        noUpdateCheck: true,
        migrated: true,
    });
    const extra = editDesktopJson('{"future":1,"reportStats":true}', {});
    assert.deepEqual(JSON.parse(extra), {
        future: 1,
        server: '',
        web: '',
        hideIP: false,
        reportStats: false,
        noUpdateCheck: true,
        migrated: true,
    });
    assert.deepEqual(
        JSON.parse(editDesktopJson('', { hideIP: 1 })).hideIP,
        true
    );
    assert.deepEqual(JSON.parse(editDesktopJson(null, {})).migrated, true);
    assert.throws(() => editDesktopJson('{not json', {}));
});

test('sendButtonName, receiverTarget, pillVerdict, classifyStatus, sameText', () => {
    assert.equal(sendButtonName(0), 'Send');
    assert.equal(sendButtonName(1), 'Send 1 item');
    assert.equal(sendButtonName(3), 'Send 3 items');
    assert.equal(
        receiverTarget({ input: 'code', code: 'a-b-c', link: 'L' }),
        'a-b-c'
    );
    assert.equal(
        receiverTarget({ input: 'link', code: 'a-b-c', link: 'L' }),
        'L'
    );
    assert.equal(receiverTarget({ input: 'link', code: 'a-b-c' }), 'a-b-c');
    assert.equal(receiverTarget({ target: 'T', code: 'x' }), 'T');
    assert.equal(receiverTarget({}), null);
    assert.equal(pillVerdict('DIRECT'), 'direct');
    assert.equal(pillVerdict('Relay'), 'relay');
    assert.equal(pillVerdict('ACTIVE'), 'unknown');
    assert.equal(pillVerdict('READY'), 'unknown');
    assert.equal(pillVerdict(null), 'unknown');
    assert.equal(classifyStatus(STRINGS.connecting).kind, 'connecting');
    assert.equal(
        classifyStatus('CONNECTING... KEEP THIS WINDOW OPEN.').kind,
        'connecting'
    );
    assert.equal(classifyStatus(STRINGS.enterCode).kind, 'enter-code');
    assert.equal(classifyStatus(STRINGS.canceled).kind, 'canceled');
    assert.equal(
        classifyStatus(
            'Error: transfer blocked: relay connections are capped at 2 GB (selected 3.0 GB)'
        ).kind,
        'refusal'
    );
    assert.equal(
        classifyStatus(
            'Error: That code was not recognized. Check it for typos, or ask the sender for a new one.'
        ).kind,
        'error'
    );
    assert.equal(classifyStatus('Waiting for the receiver...').kind, 'other');
    assert.ok(sameText('RECEIVE', 'Receive'));
    assert.ok(!sameText('Receive', 'Received'));
});

test('RE table matches the rendered-case names UIA reports', () => {
    for (const t of ['READY', 'Ready', 'ACTIVE', 'DIRECT', 'Relay'])
        assert.ok(RE.pill.test(t), t);
    assert.ok(!RE.pill.test('Ready for a transfer'));
    assert.ok(RE.sendButton.test('Send 3 items'));
    assert.ok(RE.sendButton.test('SEND 1 ITEM'));
    assert.ok(!RE.sendButton.test('Send'));
    assert.ok(!RE.sendButton.test('Send text'));
    assert.ok(RE.sent.test('Sent 1 item'));
    assert.equal(
        RE.savedTo.exec('Saved to C:\\Users\\alice\\Downloads')[1],
        'C:\\Users\\alice\\Downloads'
    );
    assert.ok(RE.incoming.test('Incoming: report.pdf · 30.0 MB'));
    assert.ok(RE.code.test('olive-tiger-castle'));
    assert.ok(RE.code.test('one-two-three-four'));
    assert.ok(!RE.code.test('CODE OR LINK'));
    assert.ok(!RE.code.test('SEND'));
    assert.ok(RE.link.test('https://floe.one/#room=0b1c'));
    assert.ok(
        RE.busyFooter.test(
            'KEEP THIS WINDOW OPEN. CLOSING IT CANCELS THE TRANSFER.'
        )
    );
    assert.ok(RE.status.test('Error: anything'));
    assert.ok(
        RE.progress.test(
            '[1/3] a.bin - 42%  (4.2 MB / 10.0 MB), 5.0 MB/s, ETA 1s'
        )
    );
    assert.ok(RE.progress.test('a.bin - 100%  (10.0 MB / 10.0 MB)'));
});

test('parseTasklist and listDesktopProcesses with an injected lister', async () => {
    const csv =
        '"floe-desktop.exe","1234","Console","1","120,000 K"\r\n"floe.exe","99","Console","1","1 K"\r\n';
    assert.deepEqual(parseTasklist(csv), [
        { image: 'floe-desktop.exe', pid: 1234 },
        { image: 'floe.exe', pid: 99 },
    ]);
    assert.deepEqual(
        parseTasklist(
            'INFO: No tasks are running which match the specified criteria.'
        ),
        []
    );
    const rows = await listDesktopProcesses(async () => parseTasklist(csv));
    assert.deepEqual(rows, [{ image: EXE_NAME, pid: 1234 }]);
});

test('resolveMode and planLaunch per mode', () => {
    assert.deepEqual(LAUNCH_MODES, ['store', 'portable', 'head', 'wailsdev']);
    assert.equal(
        resolveMode({ build: { kind: 'shipped', launch: 'store' } }),
        'store'
    );
    assert.equal(resolveMode({ build: { kind: 'head' } }), 'head');
    assert.equal(resolveMode({ build: { kind: 'shipped' } }), 'portable');
    assert.equal(resolveMode({}), 'portable');
    const env = {
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        PATH: 'p',
        PION_LOG_TRACE: 'all',
        pion_log_debug: 'x',
    };

    const store = planLaunch({ mode: 'store', env });
    assert.equal(store.command, 'explorer.exe');
    assert.deepEqual(store.args, [`shell:AppsFolder\\${AUMID}`]);
    assert.equal(store.env, null);
    assert.equal(
        store.configPath,
        'C:\\Users\\u\\AppData\\Roaming\\floe\\desktop.json'
    );
    assert.equal(store.filesStaged, false);

    const storeExe = `${WINDOWS_APPS}JanCarloParedes.FloeDesktop_1.2.8.0_x64__r1y5w9chaxnzc\\floe-desktop.exe`;
    const storeFiles = planLaunch({
        mode: 'store',
        env,
        storeExe,
        files: ['C:\\fx\\a.bin', "C:\\fx\\it's.bin"],
    });
    assert.equal(storeFiles.command, storeExe);
    assert.deepEqual(storeFiles.args, ['C:\\fx\\a.bin', "C:\\fx\\it's.bin"]);
    assert.equal(storeFiles.env, null);
    assert.equal(storeFiles.cwd, path.dirname(storeExe));
    assert.equal(storeFiles.filesStaged, true);
    assert.equal(storeFiles.identity, 'inferred-packaged');
    assert.equal(store.identity, 'aumid');
    assert.throws(
        () => planLaunch({ mode: 'store', env, files: ['C:\\fx\\a.bin'] }),
        PhaseError
    );
    assert.throws(
        () =>
            planLaunch({
                mode: 'store',
                env,
                files: ['C:\\fx\\a.bin'],
                storeExe: 'C:\\elsewhere\\floe-desktop.exe',
            }),
        PhaseError
    );

    for (const mode of ['portable', 'head']) {
        const plan = planLaunch({
            mode,
            exe: 'C:\\bin\\floe-desktop.exe',
            files: ['C:\\fx\\a.bin'],
            scratch: 'C:\\scratch',
            env,
        });
        assert.equal(plan.command, 'C:\\bin\\floe-desktop.exe');
        assert.deepEqual(plan.args, ['C:\\fx\\a.bin']);
        assert.equal(plan.cwd, 'C:\\bin');
        assert.equal(plan.appData, redirectedAppData('C:\\scratch'));
        assert.equal(plan.env.APPDATA, 'C:\\scratch\\appdata');
        assert.equal(plan.env.FLOE_NO_UPDATE_CHECK, '1');
        assert.equal(plan.env.PATH, 'p');
        assert.equal(plan.env.PION_LOG_TRACE, undefined);
        assert.equal(plan.env.pion_log_debug, undefined);
        assert.equal(
            plan.configPath,
            'C:\\scratch\\appdata\\floe\\desktop.json'
        );
        assert.equal(plan.filesStaged, true);
    }
    const traced = planLaunch({
        mode: 'portable',
        exe: 'C:\\bin\\floe-desktop.exe',
        scratch: 'C:\\scratch',
        env,
        pionTrace: true,
    });
    assert.equal(traced.env.PION_LOG_TRACE, 'ice');
    const dev = planLaunch({ mode: 'wailsdev', env });
    assert.equal(dev.url, 'http://localhost:34115');
    assert.equal(dev.command, null);
    assert.throws(
        () => planLaunch({ mode: 'portable', scratch: 'C:\\s', env }),
        PhaseError
    );
    assert.throws(
        () => planLaunch({ mode: 'portable', exe: 'C:\\x.exe', env }),
        PhaseError
    );
    assert.throws(() => planLaunch({ mode: 'nope', env }), PhaseError);
});

test('seedRedirectedConfig writes the opted-out record and statsProofFor reads it back', () => {
    const dir = tmp();
    try {
        const file = seedRedirectedConfig(path.join(dir, 'appdata'), {
            server: 'http://localhost:3001',
        });
        assert.equal(file, path.join(dir, 'appdata', 'floe', 'desktop.json'));
        const proof = statsProofFor(file);
        assert.equal(proof.kind, 'desktop.json-preflight');
        assert.equal(proof.reportStats, false);
        assert.equal(proof.migrated, true);
        assert.equal(proof.ok, true);
        assert.equal(proof.sha256, sha256(readFileSync(file)));
        assert.equal(statsProofFor(path.join(dir, 'missing.json')).ok, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const NO_PROCS = async () => [];

test('withDesktopConfig restores byte-identical and keeps a backup in the evidence dir', async () => {
    const dir = tmp();
    try {
        const cfg = path.join(dir, 'desktop.json');
        const original = Buffer.from(
            '{\n  "server": "",\n  "web": "",\n  "hideIP": false,\n  "reportStats": true,\n  "noUpdateCheck": false,\n  "migrated": true\n}\n'
        );
        writeFileSync(cfg, original);
        const evidenceDir = path.join(dir, 'ev');
        let seen = null;
        const r = await withDesktopConfig(
            cfg,
            {
                server: 'http://localhost:3001',
                web: 'http://localhost:3000',
                hideIP: true,
            },
            async (guard) => {
                seen = JSON.parse(readFileSync(cfg, 'utf8'));
                assert.equal(guard.applied, true);
                return 'body-result';
            },
            { evidenceDir, processes: NO_PROCS }
        );
        assert.equal(r.result, 'body-result');
        assert.equal(r.sha256, sha256(original));
        assert.equal(r.state.match, true);
        assert.deepEqual(seen, {
            server: 'http://localhost:3001',
            web: 'http://localhost:3000',
            hideIP: true,
            reportStats: false,
            noUpdateCheck: true,
            migrated: true,
        });
        assert.ok(readFileSync(cfg).equals(original));
        assert.ok(
            readFileSync(path.join(evidenceDir, 'desktop.json.bak')).equals(
                original
            )
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('withDesktopConfig restores even when the body throws, and reports a restore mismatch', async () => {
    const dir = tmp();
    try {
        const cfg = path.join(dir, 'desktop.json');
        const original = Buffer.from('{"migrated":true}\n');
        writeFileSync(cfg, original);
        await assert.rejects(
            withDesktopConfig(
                cfg,
                {},
                async () => {
                    throw new Error('boom');
                },
                { processes: NO_PROCS }
            ),
            /boom/
        );
        assert.ok(readFileSync(cfg).equals(original));

        // A writer that silently drops the trailing newline on restore.
        const lying = {
            existsSync,
            mkdirSync: () => {},
            readFileSync: (p) => readFileSync(p),
            writeFileSync: (p, data) =>
                writeFileSync(
                    p,
                    Buffer.isBuffer(data)
                        ? data.subarray(0, data.length - 1)
                        : data
                ),
        };
        await assert.rejects(
            withDesktopConfig(cfg, {}, async () => 1, {
                processes: NO_PROCS,
                fsImpl: lying,
            }),
            (err) => {
                assert.ok(err instanceof SafetyError);
                assert.match(err.message, /restore mismatch/);
                assert.equal(err.want, sha256(original));
                assert.notEqual(err.got, err.want);
                return true;
            }
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the guard refuses a foreign floe-desktop.exe and a missing file, and never creates one', async () => {
    const dir = tmp();
    try {
        const cfg = path.join(dir, 'desktop.json');
        writeFileSync(cfg, '{}');
        const busy = async () => [{ image: EXE_NAME, pid: 4321 }];
        await assert.rejects(
            withDesktopConfig(cfg, {}, async () => 1, { processes: busy }),
            (err) => {
                assert.ok(err instanceof PreconditionError);
                assert.equal(err.exitCode, 3);
                assert.deepEqual(err.pids, [4321]);
                return true;
            }
        );
        assert.equal(readFileSync(cfg, 'utf8'), '{}');
        const missing = path.join(dir, 'nope', 'desktop.json');
        await assert.rejects(
            withDesktopConfig(missing, {}, async () => 1, {
                processes: NO_PROCS,
            }),
            (err) =>
                err instanceof PreconditionError &&
                /never creates/.test(err.message)
        );
        assert.equal(existsSync(missing), false);
        await assert.rejects(
            new DesktopConfigGuard({ configPath: null }).apply(),
            PreconditionError
        );
        const g = new DesktopConfigGuard({
            configPath: cfg,
            processes: NO_PROCS,
        });
        assert.equal(g.restore().applied, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * A scripted driver: a mutable text list plus a log of every call. An entry
 * of state.texts may be an array of leaves (Chromium exposes each DOM text
 * node on its own); those match singly, and joined only when the read asks
 * for join and state.joinSupported is not false. state.pillScript, when
 * set, answers the pill read with the next entry (the last one repeats).
 * Reads are logged in driver.reads, not calls, so call indexes hold.
 */
function scriptedDriver(state) {
    const calls = [];
    const reads = [];
    return {
        calls,
        reads,
        async click(name, opts = {}) {
            calls.push(['click', name, opts]);
            if (state.onClick) state.onClick(name, opts);
            return { via: 'invoke' };
        },
        async setValue(placeholder, value, opts = {}) {
            calls.push(['set-value', placeholder, value, opts]);
            const before = state.values[placeholder] ?? '';
            if (state.rejectSet && state.rejectSet(placeholder))
                return { before, after: before, matchedBy: 'name' };
            state.values[placeholder] = value;
            if (state.onSet) state.onSet(placeholder, value);
            return { before, after: value, matchedBy: 'name' };
        },
        async getValue(placeholder, opts = {}) {
            calls.push(['get-value', placeholder, opts]);
            return {
                value: state.values[placeholder] ?? '',
                matchedBy: 'name',
            };
        },
        async readText(re, opts = {}) {
            reads.push({ re, opts });
            if (state.pillScript && re === RE.pill) {
                const next =
                    state.pillScript.length > 1
                        ? state.pillScript.shift()
                        : state.pillScript[0];
                return [next];
            }
            const type = opts.controlType ?? 'Text';
            const pool =
                type === 'Button'
                    ? state.buttons
                    : type === 'any'
                      ? [...state.texts, ...state.buttons]
                      : state.texts;
            const out = [];
            for (const entry of pool) {
                if (!Array.isArray(entry)) {
                    if (re.test(entry)) out.push(entry);
                    continue;
                }
                // The helper's rule: a run whose joined text matches answers
                // as that one line, else its leaves answer singly.
                const t = entry.join('').replace(/\s+/g, ' ').trim();
                if (opts.join && state.joinSupported !== false && re.test(t))
                    out.push(t);
                else
                    for (const leaf of entry) if (re.test(leaf)) out.push(leaf);
            }
            return out;
        },
        async capture(file) {
            calls.push(['capture', path.basename(file)]);
            return { path: file, w: 1, h: 1 };
        },
        async closeWindow() {
            calls.push(['close']);
            state.closed = true;
            return { posted: true };
        },
        async alive() {
            return !state.closed;
        },
        async show() {
            return { wasIconic: false, iconic: false };
        },
        async waitTree() {
            return { ready: true };
        },
        async foregroundCheck() {
            calls.push(['foreground-check']);
            return {
                foreground: false,
                foregroundHwnd: 0,
                idleSeconds: state.idleSeconds ?? 0,
            };
        },
        async stage(paths, cwd) {
            calls.push(['stage', paths, cwd]);
            if (state.onStage) state.onStage(paths);
            return { target: 1, chars: 1, cbData: 1, activates: true };
        },
    };
}

function legWith(opts, state) {
    const leg = new DesktopLeg({ evidenceDir: null, ...opts });
    const driver = scriptedDriver(state);
    leg.launch = async () => {
        leg.driver = driver;
        leg.plan = { mode: leg.mode, configPath: null, appData: null };
        return driver;
    };
    leg.lister = async () => [];
    return { leg, driver };
}

test('receiver flow: tab, remember save dir, set code and dir, click the action button, status oracle', async () => {
    const state = {
        values: { [STRINGS.saveDirPlaceholder]: 'C:\\old\\dir' },
        texts: ['READY', 'Enter a code or link, then click Receive.'],
        buttons: ['SEND', 'RECEIVE', 'Browse', 'Receive'],
    };
    state.onClick = (name, opts) => {
        if (sameText(name, 'Receive') && opts.after === STRINGS.codePlaceholder)
            state.texts = [
                'ACTIVE',
                STRINGS.connecting,
                'KEEP THIS WINDOW OPEN. CLOSING IT CANCELS THE TRANSFER.',
            ];
    };
    const { leg, driver } = legWith(
        {
            role: 'receiver',
            input: 'code',
            code: 'olive-tiger-castle',
            outDir: 'C:\\out\\a1',
            build: { launch: 'portable', path: 'x' },
        },
        state
    );
    await leg.start();
    assert.deepEqual(driver.calls[0], ['click', 'Receive', { index: 0 }]);
    assert.equal(leg.saveDir.original, 'C:\\old\\dir');
    assert.deepEqual(
        driver.calls
            .find(
                (c) => c[0] === 'set-value' && c[1] === STRINGS.codePlaceholder
            )
            .slice(1, 3),
        [STRINGS.codePlaceholder, 'olive-tiger-castle']
    );
    assert.deepEqual(
        driver.calls.find(
            (c) => c[0] === 'set-value' && c[1] === STRINGS.saveDirPlaceholder
        )[3],
        { scope: 'receive' }
    );
    const action = driver.calls.find((c) => c[0] === 'click' && c[2].after);
    assert.deepEqual(action, [
        'click',
        'Receive',
        { after: STRINGS.codePlaceholder },
    ]);
    assert.ok(leg.marks.joined);
    assert.equal(await leg.link(), 'olive-tiger-castle');

    // Connected once Incoming shows; route from the pill; done on Saved to.
    state.texts = [
        'DIRECT',
        'Incoming: a.bin · 1.0 MB',
        'a.bin - 40%  (0.4 MB / 1.0 MB)',
    ];
    const conn = await leg.awaitConnected(2000);
    assert.match(conn.line, /^Incoming/);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(leg.route().verdict, 'direct');
    state.texts = ['READY', 'Saved to C:\\out\\a1'];
    const done = await leg.awaitDone(3000);
    assert.deepEqual(done.kind, 'transfer');
    assert.equal(done.detail.dir, 'C:\\out\\a1');

    // stop restores the save dir before WM_CLOSE and never clicks Close anyway.
    await leg.stop('test');
    const restore = driver.calls
        .filter(
            (c) => c[0] === 'set-value' && c[1] === STRINGS.saveDirPlaceholder
        )
        .pop();
    assert.equal(restore[2], 'C:\\old\\dir');
    assert.equal(state.values[STRINGS.saveDirPlaceholder], 'C:\\old\\dir');
    assert.equal(leg.saveDir.restored, true);
    assert.ok(
        driver.calls.findIndex((c) => c[0] === 'close') >
            driver.calls.indexOf(restore)
    );
    assert.ok(
        !driver.calls.some(
            (c) => c[0] === 'click' && sameText(c[1], STRINGS.closeAnyway)
        )
    );
    const ev = leg.evidence();
    assert.equal(ev.surface, 'desktop');
    assert.equal(ev.saveDir.original, 'C:\\old\\dir');
    assert.equal(ev.statsProof.kind, 'desktop.json-preflight');
});

test('receiver flow: "Please enter a code or link." is SKIP uia-setvalue, a DOM-only SetValue too', async () => {
    const state = {
        values: {},
        texts: ['READY'],
        buttons: ['RECEIVE', 'Receive'],
    };
    state.onClick = (name, opts) => {
        if (opts.after) state.texts = ['READY', STRINGS.enterCode];
    };
    const { leg } = legWith(
        {
            role: 'receiver',
            input: 'link',
            link: 'https://floe.one/#room=x',
            outDir: 'C:\\out',
        },
        state
    );
    await assert.rejects(
        leg.start(),
        (err) =>
            err instanceof PhaseError &&
            err.verdict === 'SKIP' &&
            err.reason === 'uia-setvalue'
    );
    const dom = {
        values: {},
        texts: ['READY'],
        buttons: ['RECEIVE', 'Receive'],
        rejectSet: (p) => p === STRINGS.codePlaceholder,
    };
    const second = legWith(
        { role: 'receiver', input: 'code', code: 'a-b-c', outDir: 'C:\\out' },
        dom
    );
    await assert.rejects(
        second.leg.start(),
        (err) =>
            err.reason === 'uia-setvalue' && /SetValue left/.test(err.message)
    );
    const { leg: bare } = legWith(
        { role: 'receiver', input: 'code', outDir: 'C:\\out' },
        dom
    );
    await assert.rejects(
        bare.start(),
        (err) =>
            err instanceof PhaseError && /no code or link/.test(err.message)
    );
});

test('sender flow: waits for the staged button, clicks it, reads code and link, refuses to stage while present', async () => {
    const state = {
        values: {},
        texts: ['READY', 'Select or drag files, then click Send.'],
        buttons: ['SEND', 'RECEIVE', 'Send 2 items'],
    };
    const spent = [];
    state.onClick = (name) => {
        if (sameText(name, 'Send 2 items'))
            state.texts = [
                'ACTIVE',
                'CODE OR LINK',
                'olive-tiger-castle',
                'https://floe.one/#room=abc',
                'Waiting for the receiver...',
            ];
    };
    const { leg, driver } = legWith(
        {
            role: 'sender',
            files: ['C:\\fx\\a.bin', 'C:\\fx\\b.bin'],
            build: { launch: 'portable', path: 'x' },
            ledger: { spend: (k) => spent.push(k) },
        },
        state
    );
    await leg.start();
    assert.deepEqual(
        driver.calls.filter((c) => c[0] === 'click').map((c) => c[1]),
        ['Send 2 items']
    );
    assert.deepEqual(spent, ['turn', 'conn', 'code']);
    assert.equal(await leg.code(), 'olive-tiger-castle');
    assert.equal(await leg.link(), 'https://floe.one/#room=abc');
    state.texts = ['RELAY', STRINGS.peerConnected];
    await leg.awaitConnected(1000);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(leg.route().verdict, 'relay');
    state.texts = ['READY', 'Sent 2 items'];
    assert.equal((await leg.awaitDone(2000)).ok, true);
    await leg.stop('test');
    assert.equal(leg.evidence().statsProof, null);

    // Store mode with argv dropped and the user present: SKIP present, no stage call.
    const store = {
        values: {},
        texts: ['READY'],
        buttons: ['SEND', 'RECEIVE', 'Send'],
    };
    const s = legWith(
        {
            role: 'sender',
            files: ['C:\\fx\\a.bin'],
            build: { launch: 'store' },
            userAway: false,
        },
        store
    );
    s.driver.stage = async () => {
        throw new Error('stage must not be called while present');
    };
    const t0 = Date.now();
    s.leg.budget = () => 300;
    await assert.rejects(
        s.leg.start(),
        (err) => err.verdict === 'SKIP' && err.reason === 'present'
    );
    assert.ok(Date.now() - t0 < 5000);
});

test('--user-away stages only after 120 s of input idle; otherwise SKIP present without a stage call', async () => {
    const mk = (idleSeconds) => {
        const state = {
            values: {},
            texts: ['READY'],
            buttons: ['SEND', 'RECEIVE', 'Send'],
            idleSeconds,
        };
        state.onStage = () => {
            state.buttons = ['SEND', 'RECEIVE', 'Send 1 item'];
        };
        state.onClick = (name) => {
            if (sameText(name, 'Send 1 item'))
                state.texts = [
                    'ACTIVE',
                    'olive-tiger-castle',
                    'https://floe.one/#room=abc',
                    'Waiting for the receiver...',
                ];
        };
        const s = legWith(
            {
                role: 'sender',
                files: ['C:\\fx\\a.bin'],
                build: { launch: 'store' },
                userAway: true,
            },
            state
        );
        s.leg.budget = () => 300;
        return s;
    };
    assert.equal(USER_AWAY_IDLE_S, 120);
    const present = mk(5);
    await assert.rejects(
        present.leg.start(),
        (err) =>
            err instanceof PhaseError &&
            err.verdict === 'SKIP' &&
            err.reason === 'present' &&
            /idle only 5 s/.test(err.message)
    );
    assert.ok(present.driver.calls.some((c) => c[0] === 'foreground-check'));
    assert.ok(
        !present.driver.calls.some((c) => c[0] === 'stage'),
        'no WM_COPYDATA while the user is at the keyboard'
    );
    const away = mk(USER_AWAY_IDLE_S);
    await away.leg.start();
    const stage = away.driver.calls.find((c) => c[0] === 'stage');
    assert.deepEqual(stage, ['stage', ['C:\\fx\\a.bin'], 'C:\\fx']);
    assert.equal(await away.leg.link(), 'https://floe.one/#room=abc');
    assert.ok(away.leg.notes.some((n) => /idle 120 s/.test(n)));
    await away.leg.stop('test');
});

test('wailsdev: a receiver is driven only when GetSettings already shows the audit values', async () => {
    const mk = (settings, role = 'receiver') =>
        new DesktopLeg({
            role,
            input: 'code',
            code: 'a-b-c',
            outDir: 'C:\\out',
            files: ['a'],
            build: { launch: 'wailsdev' },
            infra: {
                server: 'http://localhost:3001',
                web: 'http://localhost:3000',
            },
            openDriver: async () => ({
                async waitTree() {
                    return { ready: true };
                },
                async settings() {
                    return settings;
                },
            }),
        });
    const refused = async (leg) => {
        await assert.rejects(leg.launch(), (err) => {
            assert.ok(err instanceof PreconditionError);
            assert.equal(err.reason, 'wailsdev-config');
            assert.equal(err.exitCode, 3);
            assert.match(err.message, /refusing to drive/);
            return true;
        });
        activeLegs.delete(leg);
    };
    const server = 'http://localhost:3001';
    await refused(mk({ reportStats: true, migrated: true, server }));
    await refused(mk({ reportStats: false, migrated: false, server }));
    await refused(
        mk({
            reportStats: false,
            migrated: true,
            server: 'https://api.floe.one',
        })
    );
    await refused(mk(null));
    const ok = mk({ reportStats: false, migrated: true, server });
    assert.ok(await ok.launch());
    assert.equal(ok.settingsRead.reportStats, false);
    assert.ok(activeLegs.has(ok), 'a launched leg is shutdown()-managed');
    activeLegs.delete(ok);
    // A sender never reports; only the server under test matters.
    const snd = mk({ reportStats: true, migrated: true, server }, 'sender');
    assert.ok(await snd.launch());
    activeLegs.delete(snd);
    await refused(
        mk(
            {
                reportStats: false,
                migrated: true,
                server: 'https://api.floe.one',
            },
            'sender'
        )
    );
});

test('launch registers the app pid with lib/proc.mjs (spawned and window-found alike)', async () => {
    const dir = tmp();
    const pid = 4242;
    try {
        const client = {
            log() {},
            async findWindow() {
                return {
                    hwnd: 7,
                    pid,
                    exe: 'C:\\x\\floe-desktop.exe',
                    minimized: false,
                };
            },
            async waitTree() {
                return { ready: true };
            },
        };
        const leg = new DesktopLeg({
            role: 'receiver',
            cellId: 'T-PID',
            input: 'code',
            code: 'a-b-c',
            outDir: path.join(dir, 'out'),
            build: { launch: 'portable', path: 'C:\\bogus\\floe-desktop.exe' },
            scratch: dir,
            uia: client,
            launcher: async () => ({ child: null, pid }),
            infra: { server: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        });
        started.delete(pid);
        await leg.launch([]);
        const entry = started.get(pid);
        assert.ok(entry, 'the pid is in the registry');
        assert.equal(entry.image, EXE_NAME);
        assert.equal(entry.label, 'T-PID:receiver');
        assert.deepEqual(entry.argv, ['C:\\bogus\\floe-desktop.exe']);
        assert.equal(entry.exited, null);
        assert.ok(activeLegs.has(leg));
        assert.ok(
            existsSync(path.join(dir, 'appdata', 'floe', 'desktop.json')),
            'the redirected config was seeded'
        );
        assert.equal(leg.launchProof.ok, true);
    } finally {
        started.delete(pid);
        for (const l of activeLegs)
            if (l.opts.cellId === 'T-PID') activeLegs.delete(l);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('shutdown() stops every active leg and restores every applied guard; the exit hook is armed', async () => {
    const dir = tmp();
    try {
        const cfg = path.join(dir, 'desktop.json');
        const original = Buffer.from('{"reportStats":true,"migrated":true}\n');
        writeFileSync(cfg, original);
        const g = new DesktopConfigGuard({
            configPath: cfg,
            edit: { server: 'http://127.0.0.1:9' },
            processes: NO_PROCS,
        });
        await g.apply();
        assert.ok(activeGuards.has(g), 'apply() registers the guard');
        assert.notEqual(readFileSync(cfg, 'utf8'), original.toString());
        const state = { values: {}, texts: ['READY'], buttons: [] };
        const { leg, driver } = legWith(
            {
                role: 'receiver',
                input: 'code',
                code: 'a-b-c',
                outDir: 'C:\\out',
                build: { launch: 'store' },
            },
            state
        );
        await leg.launch();
        activeLegs.add(leg);
        const manifest = {
            desktop: {
                backup: null,
                configPath: cfg,
                sha256: sha256(original),
                restored: null,
            },
        };
        const r = await shutdown({ manifest, log: () => {} });
        assert.deepEqual(r, { stopped: 1, restored: 1 });
        assert.ok(readFileSync(cfg).equals(original), 'byte-identical restore');
        assert.ok(!activeGuards.has(g), 'restore() unregisters the guard');
        assert.ok(!activeLegs.has(leg));
        assert.ok(
            driver.calls.some((c) => c[0] === 'close'),
            'WM_CLOSE posted'
        );
        assert.equal(manifest.desktop.restored, true);
        assert.ok(
            process.listeners('exit').length > 0,
            'the process exit hook is installed'
        );
        assert.deepEqual(await shutdown(), { stopped: 0, restored: 0 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('stop() restores the guard in finally even when the close path throws, writes the manifest, and runs once', async () => {
    const dir = tmp();
    try {
        const cfg = path.join(dir, 'desktop.json');
        const original = Buffer.from('{"a":1}\n');
        writeFileSync(cfg, original);
        const manifest = { desktop: { backup: null, restored: null } };
        let writes = 0;
        const state = { values: {}, texts: ['READY'], buttons: [] };
        const { leg, driver } = legWith(
            {
                role: 'receiver',
                input: 'code',
                code: 'x',
                outDir: 'C:\\out',
                build: { launch: 'store' },
                shared: { manifest, writeManifest: () => (writes += 1) },
            },
            state
        );
        await leg.launch();
        leg.guard = new DesktopConfigGuard({
            configPath: cfg,
            evidenceDir: path.join(dir, 'ev'),
            processes: NO_PROCS,
        });
        await leg.guard.apply();
        leg.recordGuard();
        assert.deepEqual(manifest.desktop, {
            backup: path.join(dir, 'ev', 'desktop.json.bak'),
            configPath: cfg,
            sha256: sha256(original),
            restored: null,
        });
        assert.equal(
            writes,
            1,
            'the manifest is written the moment the guard applies'
        );
        driver.alive = async () => {
            throw new Error('helper died');
        };
        const p1 = leg.stop('test');
        const p2 = leg.stop('again');
        assert.equal(p1, p2, 'one stop per leg, however many callers');
        await assert.rejects(p1, /helper died/);
        assert.ok(readFileSync(cfg).equals(original));
        assert.equal(manifest.desktop.restored, true);
        assert.equal(writes, 2);
        assert.ok(!activeGuards.has(leg.guard));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an interrupted or crashed run puts desktop.json back (child process: sigint, exit, crash)', async () => {
    const original = Buffer.from(
        '{\n  "server": "",\n  "web": "",\n  "hideIP": false,\n  "reportStats": true,\n  "noUpdateCheck": false,\n  "migrated": true\n}\n'
    );
    for (const [mode, code] of [
        ['sigint', 130],
        ['exit', 130],
        ['crash', 1],
    ]) {
        const scratch = tmp();
        try {
            const r = spawnSync(
                process.execPath,
                [INTERRUPT_CHILD, mode, scratch, original.toString('base64')],
                {
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 60_000,
                    env: { ...process.env, APPDATA: scratch },
                }
            );
            const cfg = path.join(scratch, 'floe', 'desktop.json');
            const first = r.stdout
                .split(/\r?\n/)
                .find((l) => l.startsWith('{'));
            assert.ok(
                first,
                `${mode}: no launch line\n${r.stdout}\n${r.stderr}`
            );
            const launched = JSON.parse(first);
            assert.equal(launched.launched, true, mode);
            assert.equal(launched.activeLeg, true, mode);
            assert.equal(launched.activeGuards, 1, mode);
            assert.equal(
                JSON.parse(launched.edited).reportStats,
                false,
                `${mode}: the guard edited the real file first`
            );
            assert.equal(
                r.status,
                code,
                `${mode}: exit ${r.status}\n${r.stderr}`
            );
            assert.ok(
                readFileSync(cfg).equals(original),
                `${mode}: desktop.json restored byte-identical`
            );
            const manifest = JSON.parse(
                readFileSync(path.join(scratch, 'manifest.json'), 'utf8')
            );
            assert.equal(manifest.desktop.configPath, cfg, mode);
            assert.equal(manifest.desktop.sha256, sha256(original), mode);
            assert.ok(
                existsSync(manifest.desktop.backup),
                `${mode}: the backup path in the manifest exists on disk`
            );
            assert.ok(readFileSync(manifest.desktop.backup).equals(original));
            assert.equal(
                manifest.desktop.restored,
                mode === 'sigint' ? true : null,
                `${mode}: only the shutdown path can record the restore`
            );
        } finally {
            rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
        }
    }
});

test('restoreConfig writes only through the fence desktop.json exception', async () => {
    const dir = tmp();
    try {
        const appData = path.join(dir, 'appdata');
        const cfg = path.join(appData, 'floe', 'desktop.json');
        mkdirSync(path.dirname(cfg), { recursive: true });
        const bak = path.join(dir, 'desktop.json.bak');
        writeFileSync(bak, '{"reportStats":true}\n');
        writeFileSync(cfg, '{"reportStats":false}\n');
        const sha = sha256(readFileSync(bak));
        const fence = createFence({
            allow: [path.join(dir, 'out')],
            repoRoots: [],
            appData,
        });
        const victim = path.join(dir, 'victim.json');
        writeFileSync(victim, 'precious');
        await assert.rejects(
            restoreConfig(
                { backup: bak, configPath: victim, sha256: sha },
                { lister: async () => [], fence }
            ),
            SafetyError
        );
        assert.equal(readFileSync(victim, 'utf8'), 'precious');
        const r = await restoreConfig(
            { backup: bak, configPath: cfg, sha256: sha },
            { lister: async () => [], fence }
        );
        assert.equal(r.ok, true);
        assert.equal(r.written, true);
        assert.equal(readFileSync(cfg, 'utf8'), '{"reportStats":true}\n');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('awaitDone classifies the relay-cap refusal, errors and cancels; timeout is a PhaseError', async () => {
    const state = {
        values: {},
        texts: [
            'READY',
            'Error: transfer blocked: relay connections are capped at 2 GB (selected 3.0 GB). Turn off Hide my IP to send larger files',
        ],
        buttons: [],
    };
    const { leg } = legWith({ role: 'sender', files: ['a'] }, state);
    leg.driver = scriptedDriver(state);
    const refusal = await leg.awaitDone(1000);
    assert.deepEqual(
        [refusal.ok, refusal.kind, refusal.detail.class],
        [true, 'refusal', 'relay-cap-refusal']
    );
    state.texts = [
        'READY',
        'Error: The transfer stalled and gave up. Start it again.',
    ];
    assert.deepEqual((await leg.awaitDone(1000)).ok, false);
    state.texts = ['READY', STRINGS.canceled];
    assert.equal((await leg.awaitDone(1000)).kind, 'canceled');
    state.texts = ['ACTIVE'];
    await assert.rejects(
        leg.awaitDone(1200),
        (err) => err instanceof PhaseError && err.phase === 'done'
    );
});

test('sender awaitDone: the joined Sent line is primary; the pill READY fallback needs a decisive sample, a READY dwell, no busy footer and no error', async () => {
    // 2026-08-28 second shipped run: the receiver's Saved to line joined,
    // the sender's Sent line never did, and the cell failed on a transfer
    // whose bytes had already been hashed. The fallback only fires once
    // DIRECT or RELAY was sampled and READY has held for
    // READY_AFTER_DECISIVE_MS since; the line read still goes first.
    const readyLeg = () => {
        const state = {
            values: {},
            texts: ['ACTIVE', STRINGS.peerConnected],
            buttons: [],
            pillScript: null,
        };
        const { leg, driver } = legWith(
            { role: 'sender', files: ['a'] },
            state
        );
        leg.driver = driver;
        return { leg, driver, state };
    };
    const settle = async (leg, state) => {
        leg.startSampler();
        state.pillScript = ['DIRECT', 'READY'];
        await leg.awaitConnected(1000);
        await sleep(400);
        assert.equal(leg.route().verdict, 'direct');
    };

    // 1. The fallback path: no Sent line ever joins, footer gone, no error.
    const a = readyLeg();
    await settle(a.leg, a.state);
    a.state.texts = ['READY'];
    const t0 = Date.now();
    const done = await a.leg.awaitDone(8000);
    const took = Date.now() - t0;
    a.leg.stopSampler();
    assert.equal(done.ok, true);
    assert.equal(done.kind, 'transfer');
    assert.equal(done.detail.outcome, COMPLETION_PILL_READY);
    assert.equal(done.detail.route, 'direct');
    assert.ok(
        done.detail.readyMs >= READY_AFTER_DECISIVE_MS,
        `readyMs=${done.detail.readyMs}`
    );
    assert.ok(took >= 1000 && took < 6000, `took ${took} ms`);
    assert.equal(a.leg.evidence().completion, COMPLETION_PILL_READY);
    assert.ok(
        a.leg.notes.some((n) => n.includes(COMPLETION_PILL_READY)),
        'the fallback leaves a note'
    );
    // The line read went first on every turn, then the status, then the
    // busy footer (controlType any) before the fallback fired.
    const order = a.driver.reads.map((r) => r.re);
    assert.equal(order[0], RE.peerConnected);
    assert.ok(order.indexOf(RE.sent) < order.indexOf(RE.busyFooter));
    assert.ok(
        a.driver.reads.some(
            (r) => r.re === RE.busyFooter && r.opts.controlType === 'any'
        )
    );

    // 2. The primary path wins when the line joins, even with the same
    //    READY dwell on record.
    const b = readyLeg();
    await settle(b.leg, b.state);
    await sleep(READY_AFTER_DECISIVE_MS + 200);
    b.state.texts = ['READY', ['Sent ', '1', ' item']];
    const line = await b.leg.awaitDone(3000);
    b.leg.stopSampler();
    assert.equal(line.detail.line, 'Sent 1 item');
    assert.equal(line.detail.outcome, undefined);
    assert.equal(b.leg.evidence().completion, 'line');

    // 3. The busy footer still showing blocks the fallback.
    const c = readyLeg();
    await settle(c.leg, c.state);
    c.state.texts = ['READY', STRINGS.busyFooter];
    await assert.rejects(
        c.leg.awaitDone(READY_AFTER_DECISIVE_MS + 1500),
        (err) => err instanceof PhaseError && err.phase === 'done'
    );
    c.leg.stopSampler();
    assert.equal(c.leg.completion, null);

    // 4. An error status wins over the fallback.
    const d = readyLeg();
    await settle(d.leg, d.state);
    await sleep(READY_AFTER_DECISIVE_MS + 200);
    d.state.texts = ['READY', ['Error: ', 'boom']];
    const failed = await d.leg.awaitDone(3000);
    d.leg.stopSampler();
    assert.equal(failed.kind, 'error');
    assert.equal(failed.ok, false);
    assert.equal(d.leg.evidence().completion, 'error');

    // 5. No decisive sample (the pill never read DIRECT or RELAY): no
    //    fallback, the leg times out as before.
    const e = readyLeg();
    e.state.pillScript = ['READY'];
    e.leg.startSampler();
    await e.leg.awaitConnected(1000);
    e.state.texts = ['READY'];
    await assert.rejects(
        e.leg.awaitDone(READY_AFTER_DECISIVE_MS + 1500),
        (err) => err instanceof PhaseError && err.phase === 'done'
    );
    e.leg.stopSampler();
    assert.equal(e.leg.readyAfterDecisiveMs(), 0);

    // 6. A receiver never takes the fallback.
    const rstate = { values: {}, texts: ['READY'], buttons: [] };
    const r = legWith(
        { role: 'receiver', code: 'x', outDir: 'C:\\out\\a1' },
        rstate
    );
    r.leg.driver = r.driver;
    r.leg.decisive = {
        t: Date.now() - 5000,
        text: 'DIRECT',
        verdict: 'direct',
    };
    r.leg.samples.push({
        t: Date.now() - 4000,
        text: 'READY',
        verdict: 'unknown',
    });
    await assert.rejects(
        r.leg.awaitDone(1200),
        (err) => err instanceof PhaseError && err.phase === 'done'
    );
});

test('awaitDone joins the split leaves of Sent {n} {item} and Saved to {dir}; status and Incoming join, the pill read does not', async () => {
    // MEASURED 2026-08-28: Chromium exposes each DOM text node as its own
    // UIA Text element, so the completion line is three leaves and the
    // shipped run polled ^Sent \d+ items?$ for 105 s with the line on screen.
    const sender = {
        values: {},
        texts: ['READY', ['Sent ', '1', ' item']],
        buttons: [],
    };
    const s = legWith({ role: 'sender', files: ['a'] }, sender);
    s.leg.driver = s.driver;
    const sent = await s.leg.awaitDone(2000);
    assert.equal(sent.ok, true);
    assert.equal(sent.detail.line, 'Sent 1 item');
    assert.equal(s.driver.reads.find((r) => r.re === RE.sent).opts.join, true);

    const receiver = {
        values: {},
        texts: ['READY', ['Saved to ', 'C:\\out\\a1']],
        buttons: [],
    };
    const r = legWith(
        { role: 'receiver', code: 'x', outDir: 'C:\\out\\a1' },
        receiver
    );
    r.leg.driver = r.driver;
    const saved = await r.leg.awaitDone(2000);
    assert.equal(saved.kind, 'transfer');
    assert.equal(saved.detail.dir, 'C:\\out\\a1');
    assert.equal(
        r.driver.reads.find((rd) => rd.re === RE.savedTo).opts.join,
        true
    );

    // Status and Incoming reads join too; the pill read never does.
    const st = {
        values: {},
        texts: ['ACTIVE', ['Error: ', 'boom']],
        buttons: [],
    };
    const e = legWith({ role: 'receiver', code: 'x', outDir: 'C:\\o' }, st);
    e.leg.driver = e.driver;
    assert.deepEqual(await e.leg.readStatus(), {
        kind: 'error',
        text: 'Error: boom',
    });
    st.texts = ['DIRECT', ['Incoming: ', 'a.bin · 1.0 MB']];
    const conn = await e.leg.awaitConnected(2000);
    assert.equal(conn.line, 'Incoming: a.bin · 1.0 MB');
    e.leg.startSampler();
    await sleep(250);
    e.leg.stopSampler();
    const pillReads = e.driver.reads.filter((rd) => rd.re === RE.pill);
    assert.ok(pillReads.length > 0);
    assert.ok(pillReads.every((rd) => !rd.opts.join));
    assert.ok(
        e.driver.reads
            .filter((rd) => rd.re !== RE.pill && rd.re !== RE.busyFooter)
            .every((rd) => rd.opts.join === true),
        'every non-pill oracle read joins'
    );

    // The same tree through a driver that ignores join never completes:
    // the shape of the shipped failure.
    const blind = {
        values: {},
        texts: ['READY', ['Sent ', '1', ' item']],
        buttons: [],
        joinSupported: false,
    };
    const b = legWith({ role: 'sender', files: ['a'] }, blind);
    b.leg.driver = b.driver;
    await assert.rejects(
        b.leg.awaitDone(1200),
        (err) => err instanceof PhaseError && err.phase === 'done'
    );
});

test('pill sampling: 100 ms for 5 s after the connected mark; the decisive sample survives READY after completion', async () => {
    // 2026-08-28 D2C: sampled at 500 ms the sender's pill read ACTIVE then
    // READY and never DIRECT (a 12 MiB loopback transfer is busy 0.4 s).
    const state = {
        values: {},
        texts: ['ACTIVE', STRINGS.waitingForReceiver],
        buttons: [],
        pillScript: null,
    };
    const { leg, driver } = legWith({ role: 'sender', files: ['a'] }, state);
    leg.driver = driver;
    assert.equal(leg.sampleInterval(), SAMPLE_MS);
    leg.startSampler();
    await sleep(650);
    const idle = leg.samples.length;
    assert.ok(idle >= 1 && idle <= 3, `idle cadence 500 ms, got ${idle}`);
    assert.equal(leg.route().verdict, 'unknown');
    // The peer connects: the pill goes ACTIVE, DIRECT, then READY.
    state.pillScript = ['ACTIVE', 'DIRECT', 'READY'];
    state.texts = ['ACTIVE', STRINGS.peerConnected];
    await leg.awaitConnected(1000);
    assert.equal(leg.sampleInterval(), FAST_SAMPLE_MS);
    await sleep(1200);
    const since = leg.samples.filter((x) => x.t >= leg.marks.connected);
    assert.ok(since.length >= 5, `fast cadence, got ${since.length} in 1.2 s`);
    assert.equal(leg.route().verdict, 'direct');
    assert.equal(leg.route().text, 'DIRECT');
    assert.ok(leg.marks.route);
    assert.equal(leg.samples[leg.samples.length - 1].text, 'READY');
    state.texts = ['READY', ['Sent ', '1', ' item']];
    assert.equal((await leg.awaitDone(2000)).ok, true);
    await sleep(300);
    assert.equal(
        leg.route().verdict,
        'direct',
        'READY after completion never overwrites the decisive sample'
    );
    assert.equal(leg.evidence().decisive.text, 'DIRECT');
    leg.marks.connected = Date.now() - FAST_SAMPLE_WINDOW_MS - 1;
    assert.equal(leg.sampleInterval(), SAMPLE_MS);
    leg.stopSampler();
    assert.equal(leg._sampler, null);
});

test('outputs() walks outDir with sha256 and refuses leftover .part files', async () => {
    const dir = tmp();
    try {
        writeFileSync(path.join(dir, 'b.bin'), 'bbb');
        writeFileSync(path.join(dir, 'a.bin'), 'aaa');
        const leg = createLeg({
            role: 'receiver',
            outDir: dir,
            input: 'code',
            code: 'x',
        });
        const out = await leg.outputs();
        assert.deepEqual(
            out.map((f) => [f.rel, f.bytes]),
            [
                ['a.bin', 3],
                ['b.bin', 3],
            ]
        );
        assert.equal(out[0].sha256, sha256('aaa'));
        writeFileSync(path.join(dir, 'c.bin.part'), 'c');
        await assert.rejects(
            leg.outputs(),
            (err) => err.phase === 'verify' && err.parts[0] === 'c.bin.part'
        );
        assert.deepEqual(
            await createLeg({ role: 'sender', files: ['x'] }).outputs(),
            []
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('aggregateProbes maps P1/P6/P9 to the gates and leaves unknowns null', () => {
    const ev = { hwnd: 1 };
    const full = aggregateProbes(
        [
            { probe: 'P1', verdict: 'drivable', detail: {}, evidence: ev },
            { probe: 'P2', verdict: 'isolated', detail: {}, evidence: ev },
            {
                probe: 'P6',
                verdict: 'packaged-argv-ok',
                detail: {},
                evidence: ev,
            },
            { probe: 'P8', verdict: 'no-activation', detail: {}, evidence: ev },
            {
                probe: 'P9',
                verdict: 'restored-across-relaunch',
                detail: { original: 'D:\\x', settable: true },
                evidence: ev,
            },
        ],
        { userAway: false, mode: 'store' }
    );
    assert.equal(full.available, true);
    assert.equal(full.receiverDrivable, true);
    assert.equal(full.saveDirSettable, true);
    assert.equal(full.senderDrivable, true);
    assert.equal(full.present, true);
    assert.equal(full.focusNeeded, false);
    assert.equal(full.mode, 'store');
    assert.equal(full.saveDirOriginal, 'D:\\x');
    assert.equal(
        full.detail,
        'P1 drivable; P2 isolated; P6 packaged-argv-ok; P8 no-activation; P9 restored-across-relaunch'
    );
    assert.equal(full.probes.P9.verdict, 'restored-across-relaunch');
    const partial = aggregateProbes(
        [
            { probe: 'P1', verdict: 'not-drivable', detail: {}, evidence: ev },
            { probe: 'P2', verdict: 'skipped', detail: 'no portable exe' },
            { probe: 'P6', verdict: 'error', detail: 'boom' },
            {
                probe: 'P9',
                verdict: 'not-restored',
                detail: { settable: true },
            },
        ],
        { userAway: true }
    );
    assert.equal(partial.available, true);
    assert.equal(partial.receiverDrivable, false);
    assert.equal(partial.senderDrivable, null);
    assert.equal(partial.saveDirSettable, false);
    assert.equal(partial.present, false);
    const dark = aggregateProbes([
        { probe: 'P1', verdict: 'error', detail: 'UIA helper: script-missing' },
    ]);
    assert.equal(dark.available, false);
    assert.equal(dark.receiverDrivable, null);
    const none = aggregateProbes([]);
    assert.equal(none.available, null);
    assert.equal(none.detail, 'no probe ran');
});

test('probe() without a name aggregates; wailsdev needs no window', async () => {
    const r = await probe({ mode: 'wailsdev' });
    assert.equal(r.available, null);
    assert.equal(r.receiverDrivable, null);
    assert.equal(r.focusNeeded, false);
    assert.match(r.detail, /Playwright/);
    assert.deepEqual(r.probes, {});
    assert.equal(typeof r.ms, 'number');
});

test('restoreConfig puts the backup back only when safe, and says when it wrote nothing', async () => {
    const dir = tmp();
    try {
        const cfg = path.join(dir, 'desktop.json');
        const bak = path.join(dir, 'desktop.json.bak');
        writeFileSync(bak, '{"reportStats":true}\n');
        writeFileSync(cfg, '{"reportStats":false}\n');
        const sha = sha256(readFileSync(bak));
        const busy = await restoreConfig(
            { backup: bak, configPath: cfg, sha256: sha },
            { lister: async () => [{ pid: 7, image: EXE_NAME }] }
        );
        assert.equal(busy.ok, false);
        assert.match(busy.detail, /running/);
        assert.equal(readFileSync(cfg, 'utf8'), '{"reportStats":false}\n');
        const bad = await restoreConfig(
            { backup: bak, configPath: cfg, sha256: '0'.repeat(64) },
            { lister: async () => [] }
        );
        assert.equal(bad.ok, false);
        assert.match(bad.detail, /differs/);
        const done = await restoreConfig(
            { backup: bak, configPath: cfg, sha256: sha },
            { lister: async () => [] }
        );
        assert.equal(done.ok, true);
        assert.equal(done.written, true);
        assert.equal(readFileSync(cfg, 'utf8'), '{"reportStats":true}\n');
        const again = await restoreConfig(
            { backup: bak, configPath: cfg, sha256: sha },
            { lister: async () => [] }
        );
        assert.equal(again.ok, true);
        assert.equal(again.written, false);
        assert.match(again.detail, /already matches/);
        assert.equal((await restoreConfig({ backup: null })).ok, true);
        assert.equal(
            (
                await restoreConfig(
                    { backup: path.join(dir, 'missing.bak'), configPath: cfg },
                    { lister: async () => [] }
                )
            ).ok,
            false
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('probe() never throws and names its probes; store paths sit under WindowsApps', async () => {
    assert.deepEqual(PROBE_NAMES, ['P1', 'P2', 'P6', 'P8', 'P9']);
    const unknown = await probe({ probe: 'P3' });
    assert.equal(unknown.verdict, 'unknown-probe');
    const failing = await probe({
        probe: 'P2',
        build: { launch: 'portable' },
        out: null,
    });
    assert.equal(failing.probe, 'P2');
    assert.equal(failing.verdict, 'error');
    assert.match(failing.detail, /exe|scratch/);
    assert.ok(WINDOWS_APPS.endsWith('\\'));
});

test('awaitConnected accepts a completion that landed between two polls (fast transfer)', async () => {
    // 2026-08-29: the WSL sender moved 12 MiB to the desktop in 0.3 s, so no
    // Incoming, progress or DIRECT sample was ever read at 500 ms, while the
    // window already showed Saved to and the pill READY.
    const state = {
        values: { [STRINGS.saveDirPlaceholder]: 'C:\\old\\dir' },
        texts: ['READY', 'Enter a code or link, then click Receive.'],
        buttons: ['SEND', 'RECEIVE', 'Browse', 'Receive'],
    };
    state.onClick = (name, opts) => {
        if (sameText(name, 'Receive') && opts.after === STRINGS.codePlaceholder)
            state.texts = [
                'ACTIVE',
                STRINGS.connecting,
                'KEEP THIS WINDOW OPEN. CLOSING IT CANCELS THE TRANSFER.',
            ];
    };
    const { leg } = legWith(
        {
            role: 'receiver',
            input: 'code',
            code: 'olive-tiger-castle',
            outDir: 'C:\\out\\fast',
            build: { launch: 'portable', path: 'x' },
        },
        state
    );
    await leg.start();
    state.texts = ['READY', 'Saved to C:\\out\\fast'];
    const conn = await leg.awaitConnected(2000);
    assert.match(
        conn.line,
        /^completed before a connect sample: Saved to C:\\out\\fast$/
    );
    assert.ok(leg.marks.connected);
    const done = await leg.awaitDone(2000);
    assert.equal(done.kind, 'transfer');
    assert.equal(done.detail.dir, 'C:\\out\\fast');
    await leg.stop('test');

    // The sender side: Sent n items proves the connection the same way.
    const sstate = {
        values: {},
        texts: ['READY', 'Select or drag files, then click Send.'],
        buttons: ['SEND', 'RECEIVE', 'Send 1 item'],
    };
    sstate.onClick = (name) => {
        if (sameText(name, 'Send 1 item'))
            sstate.texts = [
                'ACTIVE',
                'CODE OR LINK',
                'olive-tiger-castle',
                'https://floe.one/#room=abc',
                'Waiting for the receiver...',
            ];
    };
    const s = legWith(
        {
            role: 'sender',
            files: ['C:\\fx\\a.bin'],
            build: { launch: 'portable', path: 'x' },
        },
        sstate
    );
    await s.leg.start();
    sstate.texts = ['READY', 'Sent 1 item'];
    const sconn = await s.leg.awaitConnected(2000);
    assert.match(
        sconn.line,
        /^completed before a connect sample: Sent 1 item$/
    );
    assert.equal((await s.leg.awaitDone(2000)).ok, true);
    await s.leg.stop('test');
});
