// Package ice fetches STUN/TURN ICE server credentials from the Floe signaling server.
package ice

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

// iceURLClass buckets an ICE URL into a connectivity class. pion gathers
// candidates and opens TURN allocations per URL per network interface, so
// redundant URLs of the same class multiply connection-setup work for zero
// connectivity gain.
func iceURLClass(u string) string {
	// A URI scheme is case-insensitive (RFC 3986), and pion lowercases it before
	// parsing, so "TURN:host:3478" is a relay to the ICE agent. Matching it
	// case-sensitively made this disagree with what pion actually gathers, which
	// matters now that HasRelay decides whether a relay-only transfer may start.
	// Only the classification is lowercased; callers keep the original URL.
	u = strings.ToLower(u)
	switch {
	case strings.HasPrefix(u, "stun:"):
		return "stun"
	case strings.HasPrefix(u, "turns:"):
		return "tls"
	case strings.HasPrefix(u, "turn:"):
		if strings.Contains(u, "transport=tcp") {
			return "tcp"
		}
		return "udp" // RFC 7065: a turn: URI without a transport param is UDP
	}
	return ""
}

// HasRelay reports whether a list offers a TURN relay.
//
// Relay-only mode (the desktop's "Hide my IP", the CLI's --relay-only) cannot
// connect without one: ICE gathers no usable candidate at all and the attempt
// dies about thirty seconds later as a generic timeout, which reads like a
// network fault on a network that is fine. Both surfaces check this before they
// start rather than after.
//
// The relay classes are enumerated positively rather than tested as "not stun",
// so a class added to iceURLClass later has to be considered here instead of
// silently counting as a relay.
func HasRelay(servers []webrtc.ICEServer) bool {
	for _, s := range servers {
		for _, u := range s.URLs {
			switch iceURLClass(u) {
			case "udp", "tcp", "tls":
				return true
			}
		}
	}
	return false
}

// StunOnly keeps the entries that offer a STUN URL and drops the rest, which
// is what --no-relay means on both CLI commands: gather host and
// server-reflexive candidates, never a relay. Both call it after requireRelay,
// which has to see the server's full list.
//
// The body is the loop the two commands each carried, kept as it was. The
// filter is in place: the result aliases the input's backing array, so the
// caller reassigns and never reads the input again. An entry is kept or
// dropped whole, so one carrying both a stun and a turn URL survives with
// both. The prefix test is case-sensitive; iceURLClass is the
// case-insensitive classifier HasRelay uses, and this deliberately does not
// go through it, so a change in what --no-relay keeps is a decision rather
// than a side effect.
func StunOnly(servers []webrtc.ICEServer) []webrtc.ICEServer {
	filtered := servers[:0]
	for _, s := range servers {
		for _, u := range s.URLs {
			if len(u) >= 4 && u[:4] == "stun" {
				filtered = append(filtered, s)
				break
			}
		}
	}
	return filtered
}

// pick returns the first URL in urls that contains pref, else the first URL.
func pick(urls []string, pref string) string {
	for _, u := range urls {
		if strings.Contains(u, pref) {
			return u
		}
	}
	if len(urls) > 0 {
		return urls[0]
	}
	return ""
}

// trimICEServers caps a server-provided ICE list to one URL per connectivity
// class: one STUN (prefer :3478), one TURN over UDP (the fast relay path), and
// one TURN over TLS preferring :443 (the firewall fallback; plain turn-tcp is
// used only when no turns: URL exists). Entry structure and credentials are
// preserved so per-entry username/credential pairs stay attached. Defense in
// depth for servers that forward a provider's full redundant list (Cloudflare
// mints 8 URLs); a minimal list like self-hosted coturn's passes through
// unchanged. Returns the input untouched if trimming would remove everything.
func trimICEServers(servers []webrtc.ICEServer) []webrtc.ICEServer {
	var stun, udp, tcp, tls []string
	for _, s := range servers {
		for _, u := range s.URLs {
			switch iceURLClass(u) {
			case "stun":
				stun = append(stun, u)
			case "udp":
				udp = append(udp, u)
			case "tcp":
				tcp = append(tcp, u)
			case "tls":
				tls = append(tls, u)
			}
		}
	}

	keep := map[string]bool{}
	if u := pick(stun, ":3478"); u != "" {
		keep[u] = true
	}
	if u := pick(udp, "transport=udp"); u != "" {
		keep[u] = true
	}
	if u := pick(tls, ":443"); u != "" {
		keep[u] = true
	} else if u := pick(tcp, ""); u != "" {
		keep[u] = true
	}

	var out []webrtc.ICEServer
	for _, s := range servers {
		var urls []string
		for _, u := range s.URLs {
			if keep[u] {
				urls = append(urls, u)
				delete(keep, u) // a URL duplicated across entries is kept once
			}
		}
		if len(urls) > 0 {
			trimmed := s
			trimmed.URLs = urls
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return servers // nothing classifiable: leave the list alone
	}
	return out
}

// iceServerJSON is the raw JSON shape returned by /api/turn-credentials.
// The "urls" field can be either a single string or an array of strings.
type iceServerJSON struct {
	URLs       json.RawMessage `json:"urls"`
	Username   string          `json:"username,omitempty"`
	Credential string          `json:"credential,omitempty"`
}

// client bounds the fetch. http.DefaultClient has no timeout at all, so a
// server that accepts the TCP connection and then never answers used to hang
// `floe send` at step 2 forever. Generous on purpose: falling back to STUN
// costs a relay, so a slow-but-working server should still win.
var client = &http.Client{Timeout: 30 * time.Second}

// Fetch fetches ICE server credentials from serverURL/api/turn-credentials.
// Falls back to Google STUN if the endpoint is unreachable or misconfigured.
func Fetch(serverURL string) ([]webrtc.ICEServer, error) {
	servers, _, err := FetchDetail(serverURL)
	return servers, err
}

// FetchDetail is Fetch plus the one thing Fetch throws away: whether the list
// came from the server at all, or is the STUN-only fallback.
//
// Fetch collapses four different outcomes into the same return value. An
// unreachable server, a non-200 (the TURN endpoint's own rate limiter included),
// an unreadable body and a genuinely relay-less server all produce
// defaults() and a nil error, and the only thing telling them apart is a line
// printed to stdout, which a GUI never shows. A caller that refuses to start
// because there is no relay has to know which of those happened, or it blames
// the server's configuration for what was really a failed fetch.
//
// degraded is true whenever the returned list is defaults() rather than the
// server's own. A relay-less server is NOT degraded: it answered, and the answer
// was "STUN only".
func FetchDetail(serverURL string) (servers []webrtc.ICEServer, degraded bool, err error) {
	resp, err := client.Get(serverURL + "/api/turn-credentials")
	if err != nil {
		// Server unreachable — use public Google STUN as fallback
		fmt.Println("  Warning: could not reach signaling server for TURN credentials. Using STUN only.")
		return defaults(), true, nil
	}
	defer resp.Body.Close()

	// An HTTP error used to be silent: the body is not a JSON array, Decode
	// fails, and the STUN-only fallback below returns with nothing printed.
	// serverurl.go documents the consequence, that a relayed transfer dies with
	// no message. Say so, but still fall back rather than erroring: both callers
	// treat a Fetch error as fatal, and a 429 from the TURN limiter is a
	// documented degrade that today completes over direct STUN.
	if resp.StatusCode != http.StatusOK {
		fmt.Printf("  Warning: signaling server returned %d for TURN credentials. Using STUN only.\n", resp.StatusCode)
		return defaults(), true, nil
	}

	parsed, err := ParseServers(resp.Body)
	if err != nil || len(parsed) == 0 {
		return defaults(), true, nil
	}
	return trimICEServers(parsed), false, nil
}

// ParseServers decodes a /api/turn-credentials body into pion's ICE server
// shape.
//
// Split out of Fetch so the desktop's server probe can read the list the same
// way a transfer does. The "urls" field is a plain string for coturn and for
// the STUN-only fallback, but an array of strings for Cloudflare, and a second
// implementation of that rule is a second thing to get wrong.
//
// Entries carrying no usable "urls" are dropped, so an empty result means the
// body parsed but held nothing to connect with.
func ParseServers(r io.Reader) ([]webrtc.ICEServer, error) {
	var raw []iceServerJSON
	if err := json.NewDecoder(r).Decode(&raw); err != nil {
		return nil, err
	}

	var servers []webrtc.ICEServer
	for _, s := range raw {
		// Parse "urls": either a string "stun:..." or array ["stun:..."]
		var urlStr string
		var urlArr []string
		if json.Unmarshal(s.URLs, &urlStr) == nil {
			urlArr = []string{urlStr}
		} else {
			json.Unmarshal(s.URLs, &urlArr)
		}
		if len(urlArr) == 0 {
			continue
		}

		ice := webrtc.ICEServer{URLs: urlArr}
		if s.Username != "" {
			ice.Username = s.Username
			ice.Credential = s.Credential
			ice.CredentialType = webrtc.ICECredentialTypePassword
		}
		servers = append(servers, ice)
	}
	return servers, nil
}

func defaults() []webrtc.ICEServer {
	return []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
		{URLs: []string{"stun:stun1.l.google.com:19302"}},
	}
}
