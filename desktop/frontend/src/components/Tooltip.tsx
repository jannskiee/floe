import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {cn} from './ui';

const GAP = 8;        // distance from the trigger
const MARGIN = 8;     // keep this far from the viewport edge
const DELAY = 250;    // hover dwell before showing
const SKIP = 300;     // after a tooltip closes, the next one opens instantly

// Shared across every instance so sweeping along a row of icon buttons shows the
// next tooltip immediately instead of re-waiting the dwell (Radix skipDelayDuration).
let lastClosed = 0;

interface Coords {
    left: number;
    top: number;
}

/** Tooltip wraps a trigger and shows a floating label on hover or keyboard focus.
 *
 *  It portals to document.body on purpose: the console card sets `backdrop-blur-xl`,
 *  which makes it the containing block for absolute AND fixed descendants, and three
 *  ancestors above it clip overflow, so an in-tree bubble would be cut off.
 *
 *  `className` lands on the wrapper span, not the trigger. Pass layout classes the
 *  trigger relies on from its parent flex row (e.g. `shrink-0`) so nothing reflows. */
export function Tooltip({label, keys, align = 'center', className, children}: {
    label: string;
    keys?: string;
    /** Edge-align the bubble with the trigger instead of centring it. Use 'start' on
     *  the first control in a row and 'end' on the last: a centred bubble on an
     *  edge-adjacent trigger overhangs the panel and reads as unanchored, while an
     *  edge-aligned one sits on the layout grid. */
    align?: 'center' | 'start' | 'end';
    className?: string;
    children: ReactNode;
}) {
    const id = useId();
    const ref = useRef<HTMLSpanElement>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);
    const timer = useRef<number | undefined>(undefined);
    // anchor = the trigger's rect, captured when the tooltip opens. coords = the
    // bubble's final position, which can only be computed once the bubble has been
    // laid out and its own size is known.
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const [coords, setCoords] = useState<Coords | null>(null);

    const hide = useCallback(() => {
        window.clearTimeout(timer.current);
        setAnchor((prev) => {
            if (prev) lastClosed = Date.now();
            return null;
        });
        setCoords(null);
    }, []);

    const place = useCallback(() => {
        const el = ref.current;
        if (el) setAnchor(el.getBoundingClientRect());
    }, []);

    // Position after the bubble is in the DOM but before the browser paints, so the
    // unmeasured frame is never visible. requestAnimationFrame is wrong here: it can
    // fire before React commits the portal, leaving bubbleRef null and the bubble
    // stuck at its uncentred, unclamped fallback position.
    useLayoutEffect(() => {
        if (!anchor) return;
        const b = bubbleRef.current;
        if (!b) return;
        const {width, height} = b.getBoundingClientRect();
        // Edge-align to the trigger's CONTENT box, not its border box. A padded
        // trigger (the Floe lockup carries px-2) would otherwise place the bubble
        // level with an invisible edge, leaving it looking shifted outward against
        // the glyph the eye actually aligns to.
        const trigger = ref.current?.firstElementChild;
        const ts = trigger ? getComputedStyle(trigger) : null;
        const padL = ts ? parseFloat(ts.paddingLeft) || 0 : 0;
        const padR = ts ? parseFloat(ts.paddingRight) || 0 : 0;

        // Centre on the trigger (or hang from one of its content edges), then clamp
        // inside the viewport so a control flush with a window edge (Close, the Floe
        // lockup) still renders its bubble on screen.
        let left;
        if (align === 'end') left = anchor.right - padR - width;
        else if (align === 'start') left = anchor.left + padL;
        else left = anchor.left + anchor.width / 2 - width / 2;
        left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN);
        // Below by default, flipped above when there is no room.
        let top = anchor.bottom + GAP;
        if (top + height > window.innerHeight - MARGIN) top = anchor.top - height - GAP;
        setCoords({left, top});
    }, [anchor, align]);

    const show = useCallback((instant: boolean) => {
        window.clearTimeout(timer.current);
        if (instant || Date.now() - lastClosed < SKIP) {
            place();
            return;
        }
        timer.current = window.setTimeout(place, DELAY);
    }, [place]);

    // Timers must be cleared on unmount: main.tsx renders under StrictMode, whose
    // double-invoked effects would otherwise leave a tooltip stuck open in dev.
    useEffect(() => () => window.clearTimeout(timer.current), []);

    // While open, anything that moves the trigger or signals "done" dismisses it.
    useEffect(() => {
        if (!anchor) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
        window.addEventListener('keydown', onKey);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [anchor, hide]);

    return (
        <span
            ref={ref}
            className={cn('inline-flex', className)}
            aria-describedby={anchor ? id : undefined}
            onMouseEnter={() => show(false)}
            onMouseLeave={hide}
            onFocusCapture={(e) => {
                // Keyboard focus only. A mouse click focuses too, and re-opening the
                // bubble the instant a button is clicked reads as a glitch.
                if ((e.target as HTMLElement).matches?.(':focus-visible')) show(true);
            }}
            onBlurCapture={hide}
            onPointerDown={hide}
        >
            {children}
            {anchor && createPortal(
                <div
                    ref={bubbleRef}
                    id={id}
                    role="tooltip"
                    style={{
                        left: coords?.left ?? 0,
                        top: coords?.top ?? 0,
                        // Hidden for the single pre-measurement commit. useLayoutEffect
                        // resolves it before paint, so this never actually renders.
                        visibility: coords ? 'visible' : 'hidden',
                    }}
                    className={cn(
                        'animate-floe-in pointer-events-none fixed z-40 flex max-w-[240px] items-center gap-2',
                        'rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 shadow-2xl',
                        'text-xs leading-snug text-zinc-100 motion-reduce:animate-none',
                    )}
                >
                    <span>{label}</span>
                    {keys && (
                        <kbd className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-zinc-400">
                            {keys}
                        </kbd>
                    )}
                </div>,
                document.body,
            )}
        </span>
    );
}
