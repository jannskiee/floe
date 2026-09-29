import {describe, expect, it} from 'vitest';
import {ANCHOR_REF, anchorTop} from './cardPin';

// The window's fixed pieces above the card, in CSS pixels: the title bar and
// the card box's top padding (py-8). The Review notice is fixed at top 52 px
// and 48 px tall (Toasts.tsx), so it ends at 100 px.
const TITLE_BAR = 36;
const BOX_PADDING = 32;
const NOTICE_BOTTOM = 52 + 48;

// <main> is the window height less the title bar; the room is <main> less the
// box's top and bottom padding.
const roomAt = (windowHeight: number) => windowHeight - TITLE_BAR - 2 * BOX_PADDING;
const cardTopAt = (windowHeight: number) => TITLE_BAR + BOX_PADDING + anchorTop(roomAt(windowHeight));

describe('the REQUEST LINK card anchor', () => {
    it('centers the minimal Ready form: 35 px for a 540 px room', () => {
        expect(ANCHOR_REF).toBe(470);
        expect(roomAt(640)).toBe(540);
        expect(anchorTop(540)).toBe(35);
        expect(cardTopAt(640)).toBe(103);
        expect(cardTopAt(720)).toBe(143);
    });

    it('never goes negative in a small window', () => {
        expect(anchorTop(ANCHOR_REF)).toBe(0);
        expect(anchorTop(300)).toBe(0);
        expect(anchorTop(0)).toBe(0);
    });

    it('keeps the card header below the Review notice at the minimum window, 1000 x 640', () => {
        // The invariant: at 640 px the card's top is at least 100 px, so the
        // fixed notice never covers the status chip or History.
        expect(cardTopAt(640)).toBeGreaterThanOrEqual(NOTICE_BOTTOM);
        for (let h = 640; h <= 1440; h += 10) expect(cardTopAt(h), `${h}`).toBeGreaterThanOrEqual(NOTICE_BOTTOM);
    });
});
