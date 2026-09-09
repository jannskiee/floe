package ice

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

// TestTrimICEServers verifies the defense-in-depth ICE list trim: one URL per
// connectivity class, entry structure and credentials preserved.
func TestTrimICEServers(t *testing.T) {
	t.Run("cloudflare 8-URL shape reduces to 3 URLs across 2 entries", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{
				"stun:stun.cloudflare.com:3478",
				"stun:stun.cloudflare.com:53",
			}},
			{
				URLs: []string{
					"turn:turn.cloudflare.com:3478?transport=udp",
					"turn:turn.cloudflare.com:3478?transport=tcp",
					"turns:turn.cloudflare.com:5349?transport=tcp",
					"turn:turn.cloudflare.com:53?transport=udp",
					"turn:turn.cloudflare.com:80?transport=tcp",
					"turns:turn.cloudflare.com:443?transport=tcp",
				},
				Username:   "user",
				Credential: "pass",
			},
		}
		got := trimICEServers(in)
		want := []webrtc.ICEServer{
			{URLs: []string{"stun:stun.cloudflare.com:3478"}},
			{
				URLs: []string{
					"turn:turn.cloudflare.com:3478?transport=udp",
					"turns:turn.cloudflare.com:443?transport=tcp",
				},
				Username:   "user",
				Credential: "pass",
			},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("coturn 3-entry shape passes through unchanged", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{"stun:turn.example.com:3478"}},
			{URLs: []string{"turn:turn.example.com:3478"}, Username: "u", Credential: "c"},
			{URLs: []string{"turns:turn.example.com:5349"}, Username: "u", Credential: "c"},
		}
		got := trimICEServers(in)
		if !reflect.DeepEqual(got, in) {
			t.Fatalf("coturn list must pass through unchanged, got %+v", got)
		}
	})

	t.Run("multiple STUN-only entries collapse to one", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		}
		got := trimICEServers(in)
		if len(got) != 1 || len(got[0].URLs) != 1 {
			t.Fatalf("expected a single STUN URL, got %+v", got)
		}
	})

	t.Run("falls back to turn tcp when no turns URL exists", func(t *testing.T) {
		in := []webrtc.ICEServer{
			{URLs: []string{
				"turn:host:3478?transport=udp",
				"turn:host:80?transport=tcp",
			}, Username: "u", Credential: "c"},
		}
		got := trimICEServers(in)
		want := []webrtc.ICEServer{
			{URLs: []string{
				"turn:host:3478?transport=udp",
				"turn:host:80?transport=tcp",
			}, Username: "u", Credential: "c"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("returns input unchanged when nothing is classifiable", func(t *testing.T) {
		in := []webrtc.ICEServer{{URLs: []string{"wss:not-an-ice-url"}}}
		got := trimICEServers(in)
		if !reflect.DeepEqual(got, in) {
			t.Fatalf("unclassifiable list must be left alone, got %+v", got)
		}
	})
}

// TestParseServersReadsBothURLShapes is the characterization test for the
// decoder lifted out of Fetch. "urls" is a plain string for coturn and for the
// STUN-only fallback but an array for Cloudflare, and the desktop's server
// probe now reads the list through this same function rather than growing a
// second implementation of that rule.
func TestParseServersReadsBothURLShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []webrtc.ICEServer
	}{
		{
			"coturn sends urls as a string",
			`[{"urls":"stun:turn.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"c"}]`,
			[]webrtc.ICEServer{
				{URLs: []string{"stun:turn.example.com:3478"}},
				{URLs: []string{"turn:turn.example.com:3478"}, Username: "u", Credential: "c", CredentialType: webrtc.ICECredentialTypePassword},
			},
		},
		{
			"cloudflare sends urls as an array",
			`[{"urls":["stun:stun.cloudflare.com:3478"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"u","credential":"c"}]`,
			[]webrtc.ICEServer{
				{URLs: []string{"stun:stun.cloudflare.com:3478"}},
				{URLs: []string{"turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"}, Username: "u", Credential: "c", CredentialType: webrtc.ICECredentialTypePassword},
			},
		},
		{
			"the two shapes mixed in one list",
			`[{"urls":"stun:a:3478"},{"urls":["turn:b:3478"]}]`,
			[]webrtc.ICEServer{
				{URLs: []string{"stun:a:3478"}},
				{URLs: []string{"turn:b:3478"}},
			},
		},
		{
			// An entry with nothing to connect with is dropped rather than
			// counted. The probe's old length check on []map[string]any
			// accepted this as "usable connection details".
			"an entry with no urls is dropped",
			`[{},{"urls":"stun:a:3478"}]`,
			[]webrtc.ICEServer{{URLs: []string{"stun:a:3478"}}},
		},
		{
			"a list of empty entries parses to nothing",
			`[{},{}]`,
			nil,
		},
		{
			"an empty list parses to nothing",
			`[]`,
			nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseServers(strings.NewReader(tc.body))
			if err != nil {
				t.Fatalf("ParseServers: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ParseServers() = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// TestParseServersRejectsJunk: a body that is not a JSON array is an error, not
// an empty list. Fetch turns both into the STUN-only fallback, but the probe
// tells them apart in its message.
func TestParseServersRejectsJunk(t *testing.T) {
	if _, err := ParseServers(strings.NewReader(`<html>not json</html>`)); err == nil {
		t.Fatal("ParseServers accepted a non-JSON body")
	}
}

// TestHasRelay pins the question both relay-only surfaces ask before they
// start: is there anything here to relay through?
func TestHasRelay(t *testing.T) {
	cases := []struct {
		name    string
		servers []webrtc.ICEServer
		want    bool
	}{
		{"stun only", []webrtc.ICEServer{{URLs: []string{"stun:a:3478"}}}, false},
		{"turn over udp", []webrtc.ICEServer{{URLs: []string{"turn:a:3478"}}}, true},
		{"turn over tcp", []webrtc.ICEServer{{URLs: []string{"turn:a:80?transport=tcp"}}}, true},
		{"turns over tls", []webrtc.ICEServer{{URLs: []string{"turns:a:443?transport=tcp"}}}, true},
		{
			"one entry carrying both",
			[]webrtc.ICEServer{{URLs: []string{"stun:a:3478", "turn:a:3478"}}},
			true,
		},
		{
			"a relay in a later entry still counts",
			[]webrtc.ICEServer{{URLs: []string{"stun:a:3478"}}, {URLs: []string{"turns:b:443"}}},
			true,
		},
		{"a url of no known class", []webrtc.ICEServer{{URLs: []string{"http://not-ice"}}}, false},
		{"nothing at all", nil, false},
		{"an entry with no urls", []webrtc.ICEServer{{}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := HasRelay(tc.servers); got != tc.want {
				t.Errorf("HasRelay() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestDefaultsHaveNoRelay pins the fact the whole missing-relay problem turns
// on. Fetch degrades to these on any non-200, including the TURN endpoint's own
// rate limiter, so a relay-only transfer against a perfectly good server can
// still be handed a list with nowhere to relay through.
func TestDefaultsHaveNoRelay(t *testing.T) {
	if HasRelay(defaults()) {
		t.Fatal("the STUN-only fallback claims to offer a relay")
	}
}

// TestIceURLClass pins the classification rules, including the RFC 7065
// default (turn without a transport param is UDP).
func TestIceURLClass(t *testing.T) {
	cases := map[string]string{
		"stun:host:3478":               "stun",
		"turn:host:3478":               "udp",
		"turn:host:3478?transport=udp": "udp",
		"turn:host:80?transport=tcp":   "tcp",
		"turns:host:443?transport=tcp": "tls",
		"turns:host:5349":              "tls",
		"http://not-ice":               "",
	}
	for u, want := range cases {
		if got := iceURLClass(u); got != want {
			t.Errorf("iceURLClass(%q) = %q, want %q", u, got, want)
		}
	}
}

// Fetch must never return an error: both callers in cmd/floe treat one as
// fatal, and a 429 from the server's TURN limiter is a documented degrade that
// still completes over direct STUN. It must, however, say something. The
// silent version of this fallback is what serverurl.go's own comment blames
// for "a relayed transfer dies with no message".
func TestFetchFallsBackWithoutErroringOnHTTPError(t *testing.T) {
	for _, status := range []int{429, 500, 404} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"nope"}`))
		}))

		servers, err := Fetch(srv.URL)
		srv.Close()

		if err != nil {
			t.Fatalf("status %d: Fetch returned an error (%v); both callers abort the transfer on one", status, err)
		}
		if len(servers) == 0 {
			t.Fatalf("status %d: Fetch returned no ICE servers; the STUN fallback is what keeps a direct transfer working", status)
		}
	}
}

// A server that accepts the connection and never answers must not hang the
// command forever. The budget is 30s, so this only proves the client is bounded
// at all, not the exact number.
func TestFetchClientHasATimeout(t *testing.T) {
	if client.Timeout <= 0 {
		t.Fatal("ice.Fetch runs on a client with no timeout; a black-holing server hangs `floe send` at step 2 indefinitely")
	}
}

// TestFetchDetailReportsTheFallback pins the distinction the relay guards need.
// Fetch collapses four outcomes into the same STUN-only list and a nil error,
// with only a stdout line telling them apart, and a GUI never shows stdout. A
// caller that refuses to start because there is no relay has to know whether
// that was the server's answer or its own fallback, or it blames a
// configuration nobody has looked at.
func TestFetchDetailReportsTheFallback(t *testing.T) {
	cases := []struct {
		name         string
		handler      http.HandlerFunc
		wantDegraded bool
		wantRelay    bool
	}{
		{
			"a relay-less server is an answer, not a degrade",
			func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`[{"urls":"stun:stun.l.google.com:19302"}]`))
			},
			false, false,
		},
		{
			"a TURN-bearing server is neither",
			func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`[{"urls":"turn:a:3478","username":"u","credential":"c"}]`))
			},
			false, true,
		},
		{
			// The endpoint's own limiter is 20 requests per IP per minute.
			"a 429 degrades",
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTooManyRequests) },
			true, false,
		},
		{
			// A reverse proxy that forwards /health and /ws but not /api/.
			"a 404 degrades",
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) },
			true, false,
		},
		{
			"a body that is not a list degrades",
			func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`<html>nope</html>`)) },
			true, false,
		},
		{
			"a list with nothing usable in it degrades",
			func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`[{}]`)) },
			true, false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()

			servers, degraded, err := FetchDetail(srv.URL)
			if err != nil {
				t.Fatalf("FetchDetail returned an error: %v", err)
			}
			if degraded != tc.wantDegraded {
				t.Errorf("degraded = %v, want %v", degraded, tc.wantDegraded)
			}
			if got := HasRelay(servers); got != tc.wantRelay {
				t.Errorf("HasRelay = %v, want %v", got, tc.wantRelay)
			}
		})
	}
}

// TestFetchDetailDegradesWhenUnreachable covers the transport failure, which
// needs no server at all.
func TestFetchDetailDegradesWhenUnreachable(t *testing.T) {
	servers, degraded, err := FetchDetail("http://127.0.0.1:9")
	if err != nil {
		t.Fatalf("FetchDetail returned an error: %v", err)
	}
	if !degraded {
		t.Error("an unreachable server did not report degraded")
	}
	if HasRelay(servers) {
		t.Error("the fallback claims to offer a relay")
	}
}

// TestIceURLClassIgnoresSchemeCase: a URI scheme is case-insensitive (RFC 3986)
// and pion lowercases it before parsing, so "TURN:" gathers relay candidates.
// Classifying it case-sensitively made HasRelay disagree with the ICE agent,
// which would refuse a relay-only transfer that could actually have connected.
func TestIceURLClassIgnoresSchemeCase(t *testing.T) {
	cases := map[string]string{
		"STUN:host:3478":               "stun",
		"TURN:host:3478":               "udp",
		"Turn:host:3478":               "udp",
		"TURNS:host:5349":              "tls",
		"TURN:host:80?TRANSPORT=TCP":   "tcp",
		"turn:host:3478?transport=udp": "udp",
	}
	for u, want := range cases {
		if got := iceURLClass(u); got != want {
			t.Errorf("iceURLClass(%q) = %q, want %q", u, got, want)
		}
	}
	if !HasRelay([]webrtc.ICEServer{{URLs: []string{"TURN:host:3478"}}}) {
		t.Error("HasRelay missed an uppercase TURN url that pion would use")
	}
}
