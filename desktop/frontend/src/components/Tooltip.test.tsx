// @vitest-environment jsdom
/**
 * The Tooltip's empty-label rule. The header status chip keeps one Tooltip
 * around it in every state, because swapping the wrapper in and out would
 * remount the chip and restart its dot's transition and pulse; so a state with
 * nothing to explain passes an empty label, and an empty label must show
 * nothing at all (D-135: only the amber READY keeps a hover).
 */
import {act, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';
import {Tooltip} from './Tooltip';

// Longer than the 250 ms hover dwell and the 300 ms skip window together.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 600)); });

describe('the Tooltip', () => {
    it('an empty label shows no bubble on hover and describes nothing', async () => {
        const user = userEvent.setup();
        render(<Tooltip label=""><span>Direct</span></Tooltip>);
        const word = screen.getByText('Direct');
        await user.hover(word);
        await settle();
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(word.parentElement!.getAttribute('aria-describedby')).toBeNull();
        await user.unhover(word);
    });

    it('a label shows its bubble on hover', async () => {
        const user = userEvent.setup();
        await settle();
        render(<Tooltip label="Hide my IP is on."><span>Ready</span></Tooltip>);
        const word = screen.getByText('Ready');
        await user.hover(word);
        const bubble = await screen.findByRole('tooltip');
        expect(bubble.textContent).toBe('Hide my IP is on.');
        expect(word.parentElement!.getAttribute('aria-describedby')).toBe(bubble.id);
        await user.unhover(word);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('the label going empty keeps the same trigger, so nothing remounts', async () => {
        const {rerender} = render(<Tooltip label="Hide my IP is on."><span>Ready</span></Tooltip>);
        const before = screen.getByText('Ready');
        rerender(<Tooltip label=""><span>Ready</span></Tooltip>);
        expect(screen.getByText('Ready')).toBe(before);
        const user = userEvent.setup();
        await settle();
        await user.hover(before);
        await settle();
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('an open bubble goes away when its label goes empty while still hovered', async () => {
        // The amber READY's bubble is open when a drop starts: the chip turns
        // RELAY, the label empties, and no empty pill may stay behind.
        const user = userEvent.setup();
        await settle();
        const {rerender} = render(<Tooltip label="Hide my IP is on."><span>Ready</span></Tooltip>);
        const word = screen.getByText('Ready');
        await user.hover(word);
        expect(await screen.findByRole('tooltip')).toBeTruthy();
        rerender(<Tooltip label=""><span>Relay</span></Tooltip>);
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(word.parentElement!.getAttribute('aria-describedby')).toBeNull();
        await user.unhover(word);
    });

    it('a label that fills in under a resting pointer opens nothing by itself', async () => {
        // The pointer rests on a green READY (no label) and a drop ends with
        // Hide my IP on, so the label fills: the hover that found nothing to
        // show never armed the bubble, so it waits for the next hover.
        const user = userEvent.setup();
        await settle();
        const {rerender} = render(<Tooltip label=""><span>Ready</span></Tooltip>);
        const word = screen.getByText('Ready');
        await user.hover(word);
        await settle();
        rerender(<Tooltip label="Hide my IP is on."><span>Ready</span></Tooltip>);
        await settle();
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(word.parentElement!.getAttribute('aria-describedby')).toBeNull();
    });
});
