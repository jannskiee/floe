package main

import (
	"encoding/json"
	"errors"
	"fmt"
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
	// looked, and the zero value says so. Hide my IP is the only thing that
	// needs a relay, so false here is information rather than a failure.
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
		return ProbeResult{Message: "Enter a server address."}
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return ProbeResult{Message: "That does not look like an address. Include https:// and the host name."}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ProbeResult{Message: "The address must start with https:// or http://."}
	}

	if r := probeHealth(base); !r.OK {
		return r
	}
	if err := dialWS(base); err != nil {
		return ProbeResult{Message: "The server answered, but the realtime connection was refused. If it is behind a reverse proxy, check that /ws is being forwarded."}
	}
	return probeAPI(base)
}

// probeHealth is stage one: reachable, and answering as a Floe server.
func probeHealth(base string) ProbeResult {
	resp, err := probeClient().Get(base + "/health")
	if err != nil {
		return ProbeResult{Message: describeDialError(err)}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ProbeResult{Message: fmt.Sprintf(
			"The address answered with HTTP %d. This may be the web app rather than the signaling server.", resp.StatusCode)}
	}
	var body struct {
		Status string `json:"status"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil || body.Status != "healthy" {
		return ProbeResult{Message: "Something answered at that address, but it is not a Floe signaling server."}
	}
	return ProbeResult{OK: true}
}

// probeAPI is stage three: the REST endpoints a transfer actually needs, and
// whether the ICE list they return has a relay in it.
func probeAPI(base string) ProbeResult {
	resp, err := probeClient().Get(base + "/api/turn-credentials")
	if err != nil {
		return ProbeResult{Message: describeDialError(err)}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ProbeResult{Message: fmt.Sprintf(
			"The server is running, but its API answered with HTTP %d. If it is behind a reverse proxy, check that /api/ is being forwarded.", resp.StatusCode)}
	}
	// Decoded by the engine rather than by hand. "urls" is a plain string for
	// coturn and the STUN-only fallback but an array for Cloudflare, and one
	// decoder is one place to get that right. It also makes "usable" here mean
	// what a transfer means by it: an entry with no urls at all used to pass,
	// because the old check only asked whether the JSON array was non-empty.
	servers, err := ice.ParseServers(resp.Body)
	if err != nil || len(servers) == 0 {
		return ProbeResult{Message: "The server is running, but it did not return usable connection details."}
	}
	if !ice.HasRelay(servers) {
		// A pass, not a failure, and the OK matters: this is a working Floe
		// signaling server, every transfer that does not force the relay will
		// run on it, and marking it an error would send a self-hoster looking
		// for a broken reverse proxy that does not exist. Saying so here is
		// what replaces a thirty-second timeout later that reads like a
		// network fault on a network that is fine.
		return ProbeResult{OK: true, Message: "Connected. This server has no TURN relay, so Hide my IP will not work."}
	}
	return ProbeResult{OK: true, RelayAvailable: true, Message: "Connected."}
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
		return "That host could not be found. Check the address for typos."
	}
	if os.IsTimeout(err) {
		return "Timed out reaching that address."
	}
	if s := err.Error(); strings.Contains(s, "certificate") || strings.Contains(s, "tls:") || strings.Contains(s, "x509") {
		return "The server's security certificate could not be verified."
	}
	return "Could not connect. Check that the server is running and reachable from this machine."
}
