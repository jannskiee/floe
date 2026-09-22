import {describe, expect, it} from 'vitest';
import {advancedSummary, hostOf, requestLinksSwitch, webPlaceholder} from './settings';

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

describe('webPlaceholder', () => {
    // The cases mirror TestWeb in cli/engine/serverurl/serverurl_test.go, which
    // pins engine/serverurl.Web, the function that actually builds the link.
    // Nothing runs both tables: this one guards only the TypeScript side, so a
    // case added to the Go table has to be carried over here by hand.
    it.each([
        ['production', 'https://api.floe.one', 'https://floe.one'],
        ['production with trailing slash', 'https://api.floe.one/', 'https://floe.one'],
        ['local dev', 'http://localhost:3001', 'http://localhost:3000'],
        ['local dev with trailing slash', 'http://localhost:3001/', 'http://localhost:3000'],
        // One-domain self-hosting: the web app and the API share an origin, so
        // the server address is already the right link base.
        ['self-hosted one domain', 'https://floe.example.com', 'https://floe.example.com'],
        ['self-hosted with trailing slash', 'https://floe.example.com/', 'https://floe.example.com'],
    ])('%s', (_name, server, want) => {
        expect(webPlaceholder(server)).toBe(want);
    });

    // The one deliberate divergence from the Go table, where Web('') is ''.
    // Go's callers pass an already-resolved server; this placeholder is shown
    // while the Server address field is still blank, and blank means Floe's
    // own server, so the field shows what that resolves to rather than nothing.
    it('shows the production link while the server field is blank', () => {
        expect(webPlaceholder('')).toBe('https://floe.one');
        expect(webPlaceholder('   ')).toBe('https://floe.one');
    });
});

describe('requestLinksSwitch', () => {
    it('request links switch is enabled when request-1 is listed', () => {
        expect(requestLinksSwitch({reachable: true, requestLinks: true}, false)).toEqual({
            disabled: false,
            description: 'Let someone send files to this PC through a link you make. Works while Floe is open.',
        });
    });

    it('request links switch is disabled with the server line when request-1 is absent', () => {
        expect(requestLinksSwitch({reachable: true, requestLinks: false}, false)).toEqual({
            disabled: true,
            description: 'Not available on this server right now.',
        });
    });

    it('request links switch is disabled with the server line when the server is unreachable', () => {
        expect(requestLinksSwitch({reachable: false, requestLinks: false}, false)).toEqual({
            disabled: true,
            description: 'Not available on this server right now.',
        });
        // A malformed probe answer that claims the feature from an unreachable
        // server is still unreachable.
        expect(requestLinksSwitch({reachable: false, requestLinks: true}, false).disabled).toBe(true);
    });

    it('request links switch is disabled with Close your request link first while a link is open', () => {
        for (const feature of [
            {reachable: true, requestLinks: true},
            {reachable: true, requestLinks: false},
            {reachable: false, requestLinks: false},
            null,
        ]) {
            expect(requestLinksSwitch(feature, true)).toEqual({
                disabled: true,
                description: 'Close your request link first.',
            });
        }
    });

    // D-115: a Beta feature can always be turned off. Only turning it on
    // needs a server that lists request-1; the S5 lock for an open link stays.
    it('request links switch can always be turned off, even without request-1', () => {
        const on = true;
        expect(requestLinksSwitch({reachable: true, requestLinks: false}, false, on)).toEqual({
            disabled: false,
            description: 'Not available on this server right now.',
        });
        expect(requestLinksSwitch({reachable: false, requestLinks: false}, false, on).disabled).toBe(false);
        expect(requestLinksSwitch(null, false, on).disabled).toBe(false);
        // Off, it still turns on only against request-1.
        expect(requestLinksSwitch({reachable: true, requestLinks: false}, false, false).disabled).toBe(true);
        // And an open link still locks it either way.
        expect(requestLinksSwitch({reachable: true, requestLinks: true}, true, on)).toEqual({
            disabled: true,
            description: 'Close your request link first.',
        });
    });

    it('stays disabled without claiming anything before the first probe answers', () => {
        expect(requestLinksSwitch(null, false)).toEqual({
            disabled: true,
            description: 'Let someone send files to this PC through a link you make. Works while Floe is open.',
        });
    });
});
