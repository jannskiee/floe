package main

// CLI --no-progress (issue #688): flag wiring and a receive whose stdout has
// no carriage return.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
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
