import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FOLDER_DROP_REFUSED,
    allReadable,
    dropHasFolder,
    fullLoadTarget,
    mainPageHoldsTab,
    opensMainPage,
    receiveUnderWay,
    unsavedCount,
    type LinkClick,
} from './pageGuards';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SENDER = { isSender: true, deadEnd: false, receiveUnderWay: false, unsaved: 0 } as const;
const RECEIVER = { isSender: false, linkOut: false, sendEnd: 'open', deadEnd: false } as const;

describe('mainPageHoldsTab', () => {
    it('holds nothing before the page knows its role', () => {
        expect(
            mainPageHoldsTab({ isSender: null, linkOut: true, sendEnd: 'open', deadEnd: false, receiveUnderWay: true, unsaved: 3 })
        ).toBe(false);
    });

    it('holds a sending tab from Create until its send ends', () => {
        expect(mainPageHoldsTab({ ...SENDER, linkOut: false, sendEnd: 'open' })).toBe(false);
        expect(mainPageHoldsTab({ ...SENDER, linkOut: true, sendEnd: 'open' })).toBe(true);
        expect(mainPageHoldsTab({ ...SENDER, linkOut: true, sendEnd: 'delivered' })).toBe(false);
        expect(mainPageHoldsTab({ ...SENDER, linkOut: true, sendEnd: 'failed' })).toBe(false);
    });

    // W2-03: the page's own words send the person to reload, so the reload
    // must not ask whether they mean it.
    it('lets a sending tab go at a dead end where the page says to reload', () => {
        expect(mainPageHoldsTab({ ...SENDER, linkOut: true, sendEnd: 'open', deadEnd: true })).toBe(false);
    });

    // W2-02: a received file the person saved is no longer lost with the tab.
    it('holds a receiving tab while a receive is under way', () => {
        expect(mainPageHoldsTab({ ...RECEIVER, receiveUnderWay: true, unsaved: 0 })).toBe(true);
    });

    it('holds a receiving tab while a received file has never been saved', () => {
        expect(mainPageHoldsTab({ ...RECEIVER, receiveUnderWay: false, unsaved: 1 })).toBe(true);
    });

    it('lets a receiving tab go once every file is saved and nothing more is coming', () => {
        expect(mainPageHoldsTab({ ...RECEIVER, receiveUnderWay: false, unsaved: 0 })).toBe(false);
    });
});

describe('receiveUnderWay', () => {
    const live = { linkInvalid: false, senderAbsent: false, ended: false, allArrived: false };

    it('is under way from the join until every announced file has arrived', () => {
        expect(receiveUnderWay(live)).toBe(true);
        expect(receiveUnderWay({ ...live, allArrived: true })).toBe(false);
    });

    it('is not under way once the attempt ended, under the Link Invalid card, or with nobody sending', () => {
        expect(receiveUnderWay({ ...live, ended: true })).toBe(false);
        expect(receiveUnderWay({ ...live, linkInvalid: true })).toBe(false);
        expect(receiveUnderWay({ ...live, senderAbsent: true })).toBe(false);
    });
});

describe('unsavedCount', () => {
    const files = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    it('counts the received files never handed to the browser to save', () => {
        expect(unsavedCount(files, new Set())).toBe(3);
        expect(unsavedCount(files, new Set(['b']))).toBe(2);
        expect(unsavedCount(files, new Set(['a', 'b', 'c']))).toBe(0);
    });

    it('ignores a saved id that is not in the list', () => {
        expect(unsavedCount([{ id: 'a' }], new Set(['gone']))).toBe(1);
    });
});

describe('the receiving page records each save', () => {
    // Nothing mounts these components, so the wiring is read from source.
    it('marks a file saved from its own download link', () => {
        expect(read('../components/ReceivedFilesList.tsx')).toMatch(/onClick=\{\(\) => onSaved\(\[file\.id\]\)\}/);
    });

    it('marks every file Download All hands over, and every file in the ZIP', () => {
        const manager = read('../hooks/useDownloadManager.ts');
        expect(manager).toContain('onSaved?.([file.id]);');
        expect(manager).toContain('onSaved?.(zipped);');
    });
});

describe('the sending page lets go where it says to reload', () => {
    // Every branch whose banner or notice tells the person to reload latches
    // the dead end right beside it.
    it('latches the dead end in each branch that says so', () => {
        const lines = read('../components/P2PTransfer.tsx').split(/\r?\n/);
        const near = (i: number) => lines.slice(Math.max(0, i - 6), i + 8).join('\n');
        const reloadSites = lines.flatMap((l, i) => (/Reload the page, add the files again/.test(l) ? [i] : []));
        // REJOIN_FAILED, the relay-off probe and the relay-blaming peer error.
        expect(reloadSites).toHaveLength(3);
        for (const i of reloadSites) expect(near(i)).toContain('setDeadEnd(true)');
        // The relay limit notice says "Reload the page to send 2 GB or less".
        const blocked = lines.findIndex((l) => l.includes('setRelayBlocked(true)'));
        expect(blocked).toBeGreaterThan(-1);
        expect(near(blocked)).toContain('setDeadEnd(true)');
    });

    it('clears it when a new recipient arrives or the connection comes up', () => {
        const page = read('../components/P2PTransfer.tsx');
        expect(page.match(/setDeadEnd\(false\)/g)?.length).toBe(2);
    });
});

describe('fullLoadTarget', () => {
    const HOME = 'https://floe.one/';
    const click = (over: Partial<LinkClick>): LinkClick => ({
        button: 0,
        modified: false,
        defaultPrevented: false,
        href: 'https://floe.one/download',
        target: '',
        download: false,
        ...over,
    });

    // W2-01: next/link navigates without unloading, so no leave prompt ran.
    it('turns a plain click on an in-app link into a full load', () => {
        expect(fullLoadTarget(click({}), HOME)).toBe('https://floe.one/download');
        expect(fullLoadTarget(click({ href: 'https://floe.one/privacy', target: '_self' }), HOME)).toBe(
            'https://floe.one/privacy'
        );
    });

    it('treats a receiving page and the bare home page as two documents', () => {
        const receiving = 'https://floe.one/?s=ab12cd34#room=00000000-0000-4000-8000-000000000000';
        expect(fullLoadTarget(click({ href: 'https://floe.one/' }), receiving)).toBe('https://floe.one/');
    });

    it('leaves a click alone when it does not leave the page', () => {
        expect(fullLoadTarget(click({ href: 'https://floe.one/#how-it-works' }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ href: HOME }), HOME)).toBeNull();
    });

    it('leaves the browser its own way with a new tab, a save, or a modified click', () => {
        expect(fullLoadTarget(click({ target: '_blank' }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ download: true }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ modified: true }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ button: 1 }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ defaultPrevented: true }), HOME)).toBeNull();
    });

    it('leaves other origins and other schemes alone', () => {
        expect(fullLoadTarget(click({ href: 'https://github.com/jannskiee/floe' }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ href: 'mailto:hello@example.com' }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ href: 'blob:https://floe.one/0b6c1f1e' }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ href: 'javascript:void(0)' }), HOME)).toBeNull();
        expect(fullLoadTarget(click({ href: 'http://[' }), HOME)).toBeNull();
    });
});

describe('opensMainPage', () => {
    it('is true for the main page, with or without an anchor or a query', () => {
        for (const href of ['/', '/#how-it-works', '/?x=1']) expect(opensMainPage(href), href).toBe(true);
    });

    it('is false for every other page and for other sites', () => {
        for (const href of ['/download', '/how-it-works', '/privacy', '/r/abc', 'https://www.floe.one/docs', '']) {
            expect(opensMainPage(href), href).toBe(false);
        }
    });
});

// Back after a soft hop into the main page stayed inside one document, so it
// never reached the leave prompt. Every link into the main page is a plain
// anchor: a next/link to it anywhere in the site brings the bug back.
describe('links into the main page load it in full', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) files.push(path);
        }
    };
    walk(join(root, 'app'));
    walk(join(root, 'components'));

    it('no next/link names the main page', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(/<Link\b[^>]*?\bhref=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{'([^']*)'\}|\{"([^"]*)"\})/g)) {
                const href = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
                if (opensMainPage(href)) offenders.push(`${file}: ${href}`);
            }
        }
        expect(files.length).toBeGreaterThan(10);
        expect(offenders).toEqual([]);
    });

    it('the footer, whose links come from a list, sends the main page through a plain anchor', () => {
        const footer = read('../components/layout/Footer.tsx');
        expect(footer).toContain("{ name: 'Floe', href: '/' }");
        expect(footer).toContain('opensMainPage(link.href)');
    });
});

describe('dropHasFolder', () => {
    const file = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) };
    const folder = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) };

    it('finds a folder among the dropped entries', () => {
        expect(dropHasFolder([file, folder])).toBe(true);
    });

    it('says no when every entry is a file', () => {
        expect(dropHasFolder([file, file])).toBe(false);
    });

    it('cannot tell without the entries API', () => {
        expect(dropHasFolder([{ kind: 'file' }])).toBeNull();
        expect(dropHasFolder(undefined)).toBeNull();
    });

    it('ignores items that are not files, and an entry the browser could not give', () => {
        expect(dropHasFolder([{ kind: 'string', webkitGetAsEntry: () => ({ isDirectory: true }) }, file])).toBe(false);
        expect(dropHasFolder([{ kind: 'file', webkitGetAsEntry: () => null }, file])).toBe(false);
    });

    it('says what the page does with one, in fixed words', () => {
        expect(FOLDER_DROP_REFUSED).toBe('Folders cannot be sent from this page. Add the files inside it, or zip it first.');
    });
});

describe('allReadable', () => {
    it('is true when the first byte of every file reads', async () => {
        expect(await allReadable([new File(['a'], 'a'), new File([], 'empty')])).toBe(true);
    });

    it('is false when one cannot be read, as a dropped folder cannot', async () => {
        const folder = new File([new Uint8Array(4096)], 'photos');
        Object.defineProperty(folder, 'slice', {
            value: () => ({ arrayBuffer: () => Promise.reject(new Error('NotFoundError')) }),
        });
        expect(await allReadable([new File(['a'], 'a'), folder])).toBe(false);
    });
});
