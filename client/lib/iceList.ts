// The relay list (the ICE servers from /api/turn-credentials) a page connects
// with, and when to read it again.
//
// The main page used to read it once, at load, and never again, and a read
// that failed was swallowed (A1-B3). Its TURN credentials last 24 hours
// (server/turn.js), so a sending page left open for a day, or one that loaded
// while the server was unreachable, connected with the STUN-only defaults
// while its "Network relay fallback" box still showed checked. Now the list is
// read again before a connection is built whenever no read has succeeded yet
// or the list is an hour old.
//
// An hour, not closer to the 24: the read is one cheap request (the server
// caches the list for 5 minutes and allows 20 reads a minute per address), and
// a list read again well inside its life never reaches a connection expired.

export const ICE_LIST_MAX_AGE_MS = 60 * 60 * 1000;

/** How long a connection waits for that read before it goes on with the list
 *  it has. A hung read must not hold the transfer: the receiver is waiting
 *  for an offer the whole time. */
const ICE_LIST_READ_WAIT_MS = 5_000;

/** What a page connects with before any read succeeds. */
export const STUN_DEFAULTS: readonly RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

/** Whether the list read at `readAt` (null: no read has succeeded) has to be
 *  read again. A clock that went backwards reads as stale. */
export function iceListStale(readAt: number | null, now: number, maxAgeMs = ICE_LIST_MAX_AGE_MS): boolean {
    return readAt === null || now < readAt || now - readAt >= maxAgeMs;
}

export interface IceList {
    /** The list to build a connection with now. */
    current(): RTCIceServer[];
    /** Reads the list, whatever its age. */
    read(): Promise<void>;
    /** Reads the list only when it is stale. */
    freshen(): Promise<void>;
}

/**
 * `read` fetches the list. An answer that is not a non-empty array (a 429's
 * JSON, an error page) counts as a failed read, like a throw: the list in hand
 * is kept and the next freshen() reads again. Callers that ask while a read is
 * in flight share it.
 */
export function createIceList(deps: { read: () => Promise<unknown>; now?: () => number }): IceList {
    const now = deps.now ?? (() => Date.now());
    let servers: RTCIceServer[] = STUN_DEFAULTS.map((s) => ({ ...s }));
    let readAt: number | null = null;
    let inFlight: Promise<void> | null = null;

    const read = (): Promise<void> => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                const list = await deps.read();
                if (Array.isArray(list) && list.length > 0) {
                    servers = list as RTCIceServer[];
                    readAt = now();
                }
            } catch {
                // Kept as it was; the next connection asks again.
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    };

    return {
        current: () => servers,
        read,
        freshen: () => (iceListStale(readAt, now()) ? read() : Promise.resolve()),
    };
}

/** freshen(), waited for at most `ms`. The read itself goes on, and a later
 *  connection gets its result. */
export function freshenWithin(list: Pick<IceList, 'freshen'>, ms: number = ICE_LIST_READ_WAIT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
        list.freshen(),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}
