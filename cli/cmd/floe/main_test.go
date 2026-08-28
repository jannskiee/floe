package main

import (
	"errors"
	"io"
	"strings"
	"testing"
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
