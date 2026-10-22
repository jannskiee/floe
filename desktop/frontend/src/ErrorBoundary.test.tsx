// @vitest-environment jsdom
/**
 * The boundary is what keeps a render-time or effect-time throw from blanking
 * the frameless window, title bar included (#695). These cases pin the fixed
 * words, that the error itself never reaches the screen, and that Close goes
 * through ConfirmClose: the Wails probe in src/test/setup.ts stubs the
 * bindings and the runtime, so no module mock is needed.
 */
import {type ReactNode, useEffect} from 'react';
import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import ErrorBoundary from './ErrorBoundary';

type Runtime = Record<'Quit' | 'WindowReload', ReturnType<typeof vi.fn>>;
const runtime = () => (window as unknown as {runtime: Runtime}).runtime;

function Broken(): ReactNode {
    throw new Error('private path C:\\Users\\someone\\secret.txt');
}

function BrokenEffect(): ReactNode {
    useEffect(() => {
        throw new Error('effect failure');
    }, []);
    return <p>mounted</p>;
}

// React logs every caught error; keep the run's output readable.
function quietConsole() {
    vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('ErrorBoundary', () => {
    it('shows the fixed fallback and never the error text', () => {
        quietConsole();
        render(<ErrorBoundary><Broken/></ErrorBoundary>);

        const alert = screen.getByRole('alert');
        expect(screen.getByRole('heading', {name: 'Something went wrong'})).toBeTruthy();
        expect(alert.textContent).toContain('Reload the window to try again');
        expect(alert.textContent).toContain('Closing Floe stops any transfer in progress and any open request link');
        expect(screen.getByRole('button', {name: 'Reload window'})).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Close Floe'})).toBeTruthy();
        expect(screen.queryByText(/private path|secret\.txt/)).toBeNull();
    });

    it('puts focus on Reload window, the gentler way out', () => {
        quietConsole();
        render(<ErrorBoundary><Broken/></ErrorBoundary>);
        expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Reload window'}));
    });

    it('Reload window reloads the webview', () => {
        quietConsole();
        render(<ErrorBoundary><Broken/></ErrorBoundary>);
        fireEvent.click(screen.getByRole('button', {name: 'Reload window'}));
        expect(runtime().WindowReload).toHaveBeenCalledTimes(1);
    });

    it('Close Floe ends anything in progress through ConfirmClose, never Quit', () => {
        quietConsole();
        render(<ErrorBoundary><Broken/></ErrorBoundary>);
        fireEvent.click(screen.getByRole('button', {name: 'Close Floe'}));
        expect(wails.go.ConfirmClose).toHaveBeenCalledTimes(1);
        expect(runtime().Quit).not.toHaveBeenCalled();
    });

    it('catches an error thrown from an effect', () => {
        quietConsole();
        render(<ErrorBoundary><BrokenEffect/></ErrorBoundary>);
        expect(screen.getByRole('heading', {name: 'Something went wrong'})).toBeTruthy();
        expect(screen.queryByText('mounted')).toBeNull();
    });

    it('renders its children untouched when nothing throws', () => {
        render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
        expect(screen.getByText('fine')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
