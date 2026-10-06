/**
 * The /r backdrop (D-166, the "Ice field" direction): faint contour lines of
 * an ice sheet seen from above, densest toward the corners and masked away
 * from the wordmark, the card and the footer, over three very faint ice
 * lights.
 *
 * Decoration only: aria-hidden, never takes a pointer, and paints behind the
 * page (-z-10 inside the shell's isolated stacking context). Static, because
 * the owner ruled out moving light, and self-contained: inline SVG and CSS
 * gradients with no image, font or remote address, since /r exists so that
 * nothing about the link travels anywhere.
 *
 * The contours are iso-lines of a height field, traced once offline; the path
 * data is kept as drawn for two frames, a 1440 x 900 window and a 390 x 844
 * phone, chosen by the window's shape rather than its width (a portrait
 * tablet sliced from the wide frame showed almost none of it). Each frame
 * covers the viewport (xMidYMid slice) and its strokes stay 1px at any scale
 * (non-scaling-stroke). One path per alpha tier.
 */

const ICE = '#bfe0f2';

type Tier = readonly [opacity: number, d: string];

const WIDE: readonly Tier[] = [
    [0.06, 'M868-12c6 3 23 11 35 17s23 11 35 17s23 11 35 17s24 12 36 17s24 10 36 15s25 9 37 13s25 8 37 12s25 7 37 11s25 8 37 12s25 9 37 14s24 10 36 15s24 10 36 15s25 10 37 14s18 7 37 11s64 10 77 12M-16 573c7 1 26 4 39 6s26 4 39 8s28 7 38 14s23 18 24 29s-10 24-16 35s-16 22-22 34s-11 24-12 37s0 28 4 40s10 25 18 35s18 20 28 28s22 15 33 21s24 11 36 17s24 11 36 17s29 16 35 19M608-14c2 6 9 24 12 37s5 26 7 39s2 27 3 40s0 26 1 39s2 27 6 39s9 25 16 36s16 21 25 31s19 18 29 27s20 18 30 26s20 17 30 25s21 17 33 23s24 12 37 14s26 2 39 1s26-5 39-8s26-8 38-12s25-9 37-13s25-8 38-11s26-7 39-8s27-1 40 0s26 2 39 5s26 7 38 11s25 9 37 13s25 7 38 10s27 5 40 6s26 1 39 0s21-2 40-5s64-12 77-15M-16 451c7 0 26 2 39 2s26 0 39-1s27-1 40-2s26-2 39-3s26-1 39-2s26-1 39-1s27 2 40 4s25 4 38 7s26 8 38 12s24 10 36 15s23 11 35 16s24 12 36 17s24 11 36 15s25 7 38 10s26 5 39 8s26 4 38 9s25 11 33 20s13 23 17 35s4 26 6 39s4 26 5 39s2 26 2 39s1 27 0 40s-3 25-6 38s-3 20-11 38s-28 59-34 71M254 628c13-2 26-3 39-1s26 8 37 14s22 13 32 21s21 17 30 26s21 18 26 29s9 26 5 36s-19 19-30 25s-24 10-37 14s-25 6-38 8s-25 4-38 6s-26 3-39 4s-27 1-40 0s-26-2-38-7s-25-12-33-21s-14-23-15-35s4-26 10-37s16-20 25-29s21-16 32-23s23-13 35-18s24-10 37-12zM444-16c0 7-1 26-3 39s-7 25-11 37s-8 25-11 38s-5 25-8 38s-4 26-7 39s-6 26-12 37s-15 22-25 30s-22 14-34 19s-24 8-37 11s-26 4-39 6s-26 3-39 4s-26 2-39 3s-26 1-39 2s-26 2-39 2s-19 1-39 0s-65-7-78-8M218 672c13-3 28-4 41-2s27 9 37 17s23 21 25 32s-4 27-13 36s-25 12-38 16s-26 6-40 7s-28 2-41-2s-30-9-36-19s-6-27-1-39s18-22 29-30s24-13 37-16z'],
    [0.075, 'M188-16c2 6 7 26 12 38s12 23 18 35s13 24 16 36s6 27 3 39s-12 24-22 31s-24 11-37 14s-26 4-39 5s-26 1-39 0s-21-1-40-5s-63-16-76-19M1456 628c-6 4-23 15-35 22s-23 13-35 20s-23 14-35 20s-24 13-36 19s-24 12-36 18s-25 13-37 19s-23 12-35 19s-24 14-35 21s-23 15-33 24s-19 19-27 30s-15 23-21 35s-12 32-15 38M210 700c11-4 27-5 37-1s23 19 22 27s-18 19-29 23s-27 5-37 1s-22-18-21-26s17-20 28-24zM73-16c-1 6-2 26-5 38s-4 28-12 37s-21 16-33 19s-32-2-38-2M1453 728c-6 3-25 11-38 16s-25 11-37 17s-25 12-37 18s-24 14-36 21s-23 15-34 23s-18 12-31 27s-40 55-48 66'],
    [0.09, 'M1456 803c-6 2-26 8-39 13s-26 11-38 17s-25 14-36 22s-22 16-32 26s-22 27-27 32'],
    [0.16, 'M1454 480c-5 4-20 17-30 26s-21 18-31 27s-20 17-31 25s-22 16-34 23s-23 13-35 19s-25 11-38 15s-26 8-39 11s-26 5-39 6s-27 1-41 0s-27-2-40-4s-27-4-40-6s-27-4-40-4s-27 1-40 4s-26 7-38 13s-24 13-35 21s-20 19-28 29s-15 22-21 34s-10 25-13 38s-5 27-7 40s-1 20-5 40s-17 65-21 78'],
];

const NARROW: readonly Tier[] = [
    [0.06, 'M303-16c1 4 6 17 8 25s5 17 6 25s3 17 3 25s-1 17-2 26s-3 18-4 26s0 17 0 25s3 17 3 26s2 18 0 26s-4 17-9 24s-12 13-19 17s-16 7-24 10s-17 5-25 7s-16 3-25 4s-17 3-26 5s-17 4-25 6s-16 4-25 5s-17 3-26 3s-17 0-26 0s-17 0-26 0s-12 0-25 0s-43-2-52-2M404 462c-4 0-18-1-27 0s-17 2-26 4s-17 5-25 8s-16 6-24 10s-16 8-24 13s-14 9-21 15s-13 13-18 20s-10 14-14 22s-7 16-12 24s-9 15-15 22s-11 13-18 19s-14 12-21 17s-14 10-22 15s-15 10-23 13s-16 5-25 7s-17 3-26 5s-17 5-25 9s-11 8-20 18s-27 34-33 41M-13 796c4 3 16 6 23 17s16 39 19 47M246-16c0 4 0 18-1 26s-4 17-7 25s-7 16-10 24s-6 16-9 24s-5 17-8 25s-4 17-9 24s-11 14-18 19s-15 8-23 11s-17 5-25 7s-16 3-25 5s-17 3-26 5s-17 4-25 6s-12 3-25 6s-42 8-51 10M404 565c-4 0-17-1-26-1s-17 0-25 1s-17 3-25 7s-14 9-20 15s-11 14-16 21s-10 14-16 20s-12 12-19 17s-15 9-23 13s-15 8-22 12s-15 9-22 14s-13 11-19 17s-12 17-19 17s-14-10-21-14s-15-8-23-10s-18 0-26 1s-17 4-24 8s-13 11-19 17s-11 13-16 20s-13 14-15 21s1 18 5 24s13 11 21 14s18 4 26 4s17-2 25-4s17-7 24-9s18-5 20-1s-5 17-9 24s-10 14-15 21s-11 18-13 22M404 657c-3 3-12 13-18 19s-13 13-20 18s-15 9-23 12s-16 5-25 7s-17 3-26 4s-17 0-26 2s-18 4-26 8s-15 9-20 16s-8 16-11 24s-3 18-5 26s0 14-7 25s-27 34-33 41M186-16c-1 4-3 18-5 26s-6 17-9 25s-6 17-9 25s-5 16-9 24s-9 16-16 22s-15 10-23 13s-16 5-25 6s-18 2-27 2s-17 1-26 1s-18-1-27-2s-22-3-26-4M75 712c8-3 19-5 26-3s15 10 17 17s0 17-3 25s-8 15-14 21s-15 11-23 13s-17 4-25 2s-18-8-20-15s3-16 7-24s9-15 15-21s12-12 20-15zM88-16c0 4-1 17-1 26s1 18 0 26s-2 18-6 24s-12 12-20 15s-17 4-26 5s-17 0-26-1s-21-4-25-5M83 724c7-1 19 3 21 9s-1 19-6 25s-14 13-21 14s-21-3-23-8s4-17 9-24s13-15 20-16z'],
    [0.075, 'M35-16c-1 5 2 18-7 27s-37 21-44 25M320 857c2-4 6-16 9-24s7-15 12-22s8-12 18-19s37-20 44-24M350 860c2-4 6-18 11-26s12-16 19-22s20-12 24-15'],
    [0.16, 'M276 856c2-4 6-16 9-25s5-18 9-26s9-16 15-23s14-11 22-16s12-6 24-12s41-21 49-25'],
];

// The three lights, at the top and in two opposite corners; a portrait window
// gets them re-sized for the tall frame.
const LIGHT_WIDE =
    'radial-gradient(900px 520px at 50% -14%, rgb(191 224 242 / 0.07), transparent 70%), ' +
    'radial-gradient(760px 560px at 100% 100%, rgb(191 224 242 / 0.06), transparent 70%), ' +
    'radial-gradient(600px 440px at 0% 0%, rgb(191 224 242 / 0.045), transparent 70%)';
const LIGHT_NARROW =
    'radial-gradient(420px 300px at 50% -8%, rgb(191 224 242 / 0.07), transparent 70%), ' +
    'radial-gradient(380px 320px at 100% 100%, rgb(191 224 242 / 0.06), transparent 70%), ' +
    'radial-gradient(340px 280px at 0% 0%, rgb(191 224 242 / 0.045), transparent 70%)';

/** One frame of contours. The vignette mask keeps the middle of the frame
 *  dark (where the card sits) and clears two soft ellipses for the wordmark
 *  and the footer. */
function Field({ id, w, h, vignette, top, bottom, tiers, className }: {
    id: string;
    w: number;
    h: number;
    vignette: { cy: number; r: number; sx: number; sy: number; stops: readonly [number, number] };
    top: readonly [cy: number, rx: number, ry: number];
    bottom: readonly [cy: number, rx: number, ry: number];
    tiers: readonly Tier[];
    className: string;
}) {
    const cx = w / 2;
    const cy = vignette.cy;
    return (
        <svg
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="xMidYMid slice"
            className={`absolute inset-0 size-full ${className}`}
        >
            <defs>
                <radialGradient
                    id={`${id}-vg`}
                    gradientUnits="userSpaceOnUse"
                    cx={cx}
                    cy={cy}
                    r={vignette.r}
                    gradientTransform={`translate(${cx} ${cy}) scale(${vignette.sx} ${vignette.sy}) translate(${-cx} ${-cy})`}
                >
                    <stop offset="0" stopColor="#000" />
                    <stop offset={vignette.stops[0]} stopColor="#000" />
                    <stop offset={vignette.stops[1]} stopColor="#fff" />
                    <stop offset="1" stopColor="#fff" />
                </radialGradient>
                <radialGradient id={`${id}-clear`}>
                    <stop offset="0" stopColor="#000" />
                    <stop offset="0.5" stopColor="#000" stopOpacity="0.85" />
                    <stop offset="1" stopColor="#000" stopOpacity="0" />
                </radialGradient>
                <mask id={`${id}-m`} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
                    <rect width={w} height={h} fill={`url(#${id}-vg)`} />
                    <ellipse cx={cx} cy={top[0]} rx={top[1]} ry={top[2]} fill={`url(#${id}-clear)`} />
                    <ellipse cx={cx} cy={bottom[0]} rx={bottom[1]} ry={bottom[2]} fill={`url(#${id}-clear)`} />
                </mask>
            </defs>
            <g mask={`url(#${id}-m)`} fill="none" stroke={ICE} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                {tiers.map(([opacity, d]) => (
                    <path key={opacity} d={d} strokeOpacity={opacity} vectorEffect="non-scaling-stroke" />
                ))}
            </g>
        </svg>
    );
}

export function RequestBackdrop() {
    return (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
            <div className="absolute inset-0 hidden landscape:block" style={{ background: LIGHT_WIDE }} />
            <div className="absolute inset-0 landscape:hidden" style={{ background: LIGHT_NARROW }} />
            <Field
                id="r-ice-wide"
                w={1440}
                h={900}
                vignette={{ cy: 450, r: 760, sx: 1, sy: 1.2, stops: [0.36, 0.74] }}
                top={[48, 240, 96]}
                bottom={[852, 220, 84]}
                tiers={WIDE}
                className="hidden landscape:block"
            />
            <Field
                id="r-ice-narrow"
                w={390}
                h={844}
                vignette={{ cy: 405, r: 480, sx: 0.7, sy: 1, stops: [0.5, 0.78] }}
                top={[42, 120, 56]}
                bottom={[808, 110, 44]}
                tiers={NARROW}
                className="landscape:hidden"
            />
        </div>
    );
}
