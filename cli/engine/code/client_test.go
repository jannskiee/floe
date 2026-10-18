package code

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
)

// Resolve must accept both the new fragment links (#room=) and the older query
// links (?room=) so that a link from either the browser or the CLI works in
// `floe receive`. The URL branch parses locally and never touches the network.
func TestResolveURL(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"fragment", "https://floe.one/#room=" + room, room},
		{"query", "https://floe.one/?room=" + room, room},
		{"query without slash", "https://floe.one?room=" + room, room},
		// The browser and the desktop app pair the fragment with a meaningless
		// ?s= cache-buster; the query lookup must miss it and fall through.
		{"fragment with nonce", "https://floe.one/?s=deadbeef#room=" + room, room},
		{"local fragment", "http://localhost:3000/#room=" + room, room},
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

// TestLinkHostReadsALinkAsResolveDoes (FU-53): for every shape Resolve takes
// a room id from, LinkHost names the host of that same link, as written (the
// caller folds case and the trailing dot), so a caller can check where the
// room lives before it uses the id. A code, and anything Resolve does not read
// as a link, has no host.
func TestLinkHostReadsALinkAsResolveDoes(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	for _, c := range []struct{ input, host string }{
		{"https://floe.one/#room=" + room, "floe.one"},
		{"https://floe.one/?room=" + room, "floe.one"},
		{"  https://www.floe.one/#room=" + room + "  ", "www.floe.one"},
		{"floe.one/#room=" + room, "floe.one"},
		{"floe.one:443/#room=" + room, "floe.one"},
		{"<https://floe.one/#room=" + room + ">", "floe.one"},
		{`"https://floe.one/?room=` + room + `"`, "floe.one"},
		{"'floe.one/#room=" + room + "'", "floe.one"},
		{"https://FLOE.ONE.:443/#room=" + room, "FLOE.ONE."},
		{"https://ｆｌｏｅ.one/#room=" + room, "ｆｌｏｅ.one"},
		{"http://localhost:3000/#room=" + room, "localhost"},
		// FU-53 review 1 L-1: slashes a browser reads past and url.Parse does
		// not. Resolve takes the room id out of each with no host, so LinkHost
		// names the host the text names.
		{"//floe.one/#room=" + room, "floe.one"},
		{"https:///floe.one/#room=" + room, "floe.one"},
		{"https:/floe.one/#room=" + room, "floe.one"},
		{"/floe.one/#room=" + room, "floe.one"},
	} {
		got, err := Resolve("", c.input)
		if err != nil || got != room {
			t.Fatalf("Resolve(%q) = %q, %v; want the room id", c.input, got, err)
		}
		if h := LinkHost(c.input); h != c.host {
			t.Errorf("LinkHost(%q) = %q, want %q", c.input, h, c.host)
		}
	}
	for _, s := range []string{"", "olive-tiger-castle", "Olive-Tiger-Castle", "floe.one", room} {
		if h := LinkHost(s); h != "" {
			t.Errorf("LinkHost(%q) = %q, want no host", s, h)
		}
	}
}

func TestResolveURLWithoutRoom(t *testing.T) {
	if _, err := Resolve("", "https://floe.one/about"); err == nil {
		t.Fatal("expected an error for a URL with no room id, got nil")
	}
}

// TestResolveRefusesARoomValueThatIsNotARoomID (A4-B27): a #room= or ?room=
// value that is not a room id (a link cut short, a typo in it) is refused
// here with fixed text, before any network call. It used to be handed to the
// server, whose join answered "Invalid room ID", a line with no advice.
func TestResolveRefusesARoomValueThatIsNotARoomID(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	for _, input := range []string{
		"https://floe.one/#room=" + room[:13],
		"https://floe.one/#room=" + room[:35],
		"https://floe.one/?room=" + room[:20],
		"https://floe.one/#room=" + room + "x",
		"https://floe.one/#room=" + strings.Replace(room, "-", "", 1),
		"https://floe.one/#room=abc-123",
		"floe.one/#room=" + room[:13],
		"http://localhost:3000/#room=6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7g",
	} {
		roomID, err := Resolve(srv.URL, input)
		if err == nil || roomID != "" {
			t.Errorf("Resolve(%q) = %q, %v; want the incomplete-link refusal", input, roomID, err)
			continue
		}
		if err.Error() != "the room id in this link is incomplete or mistyped" {
			t.Errorf("Resolve(%q) answered %q, want the fixed incomplete-link text", input, err)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests reached the server, want 0", n)
	}
	// Any letter case still resolves: the server's UUID_REGEX takes it.
	if got, err := Resolve(srv.URL, "https://floe.one/#room="+strings.ToUpper(room)); err != nil || got != strings.ToUpper(room) {
		t.Fatalf("an upper-case room id: %q, %v", got, err)
	}
}

// TestResolveAnswersAMistypedCodeAsACode (A8b-B4): an input with no slash, no
// hash and no scheme is where a code goes, so one that is not shaped like a
// code (an underscore, a space, a room id pasted alone) is answered as a code
// that was not recognized, with fixed text that names what a code looks
// like and quotes nothing. It used to be answered "invalid URL", which sent
// someone who typed a code to look for a link.
func TestResolveAnswersAMistypedCodeAsACode(t *testing.T) {
	const want = "code not recognized: a code is words joined by hyphens, like olive-tiger-castle"
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	for _, input := range []string{
		"olive_tiger_castle",
		"olive tiger castle",
		"olive--tiger",
		"-olive-tiger",
		"6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	} {
		_, err := Resolve(srv.URL, input)
		if err == nil || err.Error() != want {
			t.Errorf("Resolve(%q) = %v, want %q", input, err, want)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests reached the code API, want 0", n)
	}
	// A paste that is a link and does not parse is still a URL problem.
	if _, err := Resolve(srv.URL, "https://floe.one:port/#room=6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"); err == nil || err.Error() != "invalid URL" {
		t.Fatalf("a link that does not parse answered %v, want \"invalid URL\"", err)
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

// TestCodeAPIBodiesAreBounded: Register and Resolve read at most 64 KiB of an
// /api/code answer, and one that does not end within them ends on the fixed
// "invalid response from code API". A JSON decoder holds a whole value before
// it unmarshals, so the unbounded read handed back a code or a room id as long
// as the server sent. The transport is in memory: no port.
func TestCodeAPIBodiesAreBounded(t *testing.T) {
	const bound = 64 << 10
	huge := strings.Repeat("a", 1<<20)
	var read atomic.Int64
	orig := client
	t.Cleanup(func() { client = orig })
	client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		key := "code"
		if r.Method == http.MethodGet {
			key = "roomId"
		}
		body := &countingBody{r: strings.NewReader(`{"` + key + `":"` + huge + `"}`), n: &read}
		return &http.Response{StatusCode: http.StatusOK, Body: body, Request: r}, nil
	})}

	if code, err := Register("http://code.invalid", "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"); err == nil || err.Error() != "invalid response from code API" {
		t.Fatalf("Register answered a %d-byte code and %v, want \"invalid response from code API\"", len(code), err)
	}
	if n := read.Swap(0); n > bound {
		t.Fatalf("Register read %d bytes of the answer, want at most %d", n, bound)
	}
	if room, err := Resolve("http://code.invalid", "olive-tiger-castle"); err == nil || err.Error() != "invalid response from code API" {
		t.Fatalf("Resolve answered a %d-byte room id and %v, want \"invalid response from code API\"", len(room), err)
	}
	if n := read.Load(); n > bound {
		t.Fatalf("Resolve read %d bytes of the answer, want at most %d", n, bound)
	}
}

// countingBody is a response body that counts the bytes it hands out.
type countingBody struct {
	r io.Reader
	n *atomic.Int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	b.n.Add(int64(n))
	return n, err
}

func (b *countingBody) Close() error { return nil }

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
		// Flipped on purpose by FT-LINK-ECHO-F2: these two used to be "not a
		// request link" and came back as "does not contain a room id", which
		// the CLI quoted with the room id in it. A fragment that is a bare
		// room id is the request link's own shape whatever the path says, and
		// no room link has one (it says #room=).
		{"a ten character link id with a bare room id is a request link", "https://floe.one/r/Xk3p9Q0aB#" + room, ErrRequestLink},
		{"a twelve character link id with a bare room id is a request link", "https://floe.one/r/Xk3p9Q0aB1cD#" + room, ErrRequestLink},
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

// anyUUID finds a UUID anywhere in a string, in either case.
var anyUUID = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// The disguises of a room id that rev-eng-b's E3 probe found passing the gate:
// the test room id's hyphens removed, the Cyrillic letters that look like a, c
// and e, fullwidth forms, and combining marks sprinkled in.
var (
	bareRoom    = strings.ReplaceAll("6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f", "-", "")
	cyrillicACE = strings.NewReplacer("a", "а", "c", "с", "e", "е")
)

// fullwidth writes the digits, the letters a to f, or both, of s in their
// fullwidth forms (U+FF10 to U+FF19 and U+FF41 to U+FF46), as an East Asian
// input method types them.
func fullwidth(s string, digits, letters bool) string {
	return strings.Map(func(r rune) rune {
		if (digits && r >= '0' && r <= '9') || (letters && r >= 'a' && r <= 'f') {
			return r + 0xFEE0
		}
		return r
	}, s)
}

// withMarks puts a combining acute accent after every fourth character of s.
func withMarks(s string) string {
	var b strings.Builder
	for i, r := range []rune(s) {
		b.WriteRune(r)
		if i%4 == 3 {
			b.WriteRune('́')
		}
	}
	return b.String()
}

// FT-LINK-ECHO-F2: a request link is recognized before any network call in
// every shape the review's matrix pasted (FT-LINK-ECHO review 1, X1 to X4).
// Without its scheme it used to go to GET /api/code as a code, which sent the
// room id and the link id to the server; the other three came back in an
// error the CLI quoted, room id included. Every server code is lowercase
// words joined by hyphens, so an input with a slash or a hash is a link and
// never a lookup. The server here counts every request it gets.
func TestResolveNeverSendsALinkToTheCodeAPI(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	const id = "Xk3p9Q0aB1c"
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"roomId":"room-1"}`))
	}))
	defer srv.Close()

	links := []struct{ name, input string }{
		{"X1 a link without its scheme", "floe.one/r/" + id + "#" + room},
		{"X2 a link id one character short", "https://floe.one/r/" + id[:10] + "#" + room},
		{"X3 a link in angle brackets", "<https://floe.one/r/" + id + "#" + room + ">"},
		{"X4 an extra path segment", "https://floe.one/r/" + id + "/x#" + room},
	}
	for _, tc := range links {
		t.Run(tc.name, func(t *testing.T) {
			hits.Store(0)
			roomID, err := Resolve(srv.URL, tc.input)
			if n := hits.Load(); n != 0 {
				t.Errorf("%d requests reached the code API, want 0", n)
			}
			if !errors.Is(err, ErrRequestLink) {
				t.Fatalf("Resolve returned %q, %v; want ErrRequestLink", roomID, err)
			}
			if anyUUID.MatchString(err.Error()) || strings.Contains(err.Error(), id[:10]) {
				t.Fatalf("the error quotes the pasted link: %q", err.Error())
			}
		})
	}

	// The same rule resolves a room link that lost its scheme, locally.
	t.Run("a room link without its scheme resolves with no request", func(t *testing.T) {
		hits.Store(0)
		roomID, err := Resolve(srv.URL, "floe.one/#room="+room)
		if err != nil || roomID != room {
			t.Fatalf("Resolve returned %q, %v; want the room id", roomID, err)
		}
		if n := hits.Load(); n != 0 {
			t.Fatalf("%d requests reached the code API, want 0", n)
		}
	})

	// Review round 1 (rev-eng-a L1, rev-eng-b E1): pastes with neither a slash
	// nor a hash went to the code API too, several with the room id or the
	// link id in the path. Only a code-shaped input is looked up now; these
	// are refused here with fixed text: errNotACode since A8b-B4, the
	// "invalid URL" before it.
	pastes := []struct{ name, input string }{
		{"a room id alone", room},
		{"a room id in angle brackets", "<" + room + ">"},
		{"room= and a room id", "room=" + room},
		{"?room= and a room id", "?room=" + room},
		{"a room link with neither a slash nor a hash", "floe.one?room=" + room},
		{"a link id, %23 and a room id", id + "%23" + room},
		{"a whole request link percent-encoded", "https%3A%2F%2Ffloe.one%2Fr%2F" + id + "%23" + room},
		{"a link id and a room id with a space", id + " " + room},
		// The increment's review (rev-eng-b E3): a room id in disguise, which
		// the ASCII check let through. Five groups, a 32-character word or 32
		// hex digits once fullwidth, Cyrillic and hyphens are set aside.
		{"a room id in fullwidth digits", fullwidth(room, true, false)},
		{"a room id in fullwidth letters", fullwidth(room, false, true)},
		{"a room id in fullwidth digits and letters", fullwidth(room, true, true)},
		{"a room id with Cyrillic a, c and e", cyrillicACE.Replace(room)},
		{"a room id with its hyphens removed", bareRoom},
		{"a room id with its hyphens removed, in fullwidth", fullwidth(bareRoom, true, true)},
		{"a room id with its hyphens moved", bareRoom[:16] + "-" + bareRoom[16:]},
		{"a room id with its hyphens removed and combining marks inside", withMarks(bareRoom)},
		{"a word of 25 characters", "olive-" + strings.Repeat("x", 25)},
	}
	for _, tc := range pastes {
		t.Run(tc.name, func(t *testing.T) {
			hits.Store(0)
			roomID, err := Resolve(srv.URL, tc.input)
			if n := hits.Load(); n != 0 {
				t.Errorf("%d requests reached the code API, want 0", n)
			}
			if !errors.Is(err, errNotACode) {
				t.Fatalf("Resolve returned %q, %v; want the fixed errNotACode", roomID, err)
			}
			if anyUUID.MatchString(err.Error()) || strings.Contains(strings.ToLower(err.Error()), strings.ToLower(id)) {
				t.Fatalf("the error quotes the paste: %q", err.Error())
			}
		})
	}

	t.Run("a word code makes exactly one request", func(t *testing.T) {
		hits.Store(0)
		roomID, err := Resolve(srv.URL, "olive-tiger-castle")
		if err != nil || roomID != "room-1" {
			t.Fatalf("Resolve returned %q, %v; want room-1", roomID, err)
		}
		if n := hits.Load(); n != 1 {
			t.Fatalf("%d requests reached the code API, want exactly 1", n)
		}
	})

	// A code still reaches the API, once, in every form a word list can give
	// it: typed with capitals (folded before the lookup), and with a digit or
	// a letter outside ASCII in a word, which a self-hosted words.json may hold.
	codes := []struct{ name, input string }{
		{"a code typed with capitals makes exactly one request", "Olive-Tiger-Castle"},
		{"a code with a digit in a word makes exactly one request", "olive-tiger-2nd"},
		{"a code with a letter outside ASCII makes exactly one request", "grün-tiger-castle"},
		// The longest a generated code gets (four words, after ten collisions),
		// and the longest word the gate allows (the shipped list's is five).
		{"a four-word code makes exactly one request", "olive-tiger-castle-panda"},
		{"a code with a word of 24 characters makes exactly one request", "olive-tiger-" + strings.Repeat("x", 24)},
		// N3: words that need combining marks, from a self-hosted words.json.
		{"a code with a decomposed accent makes exactly one request", "grün-tiger-castle"},
		{"a code in a script with combining marks makes exactly one request", "नमस्ते-घर"},
	}
	for _, tc := range codes {
		t.Run(tc.name, func(t *testing.T) {
			hits.Store(0)
			roomID, err := Resolve(srv.URL, tc.input)
			if err != nil || roomID != "room-1" {
				t.Fatalf("Resolve returned %q, %v; want room-1", roomID, err)
			}
			if n := hits.Load(); n != 1 {
				t.Fatalf("%d requests reached the code API, want exactly 1", n)
			}
		})
	}
}

// An input that does not parse as a URL gets the fixed text "invalid URL"
// (D-144.7), never url.Error's copy of the input: for a bad escape in the
// fragment that copy is the whole paste, a request link's room id included,
// and the CLI prints it. Nothing reaches the code API either.
func TestResolveInvalidURLIsFixedText(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()

	for _, input := range []string{
		"https://floe.one/r/Xk3p9Q0aB1c#" + room + "%zz",
		"floe.one/r/Xk3p9Q0aB1c#" + room + "%zz",
		"https://floe.one:port/#room=" + room,
	} {
		_, err := Resolve(srv.URL, input)
		if err == nil || err.Error() != "invalid URL" {
			t.Errorf("Resolve(<a paste that does not parse>) = %v, want the fixed text \"invalid URL\"", err)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests reached the code API, want 0", n)
	}
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
