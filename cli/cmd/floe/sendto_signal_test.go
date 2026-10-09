//go:build linux || darwin

package main

// The request-link send's Ctrl+C through the real main(), in a child process,
// with a real SIGINT: exit 130 and the one line (TL-28, TL-29). The in-process
// tests (sendto_ctrlc_test.go) prove the same through handleInterrupts with a
// recorded exit; this one proves main's own wiring, which is what review lens
// A's probe caught exiting 1 with a second line. Linux and macOS only: a child
// there can signal itself, where Windows delivers Ctrl+C to a console process
// group a test child cannot count on having.

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// TestSendToRealSignalChild is the child: it serves the fake request room and
// a Floe Desktop-like host in process, runs main() on floe send --to, and
// signals itself once the phase is reached. main then exits, so the test never
// returns on its own.
func TestSendToRealSignalChild(t *testing.T) {
	mode := os.Getenv("FLOE_SIGNAL_CHILD")
	if mode == "" {
		t.Skip("runs only as the child of TestSendToRealSignal")
	}
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	size := 4096
	if mode == "TL29" {
		size = 64 << 20
	}
	p, _ := oneFile(t, t.TempDir(), "a.bin", size)
	out := t.TempDir()
	reached := make(chan struct{})
	var once sync.Once
	startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		// Floe Desktop closes the moment its receive returns.
		defer h.conn.Close()
		closed := h.early.Closed
		return transfer.ReceiveFilesWithOptions(h.dc, out, false, "desktop-test", "", transfer.ReceiveOptions{
			OnProgress: func(pr transfer.Progress) {
				if mode == "TL29" && pr.FileBytes > 0 {
					once.Do(func() { close(reached) })
				}
			},
			Decide: func(transfer.IncomingInfo) transfer.Decision {
				if mode == "TL28" {
					// The person is still deciding when the visitor stops.
					once.Do(func() { close(reached) })
					select {
					case <-closed:
					case <-h.quit:
					}
					return transfer.Decision{Kind: transfer.DecisionRefuse, Code: transfer.CodeStopped}
				}
				return transfer.Decision{Kind: transfer.DecisionAccept, OutputDir: out}
			},
			Messages: h.early.Msgs,
			Closed:   h.early.Closed,
		})
	})
	go func() {
		<-reached
		_ = syscall.Kill(os.Getpid(), syscall.SIGINT)
	}()
	os.Args = []string{"floe", "send", p, "--to", linkFor(), "--server", s.URL}
	main()
	t.Fatal("main returned: neither exit came")
}

// TestSendToRealSignal: a real SIGINT to the real main(), while the host
// decides (TL-28) and mid-file (TL-29), exits 130 with the one line.
func TestSendToRealSignal(t *testing.T) {
	if os.Getenv("FLOE_SIGNAL_CHILD") != "" {
		t.Skip("the parent only")
	}
	for _, c := range []struct{ mode, line string }{
		{"TL28", tl28Line + "\n"},
		{"TL29", tl29Line + "\n"},
	} {
		t.Run(c.mode, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestSendToRealSignalChild$", "-test.count=1", "-test.timeout=60s")
			cmd.Env = append(os.Environ(), "FLOE_SIGNAL_CHILD="+c.mode, "FLOE_NO_STATS=1")
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
			if got := pionLog.ReplaceAllString(stderr.String(), ""); code != 130 || got != c.line {
				t.Fatalf("exit %d, stderr %q; want 130 and %q\nstdout:\n%s", code, got, c.line, stdout.String())
			}
		})
	}
}
