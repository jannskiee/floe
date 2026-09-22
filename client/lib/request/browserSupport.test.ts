import { describe, it, expect } from 'vitest';
import { hasDataChannelSupport } from './browserSupport';

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
