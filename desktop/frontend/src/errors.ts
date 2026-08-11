// friendlyError turns a raw engine/backend error into StatusLine text. It
// lives outside App.tsx so it can be tested without a DOM or the Wails
// runtime bindings.
//
// The returned string always starts with 'Error: ': StatusLine keys its red
// styling and icon off that prefix, so the prefix is part of the contract.
// Known patterns map to a sentence a person can act on, in the register of
// serverprobe.go's describeDialError; anything unknown passes through
// unchanged so a novel failure still reaches a bug report intact. Substring
// matching, first match wins, because the backend wraps errors ("transfer
// failed: error sending x: ...").

// Messages that are already hand-written for humans (and may carry an
// actionable hint, like the relay cap's Hide my IP note) pass through as-is.
const PASSTHROUGH = [
    'relay connections are capped',
    'this code is no longer active',
    'room is full',
];

// Ordered mapping table: specific patterns before generic ones. The final
// 'connection closed' bucket must stay last of the connection family so the
// more precise closed-variants above it win.
const RULES: Array<[pattern: string, friendly: string]> = [
    // Before 'could not resolve': the resolve step wraps network failures too
    // ('could not resolve %q: could not reach signaling server: ...'), and a
    // dead server must not read as a typo in the code.
    ['could not reach signaling server', 'Could not reach the server. Check your internet connection.'],
    ['could not resolve', 'That code was not recognized. Check it for typos, or ask the sender for a new one.'],
    ['Invalid room ID', 'That link looks incomplete. Copy the whole share link and try again.'],
    ['connection closed before any file', 'The sender cancelled, or the transfer was blocked before it started.'],
    ['connection closed while waiting for the receiver', 'The receiver left or declined before the transfer started.'],
    ['no data arrived from the sender', 'Connected, but the sender never started sending. Ask them to try again.'],
    ['transfer stalled', 'The transfer stalled and gave up. Start it again.'],
    ['incomplete file', 'A file arrived incomplete, so it was not kept. Start the transfer again.'],
    ['timed out waiting for the peer', 'The other side never connected. Both people need Floe open at the same time.'],
    ['timed out waiting for ack', 'The other side never connected. Both people need Floe open at the same time.'],
    ['timed out establishing a connection', 'A connection could not be established. Check that both devices are online and try again.'],
    ['data channel did not open', 'A connection could not be established. Check that both devices are online and try again.'],
    ['failed to connect to signaling server', 'Could not reach the server. Check your internet connection.'],
    ['failed to fetch ICE credentials', 'Could not reach the server. Check your internet connection.'],
    ['timed out waiting for the server', 'Could not reach the server. Check your internet connection.'],
    // 'server error:' means the server WAS reached and rejected the request
    // (e.g. rate limiting), so connectivity advice would mislead.
    ['server error:', 'The server rejected the request. Try again in a minute.'],
    ['timed out waiting for delivery', 'The connection was lost before the transfer finished. Start it again.'],
    ['peer disconnected before connecting', 'The receiver left before the transfer started.'],
    ['cannot create', 'Could not write to the save folder. Check that it exists and has free space.'],
    ['write error', 'Could not write to the save folder. Check that it exists and has free space.'],
    ['connection failed (state', 'The connection was lost before the transfer finished. Start it again.'],
    ['failed to send chunk', 'The connection was lost before the transfer finished. Start it again.'],
    ['backpressure stall', 'The connection was lost before the transfer finished. Start it again.'],
    ['connection closed', 'The connection was lost before the transfer finished. Start it again.'],
];

export function friendlyError(raw: unknown): string {
    const text = String(raw).replace(/^Error:\s*/, '');
    for (const p of PASSTHROUGH) {
        if (text.includes(p)) return 'Error: ' + text;
    }
    for (const [pattern, friendly] of RULES) {
        if (text.includes(pattern)) return 'Error: ' + friendly;
    }
    return 'Error: ' + text;
}
