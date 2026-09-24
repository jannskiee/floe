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

/**
 * A request drop's row (S1-DSK-09): the owner's label as its title, the lines
 * its result card had, and a Show in folder that opens only the folder, asking
 * first after renames.
 */
describe('request rows', () => {
    const FOLDER = 'D:\\Footage\\Floe requests\\Acme footage 2026-09-14 1405';
    const request = (over: Partial<HistEntry> = {}): HistEntry => ({
        kind: 'recv', names: ['shoot/A001_C001.mov', 'shoot/A001_C002.mov'], count: 2, dir: FOLDER, at: 1_700_000_003_000,
        bytes: 2048, via: 'request', label: 'Acme footage', verified: 2, renamed: 0, offered: 2, ...over,
    });
    const openRow = async (title = 'Acme footage') => {
        await userEvent.click(rowButton(new RegExp(title)));
    };

    it('request row Show in folder opens the folder directly when nothing was renamed', async () => {
        mount([request()]);
        await openRow();
        expect(screen.getByText("Every file arrived intact: its SHA-256 matched the sender's.")).toBeTruthy();
        await userEvent.click(screen.getByRole('button', {name: 'Show in folder'}));
        expect(wails.go.OpenFolder).toHaveBeenCalledTimes(1);
        expect(wails.go.OpenFolder).toHaveBeenCalledWith(FOLDER);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('request row Show in folder asks first when files were renamed', async () => {
        mount([request({renamed: 2, names: ['a.url.floe-blocked', 'b.lnk.floe-blocked']})]);
        await openRow();
        expect(screen.getByText('2 files were renamed to end in .floe-blocked because Windows can open that kind of file by itself.')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', {name: 'Show in folder'}));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText('This drop contains renamed files.')).toBeTruthy();
        expect(document.activeElement).toBe(within(dialog).getByRole('button', {name: 'Cancel'}));
        expect(wails.go.OpenFolder).not.toHaveBeenCalled();
        await userEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(wails.go.OpenFolder).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', {name: 'Show in folder'}));
        await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Show in folder'}));
        expect(wails.go.OpenFolder).toHaveBeenCalledWith(FOLDER);
    });

    it('request rows never call RevealFile or OpenFile', async () => {
        // A one-file request row: the path a plain receive row would take to
        // RevealFile. A request row opens the folder instead, every time.
        mount([request({names: ['only.mov'], count: 1, offered: 1, verified: 1})]);
        await openRow();
        await userEvent.click(screen.getByRole('button', {name: 'Show in folder'}));
        expect(wails.go.RevealFile).not.toHaveBeenCalled();
        expect(wails.go.OpenFile).not.toHaveBeenCalled();
        expect(wails.go.OpenFolder).toHaveBeenCalledWith(FOLDER);
    });

    it('no Open button on request rows', async () => {
        mount([request(), request({at: 1_700_000_004_000, label: 'Second', stopped: 'disk-full', count: 1, offered: 5})]);
        // One row expands at a time: check each.
        for (const title of ['Acme footage', 'Second']) {
            await openRow(title);
            const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim());
            expect(buttons, title).not.toContain('Open');
            expect(buttons.filter((t) => t === 'Show in folder'), title).toHaveLength(1);
        }
    });

    it('shows the History form of a stop and no SHA-256 line with it', async () => {
        mount([request({label: 'Acme footage', stopped: 'disk-full', count: 4, offered: 12, verified: 4})]);
        await openRow();
        expect(screen.getByText('Drop stopped: the drive ran out of space. 4 of 12 files were saved.')).toBeTruthy();
        expect(screen.queryByText(/SHA-256/)).toBeNull();
    });

    it('a save-blocked row with nothing saved points at the kept file (D-128)', async () => {
        mount([request({stopped: 'save-blocked', names: [], count: 0, offered: 1, verified: 0, bytes: undefined})]);
        await openRow();
        expect(screen.getByText('Drop stopped: Windows would not let Floe save a file.')).toBeTruthy();
        expect(screen.getByText('Received a file in full but could not finish saving it. The complete file was kept in the save folder with a .part ending.')).toBeTruthy();
        expect(screen.queryByText(/SHA-256/)).toBeNull();
        await userEvent.click(screen.getByRole('button', {name: 'Show in folder'}));
        expect(wails.go.OpenFolder).toHaveBeenCalledWith(FOLDER);
    });

    it('falls back to the count when the owner gave no label', () => {
        mount([request({label: undefined})]);
        expect(screen.getByText('2 files')).toBeTruthy();
    });

    it('hostile names in a request row render as text', async () => {
        const hostile = ['<img src=x onerror=alert(1)>', '$(calc)', ']]><', '\u202Eevil.exe'];
        const {container} = mount([request({names: hostile, count: 4, offered: 4, verified: 4})]);
        await openRow();
        expect(container.querySelector('img')).toBeNull();
        for (const name of hostile) expect(screen.getByText(name, {exact: true}).textContent).toBe(name);
        await userEvent.click(screen.getByRole('button', {name: 'Show in folder'}));
        const calls = JSON.stringify(Object.values(wails.go).map((f) => f.mock.calls));
        for (const name of hostile) expect(calls.includes(JSON.stringify(name).slice(1, -1))).toBe(false);
    });
});
