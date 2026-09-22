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
// The link is a secret for its life (the room after `#`): it goes to
// page.goto and nowhere else, and any line this module logs carries the
// redacted form. The web visitor page is not on this base yet, so adding
// files, Send and the state text are the live run's work (S1-REL-03b, now
// CP-QA); this module is the context and its proof.
import { REQUEST_LINK_RE, redactRequestLink } from './desktop.mjs';
import { PhaseError } from './surfaces.mjs';
import {
    AUDIT_INIT,
    REPORT_STATS_KEY,
    STATS_ROUTE,
    guardStats,
    seedLocalStorage,
} from './web.mjs';

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '');

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
    constructor({ ctx, page, statsRec, localStorageRead, relayOnly }) {
        this.ctx = ctx;
        this.page = page;
        this.statsRec = statsRec;
        this.localStorageRead = localStorageRead;
        this.relayOnly = relayOnly;
    }
    /**
     * The same shape cell.mjs statsProofCheck reads from a web leg; breach
     * is true on any attempt or a seed that did not read back as 'false'.
     */
    statsProof() {
        const attempts = this.statsRec.attempts.length;
        return {
            kind: 'route-abort',
            route: STATS_ROUTE,
            attempts,
            localStorage: this.localStorageRead,
            breach: attempts > 0 || this.localStorageRead !== 'false',
        };
    }
    async close() {
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
}) {
    const target = visitorTarget(link, web);
    const ctx = await browser.newContext();
    const statsRec = { attempts: [] };
    try {
        await seedLocalStorage(ctx, REPORT_STATS_KEY, 'false');
        await guardStats(ctx, statsRec);
        await ctx.addInitScript(AUDIT_INIT({ relayOnly }));
        const page = await ctx.newPage();
        if (log)
            log(
                `visitor: opening ${redactRequestLink(target)}${relayOnly ? ' (relay forced)' : ''}`
            );
        await page.goto(target, { waitUntil: 'load' });
        const localStorageRead = await page.evaluate((k) => {
            try {
                return localStorage.getItem(k);
            } catch {
                return null;
            }
        }, REPORT_STATS_KEY);
        return new Visitor({ ctx, page, statsRec, localStorageRead, relayOnly });
    } catch (e) {
        try {
            await ctx.close();
        } catch {
            // The context may already be gone.
        }
        throw e;
    }
}
