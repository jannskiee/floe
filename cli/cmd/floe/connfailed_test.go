package main

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
)

// TestCloseOnFailedClosesTheConnection: when the connection fails, the
// watcher closes it, which is what ends a delivery wait with no deadline of
// its own. SetupAsReceiver is the probe: on a closed connection it returns
// ErrClosed at once, and on an open one it waits for an offer that never
// comes here. Nothing binds: no offer arrives, so ICE never gathers.
func TestCloseOnFailedClosesTheConnection(t *testing.T) {
	conn, err := peer.New(nil, &signaling.Client{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer conn.Close()
	failed := make(chan struct{})
	old := connFailed
	connFailed = func(*peer.Connection) <-chan struct{} { return failed }
	t.Cleanup(func() { connFailed = old })
	quit := make(chan struct{})
	defer close(quit)
	closeOnFailed(conn, quit)

	setup := make(chan error, 1)
	go func() {
		_, err := conn.SetupAsReceiver()
		setup <- err
	}()
	select {
	case err := <-setup:
		t.Fatalf("setup returned %v before the connection failed", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(failed)
	select {
	case err := <-setup:
		if !errors.Is(err, peer.ErrClosed) {
			t.Fatalf("setup returned %v after the connection failed; want peer.ErrClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the connection was still open 5s after it failed")
	}
}

// TestRunSendWatchesTheConnection pins the watcher's place in runSend: a
// closeOnFailed call before the SendFilesWithOptions call, its quit closed by
// a defer, so the wait for a Go receiver's word has its bound and the watch
// ends with the send. A source-shape check, because driving floe send to an
// ICE failure means waiting out ICE.
func TestRunSendWatchesTheConnection(t *testing.T) {
	watchAt, sendAt, quitDeferred := watcherShape(t, "send.go", "runSend", "closeOnFailed", "SendFilesWithOptions")
	switch {
	case !watchAt.IsValid():
		t.Fatal("runSend never calls closeOnFailed: an ICE failure would leave the wait for the receiver's word open")
	case !sendAt.IsValid():
		t.Fatal("runSend no longer calls SendFilesWithOptions; re-anchor this test")
	case watchAt > sendAt:
		t.Fatal("runSend calls closeOnFailed after SendFilesWithOptions, when the wait it bounds is already over")
	case !quitDeferred:
		t.Fatal("closeOnFailed's quit is not closed by a defer in runSend, so the watch could outlive the send")
	}
}

// watcherShape finds, in the function fn of file, the first call to watcher
// and the first call to target (by the called name, qualified or not), and
// whether a `defer close(x)` in fn closes the watcher call's last argument.
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
