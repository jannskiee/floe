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

    it('ends both spurs on the server tick and nowhere else', () => {
        expect(startOf(g.spurLeft)).toEqual(g.you);
        expect(endOf(g.spurLeft)).toEqual({ x: g.serverTick.x1, y: g.serverTick.y1 });
        expect(startOf(g.spurRight)).toEqual(g.them);
        expect(endOf(g.spurRight)).toEqual({ x: g.serverTick.x2, y: g.serverTick.y2 });
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
});
