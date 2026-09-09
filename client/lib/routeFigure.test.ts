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

    it('gates the drawing and its labels on one and the same pixel', () => {
        // Tailwind compiles max-[N] to `not (min-width: N)`, so max-[N] and
        // min-[N] are exact complements only when N is the SAME number. Written
        // as max-[767px] against min-[768px] they leave a one-pixel band at 767
        // where the phone drawing is still on show wearing the wide drawing's
        // long labels, which is the crowding this figure already fixed once.
        // Asserting the shared number is the invariant; asserting three string
        // literals was what let the off-by-one through.
        const SWAP = 768;
        for (const cls of ['min-[' + SWAP + 'px]:block', 'min-[' + SWAP + 'px]:hidden', 'max-[' + SWAP + 'px]:hidden']) {
            expect(component, cls).toContain(cls);
        }
        const gates = [...component.matchAll(/(?:min|max)-\[(\d+)px\]:/g)].map((m) => Number(m[1]));
        expect(gates.length, 'every variant and label gate is pixel-based').toBeGreaterThanOrEqual(3);
        expect([...new Set(gates)], 'all gates share one breakpoint').toEqual([SWAP]);
        for (const cls of ['md:block', 'md:hidden']) {
            expect(component, cls).not.toContain(cls);
        }
    });

    it('puts each pixel cap on the variant it belongs to', () => {
        // Swapping the two caps between the variants passed every earlier
        // assertion while reproducing the exact bug this block exists to stop.
        const line = (v: string) =>
            component.split(/\r?\n/).find((l) => l.includes('routeGeometry(ROUTE_' + v + ')'));
        expect(line('WIDE'), 'wide variant line').toContain('max-w-[' + WIDE_MAX_PX + 'px]');
        expect(line('NARROW'), 'narrow variant line').toContain('max-w-[' + NARROW_MAX_PX + 'px]');
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

// The light that crosses the direct line once on paint, and the hover loop that
// replays it. The specs that look at this figure force reduced motion
// (hydration.spec.ts opens the route without looking at it), and
// e2e/route-figure-light.spec.ts is the one that watches the motion, so the CSS
// is also pinned here as text, the way the dash headroom above is. Each block
// guards a decision the .hiw-comet comment in globals.css records; the numbers
// are read from the file, not repeated here.
describe('the light on the direct line', () => {
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    const component = readFileSync(new URL('../components/how-it-works/RouteFigure.tsx', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../app/how-it-works/page.tsx', import.meta.url), 'utf8');
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The body of the FIRST rule block with exactly this selector.
    const block = (selector: string) => {
        const m = css.match(new RegExp('(?:^|\\n)\\s*' + escape(selector) + '\\s*\\{([^}]*)\\}'));
        expect(m, selector).not.toBeNull();
        return m![1];
    };
    // The body of a media block: from its query to the closing brace at column 0.
    const media = (query: string) => {
        const m = css.match(new RegExp('\\n@media ' + escape(query) + '\\s*\\{([\\s\\S]*?)\\n\\}'));
        expect(m, query).not.toBeNull();
        return m![1];
    };
    const HOVER_QUERY = '(prefers-reduced-motion: no-preference) and (hover: hover) and (pointer: fine)';

    it('draws the light as three dashed copies of the direct line, under the ring, with no ids', () => {
        const light = component.indexOf('className="hiw-light"');
        const ring = component.indexOf('className="hiw-ring"');
        expect(light).toBeGreaterThan(-1);
        // Under the ring, or its zinc-950 fill could not swallow the head at THEM.
        expect(light).toBeLessThan(ring);
        for (const layer of ['halo', 'tail', 'core']) {
            expect(component).toContain(`className="hiw-comet hiw-comet-${layer}" pathLength={1000} d={g.direct}`);
        }
        expect(component).toContain('className="hiw-ring-halo"');
        // Both variants share the DOM and url(#id) resolves to the first, so
        // nothing in the figure may carry an id.
        expect(component).not.toMatch(/\bid=/);
    });

    it('stays a Server Component: no client directive, no handlers, no hooks', () => {
        for (const src of [component, page]) {
            expect(src).not.toMatch(/['"]use client['"]/);
            expect(src).not.toMatch(/\bon[A-Z]\w+=\{/);
            expect(src).not.toMatch(/\buse(?:State|Effect|Ref|Id|LayoutEffect)\(/);
        }
    });

    it('lets the comet dashes scale with the path, so the head arrives at every scale', () => {
        // Under non-scaling-stroke every engine lays dashes out in screen space
        // and a moving dash stops short of THEM above scale 1.
        expect(block('.hiw-fig .hiw-comet')).toMatch(/vector-effect:\s*none/);
    });

    it('keeps the caps butt, so the zero-length lead dash never renders as a dot', () => {
        expect(block('.hiw-fig .hiw-comet')).toMatch(/stroke-linecap:\s*butt/);
        // The figure's shared base rule must not hand the comet a cap either.
        const shared = css.match(/\.hiw-fig path,\s*\.hiw-fig line,\s*\.hiw-fig circle\s*\{([^}]*)\}/);
        expect(shared, 'the shared base rule').not.toBeNull();
        expect(shared![1]).not.toMatch(/stroke-linecap/);
    });

    it('ends every layer dash at one pattern position and sweeps that pattern clear of both ends', () => {
        const rest = Number(block('.hiw-fig .hiw-comet').match(/stroke-dashoffset:\s*(-?\d+)/)![1]);
        const ends = new Set<number>();
        for (const layer of ['halo', 'tail', 'core']) {
            const arr = block(`.hiw-fig .hiw-comet-${layer}`)
                .match(/stroke-dasharray:\s*([\d. ]+)/)![1]
                .trim()
                .split(/\s+/)
                .map(Number);
            expect(arr.length % 2, `${layer} pattern is dash/gap pairs`).toBe(0);
            const gap = arr.at(-1)!;
            const end = arr.slice(0, -1).reduce((a, b) => a + b, 0);
            ends.add(end);
            // The next copy of the pattern must stay off the path for the whole
            // sweep, whose offset never drops below -(1000 + 4).
            expect(gap, `${layer} gap`).toBeGreaterThanOrEqual(1004);
        }
        expect(ends.size, 'all three heads travel together').toBe(1);
        const P = [...ends][0];
        // Parked one pattern length before YOU, plus 4 of slack so the head's
        // butt end clears the device tick (see the .hiw-comet note).
        expect(rest).toBe(P + 4);
        const once = css.match(
            /@keyframes hiw-comet-once\s*\{\s*from\s*\{\s*stroke-dashoffset:\s*(-?\d+)[^}]*\}\s*to\s*\{\s*stroke-dashoffset:\s*(-?\d+)/
        )!;
        expect(Number(once[1])).toBe(rest);
        expect(Number(once[2])).toBe(-1004);
        const loop = css.match(
            /@keyframes hiw-comet-loop\s*\{\s*0%\s*\{\s*stroke-dashoffset:\s*(-?\d+)[^}]*\}\s*([\d.]+)%,\s*100%\s*\{\s*stroke-dashoffset:\s*(-?\d+)/
        )!;
        expect(Number(loop[1])).toBe(rest);
        expect(Number(loop[3])).toBe(-1004);

        // The bloom is timed off the head's landing, which the sweep fixes at
        // (rest + 1000 - P) / (rest + 1004) of the travel; the durations are read
        // from the shorthands so a retuned sweep drags the bloom with it or fails.
        const arrival = (rest + 1000 - P) / (rest + 1004);
        const base = media('(prefers-reduced-motion: no-preference)');
        const onceMs = Number(base.match(/hiw-comet-once (\d+)ms/)![1]);
        const haloOnceMs = Number(base.match(/hiw-ring-halo-once (\d+)ms/)![1]);
        const loopMs = Number(media(HOVER_QUERY).match(/hiw-comet-loop (\d+)ms/)![1]);
        expect(Math.abs((Number(loop[2]) / 100) * loopMs - onceMs), 'the loop travels for the once duration').toBeLessThan(1);
        const peak = (name: string) => {
            const body = css.match(new RegExp('@keyframes ' + name + '\\s*\\{([\\s\\S]*?)\\n\\}'))![1];
            const stops = [...body.matchAll(/([\d.]+)%\s*\{\s*stroke-opacity:\s*([\d.]+)/g)].map((m) => ({ at: Number(m[1]), v: Number(m[2]) }));
            return stops.reduce((a, s) => (s.v > a.v ? s : a)).at;
        };
        expect(Math.abs(peak('hiw-ring-halo-once') - (arrival * onceMs * 100) / haloOnceMs)).toBeLessThan(0.5);
        expect(Math.abs(peak('hiw-ring-halo-loop') - (arrival * onceMs * 100) / loopMs)).toBeLessThan(0.5);
    });

    it('keeps the base rules as the finished drawing: no animation outside the motion blocks', () => {
        for (const sel of ['.hiw-fig .hiw-comet', '.hiw-fig .hiw-comet-core', '.hiw-fig .hiw-comet-tail', '.hiw-fig .hiw-comet-halo', '.hiw-fig circle.hiw-ring-halo']) {
            expect(block(sel), sel).not.toMatch(/animation/);
        }
        expect(block('.hiw-fig circle.hiw-ring-halo')).toMatch(/stroke-opacity:\s*0\b/);
        // Every animation that names the light lives inside one of the two
        // motion queries, wherever in the file it was written: a stray base rule
        // appended later would animate under reduced motion and block() alone,
        // which sees only the first rule per selector, would never notice.
        const spans = ['(prefers-reduced-motion: no-preference)', HOVER_QUERY].map((q) => {
            const m = css.match(new RegExp('\\n@media ' + escape(q) + '\\s*\\{[\\s\\S]*?\\n\\}'))!;
            return [m.index!, m.index! + m[0].length];
        });
        for (const m of css.matchAll(/animation:\s*[^;]*hiw-(?:comet|ring-halo|arm)[^;]*;/g)) {
            expect(spans.some(([a, b]) => m.index! > a && m.index! < b), m[0]).toBe(true);
        }
        // Unlayered, like the rest of the figure's CSS, so the Tailwind cascade
        // can never outrank the reduced-motion gate.
        expect(css.lastIndexOf('@layer')).toBeLessThan(css.indexOf('.hiw-fig svg'));
    });

    it('plays the crossing once after the map is complete, from the reduced-motion gate', () => {
        const body = media('(prefers-reduced-motion: no-preference)');
        const once = body.match(/\.hiw-comet\s*\{\s*animation:\s*([^;]+);/)![1].replace(/\s+/g, ' ');
        expect(once).toMatch(/^hiw-comet-once \d+ms linear (\d+)ms backwards$/);
        const start = Number(once.match(/linear (\d+)ms/)![1]);
        // After the last beat of the draw-in (the detour's fade, 1850 + 600).
        const detour = body.match(/\.hiw-detour,\s*\.hiw-relay-tick\s*\{\s*animation:\s*hiw-fade (\d+)ms ease (\d+)ms/)!;
        expect(start).toBeGreaterThanOrEqual(Number(detour[1]) + Number(detour[2]));
        expect(body).toMatch(/\.hiw-fig circle\.hiw-ring-halo\s*\{\s*animation:\s*hiw-ring-halo-once/);
    });

    it('gates the hover loop on motion, hover and a fine pointer, in one query', () => {
        const body = media(HOVER_QUERY);
        expect(body).toMatch(/\.hiw-box:hover \.hiw-comet\s*\{/);
        expect(body).toMatch(/\.hiw-box:hover circle\.hiw-ring-halo\s*\{/);
        // No hover rule anywhere else in the file (a selector starts its line;
        // the comments that mention the hover do not count).
        const rules = (s: string) => (s.match(/^\s*\.hiw-box:hover/gm) ?? []).length;
        expect(rules(css)).toBe(rules(body));
        // And the hover block touches only the light and the box's own arming:
        // never the draw-in's classes, whose animation shorthand it would
        // otherwise replace.
        const selectors = [...body.matchAll(/^\s*([^{}\n]+?)\s*\{/gm)].map((m) => m[1].trim());
        expect(selectors.length).toBeGreaterThanOrEqual(3);
        for (const s of selectors) expect(s).toMatch(/^(?:\.hiw-box|\.hiw-box:hover (?:\.hiw-comet|circle\.hiw-ring-halo))$/);
    });

    it('ignores the pointer until the finale has played', () => {
        // Two animations of one property on one element resolve to the later
        // name, so a loop started during the draw-in would own the light and
        // mask the finale; the box therefore ignores the pointer until the
        // crossing has ended.
        const hover = media(HOVER_QUERY);
        const arm = hover.match(/\.hiw-box\s*\{\s*animation:\s*hiw-arm 1ms linear (\d+)ms backwards;/)!;
        expect(arm, 'the box arms itself with hiw-arm').not.toBeNull();
        const base = media('(prefers-reduced-motion: no-preference)');
        const once = base.match(/hiw-comet-once (\d+)ms linear (\d+)ms/)!;
        expect(Number(arm[1])).toBeGreaterThanOrEqual(Number(once[1]) + Number(once[2]));
        const frames = css.match(/@keyframes hiw-arm\s*\{([\s\S]*?)\n\}/)![1];
        expect(frames).toMatch(/from\s*\{\s*pointer-events:\s*none/);
        expect(frames).toMatch(/to\s*\{\s*pointer-events:\s*auto/);
    });

    it('appends the loop to the once-only list instead of replacing it', () => {
        // css-animations matches animations by name across a list change, so the
        // finished once-only entry survives hover-in and hover-out untouched and
        // can never replay with its delay when the pointer leaves.
        const base = media('(prefers-reduced-motion: no-preference)');
        const hover = media(HOVER_QUERY);
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        const baseComet = norm(base.match(/\.hiw-comet\s*\{\s*animation:\s*([^;]+);/)![1]);
        const hoverComet = norm(hover.match(/\.hiw-box:hover \.hiw-comet\s*\{\s*animation:\s*([^;]+);/)![1]);
        expect(hoverComet.startsWith(baseComet + ', hiw-comet-loop ')).toBe(true);
        expect(hoverComet).toMatch(/hiw-comet-loop \d+ms linear \d+ms infinite$/);
        const baseHalo = norm(base.match(/circle\.hiw-ring-halo\s*\{\s*animation:\s*([^;]+);/)![1]);
        const hoverHalo = norm(hover.match(/\.hiw-box:hover circle\.hiw-ring-halo\s*\{\s*animation:\s*([^;]+);/)![1]);
        expect(hoverHalo.startsWith(baseHalo + ', hiw-ring-halo-loop ')).toBe(true);
    });

    it('animates only stroke-dashoffset, stroke-opacity and pointer-events, and never fills forwards', () => {
        // Not opacity: an opacity animation is composited even on an SVG child,
        // and its layer dragged the ring and the 11px labels into an overlap
        // layer that grayed the labels. Not stroke: a literal color in a
        // keyframe overrides the user's colors under forced-colors.
        for (const name of ['hiw-arm', 'hiw-comet-once', 'hiw-comet-loop', 'hiw-ring-halo-once', 'hiw-ring-halo-loop']) {
            const body = css.match(new RegExp('@keyframes ' + name + '\\s*\\{([\\s\\S]*?)\\n\\}'))!;
            expect(body, name).not.toBeNull();
            const props = [...body[1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
            expect(props.length, name).toBeGreaterThan(0);
            for (const p of props) expect(['stroke-dashoffset', 'stroke-opacity', 'pointer-events'], `${name} animates ${p}`).toContain(p);
        }
        // `both` pins a composited layer and grays the labels; `forwards` would
        // hold the light past its window.
        for (const m of css.matchAll(/animation:\s*([^;]*hiw-(?:comet|ring-halo|arm)[^;]*);/g)) {
            expect(m[1]).not.toMatch(/\b(?:both|forwards)\b/);
        }
    });

    it('maps the light to the system palette under forced colors', () => {
        const body = media('(forced-colors: active)');
        expect(body).toMatch(/\.hiw-fig \.hiw-comet\s*\{\s*stroke:\s*Highlight/);
        expect(body).toMatch(/\.hiw-fig circle\.hiw-ring-halo\s*\{\s*stroke:\s*CanvasText/);
        expect(body).toMatch(/\.hiw-fig circle\.hiw-ring\s*\{\s*fill:\s*Canvas/);
        // The core's own color is beaten only by source order at equal
        // specificity, so the forced rule must come later and the core must not
        // gain a type selector.
        expect(css.indexOf('.hiw-fig .hiw-comet-core {')).toBeLessThan(css.indexOf('stroke: Highlight'));
        expect(css).not.toMatch(/path\.hiw-comet/);
    });

    it('keeps the caption true of what is drawn', () => {
        expect(component).toMatch(/then steps aside,\s*carrying no file data itself/);
        expect(component).toMatch(/carries no size limit/);
        expect(component).toMatch(/capped at \{RELAY_CAP\} per session/);
    });
});
