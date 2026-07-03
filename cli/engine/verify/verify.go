// Package verify derives a short, human-comparable verification code from a
// WebRTC connection's DTLS certificate fingerprints.
//
// WebRTC data channels are encrypted with DTLS, but the certificate fingerprints
// are exchanged through the signaling server. A malicious or compromised server
// could therefore swap the fingerprints and man-in-the-middle the "peer to peer"
// connection without either side noticing (RFC 8827). Comparing this code out of
// band (over the phone, in person, over an existing trusted channel) closes that
// gap: if a fingerprint was altered, the two peers compute different codes, so a
// mismatch reveals the tampering. This is the ZRTP / Signal "safety number"
// model applied to Floe.
package verify

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sort"
	"strings"
)

// Code returns a verification code derived from the two DTLS fingerprints of a
// connection (as they appear in the SDP, e.g. "sha-256 AB:CD:..."). The inputs
// are sorted, so each peer computes the same code from its own view of the
// connection when, and only when, no one altered the fingerprints in transit.
func Code(fpA, fpB string) string {
	pair := []string{normalize(fpA), normalize(fpB)}
	sort.Strings(pair)
	sum := sha256.Sum256([]byte(pair[0] + "\n" + pair[1]))
	n := binary.BigEndian.Uint32(sum[:4]) % 100000000 // 8 decimal digits
	return fmt.Sprintf("%04d %04d", n/10000, n%10000)
}

// normalize makes the fingerprint comparison robust to case/whitespace so both
// peers agree on the input for a given certificate.
func normalize(fp string) string {
	return strings.ToUpper(strings.TrimSpace(fp))
}
