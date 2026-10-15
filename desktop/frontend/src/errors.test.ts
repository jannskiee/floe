import {describe, expect, it} from 'vitest';
import {PASSTHROUGH, RULES, calm, friendlyError} from './errors';

describe('friendlyError', () => {
    it('always starts with the Error prefix StatusLine keys its styling off', () => {
        const samples = [
            'transfer failed: connection closed mid-transfer: a.bin (10 of 20 bytes)',
            'anything unknown at all',
            'relay connections are capped at 2 GB (selected relay)',
        ];
        for (const s of samples) {
            expect(friendlyError(s).startsWith('Error: ')).toBe(true);
        }
    });

    it('maps a wrapped engine error through the backend prefixes', () => {
        expect(friendlyError('transfer failed: error sending a.bin: failed to send chunk: x')).toBe(
            'Error: The connection dropped before the transfer finished',
        );
    });

    it('maps the backpressure stall to the connection-lost sentence', () => {
        expect(friendlyError('backpressure stall: peer not draining (8388608 bytes buffered)')).toBe(
            'Error: The connection dropped before the transfer finished',
        );
    });

    it('keeps the specific closed-before-any-file diagnosis out of the generic bucket', () => {
        expect(
            friendlyError('connection closed before any file arrived (the sender canceled, or the transfer was blocked)'),
        ).toBe('Error: The sender canceled before it started');
    });

    it('keeps the receiver-left diagnosis out of the generic bucket', () => {
        expect(
            friendlyError('transfer failed: connection closed while waiting for the receiver (transfer declined or receiver exited)'),
        ).toBe('Error: The receiver left or declined');
    });

    it('maps a close before the receiver confirmed delivery to the connection-lost sentence (D-144.9)', () => {
        // A Go receiver's ack promises its word after the last file
        // (FT-GO-CONFIRMS), so a close without it reaches a desktop sender as
        // the engine's ErrClosedBeforeReceived, never as a success; its text
        // gets no rule of its own and falls to the generic closed bucket.
        expect(friendlyError('transfer failed: the connection closed before the receiver confirmed delivery')).toBe(
            'Error: The connection dropped before the transfer finished',
        );
    });

    it('routes a wrapped network failure to the server bucket, not the typo bucket', () => {
        expect(friendlyError('could not resolve "olive-tiger": could not reach signaling server: dial tcp: refused')).toBe(
            "Error: Can't reach the server",
        );
    });

    it('names any other failed code lookup as an unreachable server, not as a wrong code', () => {
        // Resolve answers every status but 200, 404 and 429 with the same
        // sentence (a 502 or 503 from a proxy in front of a stopped server,
        // a 500). None of them says anything about the code.
        for (const status of [500, 502, 503]) {
            expect(friendlyError('could not resolve "olive-tiger-castle": server returned ' + status + ' when resolving code')).toBe(
                "Error: Can't reach the server",
            );
        }
        // The 404 is still a code the server does not know.
        expect(friendlyError('could not resolve "olive-tiger-castle": code "olive-tiger-castle" not found or expired (codes expire after 10 minutes)')).toBe(
            "Error: That code wasn't recognized",
        );
    });

    it('names a rate-limited code lookup as the server limiting requests, not as a wrong code', () => {
        // The engine's sentence for any status but 200 and 404 (Resolve in
        // cli/engine/code/client.go: "server returned %d when resolving code"),
        // as receiveByCode wraps it. A 429 is the server's limit on lookups
        // from one network, which a correct code meets too, so "That code
        // wasn't recognized" sent a person back to recheck a code that was
        // right. The rule sits above 'could not resolve', whose words open
        // the same string.
        const limited = 'The server is limiting requests from this network. Wait a minute and try again';
        expect(friendlyError('could not resolve "olive-tiger-castle": server returned 429 when resolving code')).toBe(
            'Error: ' + limited,
        );
        expect(friendlyError('Error: could not resolve "olive-tiger-castle": server returned 429 when resolving code')).toBe(
            'Error: ' + limited,
        );
        // The pasted input is not echoed, and a 404 keeps its own sentence.
        expect(friendlyError('could not resolve "429-server-returned": code "429-server-returned" not found or expired (codes expire after 10 minutes)')).toBe(
            "Error: That code wasn't recognized",
        );
    });

    it('names a room link cut short as incomplete in both places the check has run', () => {
        // A4-B27: a #room= value that is not a room id. Releases up to 1.11.0
        // hand it to the server, whose join answers 'Invalid room ID'; the
        // engine now refuses it in Resolve, and receiveByCode wraps that
        // sentence in 'could not resolve "<the link>": ...'. The rule sits
        // above 'could not resolve', whose typo advice is wrong for a link.
        const incomplete = 'Error: That link is incomplete';
        expect(friendlyError('server error: Invalid room ID')).toBe(incomplete);
        expect(
            friendlyError('could not resolve "https://floe.one/#room=6f1c2b9e-4a5d": the room id in this link is incomplete or mistyped'),
        ).toBe(incomplete);
        // A code in the wrong shape is still a code that was not recognized.
        expect(
            friendlyError('could not resolve "olive_tiger": code not recognized: a code is words joined by hyphens, like olive-tiger-castle'),
        ).toBe("Error: That code wasn't recognized");
    });

    it('reads the code-not-found sentence in both wordings the engine has had', () => {
        // Resolve's 404 sentence as receiveByCode wraps it: the one releases up
        // to 1.11.0 print, and the one that names the real causes. The desktop
        // ships its own engine, so only one of them reaches a given build, and
        // both must read the same here whichever lands first.
        const recognized = "Error: That code wasn't recognized";
        expect(
            friendlyError('could not resolve "olive-tiger-castle": code "olive-tiger-castle" not found or expired (codes expire after 10 minutes)'),
        ).toBe(recognized);
        expect(
            friendlyError('could not resolve "olive-tiger-castle": code "olive-tiger-castle" not found: it was already used, the sender left, or it expired (a code lasts 10 minutes at most)'),
        ).toBe(recognized);
    });

    it('tells a lost server connection from a receiver that left, while a send waits', () => {
        // desktop/transfer.go receiverWaitEnd: the engine's ErrSignalingLost
        // when this PC's socket to the server closed, and the receiver-left
        // sentence only when the server reported a peer gone.
        expect(friendlyError('the connection to the server was lost before the peer connected')).toBe(
            "Error: Can't reach the server",
        );
        expect(friendlyError('peer disconnected before connecting')).toBe('Error: The receiver left before it started');
    });

    it('maps a malformed room id in a pasted link to the incomplete-link sentence', () => {
        expect(friendlyError('server error: Invalid room ID')).toBe(
            'Error: That link is incomplete',
        );
    });

    it('has no rule for an error frame a Floe server never sends (A8b-B2)', () => {
        // A Floe server sends an error frame on these paths only for a
        // malformed room id, mapped just above, and its limits close the
        // socket or answer HTTP 429 instead. The rule that read every other
        // frame as "The server is busy, try again in a minute" could never
        // fire, and was wrong for anything it caught. desktop/transfer.go now
        // keeps an unknown frame's words out of the error (serverErrorFrame),
        // so what reaches this line is its own fixed sentence, passed through.
        const unknown = 'the server answered with an error this version of Floe does not know';
        expect(friendlyError(unknown)).toBe('Error: ' + unknown);
        expect(RULES.some(([p]) => p === 'server error:')).toBe(false);
        expect(RULES.some(([, f]) => f === 'The server is busy, try again in a minute')).toBe(false);
    });

    it('names a connection the server turned away by its limit, not a lost server or a dropped transfer (A8b-B1)', () => {
        // desktop/transfer.go errTurnedAway: the server closed the socket with
        // 1008 right after the upgrade, its answer to a connection past its
        // per-network limit. Nothing had started, and a minute's wait clears it.
        const limited = 'Error: The server is limiting connections from this network. Wait a minute and try again';
        expect(friendlyError('the server turned this connection away: too many connections from this network')).toBe(limited);
        expect(friendlyError('Error: the server turned this connection away: too many connections from this network')).toBe(limited);
    });

    it('names a selection with no file in it at the click (A3-B4)', () => {
        // transfer.ErrNoFiles, which StartSend's walk (transfer.Summarize)
        // returns for a selection of empty folders before any code is made,
        // and which the send itself returns, wrapped, if the folders emptied
        // between the click and the walk.
        const none = 'Error: The folders you chose have no files to send';
        expect(friendlyError('no files to send')).toBe(none);
        expect(friendlyError('transfer failed: no files to send')).toBe(none);
        // An empty selection keeps its own words.
        expect(friendlyError('no files selected')).toBe('Error: no files selected');
    });

    it('maps stall, timeout, server, and write-error buckets', () => {
        expect(friendlyError('transfer stalled: no data for 1m0s (5 of 10 bytes of "a")')).toBe(
            'Error: The transfer stalled',
        );
        expect(friendlyError('timed out establishing a connection')).toBe(
            "Error: Couldn't connect the two devices",
        );
        expect(friendlyError('failed to connect to signaling server: dial tcp: refused')).toBe(
            "Error: Can't reach the server",
        );
        expect(friendlyError('write error: disk full')).toBe(
            "Error: Can't write to the save folder",
        );
        expect(friendlyError('could not resolve "olive-tiger": 404')).toBe(
            "Error: That code wasn't recognized",
        );
    });

    it('names a setup that stopped early instead of calling it a failed connection', () => {
        // The three sentinels SetupAsSender and SetupAsReceiver return when
        // setup is ended rather than failing (peer.ErrPeerLeft,
        // ErrSignalingLost and ErrClosed in cli/engine/peer/setuperror.go),
        // quoted because Go cannot be imported here, as desktop/transfer.go
        // wraps them. They used to wait out the 30 s timeout and read as
        // "A connection could not be established".
        expect(friendlyError('WebRTC setup failed: the other side left before the connection was established')).toBe(
            'Error: They left before the connection was made',
        );
        expect(friendlyError('WebRTC setup failed: the connection to the server was lost before the peer connected')).toBe(
            "Error: Can't reach the server",
        );
        expect(friendlyError('WebRTC setup failed: closed before the connection was established')).toBe('Error: Canceled');
    });

    it('checks the early-stop rules above the connect timeout and the generic closed bucket', () => {
        // One input carrying the new pattern and both older ones shows which
        // rule sits higher in RULES: the early stop must win over both.
        const both = (s: string) => `WebRTC setup failed: ${s} (then: timed out establishing a connection; connection closed)`;
        expect(friendlyError(both('the other side left before the connection was established'))).toBe(
            'Error: They left before the connection was made',
        );
        expect(friendlyError(both('the connection to the server was lost before the peer connected'))).toBe(
            "Error: Can't reach the server",
        );
        expect(friendlyError(both('closed before the connection was established'))).toBe('Error: Canceled');
        // A present peer that cannot connect keeps its own sentence.
        expect(friendlyError('WebRTC setup failed: timed out establishing a connection')).toBe(
            "Error: Couldn't connect the two devices",
        );
    });

    it('names an ICE failure during setup as a failure to connect, not a dropped transfer', () => {
        // cli/engine/peer/connection.go builds 'connection failed (state: %s)'
        // only for the setup waits of SetupAsSender and SetupAsReceiver
        // (the conn.connected channel, read nowhere else), so this text never
        // describes a transfer that had started. desktop/transfer.go wraps it.
        for (const state of ['failed', 'disconnected', 'closed']) {
            expect(friendlyError(`WebRTC setup failed: connection failed (state: ${state})`)).toBe(
                "Error: Couldn't connect the two devices",
            );
        }
        // A transfer that had started keeps the dropped-connection sentence.
        expect(friendlyError('transfer failed: connection closed mid-transfer: a.bin (10 of 20 bytes)')).toBe(
            'Error: The connection dropped before the transfer finished',
        );
    });

    it('names a source file that changed under the send, not a lost connection', () => {
        // Two backend wrappers sit in front of the engine sentence, which is
        // why this is a substring rule rather than an equality one.
        const grew = 'transfer failed: error sending app.log: the file grew while it was being sent (announced 64 bytes); send it again once it stops changing';
        expect(friendlyError(grew)).toBe(
            "Error: A file changed while sending and wasn't delivered",
        );
        const shrank = 'transfer failed: error sending app.log: the file shrank while it was being sent (announced 64 bytes, read 32); send it again once it stops changing';
        expect(friendlyError(shrank)).toBe(
            "Error: A file changed while sending and wasn't delivered",
        );
    });

    it('keeps a reason the receiver wrote in the receiver voice, not the sender one', () => {
        // The reason travels back on an incompatible frame, so it reaches the
        // SENDER. Matching the generic incomplete-file bucket first would tell
        // the person who sent the file that a file they received was short.
        const discarded = 'transfer failed: error sending a.bin: receiver discarded a file: incomplete file "a.bin": received 40 of 100 bytes';
        expect(friendlyError(discarded)).toBe(
            "Error: They didn't get a file whole, so it was discarded",
        );
        const stopped = 'transfer failed: receiver stopped the transfer: sender exceeded the announced size of "a.bin"';
        expect(friendlyError(stopped)).toBe(
            'Error: They stopped the transfer',
        );
    });

    it('names a hash refusal as a mismatch, not a truncation', () => {
        const HASH = "Error: They discarded a file that didn't match what was sent";
        // A current peer: abortFromPeer returns *PeerStoppedError and the CLI
        // prints its fixed sentence for hash-mismatch. Since the Go half of
        // this card the sender no longer wraps a peer refusal with a local file
        // name, so both forms are asserted: a released peer's output still
        // carries the old wrap, and friendlyError matches on a substring.
        const coded = 'transfer failed: A file changed or was damaged on the way, so their Floe deleted it.';
        expect(friendlyError(coded)).toBe(HASH);
        expect(friendlyError('transfer failed: error sending a.bin: A file changed or was damaged on the way, so their Floe deleted it.')).toBe(HASH);
        // A peer that predates `code` sends the wire reason instead. Both
        // variants reach a desktop sender, and both used to fall into the
        // 'receiver discarded a file' truncation bucket.
        expect(friendlyError('transfer failed: error sending a.bin: receiver discarded a file because its SHA-256 did not match')).toBe(HASH);
        expect(friendlyError("transfer failed: error sending a.bin: receiver discarded a file because the sender's SHA-256 was not readable")).toBe(HASH);
        // And the older reason with no SHA words still reads as a truncation.
        expect(friendlyError('transfer failed: receiver discarded a file: incomplete file "a.bin": received 40 of 100 bytes')).toBe(
            "Error: They didn't get a file whole, so it was discarded",
        );
    });

    it('never maps a peer-stopped sentence to a wrong cause', () => {
        // Nine of the twelve fixed sentences from PeerStoppedError.Error() in
        // cli/engine/transfer/refusal.go, quoted because Go cannot be imported
        // here. hash-mismatch has its own rule above, and stopped and the
        // fallback have theirs below. These nine have no rule and must pass
        // through whole: since A8b-B3 desktop/transfer.go hands a peer's stop
        // to the status line bare, without the "transfer failed: " wrapper,
        // and a released build's wrapped form passes through as it did.
        // PASSTHROUGH is deliberately not extended for them: for these
        // inputs it would return the identical string to the default branch,
        // so it would be dead code. This guard is what actually holds, and it
        // fails the moment a future RULES entry swallows one of them.
        const sentences = [
            'They declined. Nothing was sent.',
            'Their computer ran out of space.',
            'They did not answer in time. Nothing was sent.',
            'A file is too large for the drive they save to.',
            'More data arrived than they accepted. If files changed after you chose them, ask them for a new link.',
            'A folder path is too long for their computer. Zip deeply nested folders first.',
            'Relayed drops are capped at 2 GB.',
            'A file arrived but their computer blocked saving it.',
            'This drop reached the 24-hour limit, so their Floe stopped it.',
            'Their computer could not save a file.',
        ];
        for (const s of sentences) {
            expect(friendlyError(s)).toBe('Error: ' + calm(s));
            expect(friendlyError('transfer failed: ' + s)).toBe('Error: transfer failed: ' + calm(s));
        }
    });

    it("gives a receiver's stop on an ordinary send the ordinary send's sentence (A8b-B3)", () => {
        // PeerStoppedError words code stopped, and its fallback, for a request
        // link ("this drop"). A desktop sender is only ever on an ordinary
        // send, where the receiver stopping it reads as the plain send's line
        // (the CLI's errTheyStopped, D-159), the sentence this file already
        // gives the wire reason 'receiver stopped the transfer'.
        const stopped = 'Error: They stopped the transfer';
        for (const s of ['They stopped this drop.', 'The drop stopped on their computer.']) {
            expect(friendlyError(s), s).toBe(stopped);
            expect(friendlyError('transfer failed: ' + s), s).toBe(stopped);
        }
    });

    it('passes the relay cap reason a blocked sender now sends through verbatim', () => {
        // A receiver used to see only a close and reported "The sender canceled,
        // or the transfer was blocked". It now carries the sender's own words.
        const capped = 'transfer failed: transfer blocked: relay connections are capped at 2 GB (selected 2.5 GB)';
        expect(friendlyError(capped)).toBe('Error: ' + capped);
    });

    it('passes hand-written actionable messages through verbatim', () => {
        const relay = 'transfer blocked: relay connections are capped at 2 GB (selected relay). Turn off Hide my IP to send larger files';
        expect(friendlyError(relay)).toBe('Error: ' + relay);
        // desktop/transfer.go errNotActive, in today's words and in the words
        // builds up to desktop-v0.3.0 used: both pass through whole.
        const active = 'this code or link is no longer active; ask the sender for a new one';
        expect(friendlyError(active)).toBe('Error: ' + active);
        const code = 'this code is no longer active; ask for a new one';
        expect(friendlyError(code)).toBe('Error: ' + code);
        expect(PASSTHROUGH.filter((p) => active.includes(p))).toEqual(['this code or link is no longer active']);
        expect(PASSTHROUGH.filter((p) => code.includes(p))).toEqual(['this code is no longer active']);
        // Both Hide my IP relay guards (desktop/transfer.go errNoRelay and
        // errRelayUnknown). They already name what to turn off, so a bucket
        // would replace advice with worse advice. This is the test that
        // catches a future RULES entry swallowing them, and it covers both
        // because the PASSTHROUGH anchors on each one's wording (D-167).
        const noRelay =
            "Hide my IP needs a relay this server doesn't have";
        expect(friendlyError(noRelay)).toBe('Error: ' + noRelay);
        const unknownRelay =
            "Couldn't read this server's relay details for Hide my IP";
        expect(friendlyError(unknownRelay)).toBe('Error: ' + unknownRelay);
        // transfer.go's two lines for a link from another server.
        for (const line of [
            'That link is for floe.one, but Floe is set to use another server. Clear Server address in Settings, then try again',
            'That link is for another Floe server. Set its address as Server address in Settings, then try again',
        ])
            expect(friendlyError(line)).toBe('Error: ' + line);
    });

    it('passes unknown errors through unchanged for bug reports', () => {
        expect(friendlyError('some novel failure nobody mapped')).toBe('Error: some novel failure nobody mapped');
    });

    it('does not double the prefix when the input already carries one', () => {
        expect(friendlyError('Error: some novel failure')).toBe('Error: some novel failure');
    });
});

describe('a code receive this side stopped (D-123)', () => {
    // The engine's own sentences for a receive this side stopped on purpose,
    // or could not finish saving: RefusedError.Error() and CommitError.Error()
    // in cli/engine/transfer/refusal.go (approved-copy-cli.txt RX-01 to RX-10),
    // quoted because Go cannot be imported here. ReceiveByCode wraps each in
    // 'transfer failed: ' (desktop/transfer.go). The second column is the
    // approved desktop row (RX1 to RX10), which approvedCopy.test.ts ties to
    // the frozen table.
    const RX: Array<[engine: string, shown: string]> = [
        ["receive stopped: a file's path is too deep or too long to save in this folder", "A file's path is too deep or too long to save in this folder"],
        ['receive stopped: a file is larger than the save drive can hold', 'A file is larger than the save drive can hold'],
        ['receive stopped: more data arrived than this transfer announced', 'More data arrived than this transfer announced'],
        ['receive stopped: relayed transfers are capped at 2 GB', 'Relayed transfers are capped at 2 GB'],
        ['receive stopped: the transfer reached its 24-hour limit', 'The transfer reached its 24-hour limit'],
        ['receive stopped: nobody answered in time', 'Nobody answered in time'],
        ['receive stopped: the transfer was declined', 'The transfer was declined'],
        ['receive stopped: the transfer was stopped on this computer', 'Stopped on this computer'],
        ['receive stopped: a finished file could not be moved into place', "A finished file couldn't be moved into place"],
        [
            'received a file in full but could not finish saving it; the complete file was kept in the save folder with a .part ending',
            "A received file couldn't be saved, so it was kept with a .part ending",
        ],
    ];
    const SHOWN = new Set(RX.map(([, shown]) => 'Error: ' + shown));

    it('maps each engine sentence, as ReceiveByCode wraps it, to its own line', () => {
        for (const [engine, shown] of RX) {
            expect(friendlyError('transfer failed: ' + engine), engine).toBe('Error: ' + shown);
            // Bare, and behind the Error: prefix a rejected promise can carry.
            expect(friendlyError(engine), engine).toBe('Error: ' + shown);
            expect(friendlyError('Error: transfer failed: ' + engine), engine).toBe('Error: ' + shown);
        }
        // Ten sentences, ten different lines.
        expect(SHOWN.size).toBe(RX.length);
    });

    it('keeps the receive sentences D-123 left alone where they were', () => {
        // write-failed and disk-full keep the save-folder sentence their
        // "write error" prefix has always mapped to.
        const saveFolder = "Error: Can't write to the save folder";
        expect(friendlyError('transfer failed: write error: could not finish writing a file, so it was not kept')).toBe(saveFolder);
        expect(friendlyError('transfer failed: write error: the drive ran out of space, so the file was not kept')).toBe(saveFolder);
        // The receiver's two hash sentences, the bare stop of an empty code,
        // and a stop worded by some other build all pass through whole.
        for (const s of [
            'a file did not match the SHA-256 the sender computed, so it was not kept',
            "the sender's SHA-256 for a file could not be read, so the file was not kept",
            'receive stopped',
            'receive stopped: path-too-long',
            'receive stopped: something a later build says',
        ]) {
            expect(friendlyError('transfer failed: ' + s), s).toBe('Error: transfer failed: ' + s);
        }
    });

    it('never gives a sender-side sentence a receive line', () => {
        // What a desktop SENDER can be handed for the same events, quoted from
        // Go and the browser: PeerStoppedError.Error() for all twelve codes
        // and its fallback, and every reason a receiver puts on the wire
        // (RefusalCode.WireReason, the receive loop's own reasons, the
        // browser's HASH_*_REASON). All are written about the other side, so
        // none may come out as this side's receive line. Wrapped both ways a
        // send error reaches the status line.
        const senderSide = [
            'They declined. Nothing was sent.',
            'Their computer ran out of space.',
            'They did not answer in time. Nothing was sent.',
            'A file is too large for the drive they save to.',
            'A file changed or was damaged on the way, so their Floe deleted it.',
            'More data arrived than they accepted. If files changed after you chose them, ask them for a new link.',
            'A folder path is too long for their computer. Zip deeply nested folders first.',
            'Relayed drops are capped at 2 GB.',
            'A file arrived but their computer blocked saving it.',
            'They stopped this drop.',
            'This drop reached the 24-hour limit, so their Floe stopped it.',
            'Their computer could not save a file.',
            'The drop stopped on their computer.',
            'receiver declined the transfer',
            'receiver ran out of disk space',
            'receiver did not answer in time',
            'receiver cannot store a file this large on its drive',
            'receiver discarded a file because its SHA-256 did not match',
            'receiver got more data than it approved',
            'receiver cannot store a file path this deep or long',
            "receiver's relay connection is capped at 2 GB",
            'receiver could not move a finished file into place',
            'receiver stopped the transfer',
            'receiver stopped the transfer at the 24-hour limit',
            'receiver could not finish writing a file',
            'receiver could not create a file',
            'receiver cannot store a file path that is not relative to its save folder',
            "receiver discarded a file because the sender's SHA-256 was not readable",
            'receiver rejected the file description: control message is 2000 bytes, over the 1000-byte cap',
            'receiver stopped the transfer: sender exceeded the announced size of "a.bin"',
            'receiver discarded a file: incomplete file "a.bin": received 40 of 100 bytes',
            'transfer blocked: relay connections are capped at 2 GB (selected 2.5 GB)',
        ];
        for (const s of senderSide) {
            for (const wrapped of ['transfer failed: ' + s, 'transfer failed: error sending a.bin: ' + s]) {
                expect(SHOWN.has(friendlyError(wrapped)), wrapped).toBe(false);
            }
        }
    });
});

describe('a pasted request link', () => {
    // The engine's sentence (code.ErrRequestLink, shared with the CLI) and the
    // desktop's own line for it (CP2, D-167).
    const engine = 'That is a request link for sending files to someone. Open it in a web browser.';
    const cp2 = 'Request links open in a web browser';

    it('a request link error maps to the request link sentence before the code rule', () => {
        // The bare sentinel a current desktop returns (transfer.go returns
        // code.ErrRequestLink unwrapped), and the wrapped form an older build
        // produced, where 'could not resolve' comes first in the string and
        // used to win: "That code was not recognized" is the wrong advice for
        // a link that resolved perfectly well to "not a room link".
        expect(friendlyError(engine)).toBe('Error: ' + cp2);
        expect(
            friendlyError('could not resolve "https://floe.one/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f": ' + engine),
        ).toBe('Error: ' + cp2);
    });

    it('never echoes the pasted link, room id included', () => {
        const out = friendlyError('could not resolve "https://floe.one/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f": ' + engine);
        expect(out).not.toContain('Xk3p9Q0aB1c');
        expect(out).not.toContain('6f1c2b9e');
    });
});
