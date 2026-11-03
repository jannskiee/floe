import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIRST_ACK_TIMEOUT_MS } from './constants';
import { REQUEST_ACK_TIMEOUT_MS, REQUEST_ACK_GRACE_MS } from '../transfer/protocol';

// What the /r page may and may not reach, read as TEXT.
//
// client/vitest.config.ts runs in node and collects lib/ and app/ only, so the
// component and the hooks cannot be mounted here. Their sources can be read,
// and the properties below are properties of the source: which modules are
// imported, which strings are emitted, which constants are passed. A rule that
// needs the running page (no socket before Send, no request carrying the room)
// is the Playwright privacy spec's.

const CLIENT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(CLIENT + rel, 'utf8');

/** Every production source reachable only from /r. Test files are left out:
 *  they name the forbidden things on purpose. */
function requestSources(): Record<string, string> {
    const files: string[] = [
        'components/RequestVisitor.tsx',
        'hooks/useRequestFiles.ts',
        'hooks/useVisitorGuards.ts',
        'app/r/[linkId]/page.tsx',
    ];
    for (const f of readdirSync(CLIENT + 'components/request')) {
        if (f.endsWith('.tsx')) files.push(`components/request/${f}`);
    }
    for (const f of readdirSync(CLIENT + 'lib/request')) {
        if (f.endsWith('.ts') && !f.endsWith('.test.ts')) files.push(`lib/request/${f}`);
    }
    const out: Record<string, string> = {};
    for (const f of files) {
        try {
            out[f] = read(f);
        } catch (err) {
            // useVisitorGuards arrives with S1-WEB-04; everything else must exist.
            if (f === 'hooks/useVisitorGuards.ts') continue;
            throw err;
        }
    }
    return out;
}

/** Everything /r renders: its own sources, plus the shared ones that wrap or
 *  sit beside the shell there. They are shared with other pages, so they are
 *  not in requestSources: InAppBrowserGuard also wraps /, where it rightly
 *  reports to Umami, which the /r-only rules forbid. Only rules that hold for
 *  every page these render on may read this list. */
function renderedOnRequestPage(): Record<string, string> {
    const out = requestSources();
    for (const f of [
        'components/InAppBrowserGuard.tsx',
        'app/layout.tsx',
        'components/UmamiScript.tsx',
        'components/ServiceWorkerRegistration.tsx',
    ]) {
        out[f] = read(f);
    }
    return out;
}

/** The argument text of every call to `name(` in `src`, balanced on parens. */
function callArgs(src: string, name: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (;;) {
        const at = src.indexOf(name + '(', from);
        if (at < 0) return out;
        let depth = 0;
        let i = at + name.length;
        for (; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')' && --depth === 0) break;
        }
        out.push(src.slice(at + name.length + 1, i));
        from = i;
    }
}

/** Split an argument list on its top-level commas. */
function splitArgs(args: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of args) {
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) {
            parts.push(cur.trim());
            cur = '';
        } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

describe('the /r page boundaries', () => {
    it('request modules never import the receiver or report stats', () => {
        const forbidden = [
            'transfer/receiver',
            'createReceiver',
            'reportBytes',
            'useTransferAnalytics',
            'StatsContributionToggle',
            'RelayFallbackToggle',
            'P2PTransfer',
            'api/stats',
            "'join-room'",
            'compatErrorFromIncompatible',
            // Spelled in two pieces so the consumer checker does not count this
            // file as a reader of the wire field.
            ['.', 'reason'].join(''),
            'track(',
            'useSignaling(',
        ];
        const sources = requestSources();
        expect(Object.keys(sources).length).toBeGreaterThan(12);
        for (const [file, src] of Object.entries(sources)) {
            for (const token of forbidden) {
                expect(src.includes(token), `${file} contains ${token}`).toBe(false);
            }
        }
    });

    it('sendAbortReason on /r passes only fixed constants', () => {
        const sources = requestSources();
        const seen = new Set<string>();
        for (const [file, src] of Object.entries(sources)) {
            for (const args of callArgs(src, 'sendAbortReason')) {
                // The import line names the function without calling it.
                const third = splitArgs(args)[2];
                expect(['RELAY_BLOCK_REASON', 'SENDER_UNVERIFIED_REASON', 'VISITOR_CANCEL_REASON'], `${file}: ${args}`).toContain(third);
                seen.add(third);
            }
        }
        // All three aborts exist, so the check above is not vacuous.
        expect([...seen].sort()).toEqual(['RELAY_BLOCK_REASON', 'SENDER_UNVERIFIED_REASON', 'VISITOR_CANCEL_REASON']);
    });

    it('the first-ack timer is the shared ack clock plus its grace', () => {
        expect(FIRST_ACK_TIMEOUT_MS).toBe(REQUEST_ACK_TIMEOUT_MS + REQUEST_ACK_GRACE_MS);
        expect(FIRST_ACK_TIMEOUT_MS).toBe(615000);
        const constants = read('lib/request/constants.ts');
        expect(constants).toContain('REQUEST_ACK_TIMEOUT_MS + REQUEST_ACK_GRACE_MS');
        for (const literal of ['615_000', '615000', '600_000', '600000']) {
            expect(constants.includes(literal), literal).toBe(false);
        }
    });

    it('the visitor sends with the first-ack clock, requireReceived and isDestroyed', () => {
        const visitor = read('components/RequestVisitor.tsx');
        const calls = callArgs(visitor, 'sendFiles');
        expect(calls).toHaveLength(1);
        const args = calls[0];
        expect(args).toContain('ackTimeoutMs: FIRST_ACK_TIMEOUT_MS');
        expect(args).toContain('requireReceived: true');
        expect(args).toContain('keyCheck: ks');
        // No deadline of its own under requireReceived (E-36): isDestroyed is
        // the only way out of a host that neither answers nor closes. The
        // callbacks are built beside the call and passed through watchSend.
        expect(args).toContain('watch.callbacks');
        expect(visitor).toContain('isDestroyed: () => !live()');
    });

    it('the visitor wires its sender callbacks, settle guard and peer through the tested mappers', () => {
        // WP-W1 review F2. The mapping rules are unit tested in senderEvents,
        // sendOutcome and visitorState; these pins make sure the component
        // uses them and adds no mapping of its own. The reviewer's mutation
        // (onDelivered wired to Delivered in the component) fails here.
        const visitor = read('components/RequestVisitor.tsx');
        expect(visitor).toMatch(/watchSend[(]\s*senderEvents[(][{]/);
        for (const own of ['onDelivered', 'onReceived', 'onAllSent:', 'onStopped:', 'onFailed:', "type: 'RECEIVED'"]) {
            expect(visitor.includes(own), own).toBe(false);
        }
        expect(visitor).toContain('afterSettle({ live: live(), reported: watch.reported() })');
        expect(visitor).toContain('new SimplePeer(peerOptionsFor(ice, model.hideIp))');
        expect(visitor.match(/new SimplePeer[(]/g)).toHaveLength(1);
    });

    it('the answering peer reports its own signal, so a sealed seat is known (review 2a L1)', () => {
        const visitor = read('components/RequestVisitor.tsx');
        const handler = visitor.slice(visitor.indexOf("p.on('signal'"));
        const body = handler.slice(0, handler.indexOf("p.on('connect'"));
        expect(body).toContain("socket?.emit('signal'");
        expect(body).toContain("dispatchFor(a, { type: 'SIGNAL_SENT' })");
    });

    it('a reload waits for the Cancel reason to reach the host', () => {
        // WP-W1 review R2-3: the Cancel flush is added to the tracker, and the reload the
        // reducer asks for on a fragment change runs only once it settled.
        const visitor = read('components/RequestVisitor.tsx');
        const cancel = visitor.slice(visitor.indexOf('function cancelWithReason()'));
        expect(cancel.slice(0, cancel.indexOf('VISITOR_CANCEL_REASON'))).toContain('flushes.add(');
        const reload = visitor.slice(visitor.indexOf("case 'reload':"));
        const body = reload.slice(0, reload.indexOf('return;'));
        expect(body).toContain('flushes.settled(');
        expect(body.indexOf('flushes.settled(')).toBeLessThan(body.indexOf('window.location.reload()'));
    });

    it('no Send or Try again starts while a fragment reload is pending', () => {
        // WP-W1 review R3-1: while the reload waits for a Cancel flush the
        // page still shows Ready, and a Send there would join the old room.
        const visitor = read('components/RequestVisitor.tsx');
        const reload = visitor.slice(visitor.indexOf("case 'reload':"));
        expect(reload.slice(0, reload.indexOf('return;'))).toContain('reloadPending = true;');
        const start = visitor.slice(visitor.indexOf("start(type: 'SEND' | 'TRY_AGAIN'"));
        const body = start.slice(0, start.indexOf('dispatch({'));
        expect(body).toContain('if (reloadPending) return;');
    });

    it('every socket emit on /r is request-join or signal', () => {
        const sources = requestSources();
        const events: string[] = [];
        for (const [file, src] of Object.entries(sources)) {
            for (const args of callArgs(src, '.emit')) {
                const first = splitArgs(args)[0];
                expect(["'request-join'", "'signal'"], `${file}: ${args}`).toContain(first);
                events.push(first);
            }
        }
        expect(events).toContain("'request-join'");
    });

    it('the request files hook only ever sets a notice from visitorCopy', () => {
        // The S1-WEB-02 review's pin from outside the vitest globs: no machine
        // error text and no path can reach the notice line.
        const hook = read('hooks/useRequestFiles.ts');
        const args = callArgs(hook, 'setNotice').map((a) => a.replace(/\s+/g, ' ').trim());
        expect(args.length).toBeGreaterThan(4);
        for (const a of args) {
            const ok =
                a === 'null' ||
                /^visitorCopy\.\w+$/.test(a) ||
                /^[\w.]+ === '[\w-]+' \? visitorCopy\.\w+ : visitorCopy\.\w+$/.test(a);
            expect(ok, a).toBe(true);
        }
    });

    it('the files hook counts overlapping reads and drops a read that Clear made stale', () => {
        // WP-W1 review F5, pinned from outside the vitest globs; the counting
        // itself is pickTracker.test.ts. A boolean let the first of two drops
        // turn Send back on, and a Clear during a walk was refilled.
        const hook = read('hooks/useRequestFiles.ts');
        const count = (needle: string) => hook.split(needle).length - 1;
        expect(count('setReading(tracker.reading())')).toBe(2);
        expect(count('if (!tracker.current(token)) return;')).toBe(2);
        expect(count('tracker.clear();')).toBe(1);
        expect(count('setReading(false)')).toBe(0);
    });

    it('Sentry breadcrumbs on /r carry counts only, never a path, a name or the link', () => {
        const sources = requestSources();
        let crumbs = 0;
        for (const [file, src] of Object.entries(sources)) {
            for (const args of callArgs(src, 'Sentry.addBreadcrumb')) {
                crumbs++;
                for (const word of ['relativePath', 'name', 'path', 'roomId', 'linkId', 'href', 'location', 'reason', 'key', 'tag']) {
                    expect(args.includes(word), `${file}: ${word} in ${args}`).toBe(false);
                }
            }
            expect(src.includes('captureException'), file).toBe(false);
            expect(src.includes('captureMessage'), file).toBe(false);
        }
        expect(crumbs).toBeGreaterThan(0);
    });

    it('the only storage /r touches is the discard record: two integers under one key', () => {
        // FT-R-DISCARD is the first storage write on /r. One module holds every
        // storage call, and the one value it writes is the counts object under
        // the fixed key, never a name, a path, the link id or the room
        // (lostRecord.test.ts checks the stored bytes; the privacy script
        // r-privacy-check-v4 checks the live page on load).
        //
        // What this pin cannot see (review 1 F8): it is a text match over
        // /r's own sources, so an indirect access (a computed property name)
        // passes it, and it does not follow imports: lib/staleBundle.ts, which
        // is global, also writes sessionStorage on /r after a stale-bundle
        // error. The live backstop is request-link.spec.ts's dump of every
        // stored key and value in Sending.
        const sources = requestSources();
        expect(Object.keys(sources)).toContain('lib/request/lostRecord.ts');
        for (const [file, src] of Object.entries(sources)) {
            if (file === 'lib/request/lostRecord.ts') continue;
            for (const api of ['sessionStorage', 'localStorage', 'indexedDB', 'caches.', 'document.cookie', 'setItem(']) {
                expect(src.includes(api), `${file} contains ${api}`).toBe(false);
            }
        }
        const record = read('lib/request/lostRecord.ts');
        expect(record).toContain("export const LOST_KEY = 'floe:r-lost';");
        expect(callArgs(record, '.setItem').map((a) => a.replace(/\s+/g, ' ').trim())).toEqual([
            'LOST_KEY, JSON.stringify({ v: 1, arrived, total })',
        ]);
        for (const api of ['localStorage', 'indexedDB', 'document.cookie']) {
            expect(record.includes(api), `lostRecord.ts contains ${api}`).toBe(false);
        }
    });

    it('nothing on /r logs to the console', () => {
        for (const [file, src] of Object.entries(requestSources())) {
            expect(/\bconsole\./.test(src), file).toBe(false);
        }
    });

    it('no way off /r is a soft navigation: plain anchors, no next/link, no router', () => {
        // A next/link or a router push keeps the /r document alive. Its
        // in-viewport prefetches send Next-Url: /r/<linkId> to the server, and
        // so to server-side Sentry (CP-QA F3-01); after Back, the tracker the
        // next page loaded into that document reports /r/<linkId> (F3-02). The
        // same hop skips beforeunload, so leaving mid-drop raises no
        // leave-page prompt (F5-02), and it hands the disconnected socket
        // singleton to / (F5-04). A plain anchor is a page load and does none
        // of that; mid-drop it raises the browser's leave-page prompt (spec 07
        // 4.14), as closing the tab does.
        //
        // app/not-found.tsx, which a /r/<id>/<more> URL renders, is not held
        // to this: its Navbar and Footer navigate softly on every page, and on
        // that URL the Umami before-send hook and the server header scrub
        // carry the load.
        const sources = renderedOnRequestPage();
        expect(Object.keys(sources)).toContain('components/InAppBrowserGuard.tsx');
        for (const [file, src] of Object.entries(sources)) {
            expect(/from\s+['"]next\/link['"]/.test(src), `${file} imports next/link`).toBe(false);
            expect(/\buseRouter\b/.test(src), `${file} uses the router`).toBe(false);
        }
        const shell = read('components/request/RequestShell.tsx');
        const footer = shell.slice(shell.indexOf('function RequestFooter'));
        const anchors = footer.match(/<a\b[^>]*>/g) ?? [];
        expect(anchors.map((a) => /href="([^"]*)"/.exec(a)?.[1])).toEqual(['/privacy', '/terms']);
        for (const a of anchors) expect(a, a).toContain('rel="noreferrer"');
    });

    // The owner's decision of 2026-10-14: off floe.one, "Report this link"
    // writes to the address the server's operator set in REQUEST_REPORT_EMAIL,
    // and with none set the page has no such link. The rule itself is
    // report.test.ts. How the setting reaches the page is pinned here, because
    // each step has a wrong neighbor. A fetch for it would be a request before
    // Send, which the privacy spec counts as the page reaching for the network.
    // A NEXT_PUBLIC_ name is inlined at build time, so the published image
    // could never carry an operator's value. And a value handed down unchecked
    // would sit in the served page as it was typed.
    it('the report address comes from one server variable, checked there, and reaches only the mailto', () => {
        const page = read('app/r/[linkId]/page.tsx');
        // Still no props and no generateMetadata, so the link id is never in
        // scope on the server: the setting is the server's own, the same for
        // every link it serves, and it is the only thing read there.
        expect(page).toContain('export default function RequestLinkPage() {');
        expect(page).not.toMatch(/export\s+(?:async\s+)?(?:function|const)\s+generateMetadata\b/);
        expect(page.match(/process\.env\.\w+/g)).toEqual(['process.env.REQUEST_REPORT_EMAIL']);
        expect(page).toContain(
            '<RequestShell reportAddress={configuredReportAddress(process.env.REQUEST_REPORT_EMAIL)} />',
        );

        // Every line of /r that names the prop, comments aside. Read line by
        // line and trimmed, so a CRLF checkout reads the same.
        const uses = (src: string) =>
            src
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => /\breportAddress\b/.test(line) && !/^(?:\/\/|\/?\*|\{\/\*)/.test(line));
        const sources = requestSources();
        const named = Object.entries(sources)
            .filter(([, src]) => uses(src).length > 0)
            .map(([file]) => file);
        expect(named.sort()).toEqual([
            'app/r/[linkId]/page.tsx',
            'components/RequestVisitor.tsx',
            'components/request/RequestShell.tsx',
        ]);
        expect(uses(sources['components/request/RequestShell.tsx'])).toEqual([
            'export function RequestShell({ reportAddress }: { reportAddress: string | null }) {',
            '<RequestVisitor reportAddress={reportAddress} />',
        ]);
        // The one thing the visitor does with it: hand it to report.ts beside
        // the page's own location. It is never drawn, logged or stored.
        const visitor = sources['components/RequestVisitor.tsx'];
        expect(uses(visitor)).toEqual([
            'export function RequestVisitor({ reportAddress }: { reportAddress: string | null }) {',
            'setReportHref(reportMailtoFromLocation(window.location, reportAddress));',
            '}, [reportAddress]);',
        ]);
        expect(callArgs(visitor, 'reportMailtoFromLocation')).toEqual(['window.location, reportAddress']);

        let fetches = 0;
        for (const [file, src] of Object.entries(sources)) {
            // No other /r source reads the environment.
            if (file !== 'app/r/[linkId]/page.tsx') {
                expect(/process\.env\b/.test(src), `${file} reads the environment`).toBe(false);
            }
            // Nothing on /r asks the client's own server for its settings,
            // and the one fetch there is the ICE list's, made after Send.
            expect(src.includes('/api/config'), `${file} asks for the runtime config`).toBe(false);
            for (const args of callArgs(src, 'fetch')) {
                fetches++;
                expect(splitArgs(args)[0], `${file}: fetch(${args})`).toContain('/api/turn-credentials');
            }
            // floe.one's own address is drawn by /privacy and /terms, never
            // by this page.
            if (file !== 'lib/request/report.ts') {
                expect(src.includes('REQUEST_REPORT_ADDRESS'), `${file} names the built-in address`).toBe(false);
            }
        }
        expect(fetches).toBeGreaterThan(0);

        // The link draws its fixed words; the address is in the href alone.
        const link = read('components/request/ReportLink.tsx');
        const anchor = link.slice(link.indexOf('<a'), link.indexOf('</a>'));
        expect(anchor.match(/\{[^{}]*\}/g)).toEqual(['{href}', '{visitorCopy.reportLink}']);
    });

    // The in-app browser notice is one component on two pages, and its advice
    // is right for only one of them: "Chrome or Safari" suits a share link on
    // the home page, and no request link page lists Safari. So /r hands the
    // notice the approved row, and the notice keeps its own sentence as the
    // default for the home page.
    //
    // The title of the box of steps is the second thing /r words for itself.
    // Its sentence recommends a computer, and the steps open the phone's own
    // browser, so on /r the box says it is the other choice. The home page
    // keeps "How to open in your browser", where the sentence and the steps
    // agree.
    it('the in-app browser notice takes its advice and its steps title from the approved copy on /r only', () => {
        expect(read('app/r/[linkId]/page.tsx')).toContain(
            '<InAppBrowserGuard advice={visitorCopy.inAppAdvice} stepsTitle={visitorCopy.inAppStepsTitle}>',
        );
        expect(read('app/page.tsx')).toContain('<InAppBrowserGuard>');
        const guard = read('components/InAppBrowserGuard.tsx');
        expect(guard).toContain("advice = 'Open Floe in Chrome or Safari for the best experience.'");
        expect(guard).toContain('has limited support for file transfers. {advice}');
        expect(guard).toContain("stepsTitle = 'How to open in your browser'");
        // Drawn from the prop and written nowhere else, so /r cannot show both.
        expect(guard).toContain('{stepsTitle}');
        expect(guard.match(/How to open in your browser/g)).toHaveLength(1);
    });
});

// What the /r page does with a link key, read as text. The key lives in one closure of
// the controller, next to the peer. A rule here is one a running page cannot show, because
// what it guards against is silent: a key that reaches a report, a frame that leads the
// proof, a listener that attaches after the first frame, a signal that skips the gate.
// e2e/request-link.spec.ts and e2e/request-privacy.spec.ts drive the real page.
describe('the /r page and the link key', () => {
    // Comments may name what they guard against; the rules are about code.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    const visitor = code(read('components/RequestVisitor.tsx'));
    const state = code(read('lib/request/visitorState.ts'));

    /** From `head` to the brace that closes the block it opens. */
    function block(src: string, head: string): string {
        const at = src.indexOf(head);
        expect(at, head).toBeGreaterThan(-1);
        let depth = 0;
        for (let i = at + head.length - 1; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
        }
        throw new Error(`unbalanced block: ${head}`);
    }

    const controller = block(visitor, 'function createVisitorController(deps: ControllerDeps) {');
    const rendered = visitor.slice(visitor.indexOf('export function RequestVisitor('));
    const buildPeer = block(controller, 'function buildPeer(a: number) {');
    const startSend = block(controller, 'function startSend(a: number) {');
    const signalHandler = block(controller, "on('signal', (data: any) => {");

    describe('where the key is', () => {
        it('the model and its events hold no key: the reducer knows a boolean and no more', () => {
            expect(state).not.toMatch(/\blinkKey\b/);
            expect(state).not.toMatch(/\bLinkKey\b/);
            expect(state).not.toContain("from '../linkKey'");
            const names = new Set(state.match(/\b\w*[Kk]ey\w*\b/g) ?? []);
            expect([...names].sort()).toEqual([
                'armKeyTimer',
                'clearKeyTimer',
                'keyChanged',
                'keyVerified',
                'keyed',
                'sendKeyAbort',
            ]);
            // Every event type it takes names no value of the key's.
            for (const type of ['KEY_CHECK_PASSED', 'KEY_CHECK_FAILED', 'KEY_CHECK_UNAVAILABLE', 'KEY_CHECK_REFUSED']) {
                expect(state).toContain(`{ type: '${type}' }`);
            }
            expect(state).toContain("{ type: 'LINK_OK'; roomId: string; keyed: boolean }");
            expect(state).toContain("{ type: 'HASHCHANGE'; roomId: string | null; keyChanged: boolean }");
        });

        it('it is one closure variable of the controller, with one writer and two readers', () => {
            expect(controller.match(/let linkKey: LinkKey \| null = null;/g)).toHaveLength(1);
            // Past the imports, one of which names the module.
            expect(visitor.slice(visitor.indexOf('type TimerName')).match(/\blinkKey\b/g)).toHaveLength(4);
            expect(controller.match(/\blinkKey\b/g)).toHaveLength(4);
            expect(controller.match(/\blinkKey = /g)).toHaveLength(1);
            // The session, and the comparison at a hash change.
            expect(buildPeer).toContain('key: linkKey,');
            expect(block(controller, 'hashChanged(win: typeof window) {')).toContain('sameLinkKey(');
        });

        it('the page cannot turn it into its characters or its bytes', () => {
            for (const [file, src] of Object.entries(requestSources())) {
                expect(src.includes('linkKeyText'), `${file} names linkKeyText`).toBe(false);
                expect(src.includes('linkKeyBytes'), `${file} names linkKeyBytes`).toBe(false);
            }
        });

        it('only the controller reads the link, from the raw address, all three parts of it', () => {
            for (const [file, src] of Object.entries(requestSources())) {
                if (file === 'components/RequestVisitor.tsx' || file === 'lib/request/requestLink.ts') continue;
                expect(src.includes('parseRequestLink('), `${file} reads the link`).toBe(false);
            }
            const reads = callArgs(visitor, 'parseRequestLink');
            expect(reads).toHaveLength(2);
            expect(callArgs(controller, 'parseRequestLink')).toHaveLength(2);
            for (const args of reads) {
                expect(args).toBe('win.location.pathname, win.location.hash, win.location.search');
            }
            expect(rendered).not.toContain('parseRequestLink');
            expect(rendered).toContain('controller.load(window);');
            expect(rendered).toContain('controller.hashChanged(window)');
        });

        it('a dispatch carries a boolean of it, and never the thing', () => {
            const dispatches = [...callArgs(controller, 'dispatch'), ...callArgs(controller, 'dispatchFor'), ...callArgs(rendered, 'controller.dispatch')];
            expect(dispatches.length).toBeGreaterThan(10);
            for (const args of dispatches) expect(args, args).not.toMatch(/\blinkKey\b/);
            const load = block(controller, 'load(win: typeof window) {');
            expect(load).toContain("keyed: link.key !== null");
            expect(load.match(/link\.key\b/g)).toHaveLength(2);
        });

        it('a socket emit carries none of it', () => {
            for (const [file, src] of Object.entries(requestSources())) {
                for (const args of callArgs(code(src), '.emit')) {
                    expect(args, `${file}: ${args}`).not.toMatch(/\b(?:linkKey|key|ks)\b/);
                }
            }
        });

        it('nothing of it renders', () => {
            expect(rendered).not.toMatch(/\b(?:linkKey|LinkKey|ks)\b/);
        });
    });

    describe('a session is the first thing on the peer', () => {
        it('one, in buildPeer, right after new SimplePeer and ahead of any listener', () => {
            expect(visitor.match(/createKeySession\(/g)).toHaveLength(1);
            expect(buildPeer).toContain('createKeySession({');
            const built = buildPeer.indexOf('new SimplePeer(');
            const session = buildPeer.indexOf('createKeySession({');
            const listener = buildPeer.search(/\bp\.on\(/);
            expect(built).toBeGreaterThan(-1);
            expect(session).toBeGreaterThan(built);
            expect(listener).toBeGreaterThan(session);
            // Nothing awaits between them.
            expect(buildPeer.slice(built, session)).not.toMatch(/\bawait\b/);
        });

        it('with this peer, this file role, the link it read and the mode the lever gives', () => {
            const session = callArgs(buildPeer, 'createKeySession')[0];
            expect(session).toContain('peer: p as unknown as PeerLike,');
            expect(session).toContain("fileRole: 'sender',");
            expect(session).toContain('key: linkKey,');
            expect(session).toContain('roomId: model.roomId as string,');
            expect(session).toContain('mode,');
            expect(session).toContain("reportRole: 'visitor',");
            expect(buildPeer).toContain("const mode = linkKeyMode('request-visitor');");
            expect(visitor.match(/linkKeyMode\(/g)).toHaveLength(1);
        });

        it('its verdict reaches the reducer through the one tested mapping, for this attempt only', () => {
            const session = callArgs(buildPeer, 'createKeySession')[0];
            expect(session).toContain('onVerdict: (verdict) => dispatchFor(a, keyVerdictEvent(verdict, mode)),');
        });

        it('its report is the page\'s one event call, enums only, by one name', () => {
            const session = callArgs(buildPeer, 'createKeySession')[0];
            expect(session).toContain('reportLinkKey(report);');
            expect(callArgs(visitor, 'reportLinkKey')).toEqual(['report']);
            // A refusal for this code ends the attempt at once, when no send is there to read it.
            expect(session).toContain("if (report.outcome === 'peer-refused') dispatchFor(a, { type: 'KEY_CHECK_REFUSED' });");
            // What keeps a key or a peer's value out of it: only the helper calls Sentry.
            for (const [file, src] of Object.entries(requestSources())) {
                if (file === 'components/RequestVisitor.tsx') continue;
                expect(src.includes('reportLinkKey('), file).toBe(false);
            }
            expect(visitor).not.toContain('withScope');
            expect(visitor).not.toContain('Link key check failed');
        });
    });

    describe('nothing goes around the session on a keyed peer', () => {
        it('no raw send and no raw data listener', () => {
            expect(visitor).not.toMatch(/\bp\.send\(/);
            expect(visitor).not.toMatch(/\bp\.on\('data'/);
            expect(visitor).not.toMatch(/\bp\.off\('data'/);
        });

        it('the send takes send and onData from the session, and hands it the check', () => {
            expect(startSend).toContain('(d) => ks.send(d),');
            expect(startSend).toContain('onData: (handler) => ks.onData(handler),');
            const args = callArgs(startSend, 'sendFiles')[0];
            expect(args).toContain('keyCheck: ks');
        });

        it('every abort sends through the session, with its own proof ahead of the words', () => {
            const aborts = callArgs(visitor, 'sendAbortReason');
            expect(aborts).toHaveLength(3);
            for (const args of aborts) expect(splitArgs(args)[0]).toBe('(d) => ks.send(d)');
        });

        it('the abort of a failed check carries the fixed reason and the code, and waits for the wire', () => {
            const abort = block(controller, 'function abortUnverified() {');
            expect(abort).toContain("SENDER_UNVERIFIED_REASON,\n                    'unverified'");
            expect(abort.indexOf('flushes.add(')).toBeGreaterThan(-1);
            expect(abort.indexOf('flushes.add(')).toBeLessThan(abort.indexOf('SENDER_UNVERIFIED_REASON'));
            // Each needle present first: indexOf answers -1 for one that is gone, and -1 is
            // less than anything, so a comparison alone could not fail on what it names.
            expect(abort.indexOf('await sendAbortReason(')).toBeGreaterThan(-1);
            expect(abort.indexOf('await sendAbortReason(')).toBeLessThan(abort.indexOf('p.destroy()'));
            expect(abort.indexOf('closedByUs = p;')).toBeGreaterThan(-1);
            expect(abort.indexOf('closedByUs = p;')).toBeLessThan(abort.indexOf('flushes.add('));
        });

        it('the wait is the shared clock, and its end goes through the session', () => {
            expect(visitor.match(/\bKEY_CHECK_WAIT_MS\b/g)?.length).toBeGreaterThanOrEqual(2);
            const arm = controller.slice(controller.indexOf("case 'armKeyTimer':"));
            const body = arm.slice(0, arm.indexOf('return;\n            }\n'));
            expect(body).toContain("arm('keyCheck', KEY_CHECK_WAIT_MS, () => ks.noteSilent());");
            // No literal for it anywhere in the controller. The render half has its own
            // 15 s, the Waiting countdown's refresh.
            expect(controller).not.toMatch(/\b15[_]?000\b/);
        });

        it('a relay block goes only to a host that proved the key', () => {
            const probe = block(controller, 'async function probeRoute(a: number, p: PeerInstance) {');
            const branch = probe.slice(probe.indexOf("if (verdict.action === 'block-over-limit') {"));
            expect(branch.indexOf('ks.settle(')).toBeGreaterThan(-1);
            expect(branch.indexOf('ks.settle(')).toBeLessThan(branch.indexOf('await sendAbortReason('));
            expect(branch).toContain("if (ks.keyed && ks.mode === 'enforce' &&");
        });

        // No rule above sees a fresh read of the address: they follow linkKey and link.key.
        // Comments are stripped, because several of them name these words to say why not.
        it('the address is read in the two places that parse it, and goes nowhere by itself', () => {
            const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
            const sources = requestSources();
            let hashReads = 0;
            for (const [file, source] of Object.entries(sources)) {
                const code = strip(source);
                hashReads += (code.match(/location\.hash/g) ?? []).length;
                for (const banned of ['location.href', 'document.URL', 'dispatchEvent(', 'postMessage(']) {
                    expect(code.includes(banned), `${file} holds ${banned}`).toBe(false);
                }
            }
            expect(hashReads).toBe(2);
            const parses = strip(sources['components/RequestVisitor.tsx']).match(
                /parseRequestLink\(win\.location\.pathname, win\.location\.hash, win\.location\.search\)/g
            );
            expect(parses).toHaveLength(2);
        });

        it('a proof that lands after the attempt ended sends no relay reason behind it', () => {
            const probe = block(controller, 'async function probeRoute(a: number, p: PeerInstance) {');
            const wait = probe.indexOf('ks.settle(KEY_CHECK_WAIT_MS');
            const asked = probe.indexOf('if (!gate.isLive(a)) return;', wait);
            const said = probe.indexOf('RELAY_BLOCK_REASON');
            expect(wait).toBeGreaterThan(-1);
            expect(asked).toBeGreaterThan(wait);
            expect(said).toBeGreaterThan(asked);
        });

        it('the route probe waits for its own proof to go out, before anything it may send', () => {
            const probe = block(controller, 'async function probeRoute(a: number, p: PeerInstance) {');
            const first = probe.slice(probe.indexOf('{') + 1).trim();
            expect(first.startsWith('const ks = sessionOf(p);')).toBe(true);
            expect(probe.indexOf('await ks.ownKcOut;')).toBeGreaterThan(-1);
            expect(probe.indexOf('await ks.ownKcOut;')).toBeLessThan(probe.indexOf('getStats'));
        });
    });

    describe('every signal goes through the gate', () => {
        it('admitSignal, ahead of p.signal, through the session of that peer', () => {
            const admit = signalHandler.indexOf('admitSignal(sig)');
            const apply = signalHandler.indexOf('p.signal(sig)');
            expect(admit).toBeGreaterThan(-1);
            expect(apply).toBeGreaterThan(admit);
            expect(signalHandler.slice(0, admit)).toContain('keySessionOf(p)');
            expect(signalHandler.slice(admit, apply)).toContain('return;');
        });

        it('one place applies a signal', () => {
            expect(visitor.match(/\.signal\(/g)).toHaveLength(1);
        });
    });

    // The session replays what came early inside the subscribe. PR-3 met this as a
    // ReferenceError on every tampered link: a handler read a const of the caller declared
    // below the subscribe, in its temporal dead zone.
    describe('what a replayed frame can reach is already declared', () => {
        it('the send: everything its callbacks read is ahead of the call that subscribes', () => {
            const at = startSend.indexOf('sendFiles(');
            expect(at).toBeGreaterThan(-1);
            for (const name of ['const watch =', 'const send =', 'const live =']) {
                expect(startSend.indexOf(name), name).toBeGreaterThan(-1);
                expect(startSend.indexOf(name), name).toBeLessThan(at);
            }
            // At this function's own depth: a const inside a later callback is its own.
            expect(startSend.slice(at)).not.toMatch(/\n {8}(?:const|let)\s/);
        });

        it('the session: what its callbacks read is ahead of it', () => {
            const session = buildPeer.indexOf('createKeySession({');
            expect(buildPeer.indexOf('const mode =')).toBeLessThan(session);
            expect(buildPeer.indexOf('peer = p;')).toBeLessThan(session);
        });
    });

    describe('reading the address again', () => {
        it('a hash change names the room and whether the key changed, through one comparison', () => {
            const hash = block(controller, 'hashChanged(win: typeof window) {');
            expect(hash).toContain("type: 'HASHCHANGE'");
            expect(hash).toContain('const keyChanged = !sameLinkKey(');
        });

        it('a key that changed takes the discard record with it, as a changed room does', () => {
            const write = block(controller, 'function dispatch(event: VisitorEvent) {');
            expect(write).toContain("if (event.type === 'HASHCHANGE') fragmentRoom = event.keyChanged ? null : event.roomId;");
        });
    });
});
