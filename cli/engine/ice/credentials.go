// Package ice fetches STUN/TURN ICE server credentials from the Floe signaling server.
package ice

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/pion/webrtc/v4"
)

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
	return servers, nil
}

func defaults() []webrtc.ICEServer {
	return []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
		{URLs: []string{"stun:stun1.l.google.com:19302"}},
	}
}
