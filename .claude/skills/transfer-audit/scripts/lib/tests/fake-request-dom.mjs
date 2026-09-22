// A scripted stand-in for the wailsdev page's request link host view, for
// the PlaywrightDriver request verbs (desktop-request.test.mjs). It models
// the host states of spec 06 4.4 as the buttons each one shows (names from
// the frozen copy, REQUEST_STRINGS), the 1 s input guard on the prompt's
// buttons (a click inside it is ignored, as the frontend ignores it), and
// GetRequestLink on window.go.main.App. Time is a fake clock the verbs read
// through `now` and advance through `nap`, so no test sleeps.

export const FAKE_LINK =
    'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

const BUTTONS = {
    ready: ['Settings', 'Receive', 'Request link, beta', 'Make link'],
    waiting: ['Settings', 'Copy link', 'Close link'],
    deciding: ['Settings', 'Accept', 'Decline', 'Close link'],
    declined: ['Settings', 'Keep waiting', 'Close link'],
    receiving: ['Settings', 'Cancel drop'],
    closed: ['Settings', 'Make another link'],
};

export function fakeRequestDom({
    link = FAKE_LINK,
    screenText = undefined,
    guardMs = 1000,
    withBinding = true,
} = {}) {
    const clock = { t: 0 };
    const dom = {
        state: 'ready',
        requestAt: null,
        promptMountedAt: null,
        clicks: [],
        ignored: [],
        reopens: 0,
        picked: [],
    };
    const now = () => clock.t;
    const nap = async (ms) => {
        clock.t += Math.max(1, ms);
    };
    // A visitor's request mounts the prompt at requestAt on the fake clock.
    const tick = () => {
        if (
            dom.state === 'waiting' &&
            dom.requestAt !== null &&
            clock.t >= dom.requestAt
        ) {
            dom.state = 'deciding';
            dom.promptMountedAt = dom.requestAt;
            dom.requestAt = null;
        }
    };
    const visible = (name) => {
        tick();
        return (BUTTONS[dom.state] || []).includes(name);
    };
    const click = (name) => {
        tick();
        if (!visible(name))
            throw new Error(`fake dom: no visible button "${name}"`);
        dom.clicks.push({ name, t: clock.t });
        const guarded =
            dom.state === 'deciding' &&
            (name === 'Accept' || name === 'Decline') &&
            clock.t < dom.promptMountedAt + guardMs;
        if (guarded) {
            dom.ignored.push({ name, t: clock.t });
            return;
        }
        if (dom.state === 'ready' && name === 'Make link') dom.state = 'waiting';
        else if (dom.state === 'deciding' && name === 'Accept')
            dom.state = 'receiving';
        else if (dom.state === 'deciding' && name === 'Decline')
            dom.state = 'declined';
        else if (dom.state === 'declined' && name === 'Keep waiting') {
            dom.reopens += 1;
            dom.state = 'waiting';
        } else if (name === 'Close link') dom.state = 'closed';
    };
    const locator = (name) => {
        const self = {
            first: () => self,
            nth: () => self,
            async isVisible() {
                return visible(name);
            },
            async click() {
                click(name);
            },
        };
        return self;
    };
    const snapshot = () => {
        tick();
        const hasLink = ['waiting', 'deciding', 'declined', 'receiving'].includes(
            dom.state
        );
        return { state: dom.state, link: hasLink ? link : '' };
    };
    const shown = () => {
        tick();
        if (!['waiting', 'deciding', 'declined'].includes(dom.state)) return [];
        if (screenText !== undefined) return screenText ? [screenText] : [];
        return [link.replace(/^https?:\/\//, '')];
    };
    const page = {
        dom,
        getByRole(role, o) {
            if (role !== 'button')
                throw new Error(`fake dom: role ${role} not modeled`);
            return locator(o.name);
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
            globalThis.window = withBinding
                ? { go: { main: { App: { GetRequestLink: async () => snapshot() } } } }
                : {};
            globalThis.document = {
                querySelectorAll: () =>
                    shown().map((t) => ({ textContent: t, contains: () => false })),
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
    };
    return {
        page,
        dom,
        clock,
        now,
        nap,
        /** A visitor asks to send at fake time t (the prompt mounts then). */
        requestAt(t) {
            dom.requestAt = t;
        },
    };
}
