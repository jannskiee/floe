import { describe, it, expect } from 'vitest';
import { detectOs } from './detectOs';

const UA = {
    win11Chrome:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    macSafari:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
    android:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    iphone:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ipadDesktopMode:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
};

describe('detectOs', () => {
    it('classifies the big three desktops from the UA', () => {
        expect(detectOs(UA.win11Chrome)).toBe('windows');
        expect(detectOs(UA.macSafari)).toBe('mac');
        expect(detectOs(UA.linuxFirefox)).toBe('linux');
    });

    it('classifies phones as mobile despite their desktop-ish UA tokens', () => {
        // Android UA contains "Linux"; iPhone UA contains "like Mac OS X".
        expect(detectOs(UA.android)).toBe('mobile');
        expect(detectOs(UA.iphone)).toBe('mobile');
    });

    it('prefers userAgentData.platform when present', () => {
        expect(detectOs(UA.win11Chrome, 'Windows')).toBe('windows');
        expect(detectOs(UA.android, 'Android')).toBe('mobile');
        // Chromium on Linux sometimes ships a frozen Windows-looking UA; the
        // client hint wins.
        expect(detectOs(UA.win11Chrome, 'Linux')).toBe('linux');
    });

    it('falls back to windows for unknown agents (the SSR default)', () => {
        expect(detectOs('SomeBot/1.0')).toBe('windows');
        expect(detectOs('')).toBe('windows');
    });

    it('treats iPad-in-desktop-mode as mac, which is acceptable', () => {
        // Indistinguishable from a real Mac by design; the mac arrangement
        // still shows the web-app CTA, so nothing breaks.
        expect(detectOs(UA.ipadDesktopMode)).toBe('mac');
    });
});
