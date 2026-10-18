// @vitest-environment jsdom
/**
 * The share panel's copy marks. Each copy shows its check for 1.5 s from that
 * copy, the way the Request link's Copy link does: a second copy inside the
 * window keeps its check for its own 1.5 s, and the panel, which unmounts when
 * the receiver joins, leaves no timer behind.
 */
import {act} from 'react';
import {fireEvent, render, screen} from '@testing-library/react';
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
