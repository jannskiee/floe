// Whole-drop time left, and the advice it earns (spec 07 4.14.4).
//
// sendFiles reports a per-file rate and ETA. The drop as a whole is what the
// visitor has to plan around, so the page sums its OWN sizes: every file
// before the current one, plus the current file's share. Nothing here reads a
// count from the host.
//
// The estimate starts only after 60 s of sending (the first minute's rate is
// mostly ramp-up), and every threshold is strictly greater, so exactly 20
// minutes adds nothing.

/** Sending time before any whole-drop estimate is shown. */
export const ETA_WARMUP_MS = 60_000;
/** Over this, C-95 (plugged in and awake, pin the tab). */
export const ETA_PLUGGED_IN_S = 20 * 60;
/** Over this, C-96 (a dropped connection restarts the moving file). */
export const ETA_STARTS_OVER_S = 2 * 3600;
/** Over this, C-97: the host's 24-hour cap would stop the drop. */
export const ETA_WILL_STOP_S = 24 * 3600;

/** Bytes of the drop delivered so far, from the visitor's own file sizes:
 *  after the ack of file `ackIndex` (1-based), files before it are whole and
 *  this one is `percent` done. Clamped to the drop. */
export function deliveredBytes(sizes: readonly number[], ackIndex: number, percent: number): number {
    const index = Math.min(Math.max(Math.floor(ackIndex), 0), sizes.length);
    if (index === 0) return 0;
    const share = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) / 100 : 0;
    let done = 0;
    for (let i = 0; i < index - 1; i++) done += sizes[i];
    return done + sizes[index - 1] * share;
}

/** The whole drop's percent, whole and clamped, for the hidden-tab title. */
export function dropPercent(sizes: readonly number[], ackIndex: number, percent: number): number {
    const all = sizes.reduce((sum, s) => sum + s, 0);
    if (all <= 0) return 0;
    return Math.min(100, Math.floor((deliveredBytes(sizes, ackIndex, percent) / all) * 100));
}

/** Seconds left for the whole drop at the measured rate, or null before 60 s
 *  of sending or without a rate. */
export function dropEtaSeconds(input: {
    dropBytes: number;
    deliveredBytes: number;
    bytesPerSec: number;
    sendingForMs: number;
}): number | null {
    if (!(input.sendingForMs >= ETA_WARMUP_MS)) return null;
    if (!(Number.isFinite(input.bytesPerSec) && input.bytesPerSec > 0)) return null;
    const left = Math.max(0, input.dropBytes - input.deliveredBytes);
    return left / input.bytesPerSec;
}

export type EtaAdvice = { key: 'plugged-in' } | { key: 'starts-over' } | { key: 'will-stop'; seconds: number };

/** The advice keys an estimate earns, cumulative and in display order. The
 *  words are visitorCopy's (adviceLines). */
export function etaAdvice(etaSeconds: number | null): EtaAdvice[] {
    if (etaSeconds === null || !Number.isFinite(etaSeconds)) return [];
    const out: EtaAdvice[] = [];
    if (etaSeconds > ETA_PLUGGED_IN_S) out.push({ key: 'plugged-in' });
    if (etaSeconds > ETA_STARTS_OVER_S) out.push({ key: 'starts-over' });
    if (etaSeconds > ETA_WILL_STOP_S) out.push({ key: 'will-stop', seconds: etaSeconds });
    return out;
}
