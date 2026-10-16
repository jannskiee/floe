// Three sentences of the privacy page that said more than the code does.
//
// vitest cannot import anything under app/, so the page is read as text, the
// way visitorBoundaries.test.ts reads its sources. Each sentence is pinned
// beside the code fact that decides it, so a change to either shows up here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOST_KEY, recordLost, takeLost } from './request/lostRecord';

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
