import React from 'react';
import { ROUTE_NARROW, ROUTE_WIDE, routeGeometry, type RouteGeometry } from '@/lib/routeFigure';
import { RELAY_CAP } from '@/lib/howItWorksStrings';

/**
 * The one drawing on /how-it-works: a transfer as a single line.
 *
 * A baseline runs from YOU to THEM. Two spurs rise from the devices and meet
 * the signaling server's mark at the top of the arch; the direct line is the
 * ice stroke below it, and a dotted second path dips through the relay tick and
 * back up to THEM. The arch is continuous ink, so the server is told apart from
 * the relay by being a brighter mark on a solid line rather than by a break in
 * it. Labels are the product's own badge words with the badge's green and amber
 * dots; no boxes, no arrowheads, no icons.
 *
 * Two variants, wide from md and narrow below it, both drawn from
 * routeGeometry() so the two cannot drift; the CSS gate is the only switch.
 * Motion is CSS only and plays once on paint: the .hiw-* rules in globals.css,
 * inside
 * prefers-reduced-motion: no-preference. The base rules are the finished
 * figure, so reduced motion, the e2e sweep and the screenshot matrix all get
 * the completed drawing at first paint, and a reader with JavaScript off gets
 * the sequence anyway, since CSS animations do not need it. No client
 * island: the route stays a Server Component. A plain load puts the figure
 * inside the first viewport at every width; a reader arriving at #direct,
 * #relay or #size-limit lands below it and sees that same finished drawing.
 */

// leading-none, as the page header does for its eyebrow: an 11px label
// inherits preflight line-height 1.5, and the 5.5px of dead half-leading
// that buys is 6.9 viewBox units at the narrow scale, more than the phone
// rise has to spare between the device tick and the relay tick.
const LABEL = 'font-mono text-[11px] leading-none uppercase tracking-[0.2em]';

function Variant({ g, className }: { g: RouteGeometry; className: string }) {
    const [left, right] = g.deviceTicks;
    const L = g.labels;
    return (
        <div className={`relative ${className}`} style={{ aspectRatio: `${g.width} / ${g.height}` }}>
            <svg viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true" focusable="false">
                <line className="hiw-tick" x1={left.x1} y1={left.y1} x2={left.x2} y2={left.y2} />
                <line className="hiw-tick" x1={right.x1} y1={right.y1} x2={right.x2} y2={right.y2} />
                <line
                    className="hiw-tick"
                    x1={g.serverTick.x1}
                    y1={g.serverTick.y1}
                    x2={g.serverTick.x2}
                    y2={g.serverTick.y2}
                />
                {/* pathLength normalizes both spurs and the line to 1000 units so one
                    stroke-dasharray value draws them regardless of their real length. */}
                <path className="hiw-spur" pathLength={1000} d={g.spurLeft} />
                <path className="hiw-spur" pathLength={1000} d={g.spurRight} />
                <path className="hiw-detour" d={g.detour} />
                <line
                    className="hiw-tick hiw-relay-tick"
                    x1={g.relayTick.x1}
                    y1={g.relayTick.y1}
                    x2={g.relayTick.x2}
                    y2={g.relayTick.y2}
                />
                <path className="hiw-direct" pathLength={1000} d={g.direct} />
                {/* A 1px ice ring marks the arrival; ice is never a fill on this site. */}
                <circle className="hiw-ring" cx={g.them.x} cy={g.them.y} r={3} />
            </svg>
            {/* HTML labels over the SVG so they get Geist Mono, the page's color
                tokens and normal text rendering. Centered labels carry pl-[0.2em]
                to repay the letter-space that tracking adds after the last glyph.
                The Direct and Relay tails drop at md, the breakpoint that swaps the
                drawing, not at sm: between 640 and 767 the long labels were being set
                across the narrow drawing, and once its rise flattened they ran their
                ends to within 10px of the spurs. Label form follows the variant. */}
            <div className={`pointer-events-none absolute inset-0 ${LABEL}`} aria-hidden="true">
                <span
                    className="absolute -translate-x-1/2 pl-[0.2em] text-zinc-400"
                    style={{ left: `${L.you.left}%`, top: `${L.you.top}%` }}
                >
                    You
                </span>
                <span
                    className="absolute -translate-x-1/2 pl-[0.2em] text-zinc-400"
                    style={{ left: `${L.them.left}%`, top: `${L.them.top}%` }}
                >
                    Them
                </span>
                <span
                    className="hiw-lbl-server absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap pl-[0.2em] text-zinc-400"
                    style={{ left: `${L.server.left}%`, top: `${L.server.top}%` }}
                >
                    Signaling server
                </span>
                <span
                    className="hiw-lbl-direct absolute flex -translate-x-1/2 -translate-y-full items-center gap-2 whitespace-nowrap pl-[0.2em] text-zinc-300"
                    style={{ left: `${L.direct.left}%`, top: `${L.direct.top}%` }}
                >
                    <i className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    Direct
                    <span className="max-md:hidden text-zinc-500">·</span>
                    <span className="max-md:hidden text-zinc-400">No size limit</span>
                </span>
                <span
                    className="hiw-lbl-relay absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap pl-[0.2em] text-zinc-300"
                    style={{ left: `${L.relay.left}%`, top: `${L.relay.top}%` }}
                >
                    <i className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    Relay
                    <span className="max-md:hidden text-zinc-500">·</span>
                    <span className="max-md:hidden text-zinc-400">{RELAY_CAP} per session</span>
                </span>
            </div>
        </div>
    );
}

export function RouteFigure() {
    return (
        <figure className="hiw-fig mt-14 sm:mt-16">
            <Variant g={routeGeometry(ROUTE_WIDE)} className="hidden md:block" />
            {/* max-w-[30rem]: between 640 and 767 the narrow drawing would otherwise
                reach 352px tall in a 720px column, taller than the wide variant is
                at the width just above the breakpoint. */}
            <Variant g={routeGeometry(ROUTE_NARROW)} className="max-w-[30rem] md:hidden" />
            {/* The only description assistive tech gets; it claims exactly what is drawn. */}
            <figcaption className="sr-only">
                A line runs from You to Them. Two thin spurs rise from each device and meet at the
                signaling server above them: it introduces the two devices and carries no file data
                itself. The direct line runs straight across, labeled Direct, and carries no size
                limit. A
                dotted second path dips through a relay and rejoins at Them, labeled Relay, and is
                capped at {RELAY_CAP} per session.
            </figcaption>
        </figure>
    );
}
