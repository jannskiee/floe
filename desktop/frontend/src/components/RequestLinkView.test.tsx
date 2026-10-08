// @vitest-environment jsdom
/**
 * Receive > REQUEST LINK as the owner sees it (S1-DSK-06). The Accept guard,
 * the fixed Close link box, and the rule that a visitor's words reach the
 * screen only as text and never reach a binding.
 */
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import RequestLinkView, {PROMPT_ACTIONS_ID, type RequestLinkViewProps} from './RequestLinkView';
import {OFF_SNAPSHOT, type Phase, type RequestLinkSnapshot} from '../requestLink';
import {VERIFIED_LINE} from '../requestCopy';
import {closingPeriods} from '../test/punctuation';
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
const result = {files: 12, saved: 12, bytes: 38 * GB, verified: 12, renamed: 0, noNamedStreams: false, folder: 'D:\\Footage\\Floe requests\\Acme footage 2026-09-14 1405', names: ['a.mov']};

const progress = (fileName: string): Prog => ({
    fileName, fileIndex: 4, fileCount: 12, fileBytes: 10, fileSize: 100, totalBytes: 1.2 * GB, grandTotal: 2.5 * GB, savedName: fileName,
});

const BY_PHASE: Record<Phase, RequestLinkSnapshot> = {
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
        onMakeAnother: vi.fn(),
        onBrowse: vi.fn(),
        onEdit: vi.fn(),
        onGuardLift: vi.fn(),
        onPromptVisible: vi.fn(),
        ...over,
    };
}

const at = (phase: Phase, over: Partial<RequestLinkViewProps> = {}) => props({phase, snap: BY_PHASE[phase], ...over});

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

    it('ignores a press that began inside the guard and was released after it', () => {
        // Review N4: a press held across the end of the guard is still a
        // press the guard was there to stop.
        const p = at('deciding');
        render(<RequestLinkView {...p}/>);
        const accept = screen.getByRole('button', {name: 'Accept'});
        act(() => { vi.advanceTimersByTime(900); });
        fireEvent.pointerDown(accept);
        act(() => { vi.advanceTimersByTime(300); });
        expect(accept.getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(accept, {detail: 1});
        expect(p.onAnswer).not.toHaveBeenCalled();
        // A fresh press after the guard counts.
        mouseClick(accept);
        expect(p.onAnswer).toHaveBeenCalledTimes(1);
    });

    it('a click at the old Make another link position during the mount frame sends no decision', () => {
        // Done ends in Make another link; the next prompt mounts with Accept
        // and Decline in that place. Whatever a click lands on in the frame
        // the prompt appears, nothing is decided.
        const p = at('done');
        const {rerender} = render(<RequestLinkView {...p}/>);
        expect(screen.getByRole('button', {name: 'Make another link'})).toBeTruthy();
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
                onCancelDrop: record(), onShowInFolder: record(), onMakeAnother: record(),
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
            expect(within(dialog).getByText('This drop has renamed files')).toBeTruthy();
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

    it('marks a drop verified only when every file verified', () => {
        const {rerender} = render(<RequestLinkView {...at('done')}/>);
        // The words are for screen readers now; nothing visible says them.
        expect(screen.getByText('SHA-256 matched').className).toContain('sr-only');
        rerender(<RequestLinkView {...at('done')} snap={snap({state: 'done', result: {...result, verified: 11}})}/>);
        expect(screen.queryByText(/SHA-256/)).toBeNull();
        // No hash value or digest-shaped text anywhere.
        expect(document.body.textContent).not.toMatch(/[0-9a-f]{16,}/);
    });

    it('a stop with nothing saved shows no folder (DT-05) and no follow-up line (ST15 is cut)', () => {
        render(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'relay-cap', result: {...result, saved: 0}})}/>);
        expect(screen.getByText('Over the 2 GB relay limit · Nothing saved')).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Show in folder'})).toBeNull();
        expect(document.body.textContent).not.toMatch(/send the rest/);
    });

    it('a stop reads its count in the web grammar (ST16, D-136)', () => {
        const {rerender} = render(<RequestLinkView {...at('stopped')}/>);
        expect(screen.getByText('The drive ran out of space · 4 of 12 files saved')).toBeTruthy();
        rerender(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'disk-full', result: {...result, files: 1, saved: 1}})}/>);
        expect(screen.getByText('The drive ran out of space · 1 of 1 file saved')).toBeTruthy();
        rerender(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'path-too-long', result: {...result, saved: 0}})}/>);
        expect(screen.getByText('A folder path was too long for Windows · Nothing saved')).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/send the rest/);
    });

    it('a save-blocked stop points at the kept file, even with nothing saved (D-128)', async () => {
        const user = userEvent.setup();
        const kept = 'The complete file was kept with a .part ending';
        for (const saved of [0, 4]) {
            const p = props({phase: 'stopped', snap: snap({state: 'stopped', code: 'save-blocked', result: {...result, saved, verified: saved, names: saved ? ['a.mov'] : []}})});
            const {unmount} = render(<RequestLinkView {...p}/>);
            // ST9 carries a count only when a file was saved, so the card never
            // says "Nothing saved" above the kept file (ST17).
            const card = saved ? `Windows blocked Floe from saving a file · ${saved} of 12 files saved` : 'Windows blocked Floe from saving a file';
            expect(screen.getByText(card)).toBeTruthy();
            expect(screen.getByText(kept)).toBeTruthy();
            expect(document.body.textContent).not.toMatch(/Nothing was saved/);
            await user.click(screen.getByRole('button', {name: 'Show in folder'}));
            expect(p.onShowInFolder).toHaveBeenCalledWith(result.folder);
            expect(document.body.textContent).not.toMatch(/send the rest/);
            expect(document.body.textContent).not.toMatch(/[0-9a-f]{16,}/);
            unmount();
        }
        // Any other stop with nothing saved still shows neither.
        render(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'write-failed', result: {...result, saved: 0}})}/>);
        expect(screen.queryByRole('button', {name: 'Show in folder'})).toBeNull();
        expect(screen.queryByText(kept)).toBeNull();
    });

    it('the save-blocked stop and its kept-file line read as one statement, 8 px apart', () => {
        // ST9 and ST17 are one group (space-y-2), not two blocks of the card's
        // 16 px rhythm (D-136 L6).
        render(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'save-blocked', result: {...result, saved: 0}})}/>);
        const stop = screen.getByText('Windows blocked Floe from saving a file');
        const kept = screen.getByText('The complete file was kept with a .part ending');
        expect(stop.nextElementSibling).toBe(kept);
        expect(stop.parentElement!.className.split(' ')).toContain('space-y-2');
    });
});

describe('the link phases (D-136)', () => {
    it('no IP line while the link waits, connects, reconnects, decides or is declined', () => {
        // The IP line is said once, on the Ready form, with its timing (R15);
        // W9 is cut.
        for (const phase of ['waiting', 'connecting', 'reconnecting', 'deciding', 'declined'] as const) {
            const {container, unmount} = render(<RequestLinkView {...at(phase)}/>);
            expect(container.textContent, phase).not.toMatch(/IP address/);
            unmount();
        }
    });

    it('Waiting says Waiting for files and nothing else in the slot', () => {
        const {container} = render(<RequestLinkView {...at('waiting')}/>);
        expect(screen.getByText('Waiting for files')).toBeTruthy();
        expect(container.textContent).not.toMatch(/open the link|still open/);
    });

    it('Reconnecting says C1 on two lines, the news first and the reassurance quieter', () => {
        render(<RequestLinkView {...at('reconnecting')}/>);
        const news = screen.getByText("Can't reach the Floe server");
        const note = screen.getByText('Reconnecting...');
        expect(news.nextElementSibling).toBe(note);
        expect(news.className).toContain('text-zinc-200');
        expect(note.className).toContain('text-zinc-500');
        expect(document.body.textContent).not.toMatch(/Senders see|until the link ends/);
    });
});

describe('the layout (D-136)', () => {
    const PRIMARY = 'bg-white text-black';
    // By accessible name: Accept draws its countdown beside its name (D-169).
    const whites = () => screen.queryAllByRole('button').filter((b) => b.className.includes(PRIMARY)).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    it('one white button per view', () => {
        const want: Record<Phase, string[]> = {
            ready: ['Make link'], making: ['Making link...'], error: ['Make link'], waiting: ['Copy link'],
            reconnecting: [], connecting: [], deciding: ['Accept'], declined: [], receiving: [], done: [], stopped: [],
            ended: ['Make another link'],
        };
        for (const phase of Object.keys(want) as Phase[]) {
            const {unmount} = render(<RequestLinkView {...at(phase, {progress: progress('a.mov')})}/>);
            expect(whites(), phase).toEqual(want[phase]);
            unmount();
        }
    });

    it('R15 sits above Make link while Hide my IP is off, and R17 alone while it is on', () => {
        const R15 = 'Senders see your IP, even if you decline';
        const R17 = 'Hide my IP limits drops to 2 GB';
        const {rerender} = render(<RequestLinkView {...at('ready')}/>);
        const line = screen.getByText(R15);
        expect(line.className).toContain('text-zinc-400');
        expect(before(line, screen.getByRole('button', {name: 'Make link'}))).toBe(true);
        expect(screen.queryByText(R17)).toBeNull();
        rerender(<RequestLinkView {...at('ready', {hideIP: true})}/>);
        expect(screen.queryByText(R15)).toBeNull();
        expect(document.body.textContent).not.toMatch(/IP address/);
        expect(before(screen.getByText(R17), screen.getByRole('button', {name: 'Make link'}))).toBe(true);
        // The error line still shows under Make link with Hide my IP on (E5).
        rerender(<RequestLinkView {...at('error', {hideIP: true, errorCode: 'no-relay'})}/>);
        expect(before(screen.getByRole('button', {name: 'Make link'}), screen.getByRole('alert'))).toBe(true);
        expect(screen.getByRole('alert').textContent).toMatch(/^Hide my IP needs a relay/);
    });

    it('the label field carries R7 as its placeholder, and nothing sits right of LABEL (D-161)', () => {
        const {container} = render(<RequestLinkView {...at('ready')}/>);
        const field = screen.getByLabelText('Label') as HTMLInputElement;
        expect(field.placeholder).toBe('Optional');
        // The placeholder carries a fact the owner needs, so it is zinc-400 (AA
        // on the field), not the shared Input's zinc-500 (RC-5). It wins the
        // cascade because the important modifier outranks the shared class,
        // and the folder field draws its grayed path the same way (D-167).
        expect(field.className.split(' ')).toContain('placeholder:text-zinc-400!');
        const save = screen.getByLabelText('Save to') as HTMLInputElement;
        expect(save.placeholder).toBe('Downloads\\Floe');
        expect(save.className.split(' ')).toContain('placeholder:text-zinc-400!');
        // The words are no longer text on the page: the eyebrow row is LABEL alone.
        expect(screen.queryByText('Optional')).toBeNull();
        expect(container.textContent).not.toMatch(/Only you see it/);
        // LABEL stands alone above its field, on the same edge as SAVE TO and
        // LINK ENDS (one label edge): nothing sits beside it.
        const eyebrow = screen.getByText('Label').parentElement!;
        expect(eyebrow.className.split(' ')).toContain('px-0.5');
        expect([...eyebrow.parentElement!.children].map((c) => c.tagName)).toEqual(['P', 'INPUT']);
    });

    it('the prompt has three text lines and the buttons: no caution line, no laptop line (S-3, D-161)', () => {
        const {rerender} = render(<RequestLinkView {...at('deciding')}/>);
        const group = screen.getByRole('heading', {level: 3}).parentElement!;
        // The heading, the size row and the folder row: nothing else above the buttons.
        expect(group.children).toHaveLength(3);
        expect(group.textContent).not.toMatch(/Accept only if|laptop|plug/i);
        // A warning of this drop still adds its own amber line; the old laptop
        // code, if a stale host sent it, draws nothing.
        const warned = snap({state: 'deciding', prompt: {...prompt, freeBytes: 31 * GB, warnings: ['low-space', 'laptop-power']}});
        rerender(<RequestLinkView {...at('deciding', {snap: warned})}/>);
        expect(screen.getByRole('heading', {level: 3}).parentElement!.children).toHaveLength(4);
        expect(document.body.textContent).not.toMatch(/laptop|plug|Accept only if/i);
    });

    it('the prompt: Accept counts down to the answer deadline, drawn only, and the size line stands alone (D-169)', () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
        vi.setSystemTime(T0);
        try {
            render(<RequestLinkView {...at('deciding')}/>);
            // The size has its line to itself: no answer line beside it.
            const size = screen.getByText('12 files, 38.0 GB');
            expect(size.parentElement!.textContent).not.toMatch(/answer|min/);
            expect(document.body.textContent).not.toMatch(/to answer|Answer within/);
            const accept = screen.getByRole('button', {name: 'Accept'});
            expect(accept.textContent).toBe('Accept (9:00)');
            // The time is drawn only, in fixed-width digits, outside every live region.
            const clock = accept.querySelector('span')!;
            expect(clock.getAttribute('aria-hidden')).toBe('true');
            expect(clock.className.split(' ')).toContain('tabular-nums');
            expect(accept.closest('[aria-live], [role="status"], [role="alert"], [role="log"]')).toBeNull();
            // It ticks every second and stops at 0:00.
            act(() => { vi.advanceTimersByTime(1000); });
            expect(accept.textContent).toBe('Accept (8:59)');
            act(() => { vi.advanceTimersByTime(9 * 60000); });
            expect(accept.textContent).toBe('Accept (0:00)');
            expect(screen.getByRole('button', {name: 'Accept'})).toBe(accept);
        } finally {
            vi.useRealTimers();
        }
    });

    it('the prompt: the folder row keeps Into and no glyph, the warnings stay amber, the buttons carry the Review id', () => {
        const warned = snap({state: 'deciding', prompt: {...prompt, freeBytes: 31 * GB, warnings: ['low-space']}});
        render(<RequestLinkView {...at('deciding', {snap: warned})}/>);
        const accept = screen.getByRole('button', {name: 'Accept'});
        const folderRow = screen.getByText(prompt.folder).parentElement!;
        expect(folderRow.textContent).toBe(`Into ${prompt.folder}`);
        expect(folderRow.querySelector('svg')).toBeNull();
        expect(folderRow.className).toContain('text-zinc-400');
        expect(screen.getByText(/^Only 31\.0 GB free on D:/).className).toContain('text-amber-300/80');
        // The folder wraps inside the card instead of overflowing it, at its
        // spaces first: break-all cut "from" into "f" and "rom" (QA-H6 L-1).
        const into = screen.getByText(prompt.folder).className.split(' ');
        expect(into).toContain('[overflow-wrap:anywhere]');
        expect(into).not.toContain('break-all');
        // The Accept and Decline row carries the id Review scrolls to.
        expect(accept.parentElement!.id).toBe(PROMPT_ACTIONS_ID);
    });

    it('the notice shows unless the whole Accept and Decline row is in view', () => {
        type Entry = {intersectionRatio: number; isIntersecting: boolean};
        let cb: ((entries: Entry[]) => void) | null = null;
        let observed: Element | null = null;
        let options: IntersectionObserverInit | undefined;
        vi.stubGlobal('IntersectionObserver', class {
            constructor(c: (entries: Entry[]) => void, o?: IntersectionObserverInit) { cb = c; options = o; }
            observe(el: Element) { observed = el; }
            disconnect() {}
        });
        try {
            const p = at('deciding');
            render(<RequestLinkView {...p}/>);
            expect(observed).toBe(document.getElementById(PROMPT_ACTIONS_ID));
            expect(options?.threshold).toEqual([0, 0.99]);
            // Half the row showing, as in capture 14 where Accept was cut.
            act(() => cb!([{intersectionRatio: 0.5, isIntersecting: true}]));
            expect(p.onPromptVisible).toHaveBeenLastCalledWith(false);
            act(() => cb!([{intersectionRatio: 1, isIntersecting: true}]));
            expect(p.onPromptVisible).toHaveBeenLastCalledWith(true);
            act(() => cb!([{intersectionRatio: 0.9999, isIntersecting: true}]));
            expect(p.onPromptVisible).toHaveBeenLastCalledWith(true);
            act(() => cb!([{intersectionRatio: 0, isIntersecting: false}]));
            expect(p.onPromptVisible).toHaveBeenLastCalledWith(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('the link block: no SAVE TO row, W5 at AA, and with no label the heading is for screen readers only', () => {
        const {rerender} = render(<RequestLinkView {...at('waiting')}/>);
        expect(screen.queryByText(/save to/i)).toBeNull();
        expect(screen.getByText(/^Ends /).className).toContain('text-zinc-400');
        expect(screen.getByText('ACME FOOTAGE').className).not.toContain('sr-only');
        rerender(<RequestLinkView {...at('waiting')} snap={snap({state: 'waiting', label: ''})}/>);
        expect(screen.getByText('REQUEST LINK').className).toBe('sr-only');
        // The link field keeps its name, by which the harnesses find it.
        expect(screen.getByRole('textbox', {name: 'REQUEST LINK'})).toBeTruthy();
        rerender(<RequestLinkView {...at('ended')} snap={snap({state: 'ended', code: 'closed', label: ''})}/>);
        expect(screen.getByText('REQUEST LINK').className).toBe('sr-only');
        expect(screen.getByText('Link closed')).toBeTruthy();
        rerender(<RequestLinkView {...at('ended')}/>);
        expect(screen.getByText('ACME FOOTAGE').className).not.toContain('sr-only');
    });

    it('every mono caps label sits on the +2 px edge', () => {
        const heads: Array<[Phase, string | RegExp]> = [
            ['waiting', 'ACME FOOTAGE'], ['deciding', 'ACME FOOTAGE WANTS TO SEND YOU FILES'], ['receiving', /^RECEIVING /],
            ['done', /^RECEIVED /], ['stopped', 'DROP STOPPED'], ['ended', 'ACME FOOTAGE'],
        ];
        for (const [phase, text] of heads) {
            const {unmount} = render(<RequestLinkView {...at(phase, {progress: progress('a.mov')})}/>);
            expect(screen.getByText(text).className.split(' '), phase).toContain('px-0.5');
            unmount();
        }
    });

    it('Receiving names the accepted count and folder before the first progress event', () => {
        const accepted = {files: 12, folder: prompt.folder};
        const {container, rerender} = render(<RequestLinkView {...at('receiving', {accepted})}/>);
        expect(screen.getByText('RECEIVING 1 OF 12 FROM ACME FOOTAGE')).toBeTruthy();
        const into = screen.getByText(prompt.folder);
        expect(into.className.split(' ')).toContain('[overflow-wrap:anywhere]');
        expect(into.className.split(' ')).not.toContain('break-all');
        expect(into.parentElement!.textContent).toBe(`Into ${prompt.folder}`);
        expect(container.textContent).not.toMatch(/0 B of 0 B|RECEIVING 0 OF 0/);
        rerender(<RequestLinkView {...at('receiving', {accepted, progress: progress('a.mov')})}/>);
        expect(screen.getByText('RECEIVING 4 OF 12 FROM ACME FOOTAGE')).toBeTruthy();
        expect(screen.getByText('1.2 GB of 2.5 GB')).toBeTruthy();
        expect(screen.getByText(prompt.folder)).toBeTruthy();
    });

    it('Done: a circle-check glyph read as SHA-256 matched, only when every file verified (DN3, D-161)', () => {
        const {container, rerender} = render(<RequestLinkView {...at('done')}/>);
        const mark = () => container.querySelector('svg.lucide-circle-check');
        const glyph = mark()!;
        expect(glyph).not.toBeNull();
        expect(glyph.getAttribute('aria-hidden')).toBe('true');
        expect(glyph.getAttribute('class')!.split(' ')).toEqual(expect.arrayContaining(['size-3.5', 'shrink-0', 'text-green-500']));
        // Read aloud and never drawn: the D-101 words, right after the glyph.
        const sr = screen.getByText('SHA-256 matched');
        expect(sr.className).toBe('sr-only');
        expect(sr.textContent).toBe(VERIFIED_LINE);
        expect(glyph.nextElementSibling).toBe(sr);
        // No tooltip, and never a shield, lock, badge or seal (the never-claim list).
        expect(container.querySelector('[title="SHA-256 matched"], [aria-label*="SHA-256"], svg title')).toBeNull();
        expect(container.querySelector('svg.lucide-shield-check, svg.lucide-shield, svg.lucide-lock, svg.lucide-badge-check, svg.lucide-shield-alert')).toBeNull();
        // One file short of verified: nothing is drawn and nothing is said (DN11).
        rerender(<RequestLinkView {...at('done')} snap={snap({state: 'done', result: {...result, verified: 11}})}/>);
        expect(mark()).toBeNull();
        expect(screen.queryByText(/SHA-256/)).toBeNull();
        // The Stopped card shares the component and is untouched: no mark, even when the counts match.
        rerender(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'disk-full', result})}/>);
        expect(mark()).toBeNull();
        expect(screen.queryByText(/SHA-256/)).toBeNull();
    });

    it('Done: the glyph follows the heading text, so the heading keeps its left edge', () => {
        const {container} = render(<RequestLinkView {...at('done')}/>);
        const heading = screen.getByText(/^RECEIVED /);
        const glyph = container.querySelector('svg.lucide-circle-check')!;
        expect(glyph).not.toBeNull();
        expect(glyph.parentElement).toBe(heading.parentElement);
        expect(heading.parentElement!.firstElementChild).toBe(heading);
        expect(heading.compareDocumentPosition(glyph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // No Dismiss on the right since D-169: Make another link puts it away.
        expect(screen.queryByRole('button', {name: 'Dismiss'})).toBeNull();
    });

    it('Done: no malware line on a normal save, and no empty body group between the heading and the folder (DN5, S-7)', () => {
        render(<RequestLinkView {...at('done')}/>);
        expect(screen.queryByText(/scan files/)).toBeNull();
        // Heading row, folder row, Make another link: nothing else.
        expect(screen.getByText(/^RECEIVED /).closest('.space-y-4')!.children).toHaveLength(3);
    });

    it('Done: the malware line returns when the drive has no named streams, with the renamed line above it (DN5, S-7)', () => {
        const noMark = {...result, noNamedStreams: true};
        const {rerender} = render(<RequestLinkView {...at('done')} snap={snap({state: 'done', result: noMark})}/>);
        const line = screen.getByText("Floe doesn't scan files for malware");
        expect(line.className).toContain('text-zinc-400');
        // It is independent of the check: a verified drop on such a drive shows both.
        expect(document.querySelector('svg.lucide-circle-check')).not.toBeNull();
        rerender(<RequestLinkView {...at('done')} snap={snap({state: 'done', result: {...noMark, renamed: 2}})}/>);
        const renamed = screen.getByText(/^2 files now end in \.floe-blocked/);
        expect(renamed.parentElement).toBe(screen.getByText("Floe doesn't scan files for malware").parentElement);
        expect(before(renamed, screen.getByText("Floe doesn't scan files for malware"))).toBe(true);
        // A renamed file alone does not bring it back on a normal drive.
        rerender(<RequestLinkView {...at('done')} snap={snap({state: 'done', result: {...result, renamed: 2}})}/>);
        expect(screen.queryByText(/scan files/)).toBeNull();
        // The Stopped card never carried it.
        rerender(<RequestLinkView {...at('stopped')} snap={snap({state: 'stopped', code: 'disk-full', result: noMark})}/>);
        expect(screen.queryByText(/scan files/)).toBeNull();
    });

    it('Done: a folder name that keeps its end', () => {
        const long = `D:\\Footage\\Floe requests\\${'A'.repeat(64)} 2026-09-14 1405`;
        const {rerender} = render(<RequestLinkView {...at('done')} snap={snap({state: 'done', result: {...result, folder: long}})}/>);
        const name = screen.getByTitle(long);
        expect(name.textContent!.endsWith(' 2026-09-14 1405')).toBe(true);
        expect(name.textContent!.length).toBeLessThanOrEqual(34);
        // A name that fits shows whole, and the title is still the full path.
        rerender(<RequestLinkView {...at('done')}/>);
        expect(screen.getByTitle(result.folder).textContent).toBe('Acme footage 2026-09-14 1405');
    });

    it('a label with no spaces wraps inside the card on every heading that carries it (FU-38)', () => {
        // The field takes 64 characters, and a heading sets them uppercase in
        // 10 px mono at 0.2 em tracking: with no space to break at, the label
        // was one word far wider than the card and scrolled <main> sideways
        // (FU-04, cell-08 case d). jsdom has no layout, so the class is what
        // is checked here; the pixels are cell-08-d-no-sideways.
        const unspaced = 'AcmeFootageForTheAutumnLaunchReviewFromTheLisbonStudioAndArchive';
        expect(unspaced).toHaveLength(64);
        const LABEL = unspaced.toUpperCase();
        const heads: Array<[Phase, string]> = [
            ['waiting', LABEL],
            ['deciding', `${LABEL} WANTS TO SEND YOU FILES`],
            ['receiving', `RECEIVING 4 OF 12 FROM ${LABEL}`],
            ['ended', LABEL],
        ];
        for (const [phase, text] of heads) {
            const {unmount} = render(<RequestLinkView {...at(phase, {progress: progress('a.mov'), snap: {...BY_PHASE[phase], label: unspaced}})}/>);
            expect(screen.getByText(text).className.split(' '), phase).toContain('[overflow-wrap:anywhere]');
            unmount();
        }
    });

    it('the Into line breaks at spaces, the way the headings above it do (QA-H6 L-1)', () => {
        // break-all wrapped a spaced folder as "...review f" / "rom the Lisbon
        // studio": every letter was a break point. anywhere breaks inside a
        // word only when the word cannot fit, so a long unspaced name still
        // stays inside the card. jsdom has no layout, so the class is checked.
        const folder = 'save-base\\Acme footage for the autumn launch review from the Lisbon studio 2026-10-03 2104';
        const s = snap({state: 'deciding', prompt: {...prompt, folder}});
        for (const [phase, over] of [
            ['deciding', {snap: s}],
            ['receiving', {snap: snap({state: 'receiving', route: 'direct'}), accepted: {files: 1, folder}}],
        ] as const) {
            const {unmount} = render(<RequestLinkView {...at(phase, over)}/>);
            const span = screen.getByText(folder);
            expect(span.parentElement!.textContent, phase).toBe(`Into ${folder}`);
            expect(span.className.split(' '), phase).toContain('[overflow-wrap:anywhere]');
            expect(span.className.split(' '), phase).not.toContain('break-all');
            unmount();
        }
    });

    it('SAVE TO cuts a long folder in the middle while the field is at rest, and edits the whole path (QA-H6 L-2)', async () => {
        // At 1000 x 640 the field cut "...\l12-scratch\save-base" at its end, so
        // the folder that says where the files go was the part hidden. Done and
        // History cut in the middle (M5); the Ready form now does too, with the
        // same helper. The field's own value stays the whole path: UIA,
        // Playwright and a screen reader read that, and focus shows it to edit.
        const user = userEvent.setup();
        const long = 'C:\\Users\\Admin\\floe-audit\\fu27-h6\\l12-scratch\\save-base';
        const cut = 'C:\\...\\fu27-h6\\l12-scratch\\save-base';
        const {rerender} = render(<RequestLinkView {...at('ready', {saveDir: long})}/>);
        const field = screen.getByLabelText('Save to') as HTMLInputElement;
        expect(field.value).toBe(long);
        const shown = screen.getByText(cut);
        const shownClasses = shown.className.split(' ');
        // In a Windows contrast theme the forced text color replaces the
        // field's transparent one (only background-color keeps its alpha), so
        // the overlay steps aside and the field shows its own text, cut at
        // the end, rather than two paths drawn on top of each other.
        expect(shownClasses).toContain('forced-colors:hidden');
        // What places the overlay, none of which jsdom can see: out of the hit
        // test (a click on the text must still focus the field), over the
        // field's box and no wider, and in the field's own box model so the
        // two texts line up.
        for (const c of ['pointer-events-none', 'absolute', 'inset-0', 'truncate', 'border', 'border-transparent', 'px-3', 'py-2', 'text-sm']) expect(shownClasses).toContain(c);
        expect(shown.parentElement!.className.split(' ')).toContain('relative');
        expect(shown.getAttribute('aria-hidden')).toBe('true');
        expect(shown.textContent!.length).toBeLessThanOrEqual(36);
        expect(field.title).toBe(long);
        expect(field.style.color).toBe('transparent');
        // Only the focus ring transitions, cut or not: a color transition
        // would fade the whole path in under the cut one on blur, and blank
        // the field and fade it back in when the cut ends.
        expect(field.style.transitionProperty).toBe('box-shadow');

        // Focused: the whole path, as typed, and nothing laid over it.
        await user.click(field);
        expect(screen.queryByText(cut)).toBeNull();
        expect(field.style.color).toBe('');
        expect(field.style.transitionProperty).toBe('box-shadow');
        expect(field.title).toBe('');
        expect(field.value).toBe(long);
        // At rest again: the middle cut is back.
        await user.tab();
        expect(screen.getByText(cut)).toBeTruthy();

        // While the link is being made the field is disabled, and the cut text dims with it.
        rerender(<RequestLinkView {...at('making', {saveDir: long})}/>);
        expect(screen.getByText(cut).className.split(' ')).toContain('opacity-50');

        // A folder that fits shows as the field's own text, with no title.
        rerender(<RequestLinkView {...at('ready', {saveDir: 'D:\\Footage\\Floe requests'})}/>);
        expect(screen.queryByText('D:\\Footage\\Floe requests')).toBeNull();
        expect(field.style.color).toBe('');
        expect(field.style.transitionProperty).toBe('box-shadow');
        expect(field.title).toBe('');
    });

    it('Review leaves 16 px under the Accept row, from a scroll margin on the row alone (QA-H6 L-4)', () => {
        // Review scrolls this row into view (block nearest); with no margin it
        // ended flush with the window's bottom edge at 1000 x 640. The margin
        // is on the row only: Accept and Decline keep none, so a Tab onto
        // either scrolls exactly as before, and nothing moves when a request
        // arrives (no scroll happens then).
        render(<RequestLinkView {...at('deciding')}/>);
        const row = document.getElementById(PROMPT_ACTIONS_ID)!;
        expect(row.className.split(' ')).toContain('scroll-mb-4');
        for (const b of within(row).getAllByRole('button')) expect(b.className).not.toMatch(/scroll-m/);
    });
});

describe('the Receiving laptop line (P11, E-94)', () => {
    const LINE = 'Keep this laptop plugged in and open';
    const MB = 1024 ** 2;
    beforeEach(() => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
        vi.setSystemTime(T0);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    // A drop of `total` bytes that has moved `done` of them in `secs` seconds,
    // so Receiving averages done / secs since its first progress event and the
    // time left is (total - done) / that speed.
    function drop(battery: boolean, secs: number, done: number, total: number) {
        const s = snap({state: 'receiving', route: 'direct', battery});
        const first: Prog = {fileName: 'a.mov', fileIndex: 1, fileCount: 1, fileBytes: 0, fileSize: total, totalBytes: 0, grandTotal: total, savedName: 'a.mov'};
        const view = render(<RequestLinkView {...props({phase: 'receiving', snap: s, progress: first})}/>);
        act(() => { vi.advanceTimersByTime(secs * 1000); });
        view.rerender(<RequestLinkView {...props({phase: 'receiving', snap: s, progress: {...first, totalBytes: done}})}/>);
        return view;
    }

    it('shows above Cancel drop on a PC with a battery while more than 5 min remain', () => {
        // 60 MB in 60 s is 1 MB/s, so 301 MB more is 301 s: just over 5 min.
        drop(true, 60, 60 * MB, 361 * MB);
        const line = screen.getByText(LINE);
        expect(line.className.split(' ')).toContain('text-zinc-400');
        expect(line.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
        const cancel = screen.getByRole('button', {name: /Cancel drop/});
        expect(line.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The progress numbers stay above it.
        expect(screen.getByText(/left$/).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('is gone at exactly 5 min left, on a PC with no battery, and in the first minute', () => {
        drop(true, 60, 60 * MB, 360 * MB).unmount();
        expect(screen.queryByText(LINE)).toBeNull();
        drop(false, 60, 60 * MB, 361 * MB).unmount();
        expect(screen.queryByText(LINE)).toBeNull();
        // 59 s is too early for any estimate, however long the drop would take.
        drop(true, 59, 59 * MB, 5000 * MB).unmount();
        expect(screen.queryByText(LINE)).toBeNull();
    });

    it('stays once shown for the drop while the averaged time left wobbles under 5 min, and a new drop starts without it (RC-6)', () => {
        const first = (total: number): Prog => ({fileName: 'a.mov', fileIndex: 1, fileCount: 1, fileBytes: 0, fileSize: total, totalBytes: 0, grandTotal: total, savedName: 'a.mov'});
        const total = 361 * MB;
        const s = snap({state: 'receiving', route: 'direct', battery: true});
        const view = render(<RequestLinkView {...props({phase: 'receiving', snap: s, progress: first(total)})}/>);
        act(() => { vi.advanceTimersByTime(60_000); });
        view.rerender(<RequestLinkView {...props({phase: 'receiving', snap: s, progress: {...first(total), totalBytes: 60 * MB}})}/>);
        expect(screen.getByText(LINE)).toBeTruthy();
        // A second later 62 MB are in: the average speed is 1.016 MB/s and the
        // time left reads 294 s, under 5 min. The line stays.
        act(() => { vi.advanceTimersByTime(1000); });
        view.rerender(<RequestLinkView {...props({phase: 'receiving', snap: s, progress: {...first(total), totalBytes: 62 * MB}})}/>);
        expect(screen.getByText(LINE)).toBeTruthy();
        // Back over 5 min, still there.
        act(() => { vi.advanceTimersByTime(1000); });
        view.rerender(<RequestLinkView {...props({phase: 'receiving', snap: s, progress: {...first(total), totalBytes: 62 * MB}})}/>);
        expect(screen.getByText(LINE)).toBeTruthy();

        // The next drop (a new lane generation) starts unlatched: 60 MB in
        // 60 s of a 360 MB drop is exactly 5 min left, which shows nothing.
        const next = {...s, gen: s.gen + 1};
        view.rerender(<RequestLinkView {...props({phase: 'receiving', snap: next, progress: first(360 * MB)})}/>);
        expect(screen.queryByText(LINE)).toBeNull();
        act(() => { vi.advanceTimersByTime(60_000); });
        view.rerender(<RequestLinkView {...props({phase: 'receiving', snap: next, progress: {...first(360 * MB), totalBytes: 60 * MB}})}/>);
        expect(screen.queryByText(LINE)).toBeNull();
    });

    it('is never on the prompt, the form, Waiting or Done', () => {
        for (const phase of ['ready', 'waiting', 'deciding', 'done'] as const) {
            const withBattery = {...BY_PHASE[phase], battery: true};
            const {unmount} = render(<RequestLinkView {...at(phase, {snap: withBattery})}/>);
            expect(screen.queryByText(LINE), phase).toBeNull();
            expect(document.body.textContent, phase).not.toMatch(/laptop/i);
            unmount();
        }
    });
});

describe('every state', () => {
    const phases = Object.keys(BY_PHASE) as Phase[];

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
        // From deciding through done there is no Browse to press at all: the
        // destination the owner approved cannot change (review N3: say so,
        // rather than loop over nothing).
        for (const phase of ['deciding', 'declined', 'receiving', 'done', 'stopped'] as const) {
            const {unmount} = render(<RequestLinkView {...at(phase, {progress: progress('a.mov')})}/>);
            expect(screen.queryAllByRole('button', {name: /Browse/}), phase).toEqual([]);
            unmount();
        }
        // While the link is being made it is shown, and disabled.
        const making = render(<RequestLinkView {...at('making')}/>);
        expect((screen.getByRole('button', {name: /Browse/}) as HTMLButtonElement).disabled).toBe(true);
        making.unmount();
        render(<RequestLinkView {...at('ready')}/>);
        expect((screen.getByRole('button', {name: /Browse/}) as HTMLButtonElement).disabled).toBe(false);
    });

    it('never renders engine or error text, only the fixed line for the code', () => {
        render(<RequestLinkView {...at('error', {errorCode: 'Error: dial tcp 10.0.0.1: refused $(calc)'})}/>);
        expect(screen.getByRole('alert').textContent).toBe("Couldn't make a link");
        expect(document.body.textContent).not.toContain('dial tcp');
    });

    it('Make link sends the trimmed label and the lifetime', async () => {
        const user = userEvent.setup();
        const p = at('ready');
        render(<RequestLinkView {...p}/>);
        await user.type(screen.getByLabelText('Label'), '  Acme footage ');
        // Picked by its label, the way the owner and the harness pick it.
        await user.selectOptions(screen.getByLabelText('Link ends'), 'In 7 days');
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(p.onMake).toHaveBeenCalledWith('Acme footage', '7d', false);
    });
});

describe('Link ends (D-173)', () => {
    const lifetimeSelect = () => screen.getByLabelText('Link ends') as HTMLSelectElement;

    it('offers the six choices in order, each with its approved label, and 24h is chosen', () => {
        render(<RequestLinkView {...at('ready')}/>);
        const select = lifetimeSelect();
        expect(select.tagName).toBe('SELECT');
        expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
            ['30m', 'In 30 minutes'],
            ['1h', 'In 1 hour'],
            ['8h', 'In 8 hours'],
            ['24h', 'In 24 hours'],
            ['3d', 'In 3 days'],
            ['7d', 'In 7 days'],
        ]);
        expect(select.value).toBe('24h');
        expect((screen.getByRole('option', {name: 'In 24 hours'}) as HTMLOptionElement).selected).toBe(true);
    });

    it('Make link with no choice sends 24h', async () => {
        const user = userEvent.setup();
        const p = at('ready');
        render(<RequestLinkView {...p}/>);
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(p.onMake).toHaveBeenCalledWith('', '24h', false);
    });

    it.each(['30m', '1h', '8h', '24h', '3d', '7d'])('choosing %s sends that key to Make link', async (key) => {
        const user = userEvent.setup();
        const p = at('ready');
        render(<RequestLinkView {...p}/>);
        await user.selectOptions(lifetimeSelect(), key);
        expect(lifetimeSelect().value).toBe(key);
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(p.onMake).toHaveBeenCalledTimes(1);
        expect(p.onMake).toHaveBeenCalledWith('', key, false);
    });

    it('a value that is not one of the six changes nothing: it is never folded into 24h', async () => {
        const user = userEvent.setup();
        const p = at('ready');
        render(<RequestLinkView {...p}/>);
        await user.selectOptions(lifetimeSelect(), '3d');
        fireEvent.change(lifetimeSelect(), {target: {value: '15m'}});
        expect(lifetimeSelect().value).toBe('3d');
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(p.onMake).toHaveBeenCalledWith('', '3d', false);
    });

    it('is disabled while the link is being made', () => {
        const {unmount} = render(<RequestLinkView {...at('making')}/>);
        expect(lifetimeSelect().disabled).toBe(true);
        unmount();
        render(<RequestLinkView {...at('ready')}/>);
        expect(lifetimeSelect().disabled).toBe(false);
    });

    it('a change while an error shows counts as an edit of the form (T5)', async () => {
        const user = userEvent.setup();
        const p = at('error', {errorCode: 'limited'});
        render(<RequestLinkView {...p}/>);
        await user.selectOptions(lifetimeSelect(), '1h');
        expect(p.onEdit).toHaveBeenCalled();
    });

    it('is the restyled real select, the trigger in Input\'s box, with the chevron drawn over it', () => {
        render(<RequestLinkView {...at('ready')}/>);
        const select = lifetimeSelect();
        // globals.css .floe-select draws the picker (customizable select).
        expect(select.className.split(' ')).toEqual(expect.arrayContaining(['floe-select', 'h-[38px]', 'border-white/10', 'bg-white/[0.03]', 'text-zinc-100']));
        const chevron = select.parentElement!.querySelector('svg')!;
        expect(chevron.getAttribute('aria-hidden')).toBe('true');
        expect(chevron.getAttribute('class')).toContain('floe-select-chevron');
        // No option carries a class of its own: the picker rules style them all.
        for (const o of select.options) expect(o.className, o.value).toBe('');
    });
});

describe('the calm copy (D-167)', () => {
    it.each(Object.keys(BY_PHASE) as Phase[])('the %s view draws no line that ends in a period', (phase) => {
        const {container} = render(<RequestLinkView {...at(phase, {errorCode: 'limited', hideIP: phase === 'ready'})}/>);
        expect(closingPeriods(container)).toEqual([]);
    });
});

describe('the saved files on Done and Stopped (D-171)', () => {
    const KB = 1024;
    const MB = 1024 ** 2;
    const seven = {
        ...result, files: 7, saved: 7,
        names: ['report.pdf', 'photos/beach-01.jpg', 'a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'],
        sizes: [10.2 * MB, 2.1 * MB, KB, 0, 2, 3, 4],
    };

    it('lists every saved file with its size in a list that scrolls, in a box whose footer is the folder (D-172)', () => {
        render(<RequestLinkView {...at('done', {snap: snap({state: 'done', result: seven})})}/>);
        const list = screen.getByRole('list', {name: 'Received files'});
        const items = within(list).getAllByRole('listitem');
        expect(items.map((li) => li.textContent)).toEqual(['report.pdf10.2 MB', 'photos\\beach-01.jpg2.1 MB', 'a.txt1.0 KB', 'b.txt0 B', 'c.txt2 B', 'd.txt3 B', 'e.txt4 B']);
        // Every row is there, so nothing is counted past them.
        expect(screen.queryByText(/more$/)).toBeNull();
        // The list scrolls inside the box past about five rows.
        expect(list.className.split(' ')).toEqual(expect.arrayContaining(['max-h-[185px]', 'overflow-y-auto', 'custom-scrollbar']));
        const box = list.parentElement!;
        expect(box.className.split(' ')).toEqual(expect.arrayContaining(['rounded-md', 'border', 'border-white/10']));
        // The folder row is the box's footer, outside the scroll, with Show in folder in it.
        const footer = box.lastElementChild!;
        expect(list.contains(footer)).toBe(false);
        expect(within(footer as HTMLElement).getByRole('button', {name: 'Show in folder'})).toBeTruthy();
        expect(footer.className.split(' ')).toContain('border-t');
        // A stranger's files: no Open, only Show in folder.
        expect(screen.queryByRole('button', {name: /^Open$/})).toBeNull();
        // Heading, then the box, then Make another link.
        const heading = screen.getByText(/^RECEIVED 7 FILES, /);
        const another = screen.getByRole('button', {name: 'Make another link'});
        expect(heading.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(box.compareDocumentPosition(another) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('counts only the files past the names Go sent (over 200) under the list', () => {
        render(<RequestLinkView {...at('done', {snap: snap({state: 'done', result: {...seven, files: 250, saved: 250}})})}/>);
        const more = screen.getByText('+ 243 more');
        expect(screen.getByRole('list', {name: 'Received files'}).contains(more)).toBe(false);
    });

    it('the renamed dialog dims what is behind it without blurring it (D-172)', async () => {
        render(<RequestLinkView {...at('done', {snap: snap({state: 'done', result: {...seven, renamed: 1}})})}/>);
        await userEvent.click(screen.getByRole('button', {name: 'Show in folder'}));
        const overlay = screen.getByRole('dialog').parentElement!;
        expect(overlay.className).not.toMatch(/backdrop-blur/);
        expect(overlay.className.split(' ')).toContain('bg-black/70');
    });

    it('cuts a long name in the middle so its real ending shows, with the whole name as the title', () => {
        const long = `invoice-${'x'.repeat(60)}.pdf.exe`;
        render(<RequestLinkView {...at('done', {snap: snap({state: 'done', result: {...result, files: 1, saved: 1, names: [long], sizes: [5]}})})}/>);
        const row = within(screen.getByRole('list', {name: 'Received files'})).getByRole('listitem');
        const name = row.firstElementChild as HTMLElement;
        expect(name.textContent!.endsWith('.pdf.exe')).toBe(true);
        expect(name.textContent!.length).toBeLessThan(long.length);
        expect(name.getAttribute('title')).toBe(long);
    });

    it('shows a visitor name as text only, and a row without a size shows none', () => {
        const names = [...HOSTILE];
        const {container} = render(<RequestLinkView {...at('done', {snap: snap({state: 'done', result: {...result, files: 4, saved: 4, names}})})}/>);
        const items = within(screen.getByRole('list', {name: 'Received files'})).getAllByRole('listitem');
        expect(items.map((li) => li.textContent)).toEqual(names);
        expect(container.querySelector('img')).toBeNull();
    });

    it('Stopped lists the files that were saved, under the stop sentence', () => {
        const stopped = snap({state: 'stopped', code: 'disk-full', result: {...result, files: 12, saved: 2, names: ['a.mov', 'b.mov'], sizes: [MB, 2 * MB]}});
        render(<RequestLinkView {...at('stopped', {snap: stopped})}/>);
        const line = screen.getByText('The drive ran out of space · 2 of 12 files saved');
        const list = screen.getByRole('list', {name: 'Received files'});
        expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['a.mov1.0 MB', 'b.mov2.0 MB']);
        expect(line.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // + N more counts saved files past the list, not the ones never sent.
        expect(screen.queryByText(/more$/)).toBeNull();
    });

    it('a save-blocked stop with nothing saved keeps the folder row alone in the box', () => {
        const blocked = snap({state: 'stopped', code: 'save-blocked', result: {...result, files: 1, saved: 0, names: [], sizes: []}});
        render(<RequestLinkView {...at('stopped', {snap: blocked})}/>);
        expect(screen.queryByRole('list', {name: 'Received files'})).toBeNull();
        const btn = screen.getByRole('button', {name: 'Show in folder'});
        expect(btn.parentElement!.parentElement!.className.split(' ')).toContain('rounded-md');
        expect(btn.parentElement!.className.split(' ')).not.toContain('border-t');
    });
});

// Auto-accept (D-173, D-174): an inline check right under the LINK ENDS
// select, in its group, with an info icon whose tooltip warns when to turn
// it on (R31) and says what it does (R31a); off on every mount and never stored; R30
// in amber only while it is on, above the IP line; W5a on the link line; and
// the lane's own count and folder while an automatic drop arrives.
describe('Auto-accept (D-173, D-174)', () => {
    const R29 = 'Auto-accept';
    const R30 = 'Anyone with this link can send you files without asking';
    const R15 = 'Senders see your IP, even if you decline';
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const toggle = () => screen.getByRole('checkbox', {name: R29}) as HTMLInputElement;

    it('starts off, is named by its words, is described by the tooltip words, and Make link sends false', async () => {
        const user = userEvent.setup();
        const p = at('ready');
        render(<RequestLinkView {...p}/>);
        expect(toggle().checked).toBe(false);
        // R3 M1: the warning reaches a screen reader on the check itself.
        expect(toggle().getAttribute('aria-describedby')).toBe('floe-request-auto-about');
        const about = document.getElementById('floe-request-auto-about')!;
        expect(about.textContent).toBe('Only turn this on if you trust everyone with the link. Files save without asking, except in a few cases, like low space or a USB drive.');
        expect(about.hidden).toBe(true);
        expect(screen.getByRole('button', {name: 'About Auto-accept'}).getAttribute('aria-describedby')).toBe('floe-request-auto-about');
        expect(screen.queryByText(R30)).toBeNull();
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(p.onMake).toHaveBeenCalledWith('', '24h', false);
    });

    it('on: R30 in amber under the check and above the IP line, the check described by it, and Make link sends true', async () => {
        const user = userEvent.setup();
        const p = at('ready');
        const {rerender} = render(<RequestLinkView {...p}/>);
        await user.click(toggle());
        expect(toggle().checked).toBe(true);
        const line = screen.getByText(R30);
        expect(line.className).toContain('text-amber-300/80');
        expect(line.id).not.toBe('');
        expect(toggle().getAttribute('aria-describedby')).toBe(`floe-request-auto-about ${line.id}`);
        expect(before(toggle().closest('label')!, line)).toBe(true);
        expect(before(line, screen.getByText(R15))).toBe(true);
        await user.click(screen.getByRole('button', {name: 'Make link'}));
        expect(p.onMake).toHaveBeenLastCalledWith('', '24h', true);
        // With Hide my IP on, R30 sits above R17 the same way.
        rerender(<RequestLinkView {...p} hideIP/>);
        expect(before(screen.getByText(R30), screen.getByText('Hide my IP limits drops to 2 GB'))).toBe(true);
        await user.click(toggle());
        expect(screen.queryByText(R30)).toBeNull();
        expect(toggle().getAttribute('aria-describedby')).toBe('floe-request-auto-about');
    });

    it('the check is one label: a click on its word turns it on, and its box fills white with a check', async () => {
        const user = userEvent.setup();
        render(<RequestLinkView {...at('ready')}/>);
        const label = toggle().closest('label')!;
        expect(label.textContent).toBe(R29);
        expect(label.className.split(' ')).toEqual(expect.arrayContaining(['inline-flex', 'min-h-6', 'cursor-pointer']));
        const box = () => label.querySelector('span[aria-hidden]')!;
        expect(box().className.split(' ')).toEqual(expect.arrayContaining(['size-4', 'rounded-[5px]', 'border-white/40', 'group-hover:border-white/60']));
        expect(box().querySelector('svg')).toBeNull();
        await user.click(screen.getByText(R29));
        expect(toggle().checked).toBe(true);
        expect(toggle().type).toBe('checkbox');
        expect(box().className.split(' ')).toEqual(expect.arrayContaining(['bg-white', 'border-white']));
        expect(box().querySelector('svg')).not.toBeNull();
        // The keyboard ring is drawn on the box, from the sr-only checkbox.
        expect(box().className).toContain('peer-focus-visible:outline-ice/60');
    });

    it('sits in the LINK ENDS group right under the select, with no eyebrow of its own (D-174, R28 cut)', () => {
        render(<RequestLinkView {...at('ready')}/>);
        const select = screen.getByLabelText('Link ends');
        expect(select.closest('.space-y-2')).toBe(toggle().closest('.space-y-2'));
        expect(before(select, toggle())).toBe(true);
        expect(before(toggle(), screen.getByRole('button', {name: 'Make link'}))).toBe(true);
        // The word is drawn once, as the check's label, never as an eyebrow.
        expect(screen.getAllByText(/^auto-accept$/i)).toHaveLength(1);
        expect(document.body.textContent).not.toContain('AUTO-ACCEPT');
    });

    it('the info icon is a named button whose tooltip warns, then says what it does (R31, R31a, R32)', async () => {
        const user = userEvent.setup();
        render(<RequestLinkView {...at('ready')}/>);
        const info = screen.getByRole('button', {name: 'About Auto-accept'});
        expect(before(toggle(), info)).toBe(true);
        await user.hover(info);
        const tip = await screen.findByRole('tooltip');
        expect(tip.textContent).toBe('Only turn this on if you trust everyone with the linkFiles save without asking, except in a few cases, like low space or a USB drive');
        // The first line is the warning: amber, with no icon (the owner, D-174).
        const warn = screen.getByText('Only turn this on if you trust everyone with the link');
        expect(warn.className).toContain('text-amber-300/95');
        expect(tip.querySelector('svg')).toBeNull();
        expect(screen.getAllByText('Files save without asking, except in a few cases, like low space or a USB drive').some((e) => e.className.includes('text-zinc-400'))).toBe(true);
        expect(info.parentElement!.getAttribute('aria-describedby')).toBe(tip.id);
        await user.unhover(info);
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
        // A click opens the explanation at once and a second click closes it
        // (a toggletip, R3 L1); neither touches the check.
        await user.click(info);
        expect(screen.getByRole('tooltip').textContent).toContain('Only turn this on if you trust everyone with the link');
        await user.click(info);
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(toggle().checked).toBe(false);
    });

    it('keyboard focus on the info icon opens the same words, and Escape closes them (R3 L5)', async () => {
        const user = userEvent.setup();
        render(<RequestLinkView {...at('ready')}/>);
        toggle().focus();
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', {name: 'About Auto-accept'}));
        const tip = await screen.findByRole('tooltip');
        expect(tip.textContent).toBe('Only turn this on if you trust everyone with the linkFiles save without asking, except in a few cases, like low space or a USB drive');
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('goes back to off on every mount, including after Make another link', async () => {
        const user = userEvent.setup();
        const first = render(<RequestLinkView {...at('ready')}/>);
        await user.click(toggle());
        first.unmount();
        const {rerender} = render(<RequestLinkView {...at('ready')}/>);
        expect(toggle().checked).toBe(false);
        await user.click(toggle());
        // A made link, its drop, then Make another link: the form mounts anew.
        rerender(<RequestLinkView {...at('waiting')}/>);
        rerender(<RequestLinkView {...at('done')}/>);
        rerender(<RequestLinkView {...at('ready')}/>);
        expect(toggle().checked).toBe(false);
        expect(screen.queryByText(R30)).toBeNull();
    });

    it('never remembers the choice anywhere', async () => {
        const user = userEvent.setup();
        const set = vi.spyOn(Storage.prototype, 'setItem');
        try {
            render(<RequestLinkView {...at('ready')}/>);
            await user.click(toggle());
            await user.click(screen.getByRole('button', {name: 'Make link'}));
            expect(set).not.toHaveBeenCalled();
        } finally {
            set.mockRestore();
        }
    });

    it('is disabled, and dimmed, while the link is being made; an edit while an error shows puts the error away', async () => {
        const user = userEvent.setup();
        // Off while making: no hover brightening on a check that cannot be used (R3 L2).
        const off = render(<RequestLinkView {...at('making')}/>);
        expect(toggle().closest('label')!.querySelector('span[aria-hidden]')!.className).not.toContain('hover:');
        off.unmount();
        const {rerender} = render(<RequestLinkView {...at('ready')}/>);
        await user.click(toggle());
        rerender(<RequestLinkView {...at('making')}/>);
        // The same form, so the choice the owner made is the one being made.
        expect(toggle().checked).toBe(true);
        expect(toggle().disabled).toBe(true);
        const label = toggle().closest('label')!;
        expect(label.className.split(' ')).toEqual(expect.arrayContaining(['opacity-50', 'cursor-not-allowed']));
        expect(label.className).not.toContain('cursor-pointer');
        expect(label.getAttribute('aria-disabled')).toBe('true');
        const p = at('error', {errorCode: 'limited'});
        rerender(<RequestLinkView {...p}/>);
        expect(toggle().disabled).toBe(false);
        await user.click(toggle());
        expect(p.onEdit).toHaveBeenCalled();
    });

    it('the link line says Accepts automatically only on an automatic link (W5a), at AA', () => {
        const {rerender} = render(<RequestLinkView {...at('waiting')} snap={snap({state: 'waiting', autoAccept: true})}/>);
        const line = screen.getByText(/^Ends .* · Accepts automatically$/);
        expect(line.className).toContain('text-zinc-400');
        rerender(<RequestLinkView {...at('waiting')}/>);
        expect(screen.getByText(/^Ends /).textContent).not.toContain('automatically');
    });


    it('an automatic link on a drive under its floor says it will ask (W5b, D-176)', () => {
        render(<RequestLinkView {...at('waiting')} snap={snap({state: 'waiting', autoAccept: true, autoAsks: 'low-space', saveDir: 'C:\\Users\\x\\Downloads\\Floe'})}/>);
        const line = screen.getByText(/^Ends .* · Asks first, low space on C:$/);
        expect(line.className).toContain('text-zinc-400');
        expect(screen.queryByText(/Accepts automatically/)).toBeNull();
    });

    it('a prompt on an automatic link gives its reason in gray, while a warning stays amber (D-176, D-177)', () => {
        const asked = snap({state: 'deciding', autoAccept: true, saveDir: 'C:\\Users\\x\\Downloads\\Floe', prompt: {...prompt, freeBytes: 30 * GB, warnings: ['auto-floor'], floorBytes: 48 * GB}});
        const {rerender} = render(<RequestLinkView {...at('deciding', {snap: asked})}/>);
        const reason = screen.getByText('Asks because C: would have under 48.0 GB free');
        expect(reason.className).toContain('text-zinc-400');
        expect(reason.className).not.toContain('amber');
        const warned = snap({state: 'deciding', autoAccept: true, prompt: {...prompt, freeBytes: 31 * GB, warnings: ['low-space']}});
        rerender(<RequestLinkView {...at('deciding', {snap: warned})}/>);
        expect(screen.getByText(/^Only 31\.0 GB free on D:/).className).toContain('text-amber-300/80');
    });
    it('an automatic link that asks, or was declined, does not say Accepts automatically over the prompt (review R2 F2)', () => {
        for (const ph of ['deciding', 'declined'] as const) {
            const {unmount} = render(<RequestLinkView {...at(ph)} snap={{...at(ph).snap, autoAccept: true}}/>);
            expect(screen.getByText(/^Ends /).textContent, ph).not.toContain('automatically');
            unmount();
        }
        for (const ph of ['waiting', 'reconnecting', 'connecting'] as const) {
            const {unmount} = render(<RequestLinkView {...at(ph)} snap={{...at(ph).snap, autoAccept: true}}/>);
            expect(screen.getByText(/^Ends .* · Accepts automatically$/), ph).toBeTruthy();
            unmount();
        }
    });

    it('Receiving on the automatic path names the lane\'s count and folder, and shows no prompt', () => {
        const auto = snap({state: 'receiving', route: 'direct', autoAccept: true, result: {...result, saved: 0, bytes: 0, verified: 0, names: [], autoAccepted: true}});
        const {container} = render(<RequestLinkView {...at('receiving')} snap={auto}/>);
        expect(screen.getByText('RECEIVING 1 OF 12 FROM ACME FOOTAGE')).toBeTruthy();
        const into = screen.getByText(prompt.folder);
        expect(into.parentElement!.textContent).toBe(`Into ${prompt.folder}`);
        expect(screen.queryByRole('button', {name: 'Accept'})).toBeNull();
        expect(container.textContent).not.toMatch(/wants to send you files/i);
        expect(screen.getByRole('button', {name: /Cancel drop/})).toBeTruthy();
    });

    it('the form with the switch on draws no line that ends in a period (D-167)', async () => {
        const user = userEvent.setup();
        const {container} = render(<RequestLinkView {...at('ready')}/>);
        await user.click(toggle());
        expect(closingPeriods(container)).toEqual([]);
    });
});
