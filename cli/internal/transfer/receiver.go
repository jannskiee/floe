// Package transfer implements the Floe data channel protocol for receiving files.
// See sender.go for the full protocol description.
package transfer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/schollz/progressbar/v3"
)

// FileInfo describes an incoming file (parsed from metadata message).
type FileInfo struct {
	ID       string
	FileName string
	FileSize int64
	Index    int
	Total    int
}

// ReceiveFiles handles the full receiving side of the Floe protocol.
// It blocks until all files are received. Files are written to outputDir.
// If autoAccept is false, the user is prompted before receiving begins.
func ReceiveFiles(dc *webrtc.DataChannel, outputDir string, autoAccept bool) error {
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

	for {
		// Prefer draining buffered messages over reacting to a close: a normal
		// transfer ends with the final "end" marker already queued in msgCh,
		// which must be processed even if OnClose has fired alongside it.
		var msg webrtc.DataChannelMessage
		select {
		case msg = <-msgCh:
		default:
			select {
			case msg = <-msgCh:
			case <-done:
				// Channel closed before the transfer finished normally.
				if currentFile != nil {
					return fmt.Errorf("connection closed mid-transfer: %s (%d of %d bytes)",
						currentInfo.FileName, bytesReceived, currentInfo.FileSize)
				}
				return nil
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

				// On first file: show summary and optionally prompt
				if waitingForFirst {
					waitingForFirst = false
					start = time.Now()
					fmt.Printf("\n  Incoming: %s\n\n", pluralize(info.Total, "file"))
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

				// Send ack as BINARY — the browser checks data.byteLength before
				// decoding, which is only defined on ArrayBuffer/Buffer, not strings.
				ack := map[string]interface{}{
					"type":   "ack",
					"id":     info.ID,
					"offset": 0,
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
// message and, if so, its type ("metadata" or "end").
//
// Control messages are JSON objects. The browser (SimplePeer) sends them as
// strings, but depending on SCTP framing they can also arrive as small binary
// messages, so binary payloads up to 1000 bytes are probed too (matching the
// browser's `data.byteLength <= 1000` guard). Crucially, a message is treated
// as control ONLY when it parses as a JSON object whose "type" is a known
// control type. Anything else — including a small file whose bytes happen to be
// a JSON object — is file data and must be written, not dropped.
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
	if t == "metadata" || t == "end" {
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
		Type     string  `json:"type"`
		ID       string  `json:"id"`
		FileName string  `json:"fileName"`
		FileSize float64 `json:"fileSize"` // JSON numbers decode as float64
		Index    int     `json:"index"`
		Total    int     `json:"total"`
	}
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		return FileInfo{}, err
	}
	if m.Type != "metadata" {
		return FileInfo{}, fmt.Errorf("not a metadata message")
	}
	return FileInfo{
		ID:       m.ID,
		FileName: m.FileName,
		FileSize: int64(m.FileSize),
		Index:    m.Index,
		Total:    m.Total,
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
