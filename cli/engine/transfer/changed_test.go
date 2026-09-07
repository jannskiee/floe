// A file can change on disk between the Stat that fills in its announced size
// and the read that puts its bytes on the wire: an active log, a download still
// running, a video still being written. These tests drive the real sender over
// a real pion pair and mutate the source file in the window the protocol opens
// for them, between the metadata and the ack, which is deterministic rather
// than timing-dependent.
//
// The contract they pin: the sender never puts more bytes on the wire than it
// announced, it never follows a wrong byte count with an end marker, and the
// error it returns names the file's own change rather than leaving the receiver
// to report a count that reads like a network fault.
package transfer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// sendWithMidFlightChange writes initial bytes to a source file, starts a real
// SendFiles against a real receiver channel, waits for the metadata to land,
// runs mutate on the file, and only then sends the ack that releases the read
// loop. It returns the sender's error and every frame the receiver saw after
// the metadata.
func sendWithMidFlightChange(t *testing.T, initial []byte, mutate func(path string)) (error, [][]byte) {
	t.Helper()

	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	defer closeFn()

	src := filepath.Join(t.TempDir(), "changing.bin")
	if err := os.WriteFile(src, initial, 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFiles(sender, []string{src}, "") }()

	var meta struct {
		ID       string `json:"id"`
		FileSize int64  `json:"fileSize"`
	}
	select {
	case m := <-msgs:
		if err := json.Unmarshal(m.Data, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first message is not the metadata: %q", m.Data)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("sender's metadata never reached the receiver")
	}
	if meta.FileSize != int64(len(initial)) {
		t.Fatalf("announced %d bytes, source was %d", meta.FileSize, len(initial))
	}

	// The sender is parked on its ack deadline here, having already stated the
	// size it will send. Change the file underneath it, then let it go.
	mutate(src)

	ack := `{"type":"ack","id":"` + meta.ID + `","offset":0,"pv":1,"pvMin":1}`
	if err := rdc.Send([]byte(ack)); err != nil {
		t.Fatalf("reply: %v", err)
	}

	var err error
	select {
	case err = <-sendErr:
	case <-time.After(30 * time.Second):
		t.Fatal("SendFiles did not return")
	}

	// Anything still in flight has had the send's whole lifetime to arrive; a
	// short settle keeps the "no end marker" assertion honest rather than lucky.
	time.Sleep(300 * time.Millisecond)
	var frames [][]byte
	for {
		select {
		case m := <-msgs:
			frames = append(frames, append([]byte(nil), m.Data...))
			continue
		default:
		}
		break
	}
	return err, frames
}

// assertNoEndMarker fails when the sender closed a file off after refusing it.
// Sending "end" behind a wrong byte count is what made the receiver report the
// mismatch instead of the sender reporting the cause.
func assertNoEndMarker(t *testing.T, frames [][]byte) {
	t.Helper()
	for _, f := range frames {
		if strings.Contains(string(f), `"type":"end"`) {
			t.Fatalf("sender sent an end marker after refusing the file: %q", f)
		}
	}
}

// countBytesSent sums every frame that is not a control message, which for this
// harness means every frame after the metadata that is not the end marker.
func countBytesSent(frames [][]byte) int {
	n := 0
	for _, f := range frames {
		if _, isControl := classifyControl(f); isControl {
			continue
		}
		n += len(f)
	}
	return n
}

// TestSenderStopsAtAnnouncedSizeWhenFileGrows: a file that gains bytes after
// its size was announced must not overrun the announcement. Before the cap the
// read ran to EOF, so the receiver killed the whole batch with "sender exceeded
// the announced size", naming nothing either person could act on.
func TestSenderStopsAtAnnouncedSizeWhenFileGrows(t *testing.T) {
	err, frames := sendWithMidFlightChange(t, make([]byte, 64), func(path string) {
		f, oerr := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
		if oerr != nil {
			t.Fatalf("reopen for append: %v", oerr)
		}
		if _, werr := f.Write(make([]byte, 64)); werr != nil {
			t.Fatalf("append: %v", werr)
		}
		if cerr := f.Close(); cerr != nil {
			t.Fatalf("close append handle: %v", cerr)
		}
	})

	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "grew while it was being sent") {
		t.Fatalf("error does not name the growth: %v", err)
	}
	if sent := countBytesSent(frames); sent > 64 {
		t.Fatalf("sent %d bytes for a 64-byte announcement", sent)
	}
	assertNoEndMarker(t, frames)
}

// TestSenderReportsAFileThatShrinks: the other half of the same window. The
// announcement can no longer be honored, so the sender says so instead of
// sending an end marker and leaving the receiver to call it an incomplete file.
func TestSenderReportsAFileThatShrinks(t *testing.T) {
	err, frames := sendWithMidFlightChange(t, make([]byte, 64), func(path string) {
		if terr := os.Truncate(path, 32); terr != nil {
			t.Fatalf("truncate: %v", terr)
		}
	})

	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "shrank while it was being sent") {
		t.Fatalf("error does not name the shrink: %v", err)
	}
	if !strings.Contains(err.Error(), "64") || !strings.Contains(err.Error(), "32") {
		t.Fatalf("error names neither the announced size nor what was read: %v", err)
	}
	assertNoEndMarker(t, frames)
}

// TestSenderRefusesAZeroStatFileThatHasBytes is the case a second Stat cannot
// catch and the cap alone would hide. A descriptor that reports 0 and still
// yields bytes (a log created moments earlier, or a /proc, /sys or
// character-device path, all of which collectFiles accepts) would otherwise be
// capped to nothing, closed off with an end marker, and reported as a success
// by both ends because the receiver's guard sees 0 == 0.
func TestSenderRefusesAZeroStatFileThatHasBytes(t *testing.T) {
	err, frames := sendWithMidFlightChange(t, nil, func(path string) {
		if werr := os.WriteFile(path, []byte("this arrived after the size was announced"), 0o600); werr != nil {
			t.Fatalf("fill: %v", werr)
		}
	})

	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "grew while it was being sent") {
		t.Fatalf("error does not name the growth: %v", err)
	}
	if sent := countBytesSent(frames); sent != 0 {
		t.Fatalf("sent %d bytes for a 0-byte announcement", sent)
	}
	assertNoEndMarker(t, frames)
}
