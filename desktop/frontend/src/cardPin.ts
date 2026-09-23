// The console card's vertical pin for Receive > REQUEST LINK (spec 06 5.5,
// VR3-D03: Close link does not move when a request mounts).
//
// The card is centered by m-auto inside a min-h-full flex box, so every change
// in its height re-centers it: a prompt mounting below the link block grew it
// by about 130 px and carried Close link 65.4 px up at 1000 x 640 in Chromium
// (WP-D-QA CELL-09). Keeping Close link inside the link block only fixes its
// place in the card, not the card's place on screen.
//
// CSS alone cannot keep the waiting view where the approved canvas centers it
// and also stop growth from moving it: the centered spot depends on the
// waiting card's height, and CSS keeps no memory of a height the card no
// longer has. So while the view shows a link, the card's top is
// read once, where m-auto put it, and held as an explicit margin-top. Growth
// then extends downward and <main> scrolls if it has to. A resize re-centers
// and reads the spot again. Everywhere else the style is undefined and m-auto
// alone places the card, as before.

import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties} from 'react';

/** centeredTop is the card's used top margin inside its box: how far below the
 *  box's top padding edge m-auto placed it. Rect differences, not offsetTop:
 *  offsetTop rounds to whole pixels, and a pin half a pixel off is a move. Both
 *  rects shift together when <main> scrolls, so the difference ignores it. */
export function centeredTop(card: HTMLElement): number {
    const box = card.parentElement;
    if (!box) return 0;
    const pad = parseFloat(getComputedStyle(box).paddingTop) || 0;
    return Math.max(0, card.getBoundingClientRect().top - box.getBoundingClientRect().top - pad);
}

/** useCardPin holds the card's top while `active` is true. The returned style
 *  goes inline on the card: cn() has no tailwind-merge, so an inline style,
 *  not a competing class, is what reliably beats m-auto's margin-top. */
export function useCardPin(active: boolean) {
    const ref = useRef<HTMLDivElement>(null);
    const [top, setTop] = useState<number | null>(null);
    // Bumped by a resize: the card goes back to m-auto for one render and the
    // layout effect reads the new centered spot before anything paints.
    const [epoch, setEpoch] = useState(0);

    useLayoutEffect(() => {
        if (!active) {
            setTop(null);
            return;
        }
        if (ref.current) setTop(centeredTop(ref.current));
    }, [active, epoch]);

    useEffect(() => {
        if (!active) return;
        const onResize = () => {
            setTop(null);
            setEpoch((n) => n + 1);
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [active]);

    const style: CSSProperties | undefined = active && top !== null ? {marginTop: top, marginBottom: 'auto'} : undefined;
    return {ref, style};
}
