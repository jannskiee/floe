package linkkey

// FuzzParseLinkKey is the DV-FUZZ target for the one decoder this package owns.
// A key arrives inside a link the other party wrote, so its text is hostile by
// default. The seeds are added with f.Add and the same values are committed
// under testdata/fuzz/FuzzParseLinkKey/ so the corpus directory exists in git;
// FLOE_WRITE_FUZZ_SEEDS=1 go test -run '^Fuzz' . rewrites those files, and
// nothing else here writes.

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The two canonical shapes, written as the regular expressions the wire spec
// states, so the property is graded by something other than the code under test.
var (
	fuzzKeyShape = regexp.MustCompile(`^[A-Za-z0-9_-]{21}[AQgw]$`)
	fuzzTagShape = regexp.MustCompile(`^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
)

type fuzzSeed struct{ name, text string }

func parseLinkKeySeeds() []fuzzSeed {
	return []fuzzSeed{
		{"canonical-zero", "AAAAAAAAAAAAAAAAAAAAAA"},
		{"canonical-counting", "AQIDBAUGBwgJCgsMDQ4PEA"},
		{"canonical-ff", "_____________________w"},
		{"last-char-B", "AAAAAAAAAAAAAAAAAAAAAB"},
		{"too-short-21", "AAAAAAAAAAAAAAAAAAAAA"},
		{"too-long-23", "AAAAAAAAAAAAAAAAAAAAAAA"},
		{"padded", "AAAAAAAAAAAAAAAAAAAAAA=="},
		{"std-alphabet-plus", "+AAAAAAAAAAAAAAAAAAAAA"},
		{"std-alphabet-slash", "/AAAAAAAAAAAAAAAAAAAAA"},
		{"dot", ".AAAAAAAAAAAAAAAAAAAAA"},
		{"crlf-inside", "AAAAAAAAAA\r\nAAAAAAAAAA"},
		{"crlf-after", "AAAAAAAAAAAAAAAAAAAAAA\r\n"},
		{"space-inside", "AAAAAAAAAA AAAAAAAAAAA"},
		{"percent-encoded-A", "%41AAAAAAAAAAAAAAAAAAAAA"},
		{"empty", ""},
		{"nul-inside", "AAAAAAAAAA\x00AAAAAAAAAAA"},
		{"invalid-utf8", "AAAAAAAAAA\xffAAAAAAAAAAA"},
		{"tag-shape", strings.Repeat("A", 43)},
		{"bidi-control", "\u202eAAAAAAAAAAAAAAAAAAA"},
	}
}

// FuzzParseLinkKey: Parse never panics and accepts exactly the canonical shape;
// what it accepts comes back byte for byte from Encode; what it refuses is the
// fixed ErrMalformed, which holds nothing of the input. DecodeCanonical holds to
// the same rule at the tag's 32 bytes, and to its length for every other size.
func FuzzParseLinkKey(f *testing.F) {
	write := os.Getenv("FLOE_WRITE_FUZZ_SEEDS") == "1"
	dir := filepath.Join("testdata", "fuzz", "FuzzParseLinkKey")
	if write {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			f.Fatalf("seed dir: %v", err)
		}
	}
	for _, s := range parseLinkKeySeeds() {
		f.Add(s.text)
		if write {
			body := "go test fuzz v1\nstring(" + strconv.Quote(s.text) + ")\n"
			if err := os.WriteFile(filepath.Join(dir, "seed-"+s.name), []byte(body), 0o644); err != nil {
				f.Fatalf("seed %s: %v", s.name, err)
			}
		}
	}
	f.Fuzz(func(t *testing.T, s string) {
		k, err := Parse(s)
		want := fuzzKeyShape.MatchString(s)
		if (err == nil) != want {
			t.Fatalf("Parse(%q) error = %v; the canonical shape says valid %v", s, err, want)
		}
		if err != nil {
			if err != ErrMalformed {
				t.Fatalf("Parse(%q) returned %v, not ErrMalformed itself", s, err)
			}
			if k != (Key{}) {
				t.Fatalf("Parse(%q) refused and still returned a key", s)
			}
		} else if got := k.Encode(); got != s {
			t.Fatalf("Parse(%q) came back as %q", s, got)
		}

		raw, ok := DecodeCanonical(s, 32)
		if ok != fuzzTagShape.MatchString(s) {
			t.Fatalf("DecodeCanonical(%q, 32) ok = %v, against the tag shape", s, ok)
		}
		if ok && len(raw) != 32 {
			t.Fatalf("DecodeCanonical(%q, 32) returned %d bytes", s, len(raw))
		}
		for _, n := range []int{-1, 0, 1, 2, 3, 15, 17, 31, 33, 64} {
			if raw, ok := DecodeCanonical(s, n); ok && len(raw) != n {
				t.Fatalf("DecodeCanonical(%q, %d) returned %d bytes", s, n, len(raw))
			}
		}
	})
}
