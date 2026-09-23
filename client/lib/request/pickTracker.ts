// Picks that are still being read: a dropped folder being walked, or a plain
// drop whose first bytes are being probed (WP-W1 review F5).
//
// A count rather than a flag, so two overlapping drops keep Send off until the
// last one settles; and a generation that Clear moves on, so a walk that began
// before Clear drops its result instead of refilling the emptied selection.

export interface PickTracker {
    /** A read begins; returns its token. */
    begin(): number;
    /** A read settled (whatever its outcome). */
    end(): void;
    /** True while any read is in flight. */
    reading(): boolean;
    /** True when nothing cleared the selection since the read with this token
     *  began. */
    current(token: number): boolean;
    /** The selection was cleared: reads already in flight are stale. */
    clear(): void;
}

export function createPickTracker(): PickTracker {
    let inFlight = 0;
    let generation = 0;
    return {
        begin() {
            inFlight += 1;
            return generation;
        },
        end() {
            inFlight = Math.max(0, inFlight - 1);
        },
        reading: () => inFlight > 0,
        current: (token) => token === generation,
        clear() {
            generation += 1;
        },
    };
}
