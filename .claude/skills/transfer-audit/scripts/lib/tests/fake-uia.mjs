// Scripted stand-in for scripts/desktop-uia.ps1 -Serve, used by
// lib/uia.test.mjs. It speaks the same line protocol (a ready notice, then
// one JSON response per JSON request, id echoed, ok or reason/detail) and
// adds a few commands the real helper does not have so the client's timeout,
// retry and crash handling can be exercised without a window:
//   echo    -> every request field back, for framing and UTF-8 round trips
//   slow    -> answers after params.ms
//   flaky   -> fails with params.reason (default not-found) params.times
//              times per params.key, then succeeds with { attempts }
//   crash   -> exits with code 3 without answering
//   noreply -> never answers (the client must time out)
//   wedge   -> from now on ignores quit and a closed stdin (the client
//              must kill the helper and still report its exit)
// read-text answers from a fixed tree in the measured shape (the pill is one
// leaf, the completion line four leaves whose count sits in its own element,
// a rectless pair that only the parent rule can group) and honors join the
// way the real helper does (helper MEASURED 8, INFERRED 9: runs are
// geometric, the raw-view parent is the fallback for a node without a
// rect), so lib/uia.mjs's join option is proven end to end.
import { createInterface } from 'node:readline';

// rect is [l, t, r, b] in screen pixels (100 percent scaling, 14 px text on
// 20 px lines, the measured window); a leaf without one is rectless.
const LEAVES = Object.freeze([
    { name: 'Ready', parent: 'a', rect: [900, 100, 950, 120] },
    { name: 'FILES', parent: 'b', rect: [600, 140, 640, 160] },
    { name: '1 ITEM', parent: 'b', rect: [900, 140, 940, 160] },
    { name: 'Sent ', parent: 'c', rect: [700, 200, 730, 220] },
    { name: '1', parent: 'd', rect: [730, 200, 738, 220] },
    { name: ' ', parent: 'c', rect: [738, 200, 742, 220] },
    { name: 'item', parent: 'c', rect: [742, 200, 770, 220] },
    { name: 'Error: ', parent: 'e', rect: [600, 240, 640, 260] },
    { name: 'boom', parent: 'e', rect: [640, 240, 675, 260] },
    { name: 'Saved to ', parent: 'f' },
    { name: 'C:\\out\\a1', parent: 'f' },
]);

// The helper's thresholds ($JOIN_GAP_PX, $JOIN_GAP_RATIO, $JOIN_LINE_OVERLAP).
const GAP_PX = 6;
const GAP_RATIO = 0.4;
const LINE_OVERLAP = 0.5;

const height = (r) => r[3] - r[1];
const sameLine = (a, b) =>
    Math.min(a[3], b[3]) - Math.max(a[1], b[1]) >=
    LINE_OVERLAP * Math.min(height(a), height(b));
const joinGap = (a, b) =>
    Math.max(GAP_PX, GAP_RATIO * Math.min(height(a), height(b)));

// Get-TextRuns: a leaf with a rect joins a geometric run when it shares the
// previous leaf's line and its left edge is within the gap of the run's
// right edge; a whitespace-only leaf never ends a run; a rectless leaf
// groups by parent id; anything else starts a new run.
function textRuns(leaves) {
    const runs = [];
    let current = null;
    let meta = null;
    for (const l of leaves) {
        const rect = l.rect ?? null;
        const blank = l.name.trim() === '';
        if (blank && current) {
            current.push(l);
            if (rect && meta.kind === 'geo' && rect[2] > meta.right)
                meta.right = rect[2];
            continue;
        }
        const parentId = rect ? '' : (l.parent ?? '');
        let joins = false;
        if (current) {
            if (rect) {
                if (meta.kind === 'geo')
                    joins =
                        sameLine(meta.last, rect) &&
                        Math.abs(rect[0] - meta.right) <=
                            joinGap(meta.last, rect);
                else if (meta.kind === 'open') joins = true;
            } else if (meta.kind === 'parent')
                joins = parentId !== '' && parentId === meta.parentId;
            else if (meta.kind === 'open') joins = parentId !== '';
        }
        if (!joins) {
            current = [];
            runs.push(current);
            meta = { kind: 'solo', last: null, right: 0, parentId: '' };
        }
        current.push(l);
        if (rect) {
            meta.kind = 'geo';
            meta.last = rect;
            if (!joins || rect[2] > meta.right) meta.right = rect[2];
        } else if (parentId) {
            meta.kind = 'parent';
            meta.parentId = parentId;
        } else meta.kind = blank ? 'open' : 'solo';
    }
    return runs;
}

// Get-RunTexts: the raw concatenation, its whitespace-normalized form and
// the trimmed non-empty leaves joined by one space, deduplicated.
function runTexts(run) {
    const names = run.map((l) => l.name);
    const raw = names.join('');
    const forms = [raw];
    const normalized = (s) => s.replace(/\s+/g, ' ').trim();
    for (const t of [
        normalized(raw),
        normalized(
            names
                .map((n) => n.trim())
                .filter(Boolean)
                .join(' ')
        ),
    ])
        if (!forms.includes(t)) forms.push(t);
    return forms;
}

// Same rule as the helper: a run whose joined text matches answers as that
// one line; otherwise its leaves answer singly.
function readText(req) {
    const rx = new RegExp(String(req.regex), req.ignoreCase ? 'i' : '');
    const runs = req.join === true ? textRuns(LEAVES) : LEAVES.map((l) => [l]);
    const texts = [];
    let joined = 0;
    for (const run of runs) {
        let hit = null;
        if (run.length >= 2) {
            joined += 1;
            hit = runTexts(run).find((t) => rx.test(t)) ?? null;
        }
        if (hit !== null) texts.push(hit);
        else for (const l of run) if (rx.test(l.name)) texts.push(l.name);
    }
    return {
        texts,
        count: texts.length,
        joined,
        nodes: LEAVES.length,
        rects: LEAVES.filter((l) => l.rect).length,
    };
}

const flaky = new Map();
let wedged = false;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

out({ id: null, ok: true, ready: true, pid: process.pid, fake: true });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let req;
    try {
        req = JSON.parse(line);
    } catch (err) {
        out({
            id: null,
            ok: false,
            reason: 'bad-request',
            detail: err.message,
        });
        return;
    }
    const t0 = Date.now();
    const reply = (fields) =>
        out({ id: req.id, ok: true, ms: Date.now() - t0, ...fields });
    const fail = (reason, detail) =>
        out({ id: req.id, ok: false, ms: Date.now() - t0, reason, detail });
    switch (req.cmd) {
        case 'ping':
            return reply({ pong: true, pid: process.pid, ps: 'fake' });
        case 'echo': {
            const { id, cmd, ...rest } = req;
            return reply({ echo: rest, cmd });
        }
        case 'slow':
            setTimeout(() => reply({ slept: req.ms }), Number(req.ms) || 0);
            return;
        case 'flaky': {
            const key = req.key ?? 'default';
            const n = (flaky.get(key) ?? 0) + 1;
            flaky.set(key, n);
            if (n <= (Number(req.times) || 0))
                return fail(req.reason ?? 'not-found', `attempt ${n}`);
            return reply({ attempts: n });
        }
        case 'find-window':
            return reply({
                hwnd: 4242,
                pid: process.pid,
                exe: 'C:\\fake\\floe-desktop.exe',
                rect: { l: 0, t: 0, r: 1140, b: 720, w: 1140, h: 720 },
                minimized: false,
                visible: true,
                count: 1,
            });
        case 'read-text':
            try {
                return reply(readText(req));
            } catch (err) {
                return fail('bad-request', err.message);
            }
        case 'crash':
            process.exit(3);
            return;
        case 'noreply':
            return;
        case 'wedge':
            wedged = true;
            setInterval(() => {}, 1 << 30);
            return reply({ wedged: true });
        case 'quit':
            if (wedged) return;
            reply({ bye: true });
            process.exit(0);
            return;
        default:
            return fail('unknown-cmd', `cmd '${req.cmd}'`);
    }
});
rl.on('close', () => {
    if (!wedged) process.exit(0);
});
