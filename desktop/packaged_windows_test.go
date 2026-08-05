//go:build windows

package main

import "testing"

// go test always runs unpackaged, so the probe must report false. This pins
// the fail-open default that the context-menu gating depends on: a detection
// hiccup must read as "unpackaged", never the reverse.
func TestIsPackagedUnpackaged(t *testing.T) {
	if isPackaged() {
		t.Fatal("isPackaged() = true in an unpackaged test process")
	}
}
