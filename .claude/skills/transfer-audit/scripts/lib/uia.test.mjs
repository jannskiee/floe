// Tests for lib/uia.mjs: the line framing, then the client against
// lib/tests/fake-uia.mjs (a Node stand-in for the PowerShell helper) for
// round trips, UTF-8, errors, timeouts, retries and a crashed helper, and
// finally the real desktop-uia.ps1 -Serve on Windows for ping, exe-version,
// a refused show mode and quit. No window is ever opened.
//
// Run: node --test .claude/skills/<skill>/scripts/lib/uia.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
    COMMANDS,
    FIXED_TIMEOUTS,
    HELPER_TIMEOUT_DEFAULTS,
    SCRIPT_PATH,
    SLACK_MS,
    UiaClient,
    UiaError,
    frameRequest,
    parseResponseLine,
    powershellArgs,
    regexParams,
    timeoutFor,
    withUia,
} from './uia.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'tests', 'fake-uia.mjs');
const fakeClient = (opts = {}) =>
    new UiaClient({ command: process.execPath, args: [FAKE], ...opts });

test('SCRIPT_PATH resolves to desktop-uia.ps1 next to lib/', () => {
    assert.equal(path.basename(SCRIPT_PATH), 'desktop-uia.ps1');
    assert.equal(path.dirname(SCRIPT_PATH), path.resolve(HERE, '..'));
    assert.ok(existsSync(SCRIPT_PATH), SCRIPT_PATH);
    const args = powershellArgs();
    assert.deepEqual(args.slice(0, 5), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
    ]);
    assert.equal(args[5], SCRIPT_PATH);
    assert.equal(args[6], '-Serve');
});

test('frameRequest and parseResponseLine agree on the wire shape', () => {
    const line = frameRequest(7, 'set-value', {
        hwnd: 1968,
        placeholder: 'amber-otter-cloud',
        value: 'x',
        scope: undefined,
    });
    assert.deepEqual(JSON.parse(line), {
        hwnd: 1968,
        placeholder: 'amber-otter-cloud',
        value: 'x',
        id: 7,
        cmd: 'set-value',
    });
    assert.ok(!line.includes('\n'));
    assert.deepEqual(parseResponseLine('{"id":7,"ok":true,"ms":1}\r'), {
        id: 7,
        ok: true,
        ms: 1,
    });
    assert.equal(parseResponseLine('   '), null);
    assert.equal(
        parseResponseLine('Add-Type : error').parseError.length > 0,
        true
    );
    assert.equal(parseResponseLine('42').parseError, 'not an object');
});

test('timeoutFor adds slack to helper timeouts and uses the fixed table otherwise', () => {
    assert.equal(
        timeoutFor('find-window'),
        HELPER_TIMEOUT_DEFAULTS['find-window'] + SLACK_MS
    );
    assert.equal(timeoutFor('click', { timeoutMs: 1000 }), 1000 + SLACK_MS);
    assert.equal(timeoutFor('capture'), FIXED_TIMEOUTS.capture);
    assert.equal(timeoutFor('capture', {}, { capture: 99 }), 99);
    assert.equal(timeoutFor('nope'), 15_000);
    for (const cmd of COMMANDS) assert.ok(timeoutFor(cmd) > 0, cmd);
});

test('timeoutFor ignores a non-numeric timeoutMs and powershellArgs carries -Root', () => {
    const dflt = HELPER_TIMEOUT_DEFAULTS.click + SLACK_MS;
    assert.equal(timeoutFor('click', { timeoutMs: 'abc' }), dflt);
    assert.equal(timeoutFor('click', { timeoutMs: NaN }), dflt);
    assert.equal(timeoutFor('click', { timeoutMs: -5 }), dflt);
    assert.equal(timeoutFor('click', { timeoutMs: '250' }), 250 + SLACK_MS);
    assert.deepEqual(
        powershellArgs('x.ps1', { root: 'C:\\lta\\run' }).slice(-3),
        ['-Serve', '-Root', 'C:\\lta\\run']
    );
    assert.ok(!powershellArgs('x.ps1').includes('-Root'));
    assert.deepEqual(new UiaClient({ root: 'C:\\r' }).args.slice(-2), [
        '-Root',
        'C:\\r',
    ]);
    assert.equal(new UiaClient().root, null);
});

test('fake helper: a wedged helper is killed and close() still returns its exit', async () => {
    const c = fakeClient();
    await c.open();
    assert.equal((await c.request('wedge')).wedged, true);
    const t0 = Date.now();
    const exit = await c.close({ graceMs: 1000 });
    assert.ok(exit, 'close() waited for the exit record after the kill');
    assert.equal(c.alive, false);
    assert.equal(c.exit, exit);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(await c.close(), exit, 'a second close is a no-op');
});

test('regexParams carries the i flag to the helper', () => {
    assert.deepEqual(regexParams(/^(Ready|Active)$/i), {
        regex: '^(Ready|Active)$',
        ignoreCase: true,
    });
    assert.deepEqual(regexParams(/^Saved to (.+)$/), {
        regex: '^Saved to (.+)$',
        ignoreCase: false,
    });
    assert.deepEqual(regexParams('x'), { regex: 'x', ignoreCase: true });
});

test('fake helper: open, ping, typed helper, UTF-8 echo, close', async () => {
    const lines = [];
    const c = fakeClient({ log: (l) => lines.push(l) });
    await c.open();
    assert.equal(c.alive, true);
    const pong = await c.ping();
    assert.equal(pong.pong, true);
    const win = await c.findWindow({ class: 'wailsWindow', title: 'Floe' });
    assert.equal(win.hwnd, 4242);
    const echo = await c.request('echo', {
        text: 'Incoming: файл · 30.0 MB',
        list: [1, { a: 'b' }],
    });
    assert.deepEqual(echo.echo, {
        text: 'Incoming: файл · 30.0 MB',
        list: [1, { a: 'b' }],
    });
    const texts = await c.readText(4242, /^ready$/i);
    assert.deepEqual(texts.texts, ['Ready']);
    const exit = await c.close();
    assert.equal(exit.code, 0);
    assert.equal(c.alive, false);
    assert.ok(lines.some((l) => /send .*"cmd":"ping"/.test(l)));
    assert.ok(lines.some((l) => /recv .*"pong":true/.test(l)));
    await assert.rejects(
        c.request('ping'),
        (err) => err instanceof UiaError && err.reason === 'not-open'
    );
});

test('fake helper: readText carries join and the helper joins the leaves of one text line', async () => {
    // Chromium exposes each DOM text node as its own Text element, so the
    // completion line `Sent 1 item` is three or four leaves (helper
    // MEASURED 8), and the count sits in its own element, so their parents
    // differ (INFERRED 9: the run is geometric).
    const c = fakeClient();
    await c.open();
    try {
        const split = await c.readText(4242, /^Sent \d+ items?$/i);
        assert.deepEqual(split.texts, []);
        assert.equal(split.joined, 0);
        const joined = await c.readText(4242, /^Sent \d+ items?$/i, {
            join: true,
        });
        // Nested leaves: `1` has a different parent from `Sent ` and `item`
        // and the whitespace leaf between them never ends the run.
        assert.deepEqual(joined.texts, ['Sent 1 item']);
        assert.equal(joined.joined, 3);
        assert.equal(joined.nodes, 11);
        assert.equal(joined.rects, 9);
        // Same row, 260 px apart: two runs, so the eyebrow and its count
        // never fuse into `FILES 1 ITEM`.
        const apart = await c.readText(4242, /^(FILES|1 ITEM)$/i, {
            join: true,
        });
        assert.deepEqual(apart.texts, ['FILES', '1 ITEM']);
        // Rectless leaves still group by parent.
        const rectless = await c.readText(4242, /^Saved to (.+)$/i, {
            join: true,
        });
        assert.deepEqual(rectless.texts, ['Saved to C:\\out\\a1']);
        const single = await c.readText(4242, /^ready$/i, { join: true });
        assert.deepEqual(single.texts, ['Ready']);
        // A leaf that matches on its own yields to the run's joined line.
        const leaf = await c.readText(4242, /^Error: .*$/i);
        assert.deepEqual(leaf.texts, ['Error: ']);
        const line = await c.readText(4242, /^Error: .*$/i, { join: true });
        assert.deepEqual(line.texts, ['Error: boom']);
    } finally {
        await c.close();
    }
    // The wire carries join only when set, so the helper's default holds.
    assert.ok(
        !frameRequest(1, 'read-text', { join: undefined }).includes('join')
    );
    assert.match(frameRequest(1, 'read-text', { join: true }), /"join":true/);
});

test('fake helper: ok:false becomes a UiaError with reason and detail', async () => {
    await withUia(
        async (c) => {
            await assert.rejects(c.request('nope'), (err) => {
                assert.ok(err instanceof UiaError);
                assert.equal(err.reason, 'unknown-cmd');
                assert.equal(err.cmd, 'nope');
                assert.match(err.detail, /nope/);
                return true;
            });
        },
        { command: process.execPath, args: [FAKE] }
    );
});

test('fake helper: a slow command times out on the Node clock and a late answer is logged', async () => {
    const c = fakeClient();
    await c.open();
    try {
        await assert.rejects(
            c.request('slow', { ms: 400 }, { timeoutMs: 100 }),
            (err) => err.reason === 'timeout' && err.timeoutMs === 100
        );
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(c.late.length, 1);
        assert.equal(c.late[0].slept, 400);
        // The helper is still healthy afterwards.
        assert.equal((await c.ping()).pong, true);
    } finally {
        await c.close();
    }
});

test('fake helper: retry retries only retryable reasons', async () => {
    const c = fakeClient();
    await c.open();
    try {
        const ok = await c.retry(
            'flaky',
            { key: 'a', times: 2, reason: 'not-found' },
            { attempts: 3, delayMs: 10 }
        );
        assert.equal(ok.attempts, 3);
        await assert.rejects(
            c.retry(
                'flaky',
                { key: 'b', times: 2, reason: 'not-found' },
                { attempts: 2, delayMs: 10 }
            ),
            (err) => err.reason === 'not-found'
        );
        await assert.rejects(
            c.retry(
                'flaky',
                { key: 'c', times: 5, reason: 'ambiguous' },
                { attempts: 3, delayMs: 10 }
            ),
            (err) => err.reason === 'ambiguous'
        );
        assert.equal(
            (await c.request('flaky', { key: 'c', times: 0 })).attempts,
            2
        );
    } finally {
        await c.close();
    }
});

test('fake helper: a crash rejects every pending request with helper-exited', async () => {
    const c = fakeClient();
    await c.open();
    const pending = c.request('noreply', {}, { timeoutMs: 5000 });
    const crash = c.request('crash', {}, { timeoutMs: 5000 });
    await assert.rejects(pending, (err) => err.reason === 'helper-exited');
    await assert.rejects(crash, (err) => err.reason === 'helper-exited');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.alive, false);
    assert.equal(c.exit.code, 3);
    await assert.rejects(c.request('ping'), (err) => err.reason === 'not-open');
    assert.equal(await c.close(), c.exit);
});

test('open() rejects when the script is missing', async () => {
    const c = new UiaClient({ script: path.join(HERE, 'no-such.ps1') });
    await assert.rejects(c.open(), (err) => err.reason === 'script-missing');
});

test(
    'real helper: ping, exe-version, refused show mode, quit (Windows only, no window)',
    {
        skip:
            process.platform !== 'win32'
                ? 'powershell.exe helper is Windows only'
                : false,
    },
    async () => {
        const c = new UiaClient();
        await c.open();
        try {
            const pong = await c.ping();
            assert.equal(pong.pong, true);
            assert.match(pong.ps, /^5\.1/);
            await assert.rejects(
                c.request('bogus-cmd'),
                (err) => err.reason === 'unknown-cmd'
            );
            const notepad = path.join(
                process.env.SystemRoot || 'C:\\Windows',
                'System32',
                'notepad.exe'
            );
            if (existsSync(notepad)) {
                const v = await c.exeVersion(notepad);
                assert.ok(v.productVersion.length > 0, JSON.stringify(v));
            }
            await assert.rejects(
                c.request('show', { hwnd: 1, mode: 9 }),
                (err) => err.reason === 'mode-not-allowed'
            );
            await assert.rejects(
                c.request('read-text', { hwnd: 1, regex: 'x' }),
                (err) => err.reason === 'not-a-window'
            );
            await assert.rejects(
                c.click(1, 'Receive'),
                (err) => err.reason === 'not-a-window'
            );
            // Malformed parameters are bad-request (never retried), not
            // exception (retried twice for nothing).
            await assert.rejects(
                c.request('read-text', { hwnd: 1, regex: '[' }),
                (err) =>
                    err.reason === 'bad-request' &&
                    /invalid regex/.test(err.detail)
            );
            await assert.rejects(
                c.request('read-text', { hwnd: 1, regex: 'x', max: 'abc' }),
                (err) => err.reason === 'bad-request' && /max/.test(err.detail)
            );
            await assert.rejects(
                c.request('close', { hwnd: 'abc' }),
                (err) => err.reason === 'bad-request' && /hwnd/.test(err.detail)
            );
            // A framing slip still answers under its id, so the client never
            // waits a full timeout on it.
            c.proc.stdin.write('{"id": 777, oops\n');
            for (let i = 0; i < 50 && !c.late.some((m) => m.id === 777); i++)
                await new Promise((r) => setTimeout(r, 100));
            const echoed = c.late.find((m) => m.id === 777);
            assert.ok(echoed, 'the unparseable line answered under id 777');
            assert.equal(echoed.ok, false);
            assert.equal(echoed.reason, 'bad-request');
        } finally {
            const exit = await c.close();
            assert.equal(exit.code, 0);
        }
        // -Root: a capture path outside the run dir is refused before the
        // window is even looked at; one inside reaches the hwnd check.
        const rooted = new UiaClient({ root: 'C:\\lta-root' });
        await rooted.open();
        try {
            await assert.rejects(
                rooted.capture(1, 'C:\\elsewhere\\x.png'),
                (err) =>
                    err.reason === 'bad-request' &&
                    /outside -Root/.test(err.detail)
            );
            await assert.rejects(
                rooted.capture(1, 'C:\\lta-root\\cells\\x.png'),
                (err) => err.reason === 'not-a-window'
            );
        } finally {
            await rooted.close();
        }
    }
);

test('moveWindow and listMonitors send the shapes the helper documents', async () => {
    const sent = [];
    const client = {
        request(cmd, params) {
            sent.push({ cmd, params });
            return Promise.resolve({ ok: true });
        },
    };
    // Borrow the real methods: they must not invent their own transport.
    const proto = Object.getPrototypeOf(new UiaClient({ root: 'x' }));
    await proto.moveWindow.call(client, 4242);
    await proto.moveWindow.call(client, 4242, 2);
    await proto.listMonitors.call(client);
    assert.deepEqual(sent, [
        { cmd: 'move-window', params: { hwnd: 4242, monitor: 'secondary' } },
        { cmd: 'move-window', params: { hwnd: 4242, monitor: '2' } },
        { cmd: 'list-monitors', params: {} },
    ]);
});

test('the helper documents move-window and never activates the window', () => {
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    // One call site, and its flags are the two that mean "move only".
    assert.equal(
        (src.match(/::SetWindowPos\(/g) || []).length,
        1,
        'exactly one SetWindowPos call site'
    );
    assert.match(src, /\$flags = \$SWP_NOACTIVATE -bor \$SWP_NOZORDER/);
    const callLine = src
        .split(/\r?\n/)
        .find((l) => l.includes('::SetWindowPos('));
    assert.ok(callLine, 'the call site is findable');
    assert.ok(
        !/SWP_SHOWWINDOW|HWND_TOPMOST|SWP_NOMOVE/.test(callLine),
        'the call never raises or pins the window: ' + callLine
    );
    assert.ok(
        callLine.includes('$flags)'),
        'the call passes the checked flags'
    );
    // The forbidden list still bans every focus-stealing API.
    for (const banned of [
        'SetForegroundWindow',
        'SetFocus',
        'BringWindowToTop',
        'SwitchToThisWindow',
        'SetActiveWindow',
    ]) {
        const lines = src
            .split(/\r?\n/)
            .filter((l) => l.includes(banned) && !l.includes('# denylist'));
        assert.deepEqual(lines, [], banned);
    }
});

test('the client and the helper agree on the command list', () => {
    // The client refuses a command that is not in its own copy before the
    // helper ever sees it, so a command added to only one side is dead:
    // move-window shipped that way for one run (unknown-cmd from the client
    // while the helper answered it correctly).
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    const block = /\$COMMANDS = @\(([\s\S]*?)\)/.exec(src);
    assert.ok(block, '$COMMANDS block found in the helper');
    const inPs1 = [...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
        [...COMMANDS].sort(),
        inPs1.sort(),
        'lib/uia.mjs COMMANDS and the helper $COMMANDS must match exactly'
    );
    for (const c of ['list-monitors', 'move-window'])
        assert.ok(COMMANDS.includes(c), c);
});
