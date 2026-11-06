// What a browser SENDER tells its receiver when the send stops on this side.
// Pure and outside P2PTransfer.tsx for the reason senderStop.ts is: nothing in
// the suite mounts the component.
//
// The sender used to stop on an unreadable file, on the 2 minute ack wait and
// on an internal error with a banner of its own and nothing on the wire, and
// it left the connection open, so the receiver sat on its last status line for
// as long as the sending tab stayed open (A1-B1). A sender that refused a
// relayed path closed with no reason, and the receiver was told to ask for a
// restart that fails the same way (A8a-B2).
//
// The carrier is the frame every peer already reads: `incompatible` as TEXT
// with an overlapping pv range, from incompatibleMessage, the same frame the
// relay-cap reason has used since PR #429. No code rides on it: the RefusalCodes
// name why a RECEIVER stopped, all but unverified, and no released receiver reads
// a code on a sender's frame. Every receiver shows the reason itself: the
// browser receiver in its banner, floe 1.11.0 after "Error: ", Floe Desktop
// 0.3.0 after "Error: transfer failed: ". The literal frames and what each of
// those receivers makes of them are pinned in
// cli/engine/transfer/testdata/browser-sender-stops.json, which
// senderSelfStop.test.ts and browserstop_test.go both read.
//
// Written for the person at the RECEIVER, about the sender, in words that
// name no surface the receiver might not be on. Each is fixed copy: none
// carries a file name or anything the peer sent.

export type SelfStop = 'unreadable' | 'ack-timeout' | 'internal';

export const SELF_STOP_REASONS: Readonly<Record<SelfStop, string>> = {
    unreadable: 'The sender stopped: a file could not be read on their device. Ask them to check it and send again.',
    'ack-timeout': 'The sender stopped after waiting 2 minutes for this device to answer. Ask them to send again.',
    internal: 'The sender stopped because of an error on their side. Ask them to send again.',
};

/** Sent when this page refuses a relayed path because its link was made with
 *  Network relay fallback off. The receiver cannot change the sender's
 *  checkbox, so it names what the sender has to do. */
export const RELAY_OFF_REASON =
    'The sender has Network relay fallback off, and this connection needs the relay. ' +
    'Ask them to reload, leave it on, and share a new link.';

/**
 * The stop to tell the receiver about, from the send engine's typed failure,
 * or null when there is nothing to tell. A closed channel is the one failure
 * with no one left to tell.
 */
export function selfStopOf(kind: 'ack-timeout' | 'closed' | 'unreadable'): SelfStop | null {
    return kind === 'closed' ? null : kind;
}
