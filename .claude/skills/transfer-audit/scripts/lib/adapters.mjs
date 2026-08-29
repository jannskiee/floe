// Adapter registry. The surface adapters (web, cli, desktop, wsl) and the
// process and stack helpers are imported lazily, so the pure modules and
// their tests never load Playwright, PowerShell or a Floe binary. Tests
// install in-memory adapters with setAdapter(); a missing module reports
// `pending` instead of crashing the run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.dirname(fileURLToPath(import.meta.url));

const MODULES = Object.freeze({
    web: './web.mjs',
    cli: './cli.mjs',
    desktop: './desktop.mjs',
    wsl: './wsl.mjs',
    proc: './proc.mjs',
    stack: './stack.mjs',
});

const overrides = new Map();
const loaded = new Map();

export function adapterNames() {
    return Object.keys(MODULES);
}

/** Install an adapter module for tests, or null to remove the override. */
export function setAdapter(name, mod) {
    if (!(name in MODULES)) throw new Error(`unknown adapter ${name}`);
    if (mod === null || mod === undefined) overrides.delete(name);
    else overrides.set(name, mod);
}

export function resetAdapters() {
    overrides.clear();
    loaded.clear();
}

/**
 * getAdapter(name) -> module namespace, or throws with `missing: true`
 * when the module file is not there (a sibling builder's deliverable).
 */
export async function getAdapter(name) {
    if (overrides.has(name)) return overrides.get(name);
    if (loaded.has(name)) return loaded.get(name);
    if (!(name in MODULES)) throw new Error(`unknown adapter ${name}`);
    const file = path.join(LIB, MODULES[name]);
    try {
        const mod = await import(`file://${file.replace(/\\/g, '/')}`);
        loaded.set(name, mod);
        return mod;
    } catch (e) {
        if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
            const err = new Error(
                `adapter ${name} is not available (${MODULES[name]} missing)`
            );
            err.missing = true;
            err.adapter = name;
            throw err;
        }
        throw e;
    }
}

/** getAdapter that resolves to null instead of throwing when missing. */
export async function tryAdapter(name) {
    try {
        return await getAdapter(name);
    } catch (e) {
        if (e && e.missing) return null;
        throw e;
    }
}

/** Surface adapters have createLeg and preflight; helpers have neither. */
export function isSurfaceAdapter(mod) {
    return Boolean(
        mod &&
        typeof mod.createLeg === 'function' &&
        typeof mod.preflight === 'function'
    );
}
