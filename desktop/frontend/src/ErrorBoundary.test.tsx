// @vitest-environment jsdom
import {type ReactNode, useEffect} from 'react';
import {fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import ErrorBoundary from './ErrorBoundary';
import {Quit, WindowReload} from '../wailsjs/runtime';

vi.mock('../wailsjs/runtime', () => ({
    WindowReload: vi.fn(),
    Quit: vi.fn()
}));

function Broken(): ReactNode {
    throw new Error('private path C:\\Users\\someone\\secret.txt');
}

function BrokenEffect(): ReactNode {
    useEffect(() => {
        throw new Error('effect failure');
    }, []);
    return <p>mounted</p>;
}

describe('ErrorBoundary', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('shows a standalone fallback with reload and close actions', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        render(
            <ErrorBoundary>
                <Broken/>
            </ErrorBoundary>
        );

        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Reload'})).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Close Floe'})).toBeTruthy();
        expect(screen.queryByText(/private path/)).toBeNull();

        fireEvent.click(screen.getByRole('button', {name: 'Reload'}));
        fireEvent.click(screen.getByRole('button', {name: 'Close Floe'}));
        expect(WindowReload).toHaveBeenCalledTimes(1);
        expect(Quit).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalled();
    });

    it('catches an error thrown from an effect', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        render(
            <ErrorBoundary>
                <BrokenEffect/>
            </ErrorBoundary>
        );

        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', {name: 'Reload'})).toBeTruthy();
        expect(consoleError).toHaveBeenCalled();
    });
});
