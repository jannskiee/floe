// Package transfer implements the Floe data channel protocol for receiving files.
// See sender.go for the full protocol description.
package transfer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pion/webrtc/v3"
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

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		msgCh <- msg
	})

	dc.OnClose(func() {
		close(msgCh)
	})

	// Process messages sequentially
	var currentFile *os.File
	var currentInfo FileInfo
	var bytesReceived int64
	var bar *progressbar.ProgressBar
	filesReceived := 0
	waitingForFirst := true

	// If the transfer is interrupted (peer disconnect or error) before the
	// "end" marker closes the current file, ensure the handle is still released.
	defer func() {
		if currentFile != nil {
			currentFile.Close()
		}
	}()

	for msg := range msgCh {
		// Try to parse as a JSON control message.
		// Browser (SimplePeer) sends metadata/end as strings, but they may
		// arrive as binary depending on SCTP framing. We attempt JSON parsing
		// on any string message OR any small binary message (< 1 KB).
		if msg.IsString || len(msg.Data) < 1024 {
			var base map[string]interface{}
			if err := json.Unmarshal(msg.Data, &base); err == nil {
				msgType, _ := base["type"].(string)

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
						fmt.Printf("\n  Incoming: %d file(s)\n\n", info.Total)
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
					bar = progressbar.NewOptions64(
						info.FileSize,
						progressbar.OptionSetDescription(
							fmt.Sprintf("  [%d/%d] %s", info.Index, info.Total, truncateName(info.FileName, 30)),
						),
						progressbar.OptionSetWidth(30),
						progressbar.OptionShowBytes(true),
						progressbar.OptionSetTheme(progressbar.Theme{
							Saucer:        "█",
							SaucerPadding: "░",
							BarStart:      "[",
							BarEnd:        "]",
						}),
					)

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
						filesReceived++

						if filesReceived >= currentInfo.Total {
							fmt.Printf("  Done. %d file(s) received in %s\n", filesReceived, outputDir)
							return nil
						}
					}
				}
				continue // successfully parsed JSON — skip binary write
			}
			// JSON parse failed on a string message — skip it
			if msg.IsString {
				continue
			}
			// JSON parse failed on a small binary message — fall through to chunk write
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
		bar.Add(n)
	}

	return nil
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
