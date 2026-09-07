import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ROUTE_NARROW, ROUTE_WIDE, routeGeometry } from './routeFigure';

// Every point a path visits, control points included. H carries one x at the
// current y, so the numbers cannot simply be read in pairs.
const pointsOf = (d: string) => {
    const out: { x: number; y: number }[] = [];
    let y = 0;
    for (const cmd of d.match(/[MCH][^MCH]*/g)!) {
        const nums = cmd.slice(1).trim().split(/\s+/).map(Number);
        if (cmd[0] === 'H') {
            out.push({ x: nums[0], y });
            continue;
        }
        for (let i = 0; i < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
        y = nums[nums.length - 1];
    }
    return out;
};
const startOf = (d: string) => pointsOf(d)[0];
const endOf = (d: string) => pointsOf(d).at(-1)!;

// The box each variant feeds to viewBox and aspect-ratio. Pinned here rather
// than derived, so a change to the geometry has to state the new box out loud.
const BOX_HEIGHT: Record<number, number> = { [ROUTE_WIDE]: 280, [ROUTE_NARROW]: 176 };

describe.each([ROUTE_WIDE, ROUTE_NARROW])('routeGeometry(%i)', (width) => {
    const g = routeGeometry(width);

    it('draws the direct line flat across the baseline, device to device', () => {
        expect(g.direct).toBe(`M ${g.you.x} ${g.baselineY} H ${g.them.x}`);
        expect(g.you.y).toBe(g.baselineY);
        expect(g.them.y).toBe(g.baselineY);
    });

    it('lands both spurs on the ends of the server tick', () => {
        // The spurs used to stop 10 units short of the tick. Flush against it
        // they are C1-continuous with it, so spur, tick and spur read as one
        // arch from YOU over to THEM, and the gap was there to break that. It
        // never worked: a small gap between collinear, same-weight hairline
        // ends is the grammar of a dashed line, so the eye closed it and the
        // apex read as a stroke that had failed to render. Anything that wants
        // the "does not pass through" reading back needs a device the eye does
        // not close, not a wider gap.
        expect(startOf(g.spurLeft)).toEqual(g.you);
        expect(endOf(g.spurLeft)).toEqual({ x: g.serverTick.x1, y: g.serverTick.y1 });
        expect(startOf(g.spurRight)).toEqual(g.them);
        expect(endOf(g.spurRight)).toEqual({ x: g.serverTick.x2, y: g.serverTick.y2 });
        // Flush is half of it. The second control point has to sit at the tick's
        // own y as well, or the spur arrives at an angle and puts a visible
        // corner at the exact apex this file exists to keep clean. Endpoints
        // alone do not catch that.
        expect(pointsOf(g.spurLeft)[2].y).toBe(g.serverTick.y1);
        expect(pointsOf(g.spurRight)[2].y).toBe(g.serverTick.y2);
    });

    it('runs the detour as a complete second path from you to them through the relay tick', () => {
        expect(startOf(g.detour)).toEqual(g.you);
        expect(endOf(g.detour)).toEqual(g.them);
        expect(g.detour).toContain(`${g.relayTick.x1} ${g.relayTick.y1} H ${g.relayTick.x2}`);
    });

    it('mirrors the server and relay ticks across the baseline', () => {
        expect(g.serverTick.x1).toBe(g.relayTick.x1);
        expect(g.serverTick.x2).toBe(g.relayTick.x2);
        expect(g.baselineY - g.serverTick.y1).toBe(g.relayTick.y1 - g.baselineY);
        expect(g.serverTick.x1 + g.serverTick.x2).toBe(width);
    });

    it('mirrors the label margin above the server tick and below the relay tick', () => {
        // Within one variant this is algebra, since height is twice the
        // baseline; it is here to catch a box that stops being symmetric. The
        // margin that actually matters is pinned across variants below.
        expect(g.serverTick.y1).toBe(g.height - g.relayTick.y1);
    });

    it('puts the apex and the nadir on a half unit', () => {
        // A 1px non-scaling stroke centered on an integer straddles two device
        // rows at half opacity, and the tick (shape-rendering: crispEdges)
        // snaps to one row while the spur touching it does not. On a half unit
        // both land on the same row at the wide variant's scale of exactly 1.
        expect(g.serverTick.y1 % 1).toBe(0.5);
        expect(g.relayTick.y1 % 1).toBe(0.5);
    });

    it('keeps every coordinate inside the viewBox', () => {
        for (const d of [g.spurLeft, g.spurRight, g.detour, g.direct]) {
            for (const { x, y } of pointsOf(d)) {
                expect(x).toBeGreaterThanOrEqual(0);
                expect(x).toBeLessThanOrEqual(width);
                expect(y).toBeGreaterThanOrEqual(0);
                expect(y).toBeLessThanOrEqual(g.height);
            }
        }
        for (const a of Object.values(g.labels)) {
            expect(a.left).toBeGreaterThanOrEqual(0);
            expect(a.left).toBeLessThanOrEqual(100);
            expect(a.top).toBeGreaterThanOrEqual(0);
            expect(a.top).toBeLessThanOrEqual(100);
        }
    });

    it('centers the server, direct and relay labels', () => {
        expect(g.labels.server.left).toBe(50);
        expect(g.labels.direct.left).toBe(50);
        expect(g.labels.relay.left).toBe(50);
    });

    // Without these the anchors are free to drift anywhere inside 0..100 and
    // still pass: a label could sit on the wrong side of the thing it names.
    it('anchors the device labels on their own ticks', () => {
        const pct = (v: number, of: number) => Math.round((v / of) * 1000) / 10;
        expect(g.labels.you.left).toBe(pct(g.you.x, width));
        expect(g.labels.them.left).toBe(pct(g.them.x, width));
        expect(g.labels.you.top).toBe(g.labels.them.top);
    });

    it('puts each figure label on the correct side of what it names', () => {
        // Against g.height, not a module constant: with a per-variant box, a
        // fixed denominator here would compare the narrow variant's anchors to
        // the wide variant's box and pass on the wrong numbers.
        const pct = (v: number) => (v / g.height) * 100;
        // Server label above its tick, relay label below its own.
        expect(g.labels.server.top).toBeLessThan(pct(g.serverTick.y1));
        expect(g.labels.relay.top).toBeGreaterThan(pct(g.relayTick.y1));
        // Direct label above the baseline, device labels below it.
        expect(g.labels.direct.top).toBeLessThan(pct(g.baselineY));
        expect(g.labels.you.top).toBeGreaterThan(pct(g.baselineY));
        // And clear of the device ticks it sits under.
        expect(g.labels.you.top).toBeGreaterThan(pct(g.deviceTicks[0].y2));
        // And its anchor is above the relay tick. This pins the ORDER only: the
        // label's own 11px box is not geometry and cannot be seen from here, so
        // the clearance underneath it is measured in the browser, not asserted.
        expect(g.labels.you.top).toBeLessThan(pct(g.relayTick.y1));
    });

    it('reports the width and height the component feeds to viewBox and aspect-ratio', () => {
        expect(g.width).toBe(width);
        expect(g.height).toBe(BOX_HEIGHT[width]);
        expect(g.height).toBe(2 * g.baselineY);
    });
});

// The phone variant used to carry the wide variant's 96-unit rise across a run
// a third as long, and to place its control points by a fraction of the box
// width rather than of that run. Together those made the phone a different
// drawing: a 56 degree dome with a flat top and two walls, against 19 degrees
// on a desktop. These two guards are what stop it drifting back.
describe('the phone variant is the desktop drawing, not a steeper one', () => {
    const wide = routeGeometry(ROUTE_WIDE);
    const narrow = routeGeometry(ROUTE_NARROW);
    // Rise over run for the spur: the baseline to the server tick, and the
    // device tick across to it.
    const steepness = (g: typeof wide) => (g.baselineY - g.serverTick.y1) / (g.serverTick.x1 - g.you.x);

    it('keeps the narrow spur within 1.7x the wide one for steepness', () => {
        // 1.573 as shipped. The bound is not a target: it is the point past
        // which the phone stops being a smaller version of the same picture.
        // Before this change the ratio was 3.45.
        expect(steepness(narrow) / steepness(wide)).toBeLessThan(1.7);
    });

    it('holds the label margin at the same number on both variants', () => {
        // This is the guard the per-variant check above cannot be. The phone
        // box lost 104 units of height; what must NOT have come out of it is
        // the room reserved for labels that do not scale with the drawing. A
        // leading-none 11px label is 13.75 viewBox units at the 320px
        // viewport's 0.8 scale, and it is centred 20 units off the tick, so the
        // margin has to clear roughly 27 for the label to sit inside the box.
        expect(narrow.serverTick.y1).toBe(wide.serverTick.y1);
        expect(narrow.serverTick.y1).toBeGreaterThan(27);
    });

    it('places both control points at the same fraction of each spur run', () => {
        const fractions = (g: typeof wide, path: 'spurLeft' | 'spurRight') => {
            const [p0, p1, p2, p3] = pointsOf(g[path]);
            const run = p3.x - p0.x;
            return [(p1.x - p0.x) / run, (p3.x - p2.x) / run];
        };
        for (const path of ['spurLeft', 'spurRight'] as const) {
            const [wideReach, wideApproach] = fractions(wide, path);
            const [narrowReach, narrowApproach] = fractions(narrow, path);
            expect(narrowReach, path).toBeCloseTo(wideReach, 3);
            expect(narrowApproach, path).toBeCloseTo(wideApproach, 3);
        }
    });
});

// The figure's draw-in is a stroke dash, and Chromium lays a dash out in
// unscaled user units while the path renders scaled, so the ink only covers
// dasharray/scale of the path. At the pathLength-normalized 1000 the ice line
// stopped 98.8px short of THEM wherever the narrow variant rendered above
// scale 1, and the arrival ring floated unattached. Nothing caught it: every
// Playwright context that opens this page forces reduced motion, where no dash
// exists at all. This is the guard for that.
describe('the draw-in dash survives the figure being scaled up', () => {
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    const component = readFileSync(new URL('../components/how-it-works/RouteFigure.tsx', import.meta.url), 'utf8');
    // The widest each variant can ever render, in CSS pixels. They are pixels on
    // purpose: as rem they grew with the reader's font size while the dash that
    // draws them did not, so at a 20px root the narrow line stopped 19.7px short
    // of THEM and at 24px it stopped 118.4px short, with the arrival ring left
    // floating. The two assertions below are what make these numbers facts.
    const NARROW_MAX_PX = 480;
    const WIDE_MAX_PX = 1024;
    const maxScale = Math.max(NARROW_MAX_PX / ROUTE_NARROW, WIDE_MAX_PX / ROUTE_WIDE);

    it('caps both variants in pixels, so the scale below is measured and not assumed', () => {
        expect(component).toContain('max-w-[' + NARROW_MAX_PX + 'px]');
        expect(component).toContain('max-w-[' + WIDE_MAX_PX + 'px]');
        // A rem cap is the bug: 30rem is 480px only while the root font is 16.
        expect(component).not.toMatch(/max-w-\[[\d.]+rem\]/);
    });

    it('swaps the variants on the same pixel it caps them at', () => {
        // If the swap stayed on md (48rem) while the caps were pixels, a large
        // font would keep the phone drawing on show up to a 1151px viewport, and
        // hand the wide drawing the short labels that belong to the narrow one.
        for (const cls of ['min-[768px]:block', 'min-[768px]:hidden', 'max-[767px]:hidden']) {
            expect(component, cls).toContain(cls);
        }
        for (const cls of ['md:block', 'md:hidden']) {
            expect(component, cls).not.toContain(cls);
        }
    });

    it('sets a dasharray with headroom for the largest scale the figure reaches', () => {
        const values = [...css.matchAll(/\.hiw-(?:spur|direct)\s*\{[^}]*?stroke-dasharray:\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(values.length, 'both dash-drawn paths declare a dasharray').toBe(2);
        for (const v of values) expect(v).toBeGreaterThanOrEqual(1000 * maxScale);
    });

    it('starts the keyframe at the same value it dashes with', () => {
        const dash = Number(css.match(/\.hiw-direct\s*\{[^}]*?stroke-dasharray:\s*(\d+)/)![1]);
        const from = Number(css.match(/@keyframes hiw-draw\s*\{\s*from\s*\{\s*stroke-dashoffset:\s*(\d+)/)![1]);
        expect(from).toBe(dash);
    });
});
