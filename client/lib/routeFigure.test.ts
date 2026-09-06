import { describe, it, expect } from 'vitest';
import { ROUTE_HEIGHT, ROUTE_NARROW, ROUTE_WIDE, routeGeometry } from './routeFigure';

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

describe.each([ROUTE_WIDE, ROUTE_NARROW])('routeGeometry(%i)', (width) => {
    const g = routeGeometry(width);

    it('draws the direct line flat across the baseline, device to device', () => {
        expect(g.direct).toBe(`M ${g.you.x} ${g.baselineY} H ${g.them.x}`);
        expect(g.you.y).toBe(g.baselineY);
        expect(g.them.y).toBe(g.baselineY);
    });

    it('stops both spurs short of the server tick, level with it', () => {
        // Flush against the tick the spurs and the tick render as one arch from
        // YOU over to THEM, which reads as the file passing through the server.
        expect(g.serverGap).toBeGreaterThan(0);
        expect(startOf(g.spurLeft)).toEqual(g.you);
        expect(endOf(g.spurLeft)).toEqual({ x: g.serverTick.x1 - g.serverGap, y: g.serverTick.y1 });
        expect(startOf(g.spurRight)).toEqual(g.them);
        expect(endOf(g.spurRight)).toEqual({ x: g.serverTick.x2 + g.serverGap, y: g.serverTick.y2 });
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

    it('keeps every coordinate inside the viewBox', () => {
        for (const d of [g.spurLeft, g.spurRight, g.detour, g.direct]) {
            for (const { x, y } of pointsOf(d)) {
                expect(x).toBeGreaterThanOrEqual(0);
                expect(x).toBeLessThanOrEqual(width);
                expect(y).toBeGreaterThanOrEqual(0);
                expect(y).toBeLessThanOrEqual(ROUTE_HEIGHT);
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
        const pct = (v: number) => (v / ROUTE_HEIGHT) * 100;
        // Server label above its tick, relay label below its own.
        expect(g.labels.server.top).toBeLessThan(pct(g.serverTick.y1));
        expect(g.labels.relay.top).toBeGreaterThan(pct(g.relayTick.y1));
        // Direct label above the baseline, device labels below it.
        expect(g.labels.direct.top).toBeLessThan(pct(g.baselineY));
        expect(g.labels.you.top).toBeGreaterThan(pct(g.baselineY));
        // And clear of the device ticks it sits under.
        expect(g.labels.you.top).toBeGreaterThan(pct(g.deviceTicks[0].y2));
    });

    it('reports the width and height the component feeds to viewBox and aspect-ratio', () => {
        expect(g.width).toBe(width);
        expect(g.height).toBe(ROUTE_HEIGHT);
    });
});
