package code

// The link key in a link, and what a parser does when it is damaged. A caller can
// never keep the old shape and drop the key by accident: ResolveLink replaced
// Resolve and ParseRequestLink returns a struct, so the key is one field away (DV4).

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jannskiee/floe/cli/engine/linkkey"
)

const (
	shapeRoom = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	shapeKey  = "AAECAwQFBgcICQoLDA0ODw"
	shapeID   = "Xk3p9Q0aB1c"
)

type linkShape struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Input   string `json:"input"`
	Outcome string `json:"outcome"`
	Room    string `json:"room"`
	Key     string `json:"key"`
	LinkID  string `json:"linkId"`
	// A recorded difference from the browser parser, which the TypeScript tests
	// read. Go holds Outcome and Room.
	TSOutcome string `json:"tsOutcome"`
	TSRoom    string `json:"tsRoom"`
	Finding   string `json:"finding"`
}

func loadLinkShapes(t *testing.T) []linkShape {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "link-shapes.json"))
	if err != nil {
		t.Fatalf("read the vector file: %v", err)
	}
	var file struct {
		Rows []linkShape `json:"rows"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parse the vector file: %v", err)
	}
	return file.Rows
}

func keyText(has bool, key linkkey.Key) string {
	if !has {
		return ""
	}
	return key.Encode()
}

// TestLinkShapes runs every row through the parser its kind names. The file is what
// keeps this parser and the browser's giving one answer; every row that differs names
// a finding, and no keyed row may have the browser join where Go refuses.
func TestLinkShapes(t *testing.T) {
	rows := loadLinkShapes(t)
	if len(rows) < 30 {
		t.Fatalf("the file has %d rows", len(rows))
	}
	seen := map[string]bool{}
	for _, row := range rows {
		t.Run(row.Kind+"/"+row.Name, func(t *testing.T) {
			if seen[row.Kind+row.Name] {
				t.Fatal("a second row with this name")
			}
			seen[row.Kind+row.Name] = true
			if (row.TSOutcome != "" || row.TSRoom != "") && row.Finding == "" {
				t.Fatal("a recorded difference needs its finding")
			}
			if row.Outcome != "ok" && (row.Room != "" || row.Key != "") {
				t.Fatal("a row that is not whole names a room or a key")
			}
			if row.Key != "" && row.TSOutcome != "" && row.TSOutcome != "incomplete" {
				t.Fatal("a whole keyed link the browser reads as anything but incomplete")
			}
			var got, room, key, id string
			switch row.Kind {
			case "share":
				link, err := ResolveLink("", row.Input)
				switch {
				case err == nil:
					got, room, key = "ok", link.RoomID, keyText(link.HasKey, link.Key)
				case errors.Is(err, ErrIncompleteLink) || errors.Is(err, errInvalidURL):
					got = "incomplete"
				case strings.Contains(err.Error(), "does not contain a room id"):
					got = "none"
				default:
					t.Fatalf("an answer the file cannot name: %v", err)
				}
			case "request":
				link, err := ParseRequestLink(row.Input)
				if err == nil {
					got, id, room, key = "ok", link.LinkID, link.RoomID, keyText(link.HasKey, link.Key)
				} else {
					got = "incomplete"
					if !errors.Is(err, errNotRequestLink) && !errors.Is(err, errRequestLinkRoom) && !errors.Is(err, errRequestLinkKey) {
						t.Fatalf("an answer the file cannot name: %v", err)
					}
				}
			default:
				t.Fatalf("no parser for kind %q", row.Kind)
			}
			if got != row.Outcome || room != row.Room || key != row.Key || id != row.LinkID {
				t.Fatalf("got %s room %q key %q id %q; the row says %s room %q key %q id %q",
					got, room, key, id, row.Outcome, row.Room, row.Key, row.LinkID)
			}
		})
	}
}

// B10: a fragment that is a room id, with or without a key behind its dot, is a
// request link whatever its path says. Before the wider rule a #<uuid>.<k> fell to
// "URL does not contain a room id", the CLI quoted it, and the key went with it.
func TestResolveKeyedRequestFragmentIsARequestLink(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	for _, input := range []string{
		"https://floe.one/r/" + shapeID + "#" + shapeRoom + "." + shapeKey,
		"https://floe.one/r/" + shapeID[:10] + "#" + shapeRoom + "." + shapeKey,
		"https://floe.one/r/" + shapeID + "/x#" + shapeRoom + "." + shapeKey,
		"https://floe.one/#" + shapeRoom + "." + shapeKey,
		"https://floe.one/#" + strings.ToUpper(shapeRoom) + "." + shapeKey,
		"https://floe.one/#" + shapeRoom + ".",
		"https://floe.one/#" + shapeRoom + ".cutshort",
		"floe.one/#" + shapeRoom + "." + shapeKey,
		"#" + shapeRoom + "." + shapeKey,
		"<https://floe.one/r/" + shapeID + "#" + shapeRoom + "." + shapeKey + ">",
	} {
		link, err := ResolveLink(srv.URL, input)
		if !errors.Is(err, ErrRequestLink) {
			t.Errorf("ResolveLink(%q) = %v, want ErrRequestLink", input, err)
		}
		if link != (ResolvedLink{}) {
			t.Errorf("ResolveLink(%q) returned a link beside its refusal", input)
		}
		if err != nil && strings.Contains(err.Error(), shapeKey) {
			t.Errorf("the error quotes the key: %q", err)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests reached the server, want 0", n)
	}
}

// A fragment with k needs exactly one valid key and a valid fragment room, and
// anything else is the one fixed sentinel with nothing returned, so no caller can
// take the room and drop the key. Nothing here reaches any server.
func TestResolveKeyedLinkIsWholeOrIncomplete(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()

	link, err := ResolveLink(srv.URL, "  https://floe.one/#k="+shapeKey+"&room="+shapeRoom+"\n")
	if err != nil || link.RoomID != shapeRoom || !link.HasKey || link.Key.Encode() != shapeKey {
		t.Fatalf("a whole link: %v, room %q, has key %v", err, link.RoomID, link.HasKey)
	}
	if link, err := ResolveLink(srv.URL, "floe.one/#k="+shapeKey+"&room="+shapeRoom); err != nil || !link.HasKey {
		t.Fatalf("a link without its scheme: %v, has key %v", err, link.HasKey)
	}
	if link, err := ResolveLink(srv.URL, "<https://floe.one/#k="+shapeKey+"&room="+shapeRoom+">"); err != nil || !link.HasKey {
		t.Fatalf("a link in angle brackets: %v, has key %v", err, link.HasKey)
	}
	if link, err := ResolveLink(srv.URL, "https://floe.one/#room="+shapeRoom); err != nil || link.HasKey || link.Key != (linkkey.Key{}) {
		t.Fatalf("a keyless link: %v, has key %v", err, link.HasKey)
	}

	for _, frag := range []string{
		"k=" + shapeKey,
		"k=" + shapeKey[:10],
		"k=" + shapeKey + "&",
		"k=" + shapeKey + "&room=",
		"k=" + shapeKey + "&room=" + shapeRoom[:13],
		"k=" + shapeKey + "&room=" + shapeRoom + "x",
		"k=&room=" + shapeRoom,
		"k&room=" + shapeRoom,
		"k=" + shapeKey[:21] + "x&room=" + shapeRoom,
		"k=" + shapeKey + "A&room=" + shapeRoom,
		"k=" + shapeKey + "&k=" + shapeKey + "&room=" + shapeRoom,
		"k=" + shapeKey + "&room=" + shapeRoom + "&room=" + shapeRoom,
		"k=" + shapeKey + "&k=&room=" + shapeRoom,
		"k=" + shapeKey + "&amp;room=" + shapeRoom,
		"k=" + shapeKey + ";room=" + shapeRoom,
		"room=" + shapeRoom + ";k=" + shapeKey,
		"k%3D" + shapeKey + "%26room%3D" + shapeRoom,
	} {
		for _, input := range []string{"https://floe.one/#" + frag, "https://floe.one/?s=deadbeef#" + frag, "floe.one/#" + frag, "https://floe.one/?room=" + shapeRoom + "#" + frag} {
			link, err := ResolveLink(srv.URL, input)
			if !errors.Is(err, ErrIncompleteLink) {
				t.Errorf("ResolveLink(%q) = %q, has key %v, %v; want ErrIncompleteLink", input, link.RoomID, link.HasKey, err)
			}
			if link != (ResolvedLink{}) {
				t.Errorf("ResolveLink(%q) returned a link beside its refusal", input)
			}
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests reached the server, want 0", n)
	}
}

// A key pasted alone (a double click in a terminal selects exactly it) is shaped
// like a code often enough that it would go to the code API, which is the one place
// it must never go. It is refused here unless it could be a code a person typed.
func TestResolveNeverLooksUpAKeyAlone(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"roomId":"room-1"}`))
	}))
	defer srv.Close()
	for _, key := range []string{shapeKey, "aBcDeFgHiJkLmNoPqRsTuA", "aB-cD-eF-gH1jKlMnOpQrw", "Ab_cDeFgHiJkLmNoPqRsTg"} {
		if _, err := linkkey.Parse(key); err != nil {
			t.Fatalf("%q is no key: %v", key, err)
		}
		hits.Store(0)
		if _, err := ResolveLink(srv.URL, key); !errors.Is(err, errNotACode) {
			t.Errorf("a key alone answered %v, want errNotACode", err)
		}
		if n := hits.Load(); n != 0 {
			t.Errorf("a key alone reached the code API: %d requests", n)
		}
		if !HoldsLinkKey(key) || !HoldsLinkKey("see "+key+".") {
			t.Errorf("HoldsLinkKey misses %q", key)
		}
	}
	// A key cut or overlong, pasted alone: it parses as no key, and it is no code either,
	// since no phone's autocapitalize puts a capital inside a word. It used to go to the
	// server lowercased and come back quoted in the 404 (review 25 F5).
	for _, damaged := range []string{
		"AbCdEfGhIjKlMnOpQrStU",   // 21 characters
		"AbCdEfGhIjKlMnOpQrStUvw", // 23
		"AbCdEfGhIjKlMnOp",        // 16
		"AbCdEfGhIjKlMnOpQrSt",    // 20
		"AbCd-EfGh",               // a piece between hyphens
		"olive-tiGer-castle",      // a code with a capital inside a word
		"a1B",
	} {
		if _, err := linkkey.Parse(damaged); err == nil {
			t.Fatalf("%q is a whole key, so this row proves nothing", damaged)
		}
		hits.Store(0)
		if _, err := ResolveLink(srv.URL, damaged); !errors.Is(err, errNotACode) {
			t.Errorf("%q answered %v, want errNotACode", damaged, err)
		}
		if n := hits.Load(); n != 0 {
			t.Errorf("%q reached the code API: %d requests", damaged, n)
		}
	}
	// Twenty-two characters of plain words is still a code, in the capitals a phone
	// types too, and it ends in a letter a key can end in.
	for _, code := range []string{"olive-tiger-castle-dog", "Olive-Tiger-Castle-Dog"} {
		if _, err := linkkey.Parse(code); err != nil {
			t.Fatalf("%q is not key-shaped, so this row proves nothing: %v", code, err)
		}
		hits.Store(0)
		if got, err := resolveRoom(srv.URL, code); err != nil || got != "room-1" {
			t.Errorf("the code %q answered %q, %v", code, got, err)
		}
		if n := hits.Load(); n != 1 {
			t.Errorf("the code %q made %d requests, want 1", code, n)
		}
		if HoldsLinkKey(code) {
			t.Errorf("HoldsLinkKey takes the code %q for a key", code)
		}
	}
	for _, s := range []string{"", "olive-tiger-castle", "notes.txt", shapeKey[:21], shapeKey + "A", shapeKey[:21] + "x"} {
		if HoldsLinkKey(s) {
			t.Errorf("HoldsLinkKey(%q) = true", s)
		}
	}
}

// No error from either parser ever quotes the input, whole or in part, whichever way
// it was damaged, and a printed link shows no key.
func TestLinkParsersNeverPrintTheKey(t *testing.T) {
	inputs := []string{
		"https://floe.one/#k=" + shapeKey,
		"https://floe.one/#k=" + shapeKey + "&room=" + shapeRoom[:13],
		"https://floe.one/#k=" + shapeKey + "%zz",
		"https://floe.one/r/" + shapeID + "#" + shapeRoom + "." + shapeKey + "x",
		"https://floe.one/r/" + shapeID + "#" + shapeRoom + "." + shapeKey + "%zz",
		"floe.one/#." + shapeKey,
		"https://floe.one/#x=" + shapeKey,
		"k=" + shapeKey,
		"k=" + shapeKey + "&room=",
	}
	for _, input := range inputs {
		if _, err := ResolveLink("http://code.invalid", input); err != nil && strings.Contains(err.Error(), shapeKey) {
			t.Errorf("ResolveLink's error quotes the key: %q", err)
		}
		if _, err := ParseRequestLink(input); err != nil && strings.Contains(err.Error(), shapeKey) {
			t.Errorf("ParseRequestLink's error quotes the key: %q", err)
		}
	}
	share, err := ResolveLink("", "https://floe.one/#k="+shapeKey+"&room="+shapeRoom)
	if err != nil {
		t.Fatal(err)
	}
	request, err := ParseRequestLink("https://floe.one/r/" + shapeID + "#" + shapeRoom + "." + shapeKey)
	if err != nil {
		t.Fatal(err)
	}
	if !request.HasKey {
		t.Fatal("no key in a keyed request link")
	}
	for _, v := range []any{share, request} {
		for _, verb := range []string{"%v", "%+v", "%#v"} {
			if got := fmt.Sprintf(verb, v); strings.Contains(got, shapeKey) {
				t.Errorf("Sprintf(%q, %T) shows the key: %s", verb, v, got)
			}
		}
		if b, err := json.Marshal(v); err == nil && strings.Contains(string(b), shapeKey) {
			t.Errorf("json.Marshal(%T) shows the key: %s", v, b)
		}
	}
}
