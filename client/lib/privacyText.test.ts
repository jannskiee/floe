// Sentences of the privacy page that said, or could come to say, more than the
// code does.
//
// vitest cannot import anything under app/, so the page is read as text, the
// way visitorBoundaries.test.ts reads its sources. Each sentence is pinned
// beside the code fact that decides it, so a change to either shows up here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { umamiBeforeSend } from './analyticsPath';
import { keyCheckReport } from './keyCheckReport';
import { TRANSFER_FAILED_REASONS } from './peerErrors';
import { LOST_KEY, recordLost, takeLost } from './request/lostRecord';
import { scrubBreadcrumb } from './scrubUrl';
import { UMAMI_SRC } from './umamiPin';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// One line of text per paragraph, so a sentence the page wraps still matches.
const page = read('../app/privacy/page.tsx').replace(/\s+/g, ' ');

describe('the privacy page: Umami', () => {
    // The page's own list says Umami works out country, region and city from
    // the IP address. A city, a browser and a screen size are not nothing, so
    // "does not collect personally identifiable information" claimed more
    // than that list allows. What Umami's server does is narrower and
    // checkable: it hashes the address with the user agent and a rotating
    // salt into a session id, and writes the id and the location, never the
    // address (the send route of umami-software/umami, read 2026-10-14).
    it('says the address is not kept, and makes no wider claim', () => {
        expect(page).not.toContain('personally identifiable');
        expect(page).toContain(
            'Umami does not use cookies and stores nothing on your device. It does not keep your IP address: the address and your browser signature are hashed with a salt that rotates on a schedule,',
        );
        // The list item the sentence has to agree with.
        expect(page).toContain('approximate location (country, region, and city), derived from your IP address by Umami');
    });
});

describe('the privacy page: what Sentry is sent about a transfer', () => {
    // The transfer facts are breadcrumbs and scope data, and the SDK attaches
    // those to every event it sends, a performance trace included
    // (applyBreadcrumbsToEvent in @sentry/core has no event-type check). So
    // "at the time of an error" left out the 10% of page loads and page
    // changes that are traced.
    it('names the performance trace beside the error report', () => {
        expect(page).not.toContain('total size at the time of an error');
        expect(page).toContain(
            'Connection type (direct or relay), whether relay fallback was on, transfer progress, file count, and total size, sent with an error report or with a page performance trace that falls in the 10% sample',
        );
    });

    // The sample the sentence names is the one the page promises above it and
    // the one every runtime uses.
    it('agrees with the sample rate the page states and the code sets', () => {
        expect(page).toContain('a 10% sample of page performance traces');
        expect(read('./traceSampling.ts')).toContain('export const TRACES_SAMPLE_RATE = 0.1;');
    });
});

describe('the privacy page: the request link page\'s two counts', () => {
    // "it clears them when the drop ends" was true of a page that runs. A tab
    // the browser discarded mid-drop runs nothing, so the counts stay until
    // that tab loads again, where takeLost removes them whatever it finds, or
    // until it closes and its sessionStorage goes with it (A4-09, owner
    // answer 11, approved words).
    it('says how long a discarded tab keeps them', () => {
        expect(page).toContain(
            'It never stores the link, the room, or a file name, and it clears them when the drop ends; if the browser discarded the tab first, they stay in that tab until it loads again or you close it.',
        );
    });

    it('agrees with the record: it stays through a discard and goes at the next load', () => {
        const held = new Map<string, string>();
        const store = {
            getItem: (k: string) => held.get(k) ?? null,
            setItem: (k: string, v: string) => void held.set(k, v),
            removeItem: (k: string) => void held.delete(k),
        };
        recordLost(store, 4, 12);
        // The discard: no code of the page runs, so nothing clears it.
        expect(held.get(LOST_KEY)).toBeDefined();
        // The tab loads again, as Chrome's reload of a discarded tab or not.
        takeLost(store, false);
        expect(held.has(LOST_KEY)).toBe(false);
    });
});

describe('the privacy page: what a failed transfer tells Umami', () => {
    // The page states how many labels there are, and a new one has to change the word.
    it('counts the labels in a word tied to the list', () => {
        const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
        const word = words[TRANSFER_FAILED_REASONS.length];
        expect(word).toBe('ten');
        expect(page).toContain(`your role, one of ${word} fixed labels (for example`);
    });
});

describe('the privacy page: what the link key does', () => {
    // What is checked and what is not, and nothing more (PLAN.md, the honesty rule).
    // The old sentence said no Floe app checks the server and that this is true of
    // every WebRTC application, and neither holds any more.
    it('says a link key catches a swap on a link that carries one', () => {
        expect(page).not.toContain('no Floe app shows a verification code');
        expect(page).not.toContain('every WebRTC application');
        expect(page).toContain(
            'A link made in the web app also carries a random link key in its fragment, which no server receives.',
        );
        expect(page).toContain('So a server that swaps the fingerprints on such a link is caught.');
    });

    it('says where you still trust the server, and that a file name can go ahead of the check', () => {
        expect(page).toContain('A room code, and a link made by the CLI or Floe Desktop, carries no link key yet,');
        expect(page).toContain(
            'and a sender in the browser does not yet refuse a receiver that cannot show the link key, and sends a file&apos;s name and size before that check has finished, so in those cases you are still trusting that server;',
        );
    });

    it('says the fragment holds it, and the signaling server never receives it', () => {
        expect(page).toContain('The link you share carries its room id, and on a link made in the web app a link key, in the URL fragment');
        expect(page).toContain('Our signaling server never receives the link key,');
    });
});

describe('the privacy page: the warning a failed check sends', () => {
    // O7: the list item has to name every field the report carries, and the report
    // has to carry nothing else.
    it('names the side, the way the certificate was read, the outcome and the mode, and nothing else goes', () => {
        expect(page).toContain(
            'One warning when a link key check does not pass: which side it was, how the check read the certificate, the outcome, and whether the page was set to stop on it, each a fixed label, with no link, no key, and nothing the other device sent',
        );
        const report = keyCheckReport({ role: 'receiver', path: 'der', outcome: 'bad-tag', mode: 'enforce' });
        expect(Object.keys(report?.tags ?? {}).sort()).toEqual(['linkkey.mode', 'linkkey.outcome', 'linkkey.path', 'linkkey.role']);
        expect(report?.fingerprint).toEqual(['link-key', 'receiver', 'bad-tag', 'der']);
    });

    it('says the link key is stripped with the room link', () => {
        expect(page).toContain('The room link, its link key included, is stripped from every error report,');
    });
});

describe('the privacy page: a request link and the link key', () => {
    // W2 and T6-3: what the /r page now does with a link that holds one. The sentence says
    // "a request link that carries one", because no released Floe Desktop makes such a link
    // yet, which the sentence above it still says (decision D12).
    it('names the shape, and calls the part after the # a room id', () => {
        expect(page).not.toContain('#&lt;key&gt;');
        expect(page).toContain('A request link looks like <InlineCode>floe.one/r/&lt;link id&gt;#&lt;room id&gt;</InlineCode>');
        expect(page).toContain('The room id after the <InlineCode>#</InlineCode> works like a share link&apos;s and stays out of logs the same way.');
        expect(page).toContain('it names one link without the room id,');
    });

    it('says what the page does with a key: keeps it, proves it, and names no file before the proof', () => {
        expect(page).toContain(
            "A request link that carries a link key holds it after the room id, as{' '} <InlineCode>#&lt;room id&gt;.&lt;link key&gt;</InlineCode>.",
        );
        expect(page).toContain(
            'The page keeps it in memory and never sends it to any server. It proves it to the computer that made the link, and it names no file until that computer has proved it back; if that proof does not come, it sends no file and says so.',
        );
    });

    it('says that page sends the one warning, and the report it means is the visitor\'s own', () => {
        expect(page).toContain(
            'Our analytics script does not load on a request link&apos;s page at all, and our error monitoring removes the link id from the address before anything is sent. A link key check that does not pass on that page sends the one warning described under Error monitoring, and nothing else about the check.',
        );
        const report = keyCheckReport({ role: 'visitor', path: 'der', outcome: 'silent', mode: 'enforce' });
        expect(report?.tags['linkkey.role']).toBe('visitor');
        expect(Object.keys(report?.tags ?? {}).sort()).toEqual(['linkkey.mode', 'linkkey.outcome', 'linkkey.path', 'linkkey.role']);
    });

    it('still says a link Floe Desktop makes carries no key yet', () => {
        expect(page).toContain('A room code, and a link made by the CLI or Floe Desktop, carries no link key yet,');
    });
});

describe('the privacy page: the tracker', () => {
    it('says floe.one serves a copy the browser checks, and the component loads exactly that', () => {
        expect(page).toContain(
            'The script that does this does not load from Umami. floe.one serves its own copy of it, which we read through before using, and your browser refuses to run that copy if any of its bytes have changed.',
        );
        const component = read('../components/UmamiScript.tsx');
        expect(component).toMatch(/^\s+src=\{UMAMI_SRC\}\r?$/m);
        expect(component).toMatch(/^\s+integrity=\{UMAMI_INTEGRITY\}\r?$/m);
        expect(UMAMI_SRC.startsWith('/vendor/')).toBe(true);
    });

    it('says the page title stays out of everything it sends', () => {
        expect(page).toContain('Floe takes the page title out of everything it sends.');
        expect(umamiBeforeSend('event', { url: 'https://floe.one/', title: 'Send files - Floe' })).toEqual({
            url: 'https://floe.one/',
        });
    });
});

describe('the privacy page: a click in an error report', () => {
    it('says a click is recorded without its label, and the breadcrumb hook holds that', () => {
        expect(page).toContain('A click is recorded without the label of what you clicked,');
        // Sentry does not capture file names: the two labels that hold one.
        for (const label of ['Remove a.pdf', 'Download a.pdf']) {
            const out = scrubBreadcrumb({ category: 'ui.click', message: `button[aria-label="${label}"]` });
            expect(out.message).toBe('button[aria-label]');
        }
    });
});

describe('the privacy page: the cache', () => {
    it('says a stored copy is for when there is no network, and the worker holds that', () => {
        expect(page).toContain('and uses those copies only when it cannot reach the network;');
        // Each answer from the store sits behind a fetch that rejected: nothing
        // asks the store first. Both read the worker's own cache by name, because
        // caches.match would also find a copy planted under another name.
        const worker = read('../public/sw.js').replace(/^\s*\/\/.*$/gm, '');
        const fromStore = '() => caches.open(CACHE_NAME).then((cache) => cache.match(request))';
        expect(worker).not.toMatch(/caches\.match\(/);
        expect(worker.match(/cache\.match\(/g)).toHaveLength(2);
        expect(worker).toContain(`.catch(${fromStore})`);
        expect(worker).toMatch(/\},\s*\(\) => caches\.open\(CACHE_NAME\)\.then\(\(cache\) => cache\.match\(request\)\)\s*\)/);
    });
});
