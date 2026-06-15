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
	"github.com/pion/webrtc/v4"
	"github.com/schollz/progressbar/v3"
)

const chunkSize = 16 * 1024

// Backpressure watermarks mirror the browser sender (P2PTransfer.tsx): pause
// sending once pion's SCTP send buffer reaches the high-water mark, resume once
// it drains back below the low-water mark. Without this the sender enqueues the
// whole file as fast as the disk reads it — the progress bar races to 100% while
// the receiver is still mid-transfer, and large files overflow pion's buffer and
// stall the connection.
const (
	bufferedAmountHighWater = 8 * 1024 * 1024 // pause sending at/above 8 MB buffered
	bufferedAmountLowWater  = 4 * 1024 * 1024 // resume sending below 4 MB buffered
)

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
		// Non-blocking: a full buffer means a stray/duplicate message arrived;
		// dropping it is safe because the ack loop already matched its ID.
		select {
		case ackCh <- msg.Data:
		default:
		}
	})

	// Backpressure: pion calls OnBufferedAmountLow once the send buffer drains
	// to bufferedAmountLowWater. The send loop blocks on sendMore whenever the
	// buffer is full so we never enqueue faster than the peer can drain.
	sendMore := make(chan struct{}, 1)
	dc.SetBufferedAmountLowThreshold(bufferedAmountLowWater)
	dc.OnBufferedAmountLow(func() {
		select {
		case sendMore <- struct{}{}:
		default:
		}
	})

	for i, entry := range files {
		if err := sendFile(dc, ackCh, sendMore, entry, i+1, len(files)); err != nil {
			return fmt.Errorf("error sending %s: %w", entry.displayName, err)
		}
	}

	fmt.Println("\n  All files sent.")

	// Flush: wait for pion to push every buffered byte (including the final end
	// marker) onto the wire before the caller closes the connection. Closing
	// while data is still buffered truncates the transfer. Capped so a dead peer
	// can't hang the process forever.
	drainDeadline := time.Now().Add(30 * time.Second)
	for dc.BufferedAmount() > 0 {
		if time.Now().After(drainDeadline) {
			return fmt.Errorf("timed out flushing %d buffered bytes to peer", dc.BufferedAmount())
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Brief grace period so the receiver can process the final end marker
	// before the data channel is torn down.
	time.Sleep(250 * time.Millisecond)
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
func sendFile(dc *webrtc.DataChannel, ackCh <-chan []byte, sendMore <-chan struct{}, entry fileEntry, index, total int) error {
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

	// Step 2: Wait for this file's ack (with 30-second timeout).
	// Discard any stray or stale message until we see the ack whose ID matches
	// this file — otherwise an out-of-order message could be misread as the ack
	// (sending from offset 0) or leak into the next file's handshake.
	var offset int64
	// 120 s lets a human at the interactive [Y/n] receiver prompt accept without
	// triggering a spurious timeout on the sender.
	ackDeadline := time.After(120 * time.Second)
ackLoop:
	for {
		select {
		case raw := <-ackCh:
			var ack ackMsg
			if err := json.Unmarshal(raw, &ack); err == nil && ack.Type == "ack" && ack.ID == fileID {
				offset = ack.Offset
				break ackLoop
			}
			// Not our ack — keep waiting.
		case <-ackDeadline:
			return fmt.Errorf("timed out waiting for ack")
		}
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
			// Backpressure: block until pion's buffer drains below the low-water
			// mark before queuing more. The loop re-checks after each wakeup so a
			// stale signal can't let us run away from the receiver.
			for dc.BufferedAmount() >= bufferedAmountHighWater {
				select {
				case <-sendMore:
				case <-time.After(60 * time.Second):
					return fmt.Errorf("backpressure stall: peer not draining (%d bytes buffered)", dc.BufferedAmount())
				}
			}
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
