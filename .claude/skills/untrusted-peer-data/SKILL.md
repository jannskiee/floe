---
name: 'untrusted-peer-data'
description: "Use before touching any value that arrived from the remote peer (fileName, fileSize, totalBytes, total, index, id, offset, ver, reason in metadata, ack, end or incompatible) wherever it is displayed, logged, stored or written (received-file lists, history rows, notifications, paths), or when adding any wire field (a checksum, a hash, a size). Not for the sender's own selected files. Covers cli/engine/transfer, client/lib/transfer, download.ts, desktop/app.go and desktop/frontend; every sink on CLI, desktop and browser with its treatment."
---

# Untrusted peer data

Every field of metadataMsg, ackMsg and endMsg (cli/engine/transfer/sender.go) and
incompatibleMsg (protocol.go), mirrored by Metadata, Ack, End and Incompatible in
client/lib/transfer/protocol.ts, is chosen by the other machine. classifyControl casts
parsed JSON straight to the interface and json.Unmarshal fills the Go struct: nothing
validates on the way in except the size checks in parseMetadata (Go) and
normalizeFileSize (browser). The invariant: a peer value is safe at a sink only
because THAT sink applied THAT sink's treatment. A value carries no "already
sanitized" flag, and the engine's callbacks being display-safe does not make the
browser's own copy of the same field safe.

## Sink kinds and the treatment each needs

| Sink             | Treatment                                                                                                                                                                                                                                                                                                 | Helper (by symbol)                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| disk             | per-component sanitize + traversal filter                                                                                                                                                                                                                                                                 | Go: safeJoin -> sanitizeComponent (receiver.go); desktop OpenFile/RevealFile -> safeLeaf (app.go); browser: sanitizeFileName for the download attribute, sanitizeZipEntryName for archives (download.ts) |
| screen, terminal | displayText before any fmt.Printf / PrintBox / error string (format.go); shares sanitizeRune with the disk sanitizer                                                                                                                                                                                      | displayText, maxDisplayName / maxDisplayVer / maxDisplayReason                                                                                                                                           |
| screen, GUI      | desktop values on recv:incoming / recv:progress / send:error arrive display-safe from the engine (currentDisplayName); browser sanitizes at render (sanitizeFileName in ReceivedFilesList and useDownloadManager, sanitizeDisplayText in the error paths)                                                 | currentDisplayName (receiver.go), sanitizeDisplayText (download.ts)                                                                                                                                      |
| object key       | Map, or Object.create(null) plus the `__proto__` rename (buildZipEntries); Go maps are safe                                                                                                                                                                                                               | buildZipEntries, sanitizeZipEntryName                                                                                                                                                                    |
| number           | Go: byteCount (>= 0, integer, <= 2^53-1) and index/total >= 1 in parseMetadata; browser: normalizeFileSize; formatBytes guards <= 0                                                                                                                                                                       | byteCount, maxAnnouncedSize, normalizeFileSize, formatBytes                                                                                                                                              |
| parse, compare   | validate the format once where it enters, and malformed means reject the transfer (Go byteCount does; the browser should reject too rather than degrade the way normalizeFileSize does); a value that passed needs no per-sink treatment, and the validator is the row's anchor                           | byteCount, normalizeFileSize, fileId / ack.ID                                                                                                                                                            |
| log              | no log sink exists in the transfer path today; keep it that way. Exempt by grep (no fmt.Print / console.\* of a peer field outside the display paths above), not by assertion                                                                                                                             | none                                                                                                                                                                                                     |
| telemetry        | Umami and Sentry get counts and enums only (files, bytes, connection type), never a peer string                                                                                                                                                                                                           | track (P2PTransfer.tsx)                                                                                                                                                                                  |
| notification     | never. Desktop notifications are constant strings (notify / notifyTransferFailed in app.go); keep it that way                                                                                                                                                                                             | notify, notifyTransferFailed                                                                                                                                                                             |
| persisted        | desktop localStorage['floe:history'] stores names and re-renders them later, so stored = displayed today; a field that is stored but not shown still counts as a sink and needs a row. The engine's SavedName/FileName are already display-safe; entries stored before 2026-08-28 keep whatever they held | recvNamesRef, floe:history (App.tsx)                                                                                                                                                                     |

The finer labels the map uses (wire, callback, network, state) name where a value goes
next and carry no treatment of their own; telemetry is the exception and has its row
above. The row's Treatment column says what, if anything, happens there.

## Procedure

1. Name the field(s) and the message they ride on. Adding a field: add it to both
   wire structs (Go and TS) in the same PR; add it to FIELDS in
   scripts/check-consumers.mjs (a `word` token for a wire-unique name, a `member` token
   such as `.hash` for a common one; a member token only avoids test-file noise, the
   real filter is the `no` rows you will write for unrelated matches); cost a new
   string field against controlMsgMax / CONTROL_MSG_MAX (1000 bytes): a 64-hex hash
   plus its key is about 73 bytes taken from the fileName envelope, and an over-cap
   string metadata now fails the transfer; and decide whether ProtocolVersion moves
   (CLAUDE.md, Transfer Protocol Versioning, and the concrete test in the header
   comment of cli/engine/transfer/protocol.go: "a mandatory new field old receivers
   cannot ignore").
2. Run `node .claude/skills/untrusted-peer-data/scripts/check-consumers.mjs`. Green
   means every file that references a peer field is in the map and every mapped
   anchor still exists. It does not mean the rows are right, and a new field inside an
   already mapped file prints nothing: go on to step 3 regardless. `--strict-tests`
   turns the unmapped-test warnings into failures; `--root <dir>` points it at another
   checkout.
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
download.test.ts, transfer.test.ts, protocol.test.ts (classifyControl and the message
builders) (browser); incoming.test.ts / errors.test.ts (desktop). normalizeFileSize has
no unit test today: a gap, not a home.
