// One Send, or one Try again, is one attempt.
//
// The visitor page awaits a lot: the TURN answer, the socket, getStats, the
// abort frame's flush, and sendFiles itself, which has no deadline of its own
// under requireReceived. Any of those can come back after the visitor pressed
// Cancel or Try again, and a write from a finished attempt is exactly how a
// page ends up showing the last attempt's outcome over the current one. So
// every continuation carries the id it started under and asks the gate before
// it writes. This is the page's isDestroyed: the sender's own isDestroyed
// callback is built from it.

export interface AttemptGate {
    /** Start a new attempt and return its id. Any earlier id stops being live. */
    begin(): number;
    /** The current attempt is over (it reached an attempt-ending state). */
    end(): void;
    /** True only for the current attempt, and only until it ends. */
    isLive(id: number): boolean;
    /** Run `write` only while `id` is live. */
    guard(id: number, write: () => void): void;
}

export function createAttemptGate(): AttemptGate {
    let current = 0;
    let live = false;
    const isLive = (id: number) => live && id === current;
    return {
        begin() {
            current += 1;
            live = true;
            return current;
        },
        end() {
            live = false;
        },
        isLive,
        guard(id, write) {
            if (isLive(id)) write();
        },
    };
}
