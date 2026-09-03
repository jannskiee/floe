/**
 * Test setup for the whole suite.
 *
 * setupFiles runs for EVERY test file, including the pure logic modules that
 * stay on the node environment and have no window to attach to, so everything
 * here is behind a `typeof window` guard.
 *
 * The Wails shims read window.go and window.runtime only INSIDE their exported
 * functions (wailsjs/go/main/App.js, wailsjs/runtime/runtime.js), never at
 * module evaluation. That is what makes a plain object enough: no module
 * mocking, and import order inside a test file does not matter.
 */
import {afterEach, beforeEach, vi} from 'vitest';

/** The Wails event bus and call log a render test drives the app through. */
export interface WailsProbe {
    /** Live listeners by event name. EventsOff deletes; a leaked registration
     *  shows up as a surviving key after unmount. */
    listeners: Map<string, Set<(...args: never[]) => void>>;
    /** Every EventsOn / EventsOff / binding call, in order. The
     *  GetPendingFiles ordering assertion reads this. */
    calls: string[];
    /** Fire a Go event at whatever App.tsx registered for it. */
    emit(name: string, ...args: unknown[]): void;
    /** The native OnFileDrop callback, or null once OnFileDropOff ran. */
    drop: ((x: number, y: number, paths: string[]) => void) | null;
    go: Record<string, ReturnType<typeof vi.fn>>;
}

declare global {
    // eslint-disable-next-line no-var
    var wails: WailsProbe;
}

function installWails() {
    const listeners = new Map<string, Set<(...args: never[]) => void>>();
    const calls: string[] = [];

    // Every binding App.tsx imports. Return shapes match what the caller
    // destructures: anything returning undefined here becomes "Cannot read
    // properties of undefined (reading 'then')" inside an effect, which
    // surfaces as an unrelated-looking failure.
    const go: WailsProbe['go'] = {
        CancelTransfer: vi.fn(async () => {}),
        CheckForUpdate: vi.fn(async () => ({version: ''})),
        ConfirmClose: vi.fn(async () => {}),
        ContextMenuEnabled: vi.fn(async () => true),
        DisableContextMenu: vi.fn(async () => {}),
        EnableContextMenu: vi.fn(async () => {}),
        EngineProtocolVersion: vi.fn(async () => 1),
        GetPendingFiles: vi.fn(async () => {
            calls.push('GetPendingFiles');
            return [] as string[];
        }),
        GetSettings: vi.fn(async () => ({
            server: '',
            web: '',
            hideIP: false,
            reportStats: true,
            noUpdateCheck: false,
            migrated: true,
        })),
        GetVersion: vi.fn(async () => 'dev'),
        IsPackaged: vi.fn(async () => false),
        OpenFile: vi.fn(async () => {}),
        OpenFolder: vi.fn(async () => {}),
        PasteFiles: vi.fn(async () => [] as string[]),
        ReceiveByCode: vi.fn(async () => 'C:\\Users\\test\\Downloads'),
        RevealFile: vi.fn(async () => {}),
        SelectFiles: vi.fn(async () => [] as string[]),
        SelectFolder: vi.fn(async () => ''),
        SetCheckUpdates: vi.fn(async () => {}),
        SetSettings: vi.fn(async () => {}),
        StartSend: vi.fn(async () => {}),
        StartSendText: vi.fn(async () => {}),
        TestServer: vi.fn(async () => ({ok: true, message: 'Connected.'})),
    };

    const probe: WailsProbe = {
        listeners,
        calls,
        go,
        drop: null,
        emit(name, ...args) {
            const set = listeners.get(name);
            if (!set) throw new Error(`no listener registered for "${name}"`);
            for (const fn of [...set]) (fn as (...a: unknown[]) => void)(...args);
        },
    };

    // runtime.js delegates EventsOn to EventsOnMultiple(name, cb, -1), so that
    // is the hook, not EventsOn.
    (window as unknown as {runtime: unknown}).runtime = {
        EventsOnMultiple(name: string, cb: (...args: never[]) => void) {
            calls.push(`on:${name}`);
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(cb);
            return () => listeners.get(name)?.delete(cb);
        },
        EventsOff(name: string, ...more: string[]) {
            for (const n of [name, ...more]) {
                calls.push(`off:${n}`);
                listeners.delete(n);
            }
        },
        EventsOffAll() {
            calls.push('offAll');
            listeners.clear();
        },
        EventsEmit() {},
        OnFileDrop(cb: WailsProbe['drop']) {
            calls.push('onFileDrop');
            probe.drop = cb;
        },
        OnFileDropOff() {
            calls.push('offFileDrop');
            probe.drop = null;
        },
        BrowserOpenURL: vi.fn(),
        Quit: vi.fn(),
        WindowMinimise: vi.fn(),
        WindowToggleMaximise: vi.fn(),
        LogPrint() {},
        LogError() {},
        LogWarning() {},
    };

    (window as unknown as {go: unknown}).go = {main: {App: go}};
    globalThis.wails = probe;

    localStorage.clear();
}

function installDomShims() {
    // The undo bar's onFocus and Tooltip both branch on
    // .matches(':focus-visible'), and the App.tsx call is UNGUARDED and runs on
    // exactly the focus move clearStaged performs. jsdom's selector engine has
    // no focus-visible heuristics and support varies by version, so resolve it
    // to ":focus", which is the keyboard branch these tests are about.
    const realMatches = Element.prototype.matches;
    // The cast is unavoidable: the real signature is a set of type-predicate
    // overloads, and this shim is deliberately not one.
    Element.prototype.matches = function (this: Element, sel: string) {
        if (sel === ':focus-visible') return this === document.activeElement;
        return realMatches.call(this, sel);
    } as typeof Element.prototype.matches;

    // SharePanel and copyAbout both use it; jsdom ships none. Both call sites
    // are try/catch, so this only matters to the tests that assert on a copy.
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {writeText: vi.fn(async () => {})},
    });
}

if (typeof window !== 'undefined') {
    installDomShims();
    beforeEach(installWails);
    afterEach(() => {
        document.body.innerHTML = '';
    });
}
