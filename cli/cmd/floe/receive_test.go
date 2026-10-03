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
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
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
	// runReceive returns the refusal for execute to print (see
	// TestReceiveLinkRefusalPrintsTheApprovedLine for what the terminal shows).
	rootCmd.SetErr(io.Discard)
	t.Cleanup(func() {
		flagServer = old
		rootCmd.SetErr(nil)
	})

	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cases := []struct {
		name  string
		input string
		want  error
	}{
		{"request link", "https://floe.one/r/Xk3p9Q0aB1c#" + room, code.ErrRequestLink},
		{"drop link", "https://floe.one/d/Xk3p9Q0aB1c", code.ErrDropLink},
		// FT-LINK-ECHO-F2, the review's X1 to X4: shapes the path checks used
		// to miss. X1 went to the server as a code lookup; all four came back
		// inside the wrapper with the room id in it.
		{"X1 a request link without its scheme", "floe.one/r/Xk3p9Q0aB1c#" + room, code.ErrRequestLink},
		{"X2 a link id one character short", "https://floe.one/r/Xk3p9Q0aB1#" + room, code.ErrRequestLink},
		{"X3 a request link in angle brackets", "<https://floe.one/r/Xk3p9Q0aB1c#" + room + ">", code.ErrRequestLink},
		{"X4 an extra path segment", "https://floe.one/r/Xk3p9Q0aB1c/x#" + room, code.ErrRequestLink},
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
// refusal is an outcome, not a usage mistake. execute prints it once and
// still returns the sentinel, which main turns into exit 1.
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
// real command tree with execute, the way main does, and returns what the
// terminal would show: stdout (runReceive writes its blank line with fmt,
// straight to os.Stdout) and stderr (the error writer cobra and execute print
// to), with the error main turns into exit 1. Cobra keeps flag state, writers
// and arguments on the package-level tree between Execute calls, so all three
// are put back after.
func receiveThroughCobra(t *testing.T, input, server string) (stdout, stderr string, err error) {
	t.Helper()
	resetSharedFlags(t)
	t.Cleanup(func() {
		if f := rootCmd.PersistentFlags().Lookup("server"); f != nil {
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		}
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	var out, errOut strings.Builder
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	stdout = captureStdout(t, func() { err = execute([]string{"receive", input, "--server", server}) })
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

// lineFloeLinkOtherServer is the line receive ends on for a floe.one room
// link with another server chosen (FU-53, FU-46 review 1 L5). New copy,
// pending the owner's approval.
const lineFloeLinkOtherServer = "That link is for floe.one, but this Floe is set to use another server. Unset FLOE_SERVER or use --server https://api.floe.one, then try again."

// TestReceiveFloeLinkWithAnotherServerEndsWithoutANetworkCall (FU-53, FU-46
// review 1 L5): a room link made on floe.one has its room on api.floe.one
// alone. With FLOE_SERVER or --server naming any other server, receive used
// to send that room's id to it in join-room, and whoever runs it could take
// the receiver's seat and the files. It now ends on one fixed line before
// any network call (no ICE fetch, no signaling connect, no request of any
// kind to the server) and never prints the link. The F5-4 host rule of the
// request-link send decides (isFloeOneServer): api.floe.one in any spelling
// that reaches it goes through, and so do a link on another host (the
// self-hosted case) and a code.
func TestReceiveFloeLinkWithAnotherServerEndsWithoutANetworkCall(t *testing.T) {
	var hits atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(other.Close)

	room := uuid.New().String()
	links := map[string]string{
		"fragment":              "https://floe.one/#room=" + room,
		"query":                 "https://floe.one/?room=" + room,
		"www":                   "https://www.floe.one/#room=" + room,
		"www, query":            "https://www.floe.one/?room=" + room,
		"no scheme":             "floe.one/#room=" + room,
		"angle brackets":        "<https://floe.one/#room=" + room + ">",
		"quotes":                `"https://www.floe.one/?room=` + room + `"`,
		"capitals, port, a dot": "https://FLOE.ONE.:443/#room=" + room,
		"http":                  "http://floe.one/#room=" + room,
		// N1: hosts a browser maps to floe.one (IDNA), as it reads them.
		"fullwidth":                   "https://ｆｌｏｅ.one/#room=" + room,
		"www, ideographic full stops": "https://www。ｆｌｏｅ。one/?room=" + room,
		"circled letters":             "https://ⓕⓛⓞⓔ.one/#room=" + room,
	}
	servers := []struct {
		name string
		env  map[string]string
		args []string
	}{
		{"--server another", nil, []string{"--server", other.URL}},
		{"FLOE_SERVER another", map[string]string{"FLOE_SERVER": other.URL}, nil},
		{"FLOE_SERVER http api.floe.one", map[string]string{"FLOE_SERVER": "http://api.floe.one"}, nil},
		{"--server api.floe.one on another port", nil, []string{"--server", "https://api.floe.one:8443"}},
	}
	for _, s := range servers {
		for name, link := range links {
			t.Run(s.name+", "+name, func(t *testing.T) {
				hits.Store(0)
				calls := stubNetwork(t, "")
				stdout, stderr, err := receiveWith(t, s.env, append([]string{link}, s.args...)...)
				if n, c, h := calls.ice.Load(), calls.connect.Load(), hits.Load(); n != 0 || c != 0 || h != 0 {
					t.Fatalf("network calls made: ICE %d, connect %d, requests to the server %d; want none\nstderr:\n%s", n, c, h, stderr)
				}
				var outcome outcomeError
				if !errors.As(err, &outcome) {
					t.Fatalf("execute returned %v, want an outcome (main exits 1 on it)", err)
				}
				if stdout != "\n" || stderr != "  "+lineFloeLinkOtherServer+"\n" {
					t.Fatalf("want the blank line and %q\nstdout:\n%q\nstderr:\n%q", lineFloeLinkOtherServer, stdout, stderr)
				}
				if strings.Contains(strings.ToLower(stdout+stderr), room[1:]) {
					t.Fatalf("the room id was printed:\n%s", stderr)
				}
			})
		}
	}

	// Through to the network (the stub refuses every call and counts it, so
	// nothing leaves the test): the link with api.floe.one, chosen or not, a
	// self-hosted room link with its own server, and a code.
	for _, c := range []struct {
		name  string
		env   map[string]string
		args  []string
		ice   int32
		hits  int32
		cause string
	}{
		{"no server chosen", nil, []string{"https://floe.one/#room=" + room}, 1, 0, "failed to fetch ICE credentials: test: no ICE fetch from https://api.floe.one"},
		{"no server chosen, fullwidth", nil, []string{"https://ｆｌｏｅ.one/#room=" + room}, 1, 0, "failed to fetch ICE credentials: test: no ICE fetch from https://api.floe.one"},
		{"FLOE_SERVER names api.floe.one", map[string]string{"FLOE_SERVER": "https://API.floe.one.:443/"}, []string{"https://www.floe.one/?room=" + room}, 1, 0, "failed to fetch ICE credentials: test: no ICE fetch from https://API.floe.one.:443"},
		{"--server names api.floe.one", nil, []string{"floe.one/#room=" + room, "--server", "https://api.floe.one"}, 1, 0, "failed to fetch ICE credentials: test: no ICE fetch from https://api.floe.one"},
		{"a self-hosted link with its server", nil, []string{"https://files.example.com/#room=" + room, "--server", other.URL}, 1, 0, "failed to fetch ICE credentials: test: no ICE fetch from " + other.URL},
		{"a code with another server", nil, []string{"olive-tiger-castle", "--server", other.URL}, 0, 1, `could not resolve "olive-tiger-castle": code "olive-tiger-castle" not found or expired (codes expire after 10 minutes)`},
	} {
		t.Run("goes through: "+c.name, func(t *testing.T) {
			hits.Store(0)
			calls := stubNetwork(t, "")
			_, stderr, err := receiveWith(t, c.env, c.args...)
			if err == nil {
				t.Fatal("receive succeeded against a refused network")
			}
			if n, h := calls.ice.Load(), hits.Load(); n != c.ice || h != c.hits || calls.connect.Load() != 0 {
				t.Fatalf("ICE fetches %d, requests to the server %d, connects %d; want %d, %d and 0\nstderr:\n%s", n, h, calls.connect.Load(), c.ice, c.hits, stderr)
			}
			if want := "Error: " + c.cause + "\n"; stderr != want {
				t.Fatalf("stderr is %q, want %q", stderr, want)
			}
		})
	}
}

// receiveWith runs `floe receive args...` through execute, as main runs it,
// with env set as the user's shell would hold it, and returns what reached
// stdout and the error writer, with the error main turns into exit 1. The
// shared and receive flags go back to their defaults afterwards.
func receiveWith(t *testing.T, env map[string]string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	resetSharedFlags(t)
	t.Setenv("FLOE_NO_STATS", "1")
	for k, v := range env {
		t.Setenv(k, v)
	}
	t.Cleanup(func() {
		if f := rootCmd.PersistentFlags().Lookup("server"); f != nil {
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		}
		for _, name := range []string{"output", "no-report"} {
			if f := receiveCmd.Flags().Lookup(name); f != nil {
				_ = f.Value.Set(f.DefValue)
				f.Changed = false
			}
		}
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	var out, errOut strings.Builder
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	argv := append([]string{"receive"}, args...)
	argv = append(argv, "--no-report", "--output", t.TempDir())
	stdout = captureStdout(t, func() { err = execute(argv) })
	return stdout + out.String(), errOut.String(), err
}
