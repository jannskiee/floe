package main

// cliRun.wait's failure (sendto_test.go) names where every goroutine is. The
// command under test runs in the test process, so when it does not return
// within the bound, the stacks say where it was parked. A hang seen only on a
// CI runner used to leave one line, "the command did not return within 1m30s",
// and nothing to read it by.

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// parkedForTheWaitDump is where the child's stand-in command waits. Its name
// is what the parent looks for in the dump.
//
//go:noinline
func parkedForTheWaitDump(release <-chan struct{}) { <-release }

// TestCLIWaitTimeoutChild is the child: a command that never returns, waited
// for with a bound it cannot meet. The wait fails the test, which is the
// output the parent reads.
func TestCLIWaitTimeoutChild(t *testing.T) {
	if os.Getenv("FLOE_WAIT_CHILD") == "" {
		t.Skip("runs only as the child of TestCLIWaitTimeoutNamesWhereEveryGoroutineIs")
	}
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	r := &cliRun{done: make(chan struct{})}
	go func() {
		defer close(r.done)
		parkedForTheWaitDump(release)
	}()
	// Long enough for the goroutine above to reach its wait.
	r.wait(t, 200*time.Millisecond)
}

// TestCLIWaitTimeoutNamesWhereEveryGoroutineIs: a wait that runs out fails
// with its one line and, below it, every goroutine's stack, the parked
// command's among them.
func TestCLIWaitTimeoutNamesWhereEveryGoroutineIs(t *testing.T) {
	if os.Getenv("FLOE_WAIT_CHILD") != "" {
		t.Skip("the parent only")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCLIWaitTimeoutChild$", "-test.count=1", "-test.timeout=60s", "-test.v")
	cmd.Env = append(os.Environ(), "FLOE_WAIT_CHILD=1")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("the child passed, so its wait never ran out:\n%s", out)
	}
	text := string(out)
	for _, want := range []string{
		"the command did not return within 200ms",
		// runtime.Stack's header for each goroutine, and the frame the
		// stand-in command is parked in.
		"goroutine ",
		"parkedForTheWaitDump",
		// The dump is every goroutine's, not only the caller's: the test's
		// own goroutine, the one in wait, is in it too.
		"(*cliRun).wait",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the failed wait's output lacks %q:\n%s", want, text)
		}
	}
}
