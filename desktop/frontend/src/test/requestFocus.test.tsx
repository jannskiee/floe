// @vitest-environment jsdom
/**
 * After each owner action
 * on REQUEST LINK, once the next state is on screen, focus is on a control of
 * that state and never the page, and each outcome is announced once through a
 * status region. An outcome the owner did not cause moves no focus.
 */
import {StrictMode, act} from 'react';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';
import App from '../App';
import {offSnapshot} from './requestFixtures';

const mount = () => render(<StrictMode><App /></StrictMode>);
const settled = () => waitFor(() => expect(wails.listeners.size).toBe(15));
const GB = 1024 ** 3;
const LINK = 'http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
let seq = 100;
const snap = (gen: number, state: string, over: Record<string, unknown> = {}) => ({
    ...offSnapshot, gen, seq: ++seq, link: LINK, label: 'Acme', saveDir: 'D:\\Footage',
    expiresAt: Date.now() + 3600_000, route: 'direct', state, ...over,
});
const prompt = () => ({files: 2, totalBytes: 3 * GB, folder: 'Footage\\Acme 2026-10-08 1405', freeBytes: 500 * GB, warnings: [], answerBy: Date.now() + 9 * 60000});
const result = (saved: number) => ({files: 2, saved, bytes: saved * GB, verified: saved, renamed: 0, folder: 'D:\\Footage\\Acme 2026-10-08 1405', names: [], sizes: []});
const push = (s: Record<string, unknown>) => act(() => { wails.emit('request:state', s); });
const statusText = () => [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? '').join(' | ');
const guard = () => act(async () => { await new Promise((r) => setTimeout(r, 1150)); });

/** Focus the control, press Enter, play Go's next snapshot, wait until the
 *  next state's own control is on screen and one frame more, then report
 *  where focus is. */
async function act1(user: ReturnType<typeof userEvent.setup>, press: string | RegExp, next: () => Record<string, unknown>, shows: string | RegExp) {
    const b = screen.getByRole('button', {name: press});
    act(() => b.focus());
    await user.keyboard('{Enter}');
    push(next()); // built after the click, so it is stamped after the binding reply
    await screen.findByRole('button', {name: shows});
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    return document.activeElement;
}

describe('A5-02 red: focus and announcements after owner actions', () => {
    it('Make link, Decline, Keep waiting, Accept, Cancel drop', async () => {
        const user = userEvent.setup();
        wails.go.MakeRequestLink.mockImplementation(async () => snap(1, 'making'));
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));

        expect(await act1(user, 'Make link', () => snap(1, 'waiting'), 'Copy link'), 'after Make link').not.toBe(document.body);

        push(snap(1, 'deciding', {promptGen: 1, prompt: prompt()}));
        await guard();
        expect(await act1(user, 'Decline', () => snap(1, 'declined', {promptGen: 1}), 'Keep waiting'), 'after Decline').not.toBe(document.body);
        expect(statusText()).toContain('Request declined');
        await guard(); // Keep waiting has the prompt's guard (A5-12)
        expect(await act1(user, 'Keep waiting', () => snap(1, 'waiting'), 'Copy link'), 'after Keep waiting').not.toBe(document.body);

        push(snap(1, 'deciding', {promptGen: 2, prompt: prompt()}));
        await guard();
        expect(await act1(user, 'Accept', () => snap(1, 'receiving', {result: result(0)}), /Cancel drop/), 'after Accept').not.toBe(document.body);
        expect(await act1(user, /Cancel drop/, () => snap(1, 'stopped', {code: 'stopped', result: result(1)}), 'Make another link'), 'after Cancel drop').not.toBe(document.body);
        expect(statusText()).toContain('You stopped this drop');
    }, 15_000); // three 1 s guards (Accept, Decline, Keep waiting) and five round trips

    it('Close link', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        await user.click(await screen.findByRole('button', {name: 'Request link, beta'}));
        push(snap(7, 'waiting'));
        expect(await act1(user, 'Close link', () => snap(7, 'ended', {code: 'closed'}), 'Make another link'), 'after Close link').not.toBe(document.body);
        expect(statusText()).toContain('Link closed');
    });

    it('a drop that finishes on its own is announced and moves no focus', async () => {
        const user = userEvent.setup();
        mount();
        await settled();
        await user.click(screen.getAllByRole('button', {name: 'Receive'})[0]);
        const code = await screen.findByRole('button', {name: 'Code'});
        act(() => code.focus());
        push(snap(3, 'receiving', {result: result(0)}));
        push(snap(3, 'done', {result: {...result(2), files: 12, saved: 12, verified: 12, bytes: 38 * GB}}));
        await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
        expect(statusText()).toContain('RECEIVED 12 FILES, 38.0 GB');
        expect(document.activeElement).toBe(code);
    });
});
