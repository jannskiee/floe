// The console card's vertical anchor for Receive > REQUEST LINK (spec 06 5.5,
// VR3-D03: Close link does not move when a request mounts; D-136: the card's
// top stays put for the whole view).
//
// The card is centered by m-auto inside a min-h-full flex box, so every change
// in its height re-centers it: a prompt mounting below the link block grew it
// by about 130 px and carried Close link 65.4 px up at 1000 x 640 in Chromium
// (WP-D-QA CELL-09), and across the view's states the card's top travelled
// from 93 to 202 px. A top read from wherever m-auto put the card could not
// fix that: the prompt it pinned at 133 px ran Accept off the bottom of a
// 640 px window.
//
// So the whole REQUEST LINK view anchors the card at one computed top instead:
// half of what the room has over ANCHOR_REF, the height of the smallest Ready
// form. It is a named design constant, not the rendered form's height, because
// a taller form would give 0 and a card top of 68 px, under the fixed Review
// notice (Toasts.tsx, top 52 px, 48 px tall), which would then cover the
// status chip and History. At 1000 x 640 the room is 540 px, so the margin is
// 35 px and the card's top sits at 36 (title bar) + 32 (box padding) + 35 =
// 103 px. Growth extends downward and <main> scrolls if it has to; a resize
// recomputes. Everywhere else the style is undefined and m-auto alone places
// the card, as before.

import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties} from 'react';

/** ANCHOR_REF is the height the anchor centers, in CSS pixels: the minimal
 *  Ready form, measured on the captures. */
export const ANCHOR_REF = 470;

/** anchorTop is the card's margin-top for a room of `room` pixels. */
export function anchorTop(room: number): number {
    return Math.max(0, (room - ANCHOR_REF) / 2);
}

/** cardRoom is the height the card can be placed in: <main>'s visible height
 *  less the box's vertical padding. Not the box's own height: the box is
 *  min-h-full and grows with the card, so it cannot be the room. */
export function cardRoom(card: HTMLElement): number {
    const box = card.parentElement;
    const main = box?.parentElement;
    if (!box || !main) return 0;
    const s = getComputedStyle(box);
    return main.clientHeight - (parseFloat(s.paddingTop) || 0) - (parseFloat(s.paddingBottom) || 0);
}

/** useCardPin anchors the card's top while `active` is true. The returned
 *  style goes inline on the card: cn() has no tailwind-merge, so an inline
 *  style, not a competing class, is what reliably beats m-auto's margin-top. */
export function useCardPin(active: boolean) {
    const ref = useRef<HTMLDivElement>(null);
    const [top, setTop] = useState<number | null>(null);
    // Bumped by a resize, so the room is read again.
    const [epoch, setEpoch] = useState(0);

    useLayoutEffect(() => {
        if (!active) {
            setTop(null);
            return;
        }
        if (ref.current) setTop(anchorTop(cardRoom(ref.current)));
    }, [active, epoch]);

    useEffect(() => {
        if (!active) return;
        const onResize = () => setEpoch((n) => n + 1);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [active]);

    const style: CSSProperties | undefined = active && top !== null ? {marginTop: top, marginBottom: 'auto'} : undefined;
    return {ref, style};
}
