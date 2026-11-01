package linkkey

import (
	"encoding/json"
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The key rows of the vector file both suites read, written by a Node script
// that shares no code with this package (records folder, tools/gen-keycheck-vectors.mjs).
const vectorFile = "../transfer/testdata/keycheck-vectors.json"

const b64URLAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// TestKeyRows: every key row of the shared vector file parses exactly when it
// says it should, and a valid one comes back byte for byte from Encode.
func TestKeyRows(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(vectorFile))
	if err != nil {
		t.Fatalf("read the vector file: %v", err)
	}
	var file struct {
		KeyRows []struct {
			Name  string `json:"name"`
			Text  string `json:"text"`
			Valid bool   `json:"valid"`
		} `json:"keyRows"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parse the vector file: %v", err)
	}
	if len(file.KeyRows) == 0 {
		t.Fatal("the vector file has no key rows")
	}
	for _, row := range file.KeyRows {
		t.Run(row.Name, func(t *testing.T) {
			k, err := Parse(row.Text)
			if got := err == nil; got != row.Valid {
				t.Fatalf("Parse(%q) error = %v, want valid %v", row.Text, err, row.Valid)
			}
			if !row.Valid {
				if err != ErrMalformed {
					t.Fatalf("Parse(%q) error = %v, want ErrMalformed itself", row.Text, err)
				}
				if k != (Key{}) {
					t.Fatalf("Parse(%q) failed and still returned a key", row.Text)
				}
				return
			}
			if got := k.Encode(); got != row.Text {
				t.Fatalf("Encode() = %q, want %q", got, row.Text)
			}
		})
	}
}

// TestParseLastCharacter walks all 64 last characters: a 16-byte key's last
// character carries 2 data bits and 4 zero bits, so exactly A, Q, g and w end a
// valid key. Two spellings of one key would make a link's text unequal to
// itself, which is what canonical means here.
func TestParseLastCharacter(t *testing.T) {
	for i := 0; i < len(b64URLAlphabet); i++ {
		c := b64URLAlphabet[i]
		s := strings.Repeat("A", 21) + string(c)
		_, err := Parse(s)
		want := strings.IndexByte("AQgw", c) >= 0
		if got := err == nil; got != want {
			t.Errorf("Parse(%q) error = %v, want valid %v", s, err, want)
		}
	}
}

// TestDecodeCanonicalLastCharacter is the same walk for the 32-byte shape a
// proof's tag has: 4 data bits and 2 zero bits in its last character.
func TestDecodeCanonicalLastCharacter(t *testing.T) {
	for i := 0; i < len(b64URLAlphabet); i++ {
		c := b64URLAlphabet[i]
		s := strings.Repeat("A", 42) + string(c)
		raw, ok := DecodeCanonical(s, 32)
		want := strings.IndexByte("AEIMQUYcgkosw048", c) >= 0
		if ok != want {
			t.Errorf("DecodeCanonical(%q, 32) ok = %v, want %v", s, ok, want)
		}
		if ok && len(raw) != 32 {
			t.Errorf("DecodeCanonical(%q, 32) returned %d bytes", s, len(raw))
		}
		if !ok && raw != nil {
			t.Errorf("DecodeCanonical(%q, 32) refused and still returned bytes", s)
		}
	}
}

// TestDecodeCanonicalAlphabet walks every byte value through the first
// position and the middle of an otherwise valid text: only the 64 URL-safe
// characters pass, so a line break, a space, padding, the standard alphabet's
// + and / and a percent escape are all refused, at the exact length.
func TestDecodeCanonicalAlphabet(t *testing.T) {
	for _, pos := range []int{0, 7, 20} {
		for b := 0; b < 256; b++ {
			buf := []byte(strings.Repeat("A", 22))
			buf[pos] = byte(b)
			_, ok := DecodeCanonical(string(buf), Size)
			want := strings.IndexByte(b64URLAlphabet, byte(b)) >= 0
			if ok != want {
				t.Errorf("byte 0x%02x at %d: ok = %v, want %v", b, pos, ok, want)
			}
		}
	}
}

// TestDecodeCanonicalLengths: the length is exact, in both directions, and a
// length this function cannot describe is refused rather than guessed at.
func TestDecodeCanonicalLengths(t *testing.T) {
	cases := []struct {
		name string
		s    string
		n    int
		want bool
	}{
		{"16 bytes at 22", strings.Repeat("A", 22), 16, true},
		{"32 bytes at 43", strings.Repeat("A", 43), 32, true},
		{"three bytes have no padding bits", "AAAA", 3, true},
		{"16 bytes at 21", strings.Repeat("A", 21), 16, false},
		{"16 bytes at 23", strings.Repeat("A", 23), 16, false},
		{"16 bytes padded", strings.Repeat("A", 22) + "==", 16, false},
		{"32 bytes at 42", strings.Repeat("A", 42), 32, false},
		{"32 bytes at 44", strings.Repeat("A", 44), 32, false},
		{"32 bytes padded", strings.Repeat("A", 43) + "=", 32, false},
		{"22 characters asked for 32 bytes", strings.Repeat("A", 22), 32, false},
		{"43 characters asked for 16 bytes", strings.Repeat("A", 43), 16, false},
		{"empty asked for 16 bytes", "", 16, false},
		{"empty asked for nothing", "", 0, false},
		{"a negative length", "", -1, false},
		{"line breaks inside the length", "AAAAAAAAAA\r\nAAAAAAAAAA", 16, false},
		{"line breaks around the length", "\n" + strings.Repeat("A", 21), 16, false},
		{"line breaks that would decode to the size", strings.Repeat("A", 22) + "\r\n", 16, false},
		{"a multi-byte rune of the right byte count", strings.Repeat("A", 20) + "\u00e9", 16, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, ok := DecodeCanonical(c.s, c.n)
			if ok != c.want {
				t.Fatalf("DecodeCanonical(%q, %d) ok = %v, want %v", c.s, c.n, ok, c.want)
			}
			if ok && len(raw) != c.n {
				t.Fatalf("DecodeCanonical(%q, %d) returned %d bytes", c.s, c.n, len(raw))
			}
		})
	}
}

// TestNewMakesAWholeRandomKey: a new key round-trips through its only text
// form, is 22 canonical characters, and two in a row differ, in every byte
// position over a small sample (a key that came out mostly zero would pass a
// bare "they differ").
func TestNewMakesAWholeRandomKey(t *testing.T) {
	var seen [Size]map[byte]bool
	for i := range seen {
		seen[i] = map[byte]bool{}
	}
	var prev Key
	for round := 0; round < 64; round++ {
		k, err := New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if k == prev {
			t.Fatal("two new keys in a row are equal")
		}
		prev = k
		text := k.Encode()
		if len(text) != 22 {
			t.Fatalf("Encode() is %d characters, want 22", len(text))
		}
		back, err := Parse(text)
		if err != nil {
			t.Fatalf("Parse(Encode()) = %v", err)
		}
		if back != k {
			t.Fatal("Parse(Encode()) is a different key")
		}
		for i, b := range k {
			seen[i][b] = true
		}
	}
	for i := range seen {
		if len(seen[i]) < 8 {
			t.Errorf("byte %d took only %d values in 64 keys", i, len(seen[i]))
		}
	}
}

// TestEncodeIsURLSafeText pins the encoding to known bytes, so Encode cannot
// drift to the standard alphabet or to padding while still round-tripping.
func TestEncodeIsURLSafeText(t *testing.T) {
	cases := []struct {
		key  Key
		want string
	}{
		{Key{}, "AAAAAAAAAAAAAAAAAAAAAA"},
		{Key{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}, "AQIDBAUGBwgJCgsMDQ4PEA"},
		{Key{255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255}, "_____________________w"},
	}
	for _, c := range cases {
		if got := c.key.Encode(); got != c.want {
			t.Errorf("Encode() = %q, want %q", got, c.want)
		}
	}
}

// secretKey is a key whose every byte and every hex or decimal spelling is easy
// to search for in printed text.
var secretKey = Key{0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef}

// leaks reports what in text shows the key: its link text, or its bytes as
// hex or as the decimal or octal run an array prints.
func leaks(text string) string {
	lower := strings.ToLower(text)
	for _, needle := range []string{secretKey.Encode(), "deadbeef", "222 173 190 239", "222, 173, 190, 239", "0xde", "336 255 276 357", "11011110"} {
		if strings.Contains(lower, strings.ToLower(needle)) {
			return needle
		}
	}
	return ""
}

// TestKeyNeverPrints: no fmt verb, on the key itself, behind a pointer, inside
// a struct or inside a slice, shows the key's bytes or its link text. %d on a
// [16]byte prints every byte unless the type stops it, which a String method
// alone does not (fmt consults Stringer only for the string verbs).
//
// %p and %w are left out because no method can reach them: on an operand that
// is not a pointer, or not an error, fmt takes its bad-verb path, which prints
// the operand raw on purpose. go vet refuses both calls, and CI runs go vet.
func TestKeyNeverPrints(t *testing.T) {
	type holder struct {
		Key  Key
		Room string
	}
	operands := map[string]any{
		"value":   secretKey,
		"pointer": &secretKey,
		"struct":  holder{Key: secretKey, Room: "room"},
		"slice":   []Key{secretKey},
		"map":     map[string]Key{"k": secretKey},
	}
	verbs := []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d", "%o", "%O", "%b", "%c", "%U", "%e", "%t", "%T"}
	for name, op := range operands {
		for _, verb := range verbs {
			got := fmt.Sprintf(verb, op)
			if needle := leaks(got); needle != "" {
				t.Errorf("Sprintf(%q, %s) = %q, shows the key (%s)", verb, name, got, needle)
			}
		}
	}
	if got := secretKey.String(); got != "linkkey.Key(redacted)" {
		t.Errorf("String() = %q", got)
	}
	if got := secretKey.GoString(); got != "linkkey.Key(redacted)" {
		t.Errorf("GoString() = %q", got)
	}
	if got := fmt.Sprint(secretKey); got != "linkkey.Key(redacted)" {
		t.Errorf("Sprint = %q", got)
	}
	if got := fmt.Errorf("wrapped: %v", secretKey).Error(); strings.Contains(got, secretKey.Encode()) {
		t.Errorf("an error built from the key shows it: %q", got)
	}
}

// TestKeyHasNoTextForm: encoding/json, and anything else that asks a value for
// its text, gets an error instead of the key, so a stored or logged struct
// fails loudly rather than carrying it.
func TestKeyHasNoTextForm(t *testing.T) {
	if b, err := secretKey.MarshalText(); err == nil || b != nil {
		t.Fatalf("MarshalText = %q, %v; want no text and an error", b, err)
	} else if needle := leaks(err.Error()); needle != "" {
		t.Fatalf("MarshalText's error shows the key: %q", err)
	}
	for name, v := range map[string]any{
		"value":   secretKey,
		"pointer": &secretKey,
		"struct":  struct{ K Key }{K: secretKey},
		"map key": map[Key]bool{secretKey: true},
	} {
		b, err := json.Marshal(v)
		if err == nil {
			t.Errorf("json.Marshal(%s) = %s, want an error", name, b)
			continue
		}
		if needle := leaks(string(b) + err.Error()); needle != "" {
			t.Errorf("json.Marshal(%s) shows the key: %q, %q", name, b, err)
		}
	}
}

// TestErrMalformedNeverQuotesInput: the one error Parse gives is a fixed
// sentence that holds nothing of the input, since a mistyped key is still most
// of a key, and it is the same error every time, so a caller can compare it.
func TestErrMalformedNeverQuotesInput(t *testing.T) {
	inputs := []string{
		"AAAAAAAAAAAAAAAAAAAAAB",
		strings.Repeat("Z", 21),
		"sk3tchy-looking-input",
		"\x1b[2K\u202e$(calc)",
	}
	for _, in := range inputs {
		_, err := Parse(in)
		if !errors.Is(err, ErrMalformed) {
			t.Fatalf("Parse(%q) = %v", in, err)
		}
		if strings.Contains(err.Error(), in) || strings.Contains(err.Error(), strconv.Quote(in)) {
			t.Fatalf("Parse(%q) quotes its input: %q", in, err)
		}
	}
	if got := ErrMalformed.Error(); got != "the link key is incomplete or mistyped" {
		t.Fatalf("ErrMalformed = %q", got)
	}
}

// TestImportsStandardLibraryOnly: the package is imported by code, transfer,
// the CLI and the desktop, and the plan holds it to the standard library so
// that none of them gains an edge through it (code never imports pion, transfer
// never imports peer).
func TestImportsStandardLibraryOnly(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, imp := range parsed.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			if first, _, _ := strings.Cut(path, "/"); strings.Contains(first, ".") {
				t.Errorf("%s imports %s, outside the standard library", name, path)
			}
		}
	}
}
