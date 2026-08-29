// Write fence. Every path the driver writes goes through assertWritable
// first, so the allowlist (the run's --out, --bin-dir, the APPDATA redirect
// dir, and any HEAD build output dirs the caller registers) is the only
// place bytes can land. Refusals are absolute: any `.env*` file, the real
// %APPDATA%\floe tree (the single desktop.json exception needs the guard
// flag), the WebView2 profile under it, any Floe checkout root the caller
// registers (the main checkout and the worktree) and any path with a `..`
// segment before resolution.
import os from 'node:os';
import path from 'node:path';

import { SafetyError } from './surfaces.mjs';

const WIN = process.platform === 'win32';

export function normalizePath(p) {
    const r = path.resolve(String(p));
    return WIN ? r.replace(/\//g, '\\').toLowerCase() : r;
}

export function isUnder(child, parent) {
    const c = normalizePath(child);
    const p = normalizePath(parent);
    if (c === p) return true;
    const sep = WIN ? '\\' : '/';
    return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function hasDotDot(p) {
    return String(p)
        .split(/[\\/]/)
        .some((seg) => seg === '..');
}

export function defaultAppData() {
    return (
        process.env.APPDATA ||
        (WIN
            ? path.join(os.homedir(), 'AppData', 'Roaming')
            : path.join(os.homedir(), '.config'))
    );
}

export class Fence {
    /**
     * @param {object} o
     * @param {string[]} o.allow  directories writes may land in
     * @param {string[]} o.repoRoots  Floe checkouts (never written)
     * @param {string} [o.appData]  the real %APPDATA%
     */
    constructor({ allow = [], repoRoots = [], appData = defaultAppData() }) {
        this.allow = allow.filter(Boolean).map((d) => path.resolve(d));
        this.repoRoots = repoRoots.filter(Boolean).map((d) => path.resolve(d));
        this.appData = path.resolve(appData);
        this.floeDir = path.join(this.appData, 'floe');
        this.webviewDir = path.join(this.floeDir, 'webview');
        this.desktopJson = path.join(this.floeDir, 'desktop.json');
        this.refusals = [];
    }

    allowDir(dir) {
        if (dir) this.allow.push(path.resolve(dir));
    }

    /** Why a path is refused, or null when it is writable. */
    refusalFor(target, { viaGuard = false } = {}) {
        if (target === undefined || target === null || target === '')
            return 'empty path';
        if (hasDotDot(target)) return `path has a .. segment: ${target}`;
        const base = path.basename(String(target));
        if (/^\.env(\..*)?$/i.test(base)) return `env file: ${target}`;
        if (isUnder(target, this.webviewDir))
            return `WebView2 profile under ${this.webviewDir}: ${target}`;
        if (normalizePath(target) === normalizePath(this.desktopJson)) {
            return viaGuard
                ? null
                : `desktop.json is only written through the config guard: ${target}`;
        }
        if (isUnder(target, this.floeDir))
            return `real Floe app data ${this.floeDir}: ${target}`;
        for (const root of this.repoRoots) {
            if (
                isUnder(target, root) &&
                !this.allow.some((a) => isUnder(a, root) && isUnder(target, a))
            )
                return `inside the checkout ${root}: ${target}`;
        }
        if (!this.allow.some((a) => isUnder(target, a)))
            return `outside every allowed dir (${this.allow.join(', ') || 'none'}): ${target}`;
        return null;
    }

    isWritable(target, opts) {
        return this.refusalFor(target, opts) === null;
    }

    /** Returns the resolved path, or throws SafetyError. */
    assertWritable(target, opts) {
        const why = this.refusalFor(target, opts);
        if (why) {
            this.refusals.push(why);
            throw new SafetyError(`write refused: ${why}`, {
                fence: true,
                path: target,
            });
        }
        return path.resolve(String(target));
    }
}

export function createFence(opts) {
    return new Fence(opts);
}
