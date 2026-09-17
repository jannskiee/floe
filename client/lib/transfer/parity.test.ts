/**
 * Decoder parity with the Go engine, and seeded property loops (DV-FUZZ B0-b).
 *
 * The browser half of two things:
 *
 * - A parity table: literal frames, each with the decision the Go engine makes
 *   and the decision this browser makes. Twin: cli/engine/transfer/parity_test.go
 *   carries the same table byte for byte, and each suite fails when the other
 *   file's copy drifts. A row whose two decisions differ must name a finding;
 *   those are recorded, not fixed, in work/14-test-evidence/DV-FUZZ/B0-b.
 * - Seeded xorshift32 loops: 1000 generated frames per decoder, never a throw.
 *   The seed is in each test name, so a failure reproduces exactly.
 *
 * Decoders covered: refusalCodeOf, classifyControl, normalizeSha256 (twin of
 * parseEnd) and verifiedCountOf (twin of parseReceived) in protocol.ts, and the
 * metadata guard of createReceiver (receiver.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    CONTROL_MSG_MAX,
    REFUSAL_CODES,
    classifyControl,
    normalizeSha256,
    refusalCodeOf,
    verifiedCountOf,
    type Incompatible,
    type Received,
} from './protocol';
import { createReceiver } from './receiver';

// PARITY-TABLE-BEGIN (twin: cli/engine/transfer/parity_test.go, parityTable)
const PARITY_TABLE = String.raw`
{"decoder":"refusalCodeOf","name":"write-failed","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"write-failed\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"hash-mismatch","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"hash-mismatch\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"stage-1-code","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"too-slow\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"upper-case","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"WRITE-FAILED\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"empty","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"number","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":7}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"null","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":null}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"array","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":[\"write-failed\"]}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"object","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":{\"code\":\"write-failed\"}}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"proto","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"__proto__\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"constructor","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"constructor\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"absent","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"saved-string","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"write-failed\",\"saved\":\"3\"}","go":"reject","ts":"accept","finding":"FND-4"}
{"decoder":"refusalCodeOf","name":"saved-1e300","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"write-failed\",\"saved\":1e300}","go":"reject","ts":"accept","finding":"FND-4"}
{"decoder":"classifyControl","name":"metadata","frame":"{\"type\":\"metadata\"}","go":"metadata","ts":"metadata"}
{"decoder":"classifyControl","name":"end","frame":"{\"type\":\"end\"}","go":"end","ts":"end"}
{"decoder":"classifyControl","name":"ack","frame":"{\"type\":\"ack\"}","go":"ack","ts":"ack"}
{"decoder":"classifyControl","name":"received","frame":"{\"type\":\"received\"}","go":"received","ts":"received"}
{"decoder":"classifyControl","name":"incompatible","frame":"{\"type\":\"incompatible\"}","go":"incompatible","ts":"incompatible"}
{"decoder":"classifyControl","name":"unknown-type","frame":"{\"type\":\"hello\"}","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"type-number","frame":"{\"type\":7}","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"leading-space","frame":" {\"type\":\"end\"}","go":"end","ts":"none","finding":"FND-1"}
{"decoder":"classifyControl","name":"leading-newline","frame":"\n{\"type\":\"end\"}","go":"end","ts":"none","finding":"FND-1"}
{"decoder":"classifyControl","name":"number-overflow","frame":"{\"type\":\"end\",\"x\":1e999}","go":"none","ts":"end","finding":"FND-2"}
{"decoder":"classifyControl","name":"array","frame":"[{\"type\":\"end\"}]","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"json-null","frame":"null","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"trailing-garbage","frame":"{\"type\":\"end\"}x","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"duplicate-type","frame":"{\"type\":\"end\",\"type\":\"hello\"}","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"cap-exact","frame":"{\"type\":\"end\",\"pad\":\"\"}","padTo":1000,"padChar":"x","go":"end","ts":"end"}
{"decoder":"classifyControl","name":"cap-plus-1","frame":"{\"type\":\"end\",\"pad\":\"\"}","padTo":1001,"padChar":"x","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"cap-plus-1-two-byte","frame":"{\"type\":\"end\",\"pad\":\"\"}","padTo":1001,"padChar":"\u00e9","go":"none","ts":"none"}
{"decoder":"metadataGuard","name":"valid","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"F1-fileSize-2pow53","frame":"{\"type\":\"metadata\",\"id\":\"f-1\",\"fileName\":\"big.bin\",\"fileSize\":9007199254740992,\"index\":1,\"total\":1,\"totalBytes\":9007199254740992,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"F5-fileSize-2pow53-minus-1","frame":"{\"type\":\"metadata\",\"id\":\"f-5\",\"fileName\":\"big.bin\",\"fileSize\":9007199254740991,\"index\":1,\"total\":1,\"totalBytes\":9007199254740991,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"fileSize-minus-1","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":-1,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"fileSize-fraction","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":1.5,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"fileSize-string","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":\"4\",\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"fileSize-1e300","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":1e300,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"index-0","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":0,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"total-0","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":0,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"totalBytes-below-fileSize","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":2,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"totalBytes-absent","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"pv-disjoint","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":2,\"pvMin\":2}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"pv-absent-legacy","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"pv-string","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":\"1\",\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"name-number","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":7,\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"accept","finding":"FND-3"}
{"decoder":"metadataGuard","name":"F4a-traversal-dotdot","frame":"{\"type\":\"metadata\",\"id\":\"f-4a\",\"fileName\":\"../../escape.txt\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"F3-bidi-override-name","frame":"{\"type\":\"metadata\",\"id\":\"f-3\",\"fileName\":\"photo\u202egnp.exe\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"leading-space","frame":" {\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"ignore","finding":"FND-1"}
{"decoder":"metadataGuard","name":"over-cap","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1,\"pad\":\"\"}","padTo":1001,"padChar":"x","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"valid","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"accept","ts":"accept"}
{"decoder":"endSha256","name":"absent","frame":"{\"type\":\"end\"}","go":"absent","ts":"absent"}
{"decoder":"endSha256","name":"uppercase","frame":"{\"type\":\"end\",\"sha256\":\"0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"63-chars","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"65-chars","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"non-hex","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"empty","frame":"{\"type\":\"end\",\"sha256\":\"\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"padded","frame":"{\"type\":\"end\",\"sha256\":\" 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"number","frame":"{\"type\":\"end\",\"sha256\":3}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"null","frame":"{\"type\":\"end\",\"sha256\":null}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"true","frame":"{\"type\":\"end\",\"sha256\":true}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"object","frame":"{\"type\":\"end\",\"sha256\":{}}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"array","frame":"{\"type\":\"end\",\"sha256\":[\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"]}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"escaped-valid","frame":"{\"type\":\"end\",\"sha256\":\"\\u0030123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"accept","ts":"accept"}
{"decoder":"endSha256","name":"duplicate-good-then-bad","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"sha256\":\"x\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"key-case","frame":"{\"type\":\"end\",\"SHA256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"zero","frame":"{\"type\":\"received\",\"verified\":0}","go":"0","ts":"0"}
{"decoder":"receivedVerified","name":"equal","frame":"{\"type\":\"received\",\"verified\":3}","go":"3","ts":"3"}
{"decoder":"receivedVerified","name":"absent","frame":"{\"type\":\"received\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"above","frame":"{\"type\":\"received\",\"verified\":4}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"negative","frame":"{\"type\":\"received\",\"verified\":-1}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"minus-zero","frame":"{\"type\":\"received\",\"verified\":-0}","go":"0","ts":"0"}
{"decoder":"receivedVerified","name":"integer-fraction","frame":"{\"type\":\"received\",\"verified\":3.0}","go":"3","ts":"3"}
{"decoder":"receivedVerified","name":"exponent-one","frame":"{\"type\":\"received\",\"verified\":1e0}","go":"1","ts":"1"}
{"decoder":"receivedVerified","name":"exponent-above","frame":"{\"type\":\"received\",\"verified\":1e2}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"fraction","frame":"{\"type\":\"received\",\"verified\":2.5}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"string","frame":"{\"type\":\"received\",\"verified\":\"3\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"null","frame":"{\"type\":\"received\",\"verified\":null}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"true","frame":"{\"type\":\"received\",\"verified\":true}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"array","frame":"{\"type\":\"received\",\"verified\":[3]}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"object","frame":"{\"type\":\"received\",\"verified\":{}}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"2pow53-minus-1","frame":"{\"type\":\"received\",\"verified\":9007199254740991}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"2pow53","frame":"{\"type\":\"received\",\"verified\":9007199254740992}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"overflow","frame":"{\"type\":\"received\",\"verified\":1e999}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"duplicate-3-then-string","frame":"{\"type\":\"received\",\"verified\":3,\"verified\":\"x\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"duplicate-string-then-2","frame":"{\"type\":\"received\",\"verified\":\"x\",\"verified\":2}","go":"2","ts":"2"}
{"decoder":"receivedVerified","name":"key-case","frame":"{\"type\":\"received\",\"Verified\":3}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"not-received","frame":"{\"type\":\"ack\",\"verified\":3}","go":"none","ts":"none"}
`;
// PARITY-TABLE-END

interface ParityRow {
    decoder: 'refusalCodeOf' | 'classifyControl' | 'metadataGuard' | 'endSha256' | 'receivedVerified';
    name: string;
    frame: string;
    padTo?: number;
    padChar?: string;
    go: string;
    ts: string;
    finding?: string;
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;

/** The table's lines, exactly as written between the markers of a file. */
function tableLines(source: string): string[] {
    const lines = source.split('\n').map((l) => l.trim());
    const begin = lines.findIndex((l) => l.startsWith('// PARITY-TABLE-BEGIN'));
    const end = lines.findIndex((l) => l.startsWith('// PARITY-TABLE-END'));
    return lines.slice(begin + 1, end).filter((l) => l.startsWith('{'));
}

/** Grows a frame that ends in an empty "pad" string to exactly padTo bytes. */
function padded(row: ParityRow): string {
    if (!row.padTo || !row.padChar) return row.frame;
    const missing = row.padTo - bytes(row.frame);
    const unit = bytes(row.padChar);
    if (missing < 0 || missing % unit !== 0) throw new Error(`row ${row.name} cannot be padded to ${row.padTo} bytes`);
    return row.frame.slice(0, -2) + row.padChar.repeat(missing / unit) + row.frame.slice(-2);
}

/** What the browser decides for a frame, in the table's vocabulary. */
function tsDecision(row: ParityRow, frame: string): string {
    switch (row.decoder) {
        case 'refusalCodeOf': {
            const msg = classifyControl(frame);
            return msg?.type === 'incompatible' && refusalCodeOf(msg as Incompatible) ? 'accept' : 'reject';
        }
        case 'classifyControl':
            return classifyControl(frame)?.type ?? 'none';
        case 'metadataGuard':
            return metadataDecision(frame);
        case 'endSha256':
            return endSha256Decision(frame);
        case 'receivedVerified': {
            // A three-file batch, as in the Go twin.
            const msg = classifyControl(frame);
            if (msg?.type !== 'received') return 'none';
            const verified = verifiedCountOf(msg as Received, 3);
            return verified === null ? 'absent' : String(verified);
        }
    }
}

/**
 * The receiver-side reading of an end frame's digest: absent when the key is
 * missing, reject when normalizeSha256 refuses a present value (a present null
 * refuses too), accept otherwise. It reads the parsed field, not the frame, so
 * the frame-level FND-1 and FND-2 disagreements do not leak into these rows.
 */
function endSha256Decision(frame: string): 'accept' | 'reject' | 'absent' {
    let parsed: unknown;
    try {
        parsed = JSON.parse(frame);
    } catch {
        return 'reject';
    }
    if (typeof parsed !== 'object' || parsed === null || !Object.prototype.hasOwnProperty.call(parsed, 'sha256')) return 'absent';
    return normalizeSha256((parsed as { sha256?: unknown }).sha256) === null ? 'reject' : 'accept';
}

/**
 * The receiver's decision on a first string frame: accept (it acked), reject
 * (it reported an error), or ignore (neither). A fresh receiver per frame.
 */
function metadataDecision(frame: string): 'accept' | 'reject' | 'ignore' {
    let acked = false;
    let errored = false;
    const rx = createReceiver({
        send: (d) => {
            if (typeof d === 'string') acked = acked || (JSON.parse(d) as { type?: string }).type === 'ack';
        },
        onError: () => {
            errored = true;
        },
    });
    rx.handleMessage(frame);
    if (errored) return 'reject';
    return acked ? 'accept' : 'ignore';
}

/** The table wrapped in its markers, so rows parse from the lines the twin check compares. */
const OWN_TABLE = `// PARITY-TABLE-BEGIN\n${PARITY_TABLE}\n// PARITY-TABLE-END`;
const rows: ParityRow[] = tableLines(OWN_TABLE).map((l) => JSON.parse(l) as ParityRow);

describe('decoder parity with the Go engine (twin: cli/engine/transfer/parity_test.go)', () => {
    it('decides every parity row as its ts column says, and differs from Go only on a recorded finding', () => {
        expect(rows.length).toBeGreaterThan(40);
        for (const row of rows) {
            const got = tsDecision(row, padded(row));
            expect(got, `row ${row.decoder}/${row.name}`).toBe(row.ts);
            expect(row.ts === row.go || Boolean(row.finding), `row ${row.name} differs from Go without a finding`).toBe(true);
            expect(row.ts !== row.go || !row.finding, `row ${row.name} names a finding but agrees with Go`).toBe(true);
        }
    });

    it('pins the same parity table as cli/engine/transfer/parity_test.go', () => {
        const goSource = readFileSync(new URL('../../../cli/engine/transfer/parity_test.go', import.meta.url), 'utf8');
        const ours = tableLines(OWN_TABLE);
        expect(ours).toEqual(tableLines(readFileSync(new URL(import.meta.url), 'utf8')));
        expect(tableLines(goSource)).toEqual(ours);
    });
});

// --- Seeded generators -------------------------------------------------------

/** xorshift32 (Marsaglia): tiny, deterministic, no dependency. */
function xorshift32(seed: number): () => number {
    let x = seed >>> 0 || 1;
    return () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
}

type Rng = () => number;
const pick = <T,>(rng: Rng, items: readonly T[]): T => items[rng() % items.length];

const CONTROL_TYPES = ['metadata', 'end', 'ack', 'received', 'incompatible'] as const;
const CODES = ['write-failed', 'hash-mismatch', 'too-slow', 'declined', 'WRITE-FAILED', '', 'write-failed '];
const ALPHABET = [
    'a', 'Z', '0', ' ', '"', '\\', '{', '}', '[', ']', ':', ',', '.', '/', 'e', '-',
    ...[0, 7, 10, 13, 27, 0x7f, 0x85, 0x9b, 0xe9, 0x061c, 0x200f, 0x202e, 0x2066, 0x6587, 0xd800, 0xfeff].map((c) =>
        String.fromCharCode(c)
    ),
];
const RAW_NUMBERS = ['0', '-0', '1', '-1', '1.5', '1e300', '1e999', '-1e999', '9007199254740991', '9007199254740992', '10001'];
const OMIT = null;

function genString(rng: Rng, maxLen: number): string {
    let s = '';
    const n = rng() % maxLen;
    for (let i = 0; i < n; i++) s += pick(rng, ALPHABET);
    return s;
}

/** A JSON value as text, or OMIT for an absent field. */
function genValue(rng: Rng, depth = 0): string | null {
    switch (rng() % 11) {
        case 0:
            return JSON.stringify(pick(rng, CODES));
        case 1:
            return JSON.stringify(genString(rng, 24));
        case 2:
            return String((rng() | 0) % 100000);
        case 3:
            return pick(rng, RAW_NUMBERS);
        case 4:
            return rng() % 2 ? 'true' : 'false';
        case 5:
            return 'null';
        case 6:
            return depth < 2 ? '[' + [genValue(rng, depth + 1) ?? '0', genValue(rng, depth + 1) ?? '1'].join(',') + ']' : '[]';
        case 7:
            return depth < 2 ? jsonObject([['code', genValue(rng, depth + 1)], [pick(rng, ['__proto__', 'type', 'x']), genValue(rng, depth + 1)]]) : '{}';
        case 8:
            return JSON.stringify(pick(rng, ['__proto__', 'constructor', 'toString', 'hasOwnProperty']));
        case 9:
            return JSON.stringify(pick(rng, CONTROL_TYPES));
        default:
            return OMIT;
    }
}

function jsonObject(fields: Array<[string, string | null]>): string {
    return '{' + fields.filter(([, v]) => v !== OMIT).map(([k, v]) => JSON.stringify(k) + ':' + v).join(',') + '}';
}

/** Wraps a generated object in the damage a hostile or broken peer can do. */
function damage(rng: Rng, text: string): string {
    switch (rng() % 8) {
        case 0:
            return pick(rng, [' ', '\n', '\t', String.fromCharCode(0xfeff), 'x']) + text;
        case 1:
            return text.slice(0, rng() % (text.length + 1));
        case 2: {
            const at = rng() % (text.length + 1);
            return text.slice(0, at) + pick(rng, ALPHABET) + text.slice(at);
        }
        case 3: {
            // Land near the control cap, on either side of it.
            const target = CONTROL_MSG_MAX - 8 + (rng() % 17);
            const missing = Math.max(0, target - bytes(text) - 9);
            return text.slice(0, -1) + (text.length > 2 ? ',' : '') + '"pad":"' + 'p'.repeat(missing) + '"}';
        }
        default:
            return text;
    }
}

function field(rng: Rng, likely: string): string | null {
    return rng() % 3 ? likely : genValue(rng);
}

/** Everything needed to replay one generated frame: the seed, its index and the frame. */
function describeFailure(seed: number, i: number, frame: string, what: string): string {
    return `seed 0x${seed.toString(16)} frame ${i} (${what}): ${JSON.stringify(frame)}`;
}

const REFUSAL_SEED = 0x5eed0017;
const CLASSIFY_SEED = 0x5eed0b0b;
const METADATA_SEED = 0x5eed3e7a;
const SHA256_SEED = 0x5eed5a25;
const VERIFIED_SEED = 0x5eedfe71;
const FRAMES = 1000;

describe('seeded xorshift32 property loops (1000 frames each)', () => {
    it(`refusalCodeOf never throws and returns only an allowlisted code (xorshift32 seed 0x${REFUSAL_SEED.toString(16)})`, () => {
        const rng = xorshift32(REFUSAL_SEED);
        let accepted = 0;
        for (let i = 0; i < FRAMES; i++) {
            const frame = damage(
                rng,
                jsonObject([
                    ['type', field(rng, '"incompatible"')],
                    ['reason', genValue(rng)],
                    ['pv', field(rng, '1')],
                    ['pvMin', field(rng, '1')],
                    ['code', rng() % 2 ? JSON.stringify(pick(rng, CODES)) : genValue(rng)],
                    ['saved', genValue(rng)],
                ])
            );
            let code: string | null = null;
            let msg: ReturnType<typeof classifyControl> = null;
            try {
                msg = classifyControl(frame);
                if (msg?.type === 'incompatible') code = refusalCodeOf(msg as Incompatible);
            } catch (err) {
                throw new Error(describeFailure(REFUSAL_SEED, i, frame, `threw ${String(err)}`));
            }
            if (code !== null) {
                accepted++;
                expect(REFUSAL_CODES.has(code), describeFailure(REFUSAL_SEED, i, frame, 'code outside REFUSAL_CODES')).toBe(true);
                expect((msg as Incompatible).code, describeFailure(REFUSAL_SEED, i, frame, 'code differs from the frame')).toBe(code);
            }
        }
        // The generator reached both answers, so the loop is not vacuous.
        expect(accepted).toBeGreaterThan(0);
        expect(accepted).toBeLessThan(FRAMES);
    });

    it(`classifyControl never throws, and past the cap never classifies (xorshift32 seed 0x${CLASSIFY_SEED.toString(16)})`, () => {
        const rng = xorshift32(CLASSIFY_SEED);
        let classified = 0;
        let overCap = 0;
        for (let i = 0; i < FRAMES; i++) {
            const extra = rng() % 3;
            const fields: Array<[string, string | null]> = [['type', field(rng, JSON.stringify(pick(rng, CONTROL_TYPES)))]];
            for (let k = 0; k < extra; k++) fields.push([pick(rng, ['id', 'x', '__proto__', 'type', 'code']), genValue(rng)]);
            const frame = damage(rng, jsonObject(fields));
            let msg: ReturnType<typeof classifyControl> = null;
            try {
                msg = classifyControl(frame);
            } catch (err) {
                throw new Error(describeFailure(CLASSIFY_SEED, i, frame, `threw ${String(err)}`));
            }
            if (bytes(frame) > CONTROL_MSG_MAX) overCap++;
            if (msg !== null) {
                classified++;
                expect((CONTROL_TYPES as readonly string[]).includes(msg.type), describeFailure(CLASSIFY_SEED, i, frame, 'unknown type')).toBe(true);
                expect(bytes(frame) <= CONTROL_MSG_MAX, describeFailure(CLASSIFY_SEED, i, frame, 'over the cap')).toBe(true);
            }
        }
        // Not vacuous: some frames classified, some did not, some crossed the cap.
        expect(classified).toBeGreaterThan(0);
        expect(classified).toBeLessThan(FRAMES);
        expect(overCap).toBeGreaterThan(0);
    });

    it(`the receiver metadata guard never throws and always decides (xorshift32 seed 0x${METADATA_SEED.toString(16)})`, () => {
        const rng = xorshift32(METADATA_SEED);
        const seen: Record<string, number> = {};
        let overCap = 0;
        for (let i = 0; i < FRAMES; i++) {
            const frame = damage(
                rng,
                jsonObject([
                    ['type', field(rng, '"metadata"')],
                    ['id', field(rng, '"g"')],
                    ['fileName', field(rng, JSON.stringify(genString(rng, 40) || 'a.bin'))],
                    ['fileSize', field(rng, '4')],
                    ['index', field(rng, '1')],
                    ['total', field(rng, '1')],
                    ['totalBytes', field(rng, '4')],
                    ['pv', field(rng, '1')],
                    ['pvMin', field(rng, '1')],
                    ['ver', genValue(rng)],
                ])
            );
            let decision: string;
            try {
                decision = metadataDecision(frame);
            } catch (err) {
                throw new Error(describeFailure(METADATA_SEED, i, frame, `threw ${String(err)}`));
            }
            expect(['accept', 'reject', 'ignore'], describeFailure(METADATA_SEED, i, frame, `decision ${decision}`)).toContain(decision);
            seen[decision] = (seen[decision] ?? 0) + 1;
            if (bytes(frame) > CONTROL_MSG_MAX) {
                overCap++;
                expect(decision, describeFailure(METADATA_SEED, i, frame, 'over the cap')).toBe('reject');
            }
        }
        // Not vacuous: all three decisions happened, and some frames crossed the cap.
        expect(Object.keys(seen).sort()).toEqual(['accept', 'ignore', 'reject']);
        expect(overCap).toBeGreaterThan(0);
    });
    it(`the end digest reading never throws and always decides (xorshift32 seed 0x${SHA256_SEED.toString(16)})`, () => {
        const rng = xorshift32(SHA256_SEED);
        const good = JSON.stringify('0123456789abcdef'.repeat(4));
        const seen: Record<string, number> = {};
        for (let i = 0; i < FRAMES; i++) {
            const frame = damage(rng, jsonObject([['type', field(rng, '"end"')], ['sha256', rng() % 3 ? field(rng, good) : genValue(rng)]]));
            let decision: string;
            try {
                decision = endSha256Decision(frame);
            } catch (err) {
                throw new Error(describeFailure(SHA256_SEED, i, frame, `threw ${String(err)}`));
            }
            expect(['accept', 'reject', 'absent'], describeFailure(SHA256_SEED, i, frame, `decision ${decision}`)).toContain(decision);
            seen[decision] = (seen[decision] ?? 0) + 1;
        }
        // Not vacuous: every decision happened.
        expect(Object.keys(seen).sort()).toEqual(['absent', 'accept', 'reject']);
    });

    it(`verifiedCountOf never throws and never over-claims (xorshift32 seed 0x${VERIFIED_SEED.toString(16)})`, () => {
        const rng = xorshift32(VERIFIED_SEED);
        let usable = 0;
        let received = 0;
        for (let i = 0; i < FRAMES; i++) {
            const frame = damage(rng, jsonObject([['type', field(rng, '"received"')], ['verified', rng() % 3 ? field(rng, String(rng() % 5)) : genValue(rng)]]));
            let verified: number | null = null;
            try {
                const msg = classifyControl(frame);
                if (msg?.type !== 'received') continue;
                received++;
                verified = verifiedCountOf(msg as Received, 3);
            } catch (err) {
                throw new Error(describeFailure(VERIFIED_SEED, i, frame, `threw ${String(err)}`));
            }
            if (verified !== null) {
                usable++;
                expect(Number.isSafeInteger(verified) && verified >= 0 && verified <= 3, describeFailure(VERIFIED_SEED, i, frame, `count ${verified}`)).toBe(true);
            }
        }
        // Not vacuous: some frames were received frames, and some of those carried a usable count and some did not.
        expect(usable).toBeGreaterThan(0);
        expect(usable).toBeLessThan(received);
    });
});
