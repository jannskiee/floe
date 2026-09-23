// The request link visitor (W on /r), S1-REL-03a step 6: a fresh Chromium
// context that opens <web>/r/<linkId>#<roomId> with the same Safety setup
// every audit browser gets, before any page script runs:
//
// - localStorage['floe:report-stats'] seeded to the string 'false', and read
//   back after load;
// - every **/api/stats/report request aborted and counted (guardStats), so
//   the cell can assert 0 attempts;
// - the AUDIT_INIT recorder, with iceTransportPolicy 'relay' for TA-11.
//
// Then the page is driven the way a person does it (WP-R2): the files go
// into the hidden "Choose files" input, Send is clicked by its label, and
// the page's own status card is read until it shows what the cell expects.
// Every string it reads is the page's frozen copy
// (client/lib/request/visitorCopy.ts, approved at Checkpoint C); the page
// never renders a peer-supplied string, so what it reads is safe to quote.
//
// The link is a secret for its life (the room after `#`): it goes to
// page.goto and nowhere else, and any line this module logs carries the
// redacted form. The TURN credential answers are recorded by status only,
// never by body.
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { REQUEST_LINK_RE, redactRequestLink } from './desktop.mjs';
import { redactRequestLinks } from './report.mjs';
import { PhaseError, sleep } from './surfaces.mjs';
import {
    AUDIT_INIT,
    REPORT_STATS_KEY,
    SAMPLE,
    STATS_ROUTE,
    TURN_FETCH_RE,
    bytesMovedFrom,
    candidateCensus,
    checkRelayPolicy,
    guardStats,
    seedLocalStorage,
    webRoute,
} from './web.mjs';

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '');

/**
 * The visitor page's fixed copy the runner keys on, quoted from
 * client/lib/request/visitorCopy.ts (the C-row id beside each). The V13
 * title is statusCopy's C-120, `ALL ${total} FILES ARRIVED`, and
 * `1 FILE ARRIVED` for a single file (D-123).
 */
export const VISITOR_TEXT = Object.freeze({
    ready: 'SEND FILES THROUGH THIS LINK', // C-01, the Ready eyebrow (an h1)
    connecting: 'Connecting to their computer', // C-50
    waiting: 'Waiting for them to accept', // C-60
    hostAbsent: 'Their computer is not connected right now', // C-40
    used: 'This link has already been used', // C-43
    declined: 'They declined. Nothing was sent.', // C-70
    tryAgain: 'Try again', // C-42
    backToFiles: 'Back to files', // C-72
    shaMatched: "Their app reports every file's SHA-256 matched.", // C-122
});

/** V13's title for a drop of n files (C-120, singular when n is 1). */
export const arrivedTitle = (n) => (n === 1 ? '1 FILE ARRIVED' : `ALL ${n} FILES ARRIVED`);

/** C-09: the Send button's label for n files. */
export const sendLabel = (n) => (n === 1 ? 'Send 1 file' : `Send ${n} files`);

/**
 * The titles a page shows while nothing has ended yet: Ready, Connecting,
 * Waiting, and Sending (C-90, `SENDING i OF n`). Any other title is an
 * ending (a refusal, a block, a lost connection), so a wait that meets one
 * it did not ask for fails at once instead of running its clock out.
 */
export function inProgressTitle(t) {
    return (
        t === VISITOR_TEXT.ready ||
        t === VISITOR_TEXT.connecting ||
        t === VISITOR_TEXT.waiting ||
        /^SENDING \d+ OF \d+$/.test(t)
    );
}

/**
 * The "Choose files" input: RequestDropzone.tsx renders it hidden with
 * `multiple`, beside a folder input that carries webkitdirectory.
 */
export const FILE_INPUT = 'input[type="file"]:not([webkitdirectory])';
export const VISITOR_POLL_MS = 250;
export const ADD_FILES_MS = 20_000;
export const MAX_VISITOR_SAMPLES = 400;

/**
 * Page function: every h1 (the Ready eyebrow, the Sending header or the
 * status card's title) and every line of the status card. Serialized by
 * page.evaluate, so it must not reference module scope.
 */
export const VISITOR_STATUS = () => ({
    titles: [...document.querySelectorAll('h1')]
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean),
    lines: [...document.querySelectorAll('section p')]
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean),
});

/**
 * The link to open, or a refusal: it must be a request link, and it must
 * point at the web under test (the same scheme, port and host, give or take
 * a leading www.), so a head run can never send its visitor to production.
 */
export function visitorTarget(link, web) {
    const s = String(link ?? '');
    if (!REQUEST_LINK_RE.test(s))
        throw new PhaseError(
            'request',
            'visitor: not a request link (<web>/r/<linkId>#<roomId>)'
        );
    const u = new URL(s);
    let w;
    try {
        w = new URL(String(web));
    } catch {
        throw new PhaseError('request', `visitor: bad web origin ${web}`);
    }
    if (
        u.protocol !== w.protocol ||
        u.port !== w.port ||
        bareHost(u.hostname) !== bareHost(w.hostname)
    )
        throw new PhaseError(
            'request',
            `visitor: the link points at ${u.origin}, not the web under test ${w.origin}`
        );
    return u.href;
}

export class Visitor {
    constructor({
        ctx,
        page,
        statsRec,
        localStorageRead,
        relayOnly,
        tag = 'visitor',
        shown = null,
        evidenceDir = null,
        ledger = null,
        turnFetches = [],
    }) {
        this.ctx = ctx;
        this.page = page;
        this.statsRec = statsRec;
        this.localStorageRead = localStorageRead;
        this.relayOnly = relayOnly;
        this.tag = tag;
        this.shown = shown;
        this.evidenceDir = evidenceDir;
        this.ledger = ledger;
        this.turnFetches = turnFetches;
        this.samples = [];
        this.titles = [];
        this.notes = [];
        this.screenshots = [];
        this.marks = {};
        this.fileCount = 0;
        this.closed = false;
    }

    _spend() {
        // RequestVisitor.tsx startAttempt: one ICE fetch and one socket per
        // attempt, so every Send and every Try again spends both.
        if (this.ledger && typeof this.ledger.spend === 'function') {
            this.ledger.spend('turn');
            this.ledger.spend('conn');
        }
    }

    _button(name) {
        return this.page.getByRole('button', { name, exact: true }).first();
    }

    async _visible(name) {
        try {
            return await this._button(name).isVisible();
        } catch {
            return false;
        }
    }

    /**
     * Hand the page the files through the hidden input, then wait for its
     * Send label to count them (C-09), which is the page's own proof that
     * the pick landed.
     */
    async addFiles(paths, { timeoutMs = ADD_FILES_MS, now = Date.now, nap = sleep } = {}) {
        const list = (paths || []).map(String);
        if (!list.length)
            throw new PhaseError('request', `${this.tag}: no files to add`);
        await this.page.locator(FILE_INPUT).first().setInputFiles(list);
        const name = sendLabel(list.length);
        const start = now();
        while (!(await this._visible(name))) {
            if (now() - start >= timeoutMs)
                throw new PhaseError(
                    'request',
                    `request-flow: the ${this.tag} never offered "${name}" after ${list.length} file(s) were picked`,
                    { signatureKey: 'request-flow' }
                );
            await nap(VISITOR_POLL_MS);
        }
        this.fileCount = list.length;
        this.marks.added = now();
        return { added: list.length, send: name };
    }

    async send({ now = Date.now } = {}) {
        if (!this.fileCount)
            throw new PhaseError('request', `${this.tag}: Send before any file`);
        this._spend();
        await this._button(sendLabel(this.fileCount)).click();
        this.marks.sent = now();
    }

    /** C-42 on the host-absent card (V4) and the other retry states. */
    async tryAgain({ now = Date.now } = {}) {
        this._spend();
        await this._button(VISITOR_TEXT.tryAgain).click();
        this.marks.retried = now();
    }

    async status() {
        const s = await this.page.evaluate(VISITOR_STATUS);
        return {
            titles: Array.isArray(s?.titles) ? s.titles : [],
            lines: Array.isArray(s?.lines) ? s.lines : [],
        };
    }

    /** One getStats sample of the page's peer connections (web.mjs SAMPLE). */
    async sampleOnce() {
        const s = await this.page.evaluate(SAMPLE).catch(() => null);
        if (!s) return null;
        if (this.samples.length >= MAX_VISITOR_SAMPLES) this.samples.splice(1, 1);
        this.samples.push(s);
        return s;
    }

    /**
     * Poll the page until one of `want` is its title. An ending the cell
     * did not ask for fails at once with that title (fixed copy); the clock
     * running out fails with the last titles seen. Every poll also samples
     * the peer connection, so the route is read while the drop is live.
     */
    async awaitTitle(
        want,
        { timeoutMs, now = Date.now, nap = sleep, live = null } = {}
    ) {
        const wanted = [].concat(want);
        const start = now();
        let last = [];
        for (;;) {
            if (live && !live.on)
                throw new PhaseError('request', `${this.tag}: the attempt ended`);
            const st = await this.status();
            last = st.titles;
            this._seen(st.titles, now());
            await this.sampleOnce();
            const hit = st.titles.find((t) => wanted.includes(t));
            if (hit) return { title: hit, lines: st.lines, at: now() };
            const ending = st.titles.find((t) => !inProgressTitle(t));
            if (ending)
                throw new PhaseError(
                    'request',
                    `request-flow: the ${this.tag} read "${ending}" instead of ${wanted.map((w) => `"${w}"`).join(' or ')}`,
                    { signatureKey: 'request-flow', visitorTitle: ending }
                );
            if (now() - start >= timeoutMs)
                throw new PhaseError(
                    'request',
                    `request-flow: the ${this.tag} did not read ${wanted.map((w) => `"${w}"`).join(' or ')} within ${timeoutMs} ms (last: ${last.map((t) => `"${t}"`).join(', ') || 'no title'})`,
                    { signatureKey: 'request-flow' }
                );
            await nap(VISITOR_POLL_MS);
        }
    }

    _seen(titles, t) {
        const key = titles.join(' | ');
        const prev = this.titles.at(-1);
        if (!prev || prev.titles !== key) this.titles.push({ t, titles: key });
    }

    /**
     * The route this page saw: the nominated candidate pair from getStats
     * first (web.mjs webRoute), then the V13 line's own word (`..., direct.`
     * or `..., relay.`), which the page takes from the same pair.
     */
    route(lines = []) {
        const last = this.samples.at(-1);
        const r = webRoute({
            samples: this.samples,
            events: last ? last.status : [],
            pill: null,
        });
        if (r) return r;
        const m = lines
            .map((l) => /, (direct|relay)\.(?: |$)/.exec(l))
            .find(Boolean);
        return m
            ? { t: null, source: 'visitor-line', local: null, remote: null, verdict: m[1] }
            : null;
    }

    policy() {
        return checkRelayPolicy(this.samples, this.relayOnly);
    }

    /**
     * The same shape cell.mjs statsProofCheck reads from a web leg; breach
     * is true on any attempt or a seed that did not read back as 'false'.
     */
    statsProof() {
        const attempts = this.statsRec.attempts.length;
        const last = this.samples.at(-1);
        const reported = last && Array.isArray(last.bytesReported)
            ? last.bytesReported.length
            : 0;
        return {
            kind: 'route-abort',
            route: STATS_ROUTE,
            attempts,
            localStorage: this.localStorageRead,
            bytesReportedEvents: reported,
            breach:
                attempts > 0 ||
                reported > 0 ||
                this.localStorageRead !== 'false',
        };
    }

    evidence() {
        const policy = this.policy();
        return {
            surface: 'web',
            role: 'visitor',
            tag: this.tag,
            relayOnly: this.relayOnly,
            link: this.shown,
            marks: this.marks,
            titles: this.titles,
            samples: this.samples.length,
            candidates: candidateCensus(this.samples),
            dcBytes: bytesMovedFrom(this.samples),
            // Status only, never a body: the body carries TURN credentials.
            turnFetches: this.turnFetches.map((f) => ({ t: f.t, status: f.status })),
            policy,
            policyOk: policy.ok,
            statsProof: this.statsProof(),
            screenshots: this.screenshots,
            notes: this.notes,
        };
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        if (this.evidenceDir && this.page && !this.page.isClosed?.()) {
            const file = path.join(this.evidenceDir, `${this.tag}-final.png`);
            try {
                mkdirSync(this.evidenceDir, { recursive: true });
                await this.page.screenshot({ path: file });
                this.screenshots.push(file);
            } catch (e) {
                this.notes.push(`screenshot: ${e.message}`);
            }
        }
        try {
            await this.ctx.close();
        } catch {
            // Already closed with the browser.
        }
    }
}

export async function openVisitor({
    browser,
    link,
    web,
    relayOnly = false,
    log = null,
    tag = 'visitor',
    evidenceDir = null,
    ledger = null,
}) {
    const target = visitorTarget(link, web);
    const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        // floe.one ships a service worker, and context routing does not
        // intercept what a service worker serves: the stats guard rests on
        // that interception (the same reason as web.mjs WebLeg.start).
        serviceWorkers: 'block',
    });
    const statsRec = { attempts: [] };
    const turnFetches = [];
    try {
        await seedLocalStorage(ctx, REPORT_STATS_KEY, 'false');
        await guardStats(ctx, statsRec);
        await ctx.addInitScript(AUDIT_INIT({ relayOnly }));
        const page = await ctx.newPage();
        if (typeof page.on === 'function')
            page.on('response', (res) => {
                try {
                    if (TURN_FETCH_RE.test(res.url()))
                        turnFetches.push({ t: Date.now(), status: res.status() });
                } catch {
                    // A response torn down with its context has no url().
                }
            });
        const shown = redactRequestLink(target);
        if (log)
            log(`${tag}: opening ${shown}${relayOnly ? ' (relay forced)' : ''}`);
        await page.goto(target, { waitUntil: 'load' });
        const localStorageRead = await page.evaluate((k) => {
            try {
                return localStorage.getItem(k);
            } catch {
                return null;
            }
        }, REPORT_STATS_KEY);
        return new Visitor({
            ctx,
            page,
            statsRec,
            localStorageRead,
            relayOnly,
            tag,
            shown,
            evidenceDir,
            ledger,
            turnFetches,
        });
    } catch (e) {
        try {
            await ctx.close();
        } catch {
            // The context may already be gone.
        }
        // A navigation error names the URL it failed on, fragment and all.
        if (e instanceof PhaseError) throw e;
        throw new PhaseError(
            'request',
            `${tag}: ${redactRequestLinks(e && e.message)}`
        );
    }
}
