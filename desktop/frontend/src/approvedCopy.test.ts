/**
 * Byte-matches the Request link copy the app renders against the frozen,
 * owner-approved desktop copy table (Checkpoint C, 2026-09-18, D-091):
 * work/16-design/cp-3/approved-copy-desktop.md in the build's plan folder.
 *
 * That file lives outside the repository, so this reads it from
 * FLOE_APPROVED_COPY, else from the plan folder on the build machine, and
 * skips (saying so) where neither exists, such as CI. The literal expectations
 * in settings.test.ts and requestCopy.test.ts keep pinning the same strings
 * everywhere; this file is what ties those literals to the approved source.
 */
import {existsSync, readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
    BETA_HEADING,
    REQUEST_LINKS_LABEL,
    REQUEST_LINKS_LINK_OPEN_LINE,
    REQUEST_LINKS_NO_SERVER_LINE,
    REQUEST_LINKS_ON_LINE,
} from './settings';
import {CODE_PASTE_LINE, OPEN_IN_BROWSER} from './requestCopy';

const DEFAULT_PATH = 'C:/Users/Admin/.claude/plans/floe-portal/work/16-design/cp-3/approved-copy-desktop.md';
const path = process.env.FLOE_APPROVED_COPY || DEFAULT_PATH;
const present = existsSync(path);

interface Row {
    id: string;
    state: string;
    string: string;
    status: string;
}

/** The copy rows: every table line whose first cell is a copy ID. Cells are
 *  split on the table's " | " separators; no approved string contains a pipe. */
function parseRows(md: string): Map<string, Row> {
    const rows = new Map<string, Row>();
    for (const line of md.split(/\r?\n/)) {
        const m = /^\| ([A-Z]+[0-9]+[a-z]?) \| (.*) \|$/.exec(line);
        if (!m) continue;
        const cells = m[2].split(' | ');
        if (cells.length !== 5) throw new Error(`unexpected row shape: ${line}`);
        rows.set(m[1], {id: m[1], state: cells[1], string: cells[2], status: cells[3]});
    }
    return rows;
}

const rows = present ? parseRows(readFileSync(path, 'utf8')) : new Map<string, Row>();

/** The approved string of a row, which must exist and must not be cut. */
function approved(id: string): string {
    const r = rows.get(id);
    if (!r) throw new Error(`no approved row ${id}`);
    if (r.status.startsWith('CUT')) throw new Error(`row ${id} is cut (${r.status}); nothing may render it`);
    return r.string;
}

describe.skipIf(!present)(`the approved desktop copy (${present ? path : 'not on this machine, skipped'})`, () => {
    it('parses the frozen table', () => {
        // 186 lines, one row per ID; a parse that finds a handful means the
        // table format moved and every check below would be vacuous.
        expect(rows.size).toBeGreaterThan(120);
        expect(approved('S1')).toBe('Beta');
    });

    it('Settings rows S1 to S5 match byte for byte', () => {
        expect(BETA_HEADING).toBe(approved('S1'));
        expect(REQUEST_LINKS_LABEL).toBe(approved('S2'));
        expect(REQUEST_LINKS_ON_LINE).toBe(approved('S3'));
        expect(REQUEST_LINKS_NO_SERVER_LINE).toBe(approved('S4'));
        expect(REQUEST_LINKS_LINK_OPEN_LINE).toBe(approved('S5'));
    });

    it('CODE paste rows CP2 and CP3 match byte for byte', () => {
        expect(CODE_PASTE_LINE).toBe(approved('CP2'));
        expect(OPEN_IN_BROWSER).toBe(approved('CP3'));
    });
});
