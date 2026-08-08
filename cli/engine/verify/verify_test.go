package verify

import (
	"strings"
	"testing"
)

func TestCodeOrderIndependentAndStable(t *testing.T) {
	a := "sha-256 AB:CD:EF:00:11:22:33:44"
	b := "sha-256 99:88:77:66:55:44:33:22"

	if Code(a, b) != Code(b, a) {
		t.Fatalf("code must be order-independent: %q vs %q", Code(a, b), Code(b, a))
	}
	if Code(a, b) != Code(a, b) {
		t.Fatal("code must be stable")
	}
}

func TestCodeCaseInsensitive(t *testing.T) {
	a := "sha-256 AB:CD:EF:00"
	b := "sha-256 99:88:77:66"
	if Code(strings.ToLower(a), b) != Code(a, b) {
		t.Fatal("code must be case-insensitive")
	}
}

func TestCodeDetectsChangedFingerprint(t *testing.T) {
	a := "sha-256 AB:CD:EF:00:11:22"
	b := "sha-256 99:88:77:66:55:44"
	mitm := "sha-256 DE:AD:BE:EF:00:11" // attacker's certificate

	// Peer A sees (a, mitm); the real peer B sees (mitm, b). A MITM that swaps
	// fingerprints therefore yields mismatched codes, which users detect.
	if Code(a, mitm) == Code(mitm, b) {
		t.Fatal("a MITM swapping fingerprints must produce mismatched codes")
	}

	// Format sanity: "NNNN NNNN".
	got := Code(a, b)
	if len(got) != 9 || got[4] != ' ' {
		t.Fatalf("unexpected code format: %q", got)
	}
}

// TestCodeKnownVector pins a canonical value so the browser implementation
// (client/lib/transfer/verify.ts) can be tested to produce the exact same code.
func TestCodeKnownVector(t *testing.T) {
	got := Code("sha-256 AA:BB:CC:DD", "sha-256 11:22:33:44")
	if got != knownVector {
		t.Fatalf("vector changed: got %q want %q (update client verify.test.ts too)", got, knownVector)
	}
}

const knownVector = "1337 5359"
