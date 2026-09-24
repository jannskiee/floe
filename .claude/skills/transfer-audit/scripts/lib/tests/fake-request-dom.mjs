// A scripted stand-in for the wailsdev page's request link host view, for
// the PlaywrightDriver request verbs (desktop-request.test.mjs) and, through
// tests/fake-request-world.mjs, for the request runner (request.test.mjs).
// It models the host states of spec 06 4.4 as the buttons each one shows
// (names from the frozen copy, REQUEST_STRINGS), the 1 s input guard on the
// prompt's buttons (a click inside it is ignored, as the frontend ignores
// it), the Settings screen with its Hide my IP and Request links switches,
// the Save to field, and the Wails bindings GetSettings, SetSettings,
// SetRequestLinks and GetRequestLink on window.go.main.App. Time is a fake
// clock the verbs read through `now` and advance through `nap`, so no test
// sleeps.
import path from 'node:path';

export const FAKE_ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
export const FAKE_LINK = `http://localhost:3000/r/Xk3p9Q0aB1c#${FAKE_ROOM}`;
export const SAVE_TO = 'Downloads\\Floe requests';
export const VERIFIED_LINE =
    "Every file arrived intact: its SHA-256 matched the sender's.";

// The lane states that show the link block (RequestLinkView.tsx LINK_PHASES)
// and the ones that lock the Beta switch (requestLink.ts HOLDS).
const LINK_STATES = new Set([
    'waiting',
    'reconnecting',
    'connecting',
    'deciding',
    'declined',
]);
const HOLDS = new Set([...LINK_STATES, 'making', 'receiving', 'done', 'stopped']);

const VIEW_BUTTONS = {
    ready: ['Make link'],
    error: ['Make link'],
    waiting: ['Copy link', 'Close link'],
    reconnecting: ['Copy link', 'Close link', 'Retry now'],
    deciding: ['Copy link', 'Accept', 'Decline', 'Close link'],
    declined: ['Copy link', 'Keep waiting', 'Close link'],
    receiving: ['Cancel drop'],
    done: ['Dismiss', 'Make another link'],
    stopped: ['Dismiss', 'Make another link'],
    closed: ['Make another link'],
};

const SWITCHES = [
    {
        key: 'hideIP',
        name: 'Hide my IP address Route every transfer through the relay.',
    },
    {
        key: 'requestLinks',
        name: 'Request links Let someone send files to this PC through a link you make. Works while Floe is open.',
    },
];

/** serverurl.Web for the two addresses the fake knows. */
function webFor(server) {
    const s = String(server || '').replace(/\/+$/, '');
    if (s === '' || s === 'https://api.floe.one') return 'https://floe.one';
    if (s === 'http://localhost:3001') return 'http://localhost:3000';
    return s;
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function fakeRequestDom({
    link = null,
    screenText = undefined,
    guardMs = 1000,
    withBinding = true,
    settings = {},
    featureOn = true,
    saveDirStuck = false,
    betaStuck = false,
    makeError = null,
    // TA-13 shapes: a SetSettings that keeps the old server address, and a
    // host that makes its link on the old address whatever Settings reads.
    addressesStuck = false,
    ignoreServer = false,
    // Release shapes: a Close link or Dismiss click the view ignores, a
    // Close link click that never returns (the teardown budget runs out),
    // and a view that shows the ended link while the lane still reads
    // waiting.
    closeStuck = false,
    dismissStuck = false,
    closeHangs = false,
    laneStaysOpen = false,
} = {}) {
    const clock = { t: 0, waiters: [] };
    const dom = {
        state: 'ready',
        requestAt: null,
        pendingPrompt: null,
        promptMountedAt: null,
        clicks: [],
        ignored: [],
        reopens: 0,
        picked: [],
        settingsOpen: false,
        // App.tsx `mode`: the REQUEST LINK view shows only on Receive, and
        // requestView is its `receiveKind === 'request'`.
        mode: 'receive',
        requestView: false,
        // What App.tsx addFiles staged, and every event the dev server
        // rebroadcast to this page from another one (devPeerPage below).
        staged: [],
        broadcasts: [],
        saveDir: '',
        linkSaveDir: '',
        link: '',
        gen: 0,
        seq: 0,
        promptGen: 0,
        code: '',
        route: '',
        prompt: null,
        result: null,
        blip: null,
        madeWith: null,
        closed: false,
        screenshots: [],
        setSettingsCalls: [],
        featureOn,
        settings: {
            server: 'http://localhost:3001',
            web: '',
            hideIP: false,
            reportStats: false,
            migrated: true,
            requestLinks: true,
            ...settings,
        },
        // Set by tests/fake-request-world.mjs.
        onTick: null,
        onAnswer: null,
    };
    const now = () => clock.t;
    const nap = async (ms) => {
        clock.t += Math.max(1, ms);
        const due = clock.waiters.filter((w) => w.t <= clock.t);
        clock.waiters = clock.waiters.filter((w) => w.t > clock.t);
        for (const w of due) w.resolve();
    };
    const waitUntil = (t) =>
        new Promise((resolve) => {
            if (clock.t >= t) resolve();
            else clock.waiters.push({ t, resolve });
        });
    // Time-driven moves: a visitor's request mounts the prompt at requestAt
    // on the fake clock; a blip holds the link in Reconnecting from its cut
    // until the reclaim; the world finishes a drop on its own schedule.
    const tick = () => {
        if (
            dom.state === 'waiting' &&
            dom.requestAt !== null &&
            clock.t >= dom.requestAt
        ) {
            const p = dom.pendingPrompt || { files: 1, totalBytes: 1 };
            dom.state = 'deciding';
            dom.promptMountedAt = dom.requestAt;
            dom.promptGen += 1;
            dom.prompt = {
                files: p.files,
                totalBytes: p.totalBytes,
                folder: path.join(dom.linkSaveDir || 'C:\\', 'Floe request 1'),
                freeBytes: 1e12,
                warnings: p.warnings || [],
                answerBy: dom.requestAt + 300_000,
            };
            dom.requestAt = null;
        }
        if (dom.blip) {
            const back = dom.blip.until + dom.blip.reclaimMs;
            if (
                dom.state === 'waiting' &&
                clock.t >= dom.blip.from &&
                clock.t < back
            )
                dom.state = 'reconnecting';
            else if (dom.state === 'reconnecting' && clock.t >= back) {
                dom.state = 'waiting';
                dom.blip = null;
            }
        }
        if (dom.onTick) dom.onTick(clock.t);
    };
    const rowOn = () =>
        dom.settings.requestLinks && (dom.featureOn || HOLDS.has(dom.state));
    // Receive > CODE | REQUEST LINK: the row, and the view under it, show
    // only on the Receive tab.
    const onRequestView = () =>
        !dom.settingsOpen && dom.mode === 'receive' && dom.requestView;
    const visibleButtons = () => {
        tick();
        const out = ['Settings', 'Receive'];
        if (dom.settingsOpen || dom.closed) return dom.closed ? [] : out;
        if (dom.mode === 'receive' && rowOn()) {
            out.push('Request link, beta');
            if (dom.requestView) out.push(...(VIEW_BUTTONS[dom.state] || []));
        }
        return out;
    };
    // App.tsx addFiles (the files:open listener): Settings closes and the
    // page moves to Send with the paths staged.
    dom.addFiles = (paths) => {
        dom.settingsOpen = false;
        dom.mode = 'send';
        dom.staged = [...(paths || [])];
    };
    // The host page's own event listeners: EventsOn('files:open', addFiles).
    const ownListeners = (msg) => {
        if (msg && msg.name === 'files:open') dom.addFiles(msg.data?.[0]);
    };
    const visible = (name) => visibleButtons().includes(name);
    const makeLink = () => {
        if (makeError) {
            dom.state = 'error';
            dom.code = makeError;
            return;
        }
        dom.gen += 1;
        dom.code = '';
        dom.route = '';
        dom.result = null;
        dom.linkSaveDir = dom.saveDir.trim();
        dom.madeWith = { ...dom.settings };
        if (ignoreServer) dom.madeWith.server = 'http://localhost:3001';
        const web =
            dom.settings.web || webFor(dom.settings.server || 'http://localhost:3001');
        dom.link = link ?? `${web.replace(/\/+$/, '')}/r/Xk3p9Q0aB1c#${FAKE_ROOM}`;
        dom.state = 'waiting';
    };
    const click = (name) => {
        if (!visible(name))
            throw new Error(`fake dom: no visible button "${name}"`);
        dom.clicks.push({ name, t: clock.t });
        if (name === 'Settings') {
            dom.settingsOpen = !dom.settingsOpen;
            return;
        }
        if (name === 'Receive') {
            // App.tsx: entering Receive shows REQUEST LINK while the lane
            // has something to say, CODE otherwise; staying on it changes
            // nothing.
            if (dom.mode !== 'receive') {
                dom.mode = 'receive';
                dom.requestView = dom.state !== 'ready';
            }
            return;
        }
        if (name === 'Request link, beta') {
            dom.requestView = true;
            return;
        }
        const guarded =
            dom.state === 'deciding' &&
            (name === 'Accept' || name === 'Decline') &&
            clock.t < dom.promptMountedAt + guardMs;
        if (guarded) {
            dom.ignored.push({ name, t: clock.t });
            return;
        }
        if ((dom.state === 'ready' || dom.state === 'error') && name === 'Make link')
            makeLink();
        else if (dom.state === 'deciding' && name === 'Accept') {
            dom.state = 'receiving';
            if (dom.onAnswer) dom.onAnswer('accept');
        } else if (dom.state === 'deciding' && name === 'Decline') {
            dom.state = 'declined';
            dom.prompt = null;
            if (dom.onAnswer) dom.onAnswer('decline');
        } else if (dom.state === 'declined' && name === 'Keep waiting') {
            dom.reopens += 1;
            dom.state = 'waiting';
            if (dom.onAnswer) dom.onAnswer('keep-waiting');
        } else if (name === 'Close link') {
            if (closeStuck) return;
            dom.state = 'closed';
            dom.code = 'closed';
            if (dom.onAnswer) dom.onAnswer('close');
        } else if (name === 'Cancel drop') {
            dom.state = 'stopped';
            dom.code = 'stopped';
        } else if (name === 'Dismiss' && dismissStuck) {
            return;
        } else if (name === 'Dismiss' || name === 'Make another link') {
            dom.state = 'ready';
            dom.result = null;
            dom.code = '';
        }
    };
    const locator = (name) => {
        const self = {
            first: () => self,
            nth: () => self,
            async isVisible() {
                return visible(name);
            },
            async click() {
                if (closeHangs && name === 'Close link') return new Promise(() => {});
                click(name);
            },
            async waitFor() {
                if (!visible(name))
                    throw new Error(`fake dom: "${name}" never showed`);
            },
        };
        return self;
    };
    const snapshot = () => {
        tick();
        const hasLink = [...LINK_STATES, 'receiving'].includes(dom.state);
        dom.seq += 1;
        return {
            state:
                dom.state === 'closed'
                    ? laneStaysOpen
                        ? 'waiting'
                        : 'ended'
                    : dom.state,
            code: dom.code,
            gen: dom.gen,
            seq: dom.seq,
            promptGen: dom.promptGen,
            link: hasLink ? dom.link : '',
            label: '',
            saveDir: dom.state === 'ready' ? '' : dom.linkSaveDir,
            expiresAt: 0,
            route: dom.route,
            suggestClose: false,
            ...(dom.state === 'deciding' && dom.prompt ? { prompt: { ...dom.prompt } } : {}),
            ...((dom.state === 'done' || dom.state === 'stopped') && dom.result
                ? { result: { ...dom.result } }
                : {}),
        };
    };
    const node = (textContent) => ({ textContent, contains: () => false });
    // What the page renders as text, roughly one node per <p> or <span>.
    const textNodes = () => {
        tick();
        const pill =
            dom.state === 'receiving'
                ? dom.route === 'relay'
                    ? 'Relay'
                    : dom.route === 'direct'
                      ? 'Direct'
                      : 'Active'
                : 'Ready';
        const out = [pill];
        if (!onRequestView()) return out.map(node);
        switch (dom.state) {
            case 'waiting':
                out.push('Waiting for them to open the link.');
                break;
            case 'reconnecting':
                out.push(
                    'No connection to the Floe server. Floe keeps trying until the link ends at 2:05 PM. Senders see: not connected.'
                );
                break;
            case 'deciding':
                out.push('SOMEONE WANTS TO SEND YOU FILES');
                break;
            case 'declined':
                out.push('You declined. Nothing was saved.');
                break;
            case 'receiving':
                out.push('RECEIVING 1 OF 1');
                break;
            case 'done': {
                const r = dom.result || { saved: 0, files: 0, verified: 0, bytes: 0 };
                out.push(
                    `RECEIVED ${r.saved} ${r.saved === 1 ? 'FILE' : 'FILES'}, ${mb(r.bytes)}`
                );
                const shown =
                    dom.forceVerifiedLine ??
                    (r.files > 0 && r.saved === r.files && r.verified === r.files);
                if (shown) out.push(VERIFIED_LINE);
                out.push('Floe does not scan files for malware.');
                break;
            }
            case 'stopped':
                out.push('DROP STOPPED');
                break;
            case 'closed':
                out.push('Link closed.');
                break;
            default:
                break;
        }
        return out.map(node);
    };
    const inputNodes = () => {
        tick();
        if (!onRequestView()) return [];
        if (LINK_STATES.has(dom.state)) {
            const value = screenText !== undefined ? screenText : dom.link;
            return [{ value, textContent: '', contains: () => false }];
        }
        if (dom.state === 'ready' || dom.state === 'error')
            return [{ value: dom.saveDir, textContent: '', contains: () => false }];
        return [];
    };
    const checkbox = (name) => {
        const sw = SWITCHES.find((s) =>
            name instanceof RegExp ? name.test(s.name) : s.name === name
        );
        if (!sw) throw new Error(`fake dom: no checkbox named ${name}`);
        const disabled = () =>
            sw.key === 'requestLinks' &&
            (betaStuck ||
                HOLDS.has(dom.state) ||
                (!dom.settings.requestLinks && !dom.featureOn));
        return {
            async isChecked() {
                return Boolean(dom.settings[sw.key]);
            },
            locator() {
                return {
                    async click() {
                        if (!dom.settingsOpen)
                            throw new Error(
                                `fake dom: the ${sw.key} switch is on the Settings screen, which is closed`
                            );
                        if (disabled()) return;
                        dom.settings[sw.key] = !dom.settings[sw.key];
                    },
                };
            },
        };
    };
    const page = {
        dom,
        getByRole(role, o) {
            if (role === 'checkbox') return checkbox(o.name);
            if (role !== 'button')
                throw new Error(`fake dom: role ${role} not modeled`);
            return locator(o.name);
        },
        getByPlaceholder(text) {
            if (text !== SAVE_TO)
                throw new Error(`fake dom: placeholder ${text} not modeled`);
            return {
                async fill(v) {
                    if (!onRequestView() || !['ready', 'error'].includes(dom.state))
                        throw new Error('fake dom: the Save to field is not showing');
                    if (!saveDirStuck) dom.saveDir = String(v);
                },
                async inputValue() {
                    return dom.saveDir;
                },
            };
        },
        getByText(text) {
            return {
                async click() {
                    dom.picked.push(text);
                },
            };
        },
        locator(sel) {
            // The lifetime is drawn as options, not a native <select>, so
            // the driver's select branch finds nothing and clicks the text.
            if (sel !== 'select' && sel !== 'option')
                throw new Error(`fake dom: locator ${sel} not modeled`);
            const none = {
                filter: () => none,
                async count() {
                    return 0;
                },
            };
            return none;
        },
        async evaluate(fn, arg) {
            const saved = {
                window: globalThis.window,
                document: globalThis.document,
                hadWindow: 'window' in globalThis,
                hadDocument: 'document' in globalThis,
            };
            const app = {
                GetRequestLink: async () => snapshot(),
                GetSettings: async () => ({ ...dom.settings }),
                SetSettings: async (server, web, hideIP, reportStats) => {
                    dom.setSettingsCalls.push({ server, web, hideIP, reportStats });
                    Object.assign(dom.settings, {
                        server: addressesStuck ? dom.settings.server : server,
                        web,
                        hideIP,
                        reportStats,
                        migrated: true,
                    });
                },
                SetRequestLinks: async (v) => {
                    dom.settings.requestLinks = Boolean(v);
                },
            };
            globalThis.window = withBinding
                ? {
                      go: { main: { App: app } },
                      __floeRoute: null,
                      // This page's own listeners (App.tsx's files:open).
                      runtime: { EventsEmit: (name, ...data) => ownListeners({ name, data }) },
                      wails: { EventsNotify: (json) => ownListeners(JSON.parse(json)) },
                  }
                : {};
            globalThis.document = {
                querySelectorAll: (sel) =>
                    sel === 'input'
                        ? inputNodes()
                        : sel === 'button'
                          ? visibleButtons().map(node)
                          : textNodes(),
            };
            try {
                return await fn(arg);
            } finally {
                if (saved.hadWindow) globalThis.window = saved.window;
                else delete globalThis.window;
                if (saved.hadDocument) globalThis.document = saved.document;
                else delete globalThis.document;
            }
        },
        async screenshot({ path: file } = {}) {
            dom.screenshots.push(file);
            return Buffer.alloc(0);
        },
        isClosed() {
            return dom.closed;
        },
    };
    const context = {
        async close() {
            dom.closed = true;
        },
    };
    /**
     * Another leg's page on the same wails dev server (its own Playwright
     * context), with the two Wails runtime calls a page can make. Wails
     * v2.12.0 devserver.go handleIPCWebSocket hands an `EE` (EventsEmit)
     * message to notifyExcludingSender, which rebroadcasts it to every
     * other connected page: this host page's files:open listener runs
     * addFiles and leaves REQUEST LINK for Send (the first live TA-17 run,
     * 2026-09-24). EventsNotify (runtime/desktop/events.js) reaches the
     * calling page's own listeners and nothing else.
     */
    const devPeerPage = () => {
        const peer = { emitted: [], notified: [] };
        return {
            peer,
            async evaluate(fn, arg) {
                const had = 'window' in globalThis;
                const prev = globalThis.window;
                globalThis.window = {
                    runtime: {
                        EventsEmit: (name, ...data) => {
                            peer.emitted.push({ name, data });
                            dom.broadcasts.push({ name, data });
                            ownListeners({ name, data });
                        },
                    },
                    wails: {
                        EventsNotify: (json) => peer.notified.push(JSON.parse(json)),
                    },
                };
                try {
                    return await fn(arg);
                } finally {
                    if (had) globalThis.window = prev;
                    else delete globalThis.window;
                }
            },
        };
    };
    return {
        page,
        context,
        devPeerPage,
        dom,
        clock,
        now,
        nap,
        waitUntil,
        tick,
        snapshot,
        /** A visitor asks to send at fake time t (the prompt mounts then). */
        requestAt(t, prompt = null) {
            dom.requestAt = t;
            dom.pendingPrompt = prompt;
        },
    };
}
