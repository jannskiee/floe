import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
    scrubBreadcrumb,
    scrubErrorEvent,
    scrubServerErrorEvent,
    scrubServerTransactionEvent,
    scrubSpanJson,
    scrubTransactionEvent,
    scrubUrl,
} from './scrubUrl';
import type { ScrubbableErrorEvent } from './scrubUrl';

describe('scrubUrl', () => {
    it('strips the room id from a fragment (new-style links)', () => {
        const out = scrubUrl('https://floe.one/#room=secret-uuid');
        expect(out).not.toContain('secret-uuid');
        expect(out).not.toContain('#');
        expect(out).toBe('https://floe.one/');
    });

    it('redacts the room id from a query param (old-style links)', () => {
        expect(scrubUrl('https://floe.one/?room=secret-uuid')).toBe(
            'https://floe.one/?room=redacted'
        );
    });

    it('keeps other query params while redacting room', () => {
        const out = scrubUrl('https://floe.one/?room=secret-uuid&foo=1');
        expect(out).not.toContain('secret-uuid');
        expect(out).toContain('foo=1');
    });

    it('handles relative URLs from breadcrumbs', () => {
        expect(scrubUrl('/#room=secret-uuid')).toBe('/');
        expect(scrubUrl('/path?room=secret-uuid')).toBe('/path?room=redacted');
    });

    it('leaves URLs without a room secret untouched', () => {
        expect(scrubUrl('https://floe.one/how-it-works')).toBe(
            'https://floe.one/how-it-works'
        );
    });

    it('passes through nullish values', () => {
        expect(scrubUrl(undefined)).toBeUndefined();
        expect(scrubUrl(null)).toBeUndefined();
    });

    it('never mistakes a host starting with the dummy base for the base itself', () => {
        // The base-strip must match "http://scrub.invalid/", not the bare
        // prefix: this host merely starts with the same characters and must
        // come back intact (still room-scrubbed), not sliced into garbage.
        expect(scrubUrl('http://scrub.invalid.evil.com/path?room=secret-uuid')).toBe(
            'http://scrub.invalid.evil.com/path?room=redacted'
        );
        // The dummy-base strip itself still works for relative inputs.
        expect(scrubUrl('/path?room=secret-uuid')).toBe('/path?room=redacted');
    });
});

describe('scrubUrl on a request link', () => {
    // A request link is /r/<linkId>#<roomId>. The room id in the fragment is a
    // capability and goes with every other fragment; the link id in the path is
    // not a secret, but it names one link and one person's request and has no
    // place in telemetry.
    const LINK_ID = 'Ab3dE_f9-xY';
    const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const REQUEST_LINK = `https://floe.one/r/${LINK_ID}#${ROOM_ID}`;

    it('redacts an absolute /r/<linkId> URL and drops its fragment', () => {
        const out = scrubUrl(REQUEST_LINK);
        expect(out).toBe('https://floe.one/r/redacted');
        expect(out).not.toContain(LINK_ID);
        expect(out).not.toContain(ROOM_ID);
        expect(out).not.toContain('#');
    });

    it('redacts a relative /r/<linkId> path', () => {
        expect(scrubUrl(`/r/${LINK_ID}`)).toBe('/r/redacted');
        expect(scrubUrl(`/r/${LINK_ID}/`)).toBe('/r/redacted/');
        expect(scrubUrl(`/r/${LINK_ID}#${ROOM_ID}`)).toBe('/r/redacted');
    });

    it('redacts /R/<linkId> case-insensitively', () => {
        // Next routes are case-sensitive, so this URL never reaches the page.
        // The scrub still folds case: it runs over strings that arrived from
        // somewhere else, and a redaction that a capital letter defeats is not
        // a redaction.
        expect(scrubUrl(`https://floe.one/R/${LINK_ID}`)).toBe('https://floe.one/r/redacted');
    });

    it('leaves /r alone', () => {
        // There is no id in a bare /r to redact, and rewriting it would make
        // two different pages look like one in telemetry.
        expect(scrubUrl('https://floe.one/r')).toBe('https://floe.one/r');
        expect(scrubUrl('/r')).toBe('/r');
        expect(scrubUrl('/r/')).toBe('/r/');
    });

    it('leaves /rx/abc and /robots.txt alone', () => {
        expect(scrubUrl('https://floe.one/rx/abc')).toBe('https://floe.one/rx/abc');
        expect(scrubUrl('/rx/abc')).toBe('/rx/abc');
        expect(scrubUrl('/robots.txt')).toBe('/robots.txt');
        expect(scrubUrl('/relay')).toBe('/relay');
        expect(scrubUrl('/r-archive')).toBe('/r-archive');
    });

    it('still redacts ?room=', () => {
        // The path redaction must not have displaced the one that was already
        // here: both run, on their own halves of the URL.
        expect(scrubUrl(`/r/${LINK_ID}?room=${ROOM_ID}`)).toBe('/r/redacted?room=redacted');
        expect(scrubUrl(`https://floe.one/?room=${ROOM_ID}`)).toBe(
            'https://floe.one/?room=redacted'
        );
    });

    it('the fallback branch redacts /r/<linkId>', () => {
        // An unterminated IPv6 host makes `new URL` throw even with a base, so
        // this input can only come out of the catch arm. The room redaction has
        // to stay on the query side there and the path redaction on the path
        // side, because that branch has no parsed URL to ask.
        const broken = `https://[/r/${LINK_ID}?room=${ROOM_ID}#${ROOM_ID}`;
        expect(() => new URL(broken, 'http://scrub.invalid')).toThrow();
        const out = scrubUrl(broken);
        expect(out).toBe('https://[/r/redacted?room=redacted');
        expect(out).not.toContain(LINK_ID);
        expect(out).not.toContain(ROOM_ID);
    });

    it('span url.full and http.url on /r are redacted', () => {
        // The browser SDK's HttpContext integration stamps location.href onto
        // the segment span's url.full, so on a visitor page that is the whole
        // request link.
        const event = {
            request: { url: REQUEST_LINK },
            contexts: { trace: { data: { 'url.full': REQUEST_LINK } } },
            spans: [{ data: { 'url.full': REQUEST_LINK, 'http.url': REQUEST_LINK } }],
        };
        const out = scrubTransactionEvent(event);
        const json = JSON.stringify(out);
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(ROOM_ID);
        expect(out.request.url).toBe('https://floe.one/r/redacted');
        expect(out.contexts.trace.data['url.full']).toBe('https://floe.one/r/redacted');
        expect(out.spans[0].data['url.full']).toBe('https://floe.one/r/redacted');
        expect(out.spans[0].data['http.url']).toBe('https://floe.one/r/redacted');
        // The standalone-span path reaches the same scrub.
        const span = { data: { 'url.full': REQUEST_LINK } };
        expect(scrubSpanJson(span).data['url.full']).toBe('https://floe.one/r/redacted');
    });

    it('the transaction name is redacted, parameterized or not', () => {
        // The name is the field Sentry indexes and lists, and it is the one
        // place the id would survive every URL scrub above.
        expect(scrubTransactionEvent({ transaction: `/r/${LINK_ID}` }).transaction).toBe(
            '/r/redacted'
        );

        // Both parameterized forms collapse to the same bucket, deliberately.
        // The Next SDK names a /r pageload /r/:linkId today, from a route
        // manifest it injects by default; this does not depend on that default
        // holding, and it does not try to tell a placeholder from an id. There
        // is one /r route, so one bucket is all the grouping it can offer, and
        // a rule that redacted only today's 11-character id shape would stop
        // covering an id of any other length without anyone noticing.
        expect(scrubTransactionEvent({ transaction: '/r/:linkId' }).transaction).toBe(
            '/r/redacted'
        );
        expect(scrubTransactionEvent({ transaction: '/r/[linkId]' }).transaction).toBe(
            '/r/redacted'
        );

        // Every other route keeps its name, including the bare /r that has no
        // id in it to hide.
        expect(scrubTransactionEvent({ transaction: '/download' }).transaction).toBe('/download');
        expect(scrubTransactionEvent({ transaction: '/r' }).transaction).toBe('/r');
        expect(scrubTransactionEvent({ transaction: '/robots.txt' }).transaction).toBe(
            '/robots.txt'
        );

        // A transaction with no name is left alone rather than coerced into
        // one. Typed rather than a bare {}, so the generic has the field to
        // infer and tsc can see the assertion.
        const nameless: { transaction?: string } = {};
        expect(scrubTransactionEvent(nameless).transaction).toBeUndefined();
    });

    it('breadcrumb from and to on /r are redacted', () => {
        // beforeBreadcrumb in sentry.client.config.ts runs scrubUrl over
        // data.url, data.to and data.from; navigation breadcrumbs carry the
        // last two as paths rather than absolute URLs.
        const data: Record<string, string> = {
            from: `/r/${LINK_ID}`,
            to: `/r/${LINK_ID}#${ROOM_ID}`,
            url: REQUEST_LINK,
        };
        for (const key of ['from', 'to', 'url'] as const) {
            data[key] = scrubUrl(data[key]) ?? '';
        }
        expect(data.from).toBe('/r/redacted');
        expect(data.to).toBe('/r/redacted');
        expect(data.url).toBe('https://floe.one/r/redacted');
        expect(JSON.stringify(data)).not.toContain(LINK_ID);
        expect(JSON.stringify(data)).not.toContain(ROOM_ID);
    });

    it('a /r pageload shaped like the capture carries no link id anywhere', () => {
        // Captured on a production build (CP-UI forced-r-diag.txt): the segment's
        // url.path is the bare /r/<linkId> path, with no '#' and no room=, so
        // neither the URL attributes nor the description rule reached it.
        // browserTracing and the Next router instrumentation write url.path on
        // every pageload and navigation span, and an http.client span names
        // and records any fetch of a /r path the same way.
        const out = scrubTransactionEvent(requestPageload());
        const json = JSON.stringify(out);
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(ROOM_ID);
        expect(out.transaction).toBe('/r/redacted');
        expect(out.request.url).toBe('http://localhost:3000/r/redacted');
        expect(out.contexts.trace.data).toEqual({
            'sentry.op': 'pageload',
            'sentry.source': 'route',
            'url.full': 'http://localhost:3000/r/redacted',
            'url.path': '/r/redacted',
            'url.template': '/r/redacted',
        });
        const fetchSpan = out.spans.find((s) => s.op === 'http.client');
        expect(fetchSpan?.description).toBe('GET /r/redacted?_rsc=1x2y3');
        expect(fetchSpan?.data).toEqual({
            type: 'fetch',
            url: '/r/redacted?_rsc=1x2y3',
            'url.path': '/r/redacted',
            'http.query': '?_rsc=1x2y3',
        });
        for (const span of out.spans.filter((s) => s.op.startsWith('browser.'))) {
            expect(span.description).toBe('http://localhost:3000/r/redacted');
        }
        // A standalone span reaches the same rule.
        const standalone = { description: `GET /r/${LINK_ID}`, data: { 'url.path': `/r/${LINK_ID}` } };
        expect(JSON.stringify(scrubSpanJson(standalone))).not.toContain(LINK_ID);
    });

    it('a pageload anywhere else keeps its paths byte for byte', () => {
        const event = () => ({
            transaction: '/how-it-works',
            request: { url: 'https://www.floe.one/how-it-works' },
            contexts: {
                trace: {
                    data: {
                        'url.full': 'https://www.floe.one/how-it-works',
                        'url.path': '/how-it-works',
                        'url.template': '/how-it-works',
                    },
                },
            },
            spans: [
                {
                    op: 'http.client',
                    description: 'GET /api/stats',
                    data: { url: '/api/stats', 'url.path': '/api/stats' },
                },
                { op: 'resource.other', description: '/robots.txt', data: { 'url.path': '/robots.txt' } },
                { op: 'resource.other', description: '/rx/abc', data: { 'url.path': '/r' } },
                { op: 'custom', description: 'r/abc is not a path', data: { note: 'div.w-1/2 r/x' } },
            ],
        });
        expect(scrubTransactionEvent(event())).toEqual(event());
    });

    it('an error event from /r carries no link id anywhere', () => {
        // Captured on a production build: an error thrown on /r reports its
        // transaction as the raw /r/<linkId> path, and beforeSend scrubbed
        // request.url only. V8 names an inline script's frames after the
        // document URL without its fragment, so a frame on /r carries the path.
        const out = scrubErrorEvent(requestError(`/r/${LINK_ID}`, `http://localhost:3000/r/${LINK_ID}#${ROOM_ID}`));
        const json = JSON.stringify(out);
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(ROOM_ID);
        expect(out.transaction).toBe('/r/redacted');
        expect(out.request.url).toBe('http://localhost:3000/r/redacted');
        const frames = out.exception.values[0].stacktrace.frames;
        expect(frames[0]).toEqual({ ...INLINE_FRAME, filename: 'app:///r/redacted', abs_path: 'app:///r/redacted' });
        expect(frames[1]).toEqual(CHUNK_FRAME);
        // A parameterized name collapses to the same bucket as on a transaction.
        expect(scrubErrorEvent({ transaction: '/r/:linkId' }).transaction).toBe('/r/redacted');
    });

    it('an error event anywhere else is left byte for byte', () => {
        const home = () => requestError('/how-it-works', 'https://www.floe.one/how-it-works', 'app:///how-it-works');
        expect(scrubErrorEvent(home())).toEqual(home());
        const bare = {};
        expect(scrubErrorEvent(bare)).toBe(bare);
        const nameless: { transaction?: string } = {};
        expect(scrubErrorEvent(nameless).transaction).toBeUndefined();
    });

    it('an exception value and the breadcrumbs that quote a share link carry no room id (A4-06)', () => {
        // A third-party or extension script that logs location.href, or
        // socket.io's debug output, puts the link into text the SDK keeps as
        // is: a console breadcrumb's message and arguments, the sentry.event
        // breadcrumb of an earlier error, and an exception's value.
        const link = `https://floe.one/?s=n0nce#room=${ROOM_ID}`;
        const event = {
            exception: { values: [{ type: 'Error', value: `failed to load ${link}` }] },
            breadcrumbs: [
                { category: 'console', message: `page ${link}`, data: { arguments: ['page', link], logger: 'console' } },
                { category: 'sentry.event', message: `Error: failed to load ${link}` },
                { category: 'console', message: `42["join-room","x"] at /r/${LINK_ID}#${ROOM_ID}` },
            ],
        };
        const json = JSON.stringify(scrubErrorEvent(event));
        expect(json).not.toContain(ROOM_ID);
        expect(json).not.toContain(LINK_ID);
        expect(event.exception.values[0].value).toBe('failed to load https://floe.one/?s=n0nce');
        expect(event.breadcrumbs[0].message).toBe('page https://floe.one/?s=n0nce');
        // Text with no link shape stays byte for byte.
        const plain = { exception: { values: [{ value: 'Cannot read properties of null (reading "x")' }] }, breadcrumbs: [{ message: 'div#main clicked' }] };
        expect(scrubErrorEvent(structuredClone(plain))).toEqual(plain);
    });

    it('the browser breadcrumb hook scrubs the message, the URLs and every logged string (A4-06)', () => {
        const crumb = {
            category: 'console',
            message: `href=https://floe.one/#room=${ROOM_ID}`,
            data: {
                url: `/r/${LINK_ID}#${ROOM_ID}`,
                arguments: [`at https://floe.one/r/${LINK_ID}`, { nested: `https://floe.one/r/${LINK_ID}` }] as unknown[],
            },
        };
        const logged = crumb.data.arguments[1];
        const out = scrubBreadcrumb(crumb);
        expect(out.message).not.toContain(ROOM_ID);
        expect(out.data.url).toBe('/r/redacted');
        expect(out.data.arguments[0]).not.toContain(LINK_ID);
        // A logged object is the page's own, live: it is left to the event
        // hooks, which scrub the SDK's normalized copy (W3 R5-01, below).
        expect(out.data.arguments[1]).toBe(logged);
        expect(logged).toEqual({ nested: `https://floe.one/r/${LINK_ID}` });
        const nav = { category: 'navigation', data: { from: '/', to: '/download' } };
        expect(scrubBreadcrumb(structuredClone(nav))).toEqual(nav);
        // The config imports the SDK and cannot load here, so its wiring is read
        // as text: the hook hands every breadcrumb to scrubBreadcrumb whole.
        const src = readFileSync(fileURLToPath(new URL('../sentry.client.config.ts', import.meta.url)), 'utf8');
        expect(src).toMatch(/beforeBreadcrumb\(breadcrumb\) \{\s*return scrubBreadcrumb\(breadcrumb\);\s*\},/);
    });

    it('the browser hook never walks or writes the objects a page logged, and never throws (W3 R5-01)', () => {
        // @sentry/browser hands beforeBreadcrumb the page's own console
        // arguments, live, before the real console call: walking them took a
        // share link in the app's state down to its path, left a deep object
        // without its leaves, and threw on a frozen object or a getter.
        const link = `https://floe.one/?s=n0nce#room=${ROOM_ID}`;
        const state = { link, peer: { a: { b: { c: { d: { e: 1 } } } } } };
        const frozen = Object.freeze({ link });
        const getter = Object.defineProperty({}, 'link', { get: () => link, enumerable: true }) as { link: string };
        const chain: Record<string, unknown> = {};
        let at = chain;
        for (let i = 0; i < 12; i++) {
            const next: Record<string, unknown> = {};
            at.return = next;
            at = next;
        }
        const args: unknown[] = [`page ${link}`, state, frozen, getter, chain];
        const crumb = { category: 'console', level: 'log', message: `page ${link}`, data: { arguments: args, logger: 'console' } };
        let out: typeof crumb | undefined;
        expect(() => {
            out = scrubBreadcrumb(crumb);
        }).not.toThrow();
        expect(state).toEqual({ link, peer: { a: { b: { c: { d: { e: 1 } } } } } });
        expect(frozen.link).toBe(link);
        expect(getter.link).toBe(link);
        let depth = 0;
        for (let x = chain; x.return; x = x.return as Record<string, unknown>) depth++;
        expect(depth).toBe(12);
        expect(args[0]).toBe(`page ${link}`);
        // The breadcrumb's own text is scrubbed; the page's objects ride along as they are.
        expect(out?.message).not.toContain(ROOM_ID);
        expect(out?.data.arguments[0]).not.toContain(ROOM_ID);
        expect(out?.data.arguments[1]).toBe(state);
    });

    it('the event hooks scrub what the browser hook left, on the normalized copy, for errors and transactions (W3 R5-01)', () => {
        const crumb = {
            category: 'console',
            message: 'state',
            data: { arguments: ['state', { nested: `https://floe.one/r/${LINK_ID}#${ROOM_ID}` }], logger: 'console' },
        };
        const live = scrubBreadcrumb(crumb);
        // The SDK attaches a normalized copy of every breadcrumb's data to each
        // event it sends, transactions included (applyScopeDataToEvent).
        const events = [scrubErrorEvent({ breadcrumbs: [structuredClone(live)] }), scrubTransactionEvent({ breadcrumbs: [structuredClone(live)] })];
        for (const event of events) {
            const json = JSON.stringify(event);
            expect(json).not.toContain(ROOM_ID);
            expect(json).not.toContain(LINK_ID);
        }
    });

    it('free text keeps a # that is not a link fragment (W3 R5-04)', () => {
        const texts = [
            'Minified React error #418; visit https://react.dev/errors/418?args[]=text for the full message',
            'Cannot read private member #peer from an object whose class did not declare it',
            'Unexpected token # in JSON at position 0',
        ];
        for (const value of texts) {
            const event = { exception: { values: [{ value }] }, breadcrumbs: [{ category: 'console', message: value }] };
            const out = scrubErrorEvent(event);
            expect(out.exception.values[0].value).toBe(value);
            expect((out.breadcrumbs as { message: string }[])[0].message).toBe(value);
            expect(scrubBreadcrumb({ message: value }).message).toBe(value);
        }
        // A fragment that can hold the room id still goes.
        const event = { exception: { values: [{ value: `bad #room=${ROOM_ID} and #${ROOM_ID}` }] } };
        expect(JSON.stringify(scrubErrorEvent(event))).not.toContain(ROOM_ID);
    });

    it('free text drops a room id after a # inside any token, a quoted selector included (C1-04)', () => {
        // Chromium's own message when a script hands the fragment to
        // querySelector: the token starts with a quote, so it is not URL-shaped,
        // and the /r fragment is a bare room id.
        const value = `Failed to execute 'querySelector' on 'Document': '#${ROOM_ID}' is not a valid selector.`;
        const kept = "Failed to execute 'querySelector' on 'Document': '#redacted' is not a valid selector.";
        const event = { exception: { values: [{ value }] }, breadcrumbs: [{ category: 'console', message: value }] };
        const out = scrubErrorEvent(event);
        expect(out.exception.values[0].value).toBe(kept);
        expect(JSON.stringify(out)).not.toContain(ROOM_ID);
        expect(scrubBreadcrumb({ message: value }).message).toBe(kept);
        expect(scrubBreadcrumb({ message: `(#${ROOM_ID.toUpperCase()})` }).message).toBe('(#redacted)');
        // A selector without a room id comes back as it was.
        const plain = "Failed to execute 'querySelector' on 'Document': '#main-content' is not a valid selector.";
        expect(scrubBreadcrumb({ message: plain }).message).toBe(plain);
    });

    it('free text drops a # token that carries a /r path (C1-05)', () => {
        // A hash route names the link the way /r/<linkId> does. The free-text
        // rule kept these, where the description rule before it made each "/".
        for (const route of [`#/r/${LINK_ID}`, `#r/${LINK_ID}`, `#/%72/${LINK_ID}`, `#%2Fr%2F${LINK_ID}`]) {
            const value = `No route matches ${route} here`;
            const event = { exception: { values: [{ value }] }, breadcrumbs: [{ category: 'console', message: value }] };
            const out = scrubErrorEvent(event);
            expect(out.exception.values[0].value, route).toBe('No route matches / here');
            expect(JSON.stringify(out), route).not.toContain(LINK_ID);
            expect(scrubBreadcrumb({ message: value }).message, route).toBe('No route matches / here');
        }
    });

    it('a fragment-less /r URL wrapped, in a query value or percent-encoded is still redacted', () => {
        // [as written, what it must become]: no producer writes these today
        // (review 3 N1), but each one carries the id past a rule that only
        // looked at a URL-shaped token's path.
        const cases: [string, string][] = [
            [`(https://www.floe.one/r/${LINK_ID})`, '/(https://www.floe.one/r/redacted'],
            [`url=https://www.floe.one/r/${LINK_ID}`, '/url=https://www.floe.one/r/redacted'],
            [`https://www.floe.one/?next=/r/${LINK_ID}`, 'https://www.floe.one/?next=%2Fr%2Fredacted'],
            [`https://www.floe.one/?next=r%2F${LINK_ID}&x=1`, 'https://www.floe.one/?next=r%2Fredacted&x=1'],
            [`https://www.floe.one/?next=%2Fr%2F${LINK_ID}`, 'https://www.floe.one/?next=%2Fr%2Fredacted'],
            [`https://www.floe.one/%72/${LINK_ID}`, 'https://www.floe.one/r/redacted'],
            [`/%72/${LINK_ID}`, '/r/redacted'],
            [`/r%2F${LINK_ID}`, '/r/redacted'],
        ];
        for (const [written, want] of cases) {
            const span = { description: `GET ${written}`, data: { note: written } };
            expect(scrubSpanJson(span), written).toEqual({ description: `GET ${want}`, data: { note: want } });
            if (!written.startsWith('(') && !written.startsWith('url=')) {
                expect(scrubUrl(written), written).toBe(want);
            }
        }
        // The same shapes without a /r segment, and free text, stay byte for byte.
        const untouched = [
            'https://www.floe.one/?next=/how-it-works',
            'https://api.floe.one/socket.io/?EIO=4&transport=polling',
            '/_next/image?url=%2Flogo.png&w=64&q=75',
            '/_next/static/chunks/r3x.js',
            '(https://www.floe.one/download)',
            'hello%2Fr%2Fx',
            'r/abc',
        ];
        for (const value of untouched) {
            const span = { description: value, data: { note: value } };
            expect(scrubSpanJson(span), value).toEqual({ description: value, data: { note: value } });
        }
        expect(scrubUrl('https://www.floe.one/?next=/how-it-works&q=a%20b')).toBe(
            'https://www.floe.one/?next=/how-it-works&q=a%20b'
        );
    });

    it('never throws on an odd error event and returns it unchanged', () => {
        // beforeSend drops an event whose hook throws, so a throw would fail
        // closed, but a scrub has no business losing an error report. The SDK
        // does not emit these shapes; anything else that reaches beforeSend
        // (a third-party event processor, a future SDK) might.
        const shapes: unknown[] = [
            { exception: null },
            { exception: { values: null } },
            { exception: { values: 'nope' } },
            { exception: { values: [null] } },
            { exception: { values: [undefined, 42, 'x', true] } },
            { exception: { values: [{ stacktrace: null }] } },
            { exception: { values: [{ stacktrace: 'nope' }] } },
            { exception: { values: [{ stacktrace: { frames: null } }] } },
            { exception: { values: [{ stacktrace: { frames: 'nope' } }] } },
            { exception: { values: [{ stacktrace: { frames: { 0: { filename: `/r/${LINK_ID}` } } } }] } },
            { exception: { values: [{ stacktrace: { frames: [null, 7, 'x', { filename: 42, abs_path: null }] } }] } },
            { request: null },
            { request: { url: 42 } },
            { transaction: null },
            { transaction: 42 },
        ];
        for (const shape of shapes) {
            const event = shape as ScrubbableErrorEvent;
            const before = structuredClone(shape);
            expect(() => scrubErrorEvent(event), JSON.stringify(shape)).not.toThrow();
            expect(event, JSON.stringify(shape)).toEqual(before);
        }
    });

    // A /r pageload transaction as the capture shows it (ids replaced), plus an
    // http.client span for a fetch of a /r path and one resource span that must
    // stay as it is.
    function requestPageload() {
        const href = `http://localhost:3000/r/${LINK_ID}#${ROOM_ID}`;
        return {
            type: 'transaction',
            transaction: '/r/:linkId',
            request: { url: href, headers: { 'User-Agent': 'Mozilla/5.0' } },
            contexts: {
                trace: {
                    data: {
                        'sentry.op': 'pageload',
                        'sentry.source': 'route',
                        'url.full': href,
                        'url.path': `/r/${LINK_ID}`,
                        'url.template': '/r/:linkId',
                    },
                },
            },
            spans: [
                ...['browser.domContentLoadedEvent', 'browser.loadEvent', 'browser.request', 'browser.response'].map(
                    (op) => ({ op, description: href, data: { 'sentry.op': op } })
                ),
                {
                    op: 'http.client',
                    description: `GET /r/${LINK_ID}?_rsc=1x2y3`,
                    data: {
                        type: 'fetch',
                        url: `/r/${LINK_ID}?_rsc=1x2y3`,
                        'url.path': `/r/${LINK_ID}`,
                        'http.query': '?_rsc=1x2y3',
                    },
                },
                {
                    op: 'resource.script',
                    description: '/_next/static/chunks/0a1b.js',
                    data: { 'sentry.op': 'resource.script' },
                },
            ],
        };
    }

    // An error event as beforeSend receives it, with one frame from an inline
    // script on the page and one from a bundle chunk.
    function requestError(transaction: string, url: string, inlineFrame = `app:///r/${LINK_ID}`) {
        return {
            level: 'error',
            transaction,
            request: { url, headers: { 'User-Agent': 'Mozilla/5.0' } },
            contexts: { trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' } },
            exception: {
                values: [
                    {
                        type: 'Error',
                        value: 'boom',
                        stacktrace: {
                            frames: [
                                { ...INLINE_FRAME, filename: inlineFrame, abs_path: inlineFrame },
                                { ...CHUNK_FRAME },
                            ],
                        },
                    },
                ],
            },
        };
    }
});

const INLINE_FRAME = { function: '?', lineno: 5, colno: 15, in_app: true };

const CHUNK_FRAME = {
    filename: 'app:///_next/static/chunks/0a1b.js',
    abs_path: 'app:///_next/static/chunks/0a1b.js',
    function: 'onClick',
    lineno: 1,
    colno: 2048,
    in_app: true,
};

describe('scrubTransactionEvent', () => {
    const LINK = 'https://www.floe.one/?s=abcd1234#room=secret-uuid';

    it('strips the room id from the transaction request url', () => {
        const event = { type: 'transaction', request: { url: LINK } };
        expect(scrubTransactionEvent(event).request.url).toBe('https://www.floe.one/?s=abcd1234');
    });

    it('scrubs the trace context and every span attribute the SDK writes', () => {
        const event = {
            contexts: { trace: { data: { 'url.full': LINK, 'sentry.op': 'pageload' } } },
            spans: [
                {
                    data: {
                        'url.full': LINK,
                        'http.url': LINK,
                        'http.query': '?room=secret-uuid&x=1',
                        'http.fragment': '#room=secret-uuid',
                    },
                },
                { data: { 'sentry.op': 'ui.react.render', 'http.query': '' } },
            ],
        };
        const out = scrubTransactionEvent(event);
        expect(JSON.stringify(out)).not.toContain('secret-uuid');
        expect(out.contexts.trace.data['url.full']).toBe('https://www.floe.one/?s=abcd1234');
        expect(out.contexts.trace.data['sentry.op']).toBe('pageload');
        expect(out.spans[0].data['http.url']).toBe('https://www.floe.one/?s=abcd1234');
        expect(out.spans[0].data['http.query']).toBe('?room=redacted&x=1');
        expect(out.spans[0].data).not.toHaveProperty('http.fragment');
        expect(out.spans[1].data).toEqual({ 'sentry.op': 'ui.react.render', 'http.query': '' });
    });

    it('returns the same object, tolerates a bare event, and leaves non-strings alone', () => {
        const bare = {};
        expect(scrubTransactionEvent(bare)).toBe(bare);
        const odd = { spans: [{ data: { 'url.full': 42 } }] };
        expect(scrubTransactionEvent(odd).spans[0].data['url.full']).toBe(42);
    });

    it('scrubs the receiver link out of the navigation-timing span descriptions', () => {
        // The shape of a captured pageload on a receiver page: browserTracing
        // names each navigation-timing span after the PerformanceNavigationTiming
        // entry, which is the document URL with its fragment.
        const out = scrubTransactionEvent(pageloadEvent());
        const json = JSON.stringify(out);
        expect(json).not.toContain(ROOM);
        expect(json).not.toContain('#');
        const nav = out.spans.filter((s) => NAV_OPS.includes(s.op));
        expect(nav).toHaveLength(NAV_OPS.length);
        for (const span of nav) expect(span.description).toBe(RECEIVER_SCRUBBED);
        expect(out.transaction).toBe('/');
        expect(out.contexts.trace.data['url.full']).toBe(RECEIVER_SCRUBBED);
        expect(out.request.url).toBe(RECEIVER_SCRUBBED);
        expect(out.measurements).toEqual(pageloadEvent().measurements);
        const loaf = out.spans.find((s) => s.op === 'ui.long-animation-frame');
        expect(loaf?.data).toEqual({ ...LOAF_DATA, ...LOAF_URLS(RECEIVER_SCRUBBED) });
    });

    it('scrubs the page URL out of every other string in span data', () => {
        // Beyond the four URL attributes: a long-animation-frame span's script
        // attributes on a child span, a legacy ?room= referer on the segment
        // (contexts.trace.data), and a string inside an array value. A header
        // attribute is no longer scrubbed but dropped whole (CP-QA F3-01; see
        // the server and edge describe below).
        const event = {
            contexts: {
                trace: {
                    data: {
                        'sentry.op': 'pageload',
                        'http.request.header.referer': `https://www.floe.one/?room=${ROOM}`,
                        'custom.referer': `https://www.floe.one/?room=${ROOM}`,
                    },
                },
            },
            spans: [
                { data: { ...LOAF_DATA, ...LOAF_URLS(RECEIVER) } },
                { data: { 'custom.list': ['plain', RECEIVER, 7] } },
            ],
        };
        const out = scrubTransactionEvent(event);
        expect(JSON.stringify(out)).not.toContain(ROOM);
        expect(out.contexts.trace.data).toEqual({
            'sentry.op': 'pageload',
            'custom.referer': 'https://www.floe.one/?room=redacted',
        });
        expect(out.spans[0].data).toEqual({ ...LOAF_DATA, ...LOAF_URLS(RECEIVER_SCRUBBED) });
        expect(out.spans[1].data).toEqual({ 'custom.list': ['plain', RECEIVER_SCRUBBED, 7] });
    });

    it('leaves span data strings that are not URLs exactly as they were', () => {
        const data = () => ({
            ...LOAF_DATA,
            'browser.script.invoker': 'BUTTON#b.onclick',
            'code.filepath': 'https://cloud.umami.is/script.js',
            'lcp.element': 'body > div#main > img.hero',
            'cls.source.1': 'div#app > section',
            'custom.list': ['TimerHandler:setTimeout', 'bathroom=3', 7],
            ...Object.fromEntries(UNTOUCHED.map((d, i) => [`untouched.${i}`, d])),
        });
        const event = { contexts: { trace: { data: data() } }, spans: [{ data: data() }] };
        const out = scrubTransactionEvent(event);
        expect(out.contexts.trace.data).toEqual(data());
        expect(out.spans[0].data).toEqual(data());
    });

    it('leaves a span description that is not a URL exactly as it was', () => {
        const event = { transaction: '/', spans: UNTOUCHED.map((d) => ({ description: d })) };
        const out = scrubTransactionEvent(event);
        expect(out.spans.map((s) => s.description)).toEqual(UNTOUCHED);
        expect(out.transaction).toBe('/');
        const empty = { spans: [{ data: {} }, { description: '' }] };
        expect(scrubTransactionEvent(empty).spans).toEqual([{ data: {} }, { description: '' }]);
    });

    it('fails closed on a description carrying a fragment or a room query', () => {
        const out = scrubTransactionEvent({ spans: FAIL_CLOSED.map(([d]) => ({ description: d })) });
        expect(out.spans.map((s) => s.description)).toEqual(FAIL_CLOSED.map(([, want]) => want));
        expect(JSON.stringify(out)).not.toContain(ROOM);
    });

    it('scrubs a transaction name that carries the room', () => {
        expect(scrubTransactionEvent({ transaction: RECEIVER }).transaction).toBe(RECEIVER_SCRUBBED);
    });

    it('is idempotent, because beforeSendSpan and beforeSendTransaction both run on a transaction', () => {
        const once = scrubTransactionEvent(pageloadEvent());
        const snapshot = JSON.stringify(once);
        expect(JSON.stringify(scrubTransactionEvent(once))).toBe(snapshot);
        for (const [, want] of FAIL_CLOSED) {
            expect(scrubSpanJson({ description: want, data: { 'code.filepath': want } })).toEqual({
                description: want,
                data: { 'code.filepath': want },
            });
        }
    });
});

describe('scrubSpanJson', () => {
    it('scrubs a standalone span in place', () => {
        const span = { data: { 'url.full': 'https://www.floe.one/#room=secret-uuid' } };
        expect(scrubSpanJson(span)).toBe(span);
        expect(span.data['url.full']).toBe('https://www.floe.one/');
    });

    it('scrubs the receiver link out of a standalone span description', () => {
        for (const op of NAV_OPS) {
            const span = { op, description: RECEIVER, data: { 'sentry.op': op } };
            expect(scrubSpanJson(span)).toBe(span);
            expect(span.description).toBe(RECEIVER_SCRUBBED);
        }
        // A transaction's root span as beforeSendSpan sees it: its description
        // is the transaction name, and HttpContext writes url.full onto it.
        const segment = { is_segment: true, description: RECEIVER, data: { 'url.full': RECEIVER } };
        const json = JSON.stringify(scrubSpanJson(segment));
        expect(json).not.toContain(ROOM);
        expect(json).not.toContain('#');
    });

    it("scrubs the page URL out of a standalone span's other data strings", () => {
        const span = { op: 'ui.long-animation-frame', data: { ...LOAF_DATA, ...LOAF_URLS(RECEIVER) } };
        expect(scrubSpanJson(span).data).toEqual({ ...LOAF_DATA, ...LOAF_URLS(RECEIVER_SCRUBBED) });
        const selector = { data: { ...LOAF_DATA, 'browser.script.invoker': 'BUTTON#b.onclick' } };
        expect(scrubSpanJson(selector).data['browser.script.invoker']).toBe('BUTTON#b.onclick');
    });

    it('leaves a standalone span description that is not a URL exactly as it was', () => {
        for (const description of UNTOUCHED) {
            expect(scrubSpanJson({ description, data: {} }).description).toBe(description);
        }
    });

    it('fails closed on a standalone span description carrying a fragment or a room query', () => {
        for (const [description, want] of FAIL_CLOSED) {
            expect(scrubSpanJson({ description, data: {} }).description).toBe(want);
        }
    });

    it('drops every request and response header attribute', () => {
        // httpHeadersToSpanAttributes writes http.<request|response>.header.<name>
        // for each header it keeps. A header can carry any URL, and the router
        // tree is URL-encoded JSON the string rule cannot read (CP-QA F3-01).
        const span = {
            data: {
                'http.request.method': 'GET',
                'http.request.header.user_agent': 'Mozilla/5.0',
                'http.request.header.next_url': '/r/Ab3dE_f9-xY',
                'http.request.header.next_router_state_tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22r%22',
                'http.response.header.location': '/r/Ab3dE_f9-xY',
                'http.response.status_code': 308,
            },
        };
        expect(scrubSpanJson(span).data).toEqual({ 'http.request.method': 'GET', 'http.response.status_code': 308 });
    });
});

describe('server and edge events', () => {
    // What server-side Sentry sent for a browser on /r, captured on a
    // production build of d0f0c93 with a local sink (CP-QA F3-01 and F3-03,
    // skeptic S2), ids replaced. The dataCollection block (what 10.x made of
    // sendDefaultPii false) drops only the headers that carry an IP address;
    // every other header stays, Cookie included.
    const LINK_ID = 'Ab3dE_f9-xY';
    const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const TREE = () =>
        encodeURIComponent(
            JSON.stringify(['', { children: ['r', { children: [['linkId', LINK_ID, 'd'], { children: ['__PAGE__', {}] }] }] }, null, null, true])
        );

    /** The transaction of one footer prefetch (or click) from /r: GET /privacy
     *  as an RSC request, which names its page in Next-Url and the router tree. */
    function prefetchTransaction() {
        return {
            type: 'transaction',
            transaction: 'GET /privacy',
            request: {
                url: 'http://127.0.0.1:64805/privacy?_rsc=1x2y3',
                method: 'GET',
                query_string: '_rsc=1x2y3',
                headers: {
                    host: '127.0.0.1:64805',
                    'user-agent': 'Mozilla/5.0',
                    accept: '*/*',
                    rsc: '1',
                    'next-router-prefetch': '1',
                    'next-router-segment-prefetch': '/_tree',
                    'next-url': `/r/${LINK_ID}`,
                    'next-router-state-tree': TREE(),
                    referer: `http://127.0.0.1:64805/r/${LINK_ID}`,
                },
            },
            contexts: {
                trace: {
                    op: 'http.server',
                    data: {
                        'sentry.op': 'http.server',
                        'http.method': 'GET',
                        'http.target': '/privacy?_rsc=1x2y3',
                        'http.request.header.next_url': `/r/${LINK_ID}`,
                        'http.request.header.next_router_state_tree': TREE(),
                    },
                },
            },
            spans: [
                {
                    description: 'render route (app) /privacy',
                    data: { 'http.request.header.next_url': `/r/${LINK_ID}`, 'next.route': '/privacy' },
                },
            ],
        };
    }

    /** captureRequestError's event for a render fault on /r: the parameterized
     *  transaction, the headers, and the raw path in contexts.nextjs. */
    function renderError() {
        return {
            level: 'error',
            transaction: 'GET /r/[linkId]/page',
            request: {
                url: `http://127.0.0.1:64805/r/${LINK_ID}?_rsc=Q1vRyY7h`,
                method: 'GET',
                query_string: '_rsc=Q1vRyY7h',
                headers: { 'user-agent': 'Mozilla/5.0', rsc: '1', 'next-router-state-tree': '%5Bbroken' },
            },
            contexts: {
                nextjs: {
                    request_path: `/r/${LINK_ID}?_rsc=Q1vRyY7h`,
                    router_kind: 'App Router',
                    router_path: '/r/[linkId]/page',
                    route_type: 'render',
                },
                trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' },
            },
            exception: {
                values: [
                    {
                        type: 'Error',
                        value: 'The router state header was sent but could not be parsed.',
                        mechanism: { type: 'auto.function.nextjs.on_request_error', handled: false },
                        stacktrace: {
                            frames: [
                                {
                                    filename:
                                        '/var/task/client/node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js',
                                    function: 's_',
                                    in_app: true,
                                },
                            ],
                        },
                    },
                ],
            },
        };
    }

    it('a footer RSC request from /r leaves no link id in its transaction (F3-01)', () => {
        const out = scrubServerTransactionEvent(prefetchTransaction());
        const json = JSON.stringify(out);
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(encodeURIComponent(LINK_ID));
        expect(out.request.headers).toEqual({ 'user-agent': 'Mozilla/5.0' });
        expect(out.request.query_string).toBe('_rsc=1x2y3');
        expect(out.request.url).toBe('http://127.0.0.1:64805/privacy?_rsc=1x2y3');
        expect(out.contexts.trace.data).toEqual({
            'sentry.op': 'http.server',
            'http.method': 'GET',
            'http.target': '/privacy?_rsc=1x2y3',
        });
        expect(out.spans[0].data).toEqual({ 'next.route': '/privacy' });
        expect(out.transaction).toBe('GET /privacy');
    });

    it('a render fault on /r leaves no link id in its error event (F3-03)', () => {
        const out = scrubServerErrorEvent(renderError());
        expect(JSON.stringify(out)).not.toContain(LINK_ID);
        expect(out.contexts.nextjs).toEqual({
            request_path: '/r/redacted?_rsc=Q1vRyY7h',
            router_kind: 'App Router',
            router_path: '/r/[linkId]/page',
            route_type: 'render',
        });
        expect(out.request.headers).toEqual({ 'user-agent': 'Mozilla/5.0' });
        expect(out.request.url).toBe('http://127.0.0.1:64805/r/redacted?_rsc=Q1vRyY7h');
        expect(out.request.query_string).toBe('_rsc=Q1vRyY7h');
        // The server runtime's frames name no page and come back as they were.
        expect(out.exception).toEqual(renderError().exception);
    });

    it('a legacy ?room= request leaves no room id in the query string or a Referer (S2 O-2)', () => {
        const home = scrubServerTransactionEvent({
            transaction: 'GET /',
            request: { url: `http://127.0.0.1:64805/?room=${ROOM_ID}`, query_string: `room=${ROOM_ID}` },
        });
        expect(home.request.query_string).toBe('room=redacted');
        const icon = scrubServerTransactionEvent({
            transaction: 'GET /icon.svg',
            request: { url: 'http://127.0.0.1:64805/icon.svg', headers: { referer: `http://127.0.0.1:64805/?room=${ROOM_ID}` } },
        });
        expect(icon.request.headers).toEqual({});
        const error = scrubServerErrorEvent({
            request: { query_string: `next=/r/${LINK_ID}&room=${ROOM_ID}` },
            contexts: { nextjs: { request_path: `/?room=${ROOM_ID}` } },
        });
        expect(JSON.stringify([home, icon, error])).not.toMatch(new RegExp(`${ROOM_ID}|${LINK_ID}`));
        expect(error.contexts.nextjs.request_path).toBe('/?room=redacted');
    });

    it('keeps the user agent under any spelling and no other header', () => {
        const out = scrubServerErrorEvent({
            request: {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    Referer: 'https://floe.one/r/x',
                    'Next-Url': '/r/x',
                    Cookie: 'a=b',
                    Host: 'floe.one',
                },
            },
        });
        expect(out.request.headers).toEqual({ 'User-Agent': 'Mozilla/5.0' });
    });

    it('drops cookies, the body and every request field but the url, method, query string and headers', () => {
        // The dataCollection block does not drop cookies, as sendDefaultPii
        // false did not in @sentry/core 10.72.0: the Cookie header stays and is parsed into request.cookies unfiltered,
        // and a body the scope holds is attached as request.data.
        const out = scrubServerErrorEvent({
            request: {
                url: 'http://127.0.0.1:64805/privacy',
                method: 'GET',
                query_string: 'x=1',
                headers: { 'user-agent': 'Mozilla/5.0', cookie: 'plain=abc; session_id=zzz' },
                cookies: { plain: 'abc', session_id: 'zzz' },
                data: { next: `/r/${LINK_ID}` },
                env: { REMOTE_ADDR: '203.0.113.7' },
            },
        });
        expect(out.request).toEqual({
            url: 'http://127.0.0.1:64805/privacy',
            method: 'GET',
            query_string: 'x=1',
            headers: { 'user-agent': 'Mozilla/5.0' },
        });
        const transaction = scrubServerTransactionEvent({
            request: { url: 'http://127.0.0.1:64805/', cookies: { plain: 'abc' }, data: 'plain=abc' },
        });
        expect(transaction.request).toEqual({ url: 'http://127.0.0.1:64805/' });
    });

    it('scrubs every breadcrumb string, on errors and transactions alike', () => {
        // The server and edge configs set no beforeBreadcrumb, and both event
        // kinds carry the scope's breadcrumbs (the captured F3-03 error and its
        // transaction each held the console breadcrumb Next logs for a render
        // fault). None carried a /r id; like the Umami hook, this is for the
        // path nobody has found yet.
        const crumbs = () => [
            {
                timestamp: 1790325332.108,
                category: 'console',
                level: 'error',
                message: `GET /r/${LINK_ID}?_rsc=x failed`,
                data: {
                    logger: 'console',
                    arguments: [
                        '\u2a2f',
                        { name: 'Error', stack: `Error: boom\n    at render (https://floe.one/r/${LINK_ID}#room=${ROOM_ID})` },
                        7,
                    ],
                },
            },
            { category: 'http', type: 'http', data: { url: `https://floe.one/r/${LINK_ID}`, method: 'GET', status_code: 200 } },
            { category: 'navigation', data: { from: `/r/${LINK_ID}`, to: '/privacy' } },
            // A url with no leading slash: the description rule leaves free
            // text like it alone, the url rule does not.
            { category: 'fetch', data: { url: `r/${LINK_ID}` } },
            { category: 'console', level: 'log', message: 'render took 12ms' },
        ];
        const want = [
            {
                timestamp: 1790325332.108,
                category: 'console',
                level: 'error',
                message: 'GET /r/redacted?_rsc=x failed',
                data: {
                    logger: 'console',
                    // The description rule's shape for a URL in parentheses
                    // (see "a fragment-less /r URL wrapped" above).
                    arguments: ['\u2a2f', { name: 'Error', stack: 'Error: boom\n    at render /(https://floe.one/r/redacted' }, 7],
                },
            },
            { category: 'http', type: 'http', data: { url: 'https://floe.one/r/redacted', method: 'GET', status_code: 200 } },
            { category: 'navigation', data: { from: '/r/redacted', to: '/privacy' } },
            { category: 'fetch', data: { url: '/r/redacted' } },
            { category: 'console', level: 'log', message: 'render took 12ms' },
        ];
        const error = scrubServerErrorEvent({ breadcrumbs: crumbs() });
        const transaction = scrubServerTransactionEvent({ breadcrumbs: crumbs() });
        for (const out of [error, transaction]) {
            expect(JSON.stringify(out)).not.toMatch(new RegExp(`${LINK_ID}|${ROOM_ID}`));
            expect(out.breadcrumbs).toEqual(want);
        }
    });

    it('a server event anywhere else keeps its URL, query string and request path', () => {
        const out = scrubServerErrorEvent({
            transaction: 'GET /api/config',
            request: { url: 'http://127.0.0.1:64805/api/config?x=1', query_string: 'x=1', headers: { accept: '*/*' } },
            contexts: { nextjs: { request_path: '/api/config?x=1', router_path: '/api/config' } },
        });
        expect(out).toEqual({
            transaction: 'GET /api/config',
            request: { url: 'http://127.0.0.1:64805/api/config?x=1', query_string: 'x=1', headers: {} },
            contexts: { nextjs: { request_path: '/api/config?x=1', router_path: '/api/config' } },
        });
    });

    it('never throws on an odd server event, and drops a header, query or path it cannot read', () => {
        const shapes: unknown[] = [
            {},
            { request: null },
            { request: 'x' },
            { request: { headers: null } },
            { request: { headers: `next-url: /r/${LINK_ID}` } },
            { request: { headers: [`/r/${LINK_ID}`] } },
            { request: { query_string: { next: `/r/${LINK_ID}` } } },
            { request: { query_string: [['next', `/r/${LINK_ID}`]] } },
            { contexts: null },
            { contexts: 'x' },
            { contexts: { nextjs: null } },
            { contexts: { nextjs: { request_path: [`/r/${LINK_ID}`] } } },
            { breadcrumbs: `/r/${LINK_ID}` },
            { breadcrumbs: { message: `/r/${LINK_ID}` } },
            { breadcrumbs: [null, `/r/${LINK_ID}`, { message: [`/r/${LINK_ID}`], data: [`/r/${LINK_ID}`] }] },
            { breadcrumbs: [{ data: { url: 42, deep: { deeper: { list: [`/r/${LINK_ID}`] } } } }] },
        ];
        for (const shape of shapes) {
            const event = structuredClone(shape) as Parameters<typeof scrubServerErrorEvent>[0];
            expect(() => scrubServerErrorEvent(event), JSON.stringify(shape)).not.toThrow();
            expect(JSON.stringify(event), JSON.stringify(shape)).not.toContain(LINK_ID);
            const transaction = structuredClone(shape) as Parameters<typeof scrubServerTransactionEvent>[0];
            expect(() => scrubServerTransactionEvent(transaction), JSON.stringify(shape)).not.toThrow();
            expect(JSON.stringify(transaction), JSON.stringify(shape)).not.toContain(LINK_ID);
        }
    });

    it('is idempotent', () => {
        const once = scrubServerTransactionEvent(prefetchTransaction());
        expect(scrubServerTransactionEvent(structuredClone(once))).toEqual(once);
        const error = scrubServerErrorEvent(renderError());
        expect(scrubServerErrorEvent(structuredClone(error))).toEqual(error);
    });

    it('the server and edge configs run these scrubs', () => {
        // The configs import the SDK and cannot load here; their wiring is
        // read as text, as visitorBoundaries.test.ts reads the /r sources.
        for (const file of ['sentry.server.config.ts', 'sentry.edge.config.ts']) {
            const src = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
            // The scrub is the innermost call of each hook, so it runs first and
            // on the whole event. What wraps it only empties the location
            // field (lib/noLocation.ts, pinned in noLocation.test.ts).
            expect(src, file).toMatch(/beforeSend\(event\) \{\s*return withoutLocation\(scrubServerErrorEvent\(event\)\);\s*\}/);
            expect(src, file).toMatch(
                /beforeSendTransaction\(event\) \{\s*return withoutLocation\(scrubServerTransactionEvent\(event\)\);\s*\}/
            );
            // A whole code line, so a commented-out one fails. The block keeps
            // the SDK from collecting an address (lib/sentryDataCollection.ts).
            expect(src, file).toMatch(
                /^\s+dataCollection: DATA_COLLECTION,\r?$/m
            );
        }
    });
});

// A receiver link as the browser reports it: ?s= is the per-link nonce, which
// carries nothing and stays; the fragment holds the room id, the transfer secret.
const ROOM = '3f6c1a2e-8b4d-4e7f-9a01-5c2d7e8f9b3a';
const RECEIVER = `http://localhost:3000/?s=b7Kq2xZp9w#room=${ROOM}`;
const RECEIVER_SCRUBBED = 'http://localhost:3000/?s=b7Kq2xZp9w';

// The navigation-timing ops browserTracing names after the document URL. The
// first seven are the ones a captured receiver pageload carried; the rest come
// from the same SDK function when their timings are non-zero.
const NAV_OPS = [
    'browser.domContentLoadedEvent',
    'browser.loadEvent',
    'browser.connect',
    'browser.cache',
    'browser.DNS',
    'browser.request',
    'browser.response',
    'browser.unloadEvent',
    'browser.redirect',
    'browser.TLS/SSL',
];

// Descriptions the SDK writes that hold no secret: resource names (same-origin
// paths and a cross-origin URL), mark and paint names, free text, element
// selectors (one with an id), an http.client name, and paths the URL parser
// would normalize if it were ever run on them.
const UNTOUCHED = [
    '/_next/static/chunks/0a1b2c3d.js',
    '/_next/image?url=%2Flogo.png&w=64&q=75',
    'https://cloud.umami.is/script.js',
    'Next.js-before-hydration',
    'first-contentful-paint',
    'Main UI thread blocked',
    'body > div#main > button.send',
    'div#main > a:nth-child(2)',
    'div#main.w-1/2',
    'div.w-1/2.bg-[#fff]',
    'div#x.w-1/2.bg-[#fff]',
    'input[name="a/b#c"]',
    'bathroom=3',
    'GET /api/turn-credentials',
    '/a/../b',
    '/',
];

// [description, what it must become]. A fragment on anything URL-shaped is
// dropped whatever it holds (a bare #<id> too), and a room= parameter is
// redacted wherever it sits, URL-shaped or not.
const FAIL_CLOSED: [string, string][] = [
    [RECEIVER, RECEIVER_SCRUBBED],
    [`/?s=b7Kq2xZp9w#room=${ROOM}`, '/?s=b7Kq2xZp9w'],
    // On the feature branch scrubUrl also redacts the /r link id (the request-link path rule).
    [`https://www.floe.one/r/Zq1a2b3c4d#${ROOM}`, 'https://www.floe.one/r/redacted'],
    [`https://www.floe.one/?room=${ROOM}&x=1`, 'https://www.floe.one/?room=redacted&x=1'],
    [`/?room=${ROOM}`, '/?room=redacted'],
    [`#room=${ROOM}`, '/'],
    [`#${ROOM}`, '/'],
    [`GET /?s=b7Kq2xZp9w#room=${ROOM}`, 'GET /?s=b7Kq2xZp9w'],
    [`navigate to http://localhost:3000/#room=${ROOM} now`, 'navigate to http://localhost:3000/ now'],
    [`www.floe.one/#room=${ROOM}`, '/www.floe.one/'],
    [`(https://www.floe.one/r/Zq1a2b3c4d#${ROOM})`, '/(https://www.floe.one/r/redacted'],
    [`url=https://www.floe.one/r/Zq1a2b3c4d#${ROOM}`, '/url=https://www.floe.one/r/redacted'],
];

// A long-animation-frame span's data, as browserTracing copies it from the
// frame's first script. For an inline classic script, or an inline onclick,
// Chromium reports the document URL, fragment included, as both the invoker
// and the sourceURL; for a handler it reports names like BUTTON#b.onclick.
const LOAF_DATA = {
    'sentry.op': 'ui.long-animation-frame',
    'sentry.origin': 'auto.ui.browser.metrics',
    'browser.script.invoker_type': 'classic-script',
    'browser.script.source_char_position': 0,
};
const LOAF_URLS = (url: string) => ({ 'browser.script.invoker': url, 'code.filepath': url });

function pageloadEvent() {
    return {
        type: 'transaction',
        transaction: '/',
        request: { url: RECEIVER, headers: { 'User-Agent': 'Mozilla/5.0' } },
        contexts: {
            trace: {
                op: 'pageload',
                origin: 'auto.pageload.nextjs.app_router_instrumentation',
                data: { 'sentry.op': 'pageload', 'sentry.source': 'url', 'url.full': RECEIVER },
            },
        },
        measurements: { fcp: { value: 120, unit: 'millisecond' }, ttfb: { value: 30, unit: 'millisecond' } },
        spans: [
            {
                op: 'ui.long-animation-frame',
                description: 'Main UI thread blocked',
                data: { ...LOAF_DATA, ...LOAF_URLS(RECEIVER) },
            },
            { op: 'mark', description: 'Next.js-before-hydration', data: { 'sentry.op': 'mark' } },
            { op: 'paint', description: 'first-contentful-paint', data: { 'sentry.op': 'paint' } },
            {
                op: 'resource.script',
                description: '/_next/static/chunks/0a1b2c3d.js',
                data: { 'url.full': 'http://localhost:3000/_next/static/chunks/0a1b2c3d.js' },
            },
            ...NAV_OPS.map((op) => ({
                op,
                description: RECEIVER,
                data: { 'sentry.op': op, 'sentry.origin': 'auto.ui.browser.metrics' },
            })),
        ],
    };
}

// The browser SDK copies document.referrer into request.headers.Referer
// (getHttpRequestData in @sentry/browser), and the two browser hooks rewrote
// request.url only. After a full navigation away from a legacy ?room=<id>
// link, for example the Link Invalid card's Back to Home, the next page's
// errors and sampled traces named that link in the header (WEB-21). Fragment
// links never get there: a browser sends no fragment in a referrer.
describe('the Referer a browser event carries', () => {
    const ROOM = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const LEGACY = `https://www.floe.one/?room=${ROOM}`;
    const event = (headers: unknown) => ({ request: { url: 'https://www.floe.one/', headers } });

    it('an error raised after leaving a legacy ?room= link carries no room id', () => {
        const out = scrubErrorEvent(event({ Referer: LEGACY, 'User-Agent': 'UA/1.0' }));
        expect(JSON.stringify(out)).not.toContain(ROOM);
        expect(out.request.headers).toEqual({
            Referer: 'https://www.floe.one/?room=redacted',
            'User-Agent': 'UA/1.0',
        });
    });

    it('a trace sampled on that page carries none either', () => {
        const out = scrubTransactionEvent(event({ Referer: LEGACY, 'User-Agent': 'UA/1.0' }));
        expect(JSON.stringify(out)).not.toContain(ROOM);
        expect(out.request.headers).toEqual({
            Referer: 'https://www.floe.one/?room=redacted',
            'User-Agent': 'UA/1.0',
        });
    });

    it('finds the header under any spelling', () => {
        for (const key of ['Referer', 'referer', 'REFERER']) {
            expect(JSON.stringify(scrubErrorEvent(event({ [key]: LEGACY }))), key).not.toContain(ROOM);
            expect(JSON.stringify(scrubTransactionEvent(event({ [key]: LEGACY }))), key).not.toContain(ROOM);
        }
    });

    it('redacts a request link path that reached it', () => {
        // /r sends no referrer (next.config.mjs), so this is belt and braces.
        const out = scrubErrorEvent(event({ Referer: 'https://www.floe.one/r/abcdefghijk' }));
        expect(out.request.headers).toEqual({ Referer: 'https://www.floe.one/r/redacted' });
    });

    it('leaves a Referer with nothing to hide byte for byte, and every other header', () => {
        const clean = () => ({
            Referer: 'https://www.floe.one/how-it-works',
            'User-Agent': 'UA/1.0',
            'X-Other': `kept-${ROOM}`,
        });
        expect(scrubErrorEvent(event(clean())).request.headers).toEqual(clean());
        expect(scrubTransactionEvent(event(clean())).request.headers).toEqual(clean());
    });

    it('never throws on an odd request or headers shape, and leaves it as it was', () => {
        const shapes: unknown[] = [
            { request: null },
            { request: 'nope' },
            { request: {} },
            { request: { headers: null } },
            { request: { headers: 'nope' } },
            { request: { headers: 42 } },
            { request: { headers: [] } },
            { request: { headers: { Referer: null } } },
            { request: { headers: { Referer: 42 } } },
            { request: { headers: { Referer: { nested: LEGACY } } } },
        ];
        for (const shape of shapes) {
            const before = JSON.stringify(shape);
            expect(() => scrubErrorEvent(shape as ScrubbableErrorEvent)).not.toThrow();
            expect(() => scrubTransactionEvent(shape as Parameters<typeof scrubTransactionEvent>[0])).not.toThrow();
            expect(JSON.stringify(shape)).toBe(before);
        }
    });

    it('is idempotent', () => {
        const once = scrubErrorEvent(event({ Referer: LEGACY }));
        const twice = scrubErrorEvent(JSON.parse(JSON.stringify(once)));
        expect(twice).toEqual(once);
    });
});

describe('the Socket.IO session id', () => {
    // Every polling request to the signaling server names its engine.io
    // session in the query (?EIO=4&transport=polling&t=<stamp>&sid=<id>), and
    // the SDK's XHR instrumentation copies that URL onto an http.client span
    // four times: url, http.url, url.full and http.query. For as long as the
    // connection lives the id is all a request needs to speak as that socket,
    // so it gets the room id's treatment. Sentry held well over a hundred such
    // spans from the 14 days before this rule.
    const SID = 'u7Xk2pQ9LmN4rTaBAAAC';
    const POLL = `https://api.floe.one/socket.io/?EIO=4&transport=polling&t=PaBcDeF&sid=${SID}`;
    const POLL_SCRUBBED = 'https://api.floe.one/socket.io/?EIO=4&transport=polling&t=PaBcDeF&sid=redacted';

    it('is redacted from a URL, and the rest of the query stays', () => {
        expect(scrubUrl(POLL)).toBe(POLL_SCRUBBED);
        expect(scrubUrl(`/socket.io/?EIO=4&sid=${SID}`)).toBe('/socket.io/?EIO=4&sid=redacted');
        expect(scrubUrl(`https://floe.one/?sid=${SID}&room=secret-uuid`)).toBe(
            'https://floe.one/?sid=redacted&room=redacted'
        );
    });

    it('is redacted when the URL cannot be parsed', () => {
        const out = scrubUrl(`http://[not-a-host/socket.io/?EIO=4&sid=${SID}&t=1`);
        expect(out).not.toContain(SID);
        expect(out).toBe('http://[not-a-host/socket.io/?EIO=4&sid=redacted&t=1');
    });

    it('leaves a parameter that only ends in sid, and a URL with none, as they were', () => {
        expect(scrubUrl('https://floe.one/?acid=1&residue=2')).toBe('https://floe.one/?acid=1&residue=2');
        const span = { description: 'GET /a/../b?x=1', data: { url: '/a/../b?x=1', note: 'sid=abc is not a URL' } };
        const before = JSON.stringify(span);
        expect(JSON.stringify(scrubSpanJson(span))).toBe(before);
    });

    it('is redacted from every attribute of an XHR span as the SDK shapes it', () => {
        const span = {
            op: 'http.client',
            description: 'GET https://api.floe.one/socket.io/',
            data: {
                'http.method': 'GET',
                type: 'xhr',
                url: POLL,
                'http.url': POLL,
                'url.full': POLL,
                'http.query': `?EIO=4&transport=polling&t=PaBcDeF&sid=${SID}`,
                'server.address': 'api.floe.one',
            },
        };
        expect(scrubSpanJson(span)).toBe(span);
        expect(JSON.stringify(span)).not.toContain(SID);
        expect(span.data).toEqual({
            'http.method': 'GET',
            type: 'xhr',
            url: POLL_SCRUBBED,
            'http.url': POLL_SCRUBBED,
            'url.full': POLL_SCRUBBED,
            'http.query': '?EIO=4&transport=polling&t=PaBcDeF&sid=redacted',
            'server.address': 'api.floe.one',
        });
    });

    it('is redacted from the spans and breadcrumbs of a transaction', () => {
        const event = {
            transaction: '/',
            spans: [{ description: `POST ${POLL}`, data: { url: POLL, 'http.query': `?sid=${SID}` } }],
            breadcrumbs: [{ category: 'xhr', data: { method: 'GET', url: POLL, status_code: 200 } }],
        };
        const json = JSON.stringify(scrubTransactionEvent(event));
        expect(json).not.toContain(SID);
        expect(json).toContain('sid=redacted');
    });

    it('is redacted from an XHR breadcrumb as it is made, and from a logged URL', () => {
        const crumb = { category: 'xhr', data: { method: 'POST', url: POLL, status_code: 200 } };
        expect(scrubBreadcrumb(crumb).data.url).toBe(POLL_SCRUBBED);
        const logged = { category: 'console', message: `poll failed ${POLL}`, data: { arguments: [`poll failed ${POLL}`] } };
        expect(JSON.stringify(scrubBreadcrumb(logged))).not.toContain(SID);
    });

    it('is idempotent', () => {
        expect(scrubUrl(POLL_SCRUBBED)).toBe(POLL_SCRUBBED);
    });
});

// SDK 11's fetch, XHR and server instrumentation split a request URL into the
// OpenTelemetry url.query and url.fragment, with no leading '?' or '#'
// (getUrlQuery and getUrlFragment in @sentry/core 11.8.0), where SDK 10 wrote
// http.query and http.fragment with them. Without them the rule for every
// other attribute sees no fragment and no ?room= or &sid= start in
// "room=<id>" or "sid=<id>", and passed both through.
describe('the OpenTelemetry URL attributes of SDK 11', () => {
    const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const LINK_ID = 'Ab3dE_f9-xY';
    const SID = 'u7Xk2pQ9LmN4rTaBAAAC';

    it('deletes url.fragment, whatever it holds', () => {
        for (const fragment of [
            `room=${ROOM_ID}`,
            ROOM_ID,
            `#room=${ROOM_ID}`,
            'top',
        ]) {
            const span = {
                data: { 'url.fragment': fragment, 'sentry.op': 'http.client' },
            };
            expect(scrubSpanJson(span).data).toEqual({
                'sentry.op': 'http.client',
            });
        }
    });

    it('redacts the session id and the room id in url.query, and keeps its shape', () => {
        const span = {
            data: {
                'url.query': `EIO=4&transport=polling&t=PaBcDeF&sid=${SID}`,
            },
        };
        expect(scrubSpanJson(span).data['url.query']).toBe(
            'EIO=4&transport=polling&t=PaBcDeF&sid=redacted'
        );
        const first = { data: { 'url.query': `sid=${SID}&EIO=4` } };
        expect(scrubSpanJson(first).data['url.query']).toBe(
            'sid=redacted&EIO=4'
        );
        const legacy = { data: { 'url.query': `room=${ROOM_ID}&x=1` } };
        expect(scrubSpanJson(legacy).data['url.query']).toBe(
            'room=redacted&x=1'
        );
        // The SDK 10 shape, with its '?', comes back with it.
        const withMark = { data: { 'url.query': `?sid=${SID}` } };
        expect(scrubSpanJson(withMark).data['url.query']).toBe('?sid=redacted');
        // A query that holds neither is left as it was.
        const plain = { data: { 'url.query': '_rsc=1x2y3' } };
        expect(scrubSpanJson(plain).data['url.query']).toBe('_rsc=1x2y3');
    });

    it('redacts the request-link id in url.path', () => {
        const span = { data: { 'url.path': `/r/${LINK_ID}` } };
        expect(scrubSpanJson(span).data['url.path']).toBe('/r/redacted');
        const other = { data: { 'url.path': '/download' } };
        expect(scrubSpanJson(other).data['url.path']).toBe('/download');
    });

    it('leaves no secret in http.target, which keeps its query', () => {
        const span = {
            data: {
                'http.target': `/r/${LINK_ID}?room=${ROOM_ID}`,
                'url.path': `/r/${LINK_ID}`,
                'url.query': `room=${ROOM_ID}`,
            },
        };
        const json = JSON.stringify(scrubSpanJson(span));
        expect(json).not.toContain(LINK_ID);
        expect(json).not.toContain(ROOM_ID);
        expect(span.data['http.target']).toBe('/r/redacted?room=redacted');
    });

    it('scrubs an XHR poll as SDK 11 shapes it, in a transaction', () => {
        const poll = `https://api.floe.one/socket.io/?EIO=4&transport=polling&t=PaBcDeF&sid=${SID}`;
        const event = {
            transaction: '/',
            contexts: {
                trace: {
                    data: {
                        'url.full': `https://www.floe.one/?s=n0nce#room=${ROOM_ID}`,
                        'url.path': '/',
                        'url.fragment': `room=${ROOM_ID}`,
                    },
                },
            },
            spans: [
                {
                    description: 'GET https://api.floe.one/socket.io/',
                    data: {
                        url: poll,
                        'http.url': poll,
                        'url.full': poll,
                        'url.query': `EIO=4&transport=polling&t=PaBcDeF&sid=${SID}`,
                        'url.fragment': '',
                    },
                },
            ],
        };
        const json = JSON.stringify(scrubTransactionEvent(event));
        expect(json).not.toContain(SID);
        expect(json).not.toContain(ROOM_ID);
        expect(event.contexts.trace.data).toEqual({
            'url.full': 'https://www.floe.one/?s=n0nce',
            'url.path': '/',
        });
    });
});

describe('breadcrumb url.query and url.fragment (SDK 11)', () => {
    // SDK 11's Node outgoing-request breadcrumb and the edge runtime's fetch
    // breadcrumb write url.query and url.fragment beside url, with no leading
    // '?' or '#'. Nothing in Floe makes one today (browser breadcrumbs carry
    // neither key, and the Next server and edge make no outgoing request), so
    // this is for the path nobody has found yet, as on spans.
    const ID = '0b8e7c2d-4a1f-4e6b-9c3d-5f7a2e1b8c90';
    const crumb = () => ({
        category: 'http',
        data: { url: 'https://floe.one/', method: 'GET', 'url.query': `room=${ID}&s=n0nce`, 'url.fragment': `room=${ID}` },
    });

    it('the browser breadcrumb hook drops the fragment and scrubs the query, keeping its shape', () => {
        const out = scrubBreadcrumb(crumb()) as { data: Record<string, unknown> };
        expect(JSON.stringify(out)).not.toContain(ID);
        expect(out.data['url.fragment']).toBeUndefined();
        expect(String(out.data['url.query']).startsWith('?')).toBe(false);
        expect(out.data.method).toBe('GET');
    });

    it('so do the event hooks, browser and server, errors and transactions', () => {
        const events = [
            scrubErrorEvent({ breadcrumbs: [crumb()] }),
            scrubTransactionEvent({ breadcrumbs: [crumb()] }),
            scrubServerErrorEvent({ breadcrumbs: [crumb()] }),
            scrubServerTransactionEvent({ breadcrumbs: [crumb()] }),
        ];
        for (const event of events) {
            expect(JSON.stringify(event)).not.toContain(ID);
            const data = (event.breadcrumbs as { data: Record<string, unknown> }[])[0].data;
            expect(data['url.fragment']).toBeUndefined();
            expect(String(data['url.query']).startsWith('?')).toBe(false);
        }
    });
});

// A link can carry a link key: /?s=<nonce>#k=<k>&room=<id> from the web,
// /#k=<k>&room=<id> from the CLI, /r/<linkId>#<id>.<k> for a request link. The
// key proves a peer holds the link, so it gets the room id's treatment
// everywhere the room id is scrubbed, and in the shapes where the '#' is gone:
// scrubUrl alone turned "k=<k>&room=<id>" into "/k=<k>&room=<id>", both intact.
describe('the link key', () => {
    const KEY = 'AbCdEfGhIjKlMnOpQrStUg';
    const ROOM_ID = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const LINK_ID = 'Ab3dE_f9-xY';
    const SHARE = `https://www.floe.one/?s=n0nce#k=${KEY}&room=${ROOM_ID}`;
    const CLI = `https://www.floe.one/#k=${KEY}&room=${ROOM_ID}`;
    const REQUEST = `https://www.floe.one/r/${LINK_ID}#${ROOM_ID}.${KEY}`;
    const LINKS: [string, string][] = [
        [SHARE, 'https://www.floe.one/?s=n0nce'],
        [CLI, 'https://www.floe.one/'],
        [REQUEST, 'https://www.floe.one/r/redacted'],
        [`/?s=x#k=${KEY}&room=${ROOM_ID}`, '/?s=x'],
        [`/#k=${KEY}&room=${ROOM_ID}`, '/'],
        [`/r/${LINK_ID}#${ROOM_ID}.${KEY}`, '/r/redacted'],
        // A link cut after the key, the likeliest damaged shape.
        [`https://www.floe.one/#k=${KEY}`, 'https://www.floe.one/'],
    ];
    const secretsIn = (value: unknown) => {
        const json = JSON.stringify(value);
        return [KEY, ROOM_ID, LINK_ID].filter((secret) => json.includes(secret));
    };

    it('scrubUrl drops it with the fragment, on every link shape', () => {
        for (const [link, want] of LINKS) {
            expect(scrubUrl(link), link).toBe(want);
        }
    });

    it('scrubUrl redacts a key that reached the query, as it does a room id', () => {
        expect(scrubUrl(`https://www.floe.one/?k=${KEY}&room=${ROOM_ID}&x=1`)).toBe(
            'https://www.floe.one/?k=redacted&room=redacted&x=1'
        );
        expect(scrubUrl(`/path?k=${KEY}`)).toBe('/path?k=redacted');
    });

    it('scrubUrl redacts it when the URL cannot be parsed', () => {
        const broken = `https://[/?k=${KEY}&x=1&k=${KEY}#k=${KEY}&room=${ROOM_ID}`;
        expect(() => new URL(broken, 'http://scrub.invalid')).toThrow();
        expect(scrubUrl(broken)).toBe('https://[/?k=redacted&x=1&k=redacted');
        // A fragment with a line break in it still goes, whole.
        expect(scrubUrl(`https://[/#k=${KEY}\n${KEY}`)).toBe('https://[/');
    });

    it('free text loses it, with the words around it kept', () => {
        for (const [link, want] of LINKS) {
            const value = `failed to load ${link} now`;
            const event = { exception: { values: [{ value }] }, breadcrumbs: [{ category: 'console', message: value }] };
            const out = scrubErrorEvent(event);
            expect(out.exception.values[0].value, link).toBe(`failed to load ${want} now`);
            expect(secretsIn(out), link).toEqual([]);
            expect(scrubBreadcrumb({ message: value }).message, link).toBe(`failed to load ${want} now`);
        }
    });

    it('free text loses it when the # is gone, in any wrapping', () => {
        for (const text of [
            `k=${KEY}&room=${ROOM_ID}`,
            `room=${ROOM_ID}&k=${KEY}`,
            `k=${KEY}`,
            `&k=${KEY}`,
            `;k=${KEY}`,
            `&amp;k=${KEY}&amp;room=${ROOM_ID}`,
            `?k=${KEY}`,
            `'k=${KEY}&room=${ROOM_ID}'`,
            `"k=${KEY}&room=${ROOM_ID}"`,
            `(k=${KEY}&room=${ROOM_ID})`,
            `[k=${KEY}]`,
            `hash:k=${KEY}&room=${ROOM_ID}`,
            `hash=k=${KEY}&room=${ROOM_ID}`,
            `/k=${KEY}&room=${ROOM_ID}`,
            `{"hash":"k=${KEY}&room=${ROOM_ID}"}`,
            `K=${KEY}&ROOM=${ROOM_ID}`,
            `#k=${KEY}`,
            `'#k=${KEY}'`,
            `'#k=${KEY}&room=${ROOM_ID}'`,
            // The request link's fragment, as location.hash.slice(1) hands it on.
            `${ROOM_ID}.${KEY}`,
            `'${ROOM_ID}.${KEY}'`,
            `fragment=${ROOM_ID}.${KEY},`,
            `${ROOM_ID.toUpperCase()}.${KEY}`,
        ]) {
            const message = `the fragment was ${text} here`;
            const out = scrubBreadcrumb({ message }).message;
            expect(out.includes(KEY), text).toBe(false);
            expect(out.toLowerCase().includes(ROOM_ID), text).toBe(false);
            expect(out.startsWith('the fragment was '), text).toBe(true);
            expect(out.endsWith(' here'), text).toBe(true);
            expect(secretsIn(scrubErrorEvent({ exception: { values: [{ value: message }] } })), text).toEqual([]);
            expect(scrubSpanJson({ description: message }).description.includes(KEY), text).toBe(false);
        }
        expect(scrubBreadcrumb({ message: `k=${KEY}` }).message).toBe('k=redacted');
        expect(scrubBreadcrumb({ message: `'#k=${KEY}'` }).message).toBe("'#k=redacted'");
        expect(scrubBreadcrumb({ message: `'${ROOM_ID}.${KEY}' is bad` }).message).toBe("'redacted' is bad");
    });

    it('free text keeps a k= or room= that is not a parameter of its own, and an id with no key', () => {
        for (const text of [
            'bank=1',
            'task=3',
            'desk=4&mock=5',
            'x-k=1',
            'a.k=1',
            'bathroom=3',
            'link=https',
            'w=64&q=75',
            ROOM_ID,
            `${ROOM_ID}.png`,
            `${ROOM_ID}.${KEY}x`,
        ]) {
            const message = `the value ${text} here`;
            expect(scrubBreadcrumb({ message }).message, text).toBe(message);
            expect(scrubSpanJson({ description: message }).description, text).toBe(message);
        }
    });

    it("Chromium's selector message loses the id and the key, and only them", () => {
        const value = `Failed to execute 'querySelector' on 'Document': '#${ROOM_ID}.${KEY}' is not a valid selector.`;
        const kept = "Failed to execute 'querySelector' on 'Document': '#redacted' is not a valid selector.";
        const event = { exception: { values: [{ value }] }, breadcrumbs: [{ category: 'console', message: value }] };
        const out = scrubErrorEvent(event);
        expect(out.exception.values[0].value).toBe(kept);
        expect(secretsIn(out)).toEqual([]);
        expect(scrubBreadcrumb({ message: value }).message).toBe(kept);
        // Whatever follows the dot goes: a key of the wrong length, a cut one,
        // or one a mail scanner percent-encoded.
        for (const tail of ['abc', 'abc-_', `${KEY}${KEY}`, `${KEY}%3D`, '']) {
            const message = `bad '#${ROOM_ID}.${tail}' selector`;
            expect(scrubBreadcrumb({ message }).message, tail).toBe("bad '#redacted' selector");
        }
        // The same fragment outside any quote, and upper-cased.
        expect(scrubBreadcrumb({ message: `(#${ROOM_ID.toUpperCase()}.${KEY})` }).message).toBe('(#redacted)');
        // A share link's fragment in the same message.
        const share = `bad '#k=${KEY}&room=${ROOM_ID}' selector`;
        expect(secretsIn(scrubBreadcrumb({ message: share }))).toEqual([]);
    });

    it('a selector with a room id takes the same rule in a span', () => {
        const out = scrubSpanJson({
            description: `'#${ROOM_ID}.${KEY}'`,
            data: { 'custom.note': `a[href="#${ROOM_ID}.${KEY}"]` },
        });
        expect(out.description).toBe("'#redacted'");
        expect(out.data['custom.note']).toBe('a[href="#redacted"]');
    });

    it('span descriptions, names and attributes lose it', () => {
        for (const [link, want] of LINKS) {
            // The navigation-timing span browserTracing names after the document URL.
            expect(scrubSpanJson({ op: 'browser.request', description: link }).description, link).toBe(want);
            expect(scrubSpanJson({ description: `GET ${link}` }).description, link).toBe(`GET ${want}`);
            const span = {
                data: {
                    'url.full': link,
                    'http.url': link,
                    url: link,
                    // A long-animation-frame span's script, for an inline script.
                    'browser.script.invoker': link,
                    'code.filepath': link,
                    'custom.list': ['plain', link, 7],
                },
            };
            const out = scrubSpanJson(span);
            expect(secretsIn(out), link).toEqual([]);
            expect(out.data['url.full'], link).toBe(want);
            expect(out.data['code.filepath'], link).toBe(want);
            expect(out.data['custom.list'], link).toEqual(['plain', want, 7]);
        }
    });

    it('the query and fragment attributes lose it, with or without their mark', () => {
        const span = {
            data: {
                'url.fragment': `k=${KEY}&room=${ROOM_ID}`,
                'http.fragment': `#k=${KEY}&room=${ROOM_ID}`,
                'url.query': `k=${KEY}&room=${ROOM_ID}&x=1`,
                'http.query': `?k=${KEY}&room=${ROOM_ID}`,
            },
        };
        const out = scrubSpanJson(span);
        expect(out.data).toEqual({ 'url.query': 'k=redacted&room=redacted&x=1', 'http.query': '?k=redacted&room=redacted' });
        const fragment = { data: { 'url.fragment': `${ROOM_ID}.${KEY}` } };
        expect(scrubSpanJson(fragment).data).toEqual({});
    });

    it('a transaction carries none of it, whatever it is named', () => {
        for (const [link] of LINKS) {
            const event = {
                transaction: link,
                request: { url: link, headers: { Referer: `https://www.floe.one/?k=${KEY}&room=${ROOM_ID}` } },
                contexts: { trace: { data: { 'url.full': link } } },
                spans: [{ description: link, data: { 'url.full': link } }],
                breadcrumbs: [{ category: 'navigation', data: { from: link, to: link } }, { category: 'console', message: `at ${link}` }],
            };
            const out = scrubTransactionEvent(event);
            expect(secretsIn(out), link).toEqual([]);
        }
    });

    it('breadcrumbs lose it, as they are made and on an event', () => {
        for (const [link, want] of LINKS) {
            const crumb = () => ({
                category: 'navigation',
                message: `moved to ${link}`,
                data: { from: link, to: link, url: link, arguments: [link] as unknown[] },
            });
            const made = scrubBreadcrumb(crumb());
            expect(secretsIn(made), link).toEqual([]);
            expect(made.data.from, link).toBe(want);
            expect(made.data.arguments[0], link).toBe(want);
            // The SDK's normalized copy, with a logged object still in it.
            const logged = { category: 'console', data: { arguments: [{ href: link, nested: { hash: `k=${KEY}&room=${ROOM_ID}` } }] } };
            for (const event of [
                scrubErrorEvent({ breadcrumbs: [crumb(), logged] }),
                scrubTransactionEvent({ breadcrumbs: [crumb(), logged] }),
                scrubServerErrorEvent({ breadcrumbs: [crumb(), logged] }),
                scrubServerTransactionEvent({ breadcrumbs: [crumb(), logged] }),
            ]) {
                expect(secretsIn(event), link).toEqual([]);
            }
        }
    });

    it('a server event loses it from its query string and request path', () => {
        const out = scrubServerErrorEvent({
            request: { query_string: `k=${KEY}&room=${ROOM_ID}` },
            contexts: { nextjs: { request_path: `/?k=${KEY}&room=${ROOM_ID}` } },
        });
        expect(secretsIn(out)).toEqual([]);
        expect(out.request.query_string).toBe('k=redacted&room=redacted');
    });

    it('a stack frame loses it', () => {
        const out = scrubErrorEvent({
            exception: { values: [{ stacktrace: { frames: [{ filename: SHARE, abs_path: REQUEST }] } }] },
        });
        expect(secretsIn(out)).toEqual([]);
    });

    describe('a throw of anything but an Error', () => {
        // The SDK's own builder, reached through the package that depends on it,
        // so a version that moves these fields fails here. A script on the page
        // that throws a string or rejects with an object gets exactly this.
        const fromNext = createRequire(createRequire(import.meta.url).resolve('@sentry/nextjs'));
        const { eventFromException } = fromNext('@sentry/browser') as {
            eventFromException: (stackParser: () => unknown[], thrown: unknown) => PromiseLike<ScrubbableErrorEvent>;
        };
        const build = async (thrown: unknown) => await eventFromException(() => [], thrown);
        const held = (value: unknown, secret: string) => JSON.stringify(value).includes(secret);

        for (const [link] of LINKS) {
            it(`a thrown string, ${link}`, async () => {
                const event = await build(`bad page ${link}`);
                expect(event.message).toContain(link);
                const out = scrubErrorEvent(event);
                expect(secretsIn(out), JSON.stringify(out)).toEqual([]);
                expect(out.message).toContain('bad page');
            });

            it(`a thrown object, ${link}`, async () => {
                const event = await build({ url: link, n: 7 });
                expect((event.extra as { __serialized__: { url: string } }).__serialized__.url).toBe(link);
                const out = scrubErrorEvent(event);
                expect(secretsIn(out), JSON.stringify(out)).toEqual([]);
                expect((out.extra as { __serialized__: { n: number } }).__serialized__.n).toBe(7);
            });

            it(`a thrown object with the link as a key, ${link}`, async () => {
                const event = await build({ [link]: 1 });
                expect(held(event.extra, link)).toBe(true);
                expect(secretsIn(scrubErrorEvent(event))).toEqual([]);
            });

            it(`an Error named after the link, ${link}`, async () => {
                const event = await build(Object.assign(new Error('x'), { name: link }));
                expect(held(event.exception, link)).toBe(true);
                expect(secretsIn(scrubErrorEvent(event))).toEqual([]);
            });

            it(`a parameterized message, ${link}`, () => {
                const out = scrubErrorEvent({ logentry: { message: `bad page ${link}`, params: [link] } });
                expect(secretsIn(out)).toEqual([]);
            });
        }

        it('reaches the server hook too, which starts from the browser one', async () => {
            const out = scrubServerErrorEvent(await build({ url: SHARE, note: `bad page ${REQUEST}` }));
            expect(secretsIn(out)).toEqual([]);
        });

        it('leaves everything else in the event as it was', async () => {
            const out = scrubErrorEvent(await build({ code: 7, deep: { a: ['b', 1, null] } }));
            expect(out.extra).toEqual({ __serialized__: { code: 7, deep: { a: ['b', 1, null] } } });
        });

        it('takes an event of any other shape without throwing', () => {
            for (const event of [
                { message: 7 },
                { extra: 'text' },
                { extra: null },
                { logentry: 'text' },
                { exception: { values: [{ type: 7 }] } },
            ]) {
                expect(() => scrubErrorEvent(event as unknown as ScrubbableErrorEvent), JSON.stringify(event)).not.toThrow();
            }
        });
    });

    describe('a link percent-encoded in a query value', () => {
        // A script on the page reporting where it is:
        // fetch('https://collector.example/hit?u=' + encodeURIComponent(location.href)).
        for (const [link] of LINKS) {
            const encoded = encodeURIComponent(link);
            const url = `https://collector.example/hit?u=${encoded}&x=1`;

            it(`scrubUrl, ${link}`, () => {
                const out = scrubUrl(url);
                expect(secretsIn(out), out).toEqual([]);
                expect(out).toContain('https://collector.example/hit?');
                expect(out).toContain('x=1');
            });

            it(`the fetch span the SDK writes, ${link}`, () => {
                const out = scrubSpanJson({
                    description: `GET ${url}`,
                    data: {
                        'url.full': url,
                        'http.url': url,
                        'url.query': `u=${encoded}&x=1`,
                        'http.query': `?u=${encoded}&x=1`,
                        'code.filepath': url,
                    },
                });
                expect(secretsIn(out), JSON.stringify(out)).toEqual([]);
            });

            it(`the fetch breadcrumb the SDK writes, ${link}`, () => {
                const live = scrubBreadcrumb({ category: 'fetch', data: { url, method: 'GET' } });
                expect(secretsIn(live), JSON.stringify(live)).toEqual([]);
                const sent = scrubErrorEvent({ breadcrumbs: [{ category: 'fetch', data: { url, method: 'GET' } }] });
                expect(secretsIn(sent), JSON.stringify(sent)).toEqual([]);
            });

            it(`a Referer that holds it, ${link}`, () => {
                const out = scrubErrorEvent({ request: { url: 'https://www.floe.one/', headers: { Referer: url } } } as ScrubbableErrorEvent);
                expect(secretsIn(out), JSON.stringify(out)).toEqual([]);
            });
        }

        it('a request link fragment on its own', () => {
            for (const fragment of [`#${ROOM_ID}`, `#${ROOM_ID}.${KEY}`, `${ROOM_ID}.${KEY}`, `k=${KEY}&room=${ROOM_ID}`]) {
                const out = scrubUrl(`https://collector.example/hit?u=${encodeURIComponent(fragment)}`);
                expect(secretsIn(out), out).toEqual([]);
            }
        });

        it('a value that holds none of a link mark comes back byte for byte', () => {
            for (const url of [
                '/_next/image?url=%2Fa.png&w=64&q=75',
                'https://x.example/?color=%23fff',
                'https://x.example/?q=bank%3D1',
                'https://x.example/?next=%2Fabout%3Fa%3D1',
                'https://x.example/?q=a%20b',
            ]) {
                expect(scrubUrl(url)).toBe(url);
                expect(scrubSpanJson({ description: `GET ${url}` }).description).toBe(`GET ${url}`);
            }
        });
    });

    it('scrubUrl takes a value that is not a string, as its header says', () => {
        expect(scrubUrl(123 as unknown as string)).toBe('/123');
        expect(() => scrubTransactionEvent({ request: { url: 123 as unknown as string } })).not.toThrow();
    });

    it('is idempotent, because a transaction passes two hooks', () => {
        for (const text of [SHARE, CLI, REQUEST, `k=${KEY}&room=${ROOM_ID}`, `'k=${KEY}'`, `'#${ROOM_ID}.${KEY}'`, `k=${KEY}`]) {
            const once = scrubSpanJson({ description: text, data: { 'code.filepath': text } });
            const snapshot = JSON.stringify(once);
            expect(JSON.stringify(scrubSpanJson(once)), text).toBe(snapshot);
            const message = scrubBreadcrumb({ message: text }).message;
            expect(scrubBreadcrumb({ message }).message, text).toBe(message);
        }
    });
});

// The SDK writes a selector with the words of the element's aria-label, title
// and alt in it, unescaped, so a click on "Remove a.pdf" or on "Download <what
// the other peer called it>" names the file, against the privacy page. The same
// selector also lands in lcp.element and cls.source.N on a page load, and in
// [HTMLElement: ...] when a page logs an element.
describe('the words of an element in a selector', () => {
    const CASES: [string, string][] = [
        ['button.icon[aria-label="Remove a.pdf"][type="button"]', 'button.icon[aria-label]'],
        // A name that holds a folder path: open PR #838's Remove button.
        ['button.icon[aria-label="Remove photos/day1/a.jpg"][type="button"]', 'button.icon[aria-label]'],
        ['div.row > a.save[aria-label="Download holiday photos.zip"]', 'div.row > a.save[aria-label]'],
        ['span.name[title="a.pdf"]', 'span.name[title]'],
        ['img.thumb[alt="a.png"]', 'img.thumb[alt]'],
        ['img[alt="a/b#c"]', 'img[alt]'],
        // What follows the attribute is the page's own structure.
        ['li > button[aria-label="Remove a.pdf"] > svg.lucide', 'li > button[aria-label] > svg.lucide'],
        ['nav[aria-label="Main"] > a.home', 'nav[aria-label] > a.home'],
        // A name holding the attribute's own end.
        ['button[aria-label="Remove a"].pdf"][type="button"]', 'button[aria-label]'],
        ['button[aria-label="Remove a"]"][type="button"]', 'button[aria-label]'],
        // A name the other peer shaped like the rest of a selector.
        ['a[aria-label="Download x"] > secret.pdf"]', 'a[aria-label]'],
        ['a[aria-label="Download x"][type="secret"]', 'a[aria-label]'],
        ['a[aria-label="Download x"] > secret.pdf[aria-label="y"]', 'a[aria-label]'],
        // A name with a line break, and one with a link in it.
        ['a[aria-label="Download a\nb.pdf"]', 'a[aria-label]'],
        ['a[aria-label="Download https://x.example/#k=1"]', 'a[aria-label]'],
        // Cut before its end, by anything between here and the SDK.
        ['button[aria-label="Remove a very long name', 'button[aria-label]'],
        // Two labeled elements: nothing between them can be told from a name.
        ['div[title="x"] > button[aria-label="y"]', 'div[title]'],
        ['div[title="x"] > button[aria-label="y"] > svg.lucide', 'div[title] > svg.lucide'],
    ];
    // Parts that are the page's own and name nobody.
    const KEPT = [
        'button.icon[type="button"]',
        'input#file[type="file"][name="upload"]',
        'body > div#main > a:nth-child(2)',
        'SelectedFilesList > button',
        'div.bg-[#fff]',
    ];

    for (const category of ['ui.click', 'ui.input']) {
        it(`a ${category} breadcrumb loses them as it is made`, () => {
            for (const [message, want] of CASES) {
                expect(scrubBreadcrumb({ category, message }).message, message).toBe(want);
            }
            for (const message of KEPT) {
                expect(scrubBreadcrumb({ category, message }).message, message).toBe(message);
            }
        });
    }

    it('keeps the component name the SDK puts beside the selector', () => {
        const crumb = { category: 'ui.click', message: 'button[aria-label="Remove a.pdf"]', data: { 'ui.component_name': 'SelectedFilesList' } };
        expect(scrubBreadcrumb(crumb)).toEqual({
            category: 'ui.click',
            message: 'button[aria-label]',
            data: { 'ui.component_name': 'SelectedFilesList' },
        });
    });

    it('an event loses them from a breadcrumb that reached it some other way', () => {
        for (const [message, want] of CASES) {
            const crumbs = () => [{ category: 'ui.click', message }];
            for (const event of [
                scrubErrorEvent({ breadcrumbs: crumbs() }),
                scrubTransactionEvent({ breadcrumbs: crumbs() }),
                scrubServerErrorEvent({ breadcrumbs: crumbs() }),
                scrubServerTransactionEvent({ breadcrumbs: crumbs() }),
            ]) {
                expect(event.breadcrumbs, message).toEqual([{ category: 'ui.click', message: want }]);
            }
        }
    });

    it('a logged element loses them too', () => {
        // normalize writes a DOM node in an event's data with htmlTreeAsString.
        const logged = '[HTMLElement: button[aria-label="Remove a.pdf"]]';
        const event = scrubErrorEvent({ breadcrumbs: [{ category: 'console', data: { arguments: [logged] } }] });
        expect(JSON.stringify(event)).not.toContain('a.pdf');
        expect(scrubBreadcrumb({ category: 'console', message: logged }).message).toBe('[HTMLElement: button[aria-label]]');
    });

    it('the selector attributes of a page load lose them', () => {
        // _setWebVitalAttributes in @sentry/browser-utils 11.8.0 writes these two
        // onto the page load's span; the standalone spans use the longer names.
        const selector = 'li > button[aria-label="Remove a.pdf"][type="button"]';
        const data = () => ({
            'lcp.element': selector,
            'cls.source.1': selector,
            'browser.web_vital.lcp.element': selector,
            'browser.web_vital.cls.source.1': selector,
            'sentry.op': 'pageload',
        });
        const want = {
            'lcp.element': 'li > button[aria-label]',
            'cls.source.1': 'li > button[aria-label]',
            'browser.web_vital.lcp.element': 'li > button[aria-label]',
            'browser.web_vital.cls.source.1': 'li > button[aria-label]',
            'sentry.op': 'pageload',
        };
        expect(scrubSpanJson({ data: data() }).data).toEqual(want);
        const out = scrubTransactionEvent({ contexts: { trace: { data: data() } }, spans: [{ data: data() }] });
        expect(out.contexts.trace.data).toEqual(want);
        expect(out.spans[0].data).toEqual(want);
        // A standalone web-vital span is named after the selector.
        expect(scrubSpanJson({ description: selector }).description).toBe('li > button[aria-label]');
    });

    it("runs on what the SDK really writes, a name holding the attribute's end included", () => {
        // The SDK's own writer, reached through the package that depends on it,
        // so a version that changes how it writes these fails here. Node has no
        // DOM, so an element is its four accessors.
        const fromNext = createRequire(createRequire(import.meta.url).resolve('@sentry/nextjs'));
        const { htmlTreeAsString } = fromNext('@sentry/browser-utils') as {
            htmlTreeAsString: (element: unknown, options?: { maxStringLength?: number }) => string;
        };
        const element = (tagName: string, className: string, attributes: Record<string, string>, parentNode: unknown) => ({
            tagName,
            id: '',
            className,
            parentNode,
            getAttribute: (name: string) => attributes[name] ?? null,
        });
        const peerName = 'x"] > secret.pdf[aria-label="y';
        const row = element('LI', 'row', {}, element('UL', 'files', {}, null));
        const button = element('BUTTON', 'icon', { 'aria-label': `Download ${peerName}`, type: 'button' }, row);
        const written = htmlTreeAsString(button, { maxStringLength: 400 });
        // Unescaped today; the rule above stands on that.
        expect(written).toBe(`ul.files > li.row > button.icon[aria-label="Download ${peerName}"][type="button"]`);
        const out = scrubBreadcrumb({ category: 'ui.click', message: written }).message;
        expect(out).toBe('ul.files > li.row > button.icon[aria-label]');
        expect(out).not.toContain('secret');
        // A long name at the default limit: the deepest element is written
        // whole, which is why a value is not cut in the middle, and the
        // ancestors that no longer fit go.
        const long = element('BUTTON', 'icon', { 'aria-label': `Remove ${'n'.repeat(300)}` }, row);
        const longWritten = htmlTreeAsString(long);
        expect(longWritten).toBe(`button.icon[aria-label="Remove ${'n'.repeat(300)}"]`);
        expect(scrubBreadcrumb({ category: 'ui.click', message: longWritten }).message).toBe('button.icon[aria-label]');
    });

    it('is idempotent', () => {
        for (const [message] of CASES) {
            const once = scrubBreadcrumb({ category: 'ui.click', message }).message;
            expect(scrubBreadcrumb({ category: 'ui.click', message: once }).message, message).toBe(once);
        }
    });

    it('never throws on a breadcrumb of an odd shape', () => {
        for (const crumb of [
            { category: 'ui.click', message: 42 },
            { category: 42, message: 'button[aria-label="a"]' },
            { category: 'ui.click' },
            null,
            'ui.click',
        ]) {
            expect(() => scrubBreadcrumb(crumb), JSON.stringify(crumb)).not.toThrow();
        }
    });
});
