// A UIA helper client over tests/fake-request-dom.mjs, for the UiaDriver
// request link verbs (S1-REL-03a step 5, FU-26): the host view as the real
// helper exposes a Floe window, read through `snapshot` (values:true) and
// driven through `click`, `set-value` and `toggle`, in process and on the fake
// DOM's clock, so no test sleeps and no window exists.
//
// The shapes it keeps from the measured and INFERRED helper facts:
//   - buttons by accessible name, compared without case (the tabs are
//     rendered upper case); the Accept and Decline buttons read disabled
//     while the prompt's 1 s guard holds (aria-disabled), so `click` refuses
//     them with reason `disabled`, as the helper does;
//   - text leaves one per element, the link field an Edit named by its
//     heading (REQUEST LINK) whose value is the full link, the Save to field
//     an Edit whose placeholder is its HelpText (INFERRED: a labeled input
//     takes its Name from the label);
//   - the Settings switches CheckBoxes named by their whole label;
//   - the Link ends options ListItems named by their labels, which a click
//     selects (SelectionItem, INFERRED; the H10 look fixture measured all six
//     options in Chromium's accessibility tree while the select is closed);
//   - G2-F1 (session 166e0836): an Invoke on an exe window that is not the
//     foreground one activates it, and the frontend re-arms the prompt's
//     guard on that focus, so the click that brought the window forward is
//     swallowed. `activates: false` models a window that is already active.
// `idle` scripts GetLastInputInfo for foreground-check (the away guard).
export function fakeRequestUiaClient(h, { activates = true, idle = 600 } = {}) {
    const { dom, views } = h;
    const calls = [];
    const state = { focused: !activates, idle, swallowed: [] };
    const err = (reason, detail) => {
        const e = new Error(`${reason}: ${detail}`);
        e.reason = reason;
        e.detail = detail;
        return e;
    };
    const canon = (name) =>
        views.buttons().find((b) => b.toLowerCase() === String(name).toLowerCase());
    const items = (values) => {
        const out = [];
        let i = 0;
        const add = (item) => out.push({ i: i++, ...item });
        const buttons = views.buttons();
        if (dom.settingsOpen) {
            for (const b of buttons) add({ type: 'Button', name: b === 'Receive' ? 'RECEIVE' : b });
            for (const sw of views.switches()) {
                const item = { type: 'CheckBox', name: sw.name };
                if (sw.disabled) item.enabled = false;
                if (values) item.toggle = sw.on ? 'On' : 'Off';
                add(item);
            }
            return out;
        }
        for (const b of buttons) {
            const item = { type: 'Button', name: b === 'Receive' ? 'RECEIVE' : b };
            if (views.guarded(b)) item.enabled = false;
            add(item);
        }
        for (const t of views.texts()) if (t) add({ type: 'Text', name: t });
        if (views.onRequestView()) {
            for (const input of views.inputs()) {
                const linkField = views.saveToShowing() ? false : true;
                const item = linkField
                    ? { type: 'Edit', name: 'REQUEST LINK' }
                    : { type: 'Edit', name: 'SAVE TO', help: 'Downloads\\Floe' };
                if (values) {
                    item.value = String(input.value ?? '');
                    item.readOnly = linkField;
                }
                add(item);
            }
        }
        return out;
    };
    const client = {
        calls,
        state,
        async request(cmd, params = {}) {
            // [cmd, params, the fake clock at the call]
            calls.push([cmd, { ...params }, h.now()]);
            h.tick();
            switch (cmd) {
                case 'snapshot': {
                    const all = items(Boolean(params.values));
                    return { count: all.length, truncated: false, items: all };
                }
                case 'click': {
                    const option = views
                        .lifetimeOptions()
                        .find((o) => o.toLowerCase() === String(params.name).toLowerCase());
                    if (option) {
                        state.focused = true;
                        views.pickLifetime(option);
                        return { via: 'select', type: 'ListItem', index: 0, count: 1 };
                    }
                    const name = canon(params.name);
                    if (!name) throw err('not-found', `name='${params.name}'`);
                    if (views.guarded(name)) {
                        // The helper refuses a disabled node before any
                        // Invoke, so a refused click never activates.
                        throw err('disabled', `'${name}' is present but disabled`);
                    }
                    if (!state.focused) {
                        state.focused = true;
                        const prompt = name === 'Accept' || name === 'Decline';
                        if (prompt) {
                            views.rearmGuard();
                            state.swallowed.push({ name, t: h.now() });
                            return { via: 'invoke', type: 'Button', index: 0, count: 1 };
                        }
                    }
                    views.click(name);
                    return { via: 'invoke', type: 'Button', index: 0, count: 1 };
                }
                case 'set-value': {
                    if (params.placeholder !== 'Downloads\\Floe' || !views.saveToShowing())
                        throw err('not-found', `no Edit named '${params.placeholder}'`);
                    const before = dom.saveDir;
                    views.setSaveDir(params.value);
                    return { before, after: dom.saveDir, matchedBy: 'help' };
                }
                case 'toggle': {
                    if (!dom.settingsOpen) throw err('not-found', `no CheckBox matching '${params.regex}'`);
                    const rx = new RegExp(params.regex, 'i');
                    const hits = views.switches().filter((s) => rx.test(s.name));
                    if (!hits.length) throw err('not-found', `no CheckBox matching '${params.regex}'`);
                    if (hits.length > 1) throw err('ambiguous', `${hits.length} CheckBoxes`);
                    const sw = hits[0];
                    const before = sw.on;
                    let changed = false;
                    if (before !== Boolean(params.value)) {
                        if (sw.disabled) throw err('disabled', `'${sw.name}' is disabled`);
                        views.setSwitch(sw.key, params.value);
                        changed = true;
                    }
                    const after = views.switches().find((s) => s.key === sw.key).on;
                    return { before, after, changed, name: sw.name };
                }
                case 'foreground-check':
                    // After WM_CLOSE the window is gone, which is how
                    // closeAndWait sees an exit without a pid.
                    if (dom.closed) throw err('not-a-window', 'hwnd 4242');
                    return { foreground: state.focused, foregroundHwnd: 0, idleSeconds: state.idle };
                default:
                    throw err('unknown-cmd', cmd);
            }
        },
        async retry(cmd, params = {}) {
            return client.request(cmd, params);
        },
        async readText(hwnd, re, { controlType = 'Text' } = {}) {
            const all = items(false).filter((x) =>
                controlType === 'any' ? true : x.type === controlType
            );
            return { texts: all.map((x) => x.name).filter((n) => re.test(n)) };
        },
        async foregroundCheck() {
            return client.request('foreground-check', {});
        },
        async capture(hwnd, file) {
            return { path: file, w: 1, h: 1 };
        },
        async closeWindow() {
            dom.closed = true;
            return { posted: true };
        },
        async waitTree() {
            return { ready: true };
        },
        async show() {
            return { wasIconic: false, iconic: false };
        },
        async listMonitors() {
            return { monitors: [], count: 1 };
        },
        async moveWindow() {
            return { moved: true, monitor: 'fake', primary: true, count: 1, stoleFocus: false };
        },
        log() {},
    };
    return client;
}
