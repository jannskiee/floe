// @vitest-environment jsdom
/**
 * HistoryView is controlled from App.tsx, so the harness below owns the same
 * three pieces of state App does and passes them through the same six props.
 * These cases cover what the view does on its own: the empty state, the list,
 * expanding a row, Remove, and the inline Clear confirm. What they cannot see
 * is whether App keeps the view mounted across its own re-renders; that is
 * the node-identity case in test/app.test.tsx, and it stays there on purpose.
 */
import {useState} from 'react';
import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it} from 'vitest';
import HistoryView from './HistoryView';
import type {HistEntry} from '../history';

// A top-level component, not one declared inside a test body: the same rule
// the view itself follows, so the harness cannot remount what it is testing.
function Harness({initial}: {initial: HistEntry[]}) {
    const [history, setHistory] = useState<HistEntry[]>(initial);
    const [confirmClear, setConfirmClear] = useState(false);
    const [expandedRow, setExpandedRow] = useState<string | null>(null);
    return (
        <HistoryView
            history={history}
            setHistory={setHistory}
            confirmClear={confirmClear}
            setConfirmClear={setConfirmClear}
            expandedRow={expandedRow}
            setExpandedRow={setExpandedRow}
        />
    );
}

const DIR = 'C:\\Users\\test\\Downloads';

// Distinct `at` values, so the rows have distinct keys.
const received: HistEntry = {kind: 'recv', names: ['report.pdf'], count: 1, dir: DIR, at: 1_700_000_000_000, bytes: 1024};
const receivedMany: HistEntry = {kind: 'recv', names: ['a.txt', 'b.txt'], count: 2, dir: DIR, at: 1_700_000_001_000, bytes: 2048};
const sent: HistEntry = {kind: 'send', names: ['photo.jpg'], count: 1, at: 1_700_000_002_000, bytes: 4096};

const mount = (initial: HistEntry[]) => render(<Harness initial={initial} />);

const rowButton = (title: RegExp) => screen.getByRole('button', {name: title});

describe('the empty state', () => {
    it('says so and offers nothing to clear', () => {
        mount([]);
        expect(screen.getByText('No transfers yet.')).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Clear'})).toBeNull();
        expect(screen.queryByRole('list')).toBeNull();
    });
});

describe('the list', () => {
    it('shows one collapsed row per entry with its direction', () => {
        mount([received, receivedMany, sent]);
        expect(screen.queryByText('No transfers yet.')).toBeNull();
        expect(screen.getAllByRole('listitem')).toHaveLength(3);

        // Single-file rows are titled by the name, multi-file rows by the count.
        expect(rowButton(/report\.pdf/).getAttribute('aria-expanded')).toBe('false');
        expect(rowButton(/2 files/).getAttribute('aria-expanded')).toBe('false');
        expect(rowButton(/photo\.jpg/).getAttribute('aria-expanded')).toBe('false');
        expect(screen.getAllByText('Received')).toHaveLength(2);
        expect(screen.getAllByText('Sent')).toHaveLength(1);

        // Nothing is expanded, so the panel actions are not on screen.
        expect(screen.queryByRole('button', {name: 'Remove'})).toBeNull();
        expect(screen.getByRole('button', {name: 'Clear'})).toBeTruthy();
    });
});

describe('expanding a row', () => {
    it('opens one panel at a time and reveals the file from it', async () => {
        const user = userEvent.setup();
        mount([received, receivedMany, sent]);

        await user.click(rowButton(/report\.pdf/));
        expect(rowButton(/report\.pdf/).getAttribute('aria-expanded')).toBe('true');
        const panel = document.getElementById(rowButton(/report\.pdf/).getAttribute('aria-controls')!)!;
        expect(within(panel).getByRole('button', {name: 'Remove'})).toBeTruthy();
        expect(within(panel).getByText(DIR)).toBeTruthy();

        // A single received file reveals that file; the name is the row's own.
        await user.click(within(panel).getByRole('button', {name: 'Show in folder'}));
        expect(wails.go.RevealFile).toHaveBeenCalledWith(DIR, 'report.pdf');
        expect(wails.go.OpenFolder).not.toHaveBeenCalled();

        // Opening another row closes the first: expandedRow is one key.
        await user.click(rowButton(/2 files/));
        expect(rowButton(/report\.pdf/).getAttribute('aria-expanded')).toBe('false');
        expect(rowButton(/2 files/).getAttribute('aria-expanded')).toBe('true');
        expect(screen.getAllByRole('button', {name: 'Remove'})).toHaveLength(1);

        // A multi-file receive lists every name and opens the folder instead.
        expect(screen.getByText('a.txt')).toBeTruthy();
        expect(screen.getByText('b.txt')).toBeTruthy();
        await user.click(screen.getByRole('button', {name: 'Show in folder'}));
        expect(wails.go.OpenFolder).toHaveBeenCalledWith(DIR);

        // A sent row has no folder to show, and a second click collapses it.
        await user.click(rowButton(/photo\.jpg/));
        expect(screen.queryByRole('button', {name: 'Show in folder'})).toBeNull();
        await user.click(rowButton(/photo\.jpg/));
        expect(rowButton(/photo\.jpg/).getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('button', {name: 'Remove'})).toBeNull();
    });
});

describe('Remove', () => {
    it('drops only that row and collapses the panel', async () => {
        const user = userEvent.setup();
        mount([received, sent]);

        await user.click(rowButton(/report\.pdf/));
        await user.click(screen.getByRole('button', {name: 'Remove'}));

        expect(screen.queryByText('report.pdf')).toBeNull();
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        expect(rowButton(/photo\.jpg/).getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('button', {name: 'Remove'})).toBeNull();
    });
});

describe('Clear', () => {
    it('asks first, keeps everything on No, and empties the list on Yes', async () => {
        const user = userEvent.setup();
        mount([received, sent]);

        await user.click(screen.getByRole('button', {name: 'Clear'}));
        expect(screen.getByText('Clear all?')).toBeTruthy();
        expect(screen.queryByRole('button', {name: 'Clear'})).toBeNull();

        await user.click(screen.getByRole('button', {name: 'No'}));
        expect(screen.queryByText('Clear all?')).toBeNull();
        expect(screen.getAllByRole('listitem')).toHaveLength(2);

        await user.click(screen.getByRole('button', {name: 'Clear'}));
        await user.click(screen.getByRole('button', {name: 'Yes'}));
        expect(screen.getByText('No transfers yet.')).toBeTruthy();
        expect(screen.queryByText('Clear all?')).toBeNull();
        expect(screen.queryByRole('button', {name: 'Clear'})).toBeNull();
    });
});
