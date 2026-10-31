//go:build windows

package main

import (
	"runtime"
	"testing"

	"golang.org/x/sys/windows"
)

// TestClipboardReadOpensAndClosesOnOneThread: the open, the read and the close
// run on one OS thread. With one P, the helper locks the reader's thread and
// waits there, so a reader that is not locked must go on on another one. The
// three steps are fakes, so the real clipboard is never touched.
func TestClipboardReadOpensAndClosesOnOneThread(t *testing.T) {
	prevOpen, prevData, prevClose := clipboardOpen, clipboardData, clipboardClose
	prevProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() {
		clipboardOpen, clipboardData, clipboardClose = prevOpen, prevData, prevClose
		runtime.GOMAXPROCS(prevProcs)
	})
	release := make(chan struct{})
	defer close(release) // the helper then ends, and its locked thread with it
	var opened, closed uint32
	clipboardOpen = func() bool {
		opened = windows.GetCurrentThreadId()
		return true
	}
	clipboardData = func(uintptr) []byte {
		ready := make(chan struct{})
		go func() {
			runtime.LockOSThread()
			close(ready)
			<-release
		}()
		<-ready
		return []byte("x")
	}
	clipboardClose = func() { closed = windows.GetCurrentThreadId() }

	if got := string(readClipboard(cfHDROP)); got != "x" {
		t.Fatalf("readClipboard = %q, want %q", got, "x")
	}
	if opened != closed {
		t.Fatalf("opened the clipboard on thread %d, closed it on thread %d", opened, closed)
	}
}
