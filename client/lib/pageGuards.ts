// What the main page guards, decided here so it can be tested: the component
// itself is mounted by no unit test.
//
// The leave prompt (owner answer 17, A1-B2 and A9-B9). After Create, a reload,
// a closed tab, the Floe wordmark (a full reload by design) or an in-app link
// ended a transfer or discarded received files with no question asked, while
// the request page has held the browser's own prompt since it shipped. The
// main page holds it only while leaving would cost something, so a person who
// is done is never asked:
//   - a sending page from Create until its send ends, except at a dead end
//     where the page's own words say to reload (W2-03);
//   - a receiving page while a receive is under way, or while a received file
//     has never been handed to the browser to save (W2-02). A click on a
//     file's download link, Download All and Download ZIP each count as a
//     save: the page cannot see a Save As dialog that was cancelled, and
//     asking after every finished receive taught people to click through it.
// next/link navigates without unloading the page, so beforeunload never runs
// for it: while the prompt is held, an in-app link becomes a full page load,
// which does (fullLoadTarget, W2-01).
//
// A dropped folder (A8a-B6). The page has no folder send, and the pseudo-file
// Chromium hands over for a folder was added like any file and failed at its
// turn mid-batch, after the files before it had gone. It is refused at the
// drop instead, as the request page refuses one it cannot read.

import type { SendEnd } from './sendSummary';

/** Fixed copy, shown under the drop area. */
export const FOLDER_DROP_REFUSED = 'Folders cannot be sent from this page. Add the files inside it, or zip it first.';

/**
 * Whether leaving the main page now would cost something. A sending page from
 * Create until its send ends: the link is out, and its footer says closing
 * cancels the transfer. Not at a dead end (`deadEnd`), where the page has
 * already told the person to reload. A receiving page while a receive is
 * under way or a received file is unsaved.
 */
export function mainPageHoldsTab(input: {
    isSender: boolean | null;
    linkOut: boolean;
    sendEnd: SendEnd;
    deadEnd: boolean;
    receiveUnderWay: boolean;
    unsaved: number;
}): boolean {
    if (input.isSender === null) return false;
    if (input.isSender) return input.linkOut && input.sendEnd === 'open' && !input.deadEnd;
    return input.receiveUnderWay || input.unsaved > 0;
}

/**
 * Whether a receive is still under way on the receiving page: from the join
 * until the files handed over reach the count the sender announced
 * (`allArrived`, latched at the receiver engine's onAllComplete), unless the
 * attempt ended, the link was refused, or nobody is on the sending side.
 */
export function receiveUnderWay(input: {
    linkInvalid: boolean;
    senderAbsent: boolean;
    ended: boolean;
    allArrived: boolean;
}): boolean {
    if (input.linkInvalid || input.ended || input.allArrived) return false;
    return !input.senderAbsent;
}

/** How many received files have never been handed to the browser to save. */
export function unsavedCount(received: readonly { id: string }[], saved: ReadonlySet<string>): number {
    return received.filter((f) => !saved.has(f.id)).length;
}

/**
 * Whether an in-app address leads to the main page. Every link there is a
 * plain anchor, never next/link, and so is every in-app link the main page
 * renders, with useFullLoadLinks as the net behind them, so it is always a
 * document of its own. A soft hop inside one document was how Back, and Forward after a
 * soft hop back, left it with beforeunload never run, and a link that was
 * out or a received file that was unsaved went with no question. As its own
 * document, Back and Forward unload it and reach the leave prompt above. The
 * Floe wordmark on the main page reloads through window.location for the
 * same reason. pageGuards.test.ts parses every next/link in the site and
 * fails on one whose address this accepts.
 */
export function opensMainPage(href: string): boolean {
    return href === '/' || href.startsWith('/#') || href.startsWith('/?');
}

/** What the click listener knows about a click on a link. */
export interface LinkClick {
    button: number;
    /** Ctrl, Shift, Alt or Meta held: a new tab or window, the browser's own. */
    modified: boolean;
    defaultPrevented: boolean;
    /** The anchor's resolved address (HTMLAnchorElement.href). */
    href: string;
    target: string;
    download: boolean;
}

/** Both URLs of a plain left click on a link that opens in this tab, or null
 *  for any other click, or when either URL does not parse. */
function plainClickUrls(click: LinkClick, here: string): { to: URL; from: URL } | null {
    if (click.defaultPrevented || click.button !== 0 || click.modified || click.download) return null;
    if (click.target !== '' && click.target.toLowerCase() !== '_self') return null;
    try {
        return { to: new URL(click.href, here), from: new URL(here) };
    } catch {
        return null;
    }
}

/**
 * The address to load in full for a click on a link while the leave prompt is
 * held, or null to leave the click to the browser and to Next.js. Only a plain
 * left click on an http(s) link of this origin that opens in this tab and
 * leaves this document: a fragment or the page itself unmounts nothing, and a
 * new tab, a save (a received file's own link is one) or another site never
 * ends this page, or unloads it the browser's own way.
 */
export function fullLoadTarget(click: LinkClick, here: string): string | null {
    const urls = plainClickUrls(click, here);
    if (!urls) return null;
    const { to, from } = urls;
    if (to.protocol !== 'http:' && to.protocol !== 'https:') return null;
    if (to.origin !== from.origin) return null;
    if (to.pathname === from.pathname && to.search === from.search) return null;
    return to.href;
}

/**
 * Whether a click on a link is a plain click to the page itself, with no
 * anchor. A next/link to the page you are on kept the page and went to the
 * top; the main page's links into itself are plain anchors now, which would
 * reload it and drop files that were added but not sent, with no prompt
 * before Create. The main page keeps the old behavior for these.
 */
export function samePageTop(click: LinkClick, here: string): boolean {
    const urls = plainClickUrls(click, here);
    if (!urls) return false;
    const { to, from } = urls;
    if (to.origin !== from.origin) return false;
    return to.pathname === from.pathname && to.search === from.search && to.hash === '';
}

interface ItemLike {
    kind: string;
    webkitGetAsEntry?: () => { isDirectory: boolean } | null;
}

/**
 * Whether a drop carries a folder: true or false when the browser hands out
 * entries, null when it does not (the caller then reads the files instead).
 * Must run during the drop event: the item list is empty after it.
 */
export function dropHasFolder(items: ArrayLike<ItemLike> | null | undefined): boolean | null {
    if (!items) return null;
    let sawEntryApi = false;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
        sawEntryApi = true;
        if (item.webkitGetAsEntry()?.isDirectory) return true;
    }
    return sawEntryApi ? false : null;
}

/** True when the first byte of every file can be read. A folder's
 *  pseudo-file cannot, which tells one apart where entries are missing. */
export async function allReadable(files: readonly File[]): Promise<boolean> {
    for (const file of files) {
        try {
            await file.slice(0, 1).arrayBuffer();
        } catch {
            return false;
        }
    }
    return true;
}
