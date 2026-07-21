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

// ReceiveFiles handles the full receiving side of the Floe protocol.
// It blocks until all files are received. Files are written to outputDir.
// If autoAccept is false, the user is prompted before receiving begins.
// localVer is the human release string (e.g. "v1.5.5") embedded in the ack
// for the optional peer-version note; pass "" for dev builds or tests.
// serverURL is the signaling server base URL used to report transfer stats;
// pass "" to skip reporting (e.g. in tests).
func ReceiveFiles(dc *webrtc.DataChannel, outputDir string, autoAccept bool, localVer string, serverURL string) error {
	// msgCh collects ALL incoming data channel messages.
	// We use a channel so the OnMessage callback (goroutine) feeds a sequential loop.
	msgCh := make(chan webrtc.DataChannelMessage, 256)

	// done is closed when the data channel closes. We signal via a separate
	// channel instead of closing msgCh from OnClose: closing msgCh while the
	// OnMessage callback might still push would panic ("send on closed channel").
	// The OnMessage send selects on done so it can never block or panic after close.
	done := make(chan struct{})
	var closeOnce sync.Once
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		select {
		case msgCh <- msg:
		case <-done:
		}
	})
	dc.OnClose(func() {
		closeOnce.Do(func() { close(done) })
	})

	// Process messages sequentially
	var currentFile *os.File
	var currentInfo FileInfo
	var bytesReceived int64
	var totalReceived int64
	var bar *progressbar.ProgressBar
	var start time.Time
	filesReceived := 0
	waitingForFirst := true

	// If the transfer is interrupted (peer disconnect or error) before the
	// "end" marker closes the current file, ensure the handle is still released.
	defer func() {
		if currentFile != nil {
			currentFile.Close()
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
				// Channel closed before the transfer finished normally.
				if currentFile != nil {
					return fmt.Errorf("connection closed mid-transfer: %s (%d of %d bytes)",
						currentInfo.FileName, bytesReceived, currentInfo.FileSize)
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
						errMsg := CompatErrorMessage(localTooOld, localVer, info.Ver,
							MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv)
						incompat := incompatibleMsg{
							Type:   "incompatible",
							Reason: errMsg,
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

				// Create destination file (create parent dirs for folder transfers)
				destPath := safeJoin(outputDir, info.FileName)
				if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
					return fmt.Errorf("cannot create directory: %w", err)
				}
				currentFile, err = os.Create(destPath)
				if err != nil {
					return fmt.Errorf("cannot create file %s: %w", destPath, err)
				}

				// Progress bar for this file
				bar = newProgressBar(info.FileSize, info.Index, info.Total, info.FileName)

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
					currentFile.Close()
					currentFile = nil
					fmt.Println()

					// Integrity guard: a short byte count means the transfer was
					// truncated (e.g. the sender closed early). Fail loudly rather
					// than leave a corrupt file that looks complete.
					if bytesReceived != currentInfo.FileSize {
						return fmt.Errorf("incomplete file %q: received %d of %d bytes",
							currentInfo.FileName, bytesReceived, currentInfo.FileSize)
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
		bar.Add(n)
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
	parts := strings.Split(clean, string(filepath.Separator))
	var safe []string
	for _, p := range parts {
		if p != ".." && p != "." && p != "" {
			safe = append(safe, p)
		}
	}
	if len(safe) == 0 {
		safe = []string{"received_file"}
	}
	return filepath.Join(outputDir, filepath.Join(safe...))
}
