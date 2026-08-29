// Report rendering: audit.md in the layout of the report design (headline,
// run header, Cells, Versions, Infra, Safety, Failures and flakes, Legend)
// and run.json with schemaVersion 1. Room links and codes are redacted to
// short hashes so a report can be pasted anywhere: the values are the
// ones each attempt recorded (attempts[].room), replaced wherever they
// appear in run.json or audit.md, plus a `#room=` link regex as the
// safety net. No generic three-word regex: it used to eat harness tokens
// (no-data-after-connect, peer-left-early) and path segments. exitCodeFor()
// is the single place the exit precedence lives: 2, 4, 3, 1, 5, 6, 0.
import { createHash } from 'node:crypto';

import { TRIAGE_KEYS } from './cell.mjs';
import { formatBytes } from './fixtures.mjs';
import { gatingDrift } from './versions.mjs';

export const SCHEMA_VERSION = 1;
export const EXIT = Object.freeze({
    clean: 0,
    fail: 1,
    usage: 2,
    precondition: 3,
    safety: 4,
    partial: 5,
    drift: 6,
    interrupted: 130,
});
export const EXIT_LEGEND = Object.freeze({
    0: 'clean: every counted cell PASS, every gating version row CURRENT or PARITY',
    1: 'any cell FAIL (or FLAKY under --strict)',
    2: 'usage',
    3: 'precondition or mid-run infra abort',
    4: 'safety invariant tripped',
    5: 'partial: SKIP, FLAKY or harness ERROR, no FAIL',
    6: 'version drift only',
    130: 'interrupted',
});

export function redact(value) {
    if (value === null || value === undefined || value === '') return null;
    return (
        '#' +
        createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
    );
}

const ROOM_LINK_RE = /https?:\/\/\S*#room=[^\s'")\]]+/g;

/**
 * redactRooms(text, rooms) -> text with every exact room value in `rooms`
 * (links and three-word codes, as the attempts recorded them) replaced by
 * `<room #hash>` or `<code #hash>`, then any remaining `#room=` link by
 * the regex. Longest values first, so a link is never split by a code
 * that happens to be a substring of it.
 */
export function redactRooms(text, rooms = []) {
    let s = String(text || '');
    if (!s) return s;
    const values = [...new Set((rooms || []).filter(Boolean).map(String))]
        .filter((v) => v.length > 0)
        .sort((a, b) => b.length - a.length);
    for (const v of values) {
        if (!s.includes(v)) continue;
        const tag = /#room=/.test(v) ? 'room' : 'code';
        s = s.split(v).join(`<${tag} ${redact(v)}>`);
    }
    return s.replace(ROOM_LINK_RE, (m) => `<room ${redact(m)}>`);
}

/** Every room link and code the run's attempts recorded, longest first. */
export function collectRooms(run) {
    const out = new Set();
    for (const c of run?.cells || [])
        for (const a of c?.attempts || []) {
            if (a?.room?.link) out.add(String(a.room.link));
            if (a?.room?.code) out.add(String(a.room.code));
        }
    return [...out].sort((a, b) => b.length - a.length);
}

const isPlain = (v) => {
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
};

/**
 * A copy of `value` with redactRooms applied to every string inside it
 * (arrays and plain objects are walked; anything else is kept as is).
 */
export function redactDeep(value, rooms) {
    if (typeof value === 'string') return redactRooms(value, rooms);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, rooms));
    if (value && typeof value === 'object' && isPlain(value)) {
        const out = {};
        for (const [k, v] of Object.entries(value))
            out[k] = redactDeep(v, rooms);
        return out;
    }
    return value;
}

/**
 * exitCodeFor({ usage, safety, precondition, interrupted, cells, strict,
 *   versions }) -> exit code with precedence 2, 4, 3, 1, 5, 6, 0.
 * Cells carry verdict and countsForExit; NA and filtered SKIPs never count.
 */
export function exitCodeFor({
    usage = false,
    safety = false,
    precondition = false,
    interrupted = false,
    cells = [],
    strict = false,
    versions = [],
} = {}) {
    if (usage) return EXIT.usage;
    if (safety) return EXIT.safety;
    if (precondition) return EXIT.precondition;
    if (interrupted) return EXIT.interrupted;
    const counted = cells.filter(
        (c) => c.countsForExit !== false && c.verdict !== 'NA'
    );
    const has = (v) => counted.some((c) => c.verdict === v);
    if (has('FAIL') || (strict && has('FLAKY'))) return EXIT.fail;
    if (has('SKIP') || has('FLAKY') || has('ERROR')) return EXIT.partial;
    if (gatingDrift(versions).length) return EXIT.drift;
    return EXIT.clean;
}

export function totalsOf(cells) {
    const t = {
        pass: 0,
        fail: 0,
        flaky: 0,
        skip: 0,
        na: 0,
        error: 0,
        // SKIP rows the operator dropped with --cells; part of `skip` and
        // of `total`, never of an exit code or a headline count.
        filtered: 0,
        total: cells.length,
    };
    for (const c of cells) {
        const k = String(c.verdict || '').toLowerCase();
        if (k in t) t[k] += 1;
        if (c.verdict === 'SKIP' && c.reason === 'filtered') t.filtered += 1;
    }
    return t;
}

export function headline(run) {
    const t = totalsOf(run.cells || []);
    const stale = gatingDrift(run.versions || []).map((r) => r.surface);
    if (run.aborted) return `aborted: ${run.aborted.reason}`;
    const executable = t.total - t.na - t.filtered;
    const skipped = t.skip - t.filtered;
    const staleText = stale.length
        ? `surfaces stale: ${stale.join(', ')}`
        : 'all surfaces on latest';
    const filteredText = t.filtered
        ? `; ${t.filtered} filtered by --cells`
        : '';
    // FLAKY and ERROR are their own counts: a FLAKY is not a SKIP (it ran
    // and passed on the retry) and an ERROR is not a FAIL (the harness,
    // not the product, gave up).
    const rest = [];
    if (skipped) rest.push(`${skipped} SKIP`);
    if (t.flaky) rest.push(`${t.flaky} FLAKY`);
    if (t.fail || t.error) {
        const ids = (run.cells || [])
            .filter((c) => c.verdict === 'FAIL' || c.verdict === 'ERROR')
            .map((c) => c.id);
        const counts = [
            t.fail ? `${t.fail} FAIL` : null,
            t.error ? `${t.error} ERROR` : null,
        ]
            .filter(Boolean)
            .join(', ');
        return `${counts} (${ids.join(', ')}); ${rest.length ? rest.join(', ') : '0 SKIP'}; ${staleText}${filteredText}`;
    }
    if (rest.length)
        return `${t.pass}/${executable} PASS, ${rest.join(', ')}; ${staleText}${filteredText}`;
    return `${t.pass}/${executable} PASS, ${staleText}${filteredText}`;
}

/**
 * Relay egress the run caused: every attempt's bytesMoved on a REL cell,
 * whatever the verdict (a FLAKY moved bytes twice, a FAIL that got bytes
 * to the receiver moved them, a refusal PASS moved none).
 */
export function relayBytesOf(cells) {
    let total = 0;
    for (const c of cells || []) {
        if (c?.path !== 'REL') continue;
        for (const a of c.attempts || []) total += Number(a?.bytesMoved) || 0;
    }
    return total;
}

function pad(s, w) {
    const v = String(s ?? '');
    return v.length >= w ? v : v + ' '.repeat(w - v.length);
}

/** A cell's text on one table row: newlines collapsed, pipes escaped. */
const cellText = (c) =>
    String(c ?? '')
        .replace(/\s*\r?\n\s*/g, ' ')
        .replace(/\|/g, '\\|');

export function table(headers, rows) {
    const hs = headers.map(cellText);
    const rs = rows.map((r) => hs.map((_, i) => cellText(r[i])));
    const widths = hs.map((h, i) =>
        Math.max(h.length, ...rs.map((r) => r[i].length))
    );
    const line = (cells) =>
        `| ${cells.map((c, i) => pad(c, widths[i])).join(' | ')} |`;
    return [
        line(hs),
        `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
        ...rs.map(line),
    ].join('\n');
}

const cellSize = (c) =>
    c.verdict === 'NA' || c.verdict === 'SKIP'
        ? '-'
        : formatBytes(c.fixture?.totalBytes ?? 0);

export function cellRows(cells) {
    return cells.map((c) => [
        c.id,
        c.verdict,
        c.verdict === 'NA' || c.verdict === 'SKIP'
            ? '-'
            : c.route?.label || '-',
        cellSize(c),
        c.verdict === 'NA' || c.verdict === 'SKIP'
            ? '-'
            : String(Math.round(c.durationS || 0)),
        c.verdict === 'NA' || c.verdict === 'SKIP' ? '-' : c.rcvBuild || '-',
        noteOf(c),
    ]);
}

function noteOf(c) {
    if (c.verdict === 'NA' || c.verdict === 'SKIP')
        return c.note || c.reason || '';
    if (c.verdict === 'PASS') {
        const mb = c.metrics?.throughputMBps;
        const extra = c.note ? c.note : '';
        return c.variant === 'thr500' && mb !== null && mb !== undefined
            ? `${mb} MB/s${mb < 10 ? ' (WARN below 10)' : ''}`
            : extra;
    }
    const key = c.reason || '';
    const text = c.note ? redactRooms(c.note) : '';
    return text ? `${key}: ${text}`.slice(0, 80) : key;
}

export function versionRows(rows) {
    return (rows || []).map((r) => [
        r.surface,
        r.installed ?? 'not installed',
        r.latest ?? '-',
        r.oracle ?? '-',
        r.status,
        r.suggest ?? '',
    ]);
}

export function safetyRows(s) {
    const ok = (v) => (v === null || v === undefined ? 'n/a' : v);
    const killed =
        s.killedPids && s.killedPids.length
            ? `own PIDs only (${s.killedPids.join(', ')})`
            : 'own PIDs only (none)';
    return [
        [
            'stats report attempts (browser, aborted)',
            String(s.statsReportAttempts ?? 0),
        ],
        ['floe:bytes-reported events', String(s.bytesReportedEvents ?? 0)],
        [
            'CLI receivers --no-report + FLOE_NO_STATS=1',
            `${s.cliReceiversOptedOut?.ok ?? 0}/${s.cliReceiversOptedOut?.total ?? 0}`,
        ],
        [
            'desktop receivers reportStats:false, migrated',
            `${s.desktopReceiversOptedOut?.ok ?? 0}/${s.desktopReceiversOptedOut?.total ?? 0}; desktop.json restored byte-identical: ${s.desktopReceiversOptedOut?.configRestoredIdentical === false ? 'NO' : 'yes'}`,
        ],
        [
            'local /api/stats before/after (head)',
            s.localStatsDeltaZero === null ||
            s.localStatsDeltaZero === undefined
                ? 'n/a'
                : s.localStatsDeltaZero
                  ? `0/0 for ${s.localReceives ?? 0} receives`
                  : 'NON-ZERO',
        ],
        [
            'TURN credential bodies printed or stored',
            s.turnBodyPrinted ? 'YES' : 'never',
        ],
        ['server/.env read', s.serverEnvRead ? 'YES' : 'never'],
        [
            'captures',
            `${s.captures?.count ?? 0}, ${s.captures?.allCropped === false ? 'NOT all cropped' : 'all cropped to window'}`,
        ],
        ['forced foreground', `${s.forcedFocus ?? 0} times`],
        ['processes killed', killed],
        [
            'working tree',
            s.workingTreeUnchanged === false
                ? 'CHANGED'
                : ok(
                      s.workingTreeUnchanged === undefined
                          ? 'unchanged'
                          : 'unchanged'
                  ),
        ],
        [
            'desktop floe:saveDir restored',
            s.saveDirRestored === false
                ? 'NO'
                : s.saveDirRestored === null || s.saveDirRestored === undefined
                  ? 'n/a'
                  : 'yes',
        ],
        [
            'desktop history rows added',
            s.historyRowsAdded === null || s.historyRowsAdded === undefined
                ? 'not counted (no desktop receiver, or the adapter reports none)'
                : String(s.historyRowsAdded),
        ],
    ];
}

export function failureSections(cells) {
    const out = [];
    for (const c of cells) {
        if (!['FAIL', 'FLAKY', 'ERROR'].includes(c.verdict)) continue;
        const last = c.attempts[c.attempts.length - 1] || {};
        const first = c.attempts[0] || {};
        const lines = [`### ${c.id} ${c.verdict} ${c.reason || ''}`.trim()];
        lines.push(
            `Phase: ${(c.verdict === 'FLAKY' ? first : last).failedPhase || 'n/a'}. Receiver: ${c.rcvBuild || c.receiver?.surface}. Sender: ${c.sender?.surface} ${c.sender?.version || ''}`.trim() +
                '.'
        );
        const sig = (c.verdict === 'FLAKY' ? first : last).signature;
        if (sig && sig.text) lines.push(`Signature: ${redactRooms(sig.text)}`);
        else if (c.note) lines.push(`Signature: ${redactRooms(c.note)}`);
        if (c.verdict === 'FLAKY')
            lines.push(
                `Attempt 2 passed after ${first.signature?.key || 'a retryable failure'}; FLAKY never counts as PASS.`
            );
        const notes = ((c.verdict === 'FLAKY' ? first : last).notes || [])
            .map((n) => String(n || '').trim())
            .filter(Boolean);
        if (notes.length)
            lines.push(`Notes: ${notes.map((n) => redactRooms(n)).join('; ')}`);
        const ev = (c.verdict === 'FLAKY' ? first : last).evidence || {};
        const paths = [
            ev.senderTranscript,
            ev.receiverTranscript,
            ...(ev.captures || []),
        ].filter(Boolean);
        lines.push(
            `Evidence: ${paths.length ? paths.join(', ') : ev.dir || 'n/a'}`
        );
        // Always a Triage line, and the disclaimer is decided by whether
        // the table documents the key, never by whether the classifier
        // happened to set a heading.
        const triageKey =
            c.triage ||
            (c.verdict === 'FLAKY' ? first : last).signature?.key ||
            c.reason;
        if (triageKey)
            lines.push(
                `Triage: references/triage.md "${triageKey}"${c.reason === 'early-race' ? '; the receiver build decides' : ''}${TRIAGE_KEYS.has(triageKey) ? '' : ' (no row: read the phase, both transcripts and the captures)'}.`
            );
        out.push(lines.join('\n'));
    }
    return out;
}

export const LEGEND = `Cell id: {S shipped | H head}-{DIR direct | REL relay}-{snd}2{rcv}; W web, C CLI, D desktop, L CLI in WSL2.
Route: observed path and the sides that observed it; \`[W local]\` means the browser's own candidate was relay (forced side).
Verdicts: PASS all oracles met first try; FLAKY passed on the retry (never PASS); FAIL any oracle unmet;
ERROR harness fault; SKIP precondition unmet on this run (reason in Note); NA impossible with the shipped product.`;

/** Render audit.md from the run record. */
export function renderMarkdown(rawRun) {
    // Every string the report prints goes through the value-based
    // redaction first: notes, signatures, completion texts, the aborted
    // reason and the headline built from it included.
    const run = redactDeep(rawRun || {}, collectRooms(rawRun));
    const cells = run.cells || [];
    const t = totalsOf(cells);
    const h = run.host || {};
    const c = run.commits || {};
    const b = run.binaries || {};
    const peak = run.pacing?.peakPer60s || {};
    const caps = run.pacing?.caps || {};
    const sha8 = (s) => (s ? String(s).slice(0, 8) : '?');
    const desktopText = b.desktop
        ? b.desktop.kind === 'store'
            ? `store ${b.desktop.identityVersion || b.desktop.version || '?'}`
            : `${b.desktop.kind || 'desktop'} ${b.desktop.version || '?'}${b.desktop.isPackaged === false ? ' (isPackaged=false)' : ''}`
        : 'none';
    const lines = [];
    lines.push(
        `# Floe live-transfer audit: ${run.headline || headline(run)}`,
        ''
    );
    lines.push(
        `Run ${run.runId} | profile ${run.profile} | subset ${run.subset} | ${run.startedAt} | ${Math.round((run.durationS || 0) / 60)} min`
    );
    lines.push(
        `Host ${h.hostname || '?'}, ${h.os || '?'}, node ${h.node || '?'}, go ${h.go || 'n/a'}`
    );
    lines.push(
        `Commits: local HEAD ${sha8(c.local)} (${c.branch || '?'}), origin main ${sha8(c.main)}, web ${c.web ? sha8(c.web) : 'unknown'}, server ${c.server ? sha8(c.server) : 'unknown'}`
    );
    lines.push(
        `Binaries under test: CLI ${b.cli?.tag || b.cli?.version || '?'} (${sha8(b.cli?.sha256)}), desktop ${desktopText}, web ${b.web?.origin || '?'}`
    );
    // A relaxed ledger (head profile, local stack) never touched the
    // production limiters, so the header must not say it did.
    const limiter =
        (run.pacing?.relaxed ?? run.flags?.relaxed)
            ? 'Limiter (relaxed, local stack)'
            : 'Production limiter';
    lines.push(
        `Relay bytes moved: ${formatBytes(run.relayBytes || 0)} | ${limiter} peak per 60 s: TURN ${peak.turn ?? 0}/${caps.turn ?? 20}, connections ${peak.conn ?? 0}/${caps.conn ?? 30}, code ${peak.code ?? 0}/${caps.code ?? 60}`
    );
    lines.push('', '## Cells', '');
    lines.push(
        table(
            ['Cell', 'Verdict', 'Route', 'Size', 't(s)', 'Rcv build', 'Note'],
            cellRows(cells)
        )
    );
    lines.push(
        '',
        `Totals: ${t.pass} PASS, ${t.fail} FAIL, ${t.flaky} FLAKY, ${t.skip} SKIP, ${t.na} NA${t.error ? `, ${t.error} ERROR` : ''} of ${t.total}${t.filtered ? ` (${t.filtered} of the SKIP rows filtered by --cells, uncounted)` : ''}`
    );
    lines.push('', '## Versions', '');
    lines.push(
        table(
            [
                'Surface',
                'Installed / deployed',
                'Latest',
                'Oracle',
                'Status',
                'Suggest',
            ],
            versionRows(run.versions)
        )
    );
    lines.push('', '## Infra', '');
    lines.push(
        table(
            ['Check', 'Result'],
            (run.infra || []).map((i) => [
                i.check,
                `${i.ok === false ? 'FAIL: ' : ''}${i.detail}`,
            ])
        )
    );
    lines.push('', '## Safety', '');
    lines.push(table(['Attestation', 'Value'], safetyRows(run.safety || {})));
    lines.push('', '## Failures and flakes', '');
    const fails = failureSections(cells);
    lines.push(fails.length ? fails.join('\n\n') : 'None.');
    lines.push('', '## Legend', '');
    lines.push(LEGEND);
    lines.push(
        `Exit code ${run.exitCode}: ${EXIT_LEGEND[run.exitCode] || 'see header'}.`
    );
    lines.push(
        `Report and JSON: ${run.artifacts?.reportMd || 'audit.md'}, ${run.artifacts?.runJson || 'run.json'}`
    );
    return lines.join('\n') + '\n';
}

/** run.json, schemaVersion 1. Every string field is redacted by value. */
export function buildRunJson(run) {
    return redactDeep(buildRunJsonRaw(run), collectRooms(run));
}

function buildRunJsonRaw(run) {
    const cells = (run.cells || []).map((c) => ({
        id: c.id,
        profile: c.profile,
        path: c.path,
        variant: c.variant ?? null,
        sender: c.sender,
        receiver: c.receiver,
        fixture: c.fixture,
        verdict: c.verdict,
        reason: c.reason ?? null,
        triage: c.triage ?? null,
        note: c.note ?? null,
        countsForExit: c.countsForExit !== false,
        attempts: (c.attempts || []).map((a) => ({
            n: a.n,
            designed: Boolean(a.designed),
            startedAt: a.startedAt,
            endedAt: a.endedAt,
            phases: a.phases,
            outcome: a.outcome,
            signature: a.signature?.text ?? null,
            signatureKey: a.signatureKey ?? null,
            failedPhase: a.failedPhase ?? null,
            room: { link: redact(a.room?.link), code: redact(a.room?.code) },
            senderExit: a.senderExit ?? null,
            receiverExit: a.receiverExit ?? null,
            bytesMoved: Number(a.bytesMoved) || 0,
            kill: a.kill ?? null,
            evidence: a.evidence,
            notes: a.notes,
        })),
        route: c.route,
        integrity: c.integrity,
        completion: c.completion,
        stats: c.stats,
        metrics: c.metrics,
        durationS: c.durationS,
    }));
    return {
        schemaVersion: SCHEMA_VERSION,
        run: {
            id: run.runId,
            profile: run.profile,
            subset: run.subset,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            durationS: run.durationS,
            root: run.root,
            outDir: run.outDir,
            scratch: run.scratch ?? null,
            host: run.host,
            commits: run.commits,
            binaries: run.binaries,
            flags: run.flags,
            relayBytes: run.relayBytes ?? 0,
            exitCode: run.exitCode,
            headline: run.headline,
            aborted: run.aborted ?? null,
            interrupted: Boolean(run.interrupted),
        },
        totals: totalsOf(run.cells || []),
        cells,
        versions: run.versions || [],
        infra: run.infra || [],
        safety: run.safety || {},
        pacing: run.pacing || null,
        probe: run.probe ?? null,
        artifacts: run.artifacts || {},
    };
}

export function newSafety() {
    return {
        statsReportAttempts: 0,
        bytesReportedEvents: 0,
        cliReceiversOptedOut: { ok: 0, total: 0 },
        desktopReceiversOptedOut: {
            ok: 0,
            total: 0,
            configRestoredIdentical: true,
        },
        localStatsDeltaZero: null,
        localReceives: 0,
        turnBodyPrinted: false,
        serverEnvRead: false,
        captures: { count: 0, allCropped: true },
        forcedFocus: 0,
        killedPids: [],
        workingTreeUnchanged: null,
        saveDirRestored: null,
        historyRowsAdded: null,
        refusals: [],
    };
}
