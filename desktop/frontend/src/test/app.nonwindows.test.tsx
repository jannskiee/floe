// @vitest-environment jsdom
/**
 * The Windows-only part of Settings > Notifications (H7 S-14, review R-S-1 F3).
 *
 * App.tsx reads navigator.userAgent at MODULE scope, and vite.config.ts pins a
 * Windows one for every run, so the other branch is reachable only from a
 * module registry that has never seen App. A file of its own is that registry:
 * vi.hoisted runs before the imports below, and the file's App is the first
 * and only one. The same stub inside app.test.tsx would need vi.resetModules,
 * which gives App a second React instance and orphans the cleanup setup.ts
 * runs after every test; the Windows half (the row and Open are there) is
 * 'Open passes ms-settings:notifications to BrowserOpenURL' in app.test.tsx.
 */
import {StrictMode} from 'react';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
    Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
});

import App from '../App';

describe('Settings > Notifications off Windows (S-14)', () => {
    it('shows the two switches but no Windows notification settings row and no Open button', async () => {
        expect(navigator.userAgent).not.toContain('Windows');
        const user = userEvent.setup();
        render(<StrictMode><App /></StrictMode>);
        await waitFor(() => expect(wails.go.GetSettings).toHaveBeenCalled());
        await user.click(await screen.findByRole('button', {name: 'Settings'}));

        // The section is there and working, so what is missing below is the
        // gate and not a Settings screen that failed to draw.
        const heading = await screen.findByRole('heading', {level: 3, name: 'Notifications'});
        expect(screen.getByRole('checkbox', {name: /^Show notifications/})).toBeTruthy();
        expect(screen.getByRole('checkbox', {name: 'Play sound'})).toBeTruthy();

        expect(screen.queryByText('Windows notification settings')).toBeNull();
        expect(screen.queryByRole('button', {name: /Windows notification settings/})).toBeNull();
        // Both rows of the section are switches: any button in it is the Open row.
        expect(within(heading.closest('section')!).queryAllByRole('button')).toEqual([]);
    });
});
