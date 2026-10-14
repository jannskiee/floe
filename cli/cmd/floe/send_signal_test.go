//go:build linux || darwin

package main

// The plain send's Ctrl+C through the real main(), in a child process, with a
// real SIGINT: exit 130 and "Canceled." alone. The in-process tests
// (send_ctrlc_test.go) prove the same through handleInterrupts with a recorded
// exit and a park they release; this one proves main's own wiring, where the
// stopped send must stay parked so that neither its error line nor main's exit
// 1 can come before the handler's 130. Linux and macOS only, for the reason
// sendto_signal_test.go gives.

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/pion/webrtc/v4"
)

// TestPlainSendRealSignalChild is the child: it serves the fake plain room and
// a receiver whose person has not answered yet in process, runs main() on floe
// send, and signals itself once the receiver holds the first metadata. main
// then exits, so the test never returns on its own.
func TestPlainSendRealSignalChild(t *testing.T) {
	if os.Getenv("FLOE_SEND_SIGNAL_CHILD") == "" {
		t.Skip("runs only as the child of TestPlainSendRealSignal")
	}
	url, seated := plainRoom(t)
	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	reached := make(chan struct{})
	plainReceiver(t, url, seated, func(_ *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
		if _, ok := awaitFirstMetadata(early, quit); !ok {
			return
		}
		close(reached)
		var heard heardFromSender
		heard.listen(early, quit, 20*time.Second, nil)
	})
	go func() {
		<-reached
		_ = syscall.Kill(os.Getpid(), syscall.SIGINT)
	}()
	os.Args = []string{"floe", "send", src, "--server", url}
	main()
	t.Fatal("main returned: neither exit came")
}

// TestPlainSendRealSignal: a real SIGINT to the real main(), while the
// receiver has not answered, exits 130 with "Canceled." alone on stderr.
func TestPlainSendRealSignal(t *testing.T) {
	if os.Getenv("FLOE_SEND_SIGNAL_CHILD") != "" {
		t.Skip("the parent only")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestPlainSendRealSignalChild$", "-test.count=1", "-test.timeout=60s")
	cmd.Env = append(os.Environ(), "FLOE_SEND_SIGNAL_CHILD=1", "FLOE_NO_STATS=1")
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("the child did not run: %v", err)
	}
	if got := pionLog.ReplaceAllString(stderr.String(), ""); code != 130 || got != canceledAlone {
		t.Fatalf("exit %d, stderr %q; want 130 and %q\nstdout:\n%s", code, got, canceledAlone, stdout.String())
	}
}
