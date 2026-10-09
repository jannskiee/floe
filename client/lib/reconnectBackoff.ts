// When to retry a Socket.IO connection the server refused.
//
// socket.io-client treats a middleware refusal (the per-IP connection limiter's
// "Rate limit exceeded") as final: the socket goes inactive and its manager
// never retries, so a refused tab sat on "Reconnecting" forever. useSignaling
// retries by hand with these delays. Pure, with the random source injected, so
// the bounds are testable.
//
// Full jitter over a range whose floor stays at 2 s and whose ceiling starts at
// 10 s and doubles to 60 s, the limiter's window: tabs refused together spread
// out instead of returning as a burst, and a client that keeps backing off
// recovers inside one window.

export const FIRST_MIN_MS = 2_000;
export const FIRST_MAX_MS = 10_000;
export const MAX_DELAY_MS = 60_000;

/**
 * Delay in milliseconds before retry number `attempt` (0 for the first).
 * `random` stands in for Math.random; anything outside 0 to 1 is clamped.
 */
export function nextDelay(attempt: number, random: () => number = Math.random): number {
    const steps = Math.max(0, Math.floor(attempt));
    const upper = Math.min(FIRST_MAX_MS * 2 ** Math.min(steps, 16), MAX_DELAY_MS);
    const r = random();
    const unit = r > 0 ? Math.min(r, 1) : 0;
    return Math.round(FIRST_MIN_MS + unit * (upper - FIRST_MIN_MS));
}

export interface ReconnectBackoff {
    /** The delay for the next retry; each call moves one attempt further. */
    next: () => number;
    /** Back to the first range, on a successful connect. */
    reset: () => void;
}

export function createReconnectBackoff(random: () => number = Math.random): ReconnectBackoff {
    let attempt = 0;
    return {
        next: () => nextDelay(attempt++, random),
        reset: () => {
            attempt = 0;
        },
    };
}
