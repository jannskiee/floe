// @vitest-environment jsdom
/**
 * Characterization tests for App.tsx, written against the file as it stands
 * before it is decomposed. That order is the point: a test written after a
 * move tests whatever the move produced, while one written before it is what
 * turns "I think I preserved the behavior" into something CI can arbitrate.
 *
 * Every case here is a regression detector for a hazard that is invisible to
 * tsc: effect ordering, listener balance, focus handoff, component identity.
 * None of them is a coverage exercise.
 */
import {StrictMode, act} from 'react';
import {cleanup, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import App from '../App';
// The generated declarations as text, through Vite's raw import (the frontend
// carries no Node types, so no fs).
import appDts from '../../wailsjs/go/main/App.d.ts?raw';
import {AnswerRequest, GetRequestLink, MakeRequestLink, RequestLinkSupport} from '../../wailsjs/go/main/App';
import {REQUEST_BINDINGS, offSnapshot} from './requestFixtures';
import {closingPeriods} from './punctuation';

// main.tsx wraps App in StrictMode, so the tests do too. Not ceremony:
// StrictMode double-invokes effects, which is what turns the balance assertion
// below from "counts 11" into "catches a handler registered twice and torn
// down once".
const mount = () => render(<StrictMode><App /></StrictMode>);

const settled = () => waitFor(() => expect(wails.listeners.size).toBe(15));

describe('the mount effect', () => {
    it('registers every Go listener and tears down every one', async () => {
        const {unmount} = mount();
        await settled();

        // Not a hand-copied list for its own sake: the assertion is that OFF
        // mirrors ON, whatever ON turns out to be.
        // The verification pair and the request pair belong to effects that sit
        // after this one, each with its own teardown; the balance assertion
        // below covers all of them.
        expect([...wails.listeners.keys()].sort()).toEqual([
            'close:blocked',
            'files:open',
            'recv:file-done',
            'recv:incoming',
            'recv:progress',
            'recv:route',
            'request:progress',
            'request:state',
            'send:code',
            'send:delivered',
            'send:done',
            'send:error',
            'send:progress',
            'send:route',
            'send:status',
        ]);
        expect(wails.drop).not.toBeNull();

        unmount();

        // The real assertion. Under StrictMode the effect has already run
        // mount / cleanup / mount, so a handler registered twice and torn down
        // once survives here with a non-empty set.
        expect([...wails.listeners.keys()]).toEqual([]);
        expect(wails.drop).toBeNull();

        const ons = wails.calls.filter((c) => c.startsWith('on:'));
        const offs = wails.calls.filter((c) => c.startsWith('off:'));
        expect(offs.length).toBe(ons.length);
    });

    // FT-03b (H7 S-1): no switch, so the lane's two events and the
    // GetRequestLink pull register at launch. They are Wails events and a call
    // into Go, not network traffic: nothing asks a server before Make link.
    it('launch registers request listeners and pulls GetRequestLink but asks no server (FT-03b)', async () => {
        mount();
        await settled();
        await waitFor(() => expect(wails.go.GetSettings).toHaveBeenCalled());
        await waitFor(() => expect(wails.go.GetRequestLink).toHaveBeenCalled());
        // Let the GetSettings promise and every effect it schedules settle.
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

        expect([...wails.listeners.keys()].filter((k) => k.startsWith('request:')).sort()).toEqual(['request:progress', 'request:state']);
        for (const name of REQUEST_BINDINGS) {
            if (name === 'GetRequestLink') continue;
            expect(wails.go[name], name).not.toHaveBeenCalled();
        }
        // Nor does it write anything of its own to storage (review F4).
        expect(Object.keys(localStorage).filter((k) => k.startsWith('floe:request'))).toEqual([]);
    });

    it('the Request link tab and its BETA chip show at launch', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);

        const tab = await screen.findByRole('button', {name: 'Request link, beta'});
        expect(tab.getAttribute('aria-pressed')).toBe('false');
        const chip = screen.getByText('Beta', {selector: 'span'});
        expect(chip.getAttribute('aria-hidden')).toBe('true');
        expect(chip.parentElement!.contains(tab)).toBe(true);
        // Seeing the tab asked no server anything.
        expect(wails.go.RequestLinkSupport).not.toHaveBeenCalled();
    });

    // The default stub answers Make link the way a server with its kill switch
    // on does (disabled). Make link is the authority: the sentence shows under
    // the button, the tab stays, and the form stays usable.
    it('a server that lists no request-1: Make link shows E1 under the button and the tab stays', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));
        const make = screen.getByRole('button', {name: 'Make link'});
        await user.click(make);

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('Request links are off on this server');
        expect(make.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Request link, beta'}).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', {name: 'Make link'})).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Copy link'})).toBeNull();
        expect(wails.go.RequestLinkSupport).not.toHaveBeenCalled();
    });

    it('an unreachable server: Make link shows E4 and the tab stays', async () => {
        wails.go.MakeRequestLink.mockImplementation(async () => ({...offSnapshot, gen: 1, seq: 1, state: 'error', code: 'unknown'}));
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));
        await user.click(screen.getByRole('button', {name: 'Make link'}));

        expect((await screen.findByRole('alert')).textContent).toBe("Couldn't make a link");
        expect(screen.getByRole('button', {name: 'Request link, beta'})).toBeTruthy();
    });

    it('remembers the request save folder only when the owner chooses one', async () => {
        wails.go.SelectFolder.mockImplementation(async () => 'D:\\Footage\\Floe requests');
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));
        expect(localStorage.getItem('floe:requestSaveDir')).toBeNull();
        await user.click(screen.getByRole('button', {name: /Browse/}));
        await waitFor(() => expect(localStorage.getItem('floe:requestSaveDir')).toBe('D:\\Footage\\Floe requests'));
        // Emptying the field forgets it.
        await user.clear(screen.getByLabelText('Save to'));
        expect(localStorage.getItem('floe:requestSaveDir')).toBeNull();
    });

    it('asks for pending files only after files:open is listening', async () => {
        mount();
        await waitFor(() => expect(wails.calls).toContain('GetPendingFiles'));

        // A second launch that forwards paths in the window between these two
        // calls is dropped if they ever swap, and nothing else would notice.
        expect(wails.calls.indexOf('on:files:open')).toBeLessThan(
            wails.calls.indexOf('GetPendingFiles')
        );
    });
});

describe('the settings screen', () => {
    it('keeps one input alive across a whole typed address', async () => {
        const user = userEvent.setup();
        mount();
        await settled();

        await user.click(screen.getByRole('button', {name: 'Settings'}));

        const field = await screen.findByLabelText('Server address');
        field.focus();
        await user.type(field, 'http://localhost:3001');

        // If the settings screen ever becomes a component DECLARED INSIDE
        // App(), its type identity changes on every render, React unmounts the
        // subtree and mounts a fresh one, and this reference is stale after the
        // first keystroke. Caret-to-end is the visible symptom; node identity
        // is the cause, and it is the thing a remount cannot fake.
        expect(screen.getByLabelText('Server address')).toBe(field);
        expect(document.activeElement).toBe(field);
        expect((field as HTMLInputElement).value).toBe('http://localhost:3001');

        // The share-link field re-renders on every server keystroke, because
        // its placeholder is derived from the server address. It is the more
        // likely of the two to be remounted, so it is asserted separately.
        const web = screen.getByLabelText('Share link address');
        web.focus();
        await user.type(web, 'https://x.test');
        expect(screen.getByLabelText('Share link address')).toBe(web);
        expect(document.activeElement).toBe(web);
    });
});

describe('the close guard', () => {
    it('raises on close:blocked and does not dismiss itself on confirm', async () => {
        const user = userEvent.setup();
        mount();
        await settled();

        act(() => {
            wails.emit('close:blocked');
        });
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Close Floe?')).toBeTruthy();

        await user.click(within(dialog).getByRole('button', {name: 'Close'}));
        expect(wails.go.ConfirmClose).toHaveBeenCalledTimes(1);

        // The dialog stays up. Go owns the exit, and clearing it here would
        // show the live UI for the duration of teardown.
        expect(screen.getByRole('dialog')).toBeTruthy();

        // A second event cannot stack dialogs.
        act(() => {
            wails.emit('close:blocked');
        });
        expect(screen.getAllByRole('dialog')).toHaveLength(1);

        // Keep open is the only local dismissal, and it hands focus off.
        await user.click(within(dialog).getByRole('button', {name: 'Keep open'}));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() =>
            expect(document.activeElement).toBe(document.getElementById('floe-lockup'))
        );
    });
});

describe('the once-registered handlers', () => {
    it('send:error still reads the current server address', async () => {
        const user = userEvent.setup();
        mount();
        await settled();

        await user.click(screen.getByRole('button', {name: 'Settings'}));
        const field = await screen.findByLabelText('Server address');
        field.focus();
        await user.type(field, 'http://localhost:3001');
        await user.click(screen.getByRole('button', {name: 'Back'}));

        act(() => {
            wails.emit('send:error', 'connection closed');
        });

        // serverNote reads serverAddrRef.current precisely because this handler
        // was registered once, at mount, with the first render's closure. A
        // decomposition that reads the serverAddr STATE under an empty
        // dependency array loses the sentence with no crash and no type error,
        // and this is the only thing that would notice.
        expect(
            await screen.findByText(/ · Both people must use localhost:3001$/)
        ).toBeTruthy();
    });

    it('send:status reaches the send view through its frozen closure', async () => {
        mount();
        await settled();

        act(() => {
            wails.emit('send:status', 'Sending...');
        });

        // The handler is registered once, at mount. It reads sendCancel.current
        // and calls only stable setters, which is the discipline that makes the
        // whole mount effect correct; a decomposition that reads state here
        // under an empty dependency array sees a value frozen at first render.
        expect(await screen.findByText('Sending...')).toBeTruthy();
    });
});

describe('the route badge', () => {
    it('goes back to green when a relayed send finishes', async () => {
        const {container} = mount();
        await settled();

        // StatusDot renders two spans; the solid one is h-1.5 w-1.5. Matching
        // on rounded-full alone also picks up the left rail's ambient glow.
        const dot = () => container.querySelector('span.h-1\\.5.w-1\\.5.rounded-full');
        act(() => {
            wails.emit('send:route', 'relay');
        });
        await waitFor(() => expect(dot()?.className).toContain('bg-amber-500'));

        act(() => {
            wails.emit('send:done');
        });

        // relayTone reads route while idle, so a finished relayed transfer used
        // to leave an amber dot beside the word Ready.
        await waitFor(() => expect(dot()?.className).toContain('bg-green-500'));
        expect(dot()?.className).not.toContain('bg-amber-500');
    });
});

/**
 * The verification effect. Its two listeners sit in their own effect after the
 * mount effect, and their counters are refs, so the handlers registered once at
 * mount keep counting correctly instead of reading a first-render value.
 */
describe('the verification line', () => {
    it('shows SHA-256 matched after send:delivered with every file verified, and nothing otherwise', async () => {
        mount();
        await settled();

        act(() => {
            wails.emit('send:done');
            wails.emit('send:delivered', {files: 2, verified: 2, hasVerified: true});
        });
        // The words are for screen readers now: a green circle-check sits
        // where the done row's plain check was, and no line says them (D-161).
        const sr = await screen.findByText('SHA-256 matched');
        expect(sr.className).toBe('sr-only');
        const row = sr.parentElement!;
        expect(row.textContent).toContain('Sent ');
        const glyph = row.querySelector('svg.lucide-circle-check')!;
        expect(glyph.getAttribute('aria-hidden')).toBe('true');
        expect(glyph.getAttribute('class')).toContain('text-green-500');
        expect(row.querySelector('svg.lucide-check')).toBeNull();
        // Reading order (RC-4): a screen reader hears "Sent 2 items" first and
        // the words after it, while the glyph still leads the row on screen.
        const sentText = screen.getByText(/^Sent \d+ items?$/);
        expect(sentText.compareDocumentPosition(sr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(glyph.getAttribute('class')).toContain('order-first');

        // A short count is not a match, and a count the validator refused
        // (hasVerified false) is absent, never "all matched": the row keeps
        // a plain, quiet check and nothing else.
        act(() => {
            wails.emit('send:delivered', {files: 2, verified: 1, hasVerified: true});
        });
        await waitFor(() => expect(screen.queryByText('SHA-256 matched')).toBeNull());
        const quiet = screen.getByText(/^Sent \d+ items?$/).parentElement!;
        expect(quiet.querySelector('svg.lucide-circle-check')).toBeNull();
        expect(quiet.querySelector('svg.lucide-check')!.getAttribute('class')).toContain('text-zinc-500');
        expect(quiet.querySelector('svg.lucide-check')!.getAttribute('class')).toContain('order-first');

        act(() => {
            wails.emit('send:delivered', {files: 2, verified: 2, hasVerified: false});
        });
        await waitFor(() => expect(screen.queryByText('SHA-256 matched')).toBeNull());
        expect(document.querySelector('svg.lucide-circle-check')).toBeNull();
    });

    it('shows SHA-256 matched after a receive whose every recv:file-done was verified, and resets on the next receive', async () => {
        let finish!: (dir: string) => void;
        wails.go.ReceiveByCode.mockImplementation(
            () => new Promise<string>((resolve) => { finish = resolve; })
        );
        const user = userEvent.setup();
        mount();
        await settled();

        // Two buttons say Receive: the mode tab and the action below it. The
        // action is the full-width one.
        const named = () => screen.getAllByRole('button', {name: 'Receive'});
        const start = () => named().find((b) => b.className.includes('w-full'))!;
        await user.click(named()[0]);
        await user.type(screen.getByPlaceholderText('amber-otter-cloud'), 'amber-otter-cloud');
        await user.click(start());

        act(() => {
            wails.emit('recv:file-done', {savedName: 'a.bin', bytes: 10, verified: true});
            wails.emit('recv:file-done', {savedName: 'b.bin', bytes: 20, verified: true});
        });
        await act(async () => { finish('C:\\dl'); });
        // Words for screen readers only; the saved row's check turns into the
        // green circle-check, and the line of words is gone (D-161).
        const sr = await screen.findByText('SHA-256 matched');
        expect(sr.className).toBe('sr-only');
        const row = sr.parentElement!;
        expect(row.textContent).toContain('Saved to C:\\dl');
        expect(row.querySelector('svg.lucide-circle-check')!.getAttribute('class')).toContain('text-green-500');
        expect(row.querySelector('svg.lucide-check')).toBeNull();
        // Reading order (RC-4): "Saved to ..." comes before the words, and the
        // glyph still leads the row on screen.
        const savedText = screen.getByText('Saved to C:\\dl');
        expect(savedText.compareDocumentPosition(sr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(row.querySelector('svg.lucide-circle-check')!.getAttribute('class')).toContain('order-first');

        // A second receive starts from nothing: the counters are reset in
        // receive(), so the previous transfer's verdict cannot carry over.
        await user.click(start());
        await waitFor(() => expect(screen.queryByText('SHA-256 matched')).toBeNull());
        expect(document.querySelector('svg.lucide-circle-check')).toBeNull();
    });

    it('keeps a quiet check on a receive that was not verified (a peer that sends no checksums)', async () => {
        let finish!: (dir: string) => void;
        wails.go.ReceiveByCode.mockImplementation(
            () => new Promise<string>((resolve) => { finish = resolve; })
        );
        const user = userEvent.setup();
        mount();
        await settled();
        const named = () => screen.getAllByRole('button', {name: 'Receive'});
        await user.click(named()[0]);
        await user.type(screen.getByPlaceholderText('amber-otter-cloud'), 'amber-otter-cloud');
        await user.click(named().find((b) => b.className.includes('w-full'))!);
        act(() => {
            wails.emit('recv:file-done', {savedName: 'a.bin', bytes: 10, verified: true});
            wails.emit('recv:file-done', {savedName: 'b.bin', bytes: 20, verified: false});
        });
        await act(async () => { finish('C:\\dl'); });
        const saved = await screen.findByText('Saved to C:\\dl');
        const row = saved.parentElement!;
        expect(screen.queryByText(/SHA-256/)).toBeNull();
        expect(row.querySelector('svg.lucide-circle-check')).toBeNull();
        expect(row.querySelector('svg.lucide-check')!.getAttribute('class')).toContain('text-zinc-500');
    });
});

describe('the history store', () => {
    it('does not overwrite a corrupt store on mount', async () => {
        localStorage.setItem('floe:history', '{not json');
        mount();
        await settled();
        // Let every mount effect, including the persist one, run.
        await waitFor(() => expect(wails.calls).toContain('GetPendingFiles'));

        // loadHistory swallows the parse error and returns [], and the persist
        // effect used to fire on mount and write that [] straight back over the
        // bytes. The store is documented as user-editable, so they were
        // recoverable right up until that ran.
        expect(localStorage.getItem('floe:history')).toBe('{not json');
    });
});

describe('the progress label', () => {
    // Drives the real send:progress path, so it covers track() as well as the
    // two formatters. Date.now is stubbed rather than the timers faked: track
    // derives speed from Date.now deltas, and faking timers would also stall
    // testing-library's waitFor.
    it('matches the web and CLI on sub-megabyte speed and multi-hour ETA', async () => {
        let now = 1_700_000_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            mount();
            await settled();

            const prog = (totalBytes: number) => ({
                fileName: 'big.bin',
                fileIndex: 1,
                fileCount: 1,
                fileBytes: totalBytes,
                fileSize: 20_000_000,
                totalBytes,
                grandTotal: 20_000_000,
                savedName: '',
            });

            // The first event sets the marker; no rate is known yet.
            act(() => wails.emit('send:progress', prog(0)));
            // 5000 bytes in 10s is 500 B/s, and the 19,995,000 left at that rate
            // is 39,990s.
            now += 10_000;
            act(() => wails.emit('send:progress', prog(5000)));

            const label = await screen.findByText(/big\.bin/);
            // toFixed(0) on the KB branch printed "0 KB/s" here, while bytes
            // were still moving. The web and the CLI both print one decimal.
            expect(label.textContent).toContain('0.5 KB/s');
            // Without the hours branch this read "666m 30s".
            expect(label.textContent).toContain('ETA 11h 6m');
        } finally {
            clock.mockRestore();
        }
    });
});

/**
 * Smoke renders for the two views nothing has ever mounted.
 *
 * Every existing test in this file leaves `mode` at its 'send' default, so the
 * receive console and the history console have no render coverage of any kind.
 * That matters because they are next in line to be extracted into top-level
 * components, and a JSX move that silently dropped a branch would take the
 * whole suite green with it.
 *
 * These are deliberately shallow. They assert that each view mounts and shows
 * the controls that make it that view, which is what a bad extraction breaks;
 * they do not try to cover behavior the views do not have tests for today.
 */
describe('the views no other test mounts', () => {
    it('renders the receive console when the Receive tab is chosen', async () => {
        mount();
        await settled();

        await userEvent.click(screen.getByRole('button', {name: 'Receive'}));

        // The code field is the view: placeholder, not label, because the
        // Eyebrow above it is not associated with the input.
        expect(
            screen.getByPlaceholderText('amber-otter-cloud')
        ).toBeInstanceOf(HTMLInputElement);
        // And the save-folder field, which is the half that reads a real path.
        expect(screen.getByPlaceholderText('Downloads (default)')).toBeTruthy();
    });

    it('renders the history console, empty and populated', async () => {
        localStorage.setItem(
            'floe:history',
            JSON.stringify([
                {kind: 'recv', names: ['report.pdf'], count: 1, at: Date.now(), bytes: 1024},
            ])
        );
        mount();
        await settled();

        await userEvent.click(screen.getByRole('button', {name: 'History'}));

        // A seeded row must actually reach the list. Asserting only the empty
        // state would pass against a view that renders nothing at all.
        expect(await screen.findByText('report.pdf')).toBeTruthy();
        expect(screen.queryByText('No transfers yet')).toBeNull();
    });

    it('shows the empty state when there is no history', async () => {
        mount();
        await settled();

        await userEvent.click(screen.getByRole('button', {name: 'History'}));

        expect(await screen.findByText('No transfers yet')).toBeTruthy();
    });
});

/**
 * Written before the history view left App.tsx, and kept because it is the
 * only detector of the one trap that move can fall into. A component DECLARED
 * INSIDE App() is a new type on every render, so React unmounts and remounts
 * the whole list on every unrelated state change, recv:progress included, and
 * the expanded row and any focus collapse with it. A standalone HistoryView
 * test cannot see that: it mounts the component once and never re-renders
 * App. Only App can, by holding a row across a tick that re-renders it.
 */
describe('the history view', () => {
    it('keeps its rows mounted across a recv:progress tick', async () => {
        localStorage.setItem(
            'floe:history',
            JSON.stringify([
                {kind: 'recv', names: ['report.pdf'], count: 1, at: Date.now(), bytes: 1024},
            ])
        );
        mount();
        await settled();

        await userEvent.click(screen.getByRole('button', {name: 'History'}));
        const row = await screen.findByText('report.pdf');
        const list = row.closest('ul');
        expect(list).not.toBeNull();

        // recv:progress sets recvProg, which re-renders App and with it the
        // history branch. It is the event that fires most often while this
        // view is on screen, so it is the one a remount would show up under.
        act(() => {
            wails.emit('recv:progress', {
                fileName: 'big.bin',
                fileIndex: 1,
                fileCount: 1,
                fileBytes: 0,
                fileSize: 20_000_000,
                totalBytes: 0,
                grandTotal: 20_000_000,
                savedName: '',
            });
        });

        // The same DOM nodes, not merely the same text: a remount renders
        // identical markup, and identity is the only thing that tells the two
        // apart.
        expect(screen.getByText('report.pdf')).toBe(row);
        expect(row.closest('ul')).toBe(list);
    });
});

/**
 * The Wails mock in setup.ts is hand-written, so it can fall behind the
 * generated bindings. A binding with no mock surfaces as an unrelated-looking
 * "Cannot read properties of undefined" inside whichever effect calls it first.
 */
describe('the Wails mock', () => {
    it('mocks every binding App.d.ts exports', () => {
        const exported = [...appDts.matchAll(/^export function (\w+)\(/gm)].map((m) => m[1]);
        expect(exported.length).toBeGreaterThan(0);
        expect(exported.filter((name) => !(name in wails.go))).toEqual([]);
        for (const name of REQUEST_BINDINGS) expect(exported).toContain(name);
    });

    // Through the generated shims, so the mock answers the way the Go stubs do
    // (requestlink.go) at the call sites App.tsx will use: nothing is
    // available and nothing reports a success.
    it('answers every request binding with a disabled or not-available result', async () => {
        await expect(MakeRequestLink('Acme footage', '', '24h', false)).resolves.toMatchObject({state: 'error', code: 'disabled'});
        await expect(GetRequestLink()).resolves.toMatchObject({state: 'off', link: ''});
        await expect(AnswerRequest(1, 'accept')).resolves.toMatchObject({state: 'off'});
        await expect(RequestLinkSupport()).resolves.toEqual({reachable: false, requestLinks: false});
    });
});

/**
 * Settings has no request-links switch (H7 S-1, D-160): the lane is always
 * there, and Make link is the authority about the server.
 */
describe('Settings has no Beta section (S-1)', () => {
    it('Settings has no Beta section', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));

        const headings = screen.getAllByRole('heading', {level: 3}).map((h) => h.textContent);
        expect(headings).toEqual(['Transfers', 'Notifications', 'Privacy', 'Windows', 'Advanced', 'About']);
        expect(screen.queryByRole('checkbox', {name: /^Request links/})).toBeNull();
        // Opening Settings asks no server about request links either.
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        expect(wails.go.RequestLinkSupport).not.toHaveBeenCalled();
    });
});

/**
 * Settings > Notifications (H7 S-11, D-162): Show notifications, Play sound
 * (dimmed while the first is off) and, on Windows, a row that opens Windows'
 * own notification settings. Each switch is Go-owned: set optimistically, call
 * the setter, put it back if the setter throws.
 */
describe('Settings > Notifications (S-11)', () => {
    const NS3 = 'For requests and transfers while Floe is in the background';
    const NS4 = 'Requests still flash Floe on the taskbar';
    const showSwitch = () => screen.getByRole('checkbox', {name: /^Show notifications/}) as HTMLInputElement;
    const soundSwitch = () => screen.getByRole('checkbox', {name: 'Play sound'}) as HTMLInputElement;
    const withToasts = (noToasts: boolean, silentToasts: boolean) => {
        wails.go.GetSettings.mockImplementation(async () => ({
            server: '', web: '', hideIP: false, reportStats: true, noUpdateCheck: false, noToasts, silentToasts, migrated: true,
        }));
    };
    async function openSettings() {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));
        return user;
    }

    it('Notifications sits after Transfers', async () => {
        await openSettings();
        const headings = screen.getAllByRole('heading', {level: 3}).map((h) => h.textContent);
        expect(headings).toEqual(['Transfers', 'Notifications', 'Privacy', 'Windows', 'Advanced', 'About']);
        expect(showSwitch().checked).toBe(true);
        expect(soundSwitch().checked).toBe(true);
        expect(screen.getByText(NS3)).toBeTruthy();
        expect(screen.queryByText(NS4)).toBeNull();
    });

    it('Show notifications off calls SetToasts(false), swaps the description and dims Play sound', async () => {
        const user = await openSettings();
        await user.click(showSwitch());

        await waitFor(() => expect(wails.go.SetToasts).toHaveBeenCalledWith(false));
        expect(showSwitch().checked).toBe(false);
        expect(screen.getByText(NS4)).toBeTruthy();
        expect(screen.queryByText(NS3)).toBeNull();
        // Dimmed, not hidden, and the sound keeps the value it had.
        expect(soundSwitch().disabled).toBe(true);
        expect(soundSwitch().checked).toBe(true);
        expect(soundSwitch().closest('label')?.getAttribute('aria-disabled')).toBe('true');
        // Nothing else was written: the whole-record save is not this switch's.
        expect(wails.go.SetSettings).not.toHaveBeenCalled();
        expect(wails.go.SetToastSound).not.toHaveBeenCalled();
    });

    it('a disabled Play sound ignores clicks', async () => {
        const user = await openSettings();
        await user.click(showSwitch());
        await waitFor(() => expect(showSwitch().checked).toBe(false));
        await user.click(soundSwitch());
        expect(wails.go.SetToastSound).not.toHaveBeenCalled();
        expect(soundSwitch().checked).toBe(true);
    });

    it('a refused SetToasts reverts the switch', async () => {
        wails.go.SetToasts.mockRejectedValueOnce(new Error('disk full'));
        const user = await openSettings();
        await user.click(showSwitch());

        await waitFor(() => expect(wails.go.SetToasts).toHaveBeenCalledWith(false));
        await waitFor(() => expect(showSwitch().checked).toBe(true));
        expect(soundSwitch().disabled).toBe(false);
        expect(screen.getByText(NS3)).toBeTruthy();
    });

    it('Play sound calls SetToastSound(false), and a refusal reverts it', async () => {
        const user = await openSettings();
        await user.click(soundSwitch());
        await waitFor(() => expect(wails.go.SetToastSound).toHaveBeenCalledWith(false));
        expect(soundSwitch().checked).toBe(false);
        expect(wails.go.SetToasts).not.toHaveBeenCalled();

        wails.go.SetToastSound.mockRejectedValueOnce(new Error('disk full'));
        await user.click(soundSwitch());
        await waitFor(() => expect(wails.go.SetToastSound).toHaveBeenCalledWith(true));
        await waitFor(() => expect(soundSwitch().checked).toBe(false));
    });

    it('Open passes ms-settings:notifications to BrowserOpenURL', async () => {
        const user = await openSettings();
        expect(screen.getByText('Windows notification settings')).toBeTruthy();
        expect(screen.getByText('Banners, Notification Center and lock screen')).toBeTruthy();
        const open = (window as unknown as {runtime: {BrowserOpenURL: ReturnType<typeof vi.fn>}}).runtime.BrowserOpenURL;
        const button = screen.getByRole('button', {name: 'Open Windows notification settings'});
        expect(button.textContent).toBe('Open');
        await user.click(button);
        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith('ms-settings:notifications');
    });

    it('noToasts and silentToasts load into the switches', async () => {
        withToasts(true, true);
        await openSettings();
        await waitFor(() => expect(showSwitch().checked).toBe(false));
        expect(soundSwitch().checked).toBe(false);
        expect(soundSwitch().disabled).toBe(true);
        expect(screen.getByText(NS4)).toBeTruthy();
    });

    it('a silent-only config loads as notifications on and sound off', async () => {
        withToasts(false, true);
        await openSettings();
        await waitFor(() => expect(soundSwitch().checked).toBe(false));
        expect(showSwitch().checked).toBe(true);
        expect(soundSwitch().disabled).toBe(false);
    });

    it('Reset turns notifications and sound back on and the dialog names notifications', async () => {
        withToasts(true, true);
        const user = await openSettings();
        await waitFor(() => expect(showSwitch().checked).toBe(false));

        await user.click(screen.getByRole('button', {name: 'Reset'}));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Save folder, notifications, privacy and server settings go back to defaults')).toBeTruthy();
        await user.click(within(dialog).getByRole('button', {name: 'Reset all settings'}));

        await waitFor(() => expect(wails.go.SetToasts).toHaveBeenCalledWith(true));
        expect(wails.go.SetToastSound).toHaveBeenCalledWith(true);
        await waitFor(() => expect(showSwitch().checked).toBe(true));
        expect(soundSwitch().checked).toBe(true);
        expect(soundSwitch().disabled).toBe(false);
    });

    it('a reset that fails part way re-pulls the notification switches', async () => {
        withToasts(true, true);
        const user = await openSettings();
        await waitFor(() => expect(showSwitch().checked).toBe(false));

        // SetToasts(true) lands and SetToastSound(true) is refused: the screen
        // must show what is on disk (notifications on, sound still off).
        wails.go.SetToastSound.mockRejectedValueOnce(new Error('disk full'));
        withToasts(false, true);
        await user.click(screen.getByRole('button', {name: 'Reset'}));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', {name: 'Reset all settings'}));

        await waitFor(() => expect(wails.go.SetToastSound).toHaveBeenCalledWith(true));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Cancel'}));
        await waitFor(() => expect(showSwitch().checked).toBe(true));
        expect(soundSwitch().checked).toBe(false);
    });
});

/**
 * A request link pasted into Receive > CODE (S1-DSK-07, VR3-D06). The link is
 * for a web browser; Floe must say so and must never start a code receive,
 * which would claim a transfer and toast a failure.
 */
describe('a request link pasted into CODE', () => {
    const room = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const link = `http://localhost:3000/r/Xk3p9Q0aB1c#${room}`;
    const cp2 = 'Request links open in a web browser';
    const receiveTab = () => screen.getAllByRole('button', {name: 'Receive'})[0];
    const receiveAction = () => screen.getAllByRole('button', {name: 'Receive'}).find((b) => b.className.includes('w-full'))!;

    async function paste(value: string) {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(receiveTab());
        await user.type(screen.getByPlaceholderText('amber-otter-cloud'), value);
        await user.click(receiveAction());
        return user;
    }

    it('request link pasted into CODE shows the sentence and never calls ReceiveByCode', async () => {
        await paste(link);
        expect(await screen.findByText(cp2)).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Open in browser'})).toBeTruthy();
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();
        // Nothing was started, so there is nothing to cancel.
        expect(screen.queryByRole('button', {name: 'Cancel'})).toBeNull();
    });

    it('a floe.one request link and a drop link show the same sentence, and editing clears it', async () => {
        await paste(`https://floe.one/r/Xk3p9Q0aB1c#${room}`);
        expect(await screen.findByText(cp2)).toBeTruthy();
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();

        // A drop link too, and Enter in the field takes the same path.
        const field = screen.getByPlaceholderText('amber-otter-cloud');
        await userEvent.clear(field);
        expect(screen.queryByText(cp2)).toBeNull(); // editing clears it
        await userEvent.type(field, 'https://floe.one/drop/aBcD1234{Enter}');
        expect(await screen.findByText(cp2)).toBeTruthy();
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();
    });

    it('Open in browser passes the pasted link to BrowserOpenURL', async () => {
        const user = await paste(link);
        await user.click(await screen.findByRole('button', {name: 'Open in browser'}));
        const open = (window as unknown as {runtime: {BrowserOpenURL: ReturnType<typeof vi.fn>}}).runtime.BrowserOpenURL;
        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith(link);
    });

    it('a link pasted without its scheme, or in quotes, keeps Open in browser and opens over https (A3-B7)', async () => {
        const user = await paste(`"floe.one/r/Xk3p9Q0aB1c#${room}"`);
        await user.click(await screen.findByRole('button', {name: 'Open in browser'}));
        const open = (window as unknown as {runtime: {BrowserOpenURL: ReturnType<typeof vi.fn>}}).runtime.BrowserOpenURL;
        expect(open).toHaveBeenCalledWith(`https://floe.one/r/Xk3p9Q0aB1c#${room}`);
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();
    });

    it('a normal #room= link still calls ReceiveByCode', async () => {
        await paste(`http://localhost:3000/?s=abc#room=${room}`);
        await waitFor(() => expect(wails.go.ReceiveByCode).toHaveBeenCalledTimes(1));
        expect(screen.queryByText(cp2)).toBeNull();
    });

    it('a three-word code still calls ReceiveByCode', async () => {
        await paste('amber-otter-cloud');
        await waitFor(() => expect(wails.go.ReceiveByCode).toHaveBeenCalledWith('amber-otter-cloud', '', false, true));
        expect(screen.queryByText(cp2)).toBeNull();
    });
});

/**
 * Receive > REQUEST LINK in the app (S1-DSK-06): the events' own effect, the
 * row rules, the Receive tab's description, the close guard and Start over
 * copy, and the next-launch line. Go's side is the mock: a test plays the lane
 * by emitting request:state snapshots.
 */
describe('the request link in the app', () => {
    const GB = 1024 ** 3;
    const LINK = 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const base = {
        code: '', gen: 1, promptGen: 0, link: LINK, label: 'Acme footage', saveDir: 'D:\\Footage\\Floe requests',
        expiresAt: Date.now() + 3600_000, route: '', suggestClose: false,
    };
    const lane = (state: string, over: Record<string, unknown> = {}) => ({...base, state, ...over});
    const prompt = {files: 12, totalBytes: 38 * GB, folder: 'Floe requests\\Acme footage 2026-09-14 1405', freeBytes: 500 * GB, warnings: [], answerBy: Date.now() + 9 * 60000};

    function withHideIP(hideIP: boolean) {
        wails.go.GetSettings.mockImplementation(async () => ({
            server: '', web: '', hideIP, reportStats: true, noUpdateCheck: false, migrated: true,
        }));
    }
    const push = (s: Record<string, unknown>) => act(() => { wails.emit('request:state', s); });
    const receiveTab = () => screen.getAllByRole('button', {name: 'Receive'})[0];
    const requestButton = () => screen.getByRole('button', {name: 'Request link, beta'});

    it('registers every Go listener and tears down every one, the request events included', async () => {
        const {unmount} = mount();
        await settled();
        expect([...wails.listeners.keys()].sort()).toEqual([
            'close:blocked', 'files:open', 'recv:file-done', 'recv:incoming', 'recv:progress', 'recv:route',
            'request:progress', 'request:state',
            'send:code', 'send:delivered', 'send:done', 'send:error', 'send:progress', 'send:route', 'send:status',
        ]);
        unmount();
        expect([...wails.listeners.keys()]).toEqual([]);
        const ons = wails.calls.filter((c) => c.startsWith('on:'));
        const offs = wails.calls.filter((c) => c.startsWith('off:'));
        expect(offs.length).toBe(ons.length);
    });

    it('the mount effect keeps its 11 listeners', async () => {
        mount();
        await settled();
        // Effects run in declaration order, so the first eleven registrations
        // are the mount effect's, and they are exactly the original eleven;
        // the verification pair and the request pair come after, each from
        // its own effect.
        const ons = wails.calls.filter((c) => c.startsWith('on:')).map((c) => c.slice(3));
        expect(ons.slice(0, 11)).toEqual([
            'send:code', 'send:status', 'send:progress', 'send:done', 'send:error', 'recv:incoming',
            'recv:progress', 'send:route', 'recv:route', 'files:open', 'close:blocked',
        ]);
        expect(ons.slice(11, 13)).toEqual(['recv:file-done', 'send:delivered']);
        expect(ons.indexOf('request:state')).toBeGreaterThan(12);
        expect(wails.go.GetRequestLink).toHaveBeenCalled();
    });

    it('the tab stays while a drop runs and after its result is put away', async () => {
        mount();
        await settled();
        await userEvent.click(receiveTab());
        await waitFor(() => expect(requestButton()).toBeTruthy());
        push(lane('receiving', {gen: 2, route: 'direct'}));

        await userEvent.click(screen.getByRole('button', {name: 'Send'}));
        await userEvent.click(receiveTab());
        expect(requestButton()).toBeTruthy();
        expect(screen.getByText(/RECEIVING/)).toBeTruthy();

        // Once the drop is over and put away the tab is still there: nothing
        // decides it but Make link (H7 S-1), and no probe ran.
        push(lane('done', {gen: 2, result: {files: 1, saved: 1, bytes: 1, verified: 1, renamed: 0, folder: 'D:\\x', names: ['a']}}));
        await userEvent.click(screen.getByRole('button', {name: 'Make another link'}));
        expect(await screen.findByRole('button', {name: 'Make link'})).toBeTruthy();
        expect(requestButton()).toBeTruthy();
        expect(wails.go.RequestLinkSupport).not.toHaveBeenCalled();
    });

    it('CODE and REQUEST LINK use aria-pressed', async () => {
        mount();
        await settled();
        await userEvent.click(receiveTab());
        const code = await screen.findByRole('button', {name: 'Code'});
        expect(code.getAttribute('aria-pressed')).toBe('true');
        expect(requestButton().getAttribute('aria-pressed')).toBe('false');
        await userEvent.click(requestButton());
        expect(screen.getByRole('button', {name: 'Code'}).getAttribute('aria-pressed')).toBe('false');
        expect(requestButton().getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', {name: 'Make link'})).toBeTruthy();
        // The Beta chip sits outside the pair, and is silent (R3 already says beta).
        const chip = screen.getByText('Beta', {selector: 'span'});
        expect(chip.getAttribute('aria-hidden')).toBe('true');
    });

    it('the Beta chip sits right beside REQUEST LINK, apart from CODE', async () => {
        mount();
        await settled();
        await userEvent.click(receiveTab());
        const chip = await screen.findByText('Beta', {selector: 'span'});
        // The owner's 2026-09-23 look: the chip belongs to its label, on the
        // words' baseline with a small gap, not to the row's CODE gap.
        const pair = chip.parentElement!;
        expect(pair.contains(requestButton())).toBe(true);
        expect(pair.contains(screen.getByRole('button', {name: 'Code'}))).toBe(false);
        expect(pair.className.split(' ')).toEqual(expect.arrayContaining(['items-baseline', 'gap-1']));
        expect(chip.className).not.toMatch(/\bml-/);
    });

    it('the Ready view has no helper line above the form (R4, cut by the owner)', async () => {
        mount();
        await settled();
        await userEvent.click(receiveTab());
        await userEvent.click(requestButton());
        expect(screen.getByRole('button', {name: 'Make link'})).toBeTruthy();
        expect(screen.queryByText(/A link someone can use to send files to this PC/)).toBeNull();
    });

    it('inactive choice labels use zinc-400', async () => {
        mount();
        await settled();
        await userEvent.click(receiveTab());
        const code = await screen.findByRole('button', {name: 'Code'});
        expect(requestButton().className).toContain('text-zinc-400');
        expect(requestButton().className).not.toContain('text-zinc-600');
        expect(code.className).toContain('text-zinc-200');
        await userEvent.click(screen.getByRole('button', {name: 'Send'}));
        const text = screen.getByRole('button', {name: 'Text'});
        expect(text.className).toContain('text-zinc-400');
        expect(text.className).not.toContain('text-zinc-600');
    });

    it('drop state stays out of busy', async () => {
        mount();
        await settled();
        push(lane('receiving', {gen: 2, route: 'direct'}));
        await userEvent.click(receiveTab());
        await userEvent.click(await screen.findByRole('button', {name: 'Code'}));
        // A running drop locks out neither code Receive nor Send.
        const receive = screen.getAllByRole('button', {name: 'Receive'}).find((b) => b.className.includes('w-full')) as HTMLButtonElement;
        expect(receive.disabled).toBe(false);
        await userEvent.click(screen.getByRole('button', {name: 'Send'}));
        expect(screen.getByRole('button', {name: 'Text'})).toBeTruthy(); // the idle Send view
        // The header reads the drop's route, and the footer the busy line.
        expect(screen.getByText('Direct')).toBeTruthy();
        expect(screen.getByText("Keep this window open until it's done")).toBeTruthy();
    });

    it('Ctrl+Enter does nothing on REQUEST LINK', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(receiveTab());
        // A code typed on CODE stays in its field behind REQUEST LINK; the
        // shortcut must not reach it from there.
        await user.type(await screen.findByPlaceholderText('amber-otter-cloud'), 'amber-otter-cloud');
        await user.click(requestButton());
        act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
        await user.keyboard('{Control>}{Enter}{/Control}');
        expect(wails.go.MakeRequestLink).not.toHaveBeenCalled();
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();
        push(lane('deciding', {gen: 2, promptGen: 1, prompt}));
        await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
        act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
        await user.keyboard('{Control>}{Enter}{/Control}');
        expect(wails.go.AnswerRequest).not.toHaveBeenCalled();
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();
    });

    it('close guard with an open link shows Keep open and Close (D-170)', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        push(lane('waiting'));
        act(() => { wails.emit('close:blocked'); });
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Close Floe?')).toBeTruthy();
        expect(within(dialog).getByText('Your request link stops working')).toBeTruthy();
        const keep = within(dialog).getByRole('button', {name: 'Keep open'});
        expect(document.activeElement).toBe(keep);
        await user.click(within(dialog).getByRole('button', {name: 'Close'}));
        expect(wails.go.ConfirmClose).toHaveBeenCalledTimes(1);
    });

    it('close guard with a drop receiving shows the receiving sentence', async () => {
        mount();
        await settled();
        push(lane('receiving', {gen: 2, route: 'relay'}));
        act(() => { wails.emit('close:blocked'); });
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText("Closing now stops the transfer before the files finish")).toBeTruthy();
        // The same pair in every case (D-170).
        expect(within(dialog).getByRole('button', {name: 'Keep open'})).toBeTruthy();
        expect(within(dialog).getByRole('button', {name: 'Close'})).toBeTruthy();
        expect(within(dialog).queryByRole('button', {name: /Keep going|Close anyway/})).toBeNull();
    });

    it('close guard with a send and a link adds the link sentence', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        push(lane('waiting'));
        await user.click(screen.getByRole('button', {name: 'Text'}));
        await user.type(screen.getByPlaceholderText('Type or paste text to send'), 'hello');
        await user.click(screen.getByRole('button', {name: /Send text/}));
        act(() => { wails.emit('close:blocked'); });
        const dialog = await screen.findByRole('dialog');
        // Two lines, never one run-on paragraph (D-167: no periods to part them).
        expect(within(dialog).getByText('Closing now stops the transfer and they get nothing')).toBeTruthy();
        expect(within(dialog).getByText('Your request link also stops working').tagName).toBe('P');
        expect(within(dialog).getByRole('button', {name: 'Keep open'})).toBeTruthy();
    });

    it('the Start over dialog says the link stays open', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        push(lane('waiting'));
        await user.click(screen.getByRole('button', {name: 'Text'}));
        await user.type(screen.getByPlaceholderText('Type or paste text to send'), 'an unsent note');
        act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
        await user.keyboard('{Control>}r{/Control}');
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Your request link stays open')).toBeTruthy();
        // Start over never touches the lane.
        await user.click(within(dialog).getByRole('button', {name: 'Start over'}));
        expect(wails.go.CloseRequestLink).not.toHaveBeenCalled();
    });

    it('no header marker: the Receive tab is described while a link is open, Send never', async () => {
        // D-135 D1: READY carries an open link, so the header looks the same
        // with no link and with a waiting one. H2 moves to the Receive tab's
        // description, only while a link is open and no drop moves (the chip
        // says that), and never on another tab.
        const user = userEvent.setup();
        mount();
        await settled();
        const send = () => screen.getAllByRole('button', {name: 'Send'})[0];
        expect(receiveTab().getAttribute('aria-describedby')).toBeNull();
        push(lane('waiting'));
        // Still on Send: no marker, and the view did not move.
        expect(screen.queryByRole('button', {name: 'Request link is open'})).toBeNull();
        expect(screen.queryByText(/link open/i)).toBeNull();
        expect(screen.getByRole('button', {name: 'Text'})).toBeTruthy();
        await waitFor(() => expect(receiveTab().getAttribute('aria-describedby')).toBe('floe-receive-link-open'));
        const description = document.getElementById('floe-receive-link-open')!;
        expect(description.textContent).toBe('Request link is open');
        expect(description.hidden).toBe(true);
        expect(receiveTab().textContent).toBe('Receive');
        expect(send().getAttribute('aria-describedby')).toBeNull();
        expect(screen.getByRole('button', {name: 'History'}).getAttribute('aria-describedby')).toBeNull();
        // Entering Receive opens REQUEST LINK while the link is live.
        await user.click(receiveTab());
        expect(await screen.findByRole('button', {name: 'Close link'})).toBeTruthy();
        expect(receiveTab().getAttribute('aria-describedby')).toBe('floe-receive-link-open');
        // A drop moving: the chip says it, so no description.
        push(lane('receiving', {gen: 2, route: 'direct'}));
        expect(receiveTab().getAttribute('aria-describedby')).toBeNull();
        // The link gone: no description either.
        push(lane('ended', {gen: 3, code: 'closed'}));
        expect(receiveTab().getAttribute('aria-describedby')).toBeNull();
        expect(send().getAttribute('aria-describedby')).toBeNull();
    });

    // The transfer-audit skill's desktop reader (desktop.mjs readText and
    // RE.pill) keeps the innermost p, span, code, h2 or div whose whole trimmed
    // text is one status word; every desktop cell samples the chip that way.
    const PILL = /^(Ready|Active|Direct|Relay)$/i;
    function pillReads(): string[] {
        const hit = [...document.querySelectorAll('p, span, code, h2, div')].filter((e) => PILL.test((e.textContent || '').trim()));
        return hit.filter((e) => !hit.some((o) => o !== e && e.contains(o))).map((e) => (e.textContent || '').trim());
    }
    const TIP2 = 'Hide my IP limits transfers to 2 GB';
    const pause = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

    it('the chip word keeps an element of its own, with Hide my IP off and on', async () => {
        for (const hideIP of [false, true]) {
            withHideIP(hideIP);
            const {unmount} = mount();
            await settled();
            const word = await screen.findByText('Ready');
            await waitFor(() => expect(!!word.nextElementSibling).toBe(hideIP));
            expect(pillReads(), `hideIP ${hideIP}`).toEqual(['Ready']);
            expect(word.children.length).toBe(0);
            if (hideIP) {
                // The screen-reader twin is the word's sibling, never inside it.
                const twin = word.nextElementSibling!;
                expect(twin.textContent).toBe(`, ${TIP2}`);
                expect(twin.className.split(' ')).toContain('sr-only');
                expect(word.contains(twin)).toBe(false);
                expect(word.parentElement!.querySelector('.bg-amber-500')).toBeTruthy();
            } else {
                expect(word.parentElement!.querySelector('.bg-green-500')).toBeTruthy();
            }
            unmount();
        }
    });

    it('the amber READY explains itself on hover; with Hide my IP off READY shows nothing', async () => {
        const user = userEvent.setup();
        withHideIP(true);
        const amber = mount();
        await settled();
        const word = await screen.findByText('Ready');
        await waitFor(() => expect(word.nextElementSibling).toBeTruthy());
        await user.hover(word);
        expect((await screen.findByRole('tooltip')).textContent).toBe(TIP2);
        await user.unhover(word);
        amber.unmount();

        withHideIP(false);
        mount();
        await settled();
        await pause(400);
        await user.hover(screen.getByText('Ready'));
        await pause(600);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('hovering DIRECT or RELAY shows nothing, and the moving chip has no twin', async () => {
        // D-135 D2: "Direct peer connection" and the relay lines are gone.
        withHideIP(true);
        const user = userEvent.setup();
        mount();
        await settled();
        await waitFor(() => expect(screen.getByText('Ready').nextElementSibling).toBeTruthy());
        for (const [route, name, seq] of [['direct', 'Direct', 1], ['relay', 'Relay', 2]] as const) {
            push(lane('receiving', {gen: 2, seq, route}));
            const word = await screen.findByText(name);
            expect(word.nextElementSibling, name).toBeNull();
            expect(pillReads(), name).toEqual([name]);
            await pause(400);
            await user.hover(word);
            await pause(600);
            expect(screen.queryByRole('tooltip'), name).toBeNull();
            await user.unhover(word);
        }
    });

    // Auto-accept (D-173, H4): the header says what the app will do by itself
    // while such a link is open and nothing moves; moving words win.
    it('the chip reads AUTO-ACCEPT only while an automatic link is open and nothing moves', async () => {
        mount();
        await settled();
        expect(await screen.findByText('Ready')).toBeTruthy();
        push(lane('waiting', {gen: 2, seq: 1, autoAccept: true}));
        const word = await screen.findByText('Auto-accept');
        // One word in its own element, drawn in the chip's uppercase.
        expect(word.children.length).toBe(0);
        expect(word.parentElement!.className.split(' ')).toContain('uppercase');
        expect(word.parentElement!.querySelector('.bg-green-500')).toBeTruthy();
        push(lane('connecting', {gen: 2, seq: 2, autoAccept: true}));
        expect(screen.getByText('Auto-accept')).toBeTruthy();
        // A drop that did not qualify asks under READY, not under AUTO-ACCEPT
        // (review R2 F2), and the link reads AUTO-ACCEPT again once it waits.
        push(lane('deciding', {gen: 2, seq: 3, autoAccept: true}));
        expect(await screen.findByText('Ready')).toBeTruthy();
        expect(screen.queryByText('Auto-accept')).toBeNull();
        push(lane('declined', {gen: 2, seq: 4, autoAccept: true}));
        expect(await screen.findByText('Ready')).toBeTruthy();
        push(lane('waiting', {gen: 2, seq: 5, autoAccept: true}));
        expect(await screen.findByText('Auto-accept')).toBeTruthy();
        push(lane('receiving', {gen: 2, seq: 6, autoAccept: true, route: 'direct'}));
        expect(await screen.findByText('Direct')).toBeTruthy();
        expect(screen.queryByText('Auto-accept')).toBeNull();
        push(lane('receiving', {gen: 2, seq: 7, autoAccept: true, route: 'relay'}));
        expect(await screen.findByText('Relay')).toBeTruthy();
        push(lane('done', {gen: 2, seq: 8, autoAccept: true, result: {files: 1, saved: 1, bytes: 1, verified: 1, renamed: 0, folder: 'D:\\x', names: ['a'], autoAccepted: true}}));
        expect(await screen.findByText('Ready')).toBeTruthy();
        expect(screen.queryByText('Auto-accept')).toBeNull();
        // A link made with the switch off reads READY, as before.
        push(lane('waiting', {gen: 3, seq: 1}));
        await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy());
        expect(screen.queryByText('Auto-accept')).toBeNull();
    });

    it('the automatic chip is amber with Hide my IP on, like READY', async () => {
        withHideIP(true);
        mount();
        await settled();
        await waitFor(() => expect(screen.getByText('Ready').nextElementSibling).toBeTruthy());
        push(lane('waiting', {gen: 2, seq: 1, autoAccept: true}));
        const word = await screen.findByText('Auto-accept');
        expect(word.parentElement!.querySelector('.bg-amber-500')).toBeTruthy();
    });

    it('an automatic drop raises no notice and no announcement: it goes from connecting to receiving', async () => {
        mount();
        await settled();
        push(lane('waiting', {gen: 2, seq: 1, autoAccept: true}));
        push(lane('connecting', {gen: 2, seq: 2, autoAccept: true}));
        push(lane('receiving', {gen: 2, seq: 3, autoAccept: true, route: 'direct', result: {files: 12, saved: 0, bytes: 0, verified: 0, renamed: 0, folder: 'D:\\Footage\\Floe requests\\Acme footage 2026-09-14 1405', names: [], autoAccepted: true}}));
        await screen.findByText('Direct');
        expect(screen.queryByRole('group', {name: 'Someone wants to send you files'})).toBeNull();
        const spans = [...document.querySelectorAll('span.sr-only[role="status"]')].map((s) => s.textContent);
        expect(spans).not.toContain('Request link: someone wants to send you files.');
        expect(wails.go.AnswerRequest).not.toHaveBeenCalled();
    });

    it('Make link passes true only while the Auto-accept switch is on', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(receiveTab());
        await user.click(requestButton());
        await user.click(screen.getByRole('checkbox', {name: 'Auto-accept'}));
        expect(screen.getByText('Anyone with this link can send you files without asking')).toBeTruthy();
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(wails.go.MakeRequestLink).toHaveBeenLastCalledWith('', '', '24h', true);
    });

    it('a prompt raises the notice elsewhere, announces once, and Review opens it', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        push(lane('deciding', {gen: 2, promptGen: 1, prompt}));
        const notice = await screen.findByRole('group', {name: 'Someone wants to send you files'});
        const spans = [...document.querySelectorAll('span.sr-only[role="status"]')].map((s) => s.textContent);
        expect(spans).toContain('Request link: someone wants to send you files.');
        expect(wails.go.AnswerRequest).not.toHaveBeenCalled();
        await user.click(within(notice).getByRole('button', {name: 'Review'}));
        await waitFor(() => expect(document.activeElement?.id).toBe('floe-request-prompt-heading'));
        expect(screen.getByText('ACME FOOTAGE WANTS TO SEND YOU FILES')).toBeTruthy();
    });

    it('Review brings the whole Accept row into view, then focuses the heading without scrolling again', async () => {
        // jsdom has no scrollIntoView; record who is asked to scroll, and how.
        const proto = HTMLElement.prototype as unknown as {scrollIntoView?: (arg?: unknown) => void};
        const had = proto.scrollIntoView;
        const scrolled: Array<{id: string; arg: unknown}> = [];
        proto.scrollIntoView = function (this: HTMLElement, arg?: unknown) { scrolled.push({id: this.id, arg}); };
        const focus = vi.spyOn(HTMLElement.prototype, 'focus');
        try {
            const user = userEvent.setup();
            mount();
            await settled();
            push(lane('deciding', {gen: 2, promptGen: 1, prompt}));
            const notice = await screen.findByRole('group', {name: 'Someone wants to send you files'});
            await user.click(within(notice).getByRole('button', {name: 'Review'}));
            await waitFor(() => expect(document.activeElement?.id).toBe('floe-request-prompt-heading'));
            expect(scrolled).toEqual([{id: 'floe-request-prompt-actions', arg: {block: 'nearest'}}]);
            const heading = document.getElementById('floe-request-prompt-heading');
            const calls = focus.mock.calls.filter((_, i) => focus.mock.contexts[i] === heading);
            expect(calls).toEqual([[{preventScroll: true}]]);
        } finally {
            proto.scrollIntoView = had;
        }
    });

    it('the card keeps its top when a request mounts on REQUEST LINK', async () => {
        // Spec 06 5.5 and VR3-D03: Close link does not move when a request
        // mounts; D-136: the card's top is one anchored spot for the whole
        // REQUEST LINK view, 103 px at 1000 x 640. jsdom has no layout, so
        // <main>'s height is mocked (the window less the 36 px title bar) and
        // the box gets its py-8 padding inline: room 540 px, margin 35 px.
        let mainHeight = 604;
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
            return this.tagName === 'MAIN' ? mainHeight : 0;
        });
        const user = userEvent.setup();
        mount();
        await settled();
        const card = () => document.querySelector<HTMLElement>('main .m-auto')!;
        card().parentElement!.style.padding = '32px';

        // A link open behind the Send view anchors nothing there.
        push(lane('waiting', {seq: 1}));
        expect(card().style.marginTop).toBe('');
        // Entering Receive opens REQUEST LINK while the link is live (the header
        // has no marker to click since D-135).
        await user.click(receiveTab());
        expect(await screen.findByRole('button', {name: 'Close link'})).toBeTruthy();
        expect(card().style.marginTop).toBe('35px');
        expect(card().style.marginBottom).toBe('auto');

        // Every state of the view keeps the same top: the prompt that would
        // have re-centered the card 65 px higher, declined, waiting again, a
        // drop moving, and its result.
        const states: Array<[string, Record<string, unknown>]> = [
            ['deciding', {seq: 2, promptGen: 1, prompt}], ['declined', {seq: 3, promptGen: 1}], ['waiting', {seq: 4}],
            ['receiving', {seq: 5, route: 'direct'}],
            ['done', {seq: 6, result: {files: 1, saved: 1, bytes: 1, verified: 1, renamed: 0, folder: 'D:\\x', names: ['a']}}],
        ];
        for (const [state, over] of states) {
            push(lane(state, over));
            expect(card().style.marginTop, state).toBe('35px');
        }
        // The Ready form after Make another link, too.
        await user.click(screen.getByRole('button', {name: 'Make another link'}));
        expect(await screen.findByRole('button', {name: 'Make link'})).toBeTruthy();
        expect(card().style.marginTop).toBe('35px');

        // A resize recomputes: 1140 x 720 puts the card's top at 143 px.
        mainHeight = 684;
        act(() => { window.dispatchEvent(new Event('resize')); });
        expect(card().style.marginTop).toBe('75px');

        // Another tab centers as before; coming back anchors again.
        await user.click(screen.getAllByRole('button', {name: 'Send'})[0]);
        expect(card().style.marginTop).toBe('');
        expect(card().style.marginBottom).toBe('');
        expect(card().className).toContain('m-auto');
        await user.click(receiveTab());
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));
        expect(card().style.marginTop).toBe('75px');
    });

    it('<main> keeps its scrollbar gutter, so a prompt that makes it scroll never moves the card sideways (FU-38)', async () => {
        // WebView2 draws the 6 px custom scrollbar inside <main> once a prompt
        // makes it scroll, and the centered box moved 3 px left (FU-04). A
        // stable gutter is the same 6 px, reserved whether it scrolls or not,
        // and on both edges, so the card stays centered where it always sat;
        // on the inline end alone it would sit 3 px left for good (FU-38
        // review F1). Inline axis only: clientHeight, and so the anchored top
        // above, is untouched. jsdom has no layout, so the class is what is
        // checked here; the pixels are cell-08's nothing-moved and
        // card-centered checks (--scrollbars).
        mount();
        await settled();
        const main = document.querySelectorAll('main');
        expect(main).toHaveLength(1);
        expect(main[0].className.split(' ')).toContain('[scrollbar-gutter:stable_both-edges]');
    });

    it('after Floe closed with a link open, Receive opens on REQUEST LINK at Make link, with no ended line (D-170)', async () => {
        localStorage.setItem('floe:requestLinkOpenUntil', String(Date.now() + 3600_000));
        const first = mount();
        await settled();
        await userEvent.click(receiveTab());
        expect(await screen.findByRole('button', {name: 'Make link'})).toBeTruthy();
        expect(screen.queryByText(/Link ended|Floe closed|Link closed/)).toBeNull();
        expect(screen.queryByRole('button', {name: 'Make another link'})).toBeNull();
        expect(localStorage.getItem('floe:requestLinkOpenUntil')).toBeNull();
        first.unmount();

        // The next launch has nothing to say: Receive opens on CODE.
        mount();
        await settled();
        await userEvent.click(receiveTab());
        expect(await screen.findByPlaceholderText('amber-otter-cloud')).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Make link'})).toBeNull();
    });

    it('keeps only the end time, never the link, and clears it when the link ends', async () => {
        mount();
        await settled();
        push(lane('waiting'));
        await waitFor(() => expect(localStorage.getItem('floe:requestLinkOpenUntil')).toBe(String(base.expiresAt)));
        for (let i = 0; i < localStorage.length; i++) {
            const v = localStorage.getItem(localStorage.key(i)!) || '';
            expect(v).not.toContain('Xk3p9Q0aB1c');
            expect(v).not.toContain('6f1c2b9e');
        }
        push(lane('ended', {code: 'closed'}));
        await waitFor(() => expect(localStorage.getItem('floe:requestLinkOpenUntil')).toBeNull());
    });

    it('Make link passes the remembered folder and shows the stub refusal as fixed copy', async () => {
        localStorage.setItem('floe:requestSaveDir', 'D:\\Footage\\Floe requests');
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(receiveTab());
        await user.click(requestButton());
        await user.type(screen.getByLabelText('Label'), 'Acme footage');
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(wails.go.MakeRequestLink).toHaveBeenCalledWith('Acme footage', 'D:\\Footage\\Floe requests', '24h', false);
        // The stub refuses (FT-03): the disabled sentence, never a link.
        expect(await screen.findByText('Request links are off on this server')).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Copy link'})).toBeNull();
    });
});

describe('visitor names in the app', () => {
    const HOSTILE = ['<img src=x onerror=alert(1)>', '$(calc)', ']]><', '\u202Eevil.exe'];

    it('a hostile name is never passed to any Wails call', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));
        const base = {code: '', gen: 2, promptGen: 1, link: 'http://localhost:3000/r/Xk3p9Q0aB1c#x', label: 'Acme footage', saveDir: 'D:\\x', expiresAt: Date.now() + 3600_000, route: 'direct', suggestClose: false};
        let gen = base.gen;
        for (const name of HOSTILE) {
            gen += 1; // each drop is a new link, so a new lane generation
            act(() => {
                wails.emit('request:state', {...base, gen, state: 'receiving'});
                wails.emit('request:progress', {fileName: name, fileIndex: 1, fileCount: 2, fileBytes: 1, fileSize: 2, totalBytes: 1, grandTotal: 4, savedName: name});
            });
            expect(await screen.findByText(name, {exact: true})).toBeTruthy();
            expect(document.querySelector('img')).toBeNull();
            await user.click(screen.getByRole('button', {name: 'Cancel drop'}));
            act(() => {
                wails.emit('request:state', {...base, gen, state: 'done', result: {files: 2, saved: 2, bytes: 4, verified: 2, renamed: 1, folder: 'D:\\x\\Acme footage 2026-09-14 1405', names: [name, name]}});
            });
            await user.click(screen.getByRole('button', {name: 'Show in folder'}));
            await user.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Show in folder'}));
            await user.click(screen.getByRole('button', {name: 'Make another link'}));
        }
        // Every binding call and every runtime call the app made, arguments
        // included: none carries a visitor's file name.
        const runtime = (window as unknown as {runtime: Record<string, unknown>}).runtime;
        const recorded = JSON.stringify([
            wails.calls,
            ...Object.values(wails.go).map((f) => f.mock.calls),
            ...Object.values(runtime).filter((f) => typeof f === 'function' && 'mock' in (f as object)).map((f) => (f as ReturnType<typeof vi.fn>).mock.calls),
        ]);
        expect(wails.go.OpenFolder).toHaveBeenCalledWith('D:\\x\\Acme footage 2026-09-14 1405');
        for (const name of HOSTILE) expect(recorded.includes(JSON.stringify(name).slice(1, -1)), name).toBe(false);
    });
});

describe('request progress per drop (F2-03)', () => {
    it('the next drop never shows the previous drop\'s name, count or percent', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));
        const base = {code: '', promptGen: 1, link: 'http://localhost:3000/r/Xk3p9Q0aB1c#x', label: 'Acme', saveDir: 'D:\\x', expiresAt: Date.now() + 3600_000, route: 'direct', suggestClose: false};
        // One drop on the link of lane generation 3, its last progress event
        // naming the twelfth of twelve files.
        act(() => {
            wails.emit('request:state', {...base, gen: 3, seq: 1, state: 'receiving'});
            wails.emit('request:progress', {fileName: 'visitor-A-contract.pdf', fileIndex: 12, fileCount: 12, fileBytes: 9, fileSize: 9, totalBytes: 900, grandTotal: 900, savedName: 'visitor-A-contract.pdf'});
        });
        expect(await screen.findByText('visitor-A-contract.pdf', {exact: true})).toBeTruthy();
        act(() => {
            wails.emit('request:state', {...base, gen: 3, seq: 2, state: 'done', result: {files: 12, saved: 12, bytes: 900, verified: 12, renamed: 0, folder: 'D:\\x\\Acme 2026-09-14 1405', names: []}});
        });
        await user.click(screen.getByRole('button', {name: 'Make another link'}));
        // The next link (generation 5), its drop accepted and receiving before
        // its own first progress event: a drop of empty files never sends one.
        act(() => {
            wails.emit('request:state', {...base, gen: 5, seq: 9, state: 'receiving'});
        });
        expect(await screen.findByText(/^RECEIVING /)).toBeTruthy();
        expect(screen.queryByText('visitor-A-contract.pdf', {exact: true})).toBeNull();
        expect(screen.queryByText(/^RECEIVING 12 OF 12/)).toBeNull();
        expect(screen.queryByText('100%')).toBeNull();
        // Its own progress still shows.
        act(() => {
            wails.emit('request:progress', {fileName: 'visitor-B.txt', fileIndex: 1, fileCount: 2, fileBytes: 1, fileSize: 2, totalBytes: 1, grandTotal: 4, savedName: 'visitor-B.txt'});
        });
        expect(await screen.findByText('visitor-B.txt', {exact: true})).toBeTruthy();
        expect(screen.getByText(/^RECEIVING 1 OF 2/)).toBeTruthy();
    });
});

describe('request drops in History', () => {
    it('a terminal request snapshot appends exactly one history row', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        const base = {
            code: '', gen: 3, promptGen: 1, link: 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f',
            label: 'Acme footage', saveDir: 'D:\\x', expiresAt: Date.now() + 3600_000, route: 'direct', suggestClose: false,
        };
        const done = {...base, state: 'done', result: {files: 3, saved: 3, bytes: 3072, verified: 3, renamed: 0, folder: 'D:\\x\\Acme footage 2026-09-14 1405', names: ['a', 'b', 'c']}};
        act(() => { wails.emit('request:state', {...base, state: 'receiving'}); });
        act(() => { wails.emit('request:state', done); });
        // Re-emitted, and pulled again: still one row.
        act(() => { wails.emit('request:state', done); });
        act(() => { wails.emit('request:state', {...done}); });

        await waitFor(() => expect(JSON.parse(localStorage.getItem('floe:history') || '[]')).toHaveLength(1));
        const stored = localStorage.getItem('floe:history') || '';
        expect(JSON.parse(stored)[0]).toMatchObject({kind: 'recv', via: 'request', label: 'Acme footage', count: 3, dir: 'D:\\x\\Acme footage 2026-09-14 1405'});
        expect(stored).not.toContain('Xk3p9Q0aB1c');
        expect(stored).not.toContain('6f1c2b9e');

        // A stop with nothing saved adds no row; the next drop's result (its
        // own exclusive subfolder) does.
        act(() => { wails.emit('request:state', {...base, gen: 4, state: 'stopped', code: 'relay-cap', result: {...done.result, saved: 0}}); });
        act(() => { wails.emit('request:state', {...base, gen: 5, state: 'stopped', code: 'disk-full', result: {...done.result, saved: 2, folder: 'D:\\x\\Acme footage 2026-09-14 1510'}}); });
        await waitFor(() => expect(JSON.parse(localStorage.getItem('floe:history') || '[]')).toHaveLength(2));
        expect(JSON.parse(localStorage.getItem('floe:history') || '[]')[0]).toMatchObject({stopped: 'disk-full', count: 2, offered: 3});

        await user.click(screen.getByRole('button', {name: 'History'}));
        expect(screen.getAllByText('Acme footage')).toHaveLength(2);

        // The once-per-generation guard on its own: a result with no folder
        // (nothing for the folder check to match) re-emitted twice still adds
        // one row.
        const bare = {...base, gen: 6, state: 'done', label: 'No folder', result: {...done.result, folder: ''}};
        act(() => { wails.emit('request:state', bare); });
        act(() => { wails.emit('request:state', {...bare}); });
        await waitFor(() => expect(JSON.parse(localStorage.getItem('floe:history') || '[]')).toHaveLength(3));
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        expect(JSON.parse(localStorage.getItem('floe:history') || '[]')).toHaveLength(3);
    });
});

describe('reset leaves request links alone (S-17)', () => {
    // There is no request-links setting any more, so Reset has nothing of it to
    // put back: the only writes are the two Settings setters, and a live link
    // is neither closed nor stranded.
    it('reset leaves request links alone, with or without a live link', async () => {
        const user = userEvent.setup();
        for (const live of [false, true]) {
            for (const fn of Object.values(wails.go)) fn.mockClear();
            const {unmount} = mount();
            await settled();
            if (live) {
                act(() => {
                    wails.emit('request:state', {
                        state: 'waiting', code: '', gen: 2, promptGen: 0, link: 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f',
                        label: 'Acme footage', saveDir: 'D:\\x', expiresAt: Date.now() + 3600_000, route: '', suggestClose: false,
                    });
                });
            }

            await user.click(screen.getByRole('button', {name: 'Settings'}));
            await user.click(screen.getByRole('button', {name: 'Reset'}));
            await user.click(within(await screen.findByRole('dialog')).getByRole('button', {name: 'Reset all settings'}));

            await waitFor(() => expect(wails.go.SetSettings).toHaveBeenCalledWith('', '', false, true), {timeout: 2000});
            expect(wails.go.SetCheckUpdates).toHaveBeenCalledWith(true);
            expect(wails.go.SetToasts).toHaveBeenCalledWith(true);
            expect(wails.go.SetToastSound).toHaveBeenCalledWith(true);
            const settingsSetters = ['SetSettings', 'SetCheckUpdates', 'SetToasts', 'SetToastSound'];
            for (const [name, fn] of Object.entries(wails.go)) {
                if (name.startsWith('Set') && !settingsSetters.includes(name)) expect(fn, `live ${live}: ${name}`).not.toHaveBeenCalled();
            }
            expect(wails.go.CloseRequestLink).not.toHaveBeenCalled();
            expect(wails.listeners.has('request:state')).toBe(true);
            if (live) {
                // Still reachable to close: entering Receive opens REQUEST LINK.
                await user.click(screen.getByRole('button', {name: 'Back'}));
                await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
                expect(await screen.findByRole('button', {name: 'Close link'})).toBeTruthy();
            }
            unmount();
        }
    });
});

describe('snapshot order (D-115)', () => {
    it('a deciding reply that arrives after a receiving event never brings the prompt back', async () => {
        let reply!: (s: unknown) => void;
        wails.go.AnswerRequest.mockImplementation(() => new Promise((r) => { reply = r; }));
        const user = userEvent.setup();
        mount();
        await settled();
        const base = {
            code: '', gen: 2, promptGen: 1, link: 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f',
            label: 'Acme footage', saveDir: 'D:\\x', expiresAt: Date.now() + 3600_000, route: '', suggestClose: false,
        };
        const prompt = {files: 2, totalBytes: 2048, folder: 'Floe requests\\Acme footage 2026-09-14 1405', freeBytes: 1 << 30, warnings: [], answerBy: Date.now() + 9 * 60000};
        act(() => { wails.emit('request:state', {...base, seq: 3, state: 'deciding', prompt}); });
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        const accept = await screen.findByRole('button', {name: 'Accept'});
        await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
        await user.click(accept);
        expect(wails.go.AnswerRequest).toHaveBeenCalledWith(1, 'accept');

        // The lane emits receiving before the answer's own reply lands...
        act(() => { wails.emit('request:state', {...base, seq: 5, state: 'receiving', route: 'direct'}); });
        expect(await screen.findByRole('button', {name: 'Cancel drop'})).toBeTruthy();
        // ...and the reply, stamped before it, says deciding.
        await act(async () => { reply({...base, seq: 4, state: 'deciding', prompt}); await Promise.resolve(); });

        expect(screen.queryByRole('button', {name: 'Accept'})).toBeNull();
        expect(screen.getByRole('button', {name: 'Cancel drop'})).toBeTruthy();
        expect(screen.queryByRole('group', {name: 'Someone wants to send you files'})).toBeNull();
    });
});

describe('a webview reload', () => {
    it('does not add a finished drop to History a second time', async () => {
        // The page reloaded while the lane still holds a done drop: its row is
        // already in the store, and the pulled snapshot must not add another.
        const folder = 'D:\\x\\Acme footage 2026-09-14 1405';
        localStorage.setItem('floe:history', JSON.stringify([
            {kind: 'recv', names: ['a', 'b'], count: 2, dir: folder, at: 1_700_000_000_000, bytes: 2048, via: 'request', label: 'Acme footage', verified: 2, renamed: 0, offered: 2},
        ]));
        const done = {
            state: 'done', code: '', gen: 3, seq: 9, promptGen: 1, link: '', label: 'Acme footage', saveDir: 'D:\\x',
            expiresAt: Date.now() + 3600_000, route: 'direct', suggestClose: false,
            result: {files: 2, saved: 2, bytes: 2048, verified: 2, renamed: 0, folder, names: ['a', 'b']},
        };
        wails.go.GetRequestLink.mockImplementation(async () => done);
        mount();
        await settled();
        await waitFor(() => expect(wails.go.GetRequestLink).toHaveBeenCalled());
        act(() => { wails.emit('request:state', done); });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        const stored = JSON.parse(localStorage.getItem('floe:history') || '[]');
        expect(stored).toHaveLength(1);

        // A different drop still gets its own row.
        act(() => { wails.emit('request:state', {...done, gen: 4, seq: 10, result: {...done.result, folder: folder + ' (2)'}}); });
        await waitFor(() => expect(JSON.parse(localStorage.getItem('floe:history') || '[]')).toHaveLength(2));
    });
});

describe('the calm copy (D-167)', () => {
    it('Send, Receive, Settings and History draw no line that ends in a period', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        expect(closingPeriods(document.body)).toEqual([]);
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        expect(closingPeriods(document.body)).toEqual([]);
        await user.click(screen.getByRole('button', {name: 'History'}));
        expect(await screen.findByText('No transfers yet')).toBeTruthy();
        expect(closingPeriods(document.body)).toEqual([]);
        cleanup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));
        await screen.findByLabelText('Server address');
        expect(closingPeriods(document.body)).toEqual([]);
    });
});

describe('the SEND and RECEIVE tabs (D-172)', () => {
    it('have the same edge and padding above and below the word in both states, so the word stays centered', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        const send = screen.getAllByRole('button', {name: 'Send'})[0];
        const receive = screen.getAllByRole('button', {name: 'Receive'})[0];
        const both = () => [send, receive].map((b) => b.className.split(' '));
        for (const c of both()) {
            expect(c).toEqual(expect.arrayContaining(['border-y-2', 'border-t-transparent', 'py-1']));
            expect(c.some((x) => x === 'pb-1' || x === 'border-b-2')).toBe(false);
        }
        expect(send.className.split(' ')).toContain('border-b-white');
        expect(receive.className.split(' ')).toContain('border-b-transparent');
        await user.click(receive);
        expect(receive.className.split(' ')).toContain('border-b-white');
        expect(send.className.split(' ')).toContain('border-b-transparent');
    });
});

describe('the rail', () => {
    it('says no size limit from Floe, and names what a receiving browser can hold', async () => {
        mount();
        await settled();
        // A browser that receives from Floe Desktop is limited by what it can
        // hold, so the rail no longer says "unlimited" or "no size cap".
        const title = screen.getByText('Direct, no size limit from Floe');
        expect(title.nextElementSibling!.textContent).toBe('Device to device. A receiving browser can only hold so much. 2 GB through a relay');
        expect(document.body.textContent).not.toMatch(/unlimited|no size cap/i);
    });
});

/**
 * The app-level shortcuts wait while one of the app's confirm dialogs is up.
 * Each used to test its own subset of the three: none tested Close Floe?,
 * which an open request link raises with nothing busy, and four tested none.
 */
describe('shortcuts behind a dialog', () => {
    const LINK = 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const waiting = {
        state: 'waiting', code: '', gen: 1, promptGen: 0, link: LINK, label: '', saveDir: 'D:\\x',
        expiresAt: Date.now() + 3600_000, route: '', suggestClose: false,
    };
    type User = ReturnType<typeof userEvent.setup>;
    // The keys go to the window, not to a button: a dialog's focused button
    // takes Enter itself, which is the dialog answering and not a shortcut.
    const press = async (user: User, keys: string) => {
        act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
        await user.keyboard(keys);
    };
    const TITLES = ['Close Floe?', 'Start over?', 'Reset all settings?'] as const;
    async function raise(user: User, title: (typeof TITLES)[number]) {
        if (title === 'Close Floe?') {
            act(() => { wails.emit('close:blocked'); });
        } else if (title === 'Start over?') {
            await user.click(screen.getByRole('button', {name: 'Text'}));
            await user.type(screen.getByPlaceholderText('Type or paste text to send'), 'an unsent note');
            await press(user, '{Control>}r{/Control}');
        } else {
            await user.click(screen.getByRole('button', {name: 'Settings'}));
            await user.click(await screen.findByRole('button', {name: 'Reset'}));
        }
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText(title)).toBeTruthy();
        return dialog;
    }

    it('Ctrl+Enter starts no receive behind Close Floe?, which an open link raises with nothing busy', async () => {
        wails.go.ReceiveByCode.mockImplementation(() => new Promise<string>(() => {}));
        const user = userEvent.setup();
        mount();
        await settled();
        act(() => { wails.emit('request:state', waiting); });
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Code'}));
        await user.type(screen.getByPlaceholderText('amber-otter-cloud'), 'amber-otter-cloud');
        const dialog = await raise(user, 'Close Floe?');
        expect(within(dialog).getByText('Your request link stops working')).toBeTruthy();

        await press(user, '{Control>}{Enter}{/Control}');
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBe(dialog);

        // The dialog answered, the shortcut is back.
        await user.click(within(dialog).getByRole('button', {name: 'Keep open'}));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await press(user, '{Control>}{Enter}{/Control}');
        await waitFor(() => expect(wails.go.ReceiveByCode).toHaveBeenCalledTimes(1));
    });

    it('Ctrl+Enter starts no send behind Close Floe?', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        act(() => { wails.emit('request:state', waiting); });
        act(() => { wails.emit('files:open', ['C:\\Users\\test\\a.txt']); });
        expect(await screen.findByRole('button', {name: 'Send 1 item'})).toBeTruthy();
        await raise(user, 'Close Floe?');
        await press(user, '{Control>}{Enter}{/Control}');
        expect(wails.go.StartSend).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it.each(TITLES)('Ctrl+O, Ctrl+V, Ctrl+H and Ctrl+, do nothing behind %s, and never close it', async (title) => {
        const user = userEvent.setup();
        mount();
        await settled();
        const dialog = await raise(user, title);
        const onSettings = () => screen.queryByLabelText('Server address') !== null;
        const onHistory = () => screen.queryByText('No transfers yet') !== null;
        const before = [onSettings(), onHistory()];
        for (const keys of ['{Control>}o{/Control}', '{Control>}v{/Control}', '{Control>}h{/Control}', '{Control>},{/Control}']) {
            await press(user, keys);
        }
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(wails.go.SelectFiles).not.toHaveBeenCalled();
        expect(wails.go.PasteFiles).not.toHaveBeenCalled();
        // The same dialog over the same screen: nothing moved behind it, and
        // closing Settings did not take "Reset all settings?" down with it.
        expect(screen.getByRole('dialog')).toBe(dialog);
        expect([onSettings(), onHistory()]).toEqual(before);
    });

    // The title bar sits above every scrim, so its gear is clickable while a
    // dialog is up. It waits there, as Ctrl+, does.
    it.each(TITLES)('the title bar gear does nothing behind %s, and never closes it', async (title) => {
        const user = userEvent.setup();
        mount();
        await settled();
        const dialog = await raise(user, title);
        const onSettings = () => screen.queryByLabelText('Server address') !== null;
        const before = onSettings();
        await user.click(screen.getByRole('button', {name: 'Settings'}));
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(screen.getByRole('dialog')).toBe(dialog);
        expect(onSettings()).toBe(before);
    });

    it('the update notice steps aside for Close Floe? too, never dimmed under its scrim', async () => {
        wails.go.GetVersion.mockImplementation(async () => 'desktop-v0.3.0');
        wails.go.CheckForUpdate.mockImplementation(async () => ({version: 'desktop-v0.3.1'}));
        const user = userEvent.setup();
        mount();
        await settled();
        expect(await screen.findByRole('group', {name: 'Update available'})).toBeTruthy();
        const dialog = await raise(user, 'Close Floe?');
        expect(screen.queryByRole('group', {name: 'Update available'})).toBeNull();
        await user.click(within(dialog).getByRole('button', {name: 'Keep open'}));
        expect(await screen.findByRole('group', {name: 'Update available'})).toBeTruthy();
    });

    // A drop on the window and a second launch (the Explorer entry, or files
    // dragged onto the exe) staged files and moved the screen behind any of
    // the three, the way the shortcuts above used to: behind Reset all
    // settings? they closed Settings under it. They wait now, as they do
    // while a transfer runs.
    it.each(TITLES)('a file drop and a second launch stage nothing behind %s, and never close it', async (title) => {
        const user = userEvent.setup();
        mount();
        await settled();
        const dialog = await raise(user, title);
        const onSettings = () => screen.queryByLabelText('Server address') !== null;
        const before = onSettings();
        act(() => { wails.drop?.(0, 0, ['C:\\Users\\test\\dropped.txt']); });
        act(() => { wails.emit('files:open', ['C:\\Users\\test\\launched.txt']); });
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(screen.getByRole('dialog')).toBe(dialog);
        expect(onSettings()).toBe(before);
        expect(screen.queryByText('dropped.txt')).toBeNull();
        expect(screen.queryByText('launched.txt')).toBeNull();
    });

    it('a drop after Close Floe? is answered stages as before', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        const dialog = await raise(user, 'Close Floe?');
        await user.click(within(dialog).getByRole('button', {name: 'Keep open'}));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        act(() => { wails.drop?.(0, 0, ['C:\\Users\\test\\dropped.txt']); });
        expect(await screen.findByRole('button', {name: 'Send 1 item'})).toBeTruthy();
    });

    // Ctrl+R and the titlebar lockup are Start over, and Start over? is their
    // own dialog: pressed again there they re-enter it (startOver's fourth
    // exit). Behind the other two they reset the screen under the dialog: a
    // send's files, Settings under Reset all settings?, and a transfer
    // canceled under Close Floe?. They wait there now.
    it.each(['Close Floe?', 'Reset all settings?'] as const)('Ctrl+R and the lockup start nothing over behind %s', async (title) => {
        const user = userEvent.setup();
        mount();
        await settled();
        act(() => { wails.emit('files:open', ['C:\\Users\\test\\a.txt']); });
        expect(await screen.findByRole('button', {name: 'Send 1 item'})).toBeTruthy();
        const dialog = await raise(user, title);
        const onSettings = () => screen.queryByLabelText('Server address') !== null;
        const before = onSettings();
        await press(user, '{Control>}r{/Control}');
        await user.click(document.getElementById('floe-lockup')!);
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(wails.go.CancelTransfer).not.toHaveBeenCalled();
        expect(screen.getAllByRole('dialog')).toEqual([dialog]);
        expect(onSettings()).toBe(before);
    });

    it('Ctrl+Z spends no undo behind Close Floe?, and the offer is still good after it', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        act(() => { wails.emit('files:open', ['C:\\Users\\test\\a.txt']); });
        await user.click(await screen.findByRole('button', {name: 'Clear 1 item'}));
        expect(await screen.findByRole('button', {name: 'Undo clearing 1 item'})).toBeTruthy();
        const dialog = await raise(user, 'Close Floe?');
        // The bar steps aside for the dialog, as it does for the other two,
        // instead of sitting under the scrim where it cannot be clicked.
        expect(screen.queryByRole('button', {name: 'Undo clearing 1 item'})).toBeNull();

        await press(user, '{Control>}z{/Control}');
        expect(screen.queryByRole('button', {name: 'Send 1 item'})).toBeNull();

        await user.click(within(dialog).getByRole('button', {name: 'Keep open'}));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await press(user, '{Control>}z{/Control}');
        expect(await screen.findByRole('button', {name: 'Send 1 item'})).toBeTruthy();
    });
});

/**
 * Start over while a note is still waiting to go out. doReset empties the box,
 * and a note that has not gone out is written to no file and no storage key,
 * so Start over asks first even while the send that carries it is waiting for
 * its receiver. With nothing to lose it still resets on the first press.
 */
describe('Start over while a note waits to be sent', () => {
    const NOTE = 'a note nobody has received yet';
    async function waitingTextSend(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('button', {name: 'Text'}));
        await user.type(screen.getByPlaceholderText('Type or paste text to send'), NOTE);
        await user.click(screen.getByRole('button', {name: 'Send text'}));
        await waitFor(() => expect(wails.go.StartSendText).toHaveBeenCalledTimes(1));
        act(() => { wails.emit('send:code', {code: 'amber-otter-cloud', link: 'http://localhost:3000/#room=x'}); });
        expect(await screen.findByText('Waiting for the receiver')).toBeTruthy();
    }

    it('asks before clearing the note of a send that is waiting for its receiver', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await waitingTextSend(user);
        act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
        await user.keyboard('{Control>}r{/Control}');
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Starting over clears your unsent text')).toBeTruthy();
        expect(wails.go.CancelTransfer).not.toHaveBeenCalled();

        // Keep going keeps the waiting send, and the note with it: once that
        // send ends, the box shows the note again.
        await user.click(within(dialog).getByRole('button', {name: 'Keep going'}));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.getByText('Waiting for the receiver')).toBeTruthy();
        expect(wails.go.CancelTransfer).not.toHaveBeenCalled();
        act(() => { wails.emit('send:error', 'peer disconnected before connecting'); });
        expect((await screen.findByPlaceholderText('Type or paste text to send') as HTMLTextAreaElement).value).toBe(NOTE);
    });

    it('still resets a waiting send on the first press when nothing would be lost', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        act(() => { wails.emit('files:open', ['C:\\Users\\test\\a.txt']); });
        await user.click(await screen.findByRole('button', {name: 'Send 1 item'}));
        await waitFor(() => expect(wails.go.StartSend).toHaveBeenCalledTimes(1));
        act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
        await user.keyboard('{Control>}r{/Control}');
        await waitFor(() => expect(wails.go.CancelTransfer).toHaveBeenCalled());
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

/**
 * While a send or a receive runs, nothing new is staged: a drop, a paste,
 * Ctrl+O and a second launch are all refused. The Files and Folder buttons
 * were the one way that still worked during a receive, on a drop zone whose
 * own invitation to drag was being ignored.
 */
describe('the Send tab while a receive runs', () => {
    it('offers no way to add files until the receive ends', async () => {
        let finish: (dir: string) => void = () => {};
        wails.go.ReceiveByCode.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
        const user = userEvent.setup();
        mount();
        await settled();
        expect(screen.getByText('Select files to send')).toBeTruthy();
        expect(screen.getByText('Select or drag files, then click Send')).toBeTruthy();

        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.type(await screen.findByPlaceholderText('amber-otter-cloud'), 'amber-otter-cloud');
        await user.click(screen.getAllByRole('button', {name: 'Receive'}).find((b) => b.className.includes('w-full'))!);
        await waitFor(() => expect(wails.go.ReceiveByCode).toHaveBeenCalledTimes(1));

        await user.click(screen.getByRole('button', {name: 'Send'}));
        // The Files and Text choice stays; the drop zone and its two buttons go,
        // and so does the line that invites a drag.
        expect(screen.getByRole('button', {name: 'Text'})).toBeTruthy();
        expect(screen.queryByText('Select files to send')).toBeNull();
        expect(screen.queryByRole('button', {name: 'Folder'})).toBeNull();
        expect(screen.queryByText('Select or drag files, then click Send')).toBeNull();
        expect(wails.go.SelectFiles).not.toHaveBeenCalled();
        // A drop is refused, as it always was.
        act(() => { wails.drop?.(0, 0, ['C:\\Users\\test\\a.txt']); });
        expect(screen.queryByRole('button', {name: 'Send 1 item'})).toBeNull();

        // The receive ends and the drop zone is back.
        await act(async () => { finish('C:\\Users\\test\\Downloads'); });
        expect(await screen.findByText('Select files to send')).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Folder'})).toBeTruthy();
    });

    it('keeps what was staged before the receive, with Clear and the list still usable', async () => {
        wails.go.ReceiveByCode.mockImplementation(() => new Promise<string>(() => {}));
        const user = userEvent.setup();
        mount();
        await settled();
        act(() => { wails.emit('files:open', ['C:\\Users\\test\\a.txt', 'C:\\Users\\test\\b.txt']); });
        expect(await screen.findByRole('button', {name: 'Send 2 items'})).toBeTruthy();

        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.type(await screen.findByPlaceholderText('amber-otter-cloud'), 'amber-otter-cloud');
        await user.click(screen.getAllByRole('button', {name: 'Receive'}).find((b) => b.className.includes('w-full'))!);
        await waitFor(() => expect(wails.go.ReceiveByCode).toHaveBeenCalledTimes(1));

        await user.click(screen.getByRole('button', {name: 'Send'}));
        expect((screen.getByRole('button', {name: 'Send 2 items'}) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByRole('button', {name: 'Folder'})).toBeNull();
        await user.click(screen.getByRole('button', {name: 'Remove a.txt'}));
        expect(screen.getByRole('button', {name: 'Send 1 item'})).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Clear 1 item'})).toBeTruthy();
    });
});

/**
 * The File Explorer entry at launch (DSK-04; owner answer 26, "Off by default
 * on portable"). Go says whose the entry is (ContextMenuState): "self" turns
 * the switch on; "other" leaves another copy's entry alone and the switch
 * off; "missing" (no entry, or one whose program is gone) registers when the
 * owner last left the switch on ('floe:ctx-menu' is '1'), and with no choice
 * on record only on an installed copy (IsInstalled: uninstall.exe beside the
 * app), so an unzipped copy adds nothing to Explorer until asked; '0' never.
 * The installer's uninstaller removes the registry key and keeps the profile
 * that holds the marker, so after a reinstall a '1' brings the entry back.
 */
describe('the File Explorer entry at launch', () => {
    const switchOn = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', {name: 'Settings'}));
        return (await screen.findByRole('checkbox', {name: /^Show in right-click menu/}) as HTMLInputElement).checked;
    };
    // ContextMenuEnabled answers false in every case, as the Go method does
    // for an entry that is missing or another copy's.
    const launch = async (state: string, marker: string | null, installed: boolean) => {
        wails.go.ContextMenuEnabled.mockImplementation(async () => false);
        wails.go.ContextMenuState.mockImplementation(async () => state);
        wails.go.IsInstalled.mockImplementation(async () => installed);
        if (marker !== null) localStorage.setItem('floe:ctx-menu', marker);
        const user = userEvent.setup();
        mount();
        await settled();
        await waitFor(() => expect(wails.go.ContextMenuState).toHaveBeenCalled());
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        return user;
    };

    it('registers a missing entry again when the switch was last left on, on any copy', async () => {
        const user = await launch('missing', '1', false);
        await waitFor(() => expect(wails.go.EnableContextMenu).toHaveBeenCalled());
        // The owner's choice is not rewritten by the launch.
        expect(localStorage.getItem('floe:ctx-menu')).toBe('1');
        expect(await switchOn(user)).toBe(true);
    });

    it('registers it on the first run of an installed copy, and never writes the marker itself', async () => {
        const user = await launch('missing', null, true);
        await waitFor(() => expect(wails.go.EnableContextMenu).toHaveBeenCalled());
        expect(localStorage.getItem('floe:ctx-menu')).toBeNull();
        expect(await switchOn(user)).toBe(true);
    });

    it('registers nothing on the first run of a portable copy, and the switch reads off', async () => {
        const user = await launch('missing', null, false);
        expect(wails.go.EnableContextMenu).not.toHaveBeenCalled();
        expect(localStorage.getItem('floe:ctx-menu')).toBeNull();
        expect(await switchOn(user)).toBe(false);
    });

    it('leaves it off when the owner switched it off, installed or not', async () => {
        await launch('missing', '0', true);
        expect(wails.go.EnableContextMenu).not.toHaveBeenCalled();
    });

    // DESKTOP-01: an entry whose program is gone. Only a copy of Floe with the
    // switch on could have written it, and Floe Desktop 0.3.0 wrote one on the
    // first run of every copy without recording a choice, so a 0.3.0 portable
    // folder that was deleted or replaced leaves one behind with the marker
    // unset. This copy registers over it when it would register an entry at
    // all, and otherwise removes it, so Explorer never keeps a broken "Send
    // with Floe" behind a switch that reads off.
    it('registers over a dead entry when this copy would register one', async () => {
        for (const [marker, installed] of [['1', false], [null, true]] as const) {
            const user = await launch('dead', marker, installed);
            await waitFor(() => expect(wails.go.EnableContextMenu).toHaveBeenCalled());
            expect(wails.go.DisableContextMenu).not.toHaveBeenCalled();
            expect(localStorage.getItem('floe:ctx-menu')).toBe(marker);
            expect(await switchOn(user)).toBe(true);
            cleanup();
            localStorage.clear();
            vi.clearAllMocks();
        }
    });

    it('removes a dead entry this copy would not register, and the switch reads off', async () => {
        for (const [marker, installed] of [[null, false], ['0', true], ['0', false]] as const) {
            const user = await launch('dead', marker, installed);
            await waitFor(() => expect(wails.go.DisableContextMenu).toHaveBeenCalled());
            expect(wails.go.EnableContextMenu).not.toHaveBeenCalled();
            expect(localStorage.getItem('floe:ctx-menu')).toBe(marker);
            expect(await switchOn(user)).toBe(false);
            cleanup();
            localStorage.clear();
            vi.clearAllMocks();
        }
    });

    it("never re-points another copy's entry, and the switch reads off", async () => {
        for (const marker of [null, '1']) {
            const user = await launch('other', marker, true);
            expect(wails.go.EnableContextMenu).not.toHaveBeenCalled();
            expect(wails.go.DisableContextMenu).not.toHaveBeenCalled();
            expect(await switchOn(user)).toBe(false);
            cleanup();
            localStorage.clear();
        }
    });

    it("turns the switch on for this copy's own entry and writes nothing", async () => {
        const user = await launch('self', null, false);
        expect(wails.go.EnableContextMenu).not.toHaveBeenCalled();
        expect(await switchOn(user)).toBe(true);
    });

    it('asks nothing and writes nothing in a Store build', async () => {
        wails.go.IsPackaged.mockImplementation(async () => true);
        localStorage.setItem('floe:ctx-menu', '1');
        mount();
        await settled();
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(wails.go.ContextMenuState).not.toHaveBeenCalled();
        expect(wails.go.EnableContextMenu).not.toHaveBeenCalled();
    });
});
