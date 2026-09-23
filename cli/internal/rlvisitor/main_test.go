package main

// The flag parser: the room comes from -link or -room, the server is never
// FLOE_SERVER, one hostile behavior at a time, and every switch a cell needs
// parses.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// A send's outcome is one fixed word per kind, with its own exit code: the
// host's refusal as its parsed code and the engine's fixed sentence for it,
// the visitor's own relay gate as that gate's sentence, and anything else as
// "failed" with no error text, so CELL-04, 05 and 13 can tell expired,
// save-blocked and relay-cap from a transport failure.
func TestSendOutcomeWords(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		outcome  string
		code     string
		sentence string
		exit     int
	}{
		{"delivered", nil, "delivered", "", "", exitDelivered},
		{"expired", &transfer.PeerStoppedError{Code: transfer.CodeExpired}, "peer-refused", "expired", "They did not answer in time. Nothing was sent.", exitPeerRefused},
		{"save-blocked wrapped", fmt.Errorf("x: %w", &transfer.PeerStoppedError{Code: transfer.CodeSaveBlocked}), "peer-refused", "save-blocked", "A file arrived but their computer blocked saving it.", exitPeerRefused},
		{"host relay-cap", &transfer.PeerStoppedError{Code: transfer.CodeRelayCap}, "peer-refused", "relay-cap", "Relayed drops are capped at 2 GB.", exitPeerRefused},
		{"hand-built unknown code", &transfer.PeerStoppedError{Code: "secret-code"}, "peer-refused", "other", "The drop stopped on their computer.", exitPeerRefused},
		{"own relay gate", fmt.Errorf("transfer blocked: %w (selected 2.0 GB)", transfer.ErrRelayOverLimit), "relay-gate", "", "transfer blocked: relay connections are capped at 2 GB (selected 2.0 GB)", exitRelayGate},
		{"transport", errors.New("secret text C:/Users/x/file.bin"), "failed", "", "", exitFailed},
	}
	for _, c := range cases {
		ev, exit := sendOutcome(c.err)
		if ev["event"] != "send-ended" || ev["outcome"] != c.outcome || exit != c.exit {
			t.Errorf("%s: event %v exit %d, want outcome %q exit %d", c.name, ev, exit, c.outcome, c.exit)
		}
		if got, _ := ev["code"].(string); got != c.code {
			t.Errorf("%s: code %q, want %q", c.name, got, c.code)
		}
		if got, _ := ev["sentence"].(string); got != c.sentence {
			t.Errorf("%s: sentence %q, want %q", c.name, got, c.sentence)
		}
		line, _ := json.Marshal(ev)
		if strings.Contains(string(line), "secret") {
			t.Errorf("%s: the event carries error text: %s", c.name, line)
		}
	}
}

// The crafted modes end on the host's refusal (its code, allowlisted), the
// host closing without one, or the bound; a refusal already queued when the
// channel closes still counts as the refusal.
func TestHostEndReadsTheRefusalCode(t *testing.T) {
	msg := func(s string) webrtc.DataChannelMessage { return webrtc.DataChannelMessage{Data: []byte(s)} }
	cases := []struct {
		name   string
		frames []string
		close  bool
		ended  string
		code   string
	}{
		{"known code", []string{`{"type":"incompatible","code":"path-too-long","reason":"x"}`}, false, "host-refused", "path-too-long"},
		{"unknown code", []string{`{"type":"incompatible","code":"secret","reason":"secret"}`}, false, "host-refused", "other"},
		{"no code", []string{`{"type":"incompatible","reason":"secret","pv":1,"pvMin":1}`}, false, "host-refused", "other"},
		{"code by exact key only", []string{`{"type":"incompatible","CODE":"expired"}`}, false, "host-refused", "other"},
		{"type by exact key only", []string{`{"TYPE":"incompatible","code":"expired"}`}, false, "bound", ""},
		{"an ack is not an end", []string{`{"type":"ack","id":"x"}`}, false, "bound", ""},
		{"oversize frame ignored", []string{`{"type":"incompatible","code":"expired","pad":"` + strings.Repeat("x", 5000) + `"}`}, false, "bound", ""},
		{"closed", nil, true, "host-closed", ""},
		{"closed with a refusal queued", []string{`{"type":"incompatible","code":"over-approved"}`}, true, "host-refused", "over-approved"},
		{"bound", nil, false, "bound", ""},
	}
	for _, c := range cases {
		msgs := make(chan webrtc.DataChannelMessage, len(c.frames)+1)
		for _, f := range c.frames {
			msgs <- msg(f)
		}
		closed := make(chan struct{})
		if c.close {
			close(closed)
		}
		ended, code := hostEnd(msgs, closed, 50*time.Millisecond)
		if ended != c.ended || code != c.code {
			t.Errorf("%s: hostEnd = %q %q, want %q %q", c.name, ended, code, c.ended, c.code)
		}
	}
}

// The usage text documents every exit code by number and word.
func TestUsageTextNamesEveryExitCode(t *testing.T) {
	for code, word := range map[int]string{
		exitDelivered:   "delivered",
		exitFailed:      "failed",
		exitUsage:       "usage",
		exitPeerRefused: "peer-refused",
		exitRelayGate:   "relay-gate",
		exitHostClosed:  "host-closed",
		exitBound:       "bound",
	} {
		if want := fmt.Sprintf("  %d  %s", code, word); !strings.Contains(usageText, want) {
			t.Errorf("usage text lacks %q", want)
		}
	}
	if len(map[int]bool{exitDelivered: true, exitFailed: true, exitUsage: true, exitPeerRefused: true, exitRelayGate: true, exitHostClosed: true, exitBound: true}) != 7 {
		t.Error("two outcomes share an exit code")
	}
}

func TestParseFlagsRoomAndServer(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	// The room comes from -link's fragment; the link's own host is not the
	// signaling server (that stays the default or -server).
	cfg, err := parseFlags([]string{"-link", "https://floe.one/r/Xk3p9Q0aB1c#" + room, "-send", "a.bin"})
	if err != nil || cfg.room != room {
		t.Fatalf("link parse: room %q err %v", cfg.room, err)
	}
	if cfg.server != defaultServer {
		t.Fatalf("server %q, want the local default", cfg.server)
	}
	// -room and -server directly.
	cfg, err = parseFlags([]string{"-room", room, "-server", "http://localhost:3001", "-send", "a.bin"})
	if err != nil || cfg.room != room || cfg.server != "http://localhost:3001" {
		t.Fatalf("room/server parse: %+v err %v", cfg, err)
	}
}

func TestParseFlagsNeverReadsFloeServer(t *testing.T) {
	t.Setenv("FLOE_SERVER", "https://api.floe.one")
	cfg, err := parseFlags([]string{"-room", "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f", "-send", "a.bin"})
	if err != nil || cfg.server != defaultServer {
		t.Fatalf("server = %q, want the local default whatever FLOE_SERVER says (err %v)", cfg.server, err)
	}
}

func TestParseFlagsRefuseBadInput(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	for name, args := range map[string][]string{
		"no room and no link":    {"-send", "a.bin"},
		"nothing to do":          {"-room", room},
		"positional":             {"-room", room, "-send", "a.bin", "extra"},
		"unknown flag":           {"-room", room, "-send", "a.bin", "-nope"},
		"unknown hostile-meta":   {"-room", room, "-hostile-meta", "f9"},
		"bad link":               {"-link", "https://floe.one/r/short"},
		"link with room= form":   {"-link", "https://floe.one/r/Xk3p9Q0aB1c#room=" + room},
		"zero timeout":           {"-room", room, "-send", "a.bin", "-timeout", "0s"},
		"two hostile at once":    {"-room", room, "-junk-flood", "-bad-sdp"},
		"hostile-name plus meta": {"-room", room, "-hostile-name", "-hostile-meta", "f2"},
	} {
		if _, err := parseFlags(args); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// -server takes only localhost, a loopback address or a private address
// (RFC 1918 or an IPv6 ULA), so a typo can never aim the stub at production
// or any public host; the WSL host address (FI-07) is private and stays
// allowed.
func TestParseFlagsRefusesNonLocalServer(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	for _, srv := range []string{
		"https://api.floe.one",
		"http://floe.one",
		"http://8.8.8.8:3001",
		"http://example.com:3001",
		"http://[2001:4860:4860::8888]:3001",
		"http://0.0.0.0:3001",
		"ftp://127.0.0.1:3001",
		"127.0.0.1:3001",
		"http://127.0.0.1:3001/api",
		"http://127.0.0.1:3001?x=1",
		"",
	} {
		if _, err := parseFlags([]string{"-room", room, "-server", srv, "-send", "a.bin"}); err == nil {
			t.Errorf("-server %q: accepted, want a usage refusal", srv)
		}
	}
	for srv, want := range map[string]string{
		"http://127.0.0.1:3001":      "http://127.0.0.1:3001",
		"http://localhost:3001":      "http://localhost:3001",
		"http://172.29.64.1:3301":    "http://172.29.64.1:3301",
		"http://192.168.1.20:3001":   "http://192.168.1.20:3001",
		"http://10.0.0.5:3001/":      "http://10.0.0.5:3001",
		"http://[::1]:3001":          "http://[::1]:3001",
		"http://[fd12:3456::1]:3001": "http://[fd12:3456::1]:3001",
		"https://127.0.0.1:3443":     "https://127.0.0.1:3443",
	} {
		cfg, err := parseFlags([]string{"-room", room, "-server", srv, "-send", "a.bin"})
		if err != nil {
			t.Errorf("-server %q: refused (%v), want accepted", srv, err)
			continue
		}
		if cfg.server != want {
			t.Errorf("-server %q: server = %q, want %q", srv, cfg.server, want)
		}
	}
}

func TestModeFromFlags(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cases := map[mode][]string{
		modeSend:        {"-room", room, "-send", "a.bin"},
		modeHostileMeta: {"-room", room, "-hostile-meta", "f4b"},
		modeHostileName: {"-room", room, "-hostile-name"},
		modeAbort:       {"-room", room, "-abort-reason", "x"},
		modeJunkFlood:   {"-room", room, "-junk-flood"},
		modeBadSDP:      {"-room", room, "-bad-sdp"},
		modeSkipGate:    {"-room", room, "-skip-relay-gate"},
	}
	for want, args := range cases {
		cfg, err := parseFlags(args)
		if err != nil {
			t.Fatalf("%v: parse err %v", want, err)
		}
		got, err := cfg.mode()
		if err != nil || got != want {
			t.Errorf("mode for %v = %v, err %v", args, got, err)
		}
	}
}

func TestRelayOnlyAndSkipGateParse(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cfg, err := parseFlags([]string{"-room", room, "-relay-only", "-send", "a.bin,b.bin"})
	if err != nil || !cfg.relayOnly || len(cfg.send) != 2 {
		t.Fatalf("relay-only send: %+v err %v", cfg, err)
	}
	cfg, err = parseFlags([]string{"-room", room, "-skip-relay-gate", "-timeout", "90s"})
	if err != nil || !cfg.skipGate || cfg.timeout != 90*time.Second {
		t.Fatalf("skip-relay-gate: %+v err %v", cfg, err)
	}
}
