package main

import (
	"os"
	"testing"
)

// TestQuietTURNClientLogLeavesChosenLevelsAlone: with no pion level set,
// quietTURNClientLog disables the "turnc" scope; with any PION_LOG_* or
// PIONS_LOG_* level set, it leaves the environment exactly as it was, so a
// person debugging pion gets the levels they asked for.
func TestQuietTURNClientLogLeavesChosenLevelsAlone(t *testing.T) {
	cases := []struct {
		name, key, value string
		wantDisable      string
	}{
		{"nothing set", "", "", "turnc"},
		{"PION_LOG_TRACE=all", "PION_LOG_TRACE", "all", ""},
		{"PION_LOG_DEBUG=ice", "PION_LOG_DEBUG", "ice", ""},
		{"PION_LOG_ERROR=turnc", "PION_LOG_ERROR", "turnc", ""},
		{"PION_LOG_DISABLE=mdns", "PION_LOG_DISABLE", "mdns", "mdns"},
		{"PIONS_LOG_WARN=all", "PIONS_LOG_WARN", "all", ""},
		{"PIONS_LOG_DISABLE=ice", "PIONS_LOG_DISABLE", "ice", ""},
		{"PIONS_LOG_INFO=turnc", "PIONS_LOG_INFO", "turnc", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
				for _, level := range pionLogLevels {
					t.Setenv(prefix+level, "")
				}
			}
			if tc.key != "" {
				t.Setenv(tc.key, tc.value)
			}
			quietTURNClientLog()
			if got := os.Getenv("PION_LOG_DISABLE"); got != tc.wantDisable {
				t.Fatalf("PION_LOG_DISABLE = %q, want %q", got, tc.wantDisable)
			}
			if tc.key != "" {
				if got := os.Getenv(tc.key); got != tc.value {
					t.Fatalf("%s = %q, want it left at %q", tc.key, got, tc.value)
				}
			}
		})
	}
}
