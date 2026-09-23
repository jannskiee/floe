/**
 * Byte-matches the Request link copy the app renders against the frozen,
 * owner-approved Checkpoint C desktop copy table (2026-09-18, D-091), which is
 * kept outside this repository.
 *
 * The table's path comes from FLOE_APPROVED_COPY and from nowhere else. Unset
 * (CI, a contributor's machine) the whole block is skipped under a title that
 * says how to run it; the build lane and QA set it on every run so the check
 * never skips silently there. The literal expectations in settings.test.ts and
 * requestCopy.test.ts keep pinning the same strings everywhere; this file is
 * what ties those literals to the approved source.
 *
 * How a row is compared: a plain row byte for byte; a row carrying a value is
 * rebuilt from the table's own mock values (D-3: Acme footage, D:\Footage\Floe
 * requests, 2:05 PM, 2:14 PM, 4 of 12, 38 GB), where a size prints through
 * fmtBytes with one decimal as the table's header says ("38.0 GB"); a
 * parenthetical in a row describes its drawn form (card body, drawn size, the
 * no-label fallback) and is read as such. Every row that is not cut is either
 * checked here or listed in NOT_RENDERED_HERE with the reason, and no cut row's
 * string can come out of requestCopy.ts.
 */
import {describe, expect, it} from 'vitest';
import {
    BETA_HEADING,
    REQUEST_LINKS_LABEL,
    REQUEST_LINKS_LINK_OPEN_LINE,
    REQUEST_LINKS_NO_SERVER_LINE,
    REQUEST_LINKS_ON_LINE,
} from './settings';
import * as c from './requestCopy';
import {fmtBytes} from './incoming';
import {fmtEta, fmtSpeed} from './progress';

// Node's fs and the process environment, reached at run time only. The
// frontend carries no Node types (the app never runs in Node), and declaring
// them for the whole src program would let app code type-check against APIs
// WebView2 does not have; so the two calls are typed here, locally.
type NodeFs = {existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string};
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as NodeFs;
const env = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env ?? {};
const path = env.FLOE_APPROVED_COPY ?? '';
const present = path !== '' && fs.existsSync(path);

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

const rows = present ? parseRows(fs.readFileSync(path, 'utf8')) : new Map<string, Row>();
const checked = new Set<string>();

/** The approved string of a row, which must exist and must not be cut. */
function approved(id: string): string {
    const r = rows.get(id);
    if (!r) throw new Error(`no approved row ${id}`);
    if (r.status.startsWith('CUT')) throw new Error(`row ${id} is cut (${r.status}); nothing may render it`);
    checked.add(id);
    return r.string;
}

/** The row with its trailing parenthetical note removed. */
function bare(id: string): string {
    return approved(id).replace(/ \([^()]*\)$/, '');
}

/** The row's trailing parenthetical note. */
function note(id: string): string {
    return /\(([^()]*)\)$/.exec(approved(id))?.[1] ?? '';
}

/** A size in the row's text, reprinted through fmtBytes (one decimal). */
function sized(s: string, gb: number): string {
    return s.replace(`${gb} GB`, fmtBytes(gb * GB));
}

// The mock values of D-3, as local times.
const END = new Date(2026, 8, 14, 14, 5).getTime();
const MISSED = new Date(2026, 8, 14, 14, 14).getTime();
const NOW = new Date(2026, 8, 14, 9, 30).getTime();
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const LABEL = 'Acme footage';
const SAVE = 'D:\\Footage\\Floe requests';
const SUB = 'Acme footage 2026-09-14 1405';

// Rows this file does not check, each with the reason. Anything else that is
// not cut must be checked above, so a row cannot be silently forgotten.
const NOT_RENDERED_HERE: Record<string, string> = {
    R5: 'placement A helper; neither helper renders since the owner cut R4 (2026-09-23)',
    R18: 'needs the save folder file system, which no binding reports yet (reported gap)',
    R19: 'needs the save folder file system, which no binding reports yet (reported gap)',
    V2: 'a value: the engine-cleaned file name, rendered as text',
    P1a: 'the one-sentence screen-reader form; A1 is the announcement that ships',
    DN11: 'the canvas draws DN1 without DN3 for this case (DO-02)',
    ST13: 'no source in Stage 1: a drop does not survive Floe closing',
    CP1: 'an existing app string (App.tsx, Code or link)',
    CL1: 'an existing app string (App.tsx, Close Floe?)',
    T1: 'the window title, set in Go (S1-DSK-05)',
    T2: 'the window title, set in Go (S1-DSK-05)',
    TO1: 'a toast, a Go constant (S1-DSK-05)',
    TO2: 'a toast, a Go constant (S1-DSK-05)',
    TO3: 'a toast, a Go constant (S1-DSK-05)',
};

describe.skipIf(!present)(present ? 'the approved desktop copy' : 'the approved desktop copy (skipped: set FLOE_APPROVED_COPY to the frozen copy table to run)', () => {
    it('parses the frozen table', () => {
        // One row per ID; a parse that finds a handful means the table format
        // moved and every check below would be vacuous.
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

    it('Receive row and Ready rows match byte for byte', () => {
        expect(`${c.CODE_TAB.toUpperCase()} / ${c.REQUEST_TAB.toUpperCase()}`).toBe(approved('R1'));
        expect(c.BETA_CHIP).toBe(bare('R2'));
        expect(c.REQUEST_TAB_NAME).toBe(approved('R3'));
        expect(c.LABEL_EYEBROW.toUpperCase()).toBe(approved('R6'));
        expect(c.LABEL_HINT).toBe(approved('R7'));
        expect(c.SAVE_TO_EYEBROW.toUpperCase()).toBe(approved('R8'));
        expect(c.SAVE_TO_PLACEHOLDER).toBe(approved('R9'));
        expect(c.BROWSE).toBe(approved('R10'));
        expect(c.LINK_ENDS_EYEBROW.toUpperCase()).toBe(approved('R11'));
        expect(c.LIFETIME_24H).toBe(approved('R12'));
        expect(c.LIFETIME_7D).toBe(approved('R13'));
        expect(c.MAKE_LINK).toBe(approved('R14'));
        expect(c.READY_IP_LINE).toBe(approved('R15'));
        expect(c.MAKING_LINK).toBe(approved('R16'));
        expect(c.READY_HIDE_IP_LINE).toBe(approved('R17'));
    });

    it('Error rows match byte for byte', () => {
        expect(c.errorLine('disabled')).toBe(approved('E1'));
        expect(c.errorLine('limited')).toBe(approved('E2'));
        expect(c.errorLine('unknown')).toBe(approved('E4'));
        expect(c.errorLine('no-relay')).toBe(approved('E5'));
        expect(c.errorLine('relay-unknown')).toBe(approved('E6'));
        expect(c.errorLine('already-open')).toBe(approved('E7'));
        expect(c.errorLine('disabled')).toBe(approved('X6'));
    });

    it('Waiting, reconnecting and ended rows match byte for byte', () => {
        // W1 describes a value: the label in uppercase, and the fallback.
        expect(approved('W1')).toContain(c.linkHeading(LABEL));
        expect(approved('W1')).toContain(`with no label: ${c.linkHeading('')}`);
        expect(c.COPY_LINK).toBe(approved('W2'));
        expect(c.COPIED).toBe(approved('W3'));
        expect(c.CLOSE_LINK).toBe(approved('W4'));
        expect(c.scopeLine(END, NOW)).toBe(approved('W5'));
        expect(`${c.SAVE_TO_EYEBROW.toUpperCase()}  ${SAVE}`).toBe(approved('W7'));
        expect(c.WAITING_LINE).toBe(approved('W8'));
        expect(c.WAITING_IP_LINE).toBe(approved('W9'));
        expect(c.missedLine(MISSED)).toBe(approved('W10'));
        expect(c.SETUP_FAILED_LINE).toBe(approved('W11'));
        expect(c.CONNECTING_LINE).toBe(approved('W12'));
        expect(c.SUGGEST_CLOSE_LINE).toBe(approved('W13'));
        expect(c.reconnectingLine(END)).toBe(approved('C1'));
        expect(`${c.RETRY_NOW} / ${c.CLOSE_LINK}`).toBe(bare('C2'));
        expect(c.endedLine('expired', END)).toBe(approved('X1'));
        expect(c.endedLine('closed', END)).toBe(approved('X2'));
        expect(c.MAKE_ANOTHER_LINK).toBe(approved('X3'));
        expect(c.endedLine('app-closed', END)).toBe(approved('X5'));
    });

    it('Prompt and Declined rows match byte for byte', () => {
        expect(approved('P1')).toContain(`for example ${c.promptHeading(LABEL)};`);
        expect(approved('P1')).toContain(`with no label: ${c.promptHeading('')}`);
        // P2 is drawn through fmtBytes: "(drawn 12 files, 38.0 GB through fmtBytes)".
        expect(note('P2')).toBe(`drawn ${c.promptSize(12, 38 * GB)} through fmtBytes`);
        expect(`${c.INTO} Floe requests\\${SUB}`).toBe(approved('P3'));
        const p = {freeBytes: 31 * GB, totalBytes: 38 * GB};
        expect(c.warningLine('low-space', p, SAVE)).toBe(sized(approved('P4'), 31));
        expect(c.warningLine('file-too-large-for-drive', p, SAVE)).toBe(approved('P5'));
        expect(c.warningLine('relay-over-cap', p, SAVE)).toBe(sized(bare('P6'), 38));
        expect(note('P6')).toBe(`drawn ${fmtBytes(38 * GB)}`);
        expect(c.answerWithin(NOW + 9 * 60000, NOW)).toBe(approved('P8'));
        expect(`${c.ACCEPT} / ${c.DECLINE}`).toBe(approved('P9'));
        expect(c.PROMPT_CAUTION).toBe(approved('P10'));
        expect(c.warningLine('laptop-power', p, SAVE)).toBe(approved('P11'));
        expect(c.DECLINED_LINE).toBe(approved('D1'));
        expect(c.DECLINED_QUESTION).toBe(approved('D2'));
        expect(`${c.KEEP_WAITING} / ${c.CLOSE_LINK}`).toBe(bare('D3'));
    });

    it('Receiving rows match byte for byte', () => {
        expect(c.receivingHeading(4, 12, LABEL)).toBe(bare('V1'));
        expect(note('V1')).toBe(`no label: ${c.receivingHeading(4, 12, '')}`);
        const v3 = [c.receivedOf(1.2 * GB, 2.5 * GB), fmtSpeed(38 * MB), c.timeLeft(fmtEta(34))];
        expect(v3.join('   ')).toBe(approved('V3'));
        expect(c.CANCEL_DROP).toBe(approved('V4'));
        expect(c.ETA_OVER_2H_LINE).toBe(approved('V5'));
        expect(c.etaLongLine(3 * 86400)).toBe(approved('V6'));
        expect(c.RELAY_DROP_TOOLTIP).toBe(approved('V8'));
    });

    it('Done rows match byte for byte', () => {
        expect(c.doneHeading(12, 38 * GB)).toBe(sized(bare('DN1'), 38));
        expect(note('DN1')).toBe(`drawn ${fmtBytes(38 * GB)}`);
        expect(c.DISMISS).toBe(approved('DN2'));
        expect(c.VERIFIED_LINE).toBe(approved('DN3'));
        expect(c.renamedLine(1)).toBe(approved('DN4'));
        expect(c.renamedLine(2)).toBe(approved('DN4p'));
        expect(c.NOT_SCANNED_LINE).toBe(approved('DN5'));
        expect(`${c.folderName(`${SAVE}\\${SUB}`)} [${c.SHOW_IN_FOLDER}]`).toBe(approved('DN6'));
        expect(c.MAKE_ANOTHER_LINK).toBe(approved('DN7'));
        expect(`${c.RENAMED_CONFIRM_TITLE} ${c.RENAMED_CONFIRM_QUESTION}`).toBe(approved('DN8'));
        expect(`${c.CANCEL} / ${c.SHOW_IN_FOLDER}`).toBe(approved('DN9'));
    });

    it('Stopped rows match byte for byte, card body and History form', () => {
        expect(c.STOPPED_HEADING).toBe(approved('ST0'));
        const stops: Array<[string, string]> = [
            ['ST1', 'disk-full'], ['ST3', 'hash-mismatch'], ['ST4', 'path-too-long'], ['ST5', 'over-approved'],
            ['ST6', 'relay-cap'], ['ST7', 'file-too-large-for-folder'], ['ST8', 'write-failed'], ['ST9', 'save-blocked'],
            ['ST10', 'stopped'], ['ST11', 'peer-abort'], ['ST12', 'time-limit'], ['ST14', 'unknown'],
        ];
        const st16 = approved('ST16');
        for (const [id, code] of stops) {
            const full = bare(id);
            const n = note(id);
            let card: string;
            if (n === '') card = full; // ST10: one sentence for both
            else if (n === 'card body without the prefix, plus ST16') {
                const rest = full.replace(/^Drop stopped: /, '');
                card = `${rest[0].toUpperCase()}${rest.slice(1)} ${st16}`;
            } else if (n.startsWith('card body: ') && n.endsWith(' plus ST16')) {
                card = `${n.slice('card body: '.length, -' plus ST16'.length)} ${st16}`;
            } else if (n.startsWith('card body: ')) {
                card = n.slice('card body: '.length);
            } else throw new Error(`${id}: unreadable note ${n}`);
            const saved = code === 'relay-cap' ? 0 : 4;
            expect(c.stoppedCard(code, saved, 12), id).toBe(card);
            expect(c.stoppedFull(code, saved, 12), id).toBe(full);
        }
        expect(c.STOPPED_FOLLOW_UP).toBe(approved('ST15'));
        expect(c.savedOf(4, 12)).toBe(st16);
    });

    it('CODE paste, dialog, header, notice and announcement rows match byte for byte', () => {
        expect(c.CODE_PASTE_LINE).toBe(approved('CP2'));
        expect(c.OPEN_IN_BROWSER).toBe(approved('CP3'));
        expect(c.CLOSE_LINK_OPEN_LINE).toBe(approved('CL2'));
        expect(`${c.KEEP_FLOE_OPEN} / ${c.CLOSE_FLOE}`).toBe(approved('CL3'));
        expect(c.CLOSE_DROP_RECEIVING_LINE).toBe(approved('CL4'));
        expect(c.CLOSE_LINK_ALSO_LINE).toBe(approved('CL5'));
        expect(c.START_OVER_LINK_LINE).toBe(approved('SO1'));
        expect(c.MARKER_TEXT).toBe(approved('H1'));
        expect(c.MARKER_NAME).toBe(approved('H2'));
        expect(c.RELAY_DROP_DIRECT_SEND_TOOLTIP).toBe(approved('H3'));
        expect(c.NOTICE_TEXT).toBe(approved('N1'));
        expect(c.NOTICE_REVIEW).toBe(approved('N2'));
        expect(c.ANNOUNCE_REQUEST).toBe(approved('A1'));
        expect(c.ANNOUNCE_GUARD_LIFTED).toBe(approved('A2'));
    });

    it('no approved row that is not cut is left unchecked', () => {
        const missing = [...rows.values()]
            .filter((r) => !r.status.startsWith('CUT') && !checked.has(r.id) && !(r.id in NOT_RENDERED_HERE))
            .map((r) => r.id);
        expect(missing).toEqual([]);
    });

    it('no cut row can come out of requestCopy.ts', () => {
        const cut = [...rows.values()].filter((r) => r.status.startsWith('CUT'));
        expect(cut.map((r) => r.id).sort()).toEqual(['C3', 'DN10', 'E3', 'E8', 'P7', 'Q1', 'R4', 'ST2', 'V7', 'W6', 'X4']);
        const out: string[] = [];
        for (const v of Object.values(c) as unknown[]) if (typeof v === 'string') out.push(v);
        for (const code of ['denied', 'too-slow', 'network', 'server-restart', 'battery-standby', 'pending-rename', 'web-address']) {
            out.push(c.errorLine(code), c.endedLine(code, END), c.stoppedCard(code, 4, 12), c.stoppedFull(code, 4, 12),
                c.warningLine(code, {freeBytes: 1, totalBytes: 1}, SAVE));
        }
        for (const r of cut) {
            const s = r.string.replace(/ \([^()]*\)$/, '');
            for (const o of out) expect(o.includes(s), `${r.id} (${r.status}) renders`).toBe(false);
        }
    });
});
