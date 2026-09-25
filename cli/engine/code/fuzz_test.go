package code

// FuzzParseRequestLink is the DV-FUZZ target for the one decoder this
// package owns (spec 05 8.9). ParseRequestLink is pure: no network, no disk.
// The seeds are added with f.Add and the same values are committed under
// testdata/fuzz/FuzzParseRequestLink/ so the corpus directory exists in git;
// FLOE_WRITE_FUZZ_SEEDS=1 go test -run '^Fuzz' . rewrites those files, and
// nothing else here writes.

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

var (
	fuzzLinkIDShape = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	fuzzRoomShape   = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

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
// agrees; a failure returns two empty strings and one of the two fixed
// sentinel errors, so no part of the input can reach a caller that prints it.
func FuzzParseRequestLink(f *testing.F) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	const id = "Xk3p9Q0aB1c"
	seeds := map[string]string{
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
		"bidi override in the id":    "https://floe.one/r/Xk3p9Q0‮aB1c#" + room,
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
		linkID, roomID, err := ParseRequestLink(input)
		if err != nil {
			if !errors.Is(err, errNotRequestLink) && !errors.Is(err, errRequestLinkRoom) {
				t.Fatalf("a failure returned a non-sentinel error: %v", err)
			}
			if linkID != "" || roomID != "" {
				t.Fatalf("a failed parse returned %q, %q; want both empty", linkID, roomID)
			}
			return
		}
		if !fuzzLinkIDShape.MatchString(linkID) {
			t.Fatalf("accepted link id %q is not 11 characters of [A-Za-z0-9_-]", linkID)
		}
		if !fuzzRoomShape.MatchString(roomID) {
			t.Fatalf("accepted room id %q is not UUID-shaped", roomID)
		}
		// No "the input holds both values" check: url.Parse decodes percent
		// escapes, so %36f1c... is the room id 6f1c... (the browser agrees).
		if l2, r2, err2 := ParseRequestLink(input); err2 != nil || l2 != linkID || r2 != roomID {
			t.Fatalf("not deterministic: %q, %q then %q, %q (%v)", linkID, roomID, l2, r2, err2)
		}
	})
}
