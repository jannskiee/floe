#!/usr/bin/env node
// Start a command that holds no foreground rights (FU-26, from the FU-02
// addendum): through Win32_Process.Create (lib/detached.mjs), so the WMI
// provider host is its parent, not this terminal, and a window it opens
// cannot take the foreground from whatever the owner is using. audit.mjs
// already starts its own exes this way; this is for `wails dev` and for any
// test exe an operator or another harness starts.
//
//   node launch-detached.mjs [--cwd <dir>] [--log <file>] -- <command> [args...]
//
// Without --log the command starts directly (a GUI exe) and its first window
// shows SW_SHOWNOACTIVATE. With --log it runs inside a hidden cmd.exe that
// appends its stdout and stderr to <file>, which is what `wails dev` needs;
// stop that one with `taskkill /PID <pid> /T /F`. Either way the process
// gets this shell's whole environment. A Floe desktop (floe-desktop.exe,
// floe-desktop-dev.exe) or `wails dev` is refused while any Floe desktop
// already runs: the single-instance lock would forward the second launch to
// the running app, which raises its own window.
//
// Prints one line, `pid <n>`. Exit 0; 1 when the launch was refused by
// Windows; 2 usage; 3 a Floe desktop already runs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDesktopProcesses } from './lib/desktop.mjs';
import { SPEC_VAR, launchDetached, logWrapped } from './lib/detached.mjs';

export const USAGE =
    'usage: node launch-detached.mjs [--cwd <dir>] [--log <file>] -- <command> [args...]';

/** { cwd, log, command, args } or { error }. */
export function parseArgs(argv) {
    const o = { cwd: null, log: null, command: null, args: [] };
    let i = 0;
    for (; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') {
            i += 1;
            break;
        }
        if (a === '--cwd' || a === '--log') {
            const v = argv[i + 1];
            if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
            o[a.slice(2)] = path.resolve(v);
            i += 1;
            continue;
        }
        return { error: `unknown argument ${a} (the command goes after --)` };
    }
    const rest = argv.slice(i);
    if (!rest.length) return { error: 'no command after --' };
    o.command = rest[0];
    o.args = rest.slice(1);
    return o;
}

/** True for a launch that would start a Floe desktop instance. */
export function startsFloe(command, args) {
    const base = path.basename(String(command)).toLowerCase();
    if (/^floe-desktop(-dev)?(\.exe)?$/.test(base)) return true;
    return /^wails(\.exe)?$/.test(base) && args[0] === 'dev';
}

export async function main(
    argv,
    {
        detach = launchDetached,
        lister = undefined,
        env = process.env,
        out = (s) => process.stdout.write(`${s}\n`),
        err = (s) => process.stderr.write(`${s}\n`),
    } = {}
) {
    const o = parseArgs(argv);
    if (o.error) {
        err(`launch-detached: ${o.error}`);
        err(USAGE);
        return 2;
    }
    if (startsFloe(o.command, o.args)) {
        const running = await listDesktopProcesses(lister);
        if (running.length) {
            err(
                `launch-detached: refused: ${running.map((r) => `${r.image} pid ${r.pid}`).join(', ')} already runs; a second Floe instance would forward to it and raise its window`
            );
            return 3;
        }
    }
    const childEnv = { ...env };
    delete childEnv[SPEC_VAR];
    let spec;
    try {
        spec = o.log
            ? { ...logWrapped(o.command, o.args, o.log), cwd: o.cwd, env: childEnv }
            : { command: o.command, args: o.args, cwd: o.cwd, env: childEnv };
    } catch (e) {
        err(`launch-detached: ${e.message}`);
        return 2;
    }
    try {
        const { pid } = await detach(spec);
        out(`pid ${pid}`);
        return 0;
    } catch (e) {
        err(`launch-detached: ${e.message}`);
        return 1;
    }
}

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
