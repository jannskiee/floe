package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
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
	if want := "The API answered HTTP 404 (check that your proxy forwards /api/)"; got.Message != want {
		t.Errorf("message = %q, want %q", got.Message, want)
	}
}

// statusServer is a healthy Floe server whose /api/turn-credentials answers
// with status and no usable body.
func statusServer(status int) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"healthy","uptime":42.0}`))
	})
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	})
	return httptest.NewServer(mux)
}

// TestProbeServerNamesTheServersOwnRateLimit: a 429 from /api/ is the server's
// own limit on requests from one network (20 a minute on this endpoint, which
// pressing Test spends), answered by a server whose proxy forwards /api/ as
// it should. It gets its own sentence, with nothing about a proxy in it. Every
// other status keeps the proxy hint, with the number that came back.
func TestProbeServerNamesTheServersOwnRateLimit(t *testing.T) {
	limited := statusServer(http.StatusTooManyRequests)
	defer limited.Close()
	got := probeServer(limited.URL, okWS)
	if got.OK {
		t.Fatalf("probeServer = %+v, want a failure: the test could not finish", got)
	}
	if want := "The server is limiting requests from this network. Wait a minute and test again"; got.Message != want {
		t.Errorf("message = %q, want %q", got.Message, want)
	}
	for _, wrong := range []string{"proxy", "/api/", "429"} {
		if strings.Contains(got.Message, wrong) {
			t.Errorf("message = %q, names %q for the server's own limit", got.Message, wrong)
		}
	}

	for _, status := range []int{http.StatusNotFound, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusInternalServerError} {
		srv := statusServer(status)
		got := probeServer(srv.URL, okWS)
		srv.Close()
		want := "The API answered HTTP " + strconv.Itoa(status) + " (check that your proxy forwards /api/)"
		if got.OK || got.Message != want {
			t.Errorf("status %d: probeServer = %+v, want the message %q", status, got, want)
		}
	}
}

// TestProbeServerCatchesMissingWebSocket covers the other proxy misconfiguration.
// A dial that failed without an HTTP status names both things a proxy gets
// wrong here: not forwarding /ws, and forwarding it with the Host header
// rewritten, which the server's origin check answers 403. A 403 and a 404 get
// a sentence each (TestProbeServerNamesTheRealtimeRefusalByItsStatus).
func TestProbeServerCatchesMissingWebSocket(t *testing.T) {
	srv := floeServer(true, true)
	defer srv.Close()

	got := probeServer(srv.URL, func(string) error { return errors.New("upgrade refused") })
	if got.OK {
		t.Fatal("probeServer accepted a server whose /ws is not reachable")
	}
	if want := "The server refused the realtime connection (check that your proxy forwards /ws and passes the original Host header)"; got.Message != want {
		t.Errorf("message = %q, want %q", got.Message, want)
	}
}

// TestProbeServerNamesTheRealtimeRefusalByItsStatus (H-1): the engine keeps
// the status of a refused /ws upgrade (signaling.HandshakeError, #572), and
// the two common answers have different fixes. 403 is the server's Origin
// check, which is what a proxy that rewrites the Host header produces; 404 is
// a proxy that does not forward /ws (since #581 the server itself answers 404
// only for an upgrade on some other path). Any other refusal keeps the
// sentence that names both.
func TestProbeServerNamesTheRealtimeRefusalByItsStatus(t *testing.T) {
	const (
		hostLine = "The server refused the realtime connection (check that your proxy passes the original Host header)"
		wsLine   = "The server refused the realtime connection (check that your proxy forwards /ws)"
		bothLine = "The server refused the realtime connection (check that your proxy forwards /ws and passes the original Host header)"
	)
	serve := func(status int) string {
		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"status":"healthy"}`))
		})
		mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(iceWithTURN))
		})
		mux.HandleFunc("/ws", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "refused", status)
		})
		srv := httptest.NewServer(mux)
		t.Cleanup(srv.Close)
		return srv.URL
	}
	// Through the engine's own dial, as Test runs it.
	for _, tc := range []struct {
		status int
		want   string
	}{
		{http.StatusForbidden, hostLine},
		{http.StatusNotFound, wsLine},
		{http.StatusBadGateway, bothLine},
		{http.StatusServiceUnavailable, bothLine},
	} {
		got := probeServer(serve(tc.status), dialSignaling)
		if got.OK || got.Message != tc.want {
			t.Errorf("/ws answered %d: %+v, want %q", tc.status, got, tc.want)
		}
	}
	// A dial that failed with no HTTP answer at all says what it always did.
	if got := probeServer(serve(http.StatusOK), func(string) error { return errors.New("upgrade refused") }); got.Message != bothLine {
		t.Errorf("no status: %q, want %q", got.Message, bothLine)
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
	if got := probeServer(notFloe.URL, okWS); got.OK || !strings.Contains(got.Message, "isn't a Floe server") {
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
		{"unresolvable host", "https://floe-probe-test.invalid", "Host not found"},
		{"connection refused", "http://127.0.0.1:59999", "Couldn't connect"},
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
		{"no scheme", "floe.example.com", "Include https:// and the host name"},
		{"wrong scheme", "ftp://floe.example.com", "Start the address with"},
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
	if got.Message != "Connected" {
		t.Errorf("Message = %q, want the unchanged pass message", got.Message)
	}
}

// TestProbeServerReportsAMissingRelay is issue #281. A server with no TURN
// relay used to answer "Connected." and the failure surfaced thirty seconds
// into the next Hide my IP transfer, as a generic connection timeout.
//
// OK stays TRUE on purpose. This is a working Floe signaling server, and two
// devices that can reach each other directly transfer through it; calling it
// an error would send a self-hoster looking for a broken reverse proxy that
// does not exist. The message is what carries the limitation, and it names
// both halves of it: Hide my IP cannot work, and two devices with no direct
// path between them cannot connect at all.
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
	if want := "Connected, but this server has no relay: Hide my IP will not work, and some networks will not connect"; got.Message != want {
		t.Errorf("Message = %q, want %q", got.Message, want)
	}
	if !strings.HasPrefix(got.Message, "Connected, but") {
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

// healthServer answers /health with body and nothing else.
func healthServer(body string) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	})
	return httptest.NewServer(mux)
}

// TestProbeHealthReadsFeatures: the request link lane reads request-1 out of the
// server's feature list; unknown names beside it are ignored, never an error.
func TestProbeHealthReadsFeatures(t *testing.T) {
	srv := healthServer(`{"status":"healthy","uptime":1,"features":["portal-9","request-1","x"]}`)
	defer srv.Close()

	r, features, listed := probeHealth(srv.URL)
	if !r.OK || !listed {
		t.Fatalf("probeHealth = %+v, listed %v, want OK with a list", r, listed)
	}
	if !featuresHave(features, "request-1") {
		t.Errorf("features = %v, want request-1 found", features)
	}
	if featuresHave(features, "request-2") {
		t.Errorf("featuresHave matched a name that is not in the list")
	}
	if got := requestLinkSupport(srv.URL); got != (FeatureResult{Reachable: true, RequestLinks: true, FeatureList: true}) {
		t.Errorf("requestLinkSupport = %+v, want reachable with request-1", got)
	}
}

// TestProbeHealthToleratesMissingFeatures: every server that predates the
// feature list, and every self-host that never turned it on, answers without
// one. That is a healthy server with no request links, not a failure, and
// Settings Test must keep passing against it.
func TestProbeHealthToleratesMissingFeatures(t *testing.T) {
	for _, body := range []string{
		`{"status":"healthy","uptime":42.0}`,
		`{"status":"healthy","features":[]}`,
		`{"status":"healthy","features":null}`,
	} {
		srv := healthServer(body)
		r, features, _ := probeHealth(srv.URL)
		if !r.OK {
			t.Errorf("%s: probeHealth = %+v, want OK", body, r)
		}
		if featuresHave(features, "request-1") {
			t.Errorf("%s: request-1 found in %v", body, features)
		}
		if got := requestLinkSupport(srv.URL); !got.Reachable || got.RequestLinks {
			t.Errorf("%s: requestLinkSupport = %+v, want reachable without request links", body, got)
		}
		srv.Close()
	}

	// A features value of the wrong shape must not fail the health check that
	// Settings Test relies on, and must never read as request-1.
	srv := healthServer(`{"status":"healthy","features":"request-1"}`)
	defer srv.Close()
	if got := requestLinkSupport(srv.URL); got.RequestLinks {
		t.Errorf("a string features value read as request-1: %+v", got)
	}
}

// TestRequestLinkSupportTellsAMissingListFromAnEmptyOne (deep QA A7-04): a
// current server always sends a feature list, [] while request links are off,
// and a server from before request links sends none. Make link words the two
// apart, so FeatureList reports whether a list came at all; null and a value
// of the wrong shape are no list.
func TestRequestLinkSupportTellsAMissingListFromAnEmptyOne(t *testing.T) {
	for _, tc := range []struct {
		body string
		want FeatureResult
	}{
		{`{"status":"healthy","uptime":42.0}`, FeatureResult{Reachable: true}},
		{`{"status":"healthy","features":null}`, FeatureResult{Reachable: true}},
		{`{"status":"healthy","features":"request-1"}`, FeatureResult{Reachable: true}},
		{`{"status":"healthy","features":[]}`, FeatureResult{Reachable: true, FeatureList: true}},
		{`{"status":"healthy","features":["portal-9"]}`, FeatureResult{Reachable: true, FeatureList: true}},
		{`{"status":"healthy","features":["request-1"]}`, FeatureResult{Reachable: true, RequestLinks: true, FeatureList: true}},
	} {
		srv := healthServer(tc.body)
		if got := requestLinkSupport(srv.URL); got != tc.want {
			t.Errorf("%s: requestLinkSupport = %+v, want %+v", tc.body, got, tc.want)
		}
		srv.Close()
	}
}

// TestRequestLinkSupportUnreachable: a server that cannot be reached, or that
// answers but is not a Floe server, reports no request links, so the switch
// stays disabled with S4.
func TestRequestLinkSupportUnreachable(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	if got := requestLinkSupport(url); got != (FeatureResult{}) {
		t.Errorf("closed port: requestLinkSupport = %+v, want the zero result", got)
	}

	notFloe := healthServer(`<html>welcome</html>`)
	defer notFloe.Close()
	if got := requestLinkSupport(notFloe.URL); got != (FeatureResult{}) {
		t.Errorf("non-Floe answer: requestLinkSupport = %+v, want the zero result", got)
	}

	unhealthy := healthServer(`{"status":"starting","features":["request-1"]}`)
	defer unhealthy.Close()
	if got := requestLinkSupport(unhealthy.URL); got.RequestLinks {
		t.Errorf("an unhealthy server's feature list was trusted: %+v", got)
	}

	if got := requestLinkSupport(""); got != (FeatureResult{}) {
		t.Errorf("empty base: requestLinkSupport = %+v, want the zero result", got)
	}
}

// TestRequestLinkSupportRefusesRedirects: a captive portal or a catch-all
// rewrite pointing at a server that does list request-1 must not unlock the
// switch. The probe shares probeClient's no-redirect rule with Settings Test.
func TestRequestLinkSupportRefusesRedirects(t *testing.T) {
	real := healthServer(`{"status":"healthy","features":["request-1"]}`)
	defer real.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, real.URL+r.URL.Path, http.StatusFound)
	}))
	defer redirector.Close()

	if got := requestLinkSupport(redirector.URL); got.RequestLinks || got.Reachable {
		t.Errorf("requestLinkSupport followed a redirect: %+v", got)
	}
}

// TestRequestLinkSupportUsesTheConfiguredServer: the bound method probes the
// server this app talks to, the endpoints() snapshot, not a fixed host.
func TestRequestLinkSupportUsesTheConfiguredServer(t *testing.T) {
	srv := healthServer(`{"status":"healthy","features":["request-1"]}`)
	defer srv.Close()
	a := &App{cfg: appConfig{Server: srv.URL}}
	if got := a.RequestLinkSupport(); got != (FeatureResult{Reachable: true, RequestLinks: true, FeatureList: true}) {
		t.Errorf("RequestLinkSupport = %+v, want reachable with request-1 from %s", got, srv.URL)
	}
}
