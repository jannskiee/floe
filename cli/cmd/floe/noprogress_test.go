package main

// CLI --no-progress (issue #688): flag wiring, and a receive, a send and a
// send --to whose stdout has no carriage return.

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

const noProgressHelp = "do not draw the progress bar (for scripts and CI logs)"

// TestNoProgressFlagHelp: floe send and floe receive register --no-progress
// with the approved help text.
func TestNoProgressFlagHelp(t *testing.T) {
	for _, name := range []string{"send", "receive"} {
		var usage string
		switch name {
		case "send":
			f := sendCmd.Flags().Lookup("no-progress")
			if f == nil {
				t.Fatal("send missing --no-progress")
			}
			usage = f.Usage
		case "receive":
			f := receiveCmd.Flags().Lookup("no-progress")
			if f == nil {
				t.Fatal("receive missing --no-progress")
			}
			usage = f.Usage
		}
		if usage != noProgressHelp {
			t.Fatalf("%s --no-progress help = %q, want %q", name, usage, noProgressHelp)
		}
	}
}

// TestReceiveNoProgressDrawsNoCarriageReturn: floe receive --no-progress
// against plainRoom + engineSender (issue #688 how-to-test) leaves no \r
// in stdout.
func TestReceiveNoProgressDrawsNoCarriageReturn(t *testing.T) {
	url, _ := plainRoom(t)
	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte("hello from no-progress"), 0o600); err != nil {
		t.Fatal(err)
	}
	room := uuid.New().String()
	_, result := engineSender(t, url, room, []string{src})
	out := t.TempDir()
	stdout, stderr, err := receiveInto(t, nil, out, url+"/#room="+room, "--server", url, "-y", "--no-progress")
	if err != nil {
		t.Fatalf("the receive failed: %v\nstderr:\n%s\nstdout:\n%s", err, stderr, stdout)
	}
	select {
	case sendErr := <-result:
		if sendErr != nil {
			t.Fatalf("the send failed: %v", sendErr)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the send never ended")
	}
	if strings.Contains(stdout, "\r") {
		t.Fatalf("receive --no-progress stdout still holds a carriage return:\n%q", stdout)
	}
	if strings.ContainsAny(stdout, "█░") {
		t.Fatalf("receive --no-progress stdout still holds bar glyphs:\n%q", stdout)
	}
	if got, readErr := os.ReadFile(filepath.Join(out, "note.txt")); readErr != nil || string(got) != "hello from no-progress" {
		t.Fatalf("saved file: %q, %v", got, readErr)
	}
}

// wantNoBar fails when stdout holds what only a drawn bar writes: the
// carriage return it redraws with, or its glyphs.
func wantNoBar(t *testing.T, what, stdout string) {
	t.Helper()
	if strings.Contains(stdout, "\r") {
		t.Fatalf("%s stdout still holds a carriage return:\n%q", what, stdout)
	}
	if strings.ContainsAny(stdout, "█░") {
		t.Fatalf("%s stdout still holds bar glyphs:\n%q", what, stdout)
	}
}

// TestSendNoProgressDrawsNoCarriageReturn: floe send --no-progress reaches the
// engine (send.go's SendOptions). The file reaches an engine receiver and
// stdout holds no bar; without the flag the same send draws one.
func TestSendNoProgressDrawsNoCarriageReturn(t *testing.T) {
	o := captureOutput(t)
	url, seated := plainRoom(t)
	stubNetwork(t, url)
	src, sum := oneFile(t, t.TempDir(), "note.bin", 64<<10)
	out := t.TempDir()
	r := startCLI(t, src, "--server", url, "--no-progress")
	received := make(chan error, 1)
	plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, _ <-chan struct{}) {
		// OnProgress is set, so this receiver draws no bar into the shared stdout.
		received <- transfer.ReceiveFilesWithOptions(dc, out, true, "test", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			Messages:   early.Msgs,
			Closed:     early.Closed,
		})
	})
	select {
	case err := <-received:
		if err != nil {
			t.Fatalf("the receive failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the receive never ended")
	}
	r.wait(t, 30*time.Second).read(o)
	if r.err != nil {
		t.Fatalf("the send failed: %v\nstderr:\n%s\nstdout:\n%s", r.err, r.stderr, r.stdout)
	}
	wantNoBar(t, "send --no-progress", r.stdout)
	if got, err := os.ReadFile(filepath.Join(out, "note.bin")); err != nil || sha256.Sum256(got) != sum {
		t.Fatalf("saved note.bin: %v, or its SHA-256 differs from the source", err)
	}
}

// TestSendToNoProgressDrawsNoCarriageReturn: floe send --to <link>
// --no-progress reaches the engine (sendto.go's sendToOptions). The drop
// reaches an engine host and stdout holds no bar; without the flag the same
// drop draws one.
func TestSendToNoProgressDrawsNoCarriageReturn(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	src, sum := oneFile(t, t.TempDir(), "note.bin", 64<<10)
	out := t.TempDir()
	var mu sync.Mutex
	var doneFiles []transfer.FileDone
	h := startHost(t, s, deliveringHost(out, &doneFiles, &mu))
	r := runCLI(t, src, "--to", linkFor(), "--server", s.URL, "--no-progress")
	herr := h.wait(t)
	r.read(o)
	if r.err != nil || herr != nil {
		t.Fatalf("the drop failed: command %v, host %v\nstdout:\n%s\nstderr:\n%s", r.err, herr, r.stdout, r.stderr)
	}
	wantNoBar(t, "send --to --no-progress", r.stdout)
	if got, err := os.ReadFile(filepath.Join(out, "drop", "note.bin")); err != nil || sha256.Sum256(got) != sum {
		t.Fatalf("drop/note.bin: %v, or its SHA-256 differs from the source", err)
	}
}
