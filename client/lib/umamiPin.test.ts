import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UMAMI_BEFORE_SEND, umamiBeforeSend } from './analyticsPath';
import { UMAMI_INTEGRITY, UMAMI_SRC } from './umamiPin';

/**
 * The pin on the Umami tracker.
 *
 * The file is third-party code that runs as first-party script on the page that
 * holds a transfer's link, so what the review read is what has to run. Any byte
 * that moves fails here, and the browser refuses it anyway (integrity). A
 * refresh is deliberate: it re-reads the whole script, renames the file and
 * moves the constants below together. components/UmamiScript.tsx says how.
 *
 * The second half runs the pinned bytes, as serviceWorker.test.ts runs public/sw.js,
 * so what the review claims about them is held by a test and not only by a note.
 */
const VENDOR_DIR = fileURLToPath(new URL('../public/vendor/', import.meta.url));
const FILE_NAME = UMAMI_SRC.replace(/^\/vendor\//, '');
const BYTES = readFileSync(`${VENDOR_DIR}${FILE_NAME}`);
const TRACKER = BYTES.toString('utf8');

/** The reviewed copy's size. It moves only with a new review. */
const REVIEWED_LENGTH = 8575;

describe('the pinned file', () => {
    it('is served from /vendor under a name made of its own hash', () => {
        expect(UMAMI_SRC).toMatch(/^\/vendor\/umami-[0-9a-f]{8}\.js$/);
        const sha256 = createHash('sha256').update(BYTES).digest('hex');
        expect(FILE_NAME).toBe(`umami-${sha256.slice(0, 8)}.js`);
    });

    it('matches the integrity value the browser checks it against', () => {
        const sha384 = createHash('sha384').update(BYTES).digest('base64');
        expect(UMAMI_INTEGRITY).toBe(`sha384-${sha384}`);
    });

    it('is the length the review read', () => {
        expect(BYTES.byteLength).toBe(REVIEWED_LENGTH);
    });

    it('is the only tracker in the folder', () => {
        // A refresh that left the old copy behind would keep serving bytes
        // nobody is checking any more.
        const trackers = readdirSync(VENDOR_DIR).filter((name) => name.toLowerCase().includes('umami'));
        expect(trackers).toEqual([FILE_NAME]);
    });

    it('stays byte for byte on a checkout that converts line endings', () => {
        // Windows Git's autocrlf would rewrite the final LF, which changes the
        // hash, and the browser would then refuse the script without a word.
        const attributes = readFileSync(fileURLToPath(new URL('../../.gitattributes', import.meta.url)), 'utf8');
        expect(attributes).toMatch(/^client\/public\/vendor\/\*\* -text\r?$/m);
    });

    it('holds nothing that loads or writes code, and only the two fetches the review read', () => {
        // Tripwires for a refresh: the first two are what a tracker has no
        // business doing, the rest are the other ways out that the review
        // counted at zero.
        for (const token of [
            'eval(',
            'new Function',
            'import(',
            'importScripts',
            'document.write',
            'innerHTML',
            'createElement',
            'XMLHttpRequest',
            'sendBeacon',
            'WebSocket',
            'postMessage',
            'javascript:',
        ]) {
            expect(TRACKER.includes(token), token).toBe(false);
        }
        expect(TRACKER.match(/fetch\(/g)).toHaveLength(2);
        expect(TRACKER.match(/https?:\/\/[^"`) ,]+/g)?.sort()).toEqual(['https://gateway.umami.is', 'https://localhost']);
    });
});

describe('UmamiScript.tsx', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/UmamiScript.tsx', import.meta.url)), 'utf8');

    it('loads the pinned copy with its integrity and names the collector', () => {
        // Whole code lines, so one commented out with // fails.
        expect(src).toMatch(/^\s+src=\{UMAMI_SRC\}\r?$/m);
        expect(src).toMatch(/^\s+integrity=\{UMAMI_INTEGRITY\}\r?$/m);
        expect(src).toMatch(/^\s+data-host-url="https:\/\/gateway\.umami\.is"\r?$/m);
    });

    it('keeps every setting the review relies on', () => {
        for (const line of [
            /^\s+data-exclude-hash="true"\r?$/m,
            /^\s+data-exclude-search="true"\r?$/m,
            /^\s+data-do-not-track="true"\r?$/m,
            /^\s+data-before-send=\{UMAMI_BEFORE_SEND\}\r?$/m,
            /^\s+strategy="afterInteractive"\r?$/m,
        ]) {
            expect(src).toMatch(line);
        }
        // The two lanes the review read as off, and nothing that widens a send.
        for (const attribute of ['data-errors', 'data-performance', 'data-distinct-id', 'data-tag', 'data-fetch-credentials']) {
            expect(src.includes(attribute), attribute).toBe(false);
        }
    });

    it('says how to refresh the copy', () => {
        expect(src).toContain('To refresh the copy');
    });
});

// The pinned bytes running, with what UmamiScript.tsx puts on the element.
const WEBSITE = '00000000-0000-4000-8000-000000000000';
const KEY = 'AbCdEfGhIjKlMnOpQrStUg';
const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const LINK_ID = 'Ab3dE_f9-xY';
const TITLE = 'Send files - Floe';
const COLLECTOR = 'https://gateway.umami.is/api/send';

interface Sent {
    url: string;
    init: { method: string; credentials: string; headers: Record<string, string>; body: string };
    type: string;
    payload: Record<string, unknown>;
}

interface RunOptions {
    attributes?: Record<string, string | null>;
    referrer?: string;
    doNotTrack?: string;
    disabled?: boolean;
    hook?: unknown;
}

function runTracker(href: string, options: RunOptions = {}) {
    const attributes: Record<string, string | null> = {
        'data-website-id': WEBSITE,
        'data-host-url': 'https://gateway.umami.is',
        'data-exclude-hash': 'true',
        'data-exclude-search': 'true',
        'data-do-not-track': 'true',
        'data-before-send': UMAMI_BEFORE_SEND,
        ...options.attributes,
    };
    const sent: Sent[] = [];
    const fetchMock = vi.fn(async (url: string, init: Sent['init']) => {
        const { type, payload } = JSON.parse(init.body) as { type: string; payload: Record<string, unknown> };
        sent.push({ url, init, type, payload });
        return { json: async () => ({ cache: 'opaque' }) };
    });
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    const fakeWindow: Record<string, unknown> = {
        screen: { width: 1280, height: 720 },
        navigator: { language: 'en-US', doNotTrack: options.doNotTrack },
        location: new URL(href),
        document: {
            currentScript: { getAttribute: (name: string) => attributes[name] ?? null },
            referrer: options.referrer ?? '',
            title: TITLE,
            readyState: 'complete',
            addEventListener: vi.fn(),
        },
        history,
        localStorage: { getItem: (key: string) => (options.disabled && key === 'umami.disabled' ? '1' : null) },
        addEventListener: vi.fn(),
        [UMAMI_BEFORE_SEND]: 'hook' in options ? options.hook : umamiBeforeSend,
    };
    fakeWindow.top = fakeWindow;
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('fetch', fetchMock);
    new Function(TRACKER)();
    return { sent, fakeWindow, history };
}

/** The tracker's sends are a few awaits behind its calls. */
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the pinned bytes, running', () => {
    it('reports a page view of a keyed share link with no key, room, nonce or title', async () => {
        for (const href of [
            `https://www.floe.one/?s=n0nce#k=${KEY}&room=${ROOM}`,
            `https://www.floe.one/#k=${KEY}&room=${ROOM}`,
        ]) {
            const { sent } = runTracker(href);
            await settle();
            expect(sent, href).toHaveLength(1);
            const [view] = sent;
            expect(view.url).toBe(COLLECTOR);
            expect(view.init.method).toBe('POST');
            expect(view.init.credentials).toBe('omit');
            expect(view.type).toBe('event');
            expect(view.payload).toEqual({
                website: WEBSITE,
                screen: '1280x720',
                language: 'en-US',
                hostname: 'www.floe.one',
                url: 'https://www.floe.one/',
                referrer: '',
            });
            const everything = JSON.stringify(view);
            for (const secret of [KEY, ROOM, 'n0nce', TITLE]) {
                expect(everything.includes(secret), secret).toBe(false);
            }
        }
    });

    it('reports no key from a referrer or a history change either', async () => {
        const { sent, history } = runTracker('https://www.floe.one/privacy', {
            referrer: `https://www.floe.one/?s=n0nce#k=${KEY}&room=${ROOM}`,
        });
        await settle();
        expect(sent[0].payload.referrer).toBe('/');
        // The wrapped pushState, as the App Router calls it.
        history.pushState(null, '', `/?s=n0nce#k=${KEY}&room=${ROOM}`);
        await settle(350);
        expect(sent).toHaveLength(2);
        expect(sent[1].payload.url).toBe('https://www.floe.one/');
        expect(sent[1].payload.referrer).toBe('/privacy');
        const everything = JSON.stringify(sent);
        expect(everything.includes(KEY)).toBe(false);
        expect(everything.includes(ROOM)).toBe(false);
    });

    it('sends nothing for a request link, whichever way the document got there', async () => {
        const { sent, history } = runTracker(`https://www.floe.one/r/${LINK_ID}#${ROOM}.${KEY}`);
        await settle();
        expect(sent).toEqual([]);
        history.pushState(null, '', `/r/${LINK_ID}#${ROOM}.${KEY}`);
        await settle(350);
        expect(sent).toEqual([]);
    });

    it('drops the title from a named event too, and keeps its name and data', async () => {
        const { sent, fakeWindow } = runTracker('https://www.floe.one/');
        await settle();
        const umami = fakeWindow.umami as { track: (name: string, data: unknown) => Promise<void> };
        await umami.track('transfer-received', { files: 3 });
        expect(sent).toHaveLength(2);
        expect(sent[1].payload).not.toHaveProperty('title');
        expect(sent[1].payload).toMatchObject({ name: 'transfer-received', data: { files: 3 } });
    });

    it('sends the page title when no hook is there, which is why the hook is installed at module scope', async () => {
        const { sent } = runTracker('https://www.floe.one/', { hook: undefined });
        await settle();
        expect(sent[0].payload.title).toBe(TITLE);
    });

    it('sends nothing when the hook throws', async () => {
        // A send's hook runs outside the tracker's try, so the throw only
        // rejects a promise nobody holds. Swallowed here, as a page ignores it.
        const swallow = () => undefined;
        process.on('unhandledRejection', swallow);
        try {
            const { sent } = runTracker('https://www.floe.one/', {
                hook: () => {
                    throw new Error('hook');
                },
            });
            await settle();
            expect(sent).toEqual([]);
        } finally {
            process.off('unhandledRejection', swallow);
        }
    });

    it('honors Do Not Track and the umami.disabled switch', async () => {
        for (const options of [{ doNotTrack: '1' }, { disabled: true }]) {
            const { sent, fakeWindow } = runTracker('https://www.floe.one/', options);
            await settle();
            expect(sent, JSON.stringify(options)).toEqual([]);
            await (fakeWindow.umami as { track: (name: string) => Promise<void> }).track('x');
            expect(sent, JSON.stringify(options)).toEqual([]);
        }
    });

    it('goes to the collector data-host-url names, trailing slash or not', async () => {
        const { sent } = runTracker('https://www.floe.one/', { attributes: { 'data-host-url': 'https://collector.example/' } });
        await settle();
        expect(sent[0].url).toBe('https://collector.example/api/send');
    });

    it('keeps the error lane off: no page errors are listened to or sent', async () => {
        const { sent, fakeWindow } = runTracker('https://www.floe.one/');
        await settle();
        const added = (fakeWindow.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map(([type]) => type);
        expect(added).toEqual([]);
        const umami = fakeWindow.umami as { captureException: (error: unknown) => Promise<void> };
        await umami.captureException(new Error(`at https://www.floe.one/#k=${KEY}&room=${ROOM}`));
        await settle();
        expect(sent).toHaveLength(1);
        expect(sent[0].type).toBe('event');
    });
});
