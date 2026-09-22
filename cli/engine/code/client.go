// Package code handles the Floe short-code API.
// The server maps a 3-word code like "olive-tiger-castle" to a UUID room ID.
// This lets CLI users type a short phrase instead of a full URL.
package code

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// client bounds both calls. http.DefaultClient has no timeout, and Resolve's
// error is fatal to `floe receive`, so this is generous: a slow link that
// resolves today must keep resolving.
var client = &http.Client{Timeout: 30 * time.Second}

// Register calls POST /api/code on the signaling server to get a short code
// that resolves to the given roomId. Returns the code phrase e.g. "olive-tiger-castle".
func Register(serverURL, roomId string) (string, error) {
	body, _ := json.Marshal(map[string]string{"roomId": roomId})
	resp, err := client.Post(serverURL+"/api/code", "application/json", bytes.NewReader(body))
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

// ErrRequestLink and ErrDropLink are what Resolve answers for a link that is
// meant to be opened in a web browser instead of typed into a receive command:
// a request link (/r/<11 base64url characters>), and the drop link (/d/<id>,
// with the legacy /drop/<id> spelling). They are sentinels, matched with
// errors.Is and never by their text, so a caller can tell the two shapes
// apart. Both carry the one approved sentence, because every surface prints
// that same sentence for all three shapes, and neither ever contains the link.
var (
	ErrRequestLink = errors.New("That is a request link for sending files to someone. Open it in a web browser.")
	ErrDropLink    = errors.New("That is a request link for sending files to someone. Open it in a web browser.")
)

// Returned by ParseRequestLink. Fixed text that holds no part of the input, so
// a caller that prints or logs the error cannot leak the link.
var (
	errNotRequestLink  = errors.New("not a Floe request link")
	errRequestLinkRoom = errors.New("that request link carries no room id")
)

// The two browser-only link shapes, matched against the PATH and anchored at
// its end rather than against the whole input, so a self-hosted base path
// (https://files.example.com/floe/r/<id>) is recognized by its suffix and a
// query string or fragment cannot fool either one. One trailing slash is
// allowed because a browser adds it. requestLinkPath also captures the link
// id, so ParseRequestLink and the Resolve check can never drift apart.
var (
	requestLinkPath = regexp.MustCompile(`(?:^|/)r/([A-Za-z0-9_-]{11})/?$`)
	dropLinkPath    = regexp.MustCompile(`(?:^|/)(?:d|drop)/[A-Za-z0-9_-]+/?$`)
)

// uuidShape is the server's UUID_REGEX (server/server.js), so a room id this
// package accepts out of a link fragment is one the server would accept.
var uuidShape = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Resolve converts a code phrase or URL to a room UUID.
//   - "olive-tiger-castle"              → calls GET /api/code/olive-tiger-castle
//   - "https://floe.one/#room=uuid"     → extracts the room from the URL fragment
//   - "https://floe.one/?room=uuid"     → extracts the room query parameter
//   - "https://floe.one/r/<id>#uuid"    → ErrRequestLink, a browser-only link
//   - "https://floe.one/d/<id>"         → ErrDropLink, the same for a drop link
func Resolve(serverURL, input string) (string, error) {
	input = strings.TrimSpace(input)

	// If input contains "://" it is a URL — extract the room id from it.
	if strings.Contains(input, "://") {
		u, err := url.Parse(input)
		if err != nil {
			return "", fmt.Errorf("invalid URL: %w", err)
		}
		// A request link or a drop link is not a room link. Answer with a
		// sentinel before the room lookup below, so the caller can print the
		// one approved sentence instead of the raw "URL does not contain a
		// room id" text, which says nothing a person could act on.
		if requestLinkPath.MatchString(u.Path) {
			return "", ErrRequestLink
		}
		if dropLinkPath.MatchString(u.Path) {
			return "", ErrDropLink
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

	// Otherwise treat it as a word code and resolve via the server. Fold case
	// first: every entry in the server's words.json is lowercase ASCII and the
	// lookup is a plain Map.get, so "Olive-Tiger-Castle" (what a phone keyboard
	// autocapitalizes to) used to be a hard 404 reading "code not found or
	// expired".
	resp, err := client.Get(serverURL + "/api/code/" + url.PathEscape(strings.ToLower(input)))
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

// ParseRequestLink splits a request link into its link id and the room id its
// fragment carries:
//
//	https://floe.one/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f
//
// It is a local shape check and nothing more. It makes no network call, so a
// pasted link is never turned into a request to anyone, and it returns no part
// of the input inside its errors, so a caller that logs or prints the failure
// cannot leak the link or the room id in it.
//
// The fragment is a bare UUID. The #room= form is a room link and is rejected
// here; client/lib/request/requestLink.ts mirrors this shape in the browser.
func ParseRequestLink(input string) (linkID, roomID string, err error) {
	u, parseErr := url.Parse(strings.TrimSpace(input))
	if parseErr != nil {
		return "", "", errNotRequestLink
	}
	m := requestLinkPath.FindStringSubmatch(u.Path)
	if m == nil {
		return "", "", errNotRequestLink
	}
	// Never folded: a room id's case is significant to the server, which is
	// the same reason the URL branch of Resolve does not fold one either.
	if !uuidShape.MatchString(u.Fragment) {
		return "", "", errRequestLinkRoom
	}
	return m[1], u.Fragment, nil
}
