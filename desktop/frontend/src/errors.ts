// friendlyError turns a raw engine/backend error into StatusLine text. It
// lives outside App.tsx so it can be tested without a DOM or the Wails
// runtime bindings.
//
// The returned string always starts with 'Error: ': StatusLine keys its red
// styling and icon off that prefix, so the prefix is part of the contract.
// Known patterns map to a sentence a person can act on, in the register of
// serverprobe.go's describeDialError; anything unknown passes through
// unchanged so a novel failure still reaches a bug report intact (only a
// closing period is trimmed: no line in the app ends in one, D-167). Substring
// matching, first match wins, because the backend wraps errors ("transfer
// failed: error sending x: ...").

// Messages that are already hand-written for humans (and may carry an
// actionable hint, like the relay cap's Hide my IP note) pass through as-is.
const PASSTHROUGH = [
    'relay connections are capped',
    // Anchored on the leading words of transfer.go's errNoRelay and
    // errRelayUnknown (D-167), so rewording the rest cannot break the match.
    // Grouped with the relay cap: both are Hide my IP messages.
    'Hide my IP needs a relay',
    "relay details for Hide my IP",
    'this code is no longer active',
    'room is full',
];

// RX10 (D-123): a receive that got a file in full, verified, and could not
// move it into place keeps it as a .part (CommitError, E-36). The request
// lane's save-blocked stop says only its second sentence, with "save folder"
// as "folder" (ST17, D-136; requestCopy.ts SAVE_BLOCKED_KEPT_LINE).
export const COMMIT_KEPT_PART = "A received file couldn't be saved, so it was kept with a .part ending";

// Ordered mapping table: specific patterns before generic ones. The final
// 'connection closed' bucket must stay last of the connection family so the
// more precise closed-variants above it win.
export const RULES: Array<[pattern: string, friendly: string]> = [
    // First of all: a request or drop link pasted into Receive (S1-DSK-07,
    // F-06). Go returns the approved sentence bare, but an older build wrapped
    // it in 'could not resolve "<the link>": ...', and the typo advice of
    // that rule is wrong for a link that parsed fine.
    ['request link for sending files', 'Request links open in a web browser'],
    // Before 'could not resolve': the resolve step wraps network failures too
    // ('could not resolve %q: could not reach signaling server: ...'), and a
    // dead server must not read as a typo in the code.
    ['could not reach signaling server', "Can't reach the server"],
    ['could not resolve', "That code wasn't recognized"],
    ['Invalid room ID', 'That link is incomplete'],
    ['connection closed before any file', 'The sender canceled before it started'],
    ['connection closed while waiting for the receiver', 'The receiver left or declined'],
    ['no data arrived from the sender', 'The sender never started sending'],
    ['transfer stalled', 'The transfer stalled'],
    // A hash refusal named as one, above 'receiver discarded a file': that rule
    // says a file arrived incomplete, which is the wrong cause here. Three
    // inputs reach a desktop SENDER for the same event: a current peer's coded
    // refusal, whose text is PeerStoppedError.Error() for CodeHashMismatch in
    // cli/engine/transfer/refusal.go, and the two wire reasons a peer that
    // predates `code` sends (RefusalCode.WireReason and the browser's
    // HASH_UNREADABLE_REASON). The RECEIVER's own two sentences (". . . so it
    // was not kept") are deliberately NOT matched: that is this side's file,
    // and they keep passing through, which refusal.go's comment relies on. A
    // bare 'SHA-256' pattern would catch them and tell a person whose own drive
    // failed that the other side discarded a file.
    ['their Floe deleted it', "They discarded a file that didn't match what was sent"],
    ['its SHA-256 did not match', "They discarded a file that didn't match what was sent"],
    ["sender's SHA-256 was not readable", "They discarded a file that didn't match what was sent"],
    // Both carry a reason the RECEIVER wrote about its own side, so they must
    // sit above the receiver-voiced buckets below or a sender would be told a
    // file it sent arrived incomplete, in the wrong voice.
    ['receiver discarded a file', "They didn't get a file whole, so it was discarded"],
    ['receiver stopped the transfer', 'They stopped the transfer'],
    ['incomplete file', "A file arrived incomplete and wasn't kept"],
    // The sender caught its own source file changing between the size it
    // announced and the bytes it read, so nothing was delivered. The engine
    // sentence is already actionable but arrives behind two wrappers
    // ('transfer failed: error sending x: ...'); say it once, cleanly.
    ['while it was being sent', "A file changed while sending and wasn't delivered"],
    // A setup the engine ended early (peer.ErrPeerLeft, ErrSignalingLost and
    // ErrClosed): above 'timed out establishing a connection' and the generic
    // 'connection closed' bucket, because none of the three is a failure to
    // connect. The closed one never shows in practice: transfer.go suppresses
    // the failure of a canceled transfer.
    ['left before the connection was established', 'They left before the connection was made'],
    ['lost before the peer connected', "Can't reach the server"],
    ['closed before the connection was established', 'Canceled'],
    ['timed out waiting for the peer', 'Both people need Floe open at the same time'],
    ['timed out waiting for ack', 'Both people need Floe open at the same time'],
    ['timed out establishing a connection', "Couldn't connect the two devices"],
    ['data channel did not open', "Couldn't connect the two devices"],
    ['failed to connect to signaling server', "Can't reach the server"],
    ['failed to fetch ICE credentials', "Can't reach the server"],
    ['timed out waiting for the server', "Can't reach the server"],
    // 'server error:' means the server WAS reached and rejected the request
    // (e.g. rate limiting), so connectivity advice would mislead.
    ['server error:', 'The server is busy, try again in a minute'],
    ['timed out waiting for delivery', 'The connection dropped before the transfer finished'],
    ['peer disconnected before connecting', 'The receiver left before it started'],
    // A receive this side stopped on purpose, or could not finish saving
    // (D-123, approved desktop copy RX1 to RX10). Each pattern is the
    // engine's WHOLE sentence (RefusedError.Error() and CommitError.Error()
    // in cli/engine/transfer/refusal.go, approved CLI copy RX-01 to RX-10),
    // never the shared "receive stopped" prefix: a desktop SENDER is handed
    // text about the other side (PeerStoppedError's "They ..." and "Their
    // ...", a wire reason's "receiver ..."), which cannot contain these
    // words, and the bare "receive stopped" of an empty code keeps passing
    // through. No rule above occurs inside any of them, so none takes them
    // first; errors.test.ts proves both directions.
    ["receive stopped: a file's path is too deep or too long to save in this folder", "A file's path is too deep or too long to save in this folder"],
    ['receive stopped: a file is larger than the save drive can hold', 'A file is larger than the save drive can hold'],
    ['receive stopped: more data arrived than this transfer announced', 'More data arrived than this transfer announced'],
    ['receive stopped: relayed transfers are capped at 2 GB', 'Relayed transfers are capped at 2 GB'],
    ['receive stopped: the transfer reached its 24-hour limit', 'The transfer reached its 24-hour limit'],
    ['receive stopped: nobody answered in time', 'Nobody answered in time'],
    ['receive stopped: the transfer was declined', 'The transfer was declined'],
    ['receive stopped: the transfer was stopped on this computer', 'Stopped on this computer'],
    ['receive stopped: a finished file could not be moved into place', "A finished file couldn't be moved into place"],
    ['received a file in full but could not finish saving it; the complete file was kept in the save folder with a .part ending', COMMIT_KEPT_PART],
    ['cannot create', "Can't write to the save folder"],
    ['write error', "Can't write to the save folder"],
    ['connection failed (state', 'The connection dropped before the transfer finished'],
    ['failed to send chunk', 'The connection dropped before the transfer finished'],
    ['backpressure stall', 'The connection dropped before the transfer finished'],
    ['connection closed', 'The connection dropped before the transfer finished'],
];

/** calm drops one closing period from a sentence that passes through, so an
 *  engine line (shared with the CLI, which keeps its punctuation) reads like
 *  every other line in the app. An ellipsis stays. */
export function calm(s: string): string {
    return s.endsWith('.') && !s.endsWith('..') ? s.slice(0, -1) : s;
}

export function friendlyError(raw: unknown): string {
    const text = String(raw).replace(/^Error:\s*/, '').trimEnd();
    for (const p of PASSTHROUGH) {
        if (text.includes(p)) return 'Error: ' + calm(text);
    }
    for (const [pattern, friendly] of RULES) {
        if (text.includes(pattern)) return 'Error: ' + friendly;
    }
    return 'Error: ' + calm(text);
}
