package main

// G5-F1: a visitor that vanished (a discarded or crashed tab, a network that
// went away) sends no close the host can hear, and during a drop the lane
// reads neither signaling nor any connection state (spec 06 4.17). ICE giving
// up on the path is the one thing that still happens, about 30 s after the
// last packet, so the lane now closes the connection on it and the drop ends
// through the path a close always takes. The failure comes through the
// requestConnFailed seam here, so no test waits out ICE.

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
)

// failOnDemand is a dropApp before hook that stands failed in for every
// pairing's Failed channel. It runs before Make link, while no lane goroutine
// exists yet, so the seam is set without racing the lane.
func failOnDemand(t *testing.T, failed chan struct{}) func(*App) {
	return func(*App) {
		setVar(t, &requestConnFailed, func(*peer.Connection) <-chan struct{} { return failed })
	}
}

// TestRunRequestDropEndsWhenTheConnectionFails: an accepted drop whose
// connection fails after file 1 committed stops with the ST14 code, with the
// committed file counted and kept, within 5 s of the failure. Before, nothing
// but the receive's 60 s stall watchdog ended it.
func TestRunRequestDropEndsWhenTheConnectionFails(t *testing.T) {
	failed := make(chan struct{})
	a, _, f, room, _ := dropApp(t, failOnDemand(t, failed))
	v := joinVisitor(t, f, room)
	v.connect(t)
	one, two := []byte("first file"), randomBytes(t, 64<<10)
	total := int64(len(one) + len(two))
	v.sendText(metaFrame(1, 2, "one.txt", int64(len(one)), total))
	acceptNext(t, a)
	v.frameOfType(t, "ack", 10*time.Second)
	v.sendBin(one)
	v.sendText(endFrame(one))
	v.sendText(metaFrame(2, 2, "two.bin", int64(len(two)), total))
	v.frameOfType(t, "ack", 10*time.Second) // file 1 is committed before this ack
	v.sendBin(two[:1<<10])
	time.Sleep(100 * time.Millisecond)
	if st := stateOf(a).State; st != "receiving" {
		t.Fatalf("the drop is %q before the failure, want receiving", st)
	}

	fired := time.Now()
	close(failed) // the visitor says nothing more and closes nothing
	s := waitSnap(t, a, 5*time.Second, "stopped", "unknown")
	t.Logf("the drop stopped %v after the connection failed", time.Since(fired).Round(time.Millisecond))
	if s.Result == nil || s.Result.Saved != 1 {
		t.Fatalf("result %+v, want the committed file counted", s.Result)
	}
	if got, err := os.ReadFile(filepath.Join(s.Result.Folder, "one.txt")); err != nil || !bytes.Equal(got, one) {
		t.Fatalf("the committed file is gone: %v", err)
	}
}

// TestRequestDecideEndsWhenTheConnectionFails: the same failure while the
// owner decides ends the prompt as the visitor leaving (outcome left), so the
// link waits again with visitor-left and nothing exists on disk. Before, the
// prompt stayed up for its whole answer window.
func TestRequestDecideEndsWhenTheConnectionFails(t *testing.T) {
	failed := make(chan struct{})
	a, _, f, room, base := dropApp(t, failOnDemand(t, failed))
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.sendText(metaFrame(1, 1, "a.txt", 4, 4))
	deciding(t, a)

	fired := time.Now()
	close(failed)
	waitSnap(t, a, 5*time.Second, "waiting", "visitor-left")
	t.Logf("the prompt ended %v after the connection failed", time.Since(fired).Round(time.Millisecond))
	if got := treeUnder(t, base); len(got) != 0 {
		t.Fatalf("the save base holds %q after a prompt nobody answered", got)
	}
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
}
