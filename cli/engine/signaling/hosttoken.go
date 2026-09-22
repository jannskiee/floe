package signaling

// The secrets and ids a request link is made of (spec 04 5.3): the host
// token, the room id derived from it, and the link id. The desktop makes
// all three here and never re-implements them.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
)

// HostTokenRegexp is the only shape a host token may have: 32 random bytes
// as unpadded base64url, 43 characters. The server applies the same pattern
// before it hashes anything, so a token of any other shape never reaches
// crypto on either side.
var HostTokenRegexp = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// roomIDContext is hashed in front of the token, so a room id is never the
// plain SHA-256 of the token the server stores a digest of.
const roomIDContext = "floe-request-room-v1:"

// NewHostToken returns a fresh host token: 32 bytes from crypto/rand as
// unpadded base64url, 43 characters. It is the host's proof of seat 0. It
// leaves the process only inside join-room over /ws, is kept in memory for
// the life of one link, and must never be logged, printed or persisted.
func NewHostToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("could not make a host token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// RoomIDFromToken is the request room's id for hostToken, the one derivation
// the server repeats before it seats a host (spec 04 5.3, gap G23): the first
// 16 bytes of SHA-256("floe-request-room-v1:" + hostToken) with the version
// nibble set to 4 and the variant bits to 10, as lowercase 8-4-4-4-12 hex.
// Holding the room id (it is in the link) never lets anyone find a token that
// derives it, so seat 0 stays the token holder's even after the server has
// forgotten the reservation.
//
// A token that does not match HostTokenRegexp returns "", never an id. The
// vectors in testdata/derivation-vectors.json came from an independent Node
// one-liner and pin this function and the server's roomIdFromToken to the
// same answers.
func RoomIDFromToken(hostToken string) string {
	if !HostTokenRegexp.MatchString(hostToken) {
		return ""
	}
	sum := sha256.Sum256([]byte(roomIDContext + hostToken))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// NewLinkID returns a fresh link id: 8 bytes from crypto/rand as unpadded
// base64url, 11 characters. It names the link in its path only and is never
// sent to the signaling server.
func NewLinkID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("could not make a link id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
