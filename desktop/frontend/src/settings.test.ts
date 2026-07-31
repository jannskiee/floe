import {describe, expect, it} from 'vitest';
import {advancedSummary, hostOf, isDefaultSettings} from './settings';

describe('hostOf', () => {
    it('reduces a full address to its host', () => {
        expect(hostOf('https://files.example.com/')).toBe('files.example.com');
        expect(hostOf('https://files.example.com:8443')).toBe('files.example.com:8443');
        expect(hostOf('http://localhost:3001')).toBe('localhost:3001');
    });

    // The field is saved on blur but rendered on every keystroke, so every one of
    // these reaches hostOf while the user is still typing. new URL throws on all
    // of them; none may throw here or the whole Settings screen unmounts.
    it('survives half-typed input', () => {
        expect(hostOf('')).toBe('');
        expect(hostOf('   ')).toBe('');
        expect(hostOf('https://')).toBe('');
        expect(hostOf('files.exa')).toBe('files.exa');
        expect(hostOf('files.example.com/path')).toBe('files.example.com');
    });
});

describe('advancedSummary', () => {
    it('offers the capability when nothing is overridden', () => {
        const s = advancedSummary('', '');
        expect(s).toBe("This app uses Floe's server. You can point it at your own instead.");
        expect(s).not.toMatch(/custom/i);
    });

    it('names the host and the consequence when a server is set', () => {
        const s = advancedSummary('https://files.example.com', '');
        expect(s).toContain('files.example.com');
        expect(s).toContain('cannot connect to you');
    });

    // The branch that matters. Overriding only the share link address leaves the
    // app signaling against Floe's own server, so the "people cannot connect to
    // you" warning would be false. Two of three independent designs for this
    // screen flattened these three states into a boolean and shipped that lie,
    // which is the entire reason this test exists.
    it('does not claim peers are unreachable when only the share link is custom', () => {
        const s = advancedSummary('', 'https://app.example.com');
        expect(s).toContain('app.example.com');
        expect(s).toContain("still uses Floe's server");
        expect(s).not.toContain('cannot connect to you');
    });

    // A server override outranks a share-link override: the server is what
    // actually determines who you can reach.
    it('reports the server when both are set', () => {
        const s = advancedSummary('https://files.example.com', 'https://app.example.com');
        expect(s).toContain('files.example.com');
        expect(s).not.toContain('app.example.com');
    });

    it('treats whitespace as unset', () => {
        expect(advancedSummary('   ', '  ')).toBe(advancedSummary('', ''));
    });

    // House style, enforced rather than trusted: no em dashes anywhere in UI copy.
    it('uses no em dashes', () => {
        for (const s of [
            advancedSummary('', ''),
            advancedSummary('https://a.example.com', ''),
            advancedSummary('', 'https://b.example.com'),
        ]) {
            expect(s).not.toContain('—');
        }
    });
});

describe('isDefaultSettings', () => {
    const defaults = {saveDir: '', hideIP: false, reportStats: true, server: '', web: ''};

    it('reports a fresh install as default', () => {
        expect(isDefaultSettings(defaults)).toBe(true);
    });

    // The regression guard. Every consumer trims before use, so a folder of
    // spaces IS the default; reporting it as customised would make the Reset
    // caption claim there is something to undo when there is not.
    it('treats a whitespace-only save folder as default', () => {
        expect(isDefaultSettings({...defaults, saveDir: '   '})).toBe(true);
        expect(isDefaultSettings({...defaults, server: '  '})).toBe(true);
        expect(isDefaultSettings({...defaults, web: '\t'})).toBe(true);
    });

    // Each field on its own must be enough to flip it, or the caption and the
    // dialog would disagree with the screen for that one setting.
    it('detects each setting individually', () => {
        expect(isDefaultSettings({...defaults, saveDir: 'C:\\Users\\Admin\\Desktop\\supoclip'})).toBe(false);
        expect(isDefaultSettings({...defaults, hideIP: true})).toBe(false);
        expect(isDefaultSettings({...defaults, reportStats: false})).toBe(false);
        expect(isDefaultSettings({...defaults, server: 'https://files.example.com'})).toBe(false);
        expect(isDefaultSettings({...defaults, web: 'https://app.example.com'})).toBe(false);
    });

    // reportStats defaults to TRUE, so its "changed" direction is the opposite of
    // every other boolean here. Worth pinning explicitly.
    it('treats stats ON as the default and OFF as a change', () => {
        expect(isDefaultSettings({...defaults, reportStats: true})).toBe(true);
        expect(isDefaultSettings({...defaults, reportStats: false})).toBe(false);
    });
});
