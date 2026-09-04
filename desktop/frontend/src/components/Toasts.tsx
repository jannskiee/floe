// The two transient bars: the update banner and the undo bar after a Clear.

import {Download, Undo2, X} from 'lucide-react';
import {BrowserOpenURL} from '../../wailsjs/runtime/runtime';
import {Button, cn} from './ui';
import {DOWNLOAD_URL, bareVersion} from '../update';

/** UpdateNotice is the app's one toast, and a notice only: nothing downloads or
 *  installs here, so it carries a single action plus a dismiss (a "Later"
 *  button would just be a second X, and snooze semantics belong to
 *  auto-updaters with a payload waiting). It persists until acted on: an
 *  actionable notice that auto-hides is one most users never see, and there is
 *  no notification center to replay it. z-30 keeps tooltips (z-40) and the
 *  dialogs (z-50) painting over it, so the documented paint-order/Escape
 *  invariant is untouched; Escape closes it only while focus is inside the
 *  card, never from the global chain. It must not steal focus on appear.
 *  Screen-reader announcement lives in the persistent sr-only region at the
 *  app root, not here: a live region that mounts with its content already
 *  inside announces nothing. */
export function UpdateNotice({version, onDismiss}: {version: string; onDismiss: () => void}) {
    return (
        <div
            role="group"
            aria-label="Update available"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDismiss(); } }}
            className={cn(
                'floe-notice-edge fixed right-4 top-[52px] z-30 isolate flex h-12 items-center gap-3 rounded-xl pl-4 pr-1.5',
                'bg-zinc-900/80 ring-1 ring-inset ring-white/10 backdrop-blur-xl backdrop-saturate-150',
                'shadow-[0_1px_1px_rgba(0,0,0,0.06),0_4px_8px_-4px_rgba(0,0,0,0.28),0_16px_32px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.07)]',
                'animate-floe-notice-in motion-reduce:animate-none',
            )}
        >
            {/* strokeWidth 3 on a 16px lucide renders a whole 2.0 device px, so
                the glyph is true white and crisp; the default 2 draws 1.33px
                straddling pixel boundaries, which antialiases to fuzzy grey. */}
            <Download className="size-4 shrink-0 text-white" strokeWidth={3} aria-hidden/>
            <div className="flex min-w-0 items-center gap-2">
                <h2 className="whitespace-nowrap text-[13px] font-semibold leading-none tracking-[-0.01em] text-zinc-50">Update available</h2>
                {/* A chip, not bare text, by the owner's choice: the boxed
                    version reads as a badge. Center-aligned like any badge, so
                    no baseline nudge. */}
                <span className="whitespace-nowrap rounded bg-white/[0.07] px-1.5 py-1 font-mono text-[11px] leading-none text-zinc-300">{bareVersion(version)}</span>
            </div>
            <div className="flex shrink-0 items-center">
                {/* No px override: cn is a plain join, so the base px-3 wins
                    over any px-* here anyway (equal specificity, later in the
                    sheet). h-7 and text-xs do apply. */}
                <Button className="h-7 text-xs" onClick={() => { BrowserOpenURL(DOWNLOAD_URL); onDismiss(); }}>
                    Get update
                </Button>
                {/* Ink-symmetric margins, not flex gaps: the button's edge is
                    flush while the X's ink sits ~10px inside its hit box, so
                    14px of margin on the button side and 4px on the X side
                    give the divider equal ~14px optical gaps to both. */}
                <span className="ml-3.5 mr-1 h-5 w-px bg-white/[0.14]" aria-hidden/>
                <button
                    aria-label="Dismiss update notice"
                    onClick={onDismiss}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-ice"
                >
                    <X className="size-3.5"/>
                </button>
            </div>
        </div>
    );
}

// The undo bar is focused from App.clearStaged() by getElementById, which is
// a contract tsc cannot see once the two live in different files. Naming it
// once and importing it there makes a rename a compile error instead of a
// keyboard that silently falls to document.body after a Clear.
export const UNDO_ANCHOR_ID = 'floe-undo-clear';

/** UndoToast is the app's second toast, and the opposite kind to the first:
 *  the update notice stands until it is acted on, while this one exists only
 *  for as long as the undo behind it does. It sits bottom centre, in the empty
 *  space under the card, so the two can never collide, and it is a pill rather
 *  than a rounded rectangle because it carries a passing sentence rather than a
 *  standing task.
 *
 *  Same material as the notice (blurred zinc, an inset hairline, the layered
 *  shadow) so they read as one family, but deliberately WITHOUT the ice rim:
 *  that is the notice's one accent, and ice otherwise belongs to focus rings
 *  and the OS drag highlight.
 *
 *  The full-width positioner is pointer-events-none so this cannot swallow a
 *  click meant for the card behind it; only the pill itself takes the pointer.
 *  Hovering the pill holds the countdown, so the offer cannot expire out from
 *  under a pointer travelling towards it.
 *
 *  Screen-reader announcement lives in the persistent sr-only region at the app
 *  root, next to the update notice's, for the reason documented there: a live
 *  region that mounts with its text already inside announces nothing. */
export function UndoToast({label, action, onUndo, onHold, onArm}: {
    label: string;
    action: string;
    onUndo: () => void;
    onHold: () => void;
    onArm: () => void;
}) {
    // Centred under the console, not under the window: the left edge mirrors
    // the hero rail's own w-[42%] max-w-[460px] rule, so the pill lines up with
    // the card it is talking about at every window width. Fixed rather than
    // absolute inside main, because that column scrolls and would carry the
    // toast away with it.
    // The px-8 on the positioner matches the console's own gutter, so a long
    // line can never run to the edges of the column.
    return (
        <div className="pointer-events-none fixed bottom-8 left-[min(42%,460px)] right-0 z-30 flex justify-center px-8">
            <div
                onMouseEnter={onHold}
                onMouseLeave={onArm}
                className={cn(
                    // The card's surface, corner and fill, but only as wide as
                    // what it has to say: at these labels that is about half the
                    // card, which is the size a passing message should be. A bar
                    // the full width of the card read as a second card.
                    'pointer-events-auto flex h-12 max-w-full items-center gap-3 rounded-xl border border-white/10 bg-zinc-900/60 pl-4 pr-2.5',
                    'shadow-2xl ring-1 ring-white/5 backdrop-blur-xl backdrop-saturate-150',
                    'animate-floe-toast-in motion-reduce:animate-none',
                )}
            >
                <Undo2 className="size-4 shrink-0 text-zinc-400" strokeWidth={2.5} aria-hidden/>
                <span className="truncate text-[13px] leading-none tracking-[-0.005em] text-zinc-200">{label}</span>
                <button
                    id={UNDO_ANCHOR_ID}
                    aria-label={action}
                    onClick={onUndo}
                    // Hold the countdown only for a keyboard landing. The focus
                    // move that brings the user here happens after a mouse click
                    // too, and holding then would pin the offer open until they
                    // clicked something else. :focus-visible is exactly that
                    // distinction, and Tooltip.tsx already leans on it.
                    onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) onHold(); }}
                    onBlur={onArm}
                    className="ml-1 h-8 shrink-0 rounded-md border border-white/10 bg-white/[0.06] px-3 text-[13px] font-medium leading-none text-zinc-100 transition-colors hover:border-white/20 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60"
                >
                    Undo
                </button>
            </div>
        </div>
    );
}
