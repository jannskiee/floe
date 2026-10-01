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
	"unicode"
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

// errInvalidURL is Resolve's answer for an input it cannot use: one that does
// not parse as a URL, or one that is neither a link nor shaped like a code.
// Fixed text on purpose (D-144.7): url.Error quotes the input, and for a
// request link that is the room id in its fragment; a paste refused before the
// code lookup can hold a room id too.
var errInvalidURL = errors.New("invalid URL")

// codeShape is a code as a word list can make one, matched after the paste is
// trimmed, unwrapped and lowercased: one to four words joined by single
// hyphens, each a letter or a digit followed by letters, digits or combining
// marks, 24 characters at most. The server's own list is 1247 words of [a-z],
// five letters at most (server/words.json), and a generated code has three
// words, four after ten collisions (generateCode), while a room id has five
// groups in any script. Digits, letters outside ASCII and the combining marks
// that scripts such as Devanagari and Thai need pass too, because a
// self-hoster can replace words.json; joiners and other format characters do
// not.
var codeShape = regexp.MustCompile(`^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]{0,23}(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]{0,23}){0,3}$`)

// holdsRoomID reports whether s carries a room id in some disguise: 32 hex
// digits in a row once fullwidth forms are folded to ASCII (what NFKC does to
// them), the Cyrillic letters that look like a, c and e are read as those,
// and hyphens and combining marks are set aside. A room id is 32 hex digits;
// no code comes near that, since four shipped words hold 20 letters at most.
func holdsRoomID(s string) bool {
	run := 0
	for _, r := range s {
		switch {
		case r == '-' || unicode.Is(unicode.M, r):
			continue
		case r >= 0xFF01 && r <= 0xFF5E: // the fullwidth forms of ASCII
			r -= 0xFEE0
		case r == 'а': // Cyrillic a
			r = 'a'
		case r == 'с': // Cyrillic es, which looks like c
			r = 'c'
		case r == 'е': // Cyrillic ie, which looks like e
			r = 'e'
		}
		if ('0' <= r && r <= '9') || ('a' <= r && r <= 'f') || ('A' <= r && r <= 'F') {
			if run++; run >= 32 {
				return true
			}
		} else {
			run = 0
		}
	}
	return false
}

// Resolve converts a code phrase or URL to a room UUID.
//   - "olive-tiger-castle"              → calls GET /api/code/olive-tiger-castle
//   - "https://floe.one/#room=uuid"     → extracts the room from the URL fragment
//   - "https://floe.one/?room=uuid"     → extracts the room query parameter
//   - "floe.one/#room=uuid"             → the same, read as https (no code has a / or #)
//   - "https://floe.one/r/<id>#uuid"    → ErrRequestLink, a browser-only link
//   - "https://floe.one/d/<id>"         → ErrDropLink, the same for a drop link
//   - anything else not shaped like a code → the fixed "invalid URL", no request
//
// A request link is recognized before any network call in every shape it can
// be pasted in (FT-LINK-ECHO-F2): without its scheme, inside angle brackets or
// quotes, with a link id a character short or long, or with an extra path
// segment. A paste without its scheme used to go to GET /api/code as a code,
// which sent the room id and the link id to the server, and the other shapes
// came back in an error that quoted them. Only a code-shaped input is ever
// looked up, so a room id pasted alone, a room link that lost its slash or a
// percent-encoded link never reaches the server either.
func Resolve(serverURL, input string) (string, error) {
	input = unwrapPaste(strings.TrimSpace(input))

	// Every server code is lowercase words joined by hyphens (generateCode in
	// server/server.js, over words.json), so an input with a slash or a hash
	// is a link that lost its scheme, never a code. Read as https, it takes
	// the URL branch below and never reaches the code lookup at the end.
	if !strings.Contains(input, "://") && strings.ContainsAny(input, "/#") {
		input = "https://" + input
	}

	// A URL: the room id comes out of it here, with no network call.
	if strings.Contains(input, "://") {
		u, err := url.Parse(input)
		if err != nil {
			return "", errInvalidURL
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
		// A fragment that is a bare room id is a request link whatever its
		// path says (a link id a character short, an extra segment): that is
		// the request link's own shape (ParseRequestLink), and a room link
		// always spells its fragment #room=, so no room link can match.
		if uuidShape.MatchString(u.Fragment) {
			return "", ErrRequestLink
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
	// expired". Then send it only if it is shaped like a code (review round 1
	// of FT-LINK-ECHO-F2): a paste with neither a slash nor a hash can still
	// be a room id, a room link that lost its punctuation or a percent-encoded
	// request link, and each of those used to reach the server in the path;
	// so can a room id in fullwidth or lookalike letters or without its
	// hyphens (the increment's review, E3).
	code := strings.ToLower(input)
	if !codeShape.MatchString(code) || holdsRoomID(code) {
		return "", errInvalidURL
	}
	resp, err := client.Get(serverURL + "/api/code/" + url.PathEscape(code))
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

// unwrapPaste strips one pair of angle brackets or quotes from around a paste,
// and the space just inside it: a mail client or a chat app hands a link over
// as <link>, and a link copied out of a document or a config file can carry
// its quotes.
func unwrapPaste(s string) string {
	if len(s) < 2 {
		return s
	}
	switch first, last := s[0], s[len(s)-1]; {
	case first == '<' && last == '>', first == '"' && last == '"', first == '\'' && last == '\'':
		return strings.TrimSpace(s[1 : len(s)-1])
	}
	return s
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
