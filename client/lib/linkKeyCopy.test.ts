import { describe, expect, it } from 'vitest';
import {
    KEY_FAILED_RECEIVER,
    KEY_FAILED_SENDER,
    KEY_REFUSED_SENDER,
    KEY_SILENT_SENDER,
    KEY_UNAVAILABLE_RECEIVER,
    KEY_UNAVAILABLE_SENDER,
    receiverKeyLine,
    senderKeyLine,
} from './linkKeyCopy';

// The owner approved these words in the plan, so each is quoted here, never built.
describe('the words a page shows for the link-key check', () => {
    it('a sending page', () => {
        expect(KEY_FAILED_SENDER).toBe(
            "Floe couldn't confirm the person who opened your link, so nothing was sent. Make a new link and send it again."
        );
        expect(KEY_REFUSED_SENDER).toBe(
            "The other side couldn't confirm this link, so nothing was sent. Make a new link and send it again."
        );
        expect(KEY_UNAVAILABLE_SENDER).toBe(
            "This browser can't check this link, so nothing was sent. Open Floe in a current version of Chrome, Edge, Firefox or Safari."
        );
    });

    it('a receiving page', () => {
        expect(KEY_FAILED_RECEIVER).toBe(
            "Floe couldn't confirm who sent this link, so nothing was received. Ask them for a new link."
        );
        expect(KEY_UNAVAILABLE_RECEIVER).toBe(
            "This browser can't check this link, so nothing was received. Open it in a current version of Chrome, Edge, Firefox or Safari."
        );
    });

    it('the one the cutover shows, built now', () => {
        expect(KEY_SILENT_SENDER).toBe(
            "Floe couldn't confirm the other side. They may need to update Floe or keep the page open."
        );
    });

    it('writes no dash and no word of the mechanism a person cannot act on', () => {
        for (const line of [
            KEY_FAILED_SENDER,
            KEY_REFUSED_SENDER,
            KEY_UNAVAILABLE_SENDER,
            KEY_SILENT_SENDER,
            KEY_FAILED_RECEIVER,
            KEY_UNAVAILABLE_RECEIVER,
        ]) {
            expect(line).not.toMatch(/[–—]/);
            expect(line).not.toMatch(/\b(kc|HMAC|DTLS|tag|fingerprint|certificate)\b/i);
        }
    });
});

// Which line goes with which enum. The enum is all a page gets from the check, so
// this is the whole of what a failed check can put on a screen.
describe('senderKeyLine', () => {
    it('a proof that did not check out blames neither the browser nor the link', () => {
        expect(senderKeyLine('bad-tag')).toBe(KEY_FAILED_SENDER);
        expect(senderKeyLine('malformed')).toBe(KEY_FAILED_SENDER);
        expect(senderKeyLine('missing')).toBe(KEY_FAILED_SENDER);
    });

    it('a refusal says the other side could not confirm it', () => {
        expect(senderKeyLine('peer-refused')).toBe(KEY_REFUSED_SENDER);
    });

    // Never claims the other side failed (D7).
    it('a browser that cannot read the certificates says so', () => {
        expect(senderKeyLine('unavailable')).toBe(KEY_UNAVAILABLE_SENDER);
    });

    // Reachable only once ENFORCE_SHARE_LINK_KEY is on: a detect-mode sender never
    // hears silence as a failure.
    it('silence gets the neutral line, since it can also be an old receiver', () => {
        expect(senderKeyLine('silent')).toBe(KEY_SILENT_SENDER);
    });
});

describe('receiverKeyLine', () => {
    it('a check that failed, or a sender that refused this side, is the same one line', () => {
        expect(receiverKeyLine(false)).toBe(KEY_FAILED_RECEIVER);
    });

    it('a browser that cannot read the certificates says so', () => {
        expect(receiverKeyLine(true)).toBe(KEY_UNAVAILABLE_RECEIVER);
    });
});
