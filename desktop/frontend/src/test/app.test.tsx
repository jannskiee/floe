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
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import App from '../App';
// The generated declarations as text, through Vite's raw import (the frontend
// carries no Node types, so no fs).
import appDts from '../../wailsjs/go/main/App.d.ts?raw';
import {AnswerRequest, GetRequestLink, MakeRequestLink, RequestLinkSupport, SetRequestLinks} from '../../wailsjs/go/main/App';
import {REQUEST_BINDINGS} from './requestFixtures';

// main.tsx wraps App in StrictMode, so the tests do too. Not ceremony:
// StrictMode double-invokes effects, which is what turns the balance assertion
// below from "counts 11" into "catches a handler registered twice and torn
// down once".
const mount = () => render(<StrictMode><App /></StrictMode>);

const settled = () => waitFor(() => expect(wails.listeners.size).toBe(13));

describe('the mount effect', () => {
    it('registers every Go listener and tears down every one', async () => {
        const {unmount} = mount();
        await settled();

        // Not a hand-copied list for its own sake: the assertion is that OFF
        // mirrors ON, whatever ON turns out to be.
        // The last two belong to the verification effect that sits after this
        // one, with its own teardown; the balance assertion below covers both.
        expect([...wails.listeners.keys()].sort()).toEqual([
            'close:blocked',
            'files:open',
            'recv:file-done',
            'recv:incoming',
            'recv:progress',
            'recv:route',
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

    // FT-03: the Request link is off by default, and off means off. Nothing
    // of the feature may run at launch, not even a probe, so a build whose
    // lane is broken cannot touch a user who never turned it on.
    it('runs no request binding at mount while the switch is off', async () => {
        mount();
        await settled();
        await waitFor(() => expect(wails.go.GetSettings).toHaveBeenCalled());
        // Let the GetSettings promise and every effect it schedules settle.
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

        for (const name of REQUEST_BINDINGS) {
            expect(wails.go[name], name).not.toHaveBeenCalled();
        }
        expect([...wails.listeners.keys()].filter((k) => k.startsWith('request:'))).toEqual([]);
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

        await user.click(within(dialog).getByRole('button', {name: 'Close anyway'}));
        expect(wails.go.ConfirmClose).toHaveBeenCalledTimes(1);

        // The dialog stays up. Go owns the exit, and clearing it here would
        // show the live UI for the duration of teardown.
        expect(screen.getByRole('dialog')).toBeTruthy();

        // A second event cannot stack dialogs.
        act(() => {
            wails.emit('close:blocked');
        });
        expect(screen.getAllByRole('dialog')).toHaveLength(1);

        // Keep going is the only local dismissal, and it hands focus off.
        await user.click(within(dialog).getByRole('button', {name: 'Keep going'}));
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
            await screen.findByText(/uses localhost:3001\. Both people must be on the same server\./)
        ).toBeTruthy();
    });

    it('send:status reaches the send view through its frozen closure', async () => {
        mount();
        await settled();

        act(() => {
            wails.emit('send:status', 'Peer connected. Sending...');
        });

        // The handler is registered once, at mount. It reads sendCancel.current
        // and calls only stable setters, which is the discipline that makes the
        // whole mount effect correct; a decomposition that reads state here
        // under an empty dependency array sees a value frozen at first render.
        expect(await screen.findByText('Peer connected. Sending...')).toBeTruthy();
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
        expect(await screen.findByText('SHA-256 matched')).toBeTruthy();

        // A short count is not a match, and a count the validator refused
        // (hasVerified false) is absent, never "all matched".
        act(() => {
            wails.emit('send:delivered', {files: 2, verified: 1, hasVerified: true});
        });
        await waitFor(() => expect(screen.queryByText('SHA-256 matched')).toBeNull());

        act(() => {
            wails.emit('send:delivered', {files: 2, verified: 2, hasVerified: false});
        });
        await waitFor(() => expect(screen.queryByText('SHA-256 matched')).toBeNull());
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
        expect(await screen.findByText('SHA-256 matched')).toBeTruthy();

        // A second receive starts from nothing: the counters are reset in
        // receive(), so the previous transfer's verdict cannot carry over.
        await user.click(start());
        await waitFor(() => expect(screen.queryByText('SHA-256 matched')).toBeNull());
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
        expect(screen.queryByText('No transfers yet.')).toBeNull();
    });

    it('shows the empty state when there is no history', async () => {
        mount();
        await settled();

        await userEvent.click(screen.getByRole('button', {name: 'History'}));

        expect(await screen.findByText('No transfers yet.')).toBeTruthy();
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
        await expect(MakeRequestLink('Acme footage', '', '24h')).resolves.toMatchObject({state: 'error', code: 'disabled'});
        await expect(GetRequestLink()).resolves.toMatchObject({state: 'off', link: ''});
        await expect(AnswerRequest(1, 'accept')).resolves.toMatchObject({state: 'off'});
        await expect(RequestLinkSupport()).resolves.toEqual({reachable: false, requestLinks: false});
        await expect(SetRequestLinks(true)).rejects.toThrow();
        await expect(SetRequestLinks(false)).resolves.toBeUndefined();
    });
});

/**
 * Settings > Beta > Request links (S1-DSK-02). Off by default, usable only
 * against a server whose /health lists request-1, reset by Reset all settings.
 */
describe('the Beta switch', () => {
    const betaSwitch = () => screen.getByRole('checkbox', {name: /^Request links/}) as HTMLInputElement;

    it('Beta section sits after Windows and before Advanced', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));

        const headings = screen.getAllByRole('heading', {level: 3}).map((h) => h.textContent);
        expect(headings).toEqual(['Transfers', 'Privacy', 'Windows', 'Beta', 'Advanced', 'About']);
    });

    it('a disabled setting row ignores clicks', async () => {
        // The stubbed probe: the server is not reachable, so the switch is
        // disabled with the server line.
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));

        const line = await screen.findByText('Not available on this server right now.');
        await waitFor(() => expect(wails.go.RequestLinkSupport).toHaveBeenCalled());
        const sw = betaSwitch();
        expect(sw.disabled).toBe(true);
        expect(sw.closest('label')?.getAttribute('aria-disabled')).toBe('true');

        await user.click(line);
        await user.click(screen.getByText('Request links'));
        expect(sw.checked).toBe(false);
        expect(wails.go.SetRequestLinks).not.toHaveBeenCalled();
    });

    it('turns on against a server that lists request-1, and a refused save reverts it', async () => {
        wails.go.RequestLinkSupport.mockImplementation(async () => ({reachable: true, requestLinks: true}));
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));

        await screen.findByText('Let someone send files to this PC through a link you make. Works while Floe is open.');
        await waitFor(() => expect(betaSwitch().disabled).toBe(false));

        // The stub setter refuses to turn on, so the switch must not stay on.
        await user.click(betaSwitch());
        expect(wails.go.SetRequestLinks).toHaveBeenCalledWith(true);
        await waitFor(() => expect(betaSwitch().checked).toBe(false));

        // A setter that saves keeps it on.
        wails.go.SetRequestLinks.mockImplementation(async () => {});
        await user.click(betaSwitch());
        await waitFor(() => expect(betaSwitch().checked).toBe(true));
    });

    it('reset all settings turns request links off', async () => {
        wails.go.GetSettings.mockImplementation(async () => ({
            server: '', web: '', hideIP: false, reportStats: true, noUpdateCheck: false,
            requestLinks: true, migrated: true,
        }));
        wails.go.RequestLinkSupport.mockImplementation(async () => ({reachable: true, requestLinks: true}));
        wails.go.SetRequestLinks.mockImplementation(async () => {});
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));
        await waitFor(() => expect(betaSwitch().checked).toBe(true));

        await user.click(screen.getByRole('button', {name: 'Reset'}));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', {name: 'Reset all settings'}));

        expect(wails.go.SetRequestLinks).toHaveBeenCalledWith(false);
        await waitFor(() => expect(betaSwitch().checked).toBe(false));
    });

    it('a Settings save sends only the fields SetSettings owns', async () => {
        // The Go side carries RequestLinks over (settingsFromArgs); the
        // frontend's half is never to route the switch through SetSettings,
        // whose four arguments have no place for it.
        wails.go.RequestLinkSupport.mockImplementation(async () => ({reachable: true, requestLinks: true}));
        wails.go.SetRequestLinks.mockImplementation(async () => {});
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getByRole('button', {name: 'Settings'}));
        await waitFor(() => expect(betaSwitch().disabled).toBe(false));
        await user.click(betaSwitch());
        await user.click(screen.getByRole('checkbox', {name: /^Hide my IP address/}));

        expect(wails.go.SetRequestLinks).toHaveBeenCalledTimes(1);
        for (const call of wails.go.SetSettings.mock.calls) expect(call).toHaveLength(4);
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
    const cp2 = 'That is a request link for sending files to someone. Open it in a web browser.';
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
        wails.go.GetSettings.mockImplementation(async () => ({
            server: '', web: '', hideIP: false, reportStats: true, noUpdateCheck: false,
            requestLinks: true, migrated: true,
        }));
        await paste(link);
        expect(await screen.findByText(cp2)).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Open in browser'})).toBeTruthy();
        expect(wails.go.ReceiveByCode).not.toHaveBeenCalled();
        // Nothing was started, so there is nothing to cancel.
        expect(screen.queryByRole('button', {name: 'Cancel'})).toBeNull();
    });

    it('request link pasted into CODE with the Beta switch off shows the same sentence', async () => {
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
 * row rules, the header marker, the close guard and Start over copy, and the
 * next-launch line. Go's side is the mock: a test plays the lane by emitting
 * request:state snapshots.
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

    function switchOn(feature = true) {
        wails.go.GetSettings.mockImplementation(async () => ({
            server: '', web: '', hideIP: false, reportStats: true, noUpdateCheck: false, requestLinks: true, migrated: true,
        }));
        wails.go.RequestLinkSupport.mockImplementation(async () => ({reachable: true, requestLinks: feature}));
    }
    const allOn = () => waitFor(() => expect(wails.listeners.size).toBe(15));
    const push = (s: Record<string, unknown>) => act(() => { wails.emit('request:state', s); });
    const receiveTab = () => screen.getAllByRole('button', {name: 'Receive'})[0];
    const requestButton = () => screen.getByRole('button', {name: 'Request link, beta'});

    it('registers every Go listener and tears down every one, the request events included', async () => {
        switchOn();
        const {unmount} = mount();
        await allOn();
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
        switchOn();
        mount();
        await allOn();
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

    it('row hidden when the switch is off or the feature is missing', async () => {
        // Off (the default): no row, and REQUEST LINK cannot be reached.
        const first = mount();
        await settled();
        await userEvent.click(receiveTab());
        expect(screen.queryByRole('button', {name: 'Request link, beta'})).toBeNull();
        first.unmount();

        // On, but the server lacks request-1.
        switchOn(false);
        mount();
        await allOn();
        await userEvent.click(receiveTab());
        await waitFor(() => expect(wails.go.RequestLinkSupport).toHaveBeenCalled());
        expect(screen.queryByRole('button', {name: 'Request link, beta'})).toBeNull();
        expect(screen.getByPlaceholderText('amber-otter-cloud')).toBeTruthy();
    });

    it('row stays while a drop runs after request-1 disappears', async () => {
        switchOn(true);
        mount();
        await allOn();
        await userEvent.click(receiveTab());
        await waitFor(() => expect(requestButton()).toBeTruthy());
        push(lane('receiving', {gen: 2, route: 'direct'}));

        // The kill switch flips on the server: the next probe says no.
        wails.go.RequestLinkSupport.mockImplementation(async () => ({reachable: true, requestLinks: false}));
        const probes = wails.go.RequestLinkSupport.mock.calls.length;
        await userEvent.click(screen.getByRole('button', {name: 'Send'}));
        await userEvent.click(receiveTab());
        await waitFor(() => expect(wails.go.RequestLinkSupport.mock.calls.length).toBeGreaterThan(probes));
        await act(async () => { await Promise.resolve(); });
        expect(requestButton()).toBeTruthy();
        expect(screen.getByText(/RECEIVING/)).toBeTruthy();

        // Once the drop is over and put away, the row goes.
        push(lane('done', {gen: 2, result: {files: 1, saved: 1, bytes: 1, verified: 1, renamed: 0, folder: 'D:\\x', names: ['a']}}));
        await userEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
        await waitFor(() => expect(screen.queryByRole('button', {name: 'Request link, beta'})).toBeNull());
    });

    it('CODE and REQUEST LINK use aria-pressed', async () => {
        switchOn();
        mount();
        await allOn();
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

    it('inactive choice labels use zinc-400', async () => {
        switchOn();
        mount();
        await allOn();
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
        switchOn();
        mount();
        await allOn();
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
        expect(screen.getByText('Keep this window open. Closing it cancels the transfer.')).toBeTruthy();
    });

    it('Ctrl+Enter does nothing on REQUEST LINK', async () => {
        switchOn();
        const user = userEvent.setup();
        mount();
        await allOn();
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

    it('close guard with an open link shows Keep Floe open and Close Floe', async () => {
        switchOn();
        const user = userEvent.setup();
        mount();
        await allOn();
        push(lane('waiting'));
        act(() => { wails.emit('close:blocked'); });
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Close Floe?')).toBeTruthy();
        expect(within(dialog).getByText('Your request link stops working until you make a new one.')).toBeTruthy();
        const keep = within(dialog).getByRole('button', {name: 'Keep Floe open'});
        expect(document.activeElement).toBe(keep);
        await user.click(within(dialog).getByRole('button', {name: 'Close Floe'}));
        expect(wails.go.ConfirmClose).toHaveBeenCalledTimes(1);
    });

    it('close guard with a drop receiving shows the receiving sentence', async () => {
        switchOn();
        mount();
        await allOn();
        push(lane('receiving', {gen: 2, route: 'relay'}));
        act(() => { wails.emit('close:blocked'); });
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText("You're still receiving. If you close now, the transfer stops before the files finish.")).toBeTruthy();
        expect(within(dialog).getByRole('button', {name: 'Keep going'})).toBeTruthy();
        expect(within(dialog).getByRole('button', {name: 'Close anyway'})).toBeTruthy();
    });

    it('close guard with a send and a link adds the link sentence', async () => {
        switchOn();
        const user = userEvent.setup();
        mount();
        await allOn();
        push(lane('waiting'));
        await user.click(screen.getByRole('button', {name: 'Text'}));
        await user.type(screen.getByPlaceholderText('Type or paste text to send'), 'hello');
        await user.click(screen.getByRole('button', {name: /Send text/}));
        act(() => { wails.emit('close:blocked'); });
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain(
            "You're still sending. If you close now, the transfer stops and the other side gets nothing. Your request link also stops working.",
        );
        expect(within(dialog).getByRole('button', {name: 'Keep going'})).toBeTruthy();
    });

    it('the Start over dialog says the link stays open', async () => {
        switchOn();
        const user = userEvent.setup();
        mount();
        await allOn();
        push(lane('waiting'));
        await user.click(screen.getByRole('button', {name: 'Text'}));
        await user.type(screen.getByPlaceholderText('Type or paste text to send'), 'an unsent note');
        act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
        await user.keyboard('{Control>}r{/Control}');
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Your request link stays open.')).toBeTruthy();
        // Start over never touches the lane.
        await user.click(within(dialog).getByRole('button', {name: 'Start over'}));
        expect(wails.go.CloseRequestLink).not.toHaveBeenCalled();
    });

    it('the header marker opens REQUEST LINK and never switches tabs by itself', async () => {
        switchOn();
        const user = userEvent.setup();
        mount();
        await allOn();
        push(lane('waiting'));
        // Still on Send: the marker appeared, the view did not move.
        const marker = await screen.findByRole('button', {name: 'Request link is open'});
        expect(marker.textContent).toBe('link open');
        expect(screen.getByRole('button', {name: 'Text'})).toBeTruthy();
        await user.click(marker);
        expect(await screen.findByRole('button', {name: 'Close link'})).toBeTruthy();
    });

    it('a prompt raises the notice elsewhere, announces once, and Review opens it', async () => {
        switchOn();
        const user = userEvent.setup();
        mount();
        await allOn();
        push(lane('deciding', {gen: 2, promptGen: 1, prompt}));
        const notice = await screen.findByRole('group', {name: 'Someone wants to send you files.'});
        const spans = [...document.querySelectorAll('span.sr-only[role="status"]')].map((s) => s.textContent);
        expect(spans).toContain('Request link: someone wants to send you files.');
        expect(wails.go.AnswerRequest).not.toHaveBeenCalled();
        await user.click(within(notice).getByRole('button', {name: 'Review'}));
        await waitFor(() => expect(document.activeElement?.id).toBe('floe-request-prompt-heading'));
        expect(screen.getByText('ACME FOOTAGE WANTS TO SEND YOU FILES')).toBeTruthy();
    });

    it('the link stopped when Floe closed line shows once after relaunch', async () => {
        switchOn();
        localStorage.setItem('floe:requestLinkOpenUntil', String(Date.now() + 3600_000));
        const first = mount();
        await allOn();
        await userEvent.click(receiveTab());
        expect(await screen.findByText('This link stopped when Floe closed. Make a new one.')).toBeTruthy();
        expect(localStorage.getItem('floe:requestLinkOpenUntil')).toBeNull();
        first.unmount();

        // The next launch has nothing to say.
        mount();
        await allOn();
        await userEvent.click(receiveTab());
        await waitFor(() => expect(requestButton()).toBeTruthy());
        await userEvent.click(requestButton());
        expect(screen.queryByText('This link stopped when Floe closed. Make a new one.')).toBeNull();
        expect(screen.getByRole('button', {name: 'Make link'})).toBeTruthy();
    });

    it('keeps only the end time, never the link, and clears it when the link ends', async () => {
        switchOn();
        mount();
        await allOn();
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
        switchOn();
        localStorage.setItem('floe:requestSaveDir', 'D:\\Footage\\Floe requests');
        const user = userEvent.setup();
        mount();
        await allOn();
        await user.click(receiveTab());
        await user.click(requestButton());
        await user.type(screen.getByLabelText('Label'), 'Acme footage');
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(wails.go.MakeRequestLink).toHaveBeenCalledWith('Acme footage', 'D:\\Footage\\Floe requests', '24h');
        // The stub refuses (FT-03): the disabled sentence, never a link.
        expect(await screen.findByText('Request links are turned off on the Floe server right now. Nothing else is affected.')).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Copy link'})).toBeNull();
    });
});

describe('visitor names in the app', () => {
    const HOSTILE = ['<img src=x onerror=alert(1)>', '$(calc)', ']]><', '\u202Eevil.exe'];

    it('a hostile name is never passed to any Wails call', async () => {
        wails.go.GetSettings.mockImplementation(async () => ({
            server: '', web: '', hideIP: false, reportStats: true, noUpdateCheck: false, requestLinks: true, migrated: true,
        }));
        wails.go.RequestLinkSupport.mockImplementation(async () => ({reachable: true, requestLinks: true}));
        const user = userEvent.setup();
        mount();
        await waitFor(() => expect(wails.listeners.size).toBe(15));
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
            await user.click(screen.getByRole('button', {name: 'Dismiss'}));
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

describe('request drops in History', () => {
    it('a terminal request snapshot appends exactly one history row', async () => {
        wails.go.GetSettings.mockImplementation(async () => ({
            server: '', web: '', hideIP: false, reportStats: true, noUpdateCheck: false, requestLinks: true, migrated: true,
        }));
        wails.go.RequestLinkSupport.mockImplementation(async () => ({reachable: true, requestLinks: true}));
        const user = userEvent.setup();
        mount();
        await waitFor(() => expect(wails.listeners.size).toBe(15));
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

        // A stop with nothing saved adds no row; the next drop's result does.
        act(() => { wails.emit('request:state', {...base, gen: 4, state: 'stopped', code: 'relay-cap', result: {...done.result, saved: 0}}); });
        act(() => { wails.emit('request:state', {...base, gen: 5, state: 'stopped', code: 'disk-full', result: {...done.result, saved: 2}}); });
        await waitFor(() => expect(JSON.parse(localStorage.getItem('floe:history') || '[]')).toHaveLength(2));
        expect(JSON.parse(localStorage.getItem('floe:history') || '[]')[0]).toMatchObject({stopped: 'disk-full', count: 2, offered: 3});

        await user.click(screen.getByRole('button', {name: 'History'}));
        expect(screen.getAllByText('Acme footage')).toHaveLength(2);
    });
});
