// @vitest-environment jsdom
/**
 * The share panel's copy marks. Each copy shows its check for 1.5 s from that
 * copy, the way the Request link's Copy link does: a second copy inside the
 * window keeps its check for its own 1.5 s, and the panel, which unmounts when
 * the receiver joins, leaves no timer behind. It also covers the QR button's
 * accessible name and its expanded state.
 */
import {act} from 'react';
import {fireEvent, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import SharePanel from './SharePanel';

const LINK = 'http://localhost:3000/#room=x';
// The copy handler awaits the clipboard; two microtask turns let it finish.
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const check = (name: string) => screen.getByRole('button', {name}).querySelector('svg.lucide-check');

describe('the copy marks', () => {
    beforeEach(() => { vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']}); });
    afterEach(() => { vi.useRealTimers(); });

    it('a second copy keeps its check for 1.5 s from that copy', async () => {
        render(<SharePanel code="amber-otter-cloud" link={LINK}/>);
        fireEvent.click(screen.getByRole('button', {name: 'Copy code'}));
        await flush();
        expect(check('Copy code')).not.toBeNull();
        act(() => { vi.advanceTimersByTime(1000); });
        fireEvent.click(screen.getByRole('button', {name: 'Copy link'}));
        await flush();
        expect(check('Copy link')).not.toBeNull();
        act(() => { vi.advanceTimersByTime(600); });
        expect(check('Copy link')).not.toBeNull();
        act(() => { vi.advanceTimersByTime(900); });
        expect(check('Copy link')).toBeNull();
    });

    it('an unmounted panel leaves no timer behind', async () => {
        const {unmount} = render(<SharePanel code="amber-otter-cloud" link={LINK}/>);
        fireEvent.click(screen.getByRole('button', {name: 'Copy link'}));
        await flush();
        expect(vi.getTimerCount()).toBe(1);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('a keyed link', () => {
    // 95 characters on floe.one, and more on a self-hosted address: level M must
    // hold both, or react-qr-code throws where it used to draw.
    const KEYED = 'https://floe.one/?s=deadbeef#k=AAECAwQFBgcICQoLDA0ODw&room=6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
    const SELF_HOSTED = KEYED.replace('https://floe.one', 'https://files.a-rather-long-subdomain.example.com/floe');

    it('shows whole and copies whole', async () => {
        const write = vi.spyOn(navigator.clipboard, 'writeText');
        render(<SharePanel code="" link={KEYED}/>);
        expect(screen.getByText(KEYED).tagName).toBe('CODE');
        fireEvent.click(screen.getByRole('button', {name: 'Copy link'}));
        await flush();
        expect(write).toHaveBeenCalledWith(KEYED);
        write.mockRestore();
    });

    it('still draws its QR at the panel\'s level, on any address', async () => {
        const user = userEvent.setup();
        for (const link of [KEYED, SELF_HOSTED]) {
            const {unmount} = render(<SharePanel code="" link={link}/>);
            await user.click(screen.getByRole('button', {name: 'Show QR'}));
            expect(screen.getByText('Scan to receive files')).toBeTruthy();
            expect(document.querySelector('svg[viewBox]')).not.toBeNull();
            unmount();
        }
    });
});

describe('the QR button', () => {
    it('is named by its words and says whether the QR is open', async () => {
        const user = userEvent.setup();
        render(<SharePanel code="amber-otter-cloud" link={LINK}/>);

        const show = screen.getByRole('button', {name: 'Show QR'});
        expect(show.getAttribute('aria-expanded')).toBe('false');
        expect(show.hasAttribute('aria-controls')).toBe(false);
        expect(show.hasAttribute('aria-pressed')).toBe(false);
        expect(screen.queryByText('Scan to receive files')).toBeNull();

        await user.click(show);
        const hide = screen.getByRole('button', {name: 'Hide QR'});
        expect(hide.getAttribute('aria-expanded')).toBe('true');
        const panel = document.getElementById(hide.getAttribute('aria-controls')!);
        expect(panel?.textContent).toContain('Scan to receive files');

        await user.click(hide);
        expect(screen.getByRole('button', {name: 'Show QR'}).getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('Scan to receive files')).toBeNull();
    });
});
