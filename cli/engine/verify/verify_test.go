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
