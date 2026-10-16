/**
 * ShellMenuGuard against the real registry, on Windows only.
 *
 * Every other test of the guard hands it a fake `exec`, so the PowerShell
 * that reads, writes and deletes the key had never run against a registry in
 * a test, and its delete branch had never run anywhere: on a machine with no
 * Explorer verb, the first portable stop would have been its first execution,
 * on the owner's own key (review of #542, finding 7).
 *
 * The key here is a throwaway one this file creates under
 * HKCU\Software\FloeTransferAuditTest-<pid>-<random> and removes again. The
 * real key, HKCU\Software\Classes\*\shell\Floe, is never named.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/shellmenu-registry.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import {
    SHELL_MENU_KEY,
    ShellMenuGuard,
    readShellMenu,
    shellMenuCommand,
} from './desktop.mjs';

const WIN = process.platform === 'win32';
const ROOT = `Software\\FloeTransferAuditTest-${process.pid}-${randomBytes(4).toString('hex')}`;
const made = [];

function reg(args) {
    return execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function exists(key) {
    try {
        reg(['query', `HKCU\\${key}`]);
        return true;
    } catch {
        return false;
    }
}
/** A fresh parent for one case: <ROOT>\<name>\shell, with the verb key under it. */
function scratch(name) {
    const parent = `${ROOT}\\${name}\\shell`;
    reg(['add', `HKCU\\${parent}`, '/f']);
    made.push(`${ROOT}\\${name}`);
    return `${parent}\\Floe`;
}
/** What desktop/contextmenu.go writes: a name, an icon, and the command. */
function register(key, exe) {
    reg(['add', `HKCU\\${key}`, '/ve', '/d', 'Send with Floe', '/f']);
    reg(['add', `HKCU\\${key}`, '/v', 'Icon', '/d', exe, '/f']);
    reg(['add', `HKCU\\${key}\\command`, '/ve', '/d', shellMenuCommand(exe), '/f']);
}

after(() => {
    if (!WIN) return;
    try {
        reg(['delete', `HKCU\\${ROOT}`, '/f']);
    } catch {
        // Never created, or already gone.
    }
});

test('the throwaway key is not the real one', () => {
    assert.equal(SHELL_MENU_KEY, 'Software\\Classes\\*\\shell\\Floe');
    assert.ok(!ROOT.toLowerCase().startsWith('software\\classes'));
});

test('absent before, created by an exe of this run: the key is removed and its parent is kept', { skip: !WIN }, () => {
    const key = scratch('own');
    const exe = 'C:\\Temp\\lta-run\\bin\\floe-desktop.exe';
    const notes = [];
    const guard = new ShellMenuGuard({ key });
    assert.equal(guard.take((l) => notes.push(l)), 'absent');
    assert.deepEqual(readShellMenu({ key }), {
        exists: false,
        present: false,
        values: { name: null, icon: null, command: null },
    });
    // Nothing appeared: nothing to do.
    assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: false, match: true });

    register(key, exe);
    assert.equal(readShellMenu({ key }).values.command.value, `"${exe}" "%1"`);
    // The app registers os.Executable(), whose spelling can differ in case.
    guard.own(exe.toUpperCase());
    assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: true, match: true });
    assert.equal(exists(key), false, 'the verb key is gone');
    assert.equal(exists(key.slice(0, key.lastIndexOf('\\'))), true, 'its parent is not');
    assert.ok(notes.some((n) => /removed HKCU\\.*which a launch of this run had created/.test(n)), notes.join('\n'));
});

test('absent before, created by a head build with MultiSelectModel Player: removed; another MultiSelectModel is left alone', { skip: !WIN }, () => {
    const exe = 'C:\\Temp\\lta-run\\bin\\floe-desktop.exe';
    // After desktop-v0.3.1 the app also writes MultiSelectModel = Player on
    // the verb (desktop/contextmenu_windows.go, A3-B9).
    for (const [value, deleted] of [
        ['Player', true],
        ['Document', false],
    ]) {
        const key = scratch(`multi-${value}`);
        const guard = new ShellMenuGuard({ key });
        assert.equal(guard.take(), 'absent');
        register(key, exe);
        reg(['add', `HKCU\\${key}`, '/v', 'MultiSelectModel', '/d', value, '/f']);
        guard.own(exe);
        const notes = [];
        assert.deepEqual(
            guard.restore((l) => notes.push(l)),
            deleted ? { wrote: true, match: true } : { wrote: false, match: null },
            value
        );
        assert.equal(exists(key), !deleted, value);
    }
});

test('absent before, then a key that is not this run\'s: left exactly as it is', { skip: !WIN }, () => {
    const exe = 'C:\\Temp\\lta-run\\bin\\floe-desktop.exe';

    // Another exe's command.
    let key = scratch('foreign');
    let guard = new ShellMenuGuard({ key });
    assert.equal(guard.take(), 'absent');
    register(key, 'D:\\Apps\\Floe\\floe-desktop.exe');
    const before = readShellMenu({ key });
    guard.own(exe);
    let notes = [];
    assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: false, match: null });
    assert.deepEqual(readShellMenu({ key }), before);
    assert.ok(notes.some((n) => /is not for an exe this run launched; left alone/.test(n)), notes.join('\n'));

    // No exe of this run was launched at all.
    key = scratch('none-launched');
    guard = new ShellMenuGuard({ key });
    assert.equal(guard.take(), 'absent');
    register(key, exe);
    notes = [];
    assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: false, match: null });
    assert.equal(exists(key), true);

    // This run's command, but the key holds more than the app writes.
    for (const extra of [
        (k) => reg(['add', `HKCU\\${k}`, '/v', 'Position', '/d', 'Top', '/f']),
        (k) => reg(['add', `HKCU\\${k}\\DropTarget`, '/f']),
        (k) => reg(['add', `HKCU\\${k}\\command`, '/v', 'DelegateExecute', '/d', 'x', '/f']),
    ]) {
        key = scratch(`extra-${made.length}`);
        guard = new ShellMenuGuard({ key });
        assert.equal(guard.take(), 'absent');
        register(key, exe);
        extra(key);
        guard.own(exe);
        notes = [];
        assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: false, match: null });
        assert.equal(exists(key), true, 'not deleted');
        assert.ok(notes.some((n) => /holds more than the app writes; left alone/.test(n)), notes.join('\n'));
    }
});

test('present before and rewritten by a launch: the snapshot goes back, value kinds included', { skip: !WIN }, () => {
    const key = scratch('armed');
    const owner = 'D:\\Apps\\Floe\\floe-desktop.exe';
    register(key, owner);
    const guard = new ShellMenuGuard({ key });
    const notes = [];
    assert.equal(guard.take((l) => notes.push(l)), 'armed');
    const snapshot = readShellMenu({ key });
    // Unchanged: nothing is written.
    assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: false, match: true });

    // An unpackaged launch points the verb at itself.
    register(key, 'C:\\Temp\\lta-run\\bin\\floe-desktop.exe');
    assert.notDeepEqual(readShellMenu({ key }), snapshot);
    assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: true, match: true });
    assert.deepEqual(readShellMenu({ key }), snapshot);
    assert.ok(notes.some((n) => /put back command "D:\\Apps\\Floe\\floe-desktop\.exe" "%1"/.test(n)), notes.join('\n'));

    // A key the owner removed meanwhile is not recreated.
    reg(['delete', `HKCU\\${key}`, '/f']);
    assert.deepEqual(guard.restore((l) => notes.push(l)), { wrote: false, match: null });
    assert.equal(exists(key), false);
});

test('a base key with no command is left alone for the rest of the process', { skip: !WIN }, () => {
    const key = scratch('incomplete');
    reg(['add', `HKCU\\${key}`, '/ve', '/d', 'Send with Floe', '/f']);
    const guard = new ShellMenuGuard({ key });
    assert.equal(guard.take(), 'incomplete');
    guard.own('C:\\Temp\\lta-run\\bin\\floe-desktop.exe');
    assert.deepEqual(guard.restore(), { wrote: false, match: null });
    assert.equal(exists(key), true);
});
