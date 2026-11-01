// Package linkkey is the link key: 16 random bytes every keyed Floe link carries
// in its fragment, never sent to any server, which the two ends of a transfer
// use to prove they hold the same link (transfer/keycheck.go).
//
// The key must never reach a log, a report, a stored file or an error, so the
// type gives it one way out as text, Encode, called only by the code that writes
// a link. Standard library only: code, transfer, the CLI and the desktop all
// import it, and none of them gains a dependency through it.
package linkkey

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// Size is a key's length in bytes, which is 22 characters in a link.
const Size = 16

// Key is a link key. Every way fmt, encoding/json or an encoding.TextMarshaler
// reader has of asking it for text gets the redacted form or an error.
//
// What a method cannot stop: fmt does not call methods on an unexported struct
// field, so a Key held in one prints its bytes under %v (hold it in an exported
// field, as transfer.KeyCheck does, or never print the struct), and its bad-verb
// path prints an operand raw (%p on a value, %w on what is not an error), which
// go vet refuses.
type Key [Size]byte

// ErrMalformed is what Parse returns for anything that is not a canonical key.
// It is fixed text and never quotes its input, because a mistyped key is still
// most of a key.
var ErrMalformed = errors.New("the link key is incomplete or mistyped")

const redacted = "linkkey.Key(redacted)"

var errNoText = errors.New("a link key has no text form")

// New makes a key from the operating system's random source.
func New() (Key, error) {
	var k Key
	if _, err := rand.Read(k[:]); err != nil {
		return Key{}, fmt.Errorf("could not make a link key: %w", err)
	}
	return k, nil
}

// Parse reads a key's text form. Only the canonical spelling passes, so one key
// has one spelling (see DecodeCanonical). The failure is always ErrMalformed
// itself, and the Key it returns with it is zero.
func Parse(s string) (Key, error) {
	raw, ok := DecodeCanonical(s, Size)
	if !ok {
		return Key{}, ErrMalformed
	}
	var k Key
	copy(k[:], raw)
	return k, nil
}

// Encode is the only route to the key as text: 22 unpadded base64url characters.
func (k Key) Encode() string {
	return base64.RawURLEncoding.EncodeToString(k[:])
}

// String keeps the key out of %v and %s.
func (Key) String() string { return redacted }

// GoString keeps the key out of %#v.
func (Key) GoString() string { return redacted }

// Format keeps the key out of every other verb. String and GoString alone leave
// the numeric ones open: fmt consults them only for the string verbs, so %d on
// a [16]byte prints all 16 bytes.
func (Key) Format(f fmt.State, _ rune) {
	_, _ = io.WriteString(f, redacted)
}

// MarshalText refuses, so encoding/json fails on a Key, or on anything holding
// one, instead of writing an array of its bytes.
func (Key) MarshalText() ([]byte, error) {
	return nil, errNoText
}

// DecodeCanonical decodes s when it is the one canonical unpadded base64url
// spelling of exactly n bytes, and refuses anything else. A tag and a key share
// it: n is 16 for a key and 32 for a proof's tag. In order:
//
//   - The length is exact, so nothing is decoded from a string of a size the
//     caller did not ask for.
//   - Every byte is in the URL-safe alphabet, checked by hand: Go's decoder skips
//     CR and LF even when Strict.
//   - RawURLEncoding.Strict() refuses bits set past the last data byte, the
//     second spelling a loose decoder would accept (AAAA...B for AAAA...A).
//   - Encoding the result again gives back s.
func DecodeCanonical(s string, n int) ([]byte, bool) {
	if n <= 0 || len(s) != base64.RawURLEncoding.EncodedLen(n) {
		return nil, false
	}
	for i := 0; i < len(s); i++ {
		if !urlSafe(s[i]) {
			return nil, false
		}
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(raw) != n {
		return nil, false
	}
	if base64.RawURLEncoding.EncodeToString(raw) != s {
		return nil, false
	}
	return raw, true
}

func urlSafe(c byte) bool {
	switch {
	case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		return true
	}
	return c == '-' || c == '_'
}
