package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/serverurl"
	"github.com/jannskiee/floe/cli/engine/signaling"
)

// probeTimeout bounds each stage separately. Long enough for a cold container to
// answer, short enough that a wrong address does not feel like a hang.
const probeTimeout = 6 * time.Second

// ProbeResult is what the Settings screen shows after Test.
//
// Deliberately a single struct with no error return: Wails' dispatcher sets the
// result and the error in mutually exclusive branches, so a method returning
// (ProbeResult, error) hands the frontend a null result whenever the error is
// non-nil, which is exactly the case the message is needed for.
type ProbeResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	// RelayAvailable reports whether the server's ICE list offers a TURN relay.
	// Only meaningful when OK: a probe that failed before stage three never
	// looked, and the zero value says so. Two things need a relay: Hide my IP,
	// and any two devices with no direct path between them. A server without
	// one still carries every transfer that can connect directly, so false
	// here is information rather than a failure.
	RelayAvailable bool `json:"relayAvailable"`
}

// TestServer checks that an address is a reachable Floe signaling server.
func (a *App) TestServer(raw string) ProbeResult {
	return probeServer(raw, dialSignaling)
}

// dialSignaling opens and immediately closes a real signaling connection. Using
// the engine's own dialer rather than a hand-rolled one means the probe
// exercises the identical path a transfer takes, including the Origin header.
func dialSignaling(base string) error {
	sc, err := signaling.Connect(base)
	if err != nil {
		return err
	}
	sc.Close()
	return nil
}

// probeServer runs three stages against base. Each one catches a failure the
// others cannot:
//
//	/health   the address is reachable and is a Floe signaling server
//	/ws       a reverse proxy is forwarding the WebSocket upgrade
//	/api/     a reverse proxy is forwarding the REST endpoints
//
// The third stage is not redundant. A proxy that forwards /health and /ws but
// drops /api/ passes the first two, and the resulting breakage is invisible:
// ice.Fetch swallows the 404 and falls back to public STUN, and a failed code
// registration is discarded, so the user gets a share link with no code and no
// error message.
//
// dialWS is injected so tests can drive the WebSocket outcome without standing
// up an upgrade-capable server.
func probeServer(raw string, dialWS func(string) error) ProbeResult {
	base := serverurl.Normalize(raw)
	if base == "" {
		return ProbeResult{Message: "Enter a server address"}
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return ProbeResult{Message: "Include https:// and the host name"}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ProbeResult{Message: "Start the address with https:// or http://"}
	}

	if r, _ := probeHealth(base); !r.OK {
		return r
	}
	if err := dialWS(base); err != nil {
		return ProbeResult{Message: realtimeRefusal(err)}
	}
	return probeAPI(base)
}

// realtimeRefusal words a /ws dial that failed, by the HTTP status the engine
// kept (signaling.HandshakeError, #572; H-1). The two common causes have
// different fixes: 403 is the server's origin check, which a proxy that
// rewrites the Host header fails; 404 is a proxy that does not forward /ws
// (the server answers 404 itself only for an upgrade on another path, #581).
// Any other answer, or none, names both, which is true either way.
func realtimeRefusal(err error) string {
	var hs *signaling.HandshakeError
	if errors.As(err, &hs) {
		switch hs.Status {
		case http.StatusForbidden:
			return "The server refused the realtime connection (check that your proxy passes the original Host header)"
		case http.StatusNotFound:
			return "The server refused the realtime connection (check that your proxy forwards /ws)"
		}
	}
	return "The server refused the realtime connection (check that your proxy forwards /ws and passes the original Host header)"
}

// probeHealth is stage one: reachable, and answering as a Floe server. It also
// returns the server's optional feature list (spec 04 5.9, ["request-1"] on a
// server with request links on), which only RequestLinkSupport reads. A missing
// list is an older or self-hosted server and is not a failure; a list of the
// wrong shape is treated as absent rather than failing Settings Test.
func probeHealth(base string) (ProbeResult, []string) {
	resp, err := probeClient().Get(base + "/health")
	if err != nil {
		return ProbeResult{Message: describeDialError(err)}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ProbeResult{Message: fmt.Sprintf(
			"That address answered HTTP %d (likely the web app, not the server)", resp.StatusCode)}, nil
	}
	var body struct {
		Status   string          `json:"status"`
		Features json.RawMessage `json:"features"`
	}
	// Bounded: the feature list is the only open-ended field, and nothing a
	// Floe server sends here comes near 64 KiB.
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body) != nil || body.Status != "healthy" {
		return ProbeResult{Message: "That address isn't a Floe server"}, nil
	}
	var features []string
	if json.Unmarshal(body.Features, &features) != nil {
		features = nil
	}
	return ProbeResult{OK: true}, features
}

// FeatureResult is the Go-side /health probe for the request link lane: whether
// the server answered as a healthy Floe server, and whether it lists request-1.
// One struct return, never a (T, error) pair, for the reason ProbeResult gives.
type FeatureResult struct {
	Reachable    bool `json:"reachable"`
	RequestLinks bool `json:"requestLinks"`
}

// RequestLinkSupport probes the server this app talks to for request-1 (spec
// 06 4.18). It runs in Go because the webview's CSP blocks the fetch, through
// probeClient: six seconds, no redirects, so a captive portal or a catch-all
// rewrite cannot unlock the switch. Only the two booleans reach the frontend,
// never the body or an error text.
func (a *App) RequestLinkSupport() FeatureResult {
	server, _ := a.endpoints()
	return requestLinkSupport(server)
}

// requestLinkSupport is RequestLinkSupport against an explicit base, so tests
// can aim it at an httptest server. An unreachable or unhealthy server is the
// zero result: not reachable, no request links.
func requestLinkSupport(base string) FeatureResult {
	if base == "" {
		return FeatureResult{}
	}
	r, features := probeHealth(base)
	if !r.OK {
		return FeatureResult{}
	}
	return FeatureResult{Reachable: true, RequestLinks: featuresHave(features, "request-1")}
}

// featuresHave reports whether name is in the server's feature list. Exact
// match only; names this build does not know are ignored.
func featuresHave(list []string, name string) bool {
	for _, f := range list {
		if f == name {
			return true
		}
	}
	return false
}

// probeAPI is stage three: the REST endpoints a transfer actually needs, and
// whether the ICE list they return has a relay in it.
func probeAPI(base string) ProbeResult {
	resp, err := probeClient().Get(base + "/api/turn-credentials")
	if err != nil {
		return ProbeResult{Message: describeDialError(err)}
	}
	defer resp.Body.Close()

	// A 429 is the server's own limit on requests from one network (20 a
	// minute on this endpoint by default, and each press of Test spends one),
	// so the request did reach /api/ and the proxy hint below would be wrong.
	if resp.StatusCode == http.StatusTooManyRequests {
		return ProbeResult{Message: "The server is limiting requests from this network. Wait a minute and test again"}
	}
	if resp.StatusCode != http.StatusOK {
		return ProbeResult{Message: fmt.Sprintf(
			"The API answered HTTP %d (check that your proxy forwards /api/)", resp.StatusCode)}
	}
	// Decoded by the engine rather than by hand. "urls" is a plain string for
	// coturn and the STUN-only fallback but an array for Cloudflare, and one
	// decoder is one place to get that right. It also makes "usable" here mean
	// what a transfer means by it: an entry with no urls at all used to pass,
	// because the old check only asked whether the JSON array was non-empty.
	servers, err := ice.ParseServers(resp.Body)
	if err != nil || len(servers) == 0 {
		return ProbeResult{Message: "The server didn't return usable connection details"}
	}
	if !ice.HasRelay(servers) {
		// A pass, not a failure, and the OK matters: this is a working Floe
		// signaling server, two devices that can reach each other directly
		// transfer through it, and marking it an error would send a
		// self-hoster looking for a broken reverse proxy that does not exist.
		// The sentence names both things that will not work, Hide my IP and a
		// pair of devices with no direct path, because the second is the one
		// that otherwise shows up later as a thirty-second timeout that reads
		// like a network fault.
		return ProbeResult{OK: true, Message: "Connected, but this server has no relay: Hide my IP will not work, and some networks will not connect"}
	}
	return ProbeResult{OK: true, RelayAvailable: true, Message: "Connected"}
}

// probeClient refuses redirects rather than following them, so a captive portal
// or a catch-all rewrite cannot masquerade as a healthy server.
func probeClient() *http.Client {
	return &http.Client{
		Timeout: probeTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// describeDialError turns a transport failure into something a user can act on.
// The underlying error is never surfaced: it leaks internal hostnames and reads
// like a stack trace.
func describeDialError(err error) string {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "Host not found"
	}
	if os.IsTimeout(err) {
		return "Timed out reaching that address"
	}
	if s := err.Error(); strings.Contains(s, "certificate") || strings.Contains(s, "tls:") || strings.Contains(s, "x509") {
		return "Couldn't verify the server's certificate"
	}
	return "Couldn't connect to that server"
}
