// Package transfer implements the Floe data channel protocol for sending files.
//
// Protocol (same as the web app — must stay compatible for CLI↔Browser):
//   1. Sender → Receiver: metadata JSON  (file name, size, index, total, pv, pvMin, ver)
//   2. Receiver → Sender: ack JSON       (confirms ready, offset for resume, pv, pvMin, ver)
//      OR:       incompatible JSON       (sent instead of ack when protocol ranges do not overlap)
//   3. Sender → Receiver: binary chunks  (raw file bytes; chunk size adapts to
//      the negotiated SCTP max-message-size, capped at 256 KB — see chunkSizeFor)
//   4. Sender → Receiver: end JSON       (signals end of this file)
//   Repeat for each file.
//
// pv/pvMin are the protocol version range (see protocol.go). ver is the human
// release string (e.g. "v1.5.5") used only for the optional informational note;
// it never gates the transfer. Fields are omitted by legacy peers and default to
// protocol version 1.
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
)

const (
	// defaultChunkSize is the safe fallback used when the negotiated SCTP
	// max-message-size is unavailable (0). It matches the historical value.
	defaultChunkSize = 16 * 1024
	// maxChunkSize caps the adaptive chunk. Mirrors MAX_CHUNK in the browser
	// sender (client/lib/transfer/protocol.ts).
	maxChunkSize = 256 * 1024
)

// chunkSizeFor returns the send chunk size for a connection whose negotiated
// SCTP max-message-size is sctpMax (read from dc.Transport().GetCapabilities()).
// It caps at maxChunkSize and never exceeds the negotiated ceiling, so dc.Send
// can never return ErrOutboundPacketTooLarge (pion/sctp enforces the limit on
// send). A zero sctpMax (capabilities not yet available) falls back to the
// proven default. Mirrors chunkSize() in client/lib/transfer/protocol.ts.
func chunkSizeFor(sctpMax uint32) int {
	if sctpMax == 0 {
		return defaultChunkSize
	}
	if int(sctpMax) < maxChunkSize {
		return int(sctpMax)
	}
	return maxChunkSize
}

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

// metadataMsg is sent before each file to describe it.
type metadataMsg struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	FileName   string `json:"fileName"`
	FileSize   int64  `json:"fileSize"`
	Index      int    `json:"index"`
	Total      int    `json:"total"`
	TotalBytes int64  `json:"totalBytes"`
	Pv         int    `json:"pv,omitempty"`
	PvMin      int    `json:"pvMin,omitempty"`
	Ver        string `json:"ver,omitempty"`
}

// ackMsg is received from the receiver confirming readiness.
type ackMsg struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Offset int64  `json:"offset"`
	Pv     int    `json:"pv"`
	PvMin  int    `json:"pvMin"`
	Ver    string `json:"ver"`
}

// endMsg is sent after the last chunk of each file.
type endMsg struct {
	Type string `json:"type"`
}

// SendFiles sends all given file paths over the open data channel.
// Folders are walked recursively. The receiver gets each file in order.
// localVer is the human release string (e.g. "v1.5.5") embedded in metadata
// for the optional peer-version note; pass "" for dev builds or tests.
func SendFiles(dc *webrtc.DataChannel, paths []string, localVer string) error {
	// Expand paths: collect all files (walk directories)
	files, err := collectFiles(paths)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no files to send")
	}

	var totalBytes int64
	for _, e := range files {
		totalBytes += e.size
	}

	start := time.Now()

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

	// Size chunks to the connection's negotiated SCTP max-message-size (capped
	// at maxChunkSize), matching the browser sender. Larger chunks mean far fewer
	// dc.Send calls per file — the main throughput lever on fast links.
	var sctpMax uint32
	if t := dc.Transport(); t != nil {
		sctpMax = t.GetCapabilities().MaxMessageSize
	}
	chunk := chunkSizeFor(sctpMax)

	for i, entry := range files {
		if err := sendFile(dc, ackCh, sendMore, entry, i+1, len(files), totalBytes, localVer, chunk); err != nil {
			return fmt.Errorf("error sending %s: %w", entry.displayName, err)
		}
	}

	// Wait for delivery confirmation before closing.
	//
	// CLI receivers send {"type":"received"} after writing and verifying every
	// byte, which is the authoritative signal. Browser receivers don't send it,
	// but they keep their connection alive so the SCTP buffer naturally drains
	// to zero — that's the fallback. A 30s deadline guards against a dead peer.
	//
	// We cannot rely solely on dc.BufferedAmount()==0: when the receiver closes
	// its connection immediately after the last write (which the CLI does), the
	// final SACKs may never arrive and the buffer stalls at a non-zero value
	// even though all bytes were delivered successfully.
	drainDeadline := time.After(30 * time.Second)
	drainTick := time.NewTicker(50 * time.Millisecond)
	defer drainTick.Stop()
drainLoop:
	for {
		select {
		case raw := <-ackCh:
			var msg struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &msg) == nil && msg.Type == "received" {
				break drainLoop
			}
		case <-drainTick.C:
			if dc.BufferedAmount() == 0 {
				break drainLoop
			}
		case <-drainDeadline:
			return fmt.Errorf("timed out waiting for delivery confirmation from peer")
		}
	}

	elapsed := time.Since(start)
	timeVal := formatDuration(elapsed)
	if spd := formatSpeed(float64(totalBytes) / elapsed.Seconds()); spd != "" {
		timeVal += " · avg " + spd
	}
	printSummary([][2]string{
		{"Sent", fmt.Sprintf("%s (%s)", pluralize(len(files), "file"), formatBytes(totalBytes))},
		{"Time", timeVal},
	})
	return nil
}

// fileEntry holds info about a file to be sent.
type fileEntry struct {
	absPath     string // absolute path on disk
	displayName string // shown in the UI (basename or relative path for folders)
	size        int64  // file size in bytes
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
				size:        info.Size(),
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
				size:        fi.Size(),
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
func sendFile(dc *webrtc.DataChannel, ackCh <-chan []byte, sendMore <-chan struct{}, entry fileEntry, index, total int, totalBytes int64, localVer string, chunk int) error {
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
		Type:       "metadata",
		ID:         fileID,
		FileName:   entry.displayName,
		FileSize:   fileSize,
		Index:      index,
		Total:      total,
		TotalBytes: totalBytes,
		Pv:         ProtocolVersion,
		PvMin:      MinProtocolVersion,
		Ver:        localVer,
	}
	metaJSON, _ := json.Marshal(meta)
	if err := dc.SendText(string(metaJSON)); err != nil {
		return fmt.Errorf("failed to send metadata: %w", err)
	}

	// Step 2: Wait for this file's ack (with 120-second timeout).
	// Discard any stray or stale message until we see the ack whose ID matches
	// this file — otherwise an out-of-order message could be misread as the ack
	// (sending from offset 0) or leak into the next file's handshake.
	// 120 s lets a human at the interactive [Y/n] receiver prompt accept without
	// triggering a spurious timeout on the sender.
	var offset int64
	ackDeadline := time.After(120 * time.Second)
ackLoop:
	for {
		select {
		case raw := <-ackCh:
			var base struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &base) != nil {
				continue
			}
			// If the receiver found the protocol ranges incompatible it sends
			// an "incompatible" message instead of an ack.
			if base.Type == "incompatible" {
				var incompat struct {
					Reason string `json:"reason"`
				}
				json.Unmarshal(raw, &incompat) //nolint:errcheck
				if incompat.Reason != "" {
					return fmt.Errorf("%s", incompat.Reason)
				}
				return fmt.Errorf("peer rejected transfer: protocol incompatible")
			}
			if base.Type == "ack" {
				var ack ackMsg
				if err := json.Unmarshal(raw, &ack); err == nil && ack.ID == fileID {
					// Defense in depth: verify protocol compat from the receiver's
					// pv fields on the first file. The receiver already checked from
					// its side; this catches the case where an old receiver (no pv
					// field, treated as v1) connects to a future sender that dropped
					// support for v1.
					if index == 1 {
						ok, localTooOld := CheckCompat(MinProtocolVersion, ProtocolVersion, ack.PvMin, ack.Pv)
						if !ok {
							return fmt.Errorf("%s", CompatErrorMessage(localTooOld, localVer, ack.Ver,
								MinProtocolVersion, ProtocolVersion, ack.PvMin, ack.Pv))
						}
						if ack.Ver != "" && localVer != "" && ack.Ver != localVer {
							fmt.Printf("  Peer version: %s\n", ack.Ver)
						}
					}
					offset = ack.Offset
					break ackLoop
				}
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
	bar := newProgressBar(fileSize, index, total, entry.displayName)
	bar.Set64(offset)

	buf := make([]byte, chunk)
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
