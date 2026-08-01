// Package code handles the Floe short-code API.
// The server maps a 3-word code like "olive-tiger-castle" to a UUID room ID.
// This lets CLI users type a short phrase instead of a full URL.
package code

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Register calls POST /api/code on the signaling server to get a short code
// that resolves to the given roomId. Returns the code phrase e.g. "olive-tiger-castle".
func Register(serverURL, roomId string) (string, error) {
	body, _ := json.Marshal(map[string]string{"roomId": roomId})
	resp, err := http.Post(serverURL+"/api/code", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("could not register code: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("server returned %d when registering code", resp.StatusCode)
	}

	var result struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || result.Code == "" {
		return "", fmt.Errorf("invalid response from code API")
	}
	return result.Code, nil
}

// Resolve converts a code phrase or URL to a room UUID.
//   - "olive-tiger-castle"              → calls GET /api/code/olive-tiger-castle
//   - "https://floe.one/#room=uuid"     → extracts the room from the URL fragment
//   - "https://floe.one/?room=uuid"     → extracts the room query parameter
func Resolve(serverURL, input string) (string, error) {
	input = strings.TrimSpace(input)

	// If input contains "://" it is a URL — extract the room id from it.
	if strings.Contains(input, "://") {
		u, err := url.Parse(input)
		if err != nil {
			return "", fmt.Errorf("invalid URL: %w", err)
		}
		// Newer links keep the room id in the fragment (#room=uuid) so it never
		// leaks to servers or analytics; older links use the ?room= query param.
		roomId := u.Query().Get("room")
		if roomId == "" && u.Fragment != "" {
			if frag, err := url.ParseQuery(u.Fragment); err == nil {
				roomId = frag.Get("room")
			}
		}
		if roomId == "" {
			return "", fmt.Errorf("URL does not contain a room id (#room= or ?room=)")
		}
		return roomId, nil
	}

	// Otherwise treat it as a word code and resolve via the server
	resp, err := http.Get(serverURL + "/api/code/" + url.PathEscape(input))
	if err != nil {
		return "", fmt.Errorf("could not reach signaling server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("code %q not found or expired (codes expire after 10 minutes)", input)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("server returned %d when resolving code", resp.StatusCode)
	}

	var result struct {
		RoomID string `json:"roomId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || result.RoomID == "" {
		return "", fmt.Errorf("invalid response from code API")
	}
	return result.RoomID, nil
}
