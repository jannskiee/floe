// Did the machine sleep while the tab was hidden? (spec 07 4.14.4, C-98)
//
// Across the hidden stretch the page reads two clocks: Date.now(), the wall
// clock, which keeps counting through a system sleep, and performance.now(),
// the page's monotonic clock, which is expected not to advance while the
// machine is suspended. A wall-clock lead of more than 30 s is read as a sleep.
// This is the spec's heuristic, and how each platform's monotonic clock treats
// a suspend is for the S1-WEB-06 manual cells to confirm; a missed sleep costs
// one caution line, never a transfer.
//
// When it fires, the page shows C-98 in place of C-96 for the rest of the
// session. A wall clock set backwards, or any reading that is not a number, is
// not sleep: this only ever adds a caution line, so it must not guess.

export const SLEEP_GAP_MS = 30_000;

export function sleptWhileHidden(input: { dateDeltaMs: number; perfDeltaMs: number }): boolean {
    const gap = input.dateDeltaMs - input.perfDeltaMs;
    return Number.isFinite(gap) && gap > SLEEP_GAP_MS;
}
