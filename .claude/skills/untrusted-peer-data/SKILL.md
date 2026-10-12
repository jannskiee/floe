---
name: 'untrusted-peer-data'
description: "Use before touching any value the remote peer chose (fileName, fileSize, totalBytes, total, index, id, offset, ver, pv, pvMin, reason, code, saved, sha256, verified, confirms in metadata, ack, end, received or incompatible; an SDP or candidate; the signaling server's role and error text; a request link) wherever it is displayed, logged, stored, written or compared (file lists, history rows, notifications, paths, the Accept prompt, refusal cards), or when adding any wire field (a checksum, a hash, a size). Not for files the local user picked to send. Covers cli/engine, cli/cmd/floe, cli/internal, client/lib, client/components, client/hooks, desktop/transfer.go, reveal.go, requestlink.go, requestauto.go and desktop/frontend; every sink on CLI, desktop and browser with its treatment."
---

# Untrusted peer data

Five messages cross the data channel: metadata, ack, end, received and incompatible. In
Go they are metadataMsg, ackMsg and endMsg (cli/engine/transfer/sender.go),
incompatibleMsg (protocol.go) and a received frame with no struct (receiver.go builds it,
parseReceived reads it); the browser mirrors them as Metadata, Ack, End, Received and
Incompatible in client/lib/transfer/protocol.ts. Every field is chosen by the other
machine. So are an SDP, the signaling server's answers, and a request link, which the
other party wrote. Decoding validates nothing: classifyControl casts parsed JSON to the
interface and json.Unmarshal fills the Go struct. Validation is a named function where the
value enters: parseMetadata and byteCount, parseEnd, parseReceived, parseAckConfirms,
ParseRefusalCode and the receiver limits in limits.go (Go); metadataProblem,
normalizeFileSize, normalizeSha256, verifiedCountOf, ackConfirmsOf and refusalCodeOf
(browser). The invariant: a peer value is safe at a sink only because THAT sink applied
THAT sink's treatment. A value carries no "already sanitized" flag, and the engine's
callbacks being display-safe does not make the browser's own copy of the same field safe.

## Sink kinds and the treatment each needs

| Sink             | Treatment                                                                                                                                                                                                                                                                                                 | Helper (by symbol)                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| disk             | per-component sanitize + traversal filter, then the path shape limit on every Go receiver (32 components, 240 UTF-16 units, never a drive or a root). Request links add the `.floe-blocked` rename: a file type Windows Explorer parses on sight is saved under a name it will not parse                  | Go: safeJoin -> sanitizeComponent (sanitize.go), checkPathShape (limits.go), blockShellTypes (blockshell.go); desktop OpenFile/RevealFile -> safeLeaf (reveal.go); browser: sanitizeFileName for the download attribute, sanitizeZipEntryName for archives (download.ts) |
| screen, terminal | displayText before any fmt.Printf / PrintBox / error string (format.go); shares sanitizeRune with the disk sanitizer                                                                                                                                                                                      | displayText, maxDisplayName / maxDisplayVer / maxDisplayReason                                                                                                                                           |
| screen, GUI      | desktop values on recv:incoming / recv:progress / send:error arrive display-safe from the engine (currentDisplayName); browser sanitizes at render (sanitizeFileName in ReceivedFilesList and useDownloadManager, sanitizeDisplayText in the error paths). The request link's Accept prompt is numbers only: RequestPrompt has no field for a visitor string, so a count and a size are all it can show | currentDisplayName (receiver.go), sanitizeDisplayText (download.ts), requestPromptFor (desktop/transfer.go)                                                                                              |
| object key       | Map, or Object.create(null) plus the `__proto__` rename (buildZipEntries); Go maps are safe                                                                                                                                                                                                               | buildZipEntries, sanitizeZipEntryName                                                                                                                                                                    |
| number           | Go: byteCount (>= 0, integer, <= 2^53-1) and index/total >= 1 in parseMetadata; browser: metadataProblem and normalizeFileSize; formatBytes guards <= 0. A count the peer reports is clamped or range-checked against this side's own total: saved is clamped to [0, total]; verified is range-checked and never clamped, so an over-claim cannot read as "all matched" | byteCount, maxAnnouncedSize, normalizeFileSize, formatBytes, savedCountIn, clampCount, parseReceived, verifiedCountOf                                                                                    |
| enum             | allowlist, then fixed copy: a refusal code is only ever a key. An unknown, missing or wrongly typed one falls to the fixed fallback sentence, and neither the code nor the peer's reason is printed                                                                                                       | ParseRefusalCode, refusalCodeOf, REFUSAL_TITLES (visitorCopy.ts), stoppedCard (requestCopy.ts)                                                                                                           |
| digest compare   | sha256 on end: a present value that is not 64 lowercase hex is a refusal, never "absent"; a valid one is compared with this side's own digest, and a mismatch refuses hash-mismatch and deletes the file                                                                                                  | parseEnd, validSHA256Hex, normalizeSha256                                                                                                                                                                |
| parse, compare   | validate the format once where it enters, and malformed means reject the transfer. Both sides do: metadataProblem is parseMetadata's twin and refuses a fileSize that is not a byte count (only an absent size stays unknown). A value that passed needs no per-sink treatment, and the validator is the row's anchor | parseMetadata, metadataProblem, fileId / ack.ID                                                                                                                                                          |
| log              | one log sink exists: pion's own loggers, all built by newLoggerFactory, which escapes controls and format characters line by line. Add no other: no fmt.Print / console.\* of a peer field outside the display paths above (exempt by grep, not by assertion). The test harnesses under cli/internal print JSON lines to stdout that reach CI logs: numbers and allowlisted codes only | newLoggerFactory, EscapeText (cli/engine/peer/logging.go)                                                                                                                                                |
| telemetry        | Umami and Sentry get counts and enums only (files, bytes, connection type), never a peer string                                                                                                                                                                                                           | track (P2PTransfer.tsx)                                                                                                                                                                                  |
| notification     | never. Desktop notifications are constant strings (notify / notifyTransferFailed in app.go); the request lane reaches them only through notifyRequest, which picks one fixed pair from requestToastText                                                                                                   | notify, notifyTransferFailed, notifyRequest (requestlink.go)                                                                                                                                             |
| persisted        | desktop localStorage['floe:history'] stores names and re-renders them later, so stored = displayed today; a field that is stored but not shown still counts as a sink and needs a row. The engine's SavedName/FileName are already display-safe; entries stored before 2026-08-28 keep whatever they held. A request drop adds one row through requestHistoryEntry (saved names capped at 200, counts, the stop code). The browser's sessionStorage['floe:r-lost'] holds two of the visitor's own counts, never a name or the link | recvNamesRef, floe:history (App.tsx), requestHistoryEntry (history.ts), LOST_KEY (lostRecord.ts)                                                                                                         |

Labels the map uses that carry no treatment of their own: wire, callback, network and
state name where a value goes next, and control is a value that only steers this side's
own flow. validator marks the function a parse row points at. stdout is a test
harness's JSON line (treat it as a log sink). test is a reviewed test or fuzz target
that feeds hostile values to a real consumer and lets nothing out. The row's Treatment
column says what, if anything, happens there.

## Decisions the map records

Some rows are a decision, not a description, and a change that crosses one
needs the owner first. The request link's Accept prompt shows numbers only
(OD-04 in the consumer map's `RequestPrompt` rows), and
docs/desktop/request-links.mdx promises it: "It never shows a file name or
any other text the sender chose." A feature that puts a visitor's string in
that prompt or in a notification reverses both. Stop and ask before building
it; it is not one more row.

## Procedure

1. Name the field(s) and the message they ride on. Adding a field: add it to both
   wire structs (Go and TS) in the same PR; add it to FIELDS in
   scripts/check-consumers.mjs (a `word` token for a wire-unique name, a `member` token
   such as `.hash` for a common one; a member token only avoids test-file noise, the
   real filter is the `no` rows you will write for unrelated matches); cost a new
   string field against controlMsgMax / CONTROL_MSG_MAX (1000 bytes): a 64-hex hash
   plus its key is about 73 bytes taken from the fileName envelope, and an over-cap
   string metadata now fails the transfer (free text such as a note does not
   fit beside a long name, so it needs a message and a cap of its own, which is
   a protocol decision); and decide whether ProtocolVersion moves
   (CLAUDE.md, Transfer Protocol Versioning, and the concrete test in the header
   comment of cli/engine/transfer/protocol.go: "a mandatory new field old receivers
   cannot ignore").
2. Run `node .claude/skills/untrusted-peer-data/scripts/check-consumers.mjs`. Green
   means every file that references a peer field is in the map and every mapped
   anchor still exists. It does not mean the rows are right, and a new field inside an
   already mapped file prints nothing: go on to step 3 regardless. `--strict-tests`
   turns the unmapped-test warnings into failures; `--root <dir>` points it at another
   checkout. CI runs it on every PR (the `Peer-data consumer map` step of the
   `Repo guardrails` job, inside the `CI green` gate). It reads `.go`, `.ts` and `.tsx`
   under cli/engine, cli/cmd, cli/internal, client/lib, client/components, client/hooks,
   desktop (not its build folder) and desktop/frontend/src. It never reads client/app,
   server/ (JavaScript) or client/e2e, and it has no token for total, index, id or
   offset: a sink there, or a file that reads only those, needs a row written by hand.
3. Open references/consumer-map.md, filter to the field. For each row, read the code
   at the Anchor symbol and confirm the Treatment column is still true. Classify every
   sink you add with the table above and add a row. For a brand-new field no rows exist
   yet: filter by message instead (the metadataMsg / Metadata rows) and by the sibling
   validator (byteCount / normalizeFileSize), and copy their shape.
4. Three-surface rule: the change is not done until CLI, desktop and browser each have
   it, or the PR body records why a surface is exempt ("browser has no disk sink" is a
   valid reason; "did not look" is not). references/prior-fixes.md shows what skipping
   a surface cost last time.
5. Update the map in the same PR. Rows for deleted code go; a local value that becomes
   peer-derived flips Peer? to yes.
6. In the PR test plan, say the checker went green AND list the rows you verified by
   hand. Prove each new regression test fails without the fix. A green checker is a
   staleness check, not proof of completeness: it cannot see a new sink inside an
   already mapped file.

Regression test homes: TestSanitizeComponent, TestDisplayText, hostile_test.go (Go);
download.test.ts, receiver.test.ts, receiverHash.test.ts (the per-file SHA-256 checks),
sender.test.ts, protocol.test.ts (classifyControl and the message builders) (browser); incoming.test.ts / errors.test.ts (desktop).
normalizeFileSize has no unit test today: a gap, not a home.
