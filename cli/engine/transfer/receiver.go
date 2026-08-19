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
	"runtime"
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
	FirstName  string `json:"firstName"`  // sender-supplied name of the first file (display only, NOT the on-disk name)
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
	var currentBase string      // safeJoin output; the de-collision sequence starts here
	var currentDest string      // final path claimed for the file (see claimPart)
	var currentSavedName string // FINAL on-disk name, relative to outputDir (see Progress.SavedName)
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
			name := currentFile.Name()
			currentFile.Close()
			_ = os.Remove(name)
			unregisterPartial(currentFile)
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
				if currentFile != nil {
					return fmt.Errorf("connection closed mid-transfer: %s (%d of %d bytes)",
						currentInfo.FileName, bytesReceived, currentInfo.FileSize)
				}
				if filesReceived == 0 {
					return fmt.Errorf("connection closed before any file arrived (the sender canceled, or the transfer was blocked)")
				}
				if currentInfo.Total > 0 && filesReceived < currentInfo.Total {
					return fmt.Errorf("connection closed after %d of %d files", filesReceived, currentInfo.Total)
				}
				return nil
			case <-stallTimer.C:
				// If the close raced the timer, report the close: it is the
				// more precise diagnosis, and it keeps behavior identical to
				// the done case above.
				select {
				case <-done:
					if currentFile != nil {
						return fmt.Errorf("connection closed mid-transfer: %s (%d of %d bytes)",
							currentInfo.FileName, bytesReceived, currentInfo.FileSize)
					}
					if filesReceived == 0 {
						return fmt.Errorf("connection closed before any file arrived (the sender canceled, or the transfer was blocked)")
					}
					if currentInfo.Total > 0 && filesReceived < currentInfo.Total {
						return fmt.Errorf("connection closed after %d of %d files", filesReceived, currentInfo.Total)
					}
					return nil
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
						receiveStallTimeout, bytesReceived, currentInfo.FileSize, currentInfo.FileName)
				default:
					return fmt.Errorf("transfer stalled: no data for %s (%d of %d files received)",
						receiveStallTimeout, filesReceived, currentInfo.Total)
				}
			}
		}

		// Decide whether this is a Floe control message (metadata/end) or file
		// data. Only recognized control types are consumed as control — a small
		// binary chunk that merely happens to be a JSON object is file data and
		// must be written, never dropped.
		msgType, isControl := classifyControl(msg.Data, msg.IsString)
		if isControl {
			switch msgType {

			case "metadata":
				// A new file is starting
				info, err := parseMetadata(string(msg.Data))
				if err != nil {
					continue
				}
				// A second metadata while a file is still open means the sender
				// abandoned the current file without an "end". Close and delete
				// the .part staging file before starting the next one, or the
				// handle leaks and the abandoned staging file lingers, keeping
				// its claimed final name blocked.
				if currentFile != nil {
					name := currentFile.Name()
					currentFile.Close()
					_ = os.Remove(name)
					unregisterPartial(currentFile)
					currentFile = nil
				}
				currentInfo = info
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
						fmt.Printf("  Peer version: %s\n", info.Ver)
					}

					var incomingLabel string
					switch {
					case info.Total == 1:
						incomingLabel = info.FileName + " · " + formatBytes(info.FileSize)
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
						opts.OnIncoming(IncomingInfo{Files: info.Total, TotalBytes: tb, FirstName: info.FileName})
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
					name := currentFile.Name()
					currentFile.Close()
					_ = os.Remove(name)
					unregisterPartial(currentFile)
					currentFile = nil
					return fmt.Errorf("refusing to write %s: not a regular file (%s)",
						name, st.Mode())
				}
				// The FINAL name claimed for this file, which differs from the
				// sender's whenever claimPart de-collided or safeJoin sanitized.
				// Everything user-facing below reports this name, never the
				// .part staging name, so progress lines and history read as the
				// file the user will end up with.
				currentSavedName = currentInfo.FileName
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
					staged.Close()
					currentFile = nil
					fmt.Println()

					// Integrity guard: a short byte count means the transfer was
					// truncated (e.g. the sender closed early). Fail loudly rather
					// than leave a corrupt file that looks complete. The handle is
					// already closed and nil'd above (required before Remove on
					// Windows), so the interrupt cleanup cannot see this truncated
					// staging file; delete it here.
					if bytesReceived != currentInfo.FileSize {
						_ = os.Remove(partPath)
						unregisterPartial(staged)
						return fmt.Errorf("incomplete file %q: received %d of %d bytes",
							currentInfo.FileName, bytesReceived, currentInfo.FileSize)
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
					unregisterPartial(staged)
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
									FileName:   currentInfo.FileName,
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
				FileName:   currentInfo.FileName,
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

// classifyControl reports whether a data channel message is a Floe control
// message and, if so, its type.
//
// Control messages are JSON objects. The browser (SimplePeer) sends them as
// strings, but depending on SCTP framing they can also arrive as small binary
// messages, so binary payloads up to 1000 bytes are probed too (matching the
// browser's `data.byteLength <= 1000` guard). Crucially, a message is treated
// as control ONLY when it parses as a JSON object whose "type" is a known
// control type. Anything else — including a small file whose bytes happen to be
// a JSON object — is file data and must be written, not dropped.
//
// The receiver only acts on "metadata" and "end". The other recognized types
// ("ack", "received", "incompatible") flow in the opposite direction; they are
// classified as control so they are never mistakenly written as file data if
// they somehow arrive on this side.
func classifyControl(data []byte, isString bool) (msgType string, isControl bool) {
	if !isString && len(data) > 1000 {
		return "", false
	}
	if !looksLikeJSONObject(data) {
		return "", false
	}
	var base map[string]interface{}
	if err := json.Unmarshal(data, &base); err != nil {
		return "", false
	}
	t, _ := base["type"].(string)
	switch t {
	case "metadata", "end", "ack", "received", "incompatible":
		return t, true
	}
	return "", false
}

// looksLikeJSONObject reports whether data's first non-whitespace byte is '{',
// a cheap pre-check (mirroring the browser's `text.startsWith('{')`) that avoids
// a full JSON parse attempt on raw binary chunks.
func looksLikeJSONObject(data []byte) bool {
	for _, b := range data {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			return true
		default:
			return false
		}
	}
	return false
}

// parseMetadata extracts FileInfo from a raw metadata JSON string.
func parseMetadata(text string) (FileInfo, error) {
	var m struct {
		Type       string  `json:"type"`
		ID         string  `json:"id"`
		FileName   string  `json:"fileName"`
		FileSize   float64 `json:"fileSize"` // JSON numbers decode as float64
		Index      int     `json:"index"`
		Total      int     `json:"total"`
		TotalBytes float64 `json:"totalBytes"` // absent from older senders → 0
		Pv         int     `json:"pv"`         // absent from older senders → 0 (treated as 1)
		PvMin      int     `json:"pvMin"`      // absent from older senders → 0 (treated as 1)
		Ver        string  `json:"ver"`        // absent from older senders → ""
	}
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		return FileInfo{}, err
	}
	if m.Type != "metadata" {
		return FileInfo{}, fmt.Errorf("not a metadata message")
	}
	return FileInfo{
		ID:         m.ID,
		FileName:   m.FileName,
		FileSize:   int64(m.FileSize),
		Index:      m.Index,
		Total:      m.Total,
		TotalBytes: int64(m.TotalBytes),
		Pv:         m.Pv,
		PvMin:      m.PvMin,
		Ver:        m.Ver,
	}, nil
}

// safeJoin prevents path traversal attacks by cleaning the relative file name
// and ensuring it stays inside the output directory.
func safeJoin(outputDir, fileName string) string {
	// Normalize separators first (the browser sends forward slashes).
	name := filepath.FromSlash(fileName)
	// Strip any volume name (e.g. "C:" or a "\\host\share" UNC prefix on
	// Windows) so an absolute or UNC path can never anchor outside outputDir.
	name = strings.TrimPrefix(name, filepath.VolumeName(name))
	clean := filepath.Clean(name)
	// Drop empty (leading separator → rooted path), "." and ".." components.
	//
	// sanitizeComponent runs FIRST so the traversal filter below judges the
	// string that will actually reach the filesystem, not the one the peer
	// sent. Keep that order, and keep the filter itself untouched: a component
	// that a trailing trim reduces to ".." or "" has to meet the same test
	// every other component meets.
	parts := strings.Split(clean, string(filepath.Separator))
	var safe []string
	for _, p := range parts {
		p = sanitizeComponent(p, runtime.GOOS)
		if p != ".." && p != "." && p != "" {
			safe = append(safe, p)
		}
	}
	if len(safe) == 0 {
		safe = []string{"received_file"}
	}
	return filepath.Join(outputDir, filepath.Join(safe...))
}

// reservedDeviceNames are the Win32 device names a file cannot be called.
//
// The match is on the WHOLE component, case-insensitively, and deliberately
// NOT on the stem before the extension. The widespread advice is stem-based,
// but "CON.txt", "AUX.log" and even "NUL.txt" all create ordinary files on
// Windows 11, so a stem rule would rename names that demonstrably work.
// "CONTRACT.pdf" never matches under either rule.
//
// On Windows 11 with go1.26.3, measured, only bare "NUL" actually reaches a
// device; "CON", "AUX", "PRN", "COM1".."COM9" and "LPT1".."LPT9" all produce
// ordinary files. The rest of the list is kept anyway rather than trimmed to
// NUL alone: the set is a documented Win32 constraint that older Windows
// versions and non-Go APIs do enforce, and renaming a file nobody sensibly
// calls "CON" is far cheaper than silently losing one. The IsRegular check at
// the call site is what actually catches whatever this list misses.
var reservedDeviceNames = map[string]struct{}{
	"CON": {}, "PRN": {}, "AUX": {}, "NUL": {},
	"COM1": {}, "COM2": {}, "COM3": {}, "COM4": {}, "COM5": {},
	"COM6": {}, "COM7": {}, "COM8": {}, "COM9": {},
	"LPT1": {}, "LPT2": {}, "LPT3": {}, "LPT4": {}, "LPT5": {},
	"LPT6": {}, "LPT7": {}, "LPT8": {}, "LPT9": {},
	"CONIN$": {}, "CONOUT$": {},
}

// sanitizeComponent rewrites one peer-supplied path component into a name the
// receiving system can actually represent.
//
// The caller passes exactly one component (no separators) and must cope with
// two legitimate outputs: "" when everything was stripped, and ".." when a
// trailing trim exposes one. safeJoin's existing filter handles both.
//
// Two classes of rule, gated differently on purpose:
//
//   - Every platform: C0 controls, DEL, and the Unicode bidi controls become
//     "_". Controls are never valid in a name, and this name is printed to a
//     terminal (the incoming box, the progress bar, the summary), where a bare
//     \r rewrites the line and \x1b injects escape sequences that can scrub the
//     accept prompt. The bidi controls are the spoofing vector:
//     "photo‮gnp.exe" renders as "photoexe.png" in Explorer, Finder and
//     GNOME Files alike, so gating them to Windows would leave the other two
//     exposed. Text that is inherently right-to-left (Arabic, Hebrew) needs no
//     control character and is left alone.
//
//   - Windows only: the characters Win32 reserves become "_", trailing spaces
//     and dots are trimmed, and a component that IS a device name is prefixed.
//     Those names are legal and distinct on ext4 and APFS, so rewriting them
//     elsewhere would lose fidelity for no security gain. The RECEIVER's OS is
//     the correct gate, because this process is the one creating the file.
//
// Trailing spaces and dots are trimmed rather than replaced because Win32 drops
// them while resolving a path, so such a name does not refer to the file it
// appears to. That is what silently detaches the Mark of the Web: for
// "evil.exe " the bytes land on a real "evil.exe", but applyMOTW then writes
// "evil.exe :Zone.Identifier", where the space is interior and survives, so the
// stream attaches to something else and the saved file carries no zone tag.
// Substituting "evil.exe_" would keep the name distinct but destroy the
// extension association, which is a worse outcome than a de-collision.
//
// The replacement character is "_", and that mapping is a compatibility
// surface rather than an implementation detail: changing it later means a
// repeat receive lands as a separate file instead of "name (1).ext", and
// desktop history rows persisted with the old SavedName stop resolving (see
// Progress.SavedName). "_" is never itself a replacement target, so sanitizing
// twice gives the same answer as sanitizing once.
//
// goos is a parameter rather than a build tag so that every branch is
// exercised on all three CI legs, matching selfupdate.AssetName and desktop's
// revealCmd/openCmd. The rules here are a decision about the target OS, not an
// operation that only exists on one (which is what motw_windows.go is for).
func sanitizeComponent(name, goos string) string {
	windows := goos == "windows"

	// strings.Map rewrites invalid UTF-8 to U+FFFD. That is harmless here:
	// FileName arrives through json.Unmarshal, which has already made the same
	// substitution before this code ever sees the name.
	clean := strings.Map(func(r rune) rune {
		switch {
		// C0 and C1 controls, and DEL. C1 matters because U+0085 is a line
		// break: the browser twin strips it, so Go has to as well or the two
		// surfaces disagree on the same name.
		case r < 0x20 || (r >= 0x7f && r <= 0x9f):
			return '_'
		case r == '؜', // ALM, the fourth Bidi_Control mark
			r == '‎' || r == '‏', // LRM, RLM
			r >= '‪' && r <= '‮', // embeddings and overrides
			r >= '⁦' && r <= '⁩': // isolates
			return '_'
		case windows && strings.ContainsRune(`<>:"|?*`, r):
			return '_'
		}
		return r
	}, name)

	if !windows {
		return clean
	}

	// "." and ".." trim to "", and the caller's filter drops them either way.
	trimmed := strings.TrimRight(clean, " .")
	if trimmed == "" {
		return ""
	}
	if _, reserved := reservedDeviceNames[strings.ToUpper(trimmed)]; reserved {
		return "_" + trimmed
	}
	return trimmed
}

// partSuffix marks a staging file that is still being written. The full final
// name stays in front of it ("report.pdf.part"), so Explorer shows what the
// file will become, and ".part" is the convention download managers established
// for "incomplete": a crash-stale leftover can never be mistaken for a finished
// file. Bytes always land in a .part first; the final name is only ever taken
// by the rename in commitPart, so a process kill at any moment leaves nothing
// on disk that looks complete.
const partSuffix = ".part"

// candidatePath returns the i-th de-collision candidate for base: base itself
// for i == 0, then "stem (i)ext". Shared by claimPart and commitPart so a
// commit-time re-collision numbers from the base and can never produce
// "shot (1) (1).png".
func candidatePath(base string, i int) string {
	if i == 0 {
		return base
	}
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	return fmt.Sprintf("%s (%d)%s", stem, i, ext)
}

// claimPart reserves a final name for an incoming file and opens its .part
// staging file. It never overwrites: a candidate whose final name is taken by
// an existing file or directory is skipped, as is one whose .part exists (a
// concurrent receive's live claim, or a stale leftover from a crash, which is
// deliberately not reused because it cannot be told apart from a live one).
// The O_EXCL open of the .part is the atomic claim, so two concurrent receives
// racing for the same name cannot both win a candidate.
//
// A candidate occupied by something that is neither a regular file nor a
// directory (a device that survived name sanitizing) aborts loudly instead of
// advancing: writing "past" a device would succeed byte-for-byte and vanish,
// and failing before any bandwidth is spent beats failing after.
func claimPart(base string) (part *os.File, dest string, err error) {
	for i := 0; i < 100000; i++ {
		candidate := candidatePath(base, i)
		if st, lerr := os.Lstat(candidate); lerr == nil {
			if !st.Mode().IsRegular() && !st.IsDir() {
				return nil, "", fmt.Errorf("refusing to write %s: not a regular file (%s)",
					candidate, st.Mode())
			}
			continue // final name taken; advance
		}
		f, oerr := os.OpenFile(candidate+partSuffix, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0666)
		if oerr == nil {
			return f, candidate, nil
		}
		if !os.IsExist(oerr) {
			return nil, "", oerr
		}
		// A live or stale .part blocks this candidate; advance.
	}
	return nil, "", fmt.Errorf("too many files named like %q", filepath.Base(base))
}

// commitPart publishes a verified .part staging file at its final name,
// never overwriting anything that is not ours.
//
// Go's os.Rename REPLACES an existing destination on every platform, Windows
// included (MoveFileEx with REPLACE_EXISTING), so a bare rename here would
// silently clobber a file that appeared at the destination mid-transfer. The
// never-overwrite claim is therefore made explicitly: O_EXCL-create an empty
// placeholder at the candidate (the same atomic claim claimPart uses), then
// rename the .part over our own placeholder, where the replace semantics are
// the mechanism rather than the hazard.
//
// The rename gets a bounded retry because an AV scanner or indexer can hold
// the just-closed .part briefly (Go's Windows opens grant no
// FILE_SHARE_DELETE). On final failure the placeholder is removed and the
// .part is deliberately LEFT IN PLACE: its bytes are complete and verified,
// and deleting them over a transient lock would be data loss.
func commitPart(partPath, claimedDest, basePath string) (dest string, err error) {
	for i := 0; i < 100000; i++ {
		candidate := candidatePath(basePath, i)
		if i > 0 && candidate == claimedDest {
			continue // already tried first, below
		}
		if i == 0 {
			candidate = claimedDest // our claim gets the first shot
		}
		// Another receiver's live claim on this candidate; leave it alone.
		if candidate+partSuffix != partPath {
			if _, perr := os.Lstat(candidate + partSuffix); perr == nil {
				continue
			}
		}
		placeholder, oerr := os.OpenFile(candidate, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0666)
		if oerr != nil {
			if os.IsExist(oerr) {
				continue // final name taken since the claim; advance
			}
			return "", oerr
		}
		// The true device backstop: stat the handle we actually opened at the
		// name the bytes are about to wear.
		if st, serr := placeholder.Stat(); serr == nil && !st.Mode().IsRegular() {
			placeholder.Close()
			return "", fmt.Errorf("refusing to write %s: not a regular file (%s)",
				candidate, st.Mode())
		}
		placeholder.Close()

		var rerr error
		for attempt := 0; attempt < 5; attempt++ {
			if rerr = os.Rename(partPath, candidate); rerr == nil {
				return candidate, nil
			}
			time.Sleep(200 * time.Millisecond)
		}
		_ = os.Remove(candidate) // take back the placeholder; keep the .part
		return "", fmt.Errorf("could not move %s into place: %w", partPath, rerr)
	}
	return "", fmt.Errorf("too many files named like %q", filepath.Base(basePath))
}
