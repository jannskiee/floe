// Package ice fetches STUN/TURN ICE server credentials from the Floe signaling server.
package ice

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/pion/webrtc/v4"
)

// iceURLClass buckets an ICE URL into a connectivity class. pion gathers
// candidates and opens TURN allocations per URL per network interface, so
// redundant URLs of the same class multiply connection-setup work for zero
// connectivity gain.
func iceURLClass(u string) string {
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

// Fetch fetches ICE server credentials from serverURL/api/turn-credentials.
// Falls back to Google STUN if the endpoint is unreachable or misconfigured.
func Fetch(serverURL string) ([]webrtc.ICEServer, error) {
	resp, err := http.Get(serverURL + "/api/turn-credentials")
	if err != nil {
		// Server unreachable — use public Google STUN as fallback
		fmt.Println("  Warning: could not reach signaling server for TURN credentials. Using STUN only.")
		return defaults(), nil
	}
	defer resp.Body.Close()

	var raw []iceServerJSON
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil || len(raw) == 0 {
		return defaults(), nil
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

	if len(servers) == 0 {
		return defaults(), nil
	}
	return trimICEServers(servers), nil
}

func defaults() []webrtc.ICEServer {
	return []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
		{URLs: []string{"stun:stun1.l.google.com:19302"}},
	}
}
