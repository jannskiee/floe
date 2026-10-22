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
import {FileSummary} from './TransferBits';

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
});
