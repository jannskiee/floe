package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// okWS stands in for a signaling dial that succeeds, so a test can isolate the
// HTTP stages.
func okWS(string) error { return nil }

// The ICE bodies /api/turn-credentials returns. Both shapes of "urls" are here
// on purpose: coturn and the STUN-only fallback send a string, Cloudflare sends
// an array, and the relay check has to read both.
const (
	iceWithTURN = `[{"urls":"stun:turn.example.com:3478"},` +
		`{"urls":"turn:turn.example.com:3478","username":"u","credential":"c"}]`
	iceSTUNOnly     = `[{"urls":"stun:stun.l.google.com:19302"}]`
	iceSTUNOnlyList = `[{"urls":["stun:stun.l.google.com:19302"]}]`
	iceCloudflare   = `[{"urls":["stun:stun.cloudflare.com:3478"]},` +
		`{"urls":["turn:turn.cloudflare.com:3478?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"u","credential":"c"}]`
	iceNoURLs = `[{}]`
)

// floeServer serves the endpoints a healthy signaling server exposes. Individual
// tests drop one to simulate a reverse proxy that forgot to forward it.
//
// The default ICE body offers a relay. It used to be STUN-only, which made the
// shared happy path assert OK against exactly the server issue #281 is about,
// so the gap could not be seen from here. Tests that want that server ask for
// it by name through floeServerICE.
func floeServer(withHealth, withAPI bool) *httptest.Server {
	return floeServerICE(withHealth, withAPI, iceWithTURN)
}

func floeServerICE(withHealth, withAPI bool, iceBody string) *httptest.Server {
	mux := http.NewServeMux()
	if withHealth {
		mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"healthy","uptime":42.0}`))
		})
	}
	if withAPI {
		mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(iceBody))
		})
	}
	return httptest.NewServer(mux)
}

// TestProbeServerAcceptsAHealthyServer is the happy path: all three stages pass.
func TestProbeServerAcceptsAHealthyServer(t *testing.T) {
	srv := floeServer(true, true)
	defer srv.Close()

	if got := probeServer(srv.URL, okWS); !got.OK {
		t.Fatalf("probeServer = %+v, want OK", got)
	}
}

// TestProbeServerNormalizesInput proves the trim reaches every stage, not just
// the first. An untrimmed base would request //health, which does not route.
func TestProbeServerNormalizesInput(t *testing.T) {
	srv := floeServer(true, true)
	defer srv.Close()

	for _, in := range []string{srv.URL + "/", srv.URL + "//", "  " + srv.URL + "  "} {
		if got := probeServer(in, okWS); !got.OK {
			t.Errorf("probeServer(%q) = %+v, want OK", in, got)
		}
	}
}

// TestProbeServerCatchesMissingAPI is the case that justifies the third stage.
// A proxy forwarding /health and /ws but dropping /api/ passes a two-stage probe,
// and the resulting breakage is silent: ice.Fetch falls back to public STUN and a
// failed code registration is discarded, so the user sees a link with no code.
func TestProbeServerCatchesMissingAPI(t *testing.T) {
	srv := floeServer(true, false) // /ws is stubbed as working by okWS
	defer srv.Close()

	got := probeServer(srv.URL, okWS)
	if got.OK {
		t.Fatal("probeServer accepted a server whose /api/ is not reachable")
	}
	if !strings.Contains(got.Message, "/api/") {
		t.Errorf("message = %q, want it to name /api/", got.Message)
	}
}

// TestProbeServerCatchesMissingWebSocket covers the other proxy misconfiguration.
func TestProbeServerCatchesMissingWebSocket(t *testing.T) {
	srv := floeServer(true, true)
	defer srv.Close()

	got := probeServer(srv.URL, func(string) error { return errors.New("upgrade refused") })
	if got.OK {
		t.Fatal("probeServer accepted a server whose /ws is not reachable")
	}
	if !strings.Contains(got.Message, "/ws") {
		t.Errorf("message = %q, want it to name /ws", got.Message)
	}
}

// TestProbeServerRejectsNonFloeEndpoints separates "nothing is there" from
// "something is there but it is not Floe", because the fixes differ.
func TestProbeServerRejectsNonFloeEndpoints(t *testing.T) {
	// 200 with a body that is not the health payload: a different service.
	notFloe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>hello</html>"))
	}))
	defer notFloe.Close()
	if got := probeServer(notFloe.URL, okWS); got.OK || !strings.Contains(got.Message, "not a Floe") {
		t.Errorf("non-Floe 200: got %+v, want a not-a-Floe-server message", got)
	}

	// 404 everywhere: most often the web app pasted instead of the server.
	empty := floeServer(false, false)
	defer empty.Close()
	if got := probeServer(empty.URL, okWS); got.OK || !strings.Contains(got.Message, "web app") {
		t.Errorf("404 health: got %+v, want the web-app hint", got)
	}
}

// TestProbeServerRejectsUnreachableHosts covers the transport failures, each with
// its own message so the user knows whether to fix the address or the server.
func TestProbeServerRejectsUnreachableHosts(t *testing.T) {
	for _, tc := range []struct{ name, addr, want string }{
		{"unresolvable host", "https://floe-probe-test.invalid", "could not be found"},
		{"connection refused", "http://127.0.0.1:59999", "Could not connect"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := probeServer(tc.addr, okWS)
			if got.OK {
				t.Fatalf("probeServer(%q) = %+v, want failure", tc.addr, got)
			}
			if !strings.Contains(got.Message, tc.want) {
				t.Errorf("message = %q, want it to contain %q", got.Message, tc.want)
			}
		})
	}
}

// TestProbeServerRejectsMalformedInput fails before any network call, so a typo
// gets an instant answer instead of a six-second wait.
func TestProbeServerRejectsMalformedInput(t *testing.T) {
	failWS := func(string) error { return errors.New("should not dial") }
	for _, tc := range []struct{ name, addr, want string }{
		{"empty", "", "Enter a server address"},
		{"only slashes", "///", "Enter a server address"},
		{"no scheme", "floe.example.com", "does not look like an address"},
		{"wrong scheme", "ftp://floe.example.com", "must start with"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := probeServer(tc.addr, failWS)
			if got.OK {
				t.Fatalf("probeServer(%q) = %+v, want failure", tc.addr, got)
			}
			if !strings.Contains(got.Message, tc.want) {
				t.Errorf("message = %q, want it to contain %q", got.Message, tc.want)
			}
		})
	}
}

// TestProbeServerAgainstLiveServer runs the real probe, including the real
// signaling dial, against an actual server. Opt-in because it needs one running:
//
//	FLOE_TEST_SERVER=http://localhost:3001 go test ./... -run LiveServer
//
// The other probe tests stub the WebSocket stage, so this is the only place
// dialSignaling itself is exercised. It doubles as the check a self-hoster can
// run against their own deployment.
func TestProbeServerAgainstLiveServer(t *testing.T) {
	base := os.Getenv("FLOE_TEST_SERVER")
	if base == "" {
		t.Skip("set FLOE_TEST_SERVER to a running signaling server to run this")
	}

	if got := probeServer(base, dialSignaling); !got.OK {
		t.Fatalf("probeServer(%q) = %+v, want OK", base, got)
	}
	// A trailing slash must survive all three stages, not just the first: an
	// untrimmed base requests //health, //ws and //api/, none of which route.
	if got := probeServer(base+"/", dialSignaling); !got.OK {
		t.Errorf("probeServer(%q) = %+v, want OK", base+"/", got)
	}
}

// TestProbeServerReportsAnAvailableRelay: the happy path now also answers the
// question Hide my IP depends on.
func TestProbeServerReportsAnAvailableRelay(t *testing.T) {
	srv := floeServer(true, true)
	defer srv.Close()

	got := probeServer(srv.URL, okWS)
	if !got.OK || !got.RelayAvailable {
		t.Fatalf("probeServer = %+v, want OK with a relay", got)
	}
	if got.Message != "Connected." {
		t.Errorf("Message = %q, want the unchanged pass message", got.Message)
	}
}

// TestProbeServerReportsAMissingRelay is issue #281. A server with no TURN
// relay used to answer "Connected." and the failure surfaced thirty seconds
// into the next Hide my IP transfer, as a generic connection timeout.
//
// OK stays TRUE on purpose. This is a working Floe signaling server and every
// transfer that does not force the relay will run on it; calling it an error
// would send a self-hoster looking for a broken reverse proxy that does not
// exist. The message is what carries the limitation.
func TestProbeServerReportsAMissingRelay(t *testing.T) {
	srv := floeServerICE(true, true, iceSTUNOnly)
	defer srv.Close()

	got := probeServer(srv.URL, okWS)
	if !got.OK {
		t.Fatalf("probeServer = %+v, want OK: the server itself is fine", got)
	}
	if got.RelayAvailable {
		t.Error("RelayAvailable = true for a STUN-only server")
	}
	if !strings.Contains(got.Message, "Hide my IP") {
		t.Errorf("Message = %q, want it to name the setting that cannot work", got.Message)
	}
	if !strings.HasPrefix(got.Message, "Connected.") {
		t.Errorf("Message = %q, want it to still read as a pass", got.Message)
	}
}

// TestProbeServerReadsBothURLShapes is the regression detector for the trap the
// issue singled out: "urls" is a plain string for coturn and the STUN fallback
// but an array of strings for Cloudflare. Classifying only one shape would call
// a Cloudflare server relay-less.
func TestProbeServerReadsBothURLShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"coturn, urls as a string, with a relay", iceWithTURN, true},
		{"cloudflare, urls as an array, with a relay", iceCloudflare, true},
		{"stun only, urls as a string", iceSTUNOnly, false},
		{"stun only, urls as an array", iceSTUNOnlyList, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := floeServerICE(true, true, tc.body)
			defer srv.Close()

			got := probeServer(srv.URL, okWS)
			if !got.OK {
				t.Fatalf("probeServer = %+v, want OK", got)
			}
			if got.RelayAvailable != tc.want {
				t.Errorf("RelayAvailable = %v, want %v", got.RelayAvailable, tc.want)
			}
		})
	}
}

// TestProbeServerRejectsAnEmptyICEEntry: an entry with no "urls" is nothing to
// connect with. The old check counted JSON array entries, so this passed as
// "usable connection details" while ice.Fetch would have dropped it and fallen
// back to public STUN. Reading the list through the engine's own decoder is
// what closes that.
func TestProbeServerRejectsAnEmptyICEEntry(t *testing.T) {
	srv := floeServerICE(true, true, iceNoURLs)
	defer srv.Close()

	got := probeServer(srv.URL, okWS)
	if got.OK {
		t.Fatalf("probeServer = %+v, want a failure", got)
	}
	if !strings.Contains(got.Message, "usable connection details") {
		t.Errorf("Message = %q, want the unusable-details message", got.Message)
	}
}

// TestProbeServerRefusesRedirects stops a catch-all rewrite or captive portal
// from passing as a healthy server.
func TestProbeServerRefusesRedirects(t *testing.T) {
	real := floeServer(true, true)
	defer real.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, real.URL+r.URL.Path, http.StatusFound)
	}))
	defer redirector.Close()

	if got := probeServer(redirector.URL, okWS); got.OK {
		t.Errorf("probeServer followed a redirect: %+v", got)
	}
}
