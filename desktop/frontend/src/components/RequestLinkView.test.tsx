// @vitest-environment jsdom
/**
 * Receive > REQUEST LINK as the owner sees it (S1-DSK-06). The Accept guard,
 * the fixed Close link box, and the rule that a visitor's words reach the
 * screen only as text and never reach a binding.
 */
import {act, fireEvent, render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import RequestLinkView, {type RequestLinkViewProps} from './RequestLinkView';
import {OFF_SNAPSHOT, type Phase, type RequestLinkSnapshot} from '../requestLink';
import type {Prog} from '../progress';

const HOSTILE = ['<img src=x onerror=alert(1)>', '$(calc)', ']]><', '\u202Eevil.exe'];
const GB = 1024 ** 3;
const T0 = new Date(2026, 8, 14, 13, 0).getTime();

const snap = (over: Partial<RequestLinkSnapshot>): RequestLinkSnapshot => ({
    ...OFF_SNAPSHOT,
    gen: 3,
    promptGen: 7,
    link: 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f',
    label: 'Acme footage',
    saveDir: 'D:\\Footage\\Floe requests',
    expiresAt: T0 + 3600_000,
    ...over,
});

const prompt = {files: 12, totalBytes: 38 * GB, folder: 'Floe requests\\Acme footage 2026-09-14 1405', freeBytes: 500 * GB, warnings: [], answerBy: T0 + 9 * 60000};
const result = {files: 12, saved: 12, bytes: 38 * GB, verified: 12, renamed: 0, folder: 'D:\\Footage\\Floe requests\\Acme footage 2026-09-14 1405', names: ['a.mov']};

const progress = (fileName: string): Prog => ({
    fileName, fileIndex: 4, fileCount: 12, fileBytes: 10, fileSize: 100, totalBytes: 1.2 * GB, grandTotal: 2.5 * GB, savedName: fileName,
});

const BY_PHASE: Record<Exclude<Phase, 'off'>, RequestLinkSnapshot> = {
    ready: snap({state: 'ready', link: ''}),
    making: snap({state: 'making', link: ''}),
    error: snap({state: 'error', code: 'limited', link: ''}),
    waiting: snap({state: 'waiting'}),
    reconnecting: snap({state: 'reconnecting', reconnectUntil: T0 + 3600_000}),
    connecting: snap({state: 'connecting'}),
    deciding: snap({state: 'deciding', prompt}),
    declined: snap({state: 'declined'}),
    receiving: snap({state: 'receiving', route: 'direct'}),
    done: snap({state: 'done', result}),
    stopped: snap({state: 'stopped', code: 'disk-full', result: {...result, saved: 4}}),
    ended: snap({state: 'ended', code: 'expired'}),
};

function props(over: Partial<RequestLinkViewProps> = {}): RequestLinkViewProps {
    return {
        phase: 'waiting',
        snap: BY_PHASE.waiting,
        errorCode: '',
        progress: null,
        hideIP: false,
        saveDir: '',
        onSaveDirChange: vi.fn(),
        onMake: vi.fn(),
        onClose: vi.fn(),
        onAnswer: vi.fn(),
        onCancelDrop: vi.fn(),
        onRetry: vi.fn(),
        onShowInFolder: vi.fn(),
        onDismiss: vi.fn(),
        onMakeAnother: vi.fn(),
        onBrowse: vi.fn(),
        onEdit: vi.fn(),
        onGuardLift: vi.fn(),
        onPromptVisible: vi.fn(),
        ...over,
    };
}

const at = (phase: Exclude<Phase, 'off'>, over: Partial<RequestLinkViewProps> = {}) => props({phase, snap: BY_PHASE[phase], ...over});

// A pointer click the way a mouse makes one: down on the button, then click.
function mouseClick(el: HTMLElement) {
    fireEvent.pointerDown(el);
    fireEvent.click(el, {detail: 1});
}

describe('the Accept guard', () => {
    beforeEach(() => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
        vi.setSystemTime(T0);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('guard blocks clicks for 1 s', () => {
        const p = at('deciding');
        render(<RequestLinkView {...p}/>);
        const accept = screen.getByRole('button', {name: 'Accept'});
        const decline = screen.getByRole('button', {name: 'Decline'});
        expect(accept.getAttribute('aria-disabled')).toBe('true');
        expect(decline.getAttribute('aria-disabled')).toBe('true');

        // At 0, 400 and 599 ms: mouse clicks on both, and a keyboard activation.
        for (const step of [0, 400, 199]) {
            act(() => { vi.advanceTimersByTime(step); });
            mouseClick(accept);
            mouseClick(decline);
            fireEvent.click(accept); // a keyboard activation, detail 0
        }
        act(() => { vi.advanceTimersByTime(399); }); // 998 ms after render
        mouseClick(accept);
        expect(p.onAnswer).not.toHaveBeenCalled();

        act(() => { vi.advanceTimersByTime(2); });
        expect(accept.getAttribute('aria-disabled')).toBe('false');
        mouseClick(accept);
        expect(p.onAnswer).toHaveBeenCalledTimes(1);
        expect(p.onAnswer).toHaveBeenCalledWith(7, 'accept');
    });

    it('Enter and Space accept after the guard', async () => {
        // Real timers here: user-event's keyboard path awaits the test
        // library's async wrapper, which cannot see vitest's fake clock.
        vi.useRealTimers();
        const p = at('deciding');
        render(<RequestLinkView {...p}/>);
        const user = userEvent.setup();
        const accept = screen.getByRole('button', {name: 'Accept'});
        const decline = screen.getByRole('button', {name: 'Decline'});

        accept.focus();
        await user.keyboard('{Enter}');
        await user.keyboard(' ');
        expect(p.onAnswer).not.toHaveBeenCalled();

        await act(async () => { await new Promise((r) => setTimeout(r, 1050)); });
        accept.focus();
        await user.keyboard('{Enter}');
        expect(p.onAnswer).toHaveBeenLastCalledWith(7, 'accept');
        decline.focus();
        await user.keyboard(' ');
        expect(p.onAnswer).toHaveBeenLastCalledWith(7, 'decline');
        expect(p.onAnswer).toHaveBeenCalledTimes(2);
    });

    it('guard re-arms for 1 s when the window regains focus', () => {
        const p = at('deciding');
        render(<RequestLinkView {...p}/>);
        const accept = screen.getByRole('button', {name: 'Accept'});
        act(() => { vi.advanceTimersByTime(1500); });
        expect(accept.getAttribute('aria-disabled')).toBe('false');

        act(() => { window.dispatchEvent(new Event('focus')); });
        expect(accept.getAttribute('aria-disabled')).toBe('true');
        act(() => { vi.advanceTimersByTime(999); });
        mouseClick(accept);
        fireEvent.click(accept);
        expect(p.onAnswer).not.toHaveBeenCalled();

        act(() => { vi.advanceTimersByTime(1); });
        expect(accept.getAttribute('aria-disabled')).toBe('false');
        mouseClick(accept);
        expect(p.onAnswer).toHaveBeenCalledTimes(1);
    });

    it('ignores a click whose pointerdown came before the prompt rendered', () => {
        const p = at('waiting');
        const {rerender} = render(<RequestLinkView {...p}/>);
        act(() => { vi.advanceTimersByTime(5000); });
        rerender(<RequestLinkView {...p} phase="deciding" snap={BY_PHASE.deciding}/>);
        act(() => { vi.advanceTimersByTime(2000); });
        // A click with no pointerdown on this button (the press began on
        // whatever was there before) is not an answer.
        fireEvent.click(screen.getByRole('button', {name: 'Accept'}), {detail: 1});
        expect(p.onAnswer).not.toHaveBeenCalled();
    });

    it('a click at the old Dismiss position during the mount frame sends no decision', () => {
        // Done has Dismiss on the right rail; the next prompt mounts with
        // Decline on the right. Whatever a click lands on in the frame the
        // prompt appears, nothing is decided.
        const p = at('done');
        const {rerender} = render(<RequestLinkView {...p}/>);
        expect(screen.getByRole('button', {name: 'Dismiss'})).toBeTruthy();
        rerender(<RequestLinkView {...p} phase="deciding" snap={snap({state: 'deciding', gen: 5, promptGen: 1, prompt})}/>);
        for (const name of ['Accept', 'Decline', 'Close link', 'Copy link']) {
            mouseClick(screen.getByRole('button', {name}));
        }
        expect(p.onAnswer).not.toHaveBeenCalled();
    });

    it('guard lift is announced once', () => {
        const p = at('deciding');
        render(<RequestLinkView {...p}/>);
        expect(p.onGuardLift).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1000); });
        expect(p.onGuardLift).toHaveBeenCalledTimes(1);
        act(() => { window.dispatchEvent(new Event('focus')); });
        act(() => { vi.advanceTimersByTime(2000); });
        expect(p.onGuardLift).toHaveBeenCalledTimes(1);
    });

    it('re-arms for a new prompt', () => {
        const p = at('deciding');
        const {rerender} = render(<RequestLinkView {...p}/>);
        act(() => { vi.advanceTimersByTime(1500); });
        rerender(<RequestLinkView {...p} snap={{...BY_PHASE.deciding, promptGen: 8}}/>);
        mouseClick(screen.getByRole('button', {name: 'Accept'}));
        expect(p.onAnswer).not.toHaveBeenCalled();
        expect(screen.getByRole('button', {name: 'Accept'}).getAttribute('aria-disabled')).toBe('true');
    });
});

describe('the fixed Close link box', () => {
    it('close link box does not move', () => {
        const p = at('waiting');
        const {rerender} = render(<RequestLinkView {...p}/>);
        const close = screen.getByRole('button', {name: 'Close link'});
        const parent = close.parentElement!;
        const index = [...parent.children].indexOf(close);

        for (const phase of ['reconnecting', 'connecting', 'deciding', 'declined', 'waiting'] as const) {
            rerender(<RequestLinkView {...p} phase={phase} snap={BY_PHASE[phase]}/>);
            const now = screen.getByRole('button', {name: 'Close link'});
            expect(now, phase).toBe(close);
            expect(now.parentElement, phase).toBe(parent);
            expect([...parent.children].indexOf(now), phase).toBe(index);
        }
        // And the prompt mounts after it, below the hairline.
        rerender(<RequestLinkView {...p} phase="deciding" snap={BY_PHASE.deciding}/>);
        const accept = screen.getByRole('button', {name: 'Accept'});
        expect(close.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});

describe('visitor text', () => {
    it('hostile names render as text', () => {
        for (const name of HOSTILE) {
            const {container, unmount} = render(<RequestLinkView {...at('receiving', {progress: progress(name)})}/>);
            expect(container.querySelector('img')).toBeNull();
            expect(container.querySelector('script')).toBeNull();
            expect(screen.getByText(name, {exact: true}).textContent).toBe(name);
            unmount();
        }
    });

    it('a hostile name is never passed to any Wails call', async () => {
        const user = userEvent.setup();
        const calls: unknown[][] = [];
        const record = () => vi.fn((...a: unknown[]) => { calls.push(a); });
        for (const name of HOSTILE) {
            const p = at('receiving', {
                progress: progress(name),
                onCancelDrop: record(), onShowInFolder: record(), onDismiss: record(), onMakeAnother: record(),
                onClose: record(), onAnswer: record(), onRetry: record(), onMake: record(), onBrowse: record(),
            });
            const {unmount, rerender} = render(<RequestLinkView {...p}/>);
            for (const b of screen.getAllByRole('button')) await user.click(b);
            // The result names of a finished drop do not render on the card and
            // never ride a callback either.
            rerender(<RequestLinkView {...p} phase="done" snap={snap({state: 'done', result: {...result, names: [name]}})}/>);
            for (const b of screen.getAllByRole('button')) await user.click(b);
            unmount();
        }
        expect(calls.length).toBeGreaterThan(0);
        const flat = JSON.stringify(calls);
        for (const name of HOSTILE) expect(flat.includes(JSON.stringify(name).slice(1, -1))).toBe(false);
    });

    it('the prompt never renders a file name', () => {
        const first = 'Call +1 555 0100 to confirm.txt';
        const lure = snap({
            state: 'deciding',
            // A future field, or a mistaken one, must still not reach the prompt.
            prompt: {...prompt, firstName: first, names: [first]} as unknown as RequestLinkSnapshot['prompt'],
        });
        const {container} = render(<RequestLinkView {...at('deciding', {snap: lure, progress: progress(first)})}/>);
        expect(container.textContent).not.toContain(first);
        expect(container.textContent).not.toContain('555 0100');
    });
});

describe('the result card', () => {
    it('Show in folder asks first only when files were renamed', async () => {
        const user = userEvent.setup();
        const plain = at('done');
        const {unmount} = render(<RequestLinkView {...plain}/>);
        await user.click(screen.getByRole('button', {name: 'Show in folder'}));
        expect(plain.onShowInFolder).toHaveBeenCalledWith(result.folder);
        expect(screen.queryByRole('dialog')).toBeNull();
        unmount();

        for (const s of [snap({state: 'done', result: {...result, renamed: 2}}), snap({state: 'stopped', code: 'disk-full', result: {...result, saved: 4, renamed: 1}})]) {
            const p = props({phase: s.state as Phase, snap: s});
            const r = render(<RequestLinkView {...p}/>);
            await user.click(screen.getByRole('button', {name: 'Show in folder'}));
            const dialog = screen.getByRole('dialog');
            expect(within(dialog).getByText('This drop contains renamed files.')).toBeTruthy();
            expect(within(dialog).getByText('Open the folder anyway?')).toBeTruthy();
            // The safe choice has focus.
            expect(document.activeElement).toBe(within(dialog).getByRole('button', {name: 'Cancel'}));
            expect(p.onShowInFolder).not.toHaveBeenCalled();
            await user.click(within(dialog).getByRole('button', {name: 'Cancel'}));
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(p.onShowInFolder).not.toHaveBeenCalled();
            await user.click(screen.getByRole('button', {name: 'Show in folder'}));
            await user.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Show in folder'}));
            expect(p.onShowInFolder).toHaveBeenCalledTimes(1);
            expect(p.onShowInFolder).toHaveBeenCalledWith(result.folder);
            r.unmount();
        }
    });

    it('shows the SHA-256 line only when every file verified', () => {
        const {rerender} = render(<RequestLinkView {...at('done')}/>);
        expect(screen.getByText("Every file arrived intact: its SHA-256 matched the sender's.")).toBeTruthy();
        rerender(<RequestLinkView {...at('done')} snap={snap({state: 'done', result: {...result, verified: 11}})}/>);
        expect(screen.queryByText(/SHA-256/)).toBeNull();
        // No hash value or digest-shaped text anywhere.
        expect(document.body.textContent).not.toMatch(/[0-9a-f]{16,}/);
    });

    it('a stop with nothing saved shows no folder and no follow-up (DT-05)', () => {
        render(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'relay-cap', result: {...result, saved: 0}})}/>);
        expect(screen.getByText('Over 2 GB through the relay, so it stopped before any file was saved.')).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Show in folder'})).toBeNull();
        expect(screen.queryByText('The sender can send the rest with a new link.')).toBeNull();
    });
});

describe('every state', () => {
    const phases = Object.keys(BY_PHASE) as Exclude<Phase, 'off'>[];

    it('no Open button in any state', () => {
        for (const phase of phases) {
            const {unmount} = render(<RequestLinkView {...at(phase, {progress: progress('a.mov')})}/>);
            expect(screen.queryByRole('button', {name: /^open$/i}), phase).toBeNull();
            for (const b of screen.queryAllByRole('button')) expect(b.textContent?.trim(), phase).not.toBe('Open');
            unmount();
        }
    });

    it('no QR control in any state', () => {
        for (const phase of phases) {
            const {container, unmount} = render(<RequestLinkView {...at(phase, {progress: progress('a.mov')})}/>);
            expect(container.textContent, phase).not.toMatch(/QR/);
            expect(container.querySelector('svg[viewBox="0 0 21 21"]'), phase).toBeNull(); // react-qr-code
            unmount();
        }
    });

    it('Browse is disabled from deciding through done', () => {
        for (const phase of ['deciding', 'declined', 'receiving', 'done', 'stopped', 'making'] as const) {
            const {unmount} = render(<RequestLinkView {...at(phase, {progress: progress('a.mov')})}/>);
            for (const b of screen.queryAllByRole('button', {name: /Browse/})) {
                expect((b as HTMLButtonElement).disabled, phase).toBe(true);
            }
            unmount();
        }
        render(<RequestLinkView {...at('ready')}/>);
        expect((screen.getByRole('button', {name: /Browse/}) as HTMLButtonElement).disabled).toBe(false);
    });

    it('never renders engine or error text, only the fixed line for the code', () => {
        render(<RequestLinkView {...at('error', {errorCode: 'Error: dial tcp 10.0.0.1: refused $(calc)'})}/>);
        expect(screen.getByRole('alert').textContent).toBe('Floe could not make a link. Try again later.');
        expect(document.body.textContent).not.toContain('dial tcp');
    });

    it('Make link sends the trimmed label and the lifetime', async () => {
        const user = userEvent.setup();
        const p = at('ready');
        render(<RequestLinkView {...p}/>);
        await user.type(screen.getByLabelText('Label'), '  Acme footage ');
        await user.selectOptions(screen.getByLabelText('Link ends'), '7d');
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(p.onMake).toHaveBeenCalledWith('Acme footage', '7d');
    });
});
