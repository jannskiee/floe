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
import {describe, expect, it} from 'vitest';
import App from '../App';

// main.tsx wraps App in StrictMode, so the tests do too. Not ceremony:
// StrictMode double-invokes effects, which is what turns the balance assertion
// below from "counts 11" into "catches a handler registered twice and torn
// down once".
const mount = () => render(<StrictMode><App /></StrictMode>);

const settled = () => waitFor(() => expect(wails.listeners.size).toBe(11));

describe('the mount effect', () => {
    it('registers every Go listener and tears down every one', async () => {
        const {unmount} = mount();
        await settled();

        // Not a hand-copied list for its own sake: the assertion is that OFF
        // mirrors ON, whatever ON turns out to be.
        expect([...wails.listeners.keys()].sort()).toEqual([
            'close:blocked',
            'files:open',
            'recv:incoming',
            'recv:progress',
            'recv:route',
            'send:code',
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
