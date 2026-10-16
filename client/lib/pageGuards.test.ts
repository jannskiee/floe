import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import {
    FOLDER_DROP_REFUSED,
    allReadable,
    dropHasFolder,
    fullLoadTarget,
    mainPageHoldsTab,
    opensMainPage,
    receiveUnderWay,
    samePageTop,
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

describe('samePageTop', () => {
    const HOME = 'https://floe.one/';
    const click = (over: Partial<LinkClick>): LinkClick => ({
        button: 0,
        modified: false,
        defaultPrevented: false,
        href: HOME,
        target: '',
        download: false,
        ...over,
    });

    // A next/link to the page you are on kept the page and went to the top. As
    // a plain anchor it would reload and drop files not yet sent (review N2).
    it('is true for a plain click on a link to this very page', () => {
        expect(samePageTop(click({}), HOME)).toBe(true);
        expect(samePageTop(click({ target: '_self' }), HOME)).toBe(true);
    });

    it('is false for another page, another query, or an anchor on this page', () => {
        expect(samePageTop(click({ href: 'https://floe.one/download' }), HOME)).toBe(false);
        expect(samePageTop(click({ href: 'https://floe.one/' }), 'https://floe.one/?s=ab12cd34#room=x')).toBe(false);
        expect(samePageTop(click({ href: 'https://floe.one/#about' }), HOME)).toBe(false);
    });

    it('leaves the browser its own way with a new tab, a save, a modified click or another site', () => {
        expect(samePageTop(click({ target: '_blank' }), HOME)).toBe(false);
        expect(samePageTop(click({ download: true }), HOME)).toBe(false);
        expect(samePageTop(click({ modified: true }), HOME)).toBe(false);
        expect(samePageTop(click({ button: 1 }), HOME)).toBe(false);
        expect(samePageTop(click({ defaultPrevented: true }), HOME)).toBe(false);
        expect(samePageTop(click({ href: 'https://github.com/' }), HOME)).toBe(false);
        expect(samePageTop(click({ href: 'http://[' }), HOME)).toBe(false);
    });
});

// The main page is a document of its own in both directions, so Back and
// Forward from it always unload it and reach the leave prompt. Into it: every
// link is a plain anchor (opensMainPage). Out of it: every in-app link it
// renders is a plain anchor too, and the page loads any other in-app link in
// full whether or not the prompt is held, so no soft history entry ever sits
// after it (review N1).
describe('the main page is always its own document', () => {
    it('loads every in-app link out of the main page in full, held or not', () => {
        const page = read('../components/P2PTransfer.tsx');
        expect(page).toContain('useFullLoadLinks();');
        expect(page).not.toContain('useFullLoadLinks(holdsTab)');
    });

    it('the footer, whose links come from a list, keeps its link to the main page', () => {
        const footer = read('../components/layout/Footer.tsx');
        expect(footer).toContain("{ name: 'Floe', href: '/' }");
    });

    it('the legal pages\' document switcher names no main-page address', () => {
        const legal = read('../components/legal/LegalShell.tsx');
        const hrefs = [...legal.matchAll(/href: '([^']*)'/g)].map((m) => m[1]);
        expect(hrefs).toEqual(expect.arrayContaining(['/privacy', '/terms']));
        for (const href of hrefs) expect(opensMainPage(href), href).toBe(false);
    });
});

// useFullLoadLinks is added by P2PTransfer, which mounts one effect after
// hydration, and a next/link clicked in that gap was a soft hop: Back and
// Forward then stayed in one document and Forward left a page holding a link
// with no prompt (measured, usePageGuards.ts). A plain anchor loads in full
// before, during and after hydration, so nothing the main page renders may
// import next/link. The walk follows every import, from the root layout and
// the page, through the client's own modules.
describe('nothing the main page renders is a next/link', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const rel = (file: string) => relative(root, file).split(sep).join('/');

    function resolve(from: string, spec: string): string | null {
        const base = spec.startsWith('@/') ? join(root, spec.slice(2)) : join(dirname(from), spec);
        for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
            if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
        return null;
    }

    /** Each client module reachable from `entries`, with the packages it imports. */
    function reach(entries: string[]): Map<string, string[]> {
        const seen = new Map<string, string[]>();
        const queue = entries.map((e) => join(root, e));
        while (queue.length > 0) {
            const file = queue.shift()!;
            if (seen.has(file)) continue;
            const packages: string[] = [];
            seen.set(file, packages);
            for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
                if (fileName.startsWith('.') || fileName.startsWith('@/')) {
                    const next = resolve(file, fileName);
                    if (next) queue.push(next);
                } else {
                    packages.push(fileName);
                }
            }
        }
        return seen;
    }

    const importersOf = (graph: Map<string, string[]>, pkg: string) =>
        [...graph].filter(([, packages]) => packages.includes(pkg)).map(([file]) => rel(file));

    const MAIN_PAGE = ['app/layout.tsx', 'app/page.tsx'];

    it('reaches the components the main page renders', () => {
        const reached = [...reach(MAIN_PAGE).keys()].map(rel);
        expect(reached).toEqual(
            expect.arrayContaining([
                'components/P2PTransfer.tsx',
                'components/layout/Navbar.tsx',
                'components/layout/Footer.tsx',
                'components/landing/DesktopSection.tsx',
                'components/landing/HowItWorksSection.tsx',
                'hooks/usePageGuards.ts',
            ]),
        );
    });

    it('sees a next/link where one is imported', () => {
        expect(importersOf(reach(['app/not-found.tsx']), 'next/link')).toContain('app/not-found.tsx');
    });

    it('finds no next/link in the main page', () => {
        expect(importersOf(reach(MAIN_PAGE), 'next/link')).toEqual([]);
    });
});

// Every next/link in the site, read by the TypeScript parser so props with a
// `>` in them, renamed imports and object addresses are seen (review N3).
// An address that is not a literal passes only where this file checks the
// list it comes from (DYNAMIC_CHECKED).
describe('no next/link leads into the main page', () => {
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
    const rel = (file: string) => relative(root, file).split(sep).join('/');

    const DYNAMIC_CHECKED = new Set(['components/legal/LegalShell.tsx: doc.href']);

    /** Each next/link element's address: the literal (or a template's fixed
     *  start), or null with the expression's text when it cannot be read. */
    function linkAddresses(sourcePath: string, text: string): { href: string | null; text: string }[] {
        const sf = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const names = new Set<string>();
        for (const st of sf.statements) {
            if (
                ts.isImportDeclaration(st) &&
                ts.isStringLiteral(st.moduleSpecifier) &&
                st.moduleSpecifier.text === 'next/link' &&
                st.importClause?.name
            ) {
                names.add(st.importClause.name.text);
            }
        }
        const out: { href: string | null; text: string }[] = [];
        const addressOf = (init: ts.JsxAttributeValue | undefined): { href: string | null; text: string } => {
            if (!init) return { href: null, text: '(no value)' };
            if (ts.isStringLiteral(init)) return { href: init.text, text: init.text };
            if (ts.isJsxExpression(init) && init.expression) {
                const e = init.expression;
                if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { href: e.text, text: e.text };
                if (ts.isTemplateExpression(e) && e.head.text !== '') return { href: e.head.text, text: e.getText(sf) };
                if (ts.isObjectLiteralExpression(e)) {
                    for (const p of e.properties) {
                        if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'pathname' && ts.isStringLiteral(p.initializer)) {
                            return { href: p.initializer.text, text: e.getText(sf) };
                        }
                    }
                }
                return { href: null, text: e.getText(sf) };
            }
            return { href: null, text: init.getText(sf) };
        };
        const visit = (node: ts.Node) => {
            if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && names.has(node.tagName.getText(sf))) {
                for (const prop of node.attributes.properties) {
                    if (ts.isJsxSpreadAttribute(prop)) out.push({ href: null, text: '...' + prop.expression.getText(sf) });
                    else if (prop.name.getText(sf) === 'href') out.push(addressOf(prop.initializer));
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        return out;
    }

    it('sees the spellings a pattern match would miss', () => {
        const sample = `import NextLink from 'next/link';
import Link from 'next/link';
const HOME = '/';
export const A = () => <Link onClick={() => track('home')} href="/">a</Link>;
export const B = () => <Link className="[&>svg]:size-4" href="/">b</Link>;
export const C = () => <Link href={HOME}>c</Link>;
export const D = () => <Link href={{ pathname: '/' }}>d</Link>;
export const E = () => <NextLink href="/">e</NextLink>;
export const F = () => <Link href={\`/#\${'about'}\`}>f</Link>;
export const G = () => <Link href="/download">g</Link>;`;
        const found = linkAddresses('sample.tsx', sample);
        const flagged = found.filter((f) => f.href === null || opensMainPage(f.href));
        expect(found).toHaveLength(7);
        expect(flagged).toHaveLength(6);
    });

    it('finds no next/link whose address opens the main page', () => {
        const offenders: string[] = [];
        for (const file of files) {
            for (const a of linkAddresses(file, readFileSync(file, 'utf8'))) {
                if (a.href !== null && opensMainPage(a.href)) offenders.push(`${rel(file)}: ${a.text}`);
            }
        }
        expect(files.length).toBeGreaterThan(10);
        expect(offenders).toEqual([]);
    });

    it('reads every other next/link address, or checks the list it comes from', () => {
        const unread: string[] = [];
        for (const file of files) {
            for (const a of linkAddresses(file, readFileSync(file, 'utf8'))) {
                if (a.href === null && !DYNAMIC_CHECKED.has(`${rel(file)}: ${a.text}`)) unread.push(`${rel(file)}: ${a.text}`);
            }
        }
        expect(unread).toEqual([]);
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
