package code

// FuzzParseRequestLink is the DV-FUZZ target for the one decoder this
// package owns (spec 05 8.9). ParseRequestLink is pure: no network, no disk.
// FuzzResolve holds Resolve to FT-LINK-ECHO-F2's rule with an in-memory code
// API. The seeds are added with f.Add and the same values are committed under
// testdata/fuzz/<target>/ so each corpus directory exists in git;
// FLOE_WRITE_FUZZ_SEEDS=1 go test -run '^Fuzz' . rewrites those files, and
// nothing else here writes.

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"unicode"

	"github.com/jannskiee/floe/cli/engine/linkkey"
)

var (
	fuzzLinkIDShape = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	fuzzRoomShape   = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// fuzzLookupProblem says what is wrong with a code that reached the code API,
// or "" when nothing is: it must be one to four hyphen-joined words of 1 to 24
// characters, each a letter or a digit and then letters, digits or combining
// marks, with no run of 32 hex digits anywhere once fullwidth forms and the
// Cyrillic lookalikes of a, c and e are read as ASCII and hyphens and marks
// are set aside (a room id in disguise, rev-eng-b E3). Written with the
// unicode package rather than Resolve's regexp, so the two can disagree.
func fuzzLookupProblem(code string) string {
	words := strings.Split(code, "-")
	if len(words) > 4 {
		return "five or more hyphen-joined groups, a room id's shape"
	}
	for _, w := range words {
		rs := []rune(w)
		if len(rs) == 0 || len(rs) > 24 {
			return "a word that is empty or longer than 24 characters"
		}
		for i, r := range rs {
			if unicode.IsLetter(r) || unicode.IsDigit(r) || (i > 0 && unicode.In(r, unicode.M)) {
				continue
			}
			return "a character that is not a letter, a digit or a combining mark inside a word"
		}
	}
	run := 0
	for _, r := range code {
		if r == '-' || unicode.In(r, unicode.M) {
			continue
		}
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		}
		switch r {
		case 'а':
			r = 'a'
		case 'с':
			r = 'c'
		case 'е':
			r = 'e'
		}
		if !unicode.In(r, unicode.ASCII_Hex_Digit) {
			run = 0
			continue
		}
		if run++; run >= 32 {
			return "32 hex digits in a row, a room id in disguise"
		}
	}
	return ""
}

// writeSeed writes one corpus file in the go test fuzz v1 encoding when
// FLOE_WRITE_FUZZ_SEEDS=1.
func writeSeed(f *testing.F, target, name, line string) {
	f.Helper()
	if os.Getenv("FLOE_WRITE_FUZZ_SEEDS") != "1" {
		return
	}
	dir := filepath.Join("testdata", "fuzz", target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		f.Fatalf("seed dir: %v", err)
	}
	body := "go test fuzz v1\n" + line + "\n"
	if err := os.WriteFile(filepath.Join(dir, "seed-"+name), []byte(body), 0o644); err != nil {
		f.Fatalf("seed %s: %v", name, err)
	}
}

// seedName turns a description into a file-name-safe seed name.
func seedName(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		}
		return '-'
	}, s)
}

// FuzzParseRequestLink: never panics; a nil error means the link id has the
// 11-character shape and the room id the UUID shape, and a second call
// agrees; a key that parsed is in the input as written, since a keyed fragment
// holding a % is refused; a failure returns the zero value and one of the three
// fixed sentinel errors, so no part of the input can reach a caller that prints it.
func FuzzParseRequestLink(f *testing.F) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	const id = "Xk3p9Q0aB1c"
	const key = "AAECAwQFBgcICQoLDA0ODw"
	seeds := map[string]string{
		"keyed":                      "https://floe.one/r/" + id + "#" + room + "." + key,
		"keyed, trailing slash":      "https://floe.one/r/" + id + "/#" + room + "." + key,
		"keyed, self-hosted":         "https://files.example.com/floe/r/" + id + "#" + room + "." + key,
		"keyed, uppercase room":      "https://floe.one/r/" + id + "#" + strings.ToUpper(room) + "." + key,
		"keyed, empty key":           "https://floe.one/r/" + id + "#" + room + ".",
		"keyed, short key":           "https://floe.one/r/" + id + "#" + room + "." + key[:21],
		"keyed, long key":            "https://floe.one/r/" + id + "#" + room + "." + key + "A",
		"keyed, loose last char":     "https://floe.one/r/" + id + "#" + room + "." + key[:21] + "x",
		"keyed, two dots":            "https://floe.one/r/" + id + "#" + room + "." + key + "." + key,
		"keyed, percent in the room": "https://floe.one/r/" + id + "#%36f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f." + key,
		"keyed, percent in the key":  "https://floe.one/r/" + id + "#" + room + ".%41AECAwQFBgcICQoLDA0ODw",
		"keyed, percent-encoded dot": "https://floe.one/r/" + id + "#" + room + "%2E" + key,
		"keyed, no room":             "https://floe.one/r/" + id + "#." + key,
		"keyed, key alone":           "https://floe.one/r/" + id + "#" + key,
		"share link shape":           "https://floe.one/r/" + id + "#k=" + key + "&room=" + room,
		"valid":                      "https://floe.one/r/" + id + "#" + room,
		"trailing slash":             "https://floe.one/r/" + id + "/#" + room,
		"self-hosted base path":      "https://files.example.com/floe/r/" + id + "#" + room,
		"query string":               "https://floe.one/r/" + id + "?s=deadbeef#" + room,
		"surrounding whitespace":     "  https://floe.one/r/" + id + "#" + room + "\n",
		"uppercase room":             "https://floe.one/r/" + id + "#" + strings.ToUpper(room),
		"d path with k fragment":     "https://floe.one/d/" + id + "#k=" + room,
		"drop path":                  "https://floe.one/drop/" + id + "#" + room,
		"10-character id":            "https://floe.one/r/Xk3p9Q0aB1#" + room,
		"12-character id":            "https://floe.one/r/Xk3p9Q0aB1cd#" + room,
		"room fragment":              "https://floe.one/r/" + id + "#room=" + room,
		"room query":                 "https://floe.one/r/" + id + "?room=" + room,
		"room link":                  "https://floe.one/#room=" + room,
		"word code":                  "olive-tiger-castle",
		"empty":                      "",
		"missing fragment":           "https://floe.one/r/" + id,
		"bidi override in the id":    "https://floe.one/r/Xk3p9Q0\u202eaB1c#" + room,
		"nul in the fragment":        "https://floe.one/r/" + id + "#" + room[:8] + "\x00" + room[9:],
		"percent-encoded fragment":   "https://floe.one/r/" + id + "#%36f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
		"javascript scheme":          "javascript:alert(1)//r/" + id + "#" + room,
		"ipv6 host":                  "http://[::1]:3000/r/" + id + "#" + room,
		"room with trailing garbage": "https://floe.one/r/" + id + "#" + room + "x",
		"64 KB string":               "https://floe.one/r/" + strings.Repeat("a", 64*1024),
	}
	names := make([]string, 0, len(seeds))
	for name := range seeds {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f.Add(seeds[name])
		writeSeed(f, "FuzzParseRequestLink", seedName(name), "string("+strconv.Quote(seeds[name])+")")
	}

	f.Fuzz(func(t *testing.T, input string) {
		link, err := ParseRequestLink(input)
		if err != nil {
			if !errors.Is(err, errNotRequestLink) && !errors.Is(err, errRequestLinkRoom) && !errors.Is(err, errRequestLinkKey) {
				t.Fatalf("a failure returned a non-sentinel error: %v", err)
			}
			if link != (RequestLink{}) {
				t.Fatal("a failed parse returned something; want the zero value")
			}
			return
		}
		if !fuzzLinkIDShape.MatchString(link.LinkID) {
			t.Fatalf("accepted link id %q is not 11 characters of [A-Za-z0-9_-]", link.LinkID)
		}
		if !fuzzRoomShape.MatchString(link.RoomID) {
			t.Fatalf("accepted room id %q is not UUID-shaped", link.RoomID)
		}
		// No "the input holds both values" check on a bare link: url.Parse decodes
		// percent escapes, so %36f1c... is the room id 6f1c.... A keyed one holding
		// any % is refused, so its room and its key are in the input as written.
		if link.HasKey {
			text := link.Key.Encode()
			if !strings.Contains(input, link.RoomID+"."+text) {
				t.Fatal("the key and the room that parsed are not in the input as written")
			}
			if back, err := linkkey.Parse(text); err != nil || back != link.Key {
				t.Fatalf("the key does not round-trip: %v", err)
			}
		} else if link.Key != (linkkey.Key{}) {
			t.Fatal("a link with no key returned key bytes")
		}
		if again, err2 := ParseRequestLink(input); err2 != nil || again != link {
			t.Fatalf("not deterministic: %v", err2)
		}
	})
}

// roundTripFunc is an http.RoundTripper made of a function.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// FuzzResolve (FT-LINK-ECHO-F2): ResolveLink never panics, an input with a slash
// or a hash never reaches the code API (every server code is lowercase words
// joined by hyphens, so such an input is a link, resolved or refused here),
// and whatever does reach it is shaped like a code with no room id in it, not
// even a disguised one (review round 1, and E3; see fuzzLookupProblem). A
// refusal is one of the fixed texts, so no part of the paste can reach a
// caller that prints it. A link that came back with a key holds a room id, and
// never went to the code API. The code API is a counting transport in memory, so
// the target binds nothing and reaches no server.
func FuzzResolve(f *testing.F) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	const id = "Xk3p9Q0aB1c"
	const key = "AAECAwQFBgcICQoLDA0ODw"
	var lookups atomic.Int64
	var lastPath atomic.Value // string: the path of the newest lookup
	orig := client
	client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		lastPath.Store(r.URL.Path)
		lookups.Add(1)
		return &http.Response{StatusCode: http.StatusNotFound, Body: http.NoBody, Request: r}, nil
	})}
	f.Cleanup(func() { client = orig })

	seeds := map[string]string{
		"keyed link":                 "https://floe.one/#k=" + key + "&room=" + room,
		"keyed link with a nonce":    "https://floe.one/?s=deadbeef#k=" + key + "&room=" + room,
		"keyed link, room first":     "https://floe.one/#room=" + room + "&k=" + key,
		"keyed link without scheme":  "floe.one/#k=" + key + "&room=" + room,
		"k alone":                    "https://floe.one/#k=" + key,
		"k cut short":                "https://floe.one/#k=" + key[:10],
		"k and an empty room":        "https://floe.one/#k=" + key + "&room=",
		"k and a query room":         "https://floe.one/?room=" + room + "#k=" + key,
		"two keys":                   "https://floe.one/#k=" + key + "&k=" + key + "&room=" + room,
		"two rooms":                  "https://floe.one/#k=" + key + "&room=" + room + "&room=" + room,
		"a loose last character":     "https://floe.one/#k=" + key[:21] + "x&room=" + room,
		"fragment encoded whole":     "https://floe.one/#k%3D" + key + "%26room%3D" + room,
		"a semicolon":                "https://floe.one/#k=" + key + ";room=" + room,
		"keyed request link":         "https://floe.one/r/" + id + "#" + room + "." + key,
		"keyed fragment, short id":   "https://floe.one/r/" + id[:10] + "#" + room + "." + key,
		"keyed fragment, no path":    "https://floe.one/#" + room + "." + key,
		"bare fragment with no room": "#k=" + key,
		"a key alone":                key,
		"k= alone":                   "k=" + key,
		"request link":               "https://floe.one/r/" + id + "#" + room,
		"x1 no scheme":               "floe.one/r/" + id + "#" + room,
		"x2 link id one short":       "https://floe.one/r/" + id[:10] + "#" + room,
		"x3 angle brackets":          "<https://floe.one/r/" + id + "#" + room + ">",
		"x4 extra path segment":      "https://floe.one/r/" + id + "/x#" + room,
		"quoted without a scheme":    `"floe.one/r/` + id + "#" + room + `"`,
		"room link":                  "https://floe.one/#room=" + room,
		"room link without a scheme": "floe.one/#room=" + room,
		"drop link":                  "https://floe.one/d/aBcD1234#k=s3cr3t",
		"bad escape in the fragment": "https://floe.one/r/" + id + "#" + room + "%zz",
		"bare room id fragment":      "#" + room,
		"word code":                  "olive-tiger-castle",
		"empty":                      "",
		"room id alone":              room,
		"room query without a slash": "floe.one?room=" + room,
		"percent-encoded link":       "https%3A%2F%2Ffloe.one%2Fr%2F" + id + "%23" + room,
		"code with capitals":         "Olive-Tiger-Castle",
		"code with a digit":          "olive-tiger-2nd",
		"four-word code":             "olive-tiger-castle-panda",
		"code with combining marks":  "नमस्ते-घर",
		"room id in fullwidth":       fullwidth(room, true, true),
		"room id in cyrillic":        cyrillicACE.Replace(room),
		"room id without hyphens":    bareRoom,
		"room id hyphens moved":      bareRoom[:16] + "-" + bareRoom[16:],
	}
	names := make([]string, 0, len(seeds))
	for name := range seeds {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f.Add(seeds[name])
		writeSeed(f, "FuzzResolve", seedName(name), "string("+strconv.Quote(seeds[name])+")")
	}

	// Every text an input can fail with when it is not looked up. ErrDropLink
	// carries the same sentence as ErrRequestLink.
	fixed := map[string]bool{
		ErrRequestLink.Error():                              true,
		errInvalidURL.Error():                               true,
		errNotACode.Error():                                 true,
		ErrIncompleteLink.Error():                           true,
		"URL does not contain a room id (#room= or ?room=)": true,
	}
	f.Fuzz(func(t *testing.T, input string) {
		before := lookups.Load()
		link, err := ResolveLink("http://code.invalid", input)
		if lookups.Load() != before {
			if link.HasKey {
				t.Fatal("the code API's answer came back with a key")
			}
			if strings.ContainsAny(input, "/#") {
				t.Fatal("an input with a slash or a hash reached the code API")
			}
			code, _ := lastPath.Load().(string)
			code = strings.TrimPrefix(code, "/api/code/")
			if problem := fuzzLookupProblem(code); problem != "" {
				t.Fatalf("a lookup was sent for text that is not shaped like a code: %s", problem)
			}
			return // the answer to a code: a 404 that quotes a code-shaped input
		}
		if err == nil {
			if link.HasKey && !fuzzRoomShape.MatchString(link.RoomID) {
				t.Fatalf("a keyed link came back with room %q", link.RoomID)
			}
			if !link.HasKey && link.Key != (linkkey.Key{}) {
				t.Fatal("a link with no key returned key bytes")
			}
			return // a room link, resolved here
		}
		if link != (ResolvedLink{}) {
			t.Fatal("a refusal also returned something; want the zero value")
		}
		if !fixed[err.Error()] {
			t.Fatalf("a refusal came back as text that is not fixed: %q", err)
		}
	})
}
