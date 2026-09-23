package main

// The flag parser: the room comes from -link or -room, the server is never
// FLOE_SERVER, one hostile behavior at a time, and every switch a cell needs
// parses.

import (
	"testing"
	"time"
)

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
