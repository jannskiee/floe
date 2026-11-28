// @vitest-environment jsdom
/**
 * FileSummary is controlled from App.tsx, so the harness below owns `open` the
 * way App owns filesOpen and passes the same three props. These cases cover what
 * a screen reader is told about the summary row: that it expands, whether it is
 * open, and which list it opens.
 */
import {useState} from 'react';
import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';
import {FileSummary, ProgressRow, StatusLine} from './TransferBits';

// A top-level component, not one declared inside a test body, so the harness
// cannot remount what it is testing.
function Harness({files}: {files: string[]}) {
    const [open, setOpen] = useState(false);
    return <FileSummary files={files} open={open} onToggle={() => setOpen((o) => !o)}/>;
}

const THREE = ['C:\\x\\a.txt', 'C:\\x\\b.png', 'C:\\x\\c.zip'];

describe('FileSummary', () => {
    it('tells assistive technology whether the file list is open', async () => {
        const user = userEvent.setup();
        render(<Harness files={THREE}/>);

        const row = screen.getByRole('button', {name: '3 items'});
        expect(row.getAttribute('aria-expanded')).toBe('false');
        expect(row.hasAttribute('aria-controls')).toBe(false);
        expect(screen.queryByRole('list')).toBeNull();

        await user.click(row);
        expect(row.getAttribute('aria-expanded')).toBe('true');
        const list = document.getElementById(row.getAttribute('aria-controls')!)!;
        expect(list.tagName).toBe('UL');
        expect(within(list).getAllByRole('listitem')).toHaveLength(3);
        for (const name of ['a.txt', 'b.png', 'c.zip']) {
            expect(within(list).getByText(name)).toBeTruthy();
        }

        await user.click(row);
        expect(row.getAttribute('aria-expanded')).toBe('false');
        expect(row.hasAttribute('aria-controls')).toBe(false);
        expect(screen.queryByRole('list')).toBeNull();
    });

    it('keeps the row\'s name, in the singular for one item', () => {
        render(<Harness files={['C:\\x\\a.txt']}/>);

        const row = screen.getByRole('button', {name: '1 item'});
        expect(row.getAttribute('type')).toBe('button');
        expect(row.getAttribute('aria-expanded')).toBe('false');
    });

    // The chevron turns as the list opens and closes. With reduced motion on
    // (Windows: Animation effects off) it flips at once, as the History row's
    // chevron and the Settings Advanced chevron do. jsdom evaluates no media
    // query, so the classes are the assertion.
    it('turns its chevron at once under reduced motion, opening and closing', async () => {
        const user = userEvent.setup();
        render(<Harness files={THREE}/>);
        const row = screen.getByRole('button', {name: '3 items'});
        const chevron = () => row.querySelector('svg.lucide-chevron-down')!;
        const classes = () => [...chevron().classList].sort();
        const closed = ['lucide', 'lucide-chevron-down', 'size-4', 'text-zinc-500', 'transition-transform', 'motion-reduce:transition-none'];

        expect(classes()).toEqual([...closed].sort());
        await user.click(row);
        expect(classes()).toEqual([...closed, 'rotate-180'].sort());
        await user.click(row);
        expect(classes()).toEqual([...closed].sort());
        // A hover fill is not motion: the row keeps its color fade for everyone.
        expect(row.classList).toContain('transition-colors');
        expect(row.className).not.toMatch(/motion-/);
    });
});

// ProgressRow is the send and receive bar; App.tsx passes it what track() built.
describe('ProgressRow', () => {
    it('reports its value and takes its name from the label beside it', () => {
        // track() writes two spaces after the percent. An accessible name
        // collapses runs of white space, so the name below has one.
        const label = '[2/3] b.png - 42%  (4.2 MB / 10.0 MB), 1.5 MB/s, ETA 4s';
        render(<ProgressRow prog={{pct: 42, label}}/>);

        const bar = screen.getByRole('progressbar', {name: '[2/3] b.png - 42% (4.2 MB / 10.0 MB), 1.5 MB/s, ETA 4s'});
        expect(bar.getAttribute('aria-valuemin')).toBe('0');
        expect(bar.getAttribute('aria-valuemax')).toBe('100');
        expect(bar.getAttribute('aria-valuenow')).toBe('42');
    });

    it('names each bar by its own label when two rows are on screen', () => {
        render(
            <>
                <ProgressRow prog={{pct: 0, label: 'a.txt - 0%'}}/>
                <ProgressRow prog={{pct: 100, label: 'b.png - 100%'}}/>
            </>
        );

        expect(screen.getByRole('progressbar', {name: 'a.txt - 0%'}).getAttribute('aria-valuenow')).toBe('0');
        expect(screen.getByRole('progressbar', {name: 'b.png - 100%'}).getAttribute('aria-valuenow')).toBe('100');
    });
});

// StatusLine is the line under the send and receive cards. friendlyError
// (errors.ts) starts every failure with 'Error: ', which is what makes a line
// an error; this is the one it returns when the other person never connects.
const FAILED = 'Error: Both people need Floe open at the same time';

describe('StatusLine', () => {
    it('announces a failed send or receive as an alert', () => {
        render(<StatusLine text={FAILED} busy={false}/>);

        expect(screen.getByRole('alert').textContent).toBe(FAILED);
    });

    it('mounts a new alert when a busy line turns into an error', () => {
        const {container, rerender} = render(<StatusLine text="Setting up..." busy/>);
        const busyLine = container.querySelector('p');
        expect(screen.queryByRole('alert')).toBeNull();

        rerender(<StatusLine text={FAILED} busy={false}/>);
        const errorLine = screen.getByRole('alert');
        expect(errorLine.textContent).toBe(FAILED);
        expect(errorLine).not.toBe(busyLine);
    });

    it('gives a line that is not an error no role', () => {
        render(<StatusLine text="Sending..." busy/>);

        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('keeps the Settings test line one polite status region, an error included', () => {
        const {rerender} = render(<StatusLine text="" busy={false} live/>);
        const region = screen.getByRole('status');

        rerender(<StatusLine text={FAILED} busy={false} live/>);
        expect(screen.getByRole('status')).toBe(region);
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.textContent).toBe(FAILED);
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
