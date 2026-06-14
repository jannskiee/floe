// Package transfer implements the Floe data channel protocol for sending files.
//
// Protocol (same as the web app — must stay compatible for CLI↔Browser):
//   1. Sender → Receiver: metadata JSON  (file name, size, index, total)
//   2. Receiver → Sender: ack JSON       (confirms ready, offset for resume)
//   3. Sender → Receiver: binary chunks  (raw file bytes, 16 KB each)
//   4. Sender → Receiver: end JSON       (signals end of this file)
//   Repeat for each file.
package transfer

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v3"
	"github.com/schollz/progressbar/v3"
)

const chunkSize = 16 * 1024

func truncateName(name string, maxLen int) string {
	if len(name) <= maxLen {
		return name
	}
	return name[:maxLen-1] + "…"
}

// metadataMsg is sent before each file to describe it.
type metadataMsg struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	FileName string `json:"fileName"`
	FileSize int64  `json:"fileSize"`
	Index    int    `json:"index"`
	Total    int    `json:"total"`
}

// ackMsg is received from the receiver confirming readiness.
type ackMsg struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Offset int64  `json:"offset"`
}

// endMsg is sent after the last chunk of each file.
type endMsg struct {
	Type string `json:"type"`
}

// SendFiles sends all given file paths over the open data channel.
// Folders are walked recursively. The receiver gets each file in order.
func SendFiles(dc *webrtc.DataChannel, paths []string) error {
	// Expand paths: collect all files (walk directories)
	files, err := collectFiles(paths)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no files to send")
	}

	fmt.Printf("  Sending %d file(s)...\n\n", len(files))

	// ackCh receives JSON ack messages from the receiver
	ackCh := make(chan []byte, 4)
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		// Accept ack as either string or binary — the CLI receiver sends
		// binary for browser compatibility, CLI-to-CLI also works.
		ackCh <- msg.Data
	})

	for i, entry := range files {
		if err := sendFile(dc, ackCh, entry, i+1, len(files)); err != nil {
			return fmt.Errorf("error sending %s: %w", entry.displayName, err)
		}
	}

	fmt.Println("\n  All files sent.")

	// Allow SCTP to flush buffered data before the caller closes the connection.
	// Without this pause, conn.Close() fires immediately and the receiver may
	// not receive the last chunks / end markers.
	time.Sleep(2 * time.Second)
	return nil
}

// fileEntry holds info about a file to be sent.
type fileEntry struct {
	absPath     string // absolute path on disk
	displayName string // shown in the UI (basename or relative path for folders)
}

// collectFiles expands all paths: plain files are added directly,
// directories are walked and each file inside is added with its relative path.
func collectFiles(paths []string) ([]fileEntry, error) {
	var entries []fileEntry
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %w", p, err)
		}

		if !info.IsDir() {
			entries = append(entries, fileEntry{
				absPath:     p,
				displayName: filepath.Base(p),
			})
			continue
		}

		// Walk the directory
		base := filepath.Dir(p)
		walkErr := filepath.Walk(p, func(path string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(base, path)
			entries = append(entries, fileEntry{
				absPath:     path,
				displayName: filepath.ToSlash(rel), // use forward slashes in metadata
			})
			return nil
		})
		if walkErr != nil {
			return nil, fmt.Errorf("cannot walk %s: %w", p, walkErr)
		}
	}
	return entries, nil
}

// sendFile handles the full send sequence for a single file.
func sendFile(dc *webrtc.DataChannel, ackCh <-chan []byte, entry fileEntry, index, total int) error {
	f, err := os.Open(entry.absPath)
	if err != nil {
		return err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return err
	}

	fileID := uuid.New().String()
	fileSize := info.Size()

	// Step 1: Send metadata
	meta := metadataMsg{
		Type:     "metadata",
		ID:       fileID,
		FileName: entry.displayName,
		FileSize: fileSize,
		Index:    index,
		Total:    total,
	}
	metaJSON, _ := json.Marshal(meta)
	if err := dc.SendText(string(metaJSON)); err != nil {
		return fmt.Errorf("failed to send metadata: %w", err)
	}

	// Step 2: Wait for ack (with 30-second timeout)
	var offset int64
	select {
	case raw := <-ackCh:
		var ack ackMsg
		if err := json.Unmarshal(raw, &ack); err == nil && ack.Type == "ack" && ack.ID == fileID {
			offset = ack.Offset
		}
	case <-time.After(30 * time.Second):
		return fmt.Errorf("timed out waiting for ack")
	}

	// Seek to resume offset (normally 0)
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return fmt.Errorf("failed to seek to offset: %w", err)
		}
	}

	// Step 3: Send binary chunks with progress bar
	bar := progressbar.NewOptions64(
		fileSize,
		progressbar.OptionSetDescription(fmt.Sprintf("  [%d/%d] %s", index, total, truncateName(entry.displayName, 30))),
		progressbar.OptionSetWidth(30),
		progressbar.OptionShowBytes(true),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "█",
			SaucerPadding: "░",
			BarStart:      "[",
			BarEnd:        "]",
		}),
	)
	bar.Set64(offset)

	buf := make([]byte, chunkSize)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if sendErr := dc.Send(buf[:n]); sendErr != nil {
				return fmt.Errorf("failed to send chunk: %w", sendErr)
			}
			bar.Add(n)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("error reading file: %w", err)
		}
	}
	fmt.Println()

	// Step 4: Send end marker
	end := endMsg{Type: "end"}
	endJSON, _ := json.Marshal(end)
	return dc.SendText(string(endJSON))
}
