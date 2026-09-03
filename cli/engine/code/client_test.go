package code

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Resolve must accept both the new fragment links (#room=) and the older query
// links (?room=) so that a link from either the browser or the CLI works in
// `floe receive`. The URL branch parses locally and never touches the network.
func TestResolveURL(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"fragment", "https://floe.one/#room=abc-123", "abc-123"},
		{"query", "https://floe.one/?room=abc-123", "abc-123"},
		{"query without slash", "https://floe.one?room=abc-123", "abc-123"},
		// The browser and the desktop app pair the fragment with a meaningless
		// ?s= cache-buster; the query lookup must miss it and fall through.
		{"fragment with nonce", "https://floe.one/?s=deadbeef#room=abc-123", "abc-123"},
		{"local fragment", "http://localhost:3000/#room=xyz", "xyz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Resolve("", tc.input)
			if err != nil {
				t.Fatalf("Resolve(%q) returned error: %v", tc.input, err)
			}
			if got != tc.want {
				t.Fatalf("Resolve(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestResolveURLWithoutRoom(t *testing.T) {
	if _, err := Resolve("", "https://floe.one/about"); err == nil {
		t.Fatal("expected an error for a URL with no room id, got nil")
	}
}

// The server keys codeToRoom by the lowercase words in words.json and does a
// plain Map.get, and nothing on any surface folded case. A phone keyboard
// autocapitalizes the first letter of a typed code, so "Olive-Tiger-Castle"
// was a hard 404 reading "code not found or expired".
func TestResolveFoldsCaseBeforeLookup(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = strings.TrimPrefix(r.URL.Path, "/api/code/")
		_, _ = w.Write([]byte(`{"roomId":"room-1"}`))
	}))
	defer srv.Close()

	roomID, err := Resolve(srv.URL, "Olive-Tiger-Castle")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if roomID != "room-1" {
		t.Fatalf("roomId = %q, want room-1", roomID)
	}
	if got != "olive-tiger-castle" {
		t.Fatalf("server saw %q, want olive-tiger-castle", got)
	}
}

// A URL is not a code phrase: the fragment carries a room id whose case is
// significant, so the URL branch must not fold it.
func TestResolveDoesNotFoldRoomIdsInLinks(t *testing.T) {
	got, err := Resolve("", "https://floe.one/#room=6F207790-92A6-4662-BB68-4C4059F75139")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != "6F207790-92A6-4662-BB68-4C4059F75139" {
		t.Fatalf("Resolve folded a room id in a link: got %q", got)
	}
}
