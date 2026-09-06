// Geometry for the route figure on /how-it-works: one drawing of a transfer.
//
// A baseline runs from YOU to THEM. Two spurs rise from the devices to a
// short signaling-server tick and END there (the server introduces, then
// leaves). A second, dotted path dips from YOU through a relay tick and back
// up to THEM: a relayed route is a complete second path, not a bypass of the
// middle. Both are built from the same curve so the figure reads as one
// symmetric composition, mirrored across the line.
//
// Pure math, no DOM. The wide (1024) and narrow (360) variants are the same
// function at two widths, so the two drawings cannot drift apart; the test
// next door pins the endpoints.

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
    /** How far short of the server tick each spur stops, in viewBox units. */
    serverGap: number;
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

export const ROUTE_HEIGHT = 280;
export const ROUTE_WIDE = 1024;
export const ROUTE_NARROW = 360;

const BASELINE_Y = 140;
const SERVER_Y = 44;
const RELAY_Y = 236;
const TICK = 32;
const DEVICE_TICK = 24;
// The spurs stop short of the server tick instead of joining it. Rendered
// flush, the two spurs and the tick are one C1-continuous arch from YOU over
// to THEM, which draws the opposite of what the page says: it looks like the
// file travels through the server. The gap makes the eye read line, stop,
// mark, stop, line, so the spurs visibly END at the server.
const SERVER_GAP = 10;

const n = (v: number) => String(Math.round(v * 100) / 100);
const cubic = (from: Point, c1: Point, c2: Point, to: Point) =>
    `M ${n(from.x)} ${n(from.y)} C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(to.x)} ${n(to.y)}`;
const pct = (v: number, of: number) => Math.round((v / of) * 1000) / 10;

export function routeGeometry(width: number): RouteGeometry {
    // The device ticks are inset far enough that the YOU and THEM labels,
    // which are 11px whatever the figure's scale, stay inside the box. The
    // narrow variant needs the larger share: at the 320px viewport it renders
    // at 0.8 scale, where half of "Them" is 18.7px, so a 20-unit inset (16px)
    // put the label 2.5px past the edge and 32 units (25.6px) clears it.
    // The curves' reach scales with the width, so the spurs leave the baseline
    // tangent and arrive at the server tick flat at both sizes.
    const pad = width > 600 ? 40 : 32;
    const reach = width * 0.16;
    const approach = width * 0.19;
    const cx = width / 2;

    const you: Point = { x: pad, y: BASELINE_Y };
    const them: Point = { x: width - pad, y: BASELINE_Y };
    const serverL: Point = { x: cx - TICK / 2, y: SERVER_Y };
    const serverR: Point = { x: cx + TICK / 2, y: SERVER_Y };
    const relayL: Point = { x: cx - TICK / 2, y: RELAY_Y };
    const relayR: Point = { x: cx + TICK / 2, y: RELAY_Y };

    // The second control point keeps the tangent horizontal at the end, so a
    // spur still arrives flat and parallel to the tick it stops beside.
    const spurLeft = cubic(
        you,
        { x: you.x + reach, y: BASELINE_Y },
        { x: serverL.x - approach, y: SERVER_Y },
        { x: serverL.x - SERVER_GAP, y: SERVER_Y }
    );
    const spurRight = cubic(
        them,
        { x: them.x - reach, y: BASELINE_Y },
        { x: serverR.x + approach, y: SERVER_Y },
        { x: serverR.x + SERVER_GAP, y: SERVER_Y }
    );
    const detour =
        cubic(you, { x: you.x + reach, y: BASELINE_Y }, { x: relayL.x - approach, y: RELAY_Y }, relayL) +
        ` H ${n(relayR.x)}` +
        ` C ${n(relayR.x + approach)} ${n(RELAY_Y)} ${n(them.x - reach)} ${n(BASELINE_Y)} ${n(them.x)} ${n(BASELINE_Y)}`;
    const direct = `M ${n(you.x)} ${n(BASELINE_Y)} H ${n(them.x)}`;

    return {
        width,
        height: ROUTE_HEIGHT,
        baselineY: BASELINE_Y,
        you,
        them,
        deviceTicks: [
            { x1: you.x, y1: BASELINE_Y - DEVICE_TICK / 2, x2: you.x, y2: BASELINE_Y + DEVICE_TICK / 2 },
            { x1: them.x, y1: BASELINE_Y - DEVICE_TICK / 2, x2: them.x, y2: BASELINE_Y + DEVICE_TICK / 2 },
        ],
        serverTick: { x1: serverL.x, y1: SERVER_Y, x2: serverR.x, y2: SERVER_Y },
        relayTick: { x1: relayL.x, y1: RELAY_Y, x2: relayR.x, y2: RELAY_Y },
        spurLeft,
        spurRight,
        detour,
        direct,
        serverGap: SERVER_GAP,
        labels: {
            you: { left: pct(you.x, width), top: pct(BASELINE_Y + 36, ROUTE_HEIGHT) },
            them: { left: pct(them.x, width), top: pct(BASELINE_Y + 36, ROUTE_HEIGHT) },
            server: { left: 50, top: pct(SERVER_Y - 20, ROUTE_HEIGHT) },
            // Bottom-anchored 11px above the line.
            direct: { left: 50, top: pct(BASELINE_Y - 11, ROUTE_HEIGHT) },
            relay: { left: 50, top: pct(RELAY_Y + 22, ROUTE_HEIGHT) },
        },
    };
}
