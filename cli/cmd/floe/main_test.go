package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
)

// TestConnectedLine pins the three shapes the status line can take. The bare
// word is the fail-open shape: other tooling matches it as a prefix, so an
// unreadable or unknown route must never produce anything else.
func TestConnectedLine(t *testing.T) {
	tests := []struct {
		name string
		ct   string
		err  error
		want string
	}{
		{"direct", "direct", nil, "  Connected (direct)"},
		{"relay", "relay", nil, "  Connected (relay)"},
		{"an error wins over a route", "direct", errors.New("no candidate pair selected"), "  Connected"},
		{"empty route", "", nil, "  Connected"},
		{"unknown route", "srflx", nil, "  Connected"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := connectedLine(tc.ct, tc.err); got != tc.want {
				t.Errorf("connectedLine(%q, %v) = %q, want %q", tc.ct, tc.err, got, tc.want)
			}
		})
	}
}

// TestSetupFailureLine: a setup that stopped because the other side left,
// the server went away or the connection was closed ends with the sentinel's
// own fixed sentence, found through any wrapping; every other setup failure
// keeps today's "WebRTC setup failed: " line byte for byte, which is what
// fmt.Errorf("WebRTC setup failed: %w", err) printed before.
func TestSetupFailureLine(t *testing.T) {
	stopped := []struct {
		name     string
		sentinel error
		stage    string
	}{
		{"peer left", peer.ErrPeerLeft, peer.StagePeerLeft},
		{"signaling lost", peer.ErrSignalingLost, peer.StageSignalingLost},
		{"closed", peer.ErrClosed, peer.StageClosed},
	}
	for _, tc := range stopped {
		t.Run(tc.name, func(t *testing.T) {
			err := &peer.SetupError{Stage: tc.stage, Err: tc.sentinel}
			if got := setupFailureLine(err); got != tc.sentinel.Error() {
				t.Errorf("setupFailureLine = %q, want %q", got, tc.sentinel.Error())
			}
			wrapped := fmt.Errorf("outer: %w", err)
			if got := setupFailureLine(wrapped); got != tc.sentinel.Error() {
				t.Errorf("through a wrap: %q, want %q", got, tc.sentinel.Error())
			}
		})
	}
	for _, err := range []error{
		&peer.SetupError{Stage: peer.StageConnect, Err: errors.New("timed out establishing a connection")},
		&peer.SetupError{Stage: peer.StageOffer, Err: errors.New("timed out waiting for the peer's offer")},
		&peer.SetupError{Stage: peer.StageChannel, Err: errors.New("connected but the data channel did not open")},
		errors.New("something else entirely"),
	} {
		want := fmt.Errorf("WebRTC setup failed: %w", err).Error()
		if got := setupFailureLine(err); got != want {
			t.Errorf("setupFailureLine(%v) = %q, want today's %q", err, got, want)
		}
	}
}

// TestInterruptLine: with no hook, Ctrl+C prints "Canceled." as it always
// has and stops nothing; a hook, while one is set, picks the line, and its
// stop runs only when the handler calls it, after the print.
func TestInterruptLine(t *testing.T) {
	line, stop := interruptLine()
	if line != "\n  Canceled." || stop == nil {
		t.Fatalf("with no hook, Ctrl+C prints %q (stop %v)", line, stop != nil)
	}
	stop()

	stopped := false
	hook := func() (string, func()) { return "\n  Hooked.", func() { stopped = true } }
	interruptHook.Store(&hook)
	t.Cleanup(func() { interruptHook.Store(nil) })
	line, stop = interruptLine()
	if line != "\n  Hooked." {
		t.Fatalf("with a hook, Ctrl+C prints %q", line)
	}
	if stopped {
		t.Fatal("the hook's stop ran before the handler called it")
	}
	stop()
	if !stopped {
		t.Fatal("the hook's stop did not run")
	}
	interruptHook.Store(nil)
	if line, _ := interruptLine(); line != "\n  Canceled." {
		t.Fatalf("after the hook is cleared, Ctrl+C prints %q", line)
	}
}

// exitRecorder stands in for os.Exit in handleInterrupts: it records the code
// and ends the calling goroutine, because os.Exit never returns either.
type exitRecorder chan int

func (e exitRecorder) exit(code int) {
	e <- code
	runtime.Goexit()
}

// awaitExit returns the next recorded exit code, or fails at bound.
func (e exitRecorder) awaitExit(t *testing.T, bound time.Duration, what string) int {
	t.Helper()
	select {
	case code := <-e:
		return code
	case <-time.After(bound):
		t.Fatalf("%s: no exit within %v", what, bound)
		return 0
	}
}

// startHandler runs main's handler on a test channel with a recording exit,
// under a Ctrl+C hook of the test's own. Closing the channel at the end
// frees the goroutine that waits for a second signal.
func startHandler(t *testing.T, hook func() (string, func())) (chan os.Signal, exitRecorder) {
	t.Helper()
	interruptHook.Store(&hook)
	sig := make(chan os.Signal, 1)
	exits := make(exitRecorder, 4)
	go handleInterrupts(sig, exits.exit)
	t.Cleanup(func() {
		close(sig)
		interruptHook.Store(nil)
	})
	return sig, exits
}

// TestHandleInterruptsPrintsStopsAndExits130: the first signal prints the
// hook's line, runs its stop and exits 130, as main always has.
func TestHandleInterruptsPrintsStopsAndExits130(t *testing.T) {
	o := captureOutput(t)
	stopped := false
	sig, exits := startHandler(t, func() (string, func()) {
		return "\n  Hooked.", func() { stopped = true }
	})
	sig <- os.Interrupt
	if code := exits.awaitExit(t, 5*time.Second, "one Ctrl+C"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	if !stopped {
		t.Fatal("the hook's stop did not run before the exit")
	}
	if _, stderr := o.text(); stderr != "\n  Hooked.\n" {
		t.Fatalf("stderr = %q, want the hook's line alone", stderr)
	}
}

// TestHandleInterruptsSecondSignalEndsAtOnce: a second Ctrl+C while the stop
// still runs exits 130 at once instead of waiting it out (review lens A,
// nit 11).
func TestHandleInterruptsSecondSignalEndsAtOnce(t *testing.T) {
	o := captureOutput(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	sig, exits := startHandler(t, func() (string, func()) {
		return "\n  Hooked.", func() {
			close(entered)
			<-release
		}
	})
	sig <- os.Interrupt
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the stop never ran")
	}
	sig <- os.Interrupt
	if code := exits.awaitExit(t, 2*time.Second, "a second Ctrl+C during the stop"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	close(release)
	exits.awaitExit(t, 5*time.Second, "the first handler after its stop")
	if _, stderr := o.text(); stderr != "\n  Hooked.\n" {
		t.Fatalf("stderr = %q, want the hook's line once", stderr)
	}
}

// TestHandleInterruptsLeavesAFinishedCommandAlone: a hook with no stop (the
// command already has its outcome) gets no line and no exit from the first
// signal, so the command ends with its own code; a second signal still ends
// it at once.
func TestHandleInterruptsLeavesAFinishedCommandAlone(t *testing.T) {
	o := captureOutput(t)
	sig, exits := startHandler(t, func() (string, func()) { return "", nil })
	sig <- os.Interrupt
	select {
	case code := <-exits:
		t.Fatalf("exit %d on a command that already had its outcome", code)
	case <-time.After(300 * time.Millisecond):
	}
	sig <- os.Interrupt
	if code := exits.awaitExit(t, 2*time.Second, "a second Ctrl+C"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	if _, stderr := o.text(); stderr != "" {
		t.Fatalf("stderr = %q, want nothing", stderr)
	}
}

// sharedFlagNames are the persistent flags these tests type or read. --iface
// is left out on purpose: its default renders as "[]", which pflag would parse
// back as a one-element slice.
var sharedFlagNames = []string{"server", "no-relay", "relay-only", "web"}

// resetSharedFlags returns each shared flag, and the variable bound to it, to
// its compiled default. Cobra keeps flag state on the package-level rootCmd
// between Execute calls, so without this a flag typed in one test would still
// read as Changed in the next. It also blanks the FLOE_* variables for the
// duration of the test so a developer's shell cannot leak into a case.
func resetSharedFlags(t *testing.T) {
	t.Helper()
	for _, name := range sharedFlagNames {
		f := rootCmd.PersistentFlags().Lookup(name)
		if f == nil {
			t.Fatalf("flag --%s is not registered on the root command", name)
		}
		if err := f.Value.Set(f.DefValue); err != nil {
			t.Fatalf("reset --%s to %q: %v", name, f.DefValue, err)
		}
		f.Changed = false
	}
	for _, k := range []string{"FLOE_SERVER", "FLOE_WEB", "FLOE_RELAY_ONLY"} {
		t.Setenv(k, "")
	}
}

// TestApplyEnvPrecedence drives the env-to-flag step directly, with a fake
// environment, over the real flag definitions: a typed flag beats its
// variable, an unset variable leaves the default alone, and a typed --no-relay
// beats FLOE_RELAY_ONLY because the pair can never both be on.
func TestApplyEnvPrecedence(t *testing.T) {
	tests := []struct {
		name          string
		args          []string
		env           map[string]string
		wantServer    string
		wantWeb       string
		wantRelayOnly bool
		wantNoRelay   bool
	}{
		{
			name:       "nothing typed, nothing set: compiled defaults",
			wantServer: "https://api.floe.one",
		},
		{
			name:       "FLOE_SERVER and FLOE_WEB fill in untyped flags",
			env:        map[string]string{"FLOE_SERVER": "https://floe.example.com", "FLOE_WEB": "https://app.example.com"},
			wantServer: "https://floe.example.com",
			wantWeb:    "https://app.example.com",
		},
		{
			name:       "a typed --server beats FLOE_SERVER",
			args:       []string{"--server", "http://localhost:3001"},
			env:        map[string]string{"FLOE_SERVER": "https://floe.example.com"},
			wantServer: "http://localhost:3001",
		},
		{
			name:          "FLOE_RELAY_ONLY=1 turns the flag on",
			env:           map[string]string{"FLOE_RELAY_ONLY": "1"},
			wantServer:    "https://api.floe.one",
			wantRelayOnly: true,
		},
		{
			name:       "FLOE_RELAY_ONLY must be exactly 1",
			env:        map[string]string{"FLOE_RELAY_ONLY": "true"},
			wantServer: "https://api.floe.one",
		},
		{
			name:          "a typed --relay-only with the variable set stays on",
			args:          []string{"--relay-only"},
			env:           map[string]string{"FLOE_RELAY_ONLY": "1"},
			wantServer:    "https://api.floe.one",
			wantRelayOnly: true,
		},
		{
			name:        "a typed --no-relay beats FLOE_RELAY_ONLY",
			args:        []string{"--no-relay"},
			env:         map[string]string{"FLOE_RELAY_ONLY": "1"},
			wantServer:  "https://api.floe.one",
			wantNoRelay: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resetSharedFlags(t)
			if err := rootCmd.ParseFlags(tc.args); err != nil {
				t.Fatalf("ParseFlags(%v): %v", tc.args, err)
			}
			applyEnv(rootCmd, func(k string) string { return tc.env[k] })

			if flagServer != tc.wantServer {
				t.Errorf("flagServer = %q, want %q", flagServer, tc.wantServer)
			}
			if flagWebURL != tc.wantWeb {
				t.Errorf("flagWebURL = %q, want %q", flagWebURL, tc.wantWeb)
			}
			if flagRelayOnly != tc.wantRelayOnly {
				t.Errorf("flagRelayOnly = %v, want %v", flagRelayOnly, tc.wantRelayOnly)
			}
			if flagNoRelay != tc.wantNoRelay {
				t.Errorf("flagNoRelay = %v, want %v", flagNoRelay, tc.wantNoRelay)
			}
		})
	}
}

// runRoot executes the real command tree the way main does, through cobra, so
// the root PersistentPreRunE and the flag-group validation both run. The
// arguments follow the `help` subcommand, the cheapest command that still
// passes through both. Output is discarded.
func runRoot(t *testing.T, env map[string]string, args ...string) error {
	t.Helper()
	resetSharedFlags(t)
	for k, v := range env {
		t.Setenv(k, v)
	}
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(io.Discard)
	rootCmd.SetArgs(append([]string{"help"}, args...))
	return rootCmd.Execute()
}

// TestRelayOnlyAndNoRelayAreMutuallyExclusive proves the pair is refused by
// cobra's own group validation when both are typed, on the real command tree.
func TestRelayOnlyAndNoRelayAreMutuallyExclusive(t *testing.T) {
	err := runRoot(t, nil, "--relay-only", "--no-relay")
	if err == nil {
		t.Fatal("--relay-only --no-relay was accepted, want cobra's mutual-exclusion error")
	}
	for _, want := range []string{"relay-only", "no-relay", "none of the others can be"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

// TestRelayOnlyThroughTheCommandTree proves the wiring, not the logic: the
// flag and the variable each reach flagRelayOnly through the real hook, and a
// variable-set relay-only next to a typed --no-relay is resolved in favor of
// the typed flag rather than tripping the group validation.
func TestRelayOnlyThroughTheCommandTree(t *testing.T) {
	tests := []struct {
		name          string
		env           map[string]string
		args          []string
		wantRelayOnly bool
		wantNoRelay   bool
	}{
		{"flag alone", nil, []string{"--relay-only"}, true, false},
		{"variable alone", map[string]string{"FLOE_RELAY_ONLY": "1"}, nil, true, false},
		{"neither", nil, nil, false, false},
		{"variable set, --no-relay typed", map[string]string{"FLOE_RELAY_ONLY": "1"}, []string{"--no-relay"}, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := runRoot(t, tc.env, tc.args...); err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if flagRelayOnly != tc.wantRelayOnly {
				t.Errorf("flagRelayOnly = %v, want %v", flagRelayOnly, tc.wantRelayOnly)
			}
			if flagNoRelay != tc.wantNoRelay {
				t.Errorf("flagNoRelay = %v, want %v", flagNoRelay, tc.wantNoRelay)
			}
		})
	}
}

// TestRequireRelay pins the CLI half of issue #281. Against a server with no
// TURN relay, --relay-only has nowhere to go: ICE gathers no usable candidate
// and the run ends thirty seconds later on the same
// "timed out establishing a connection" that --no-relay produces when no direct
// path exists. Two opposite causes, one message, neither naming the flag.
//
// The first case is the one a careless implementation breaks: a STUN-only
// server is a perfectly good server without the flag, and must not be refused.
func TestRequireRelay(t *testing.T) {
	origFlag, origServer := flagRelayOnly, flagServer
	t.Cleanup(func() { flagRelayOnly, flagServer = origFlag, origServer })
	flagServer = "https://floe.example.com"

	cases := []struct {
		name      string
		relayOnly bool
		hasRelay  bool
		degraded  bool
		wantError bool
		// A fragment only the could-not-be-read wording carries, so the two
		// causes cannot be confused for each other.
		wantUnread bool
	}{
		{"a relay-less server is fine without the flag", false, false, false, false, false},
		{"a relay-less server is refused with the flag", true, false, false, true, false},
		{"a relay-capable server is fine with the flag", true, true, false, false, false},
		{"a relay-capable server is fine without the flag", false, true, false, false, false},
		// The STUN-only fallback, not the server's answer. Saying the server
		// "offers none" would blame a configuration nobody has seen; the usual
		// causes are a wrong --server, an un-proxied /api/, and the TURN
		// endpoint's own rate limiter.
		{"a list that could not be read does not blame the server", true, false, true, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flagRelayOnly = tc.relayOnly
			err := requireRelay(tc.hasRelay, tc.degraded)
			if (err != nil) != tc.wantError {
				t.Fatalf("requireRelay(%v, %v) with flagRelayOnly=%v = %v, wantError %v",
					tc.hasRelay, tc.degraded, tc.relayOnly, err, tc.wantError)
			}
			if err != nil {
				if got := strings.Contains(err.Error(), "could not be read"); got != tc.wantUnread {
					t.Errorf("error %q: could-not-be-read wording = %v, want %v", err, got, tc.wantUnread)
				}
			}
			if err == nil {
				return
			}
			// Naming the flag is the point: the message it replaces did not,
			// which is why the same timeout covered two opposite causes.
			if !strings.Contains(err.Error(), "--relay-only") {
				t.Errorf("error %q does not name the flag that caused it", err)
			}
			// And the server, so a wrong --server is visible in the message.
			if !strings.Contains(err.Error(), flagServer) {
				t.Errorf("error %q does not name the server it asked", err)
			}
		})
	}
}
