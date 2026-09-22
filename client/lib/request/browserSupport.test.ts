import { describe, it, expect } from 'vitest';
import { canPickFolders, hasDataChannelSupport, isCoarsePointer, hasRelayUrl, parseIceServers } from './browserSupport';

describe('hasDataChannelSupport', () => {
    it('no RTCPeerConnection is unsupported', () => {
        expect(hasDataChannelSupport({})).toBe(false);
        expect(hasDataChannelSupport({ RTCPeerConnection: undefined })).toBe(false);
        // A non-callable value under the name is not a constructor either.
        expect(hasDataChannelSupport({ RTCPeerConnection: {} })).toBe(false);
        expect(hasDataChannelSupport(undefined)).toBe(false);
        expect(hasDataChannelSupport(null)).toBe(false);
    });

    it('RTCPeerConnection without createDataChannel is unsupported', () => {
        // A media-only implementation, or a webview shim that installs the name
        // and nothing else. The page has no use for a peer connection that
        // cannot carry a data channel.
        class MediaOnly {}
        expect(hasDataChannelSupport({ RTCPeerConnection: MediaOnly })).toBe(false);
    });

    it('RTCPeerConnection with createDataChannel is supported', () => {
        class WithChannels {
            createDataChannel() {
                return {};
            }
        }
        expect(hasDataChannelSupport({ RTCPeerConnection: WithChannels })).toBe(true);
    });
});

describe('canPickFolders', () => {
    // A getter, so the name lands on the PROTOTYPE, which is where the browser
    // puts it and where the probe looks. A class field would sit on instances
    // and the detection would read false on a browser that supports it.
    class InputWithDirectory {
        get webkitdirectory() {
            return false;
        }
    }
    class InputWithoutDirectory {}

    const SUPPORTS = { HTMLInputElement: InputWithDirectory };

    const DESKTOP_CHROME =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const CHROME_ANDROID = (major: number) =>
        `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
    const IOS_SAFARI = (version: string) =>
        `Mozilla/5.0 (iPhone; CPU iPhone OS ${version.replace('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`;

    it('hides folder picking without webkitdirectory', () => {
        expect(canPickFolders({ HTMLInputElement: InputWithoutDirectory }, DESKTOP_CHROME)).toBe(
            false
        );
        expect(canPickFolders({}, DESKTOP_CHROME)).toBe(false);
        expect(canPickFolders(undefined, DESKTOP_CHROME)).toBe(false);
        expect(canPickFolders(null, DESKTOP_CHROME)).toBe(false);
    });

    it('hides folder picking on Chrome Android 131', () => {
        // 131 crashes when a directory is selected. The property is present,
        // so feature detection cannot see this and the user agent has to.
        expect(canPickFolders(SUPPORTS, CHROME_ANDROID(131))).toBe(false);
        // The same call carries every earlier version, which open the picker
        // and then offer files only. 132 is where it starts working.
        expect(canPickFolders(SUPPORTS, CHROME_ANDROID(130))).toBe(false);
        expect(canPickFolders(SUPPORTS, CHROME_ANDROID(90))).toBe(false);
        expect(canPickFolders(SUPPORTS, CHROME_ANDROID(132))).toBe(true);
        expect(canPickFolders(SUPPORTS, CHROME_ANDROID(141))).toBe(true);
    });

    it('hides folder picking on iOS Safari 18.3', () => {
        // Every browser on iOS is WebKit, so this is the platform's limit and
        // not Safari's: below 18.4 the property can be set and does nothing.
        expect(canPickFolders(SUPPORTS, IOS_SAFARI('18.3'))).toBe(false);
        expect(canPickFolders(SUPPORTS, IOS_SAFARI('17.6'))).toBe(false);
        expect(canPickFolders(SUPPORTS, IOS_SAFARI('18.4'))).toBe(true);
        expect(canPickFolders(SUPPORTS, IOS_SAFARI('19.0'))).toBe(true);
        // An iOS device whose version cannot be read is hidden, not allowed.
        expect(canPickFolders(SUPPORTS, 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15')).toBe(false);
    });

    it('allows folder picking on desktop Chrome', () => {
        expect(canPickFolders(SUPPORTS, DESKTOP_CHROME)).toBe(true);
        // Desktop Edge, which is the other browser the Beta copy names.
        expect(
            canPickFolders(
                SUPPORTS,
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'
            )
        ).toBe(true);
    });
});

describe('isCoarsePointer', () => {
    it('coarse pointer is detected from matchMedia', () => {
        const asked: string[] = [];
        const win = (matches: boolean) => ({
            matchMedia: (q: string) => {
                asked.push(q);
                return { matches };
            },
        });
        expect(isCoarsePointer(win(true))).toBe(true);
        expect(isCoarsePointer(win(false))).toBe(false);
        expect(asked).toEqual(['(pointer: coarse)', '(pointer: coarse)']);
        // No matchMedia, a throwing one, or a truthy non-boolean all read as
        // a fine pointer: the line is a courtesy, never a block.
        expect(isCoarsePointer({})).toBe(false);
        expect(isCoarsePointer(undefined)).toBe(false);
        expect(isCoarsePointer({ matchMedia: () => { throw new Error('no'); } })).toBe(false);
        expect(isCoarsePointer({ matchMedia: () => ({ matches: 'yes' as unknown as boolean }) })).toBe(false);
    });
});

describe('hasRelayUrl and parseIceServers', () => {
    it('hasRelayUrl finds turn and turns in string and array urls', () => {
        expect(hasRelayUrl([{ urls: 'turn:t.example:3478' }])).toBe(true);
        expect(hasRelayUrl([{ urls: 'turns:t.example:443?transport=tcp' }])).toBe(true);
        expect(hasRelayUrl([{ urls: ['stun:s.example:3478', 'turn:t.example:3478'] }])).toBe(true);
        expect(hasRelayUrl([{ urls: 'stun:stun.l.google.com:19302' }, { urls: ['stun:a', 'stun:b'] }])).toBe(false);
        expect(hasRelayUrl([])).toBe(false);
        // A scheme only counts at the start: a STUN host named turn is not a relay.
        expect(hasRelayUrl([{ urls: 'stun:turn:3478' }])).toBe(false);
        expect(hasRelayUrl([{ urls: 'TURN:t.example:3478' }])).toBe(true);
    });

    it('parseIceServers keeps well-formed entries and refuses anything else', () => {
        const good = [
            { urls: 'stun:s.example:3478' },
            { urls: ['turn:t.example:3478'], username: 'u', credential: 'c' },
        ];
        expect(parseIceServers(good)).toEqual(good);
        expect(parseIceServers([])).toBeNull();
        expect(parseIceServers(null)).toBeNull();
        expect(parseIceServers({ urls: 'stun:x' })).toBeNull();
        expect(parseIceServers('stun:x')).toBeNull();
        // One malformed entry and the whole answer is refused, so the page
        // falls back to its own STUN list rather than half of a strange one.
        expect(parseIceServers([{ urls: 'stun:x' }, { urls: 42 }])).toBeNull();
        expect(parseIceServers([{ urls: [] }])).toBeNull();
        expect(parseIceServers([{ urls: 'http://evil.example/' }])).toBeNull();
        expect(parseIceServers([{ urls: 'stun:x', username: 7 }])).toBeNull();
        // Extra keys are dropped rather than handed to the peer connection.
        expect(parseIceServers([{ urls: 'stun:x', extra: 'y' }])).toEqual([{ urls: 'stun:x' }]);
    });
});
