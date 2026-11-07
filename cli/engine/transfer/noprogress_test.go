package transfer

// --no-progress (issue #688): an invisible bar object, no carriage returns in
// stdout, and a piped Accept answer that ends its own line when the bar is off.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// TestNoProgressBarZeroValueOff: GUIs and today's CLI leave NoProgressBar false.
func TestNoProgressBarZeroValueOff(t *testing.T) {
	if (SendOptions{}).NoProgressBar || (ReceiveOptions{}).NoProgressBar {
		t.Fatal("a zero SendOptions or ReceiveOptions turns NoProgressBar on")
	}
}

// TestNoProgressBarSenderDrawsNothing: with NoProgressBar the sender's stdout
// has no carriage return and no bar glyphs, while the transfer still succeeds.
// Shape from barLineRun / deliverTwo (issue #688 how-to-test).
func TestNoProgressBarSenderDrawsNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte(strings.Repeat("x", 64<<10)), 0o600); err != nil {
		t.Fatal(err)
	}
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}
	out := t.TempDir()
	restore := captureStdout(t)
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(rdc, out, true, "", "", ReceiveOptions{
			NoProgressBar: true, Messages: msgs, Closed: closed,
		})
	}()
	err := SendFilesWithOptions(sender, []string{src}, "", SendOptions{NoProgressBar: true})
	_ = sender.Close()
	select {
	case rerr := <-recvErr:
		if rerr != nil {
			t.Fatalf("receive: %v", rerr)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the receive never returned")
	}
	printed := restore()
	if err != nil {
		t.Fatalf("send: %v\nstdout:\n%s", err, printed)
	}
	assertNoProgressOutput(t, printed)
}

// TestNoProgressBarReceiverDrawsNothing: receiver side of the same contract,
// loopback shape from runTransfer (issue #688 how-to-test).
func TestNoProgressBarReceiverDrawsNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()
	src := filepath.Join(t.TempDir(), "only.txt")
	if err := os.WriteFile(src, []byte("only file"), 0o600); err != nil {
		t.Fatal(err)
	}
	outDir := t.TempDir()
	restore := captureStdout(t)
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", ReceiveOptions{NoProgressBar: true})
	}()
	time.Sleep(300 * time.Millisecond)
	if err := SendFilesWithOptions(sender, []string{src}, "", SendOptions{NoProgressBar: true}); err != nil {
		t.Fatalf("SendFilesWithOptions: %v", err)
	}
	_ = sender.Close()
	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("ReceiveFilesWithOptions: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not complete")
	}
	printed := restore()
	assertNoProgressOutput(t, printed)
	if got, readErr := os.ReadFile(filepath.Join(outDir, "only.txt")); readErr != nil || string(got) != "only file" {
		t.Fatalf("saved file: %q, %v", got, readErr)
	}
}

// TestNoProgressBarPipedAcceptEndsThePromptLine: a piped yes with the bar off
// must not leave the next status line on the prompt's row (issue #688).
// printSummary also starts with a blank line, so a bare "ends with \\n" check
// would pass even without the prompt's own break. Require the blank line the
// prompt adds (prompt \\n, then printSummary's \\n) so a revert fails.
func TestNoProgressBarPipedAcceptEndsThePromptLine(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	p := newOffererPair(t, nil)
	srcDir := t.TempDir()
	writeRandom(t, srcDir, "album/cover.txt", 1500)
	swapStdin(t, "y\n")
	printed := captureStdout(t)

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, outDir, false, "test-ver", "", ReceiveOptions{
			NoProgressBar: true,
			Messages:      p.hostMsgs,
			Closed:        p.hostClosed,
		})
	}()
	sendErr := make(chan error, 1)
	go func() {
		sendErr <- SendFilesWithOptions(p.visitor, []string{filepath.Join(srcDir, "album")}, "test-ver", SendOptions{
			Messages:      p.visitorMsgs,
			Closed:        p.visitorClosed,
			NoSummary:     true,
			NoProgressBar: true,
		})
	}()
	p.finish(t, sendErr, recvErr, 30*time.Second)

	out := printed()
	assertNoProgressOutput(t, out)
	at := strings.Index(out, promptText)
	if at < 0 {
		t.Fatalf("the prompt did not run:\n%s", out)
	}
	// After "Accept? [Y/n]" the Print left a trailing space. With --no-progress
	// the prompt itself prints a line break, then printSummary prints another,
	// so the tail starts with " \n\n".
	if !strings.HasPrefix(out[at+len(promptText):], " \n\n") {
		t.Fatalf("piped Accept with --no-progress did not end the prompt's line before the next output; it reads %q",
			strings.SplitN(out[at:], "\n", 2)[0])
	}
}

func assertNoProgressOutput(t *testing.T, out string) {
	t.Helper()
	if strings.Contains(out, "\r") {
		t.Fatalf("stdout still holds a carriage return:\n%q", out)
	}
	if strings.ContainsAny(out, "█░") {
		t.Fatalf("stdout still holds bar glyphs:\n%q", out)
	}
}
