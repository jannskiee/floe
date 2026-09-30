package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jannskiee/floe/cli/engine/code"
)

// closedServer is a loopback port nothing listens on. Every test here that
// drives runReceive points the server at it (or at its own httptest server),
// so an input without "://", which Resolve sends to /api/code, can never reach
// the compiled default, the production server.
const closedServer = "http://127.0.0.1:9"

// A request or drop link pasted into `floe receive` is refused before any
// network call, with the approved sentence (TL-33) and nothing else: the
// generic "could not resolve %q" wrapper would print the whole link back, and
// for a request link that includes the room id in its fragment. The desktop
// returns the same sentinel bare for the same reason (desktop/transfer.go).
func TestReceiveRefusesALinkWithoutEchoingIt(t *testing.T) {
	old := flagServer
	flagServer = closedServer
	// runReceive prints the refusal itself and silences cobra for it (see
	// TestReceiveLinkRefusalPrintsTheApprovedLine for what the terminal shows).
	rootCmd.SetErr(io.Discard)
	t.Cleanup(func() {
		flagServer = old
		rootCmd.SetErr(nil)
		receiveCmd.SilenceErrors = false
	})

	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cases := []struct {
		name  string
		input string
		want  error
	}{
		{"request link", "https://floe.one/r/Xk3p9Q0aB1c#" + room, code.ErrRequestLink},
		{"drop link", "https://floe.one/d/Xk3p9Q0aB1c", code.ErrDropLink},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := runReceive(receiveCmd, []string{c.input})
			if err == nil {
				t.Fatalf("runReceive(%s) returned nil", c.name)
			}
			if !errors.Is(err, c.want) {
				t.Fatalf("error %q does not wrap the link sentinel", err)
			}
			if err.Error() != c.want.Error() {
				t.Fatalf("error text is %q, want the approved sentence alone: %q", err.Error(), c.want.Error())
			}
			for _, part := range []string{room, "Xk3p9Q0aB1c", "floe.one"} {
				if strings.Contains(err.Error(), part) {
					t.Fatalf("error text echoes %q from the pasted link: %q", part, err.Error())
				}
			}
		})
	}
}

// What the terminal shows for a pasted request or drop link, byte for byte:
// approved-copy-cli.txt, state receive-request-link (TL-33). runReceive's
// opening blank line on stdout, then the sentence on its own line with the
// two-space indent on stderr, and no cobra "Error: " prefix, because the
// refusal is an outcome, not a usage mistake. Execute still returns the
// sentinel, which main turns into exit 1.
func TestReceiveLinkRefusalPrintsTheApprovedLine(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cases := []struct {
		name  string
		input string
		want  error
	}{
		{"request link", "https://floe.one/r/Xk3p9Q0aB1c#" + room, code.ErrRequestLink},
		{"request link on a self-hosted base path", "https://files.example.com/floe/r/Xk3p9Q0aB1c/#" + room, code.ErrRequestLink},
		{"drop link", "https://floe.one/d/Xk3p9Q0aB1c", code.ErrDropLink},
		{"legacy drop link", "https://floe.one/drop/Xk3p9Q0aB1c", code.ErrDropLink},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stdout, stderr, err := receiveThroughCobra(t, c.input, closedServer)
			if !errors.Is(err, c.want) {
				t.Fatalf("Execute returned %v, want the link sentinel (main exits 1 on it)", err)
			}
			if stdout != "\n" {
				t.Errorf("stdout is %q, want the one blank line", stdout)
			}
			if want := "  " + c.want.Error() + "\n"; stderr != want {
				t.Errorf("stderr is %q, want the approved line %q", stderr, want)
			}
		})
	}
}

// Every other resolve failure keeps today's form: cobra's "Error: " prefix and
// the "could not resolve %q" wrapper around the resolver's text. Only the two
// link sentinels are returned without the wrapper. A plain URL without a room
// fails locally; a plain code is looked up on the server, here an httptest one
// that knows no code.
func TestReceiveOtherResolveErrorsKeepTheirWrapper(t *testing.T) {
	var mu sync.Mutex
	var lookups []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lookups = append(lookups, r.URL.Path)
		mu.Unlock()
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)

	cases := []struct {
		name   string
		input  string
		server string
		cause  string
		lookup string
	}{
		{
			name:   "plain URL without a room",
			input:  "https://floe.one/#foo=bar",
			server: closedServer,
			cause:  "URL does not contain a room id (#room= or ?room=)",
		},
		{
			name:   "plain code the server does not know",
			input:  "olive-tiger-castle",
			server: srv.URL,
			cause:  `code "olive-tiger-castle" not found or expired (codes expire after 10 minutes)`,
			lookup: "/api/code/olive-tiger-castle",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mu.Lock()
			lookups = nil
			mu.Unlock()
			stdout, stderr, err := receiveThroughCobra(t, c.input, c.server)
			if err == nil {
				t.Fatal("Execute returned nil, want the resolve error (main exits 1 on it)")
			}
			if errors.Is(err, code.ErrRequestLink) || errors.Is(err, code.ErrDropLink) {
				t.Fatalf("Execute returned a link sentinel for a plain input: %v", err)
			}
			if stdout != "\n" {
				t.Errorf("stdout is %q, want the one blank line", stdout)
			}
			want := fmt.Sprintf("Error: could not resolve %q: %s\n", c.input, c.cause)
			if stderr != want {
				t.Errorf("stderr is %q, want %q", stderr, want)
			}
			mu.Lock()
			got := append([]string(nil), lookups...)
			mu.Unlock()
			if c.lookup != "" && (len(got) != 1 || got[0] != c.lookup) {
				t.Errorf("server lookups %q, want exactly %q", got, c.lookup)
			}
		})
	}
}

// receiveThroughCobra runs `floe receive <input> --server <server>` through the
// real command tree, the way main does, and returns what the terminal would
// show: stdout (runReceive writes its blank line with fmt, straight to
// os.Stdout) and stderr (the error writer cobra prints to), with the error main
// turns into exit 1. Cobra keeps flag state, writers and arguments on the
// package-level tree between Execute calls, and runReceive sets receive's
// SilenceErrors for a link refusal, so all four are put back after.
func receiveThroughCobra(t *testing.T, input, server string) (stdout, stderr string, err error) {
	t.Helper()
	resetSharedFlags(t)
	receiveCmd.SilenceErrors = false
	t.Cleanup(func() {
		if f := rootCmd.PersistentFlags().Lookup("server"); f != nil {
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		}
		receiveCmd.SilenceErrors = false
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	var out, errOut strings.Builder
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	rootCmd.SetArgs([]string{"receive", input, "--server", server})
	stdout = captureStdout(t, func() { err = rootCmd.Execute() })
	return stdout + out.String(), errOut.String(), err
}

// captureStdout runs fn with os.Stdout pointed at a pipe and returns what fn
// wrote there. The pipe is drained while fn runs, so a write larger than the
// pipe buffer cannot block it.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	got := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		got <- string(b)
	}()
	orig := os.Stdout
	func() {
		defer func() { os.Stdout = orig }()
		os.Stdout = w
		fn()
	}()
	w.Close()
	s := <-got
	r.Close()
	return s
}
