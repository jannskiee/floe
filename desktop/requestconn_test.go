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
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
)

// failOnDemand stands failed in for every pairing's Failed channel. Call it
// before dropApp, not as its before hook: t.Cleanup runs last in, first out,
// so a restore registered after laneApp's cleanup ran while the lane goroutine
// still ran, and a pairing started then would read the seam mid-restore
// (review A1 F5). Registered first, the restore runs after laneApp's cleanup
// has waited for the lane to end. No lane exists yet here, so setting it races
// nothing either.
func failOnDemand(t *testing.T, failed chan struct{}) {
	setVar(t, &requestConnFailed, func(*peer.Connection) <-chan struct{} { return failed })
}

// TestRequestConnFailedIsTheConnectionsFailed pins the seam's default: the
// very channel peer.Connection.Failed returns. The drop tests stand a channel
// in for it, so a default that returned anything else left them green while
// watchConnFailed watched a channel that never closes: the drop back on its
// 60 s stall and the desktop's Send without a bound on its wait for a Go
// receiver's word (review A1 F1, probe P3). Identity of the channel, on a
// connection that binds nothing.
func TestRequestConnFailedIsTheConnectionsFailed(t *testing.T) {
	conn, err := peer.New(nil, &signaling.Client{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer conn.Close()
	if got := requestConnFailed(conn); got == nil || got != conn.Failed() {
		t.Fatalf("requestConnFailed(conn) = %v, want conn.Failed() (%v): watchConnFailed would never see an ICE failure", got, conn.Failed())
	}
}

// TestRunRequestDropEndsWhenTheConnectionFails: an accepted drop whose
// connection fails after file 1 committed stops with the ST14 code, with the
// committed file counted and kept, and the in-flight file's staging .part gone,
// within 5 s of the failure. Before, nothing but the receive's 60 s stall
// watchdog ended it.
func TestRunRequestDropEndsWhenTheConnectionFails(t *testing.T) {
	failed := make(chan struct{})
	failOnDemand(t, failed)
	a, _, f, room, base := dropApp(t, nil)
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
	// The in-flight file is on disk before the failure, so its absence after
	// is the stop path's removal and not a file that never existed (review
	// B-1 B2, as TestRunRequestDropCancelSendsStopped asserts for a Cancel).
	waitFor(t, 5*time.Second, "the in-flight file on disk", func() bool {
		for _, p := range treeUnder(t, base) {
			if strings.Contains(p, "two.bin") {
				return true
			}
		}
		return false
	})
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
	for _, p := range treeUnder(t, base) {
		if strings.HasSuffix(p, ".part") || strings.Contains(p, "two.bin") {
			t.Fatalf("the failed drop left %q", p)
		}
	}
}

// TestRequestDecideEndsWhenTheConnectionFails: the same failure while the
// owner decides ends the prompt as the visitor leaving (outcome left), so the
// link waits again with visitor-left and nothing exists on disk. Before, the
// prompt stayed up for its whole answer window.
func TestRequestDecideEndsWhenTheConnectionFails(t *testing.T) {
	failed := make(chan struct{})
	failOnDemand(t, failed)
	a, _, f, room, base := dropApp(t, nil)
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

// TestSendAndRequestDropWatchTheConnection pins the watcher's place in both
// of its callers: a watchConnFailed call before the engine call whose wait it
// bounds, its quit closed by a defer. runRequestDrop's is also driven above;
// runSend's (FT-GO-CONFIRMS step 2: the engine's wait for a Go receiver's
// word after the last file has no deadline) is pinned only here, because a
// Send over real pion needs a room this fake server does not pair.
func TestSendAndRequestDropWatchTheConnection(t *testing.T) {
	for _, c := range []struct{ fn, target string }{
		{"runSend", "SendFilesWithOptions"},
		{"runRequestDrop", "ReceiveFilesWithOptions"},
	} {
		watchAt, targetAt, quitDeferred := watcherShape(t, "transfer.go", c.fn, "watchConnFailed", c.target)
		switch {
		case !watchAt.IsValid():
			t.Errorf("%s never calls watchConnFailed: an ICE failure would leave %s's wait open", c.fn, c.target)
		case !targetAt.IsValid():
			t.Errorf("%s no longer calls %s; re-anchor this test", c.fn, c.target)
		case watchAt > targetAt:
			t.Errorf("%s calls watchConnFailed after %s, when the wait it bounds is already over", c.fn, c.target)
		case !quitDeferred:
			t.Errorf("watchConnFailed's quit is not closed by a defer in %s, so the watch could outlive it", c.fn)
		}
	}
}

// watcherShape finds, in the function or method fn of file, the first call
// to watcher and the first call to target (by the called name, qualified or
// not), and whether a `defer close(x)` in fn closes the watcher call's last
// argument. The twin of cli/cmd/floe's helper of the same name.
func watcherShape(t *testing.T, file, fn, watcher, target string) (watchAt, targetAt token.Pos, quitDeferred bool) {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	called := func(call *ast.CallExpr) string {
		switch fun := call.Fun.(type) {
		case *ast.Ident:
			return fun.Name
		case *ast.SelectorExpr:
			return fun.Sel.Name
		}
		return ""
	}
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Name.Name != fn || fd.Body == nil {
			continue
		}
		var quit string
		var closed []string
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.DeferStmt:
				if called(n.Call) == "close" && len(n.Call.Args) == 1 {
					if id, ok := n.Call.Args[0].(*ast.Ident); ok {
						closed = append(closed, id.Name)
					}
				}
			case *ast.CallExpr:
				switch called(n) {
				case watcher:
					if !watchAt.IsValid() {
						watchAt = n.Pos()
						if len(n.Args) > 0 {
							if last, ok := n.Args[len(n.Args)-1].(*ast.Ident); ok {
								quit = last.Name
							}
						}
					}
				case target:
					if !targetAt.IsValid() {
						targetAt = n.Pos()
					}
				}
			}
			return true
		})
		for _, name := range closed {
			quitDeferred = quitDeferred || (quit != "" && name == quit)
		}
		return watchAt, targetAt, quitDeferred
	}
	t.Fatalf("%s has no function %s; re-anchor this test", file, fn)
	return
}
