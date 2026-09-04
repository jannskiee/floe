// Package transfer implements the Floe data channel protocol for receiving files.
// See sender.go for the full protocol description.
package transfer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/schollz/progressbar/v3"
)

// Receive-loop stall watchdog. Before the first metadata the sender needs no
// human input and metadata is due about one RTT after the channel opens, so a
// silent 30 s means the transfer path is dead (the captured CI failure mode:
// both sides log Connected, then nothing). Mid-transfer the bar is higher:
// pion/sctp's retransmission timeout backs off toward 60 s on a lossy path and
// the sender's own backpressure abort uses a 60 s window, so anything shorter
// would kill transfers that are still legitimately recovering. Vars, not
// consts, so tests can shrink them.
var (
	receiveIdleTimeout  = 30 * time.Second
	receiveStallTimeout = 60 * time.Second
)

// FileInfo describes an incoming file (parsed from metadata message).
type FileInfo struct {
	ID         string
	FileName   string
	FileSize   int64
	Index      int
	Total      int
	TotalBytes int64
	Pv         int    // sender's highest protocol version (0 = legacy, treat as 1)
	PvMin      int    // sender's minimum protocol version (0 = legacy, treat as 1)
	Ver        string // sender's human release string, e.g. "v1.5.5"
}

// reportBytesToServer posts the received byte count to the server's stats
// endpoint after a successful transfer. Fire-and-forget: errors are silently
// ignored so a network hiccup never affects the transfer outcome.
func reportBytesToServer(serverURL string, byteCount int64) {
	if serverURL == "" {
		return
	}
	payload, _ := json.Marshal(map[string]int64{"bytes": byteCount})
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(serverURL+"/api/stats/report", "application/json", bytes.NewReader(payload))
	if err != nil {
		return
	}
	resp.Body.Close()
}

// IncomingInfo describes a transfer at the moment its first metadata arrives,
// before any file is created, any ack is sent, or any byte lands on disk.
type IncomingInfo struct {
	Files      int    `json:"files"`      // total files in the batch
	TotalBytes int64  `json:"totalBytes"` // batch size; falls back to the single file's size, 0 when the sender predates totalBytes
	FirstName  string `json:"firstName"`  // sender-supplied name of the first file after displayText (controls and bidi marks replaced, at most maxDisplayName runes); display only, NOT the on-disk name
}

// ReceiveOptions carries the optional callbacks for GUI clients. The zero
// value is the CLI behavior: terminal progress bar, no incoming preview.
// Callbacks run synchronously on the receive loop, so keep them fast.
type ReceiveOptions struct {
	OnProgress ProgressFunc
	OnIncoming func(IncomingInfo)
	// UpdateHint replaces the CLI-only local update instruction in protocol
	// compatibility errors. Leave empty for the default CLI wording.
	UpdateHint string
	// Messages and Closed come from peer.Connection.Early(), which wires the data
	// channel the instant it exists. Pass BOTH whenever the channel came from
	// peer.SetupAsReceiver: registering handlers here instead is a race against
	// pion's read loop, and the message it loses is the sender's first, so the
	// transfer hangs with both ends reporting a healthy connection. Leave both
	// nil only for a channel you created and left unhandled.
	Messages <-chan webrtc.DataChannelMessage
	Closed   <-chan struct{}
}

// ReceiveFiles handles the full receiving side of the Floe protocol.
// It blocks until all files are received. Files are written to outputDir.
// If autoAccept is false, the user is prompted before receiving begins.
// localVer is the human release string (e.g. "v1.5.5") embedded in the ack
// for the optional peer-version note; pass "" for dev builds or tests.
// serverURL is the signaling server base URL used to report transfer stats;
// pass "" to skip reporting (e.g. in tests).
func ReceiveFiles(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string) error {
	return ReceiveFilesWithOptions(dc, outputDir, autoAccept, localVer, serverURL, ReceiveOptions{})
}

// ReceiveFilesWithProgress is ReceiveFiles with a progress callback for GUI
// clients. When onProgress is non-nil, per-chunk progress is reported through it
// and the terminal progress bar is suppressed.
func ReceiveFilesWithProgress(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string, onProgress ProgressFunc) error {
	return ReceiveFilesWithOptions(dc, outputDir, autoAccept, localVer, serverURL, ReceiveOptions{OnProgress: onProgress})
}

// ReceiveFilesWithOptions is the full-featured receive entry point; the other
// two delegate here. opts.OnIncoming, when set, fires exactly once as the
// first metadata arrives, after the protocol compatibility check and before
// any file is created or acked.
func ReceiveFilesWithOptions(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string, opts ReceiveOptions) error {
	onProgress := opts.OnProgress
	// msgCh collects ALL incoming data channel messages, so the callback that
	// pion runs on its own goroutine feeds a sequential loop here.
	//
	// It comes from peer.Connection.Early() when the caller has one, and that is
	// the only correct source for a channel obtained from SetupAsReceiver: pion
	// ACKs the data channel and starts reading before the application is told
	// anything, so a handler registered here, at the top of the receive, can miss
	// the sender's first message. It is not late by much. It is late by enough.
	//
	// The fallback below is for callers that own the data channel themselves and
	// registered nothing, which in practice means the loopback tests.
	var msgCh <-chan webrtc.DataChannelMessage
	var done <-chan struct{}
	if opts.Messages != nil && opts.Closed != nil {
		msgCh, done = opts.Messages, opts.Closed
	} else {
		// done is closed when the data channel closes. We signal via a separate
		// channel instead of closing msgCh from OnClose: closing msgCh while the
		// OnMessage callback might still push would panic ("send on closed
		// channel"). The OnMessage send selects on done so it can never block or
		// panic after close.
		ch := make(chan webrtc.DataChannelMessage, 256)
		d := make(chan struct{})
		var closeOnce sync.Once
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			select {
			case ch <- msg:
			case <-d:
			}
		})
		dc.OnClose(func() {
			closeOnce.Do(func() { close(d) })
		})
		msgCh, done = ch, d
	}

	// Process messages sequentially
	var currentFile *os.File // the .part staging file the bytes are written to
	var currentInfo FileInfo
	var currentDisplayName string // displayText(currentInfo.FileName): every print, callback and error uses this, never the raw name
	var currentBase string        // safeJoin output; the de-collision sequence starts here
	var currentDest string        // final path claimed for the file (see claimPart)
	var currentSavedName string   // FINAL on-disk name, relative to outputDir (see Progress.SavedName)
	var bytesReceived int64
	var totalReceived int64
	var bar *progressbar.ProgressBar
	var start time.Time
	filesReceived := 0
	waitingForFirst := true

	// If the transfer is interrupted (peer disconnect, stall, or error) before
	// the "end" marker completes the current file, release the handle and
	// delete the .part staging file, freeing its claimed final name so a retry
	// can reuse it. Success is safe because the "end" handler closes and nils
	// currentFile before any return, so anything still non-nil here is a
	// staging file by definition; files that completed earlier in the batch
	// were renamed to their final names and are never touched. Close before
	// Remove (Windows refuses to delete an open file), and Remove is
	// best-effort so a sharing violation from an AV scanner never masks the
	// real transfer error. Directories created for folder transfers are left
	// in place.
	defer func() {
		if currentFile != nil {
			// discardPart, not a Close and Remove here: the unregister-then-Close
			// ordering is what keeps this from deleting another transfer's file,
			// and it is argued once, on the function.
			discardPart(currentFile)
		}
	}()

	// Stall watchdog: armed only while the loop is actually blocked on an
	// empty msgCh, so it measures exactly "no data for this long" and can
	// never fire while messages are flowing. The interactive accept prompt
	// runs synchronously inside the metadata case below, outside any select,
	// so a slow human can never trip it either.
	stallTimer := time.NewTimer(receiveIdleTimeout)
	defer stallTimer.Stop()

	for {
		// Prefer draining buffered messages over reacting to a close: a normal
		// transfer ends with the final "end" marker already queued in msgCh,
		// which must be processed even if OnClose has fired alongside it.
		var msg webrtc.DataChannelMessage
		select {
		case msg = <-msgCh:
		default:
			// Bare Reset without a Stop/drain is correct under the Go 1.23+
			// timer semantics this module's go directive activates; lowering
			// the directive (or GODEBUG=asynctimerchan=1) would let a stale
			// expiry misfire the very next select.
			if waitingForFirst {
				stallTimer.Reset(receiveIdleTimeout)
			} else {
				stallTimer.Reset(receiveStallTimeout)
			}
			select {
			case msg = <-msgCh:
			case <-done:
				// Channel closed before the transfer finished normally. A close
				// with no completed files is never success: the sender cancelled
				// or was blocked (for example by its relay size cap), so report
				// it instead of returning a false "saved" outcome.
				return closedError(currentFile, currentDisplayName, bytesReceived, currentInfo, filesReceived)
			case <-stallTimer.C:
				// If the close raced the timer, report the close: it is the
				// more precise diagnosis, and it keeps behavior identical to
				// the done case above.
				select {
				case <-done:
					return closedError(currentFile, currentDisplayName, bytesReceived, currentInfo, filesReceived)
				default:
				}
				// Phase-aware stall errors. Deliberately no protocol or
				// version phrasing: the "floe update" hint belongs to the
				// incompatible path only.
				switch {
				case waitingForFirst:
					return fmt.Errorf("connected, but no data arrived from the sender within %s", receiveIdleTimeout)
				case currentFile != nil:
					return fmt.Errorf("transfer stalled: no data for %s (%d of %d bytes of %q)",
						receiveStallTimeout, bytesReceived, currentInfo.FileSize, currentDisplayName)
				default:
					return fmt.Errorf("transfer stalled: no data for %s (%d of %d files received)",
						receiveStallTimeout, filesReceived, currentInfo.Total)
				}
			}
		}

		// A string is never file data (the `if msg.IsString { continue }` rule
		// below is what proves it), so a string past the control cap is not
		// something to write and not something to parse: it is a peer sending
		// prose where a control message belongs. Fail loudly rather than skip
		// it: skipping leaves the sender waiting on an ack that never comes and
		// this side to the stall watchdog, whereas returning lets the caller's
		// deferred Close reach the sender within a second. Over-cap BINARY is
		// file data and falls through to classifyControl, which declines it.
		if msg.IsString && len(msg.Data) > controlMsgMax {
			rejectDescription(dc, localVer, fmt.Sprintf("control message is %d bytes, limit %d", len(msg.Data), controlMsgMax))
			return fmt.Errorf("rejected the sender's control message: %d bytes, limit %d", len(msg.Data), controlMsgMax)
		}

		// Decide whether this is a Floe control message (metadata/end) or file
		// data. Only recognized control types are consumed as control — a small
		// binary chunk that merely happens to be a JSON object is file data and
		// must be written, never dropped.
		msgType, isControl := classifyControl(msg.Data)
		if isControl {
			switch msgType {

			case "metadata":
				// A new file is starting
				info, err := parseMetadata(string(msg.Data))
				if err != nil {
					// classifyControl already proved this is a metadata object, so a failure
					// here is a sender whose numbers cannot be right (a negative size, a size
					// past 2^53). This used to `continue`, which left the sender waiting on an
					// ack that never came and this side to the stall watchdog. Returning lets
					// the caller's deferred Close reach the sender within a second.
					rejectDescription(dc, localVer, err.Error())
					return fmt.Errorf("rejected the sender's file description: %w", err)
				}
				// A second metadata while a file is still open means the sender
				// abandoned the current file without an "end". Close and delete
				// the .part staging file before starting the next one, or the
				// handle leaks and the abandoned staging file lingers, keeping
				// its claimed final name blocked.
				if currentFile != nil {
					discardPart(currentFile)
					currentFile = nil
				}
				currentInfo = info
				// The one display form of the name. safeJoin below derives the
				// on-disk name from the raw info.FileName under different rules
				// (Windows reserved characters, trailing trims, a length that is
				// a compatibility surface), so the two may differ; SavedName
				// carries the on-disk one.
				currentDisplayName = displayText(info.FileName, maxDisplayName)
				bytesReceived = 0

				// On first file: check compat, show summary, and optionally prompt
				if waitingForFirst {
					waitingForFirst = false
					start = time.Now()

					// Protocol compatibility check - before creating any files or
					// prompting the user. Send "incompatible" so the sender fails
					// fast with a clear message rather than waiting for an ack.
					ok, localTooOld := CheckCompat(MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv)
					if !ok {
						errMsg := compatErrorMessage(localTooOld, localVer, info.Ver,
							MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv, opts.UpdateHint)
						peerErrMsg := peerCompatErrorMessage(localTooOld, localVer, info.Ver,
							MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv)
						incompat := incompatibleMsg{
							Type:   "incompatible",
							Reason: peerErrMsg,
							Pv:     ProtocolVersion,
							PvMin:  MinProtocolVersion,
							Ver:    localVer,
						}
						incompatJSON, _ := json.Marshal(incompat)
						dc.Send([]byte(incompatJSON))
						return fmt.Errorf("%s", errMsg)
					}

					// Optional informational note when release versions differ
					if info.Ver != "" && localVer != "" && info.Ver != localVer {
						fmt.Printf("  Peer version: %s\n", displayText(info.Ver, maxDisplayVer))
					}

					var incomingLabel string
					switch {
					case info.Total == 1:
						incomingLabel = currentDisplayName + " · " + formatBytes(info.FileSize)
					case info.TotalBytes > 0:
						incomingLabel = pluralize(info.Total, "file") + " · " + formatBytes(info.TotalBytes)
					default:
						incomingLabel = pluralize(info.Total, "file")
					}
					fmt.Println()
					PrintBox([][2]string{{"Incoming", incomingLabel}})
					fmt.Println()

					if opts.OnIncoming != nil {
						tb := info.TotalBytes
						if info.Total == 1 && tb == 0 {
							tb = info.FileSize // legacy sender: the single file's size is still known
						}
						opts.OnIncoming(IncomingInfo{Files: info.Total, TotalBytes: tb, FirstName: currentDisplayName})
					}

					if !autoAccept {
						fmt.Print("  Accept? [Y/n] ")
						var answer string
						fmt.Scanln(&answer)
						answer = strings.TrimSpace(strings.ToLower(answer))
						if answer == "n" || answer == "no" {
							dc.Close()
							return fmt.Errorf("transfer declined")
						}
					}
				}

				// Claim a final name and open its .part staging file (create
				// parent dirs for folder transfers first). Bytes go to the
				// staging file; the final name is taken only by the rename in
				// the "end" handler, so a kill at any moment leaves nothing on
				// disk that looks complete.
				currentBase = safeJoin(outputDir, info.FileName)
				if err := os.MkdirAll(filepath.Dir(currentBase), 0755); err != nil {
					return fmt.Errorf("cannot create directory: %w", err)
				}
				currentFile, currentDest, err = claimPart(currentBase)
				if err != nil {
					return fmt.Errorf("cannot create file %s: %w", currentBase, err)
				}
				registerPartial(currentFile)
				// Refuse anything that is not a regular file. claimPart already
				// Lstats each final-name candidate and commitPart stats the
				// placeholder it creates, so this is defense in depth on the
				// staging handle itself: cheap, and it keeps the guarantee even
				// if those checks are ever reshaped.
				// A failed Stat is not treated as a failure: the file is already
				// open and writable, and refusing on a stat hiccup would break a
				// transfer that would otherwise succeed.
				if st, statErr := currentFile.Stat(); statErr == nil && !st.Mode().IsRegular() {
					// Read the name before discarding: discardPart closes the handle.
					name := currentFile.Name()
					discardPart(currentFile)
					currentFile = nil
					return fmt.Errorf("refusing to write %s: not a regular file (%s)",
						name, st.Mode())
				}
				// The FINAL name claimed for this file, which differs from the
				// sender's whenever claimPart de-collided or safeJoin sanitized.
				// Everything user-facing below reports this name, never the
				// .part staging name, so progress lines and history read as the
				// file the user will end up with. The fallback is the claimed
				// path's own base name, never the sender's string: Rel fails
				// only when the two paths are on different volumes, and the
				// name is still whatever claimPart wrote.
				currentSavedName = filepath.ToSlash(filepath.Base(currentDest))
				if rel, relErr := filepath.Rel(outputDir, currentDest); relErr == nil {
					currentSavedName = filepath.ToSlash(rel)
				}

				// Progress bar for this file (CLI). GUIs get callback updates instead.
				if onProgress == nil {
					bar = newProgressBar(info.FileSize, info.Index, info.Total, currentSavedName)
				}

				// Send ack as BINARY with protocol version fields so the sender
				// can verify compat from its side and show the optional peer-version
				// note. The browser checks data.byteLength before decoding, which is
				// only defined on ArrayBuffer/Buffer, not strings.
				ack := map[string]interface{}{
					"type":   "ack",
					"id":     info.ID,
					"offset": 0,
					"pv":     ProtocolVersion,
					"pvMin":  MinProtocolVersion,
				}
				if localVer != "" {
					ack["ver"] = localVer
				}
				ackJSON, _ := json.Marshal(ack)
				dc.Send([]byte(ackJSON))

			case "end":
				// Current file is complete
				if currentFile != nil {
					staged := currentFile
					partPath := staged.Name()
					// Unregister FIRST: from this line an abandon can no longer
					// touch this file. Then the flush and close double as the
					// OWNERSHIP PROOF for the path: AbandonPartials closes a
					// registered file before removing its path, so if our own
					// Sync and Close both succeed, no abandon ever touched the
					// handle, the .part at partPath is still OUR file, and the
					// rename below cannot steal a path that a newer transfer
					// re-claimed after an abandon freed it (a torture test
					// proved exactly that theft when the commit trusted the
					// path string alone). If either call fails, the transfer
					// was abandoned mid-flight: the path is not ours, so leave
					// it alone entirely and report the abort.
					unregisterPartial(staged)
					syncErr := staged.Sync()
					closeErr := staged.Close()
					currentFile = nil
					fmt.Println()
					if syncErr != nil || closeErr != nil {
						return fmt.Errorf("transfer abandoned while completing %q", currentSavedName)
					}

					// Integrity guard: a short byte count means the transfer was
					// truncated (e.g. the sender closed early). Fail loudly rather
					// than leave a corrupt file that looks complete. The handle is
					// already closed and nil'd above (required before Remove on
					// Windows), so the interrupt cleanup cannot see this truncated
					// staging file; delete it here.
					if bytesReceived != currentInfo.FileSize {
						_ = os.Remove(partPath)
						return fmt.Errorf("incomplete file %q: received %d of %d bytes",
							currentDisplayName, bytesReceived, currentInfo.FileSize)
					}

					// Mark the file as internet-sourced (Windows MOTW) so
					// SmartScreen / Office Protected View apply when it is opened,
					// like a browser download. Best-effort and Windows-only.
					// Applied to the .part BEFORE the rename: the Zone.Identifier
					// stream travels with a same-volume rename, so the final name
					// never exists for even an instant without its zone tag.
					_ = applyMOTW(partPath)

					// Publish the verified bytes at the final name. On failure the
					// staging file is deliberately left in place: the bytes are
					// complete and verified, and deleting them over a transient
					// AV lock would be data loss.
					finalPath, commitErr := commitPart(partPath, currentDest, currentBase)
					if commitErr != nil {
						return fmt.Errorf("received %q in full but could not finish saving it: %w",
							currentSavedName, commitErr)
					}

					// External interference only: something claimed the final name
					// between our claim and the commit, so the file landed under a
					// numbered sibling. Correct everything that reported the name.
					if rel, relErr := filepath.Rel(outputDir, finalPath); relErr == nil {
						if s := filepath.ToSlash(rel); s != currentSavedName {
							currentSavedName = s
							if onProgress != nil {
								onProgress(Progress{
									FileName:   currentDisplayName,
									FileIndex:  currentInfo.Index,
									FileCount:  currentInfo.Total,
									FileBytes:  bytesReceived,
									FileSize:   currentInfo.FileSize,
									TotalBytes: totalReceived,
									GrandTotal: currentInfo.TotalBytes,
									SavedName:  currentSavedName,
								})
							} else {
								fmt.Printf("  Saved as %s\n", currentSavedName)
							}
						}
					}

					filesReceived++
					if filesReceived >= currentInfo.Total {
						elapsed := time.Since(start)
						timeVal := formatDuration(elapsed)
						if spd := formatSpeed(float64(totalReceived) / elapsed.Seconds()); spd != "" {
							timeVal += " · avg " + spd
						}
						printSummary([][2]string{
							{"Received", fmt.Sprintf("%s (%s)", pluralize(filesReceived, "file"), formatBytes(totalReceived))},
							{"Time", timeVal},
							{"Saved to", outputDir},
						})

						// Tell the sender all bytes are written and verified so it
						// can close cleanly without relying on SCTP buffer accounting.
						// Sent as binary so the browser (which checks byteLength) can
						// classify it and ignore it; CLI senders consume it explicitly.
						receivedMsg, _ := json.Marshal(map[string]string{"type": "received"})
						dc.Send([]byte(receivedMsg))

						// Wait for the sender to close the channel (or a short grace
						// period) before returning. This keeps our SCTP/DTLS alive
						// long enough for the "received" SACK to reach the sender —
						// tearing down immediately would race it.
						select {
						case <-done:
						case <-time.After(5 * time.Second):
						}

						// Report total bytes to the global stats counter. Called
						// synchronously AFTER the grace wait so the program does not
						// exit before the HTTP POST completes. reportBytesToServer
						// has its own 5 s timeout and is fire-and-forget on error.
						reportBytesToServer(serverURL, totalReceived)
						return nil
					}
				}
			}
			continue
		}

		// A string that wasn't a recognized control message is never file data.
		if msg.IsString {
			continue
		}

		// Binary chunk — write directly to disk
		if currentFile == nil {
			continue // no file open yet; shouldn't happen in normal flow
		}
		// Hold the sender to the size it announced, frame by frame. The "end"
		// handler already refuses a byte count that differs, but only once
		// every byte has been written, so a sender that simply never stops
		// could fill the disk first. Failing on the first frame that would
		// cross the line bounds the damage to the announced size, and the
		// deferred cleanup removes the .part.
		if bytesReceived+int64(len(msg.Data)) > currentInfo.FileSize {
			return fmt.Errorf("sender exceeded the announced size of %q", currentDisplayName)
		}
		n, err := currentFile.Write(msg.Data)
		if err != nil {
			return fmt.Errorf("write error: %w", err)
		}
		bytesReceived += int64(n)
		totalReceived += int64(n)
		if bar != nil {
			bar.Add(n)
		} else {
			onProgress(Progress{
				FileName:   currentDisplayName,
				FileIndex:  currentInfo.Index,
				FileCount:  currentInfo.Total,
				FileBytes:  bytesReceived,
				FileSize:   currentInfo.FileSize,
				TotalBytes: totalReceived,
				GrandTotal: currentInfo.TotalBytes,
				SavedName:  currentSavedName,
			})
		}
	}
}

// closedError judges a closed connection: nil when everything the sender
// announced actually arrived, and the most specific diagnosis otherwise.
// Two verbatim copies of this ladder lived twenty lines apart, one in the
// done case and one in the stall timer's race-with-close check, which is two
// places to get "was this a clean finish?" wrong.
func closedError(currentFile *os.File, displayName string, bytesReceived int64, info FileInfo, filesReceived int) error {
	if currentFile != nil {
		return fmt.Errorf("connection closed mid-transfer: %s (%d of %d bytes)",
			displayName, bytesReceived, info.FileSize)
	}
	if filesReceived == 0 {
		return fmt.Errorf("connection closed before any file arrived (the sender canceled, or the transfer was blocked)")
	}
	if info.Total > 0 && filesReceived < info.Total {
		return fmt.Errorf("connection closed after %d of %d files", filesReceived, info.Total)
	}
	return nil
}
