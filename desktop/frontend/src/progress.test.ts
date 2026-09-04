import {describe, expect, it} from 'vitest';
import {fmtEta, fmtSpeed, track, type Marker, type Prog} from './progress';

// The numbers pinned here are cross-surface contracts: client/lib/transferUtils.ts
// and cli/engine/transfer/format.go must produce the same strings. Where a case
// records a bug that shipped, the comment says which.

describe('fmtSpeed', () => {
    it('keeps one decimal below a megabyte', () => {
        // Shipped as "0 KB/s" while bytes were moving, because the KB branch
        // used toFixed(0). That is the whole reason this function moved.
        expect(fmtSpeed(500)).toBe('0.5 KB/s');
        expect(fmtSpeed(524288)).toBe('512.0 KB/s');
    });

    it('switches to MB/s at exactly one mebibyte', () => {
        expect(fmtSpeed(1024 * 1024 - 1)).toBe('1024.0 KB/s');
        expect(fmtSpeed(1024 * 1024)).toBe('1.0 MB/s');
    });

    it('renders nothing rather than a wrong number', () => {
        for (const bad of [0, -1, NaN, Infinity]) expect(fmtSpeed(bad)).toBe('');
    });
});

describe('fmtEta', () => {
    it('rolls over into hours', () => {
        // Without the hours branch this read "90m 0s" where the web and the
        // CLI both said "1h 30m".
        expect(fmtEta(5400)).toBe('1h 30m');
        expect(fmtEta(10000)).toBe('2h 46m');
    });

    it('can never print sixty seconds', () => {
        // Rounding before the split is what fixes this: Math.ceil(119.5) is
        // 120, so the minutes branch sees a whole number of minutes.
        expect(fmtEta(119.5)).toBe('2m 0s');
        expect(fmtEta(59.9)).toBe('1m 0s');
        for (let s = 0; s < 7200; s += 0.5) expect(fmtEta(s)).not.toMatch(/\b60s$/);
    });

    it('uses the boundaries the CLI uses', () => {
        expect(fmtEta(0)).toBe('0s');
        expect(fmtEta(59)).toBe('59s');
        expect(fmtEta(60)).toBe('1m 0s');
        expect(fmtEta(3599)).toBe('59m 59s');
        expect(fmtEta(3600)).toBe('1h 0m');
    });

    it('renders nothing rather than a wrong number', () => {
        for (const bad of [-1, NaN, Infinity]) expect(fmtEta(bad)).toBe('');
    });
});

const prog = (over: Partial<Prog> = {}): Prog => ({
    fileName: 'report.pdf',
    fileIndex: 1,
    fileCount: 1,
    fileBytes: 0,
    fileSize: 1000,
    totalBytes: 0,
    grandTotal: 0,
    savedName: '',
    ...over,
});

describe('track', () => {
    it('seeds the marker on the first event and measures against it after', () => {
        const ref: {current: Marker} = {current: null};
        let t = 1_000_000;

        const first = track(ref, prog({fileBytes: 0}), () => t);
        expect(ref.current).toEqual({t: 1_000_000, bytes: 0});
        // No elapsed time yet, so no speed to report.
        expect(first.label).not.toMatch(/KB\/s|MB\/s/);

        t += 2000; // two seconds later, 1024 bytes moved
        const second = track(ref, prog({fileBytes: 1024}), () => t);
        expect(second.pct).toBe(102 > 100 ? 100 : Math.round((1024 / 1000) * 100));
        // The marker is NOT re-seeded; speed is averaged since the start.
        expect(ref.current).toEqual({t: 1_000_000, bytes: 0});
        expect(second.label).toContain('0.5 KB/s');
    });

    it('prefers the batch totals when a grand total is announced', () => {
        const ref: {current: Marker} = {current: null};
        const r = track(
            ref,
            prog({fileBytes: 10, fileSize: 100, totalBytes: 250, grandTotal: 1000}),
            () => 0
        );
        expect(r.pct).toBe(25);
    });

    it('clamps percent at 100 and never divides by zero', () => {
        const ref: {current: Marker} = {current: null};
        expect(track(ref, prog({fileBytes: 5000, fileSize: 1000}), () => 0).pct).toBe(100);
        const empty: {current: Marker} = {current: null};
        expect(track(empty, prog({fileSize: 0, grandTotal: 0}), () => 0).pct).toBe(0);
    });

    it('shows a file counter only for a multi-file batch', () => {
        const one: {current: Marker} = {current: null};
        expect(track(one, prog({fileCount: 1}), () => 0).label).not.toContain('[');
        const many: {current: Marker} = {current: null};
        expect(track(many, prog({fileIndex: 2, fileCount: 3}), () => 0).label).toContain('[2/3]');
    });

    it('names the file the receiver actually wrote', () => {
        // savedName differs from fileName after a collision de-duplicates to
        // "name (1).ext"; anything that opens the file must use savedName.
        const ref: {current: Marker} = {current: null};
        const r = track(ref, prog({savedName: 'report (1).pdf'}), () => 0);
        expect(r.label).toContain('report (1).pdf');
        expect(r.label).not.toContain('report.pdf -');
    });

    it('drops the ETA once the transfer is complete', () => {
        const ref: {current: Marker} = {current: {t: 0, bytes: 0}};
        const r = track(ref, prog({fileBytes: 1000, fileSize: 1000}), () => 1000);
        expect(r.pct).toBe(100);
        expect(r.label).not.toContain('ETA');
    });
});
