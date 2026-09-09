// Geometry for the route figure on /how-it-works: one drawing of a transfer.
//
// A baseline runs from YOU to THEM. Two spurs rise from the devices to the
// signaling server's tick at the top. A second, dotted path dips from YOU
// through a relay tick and back up to THEM: a relayed route is a complete
// second path, not a bypass of the middle. Both are built from the same curve
// so the figure reads as one symmetric composition, mirrored across the line.
//
// Pure math, no DOM. The wide (1024) and narrow (360) variants are the same
// function at two widths and share every proportion except the rise, so the
// two drawings cannot drift apart; the test next door pins the endpoints, the
// mirror and the margins.

// These three type the fields of RouteGeometry and are never named by a
// consumer, so they stay unexported.
interface Point {
    x: number;
    y: number;
}

interface Segment {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/** A label anchor as percentages of the figure box, for an absolutely
 *  positioned HTML span over the SVG. */
interface Anchor {
    left: number;
    top: number;
}

export interface RouteGeometry {
    width: number;
    height: number;
    baselineY: number;
    you: Point;
    them: Point;
    deviceTicks: [Segment, Segment];
    serverTick: Segment;
    relayTick: Segment;
    /** SVG path data. The spurs run device to server tick; the detour runs
     *  YOU to relay tick to THEM; the direct line is the baseline. */
    spurLeft: string;
    spurRight: string;
    detour: string;
    direct: string;
    labels: {
        you: Anchor;
        them: Anchor;
        server: Anchor;
        direct: Anchor;
        relay: Anchor;
    };
}

export const ROUTE_WIDE = 1024;
export const ROUTE_NARROW = 360;

// The box is a margin plus a rise, mirrored about the baseline: MARGIN holds
// the labels above the server tick and below the relay tick, and only the rise
// shrinks on a phone. Carrying the wide variant's rise onto the narrow box was
// the whole of the phone problem. The run from a device tick to the server
// tick is 132 units at 360 against 456 at 1024, so the same 96-unit rise
// peaked that curve at 56 degrees against 19 on a desktop, and the figure read
// as a dome rather than a route.
//
// The half unit is load-bearing. It answers the same bug the crispEdges comment
// in globals.css describes, but with geometry rather than with shape-rendering.
// A 1px non-scaling stroke centered on an integer straddles two device rows at
// about half opacity each: measured on the apex here, 57% of one row against
// 98% once it lands on a half unit.
// The server tick is snapped to one row by shape-rendering and the spur that
// now touches it is not, so on an integer the two meet dim and blurry against
// bright and crisp. Centered on 44.5, at the wide variant's canonical scale of
// exactly 1, both land on the same single row.
const MARGIN = 44.5;
const RISE_WIDE = 95.5;
const RISE_NARROW = 43.5;

const TICK = 32;
const DEVICE_TICK = 24;

// Both control points are fractions of the spur's OWN RUN, not of the box
// width. A fraction of the width is a different fraction of the run at each
// size, because the run is 132 units at 360 and 456 at 1024. The old 0.16 and
// 0.19 of width therefore spent 95% of the narrow run reaching the control
// points against 78% of the wide one, crushing the whole vertical transition
// into what was left and manufacturing a flat top with two walls, whatever the
// rise. These two numbers are the wide variant's own fractions, made the rule,
// so the two drawings now sample one curve.
const REACH = 0.36;
const APPROACH = 0.427;

// Label offsets, in viewBox units. The labels are a fixed 11px whatever the
// figure's scale, so the budget is set by the smallest size each variant
// renders at. The device labels are the tight pair on a phone: against a 43.5
// rise, a leading-none 11px label is 13.75 units at the 320px viewport's 0.8
// scale, so 21 leaves about 7px clear of the device tick above it and the same
// of the relay tick below. It is 36 on the wide variant, whose rise is 95.5.
// Without leading-none the label is 20.6 units instead of 13.75, and at the
// 320px viewport no drop fits between the two ticks at all.
const DEVICE_DROP_WIDE = 36;
const DEVICE_DROP_NARROW = 21;
// 20 above and 20 below: the drawing mirrors about the baseline, so its two
// mirrored labels sit the same distance from their ticks.
const TICK_LABEL_GAP = 20;
// The direct label is bottom-anchored this far above the line.
const DIRECT_LABEL_GAP = 11;

const n = (v: number) => String(Math.round(v * 100) / 100);
const cubic = (from: Point, c1: Point, c2: Point, to: Point) =>
    `M ${n(from.x)} ${n(from.y)} C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(to.x)} ${n(to.y)}`;
const pct = (v: number, of: number) => Math.round((v / of) * 1000) / 10;

export function routeGeometry(width: number): RouteGeometry {
    const narrow = width <= 600;
    // The device ticks are inset far enough that the YOU and THEM labels,
    // which are 11px whatever the figure's scale, stay inside the box. The
    // narrow variant needs the larger share: at the 320px viewport it renders
    // at 0.8 scale, where half of "Them" is 18.7px, so a 20-unit inset (16px)
    // put the label 2.5px past the edge and 32 units (25.6px) clears it.
    const pad = narrow ? 32 : 40;
    const rise = narrow ? RISE_NARROW : RISE_WIDE;
    const baselineY = MARGIN + rise;
    const height = 2 * baselineY;
    const serverY = MARGIN;
    const relayY = baselineY + rise;
    const deviceDrop = narrow ? DEVICE_DROP_NARROW : DEVICE_DROP_WIDE;
    const cx = width / 2;

    const you: Point = { x: pad, y: baselineY };
    const them: Point = { x: width - pad, y: baselineY };
    const serverL: Point = { x: cx - TICK / 2, y: serverY };
    const serverR: Point = { x: cx + TICK / 2, y: serverY };
    const relayL: Point = { x: cx - TICK / 2, y: relayY };
    const relayR: Point = { x: cx + TICK / 2, y: relayY };
    // Every curve here covers the same horizontal distance, a device tick to a
    // center tick, so one run drives all four.
    const run = serverL.x - you.x;
    const reach = REACH * run;
    const approach = APPROACH * run;

    // The spurs meet the tick's ends flush. They used to stop 10 units short:
    // arriving with a horizontal tangent they are C1-continuous with the tick,
    // so spur, tick and spur drew one unbroken arch from YOU over to THEM,
    // which says the file travels through the signaling server, and the gap
    // was there to break it. It never read that way. At the wide variant's
    // scale of exactly 1, a 10px gap between collinear, same-weight hairline
    // ends is the grammar of a dashed line: the eye closes it, and the apex
    // read as a stroke that had failed to render. The arch is continuous now,
    // and the distinction is carried by weight, color and order instead. The
    // ice line is the only bright stroke on the page, the spurs are the
    // dimmest, and they thaw from a lit zinc to zinc-700 as the ice line draws
    // across (never from ice: an ice arch would put the file through the
    // server, see the hiw-thaw note in globals.css).
    //
    // The second control point holds the tangent horizontal at the end, so a
    // spur arrives flat and flush against the tick it joins.
    const spurLeft = cubic(you, { x: you.x + reach, y: baselineY }, { x: serverL.x - approach, y: serverY }, serverL);
    const spurRight = cubic(
        them,
        { x: them.x - reach, y: baselineY },
        { x: serverR.x + approach, y: serverY },
        serverR
    );
    const detour =
        cubic(you, { x: you.x + reach, y: baselineY }, { x: relayL.x - approach, y: relayY }, relayL) +
        ` H ${n(relayR.x)}` +
        ` C ${n(relayR.x + approach)} ${n(relayY)} ${n(them.x - reach)} ${n(baselineY)} ${n(them.x)} ${n(baselineY)}`;
    const direct = `M ${n(you.x)} ${n(baselineY)} H ${n(them.x)}`;

    return {
        width,
        height,
        baselineY,
        you,
        them,
        deviceTicks: [
            { x1: you.x, y1: baselineY - DEVICE_TICK / 2, x2: you.x, y2: baselineY + DEVICE_TICK / 2 },
            { x1: them.x, y1: baselineY - DEVICE_TICK / 2, x2: them.x, y2: baselineY + DEVICE_TICK / 2 },
        ],
        serverTick: { x1: serverL.x, y1: serverY, x2: serverR.x, y2: serverY },
        relayTick: { x1: relayL.x, y1: relayY, x2: relayR.x, y2: relayY },
        spurLeft,
        spurRight,
        detour,
        direct,
        labels: {
            you: { left: pct(you.x, width), top: pct(baselineY + deviceDrop, height) },
            them: { left: pct(them.x, width), top: pct(baselineY + deviceDrop, height) },
            server: { left: 50, top: pct(serverY - TICK_LABEL_GAP, height) },
            direct: { left: 50, top: pct(baselineY - DIRECT_LABEL_GAP, height) },
            relay: { left: 50, top: pct(relayY + TICK_LABEL_GAP, height) },
        },
    };
}
