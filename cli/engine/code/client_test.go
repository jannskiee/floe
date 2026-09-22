package code

import (
	"errors"
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

// A link that belongs in a web browser gets a sentinel, before the room-id
// lookup, so a caller can print the one approved sentence instead of the raw
// "URL does not contain a room id" text, which says nothing a person could
// act on. The match is on the PATH, so a self-hosted base path is recognized
// by its suffix (E-10). errors.Is throughout, never a text compare: the two
// sentinels deliberately carry the same sentence.
func TestResolveRequestLinkTyped(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cases := []struct {
		name  string
		input string
		want  error // nil: not a browser-only link, so today's error still stands
	}{
		{"request link", "https://floe.one/r/Xk3p9Q0aB1c#" + room, ErrRequestLink},
		{"request link with a trailing slash", "https://floe.one/r/Xk3p9Q0aB1c/#" + room, ErrRequestLink},
		{"request link on a self-hosted base path", "https://files.example.com/floe/r/Xk3p9Q0aB1c#" + room, ErrRequestLink},
		{"request link with no fragment", "https://floe.one/r/Xk3p9Q0aB1c", ErrRequestLink},
		{"drop link", "https://floe.one/d/aBcD1234#k=s3cr3t.1764950400", ErrDropLink},
		{"legacy drop link", "https://floe.one/drop/aBcD1234", ErrDropLink},
		{"legacy drop link with a trailing slash", "https://floe.one/drop/aBcD1234/", ErrDropLink},
		{"a ten character link id is not a request link", "https://floe.one/r/Xk3p9Q0aB#" + room, nil},
		{"a twelve character link id is not a request link", "https://floe.one/r/Xk3p9Q0aB1cD#" + room, nil},
		{"the download page is not a drop link", "https://floe.one/download", nil},
		{"a docs page is not a drop link", "https://floe.one/docs/quickstart", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Resolve("", tc.input)
			if err == nil {
				t.Fatal("Resolve returned no error")
			}
			if tc.want != nil {
				if !errors.Is(err, tc.want) {
					t.Fatalf("Resolve returned %v, want the matching sentinel", err)
				}
				return
			}
			if errors.Is(err, ErrRequestLink) || errors.Is(err, ErrDropLink) {
				t.Fatal("Resolve returned a browser-link sentinel for a URL that is not one")
			}
			if !strings.Contains(err.Error(), "does not contain a room id") {
				t.Fatalf("expected the existing room-id error, got: %v", err)
			}
		})
	}

	// The path checks live inside the URL branch, so a typed code must still
	// reach the API untouched.
	t.Run("a word code still reaches the API", func(t *testing.T) {
		var got string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got = strings.TrimPrefix(r.URL.Path, "/api/code/")
			_, _ = w.Write([]byte(`{"roomId":"room-1"}`))
		}))
		defer srv.Close()

		roomID, err := Resolve(srv.URL, "olive-tiger-castle")
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if roomID != "room-1" || got != "olive-tiger-castle" {
			t.Fatalf("roomId = %q and the server saw %q", roomID, got)
		}
	})
}

// ParseRequestLink is a local shape check: no network call, and no part of the
// input inside any error it returns.
func TestParseRequestLink(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	const upper = "6F1C2B9E-4A5D-4C3B-9F7E-2D1A0B9C8E7F"
	const id = "Xk3p9Q0aB1c"
	cases := []struct {
		name     string
		input    string
		wantLink string
		wantRoom string // both empty: the call must fail
	}{
		{"valid", "https://floe.one/r/" + id + "#" + room, id, room},
		{"trailing slash", "https://floe.one/r/" + id + "/#" + room, id, room},
		{"self-hosted base path", "https://files.example.com/floe/r/" + id + "#" + room, id, room},
		{"a query string present", "https://floe.one/r/" + id + "?s=deadbeef#" + room, id, room},
		{"surrounding whitespace", "  https://floe.one/r/" + id + "#" + room + "\n", id, room},
		{"an uppercase room id is not folded", "https://floe.one/r/" + id + "#" + upper, id, upper},
		{"missing fragment", "https://floe.one/r/" + id, "", ""},
		{"bad uuid", "https://floe.one/r/" + id + "#not-a-uuid", "", ""},
		{"a room= fragment is a room link, not a request link", "https://floe.one/r/" + id + "#room=" + room, "", ""},
		{"bad link id", "https://floe.one/r/Xk3p9Q0aB#" + room, "", ""},
		{"a room link", "https://floe.one/#room=" + room, "", ""},
		{"a word code", "olive-tiger-castle", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			linkID, roomID, err := ParseRequestLink(tc.input)
			if tc.wantRoom == "" {
				if err == nil {
					t.Fatalf("ParseRequestLink accepted it and returned %q, %q", linkID, roomID)
				}
				if strings.Contains(err.Error(), id) || strings.Contains(err.Error(), room) {
					t.Fatalf("the error echoes part of the link: %v", err)
				}
				if linkID != "" || roomID != "" {
					t.Fatalf("a failed parse returned %q, %q; want both empty", linkID, roomID)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseRequestLink: %v", err)
			}
			if linkID != tc.wantLink {
				t.Fatalf("linkID = %q, want %q", linkID, tc.wantLink)
			}
			if roomID != tc.wantRoom {
				t.Fatalf("roomID = %q, want %q", roomID, tc.wantRoom)
			}
		})
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
