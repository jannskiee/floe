// @vitest-environment jsdom
/**
 * The Settings switch slides its thumb as it turns on and off. With reduced
 * motion on (Windows: Animation effects off) the thumb moves at once, as the
 * Advanced chevron on the same screen turns at once. jsdom evaluates no media
 * query, so the classes are the assertion.
 */
import {useState} from 'react';
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';
import {SettingRow} from './SettingsPrimitives';

// A top-level component, so the harness cannot remount what it is testing.
function Harness() {
    const [on, setOn] = useState(false);
    return <SettingRow checked={on} onChange={setOn} label="Hide my IP address"/>;
}

describe('Switch', () => {
    it('moves its thumb at once under reduced motion, on and off', async () => {
        const user = userEvent.setup();
        render(<Harness/>);
        const box = screen.getByRole('checkbox', {name: 'Hide my IP address'}) as HTMLInputElement;
        const track = box.nextElementSibling as HTMLElement;
        const thumb = track.firstElementChild as HTMLElement;
        const classes = () => [...thumb.classList].sort();
        const always = ['absolute', 'left-0.5', 'top-0.5', 'size-3.5', 'rounded-full', 'transition-transform', 'duration-150', 'ease-out', 'motion-reduce:transition-none'];

        expect(classes()).toEqual([...always, 'bg-zinc-400'].sort());
        await user.click(box);
        expect(box.checked).toBe(true);
        expect(classes()).toEqual([...always, 'translate-x-3.5', 'bg-zinc-950'].sort());
        await user.click(box);
        expect(box.checked).toBe(false);
        expect(classes()).toEqual([...always, 'bg-zinc-400'].sort());
        // A color fade is not motion: the track keeps it for everyone.
        expect(track.classList).toContain('transition-colors');
        expect(track.className).not.toMatch(/motion-/);
        // Nor is the row's hover fill: the row keeps its fade for everyone.
        expect(box.closest('label')!.className).not.toMatch(/motion-/);
    });
});
