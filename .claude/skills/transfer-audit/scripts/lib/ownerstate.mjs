/**
 * What the owner's own desktop app held before an audit command changed it,
 * kept under --out so the next command can read it.
 *
 * The Store build runs on the owner's profile, and a cell sets two fields the
 * app remembers between launches: the Make link form's Save to, and the
 * folder of a code Receive. Each leg puts back what it first read. That first
 * read lived only in the memory of the process that made it, and one command
 * runs one cell. After a restore that never happened (the app was killed, a
 * release ran out of time), the next command read the earlier run's own
 * folder, knew it was not the owner's (isAuditFolder in lib/desktop.mjs), and
 * had nothing better to put back than the app's default: the owner's folder
 * was gone for good, and the report called the field restored (second review
 * of #542, finding A).
 *
 * This file is that memory. A caller writes a value only after it has
 * decided the value is the owner's (never an audit's own folder), and the
 * latest such read wins, since the owner may change the field between
 * commands. Best effort throughout: the record is a convenience for the
 * restore, never an oracle, so a file that cannot be read or written costs
 * nothing but the convenience.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const OWNER_STATE_FILE = 'owner-state.json';
/** The Make link form's Save to field, and the code Receive folder. */
export const OWNER_KEYS = Object.freeze(['requestSaveTo', 'receiveSaveDir']);

export function ownerStateFor(outDir, { now = () => new Date() } = {}) {
    const file = outDir ? path.join(outDir, OWNER_STATE_FILE) : null;
    const read = () => {
        if (!file || !existsSync(file)) return {};
        try {
            const v = JSON.parse(readFileSync(file, 'utf8'));
            return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        } catch {
            return {};
        }
    };
    return {
        file,
        /** { value, at } for a key, or null when nothing was ever kept. */
        recall(key) {
            if (!OWNER_KEYS.includes(key)) return null;
            const e = read()[key];
            return e && typeof e.value === 'string'
                ? { value: e.value, at: typeof e.at === 'string' ? e.at : null }
                : null;
        },
        /** Keep the owner's value for a key; false when it was not written. */
        remember(key, value) {
            if (!file || !OWNER_KEYS.includes(key) || typeof value !== 'string')
                return false;
            try {
                const all = read();
                all[key] = { value, at: now().toISOString() };
                mkdirSync(path.dirname(file), { recursive: true });
                writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
                return true;
            } catch {
                return false;
            }
        },
    };
}

/**
 * What a field goes back to, given what it read before the leg set it.
 * The owner's own value is kept for later and returned as it is. An audit's
 * own folder is a leftover: the owner's last known value is put back in its
 * place when one was kept, and the app's default (empty) when none was.
 *
 *   { before, leftover, recalled }
 *   before:   what the restore sets
 *   leftover: the audit folder the field held, or null
 *   recalled: true when `before` came from the kept record
 */
export function ownerValue(state, key, read, isLeftover) {
    const value = String(read ?? '');
    if (!isLeftover(value)) {
        if (state) state.remember(key, value);
        return { before: value, leftover: null, recalled: false };
    }
    const kept = state ? state.recall(key) : null;
    // A kept value that is itself an audit folder was never the owner's.
    if (kept && !isLeftover(kept.value))
        return { before: kept.value, leftover: value, recalled: true };
    return { before: '', leftover: value, recalled: false };
}
