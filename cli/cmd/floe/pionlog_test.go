package main

import (
	"bytes"
	"os"
	"testing"

	"github.com/pion/logging"
)

// TestQuietTURNClientLogLeavesChosenLevelsAlone: with no pion level set,
// quietTURNClientLog disables the "turnc" scope. With a level that turns
// logging on (ERROR, WARN, INFO, DEBUG or TRACE, as PION_LOG_ or PIONS_LOG_)
// it leaves the environment exactly as it was, so a person debugging pion
// gets the levels they asked for. With only a DISABLE variable, which asks
// for less, turnc joins the variable pion reads, unless pion already reads it
// there. Each case is checked the way pion reads it: a default factory made
// afterwards prints the TURN client's ERROR line or not.
func TestQuietTURNClientLogLeavesChosenLevelsAlone(t *testing.T) {
	cases := []struct {
		name  string
		set   map[string]string
		want  map[string]string // the variables afterwards; "" is unset
		quiet bool              // pion's default factory prints nothing for turnc
	}{
		{"nothing set", nil, map[string]string{"PION_LOG_DISABLE": "turnc"}, true},
		{"PION_LOG_TRACE=all", map[string]string{"PION_LOG_TRACE": "all"}, map[string]string{"PION_LOG_TRACE": "all", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_DEBUG=ice", map[string]string{"PION_LOG_DEBUG": "ice"}, map[string]string{"PION_LOG_DEBUG": "ice", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_ERROR=turnc", map[string]string{"PION_LOG_ERROR": "turnc"}, map[string]string{"PION_LOG_ERROR": "turnc", "PION_LOG_DISABLE": ""}, false},
		{"PIONS_LOG_WARN=all", map[string]string{"PIONS_LOG_WARN": "all"}, map[string]string{"PIONS_LOG_WARN": "all", "PION_LOG_DISABLE": ""}, false},
		{"PIONS_LOG_INFO=turnc", map[string]string{"PIONS_LOG_INFO": "turnc"}, map[string]string{"PIONS_LOG_INFO": "turnc", "PION_LOG_DISABLE": ""}, false},
		{"PION_LOG_DISABLE=mdns and PION_LOG_DEBUG=ice", map[string]string{"PION_LOG_DISABLE": "mdns", "PION_LOG_DEBUG": "ice"}, map[string]string{"PION_LOG_DISABLE": "mdns", "PION_LOG_DEBUG": "ice"}, false},
		{"PION_LOG_DISABLE=mdns", map[string]string{"PION_LOG_DISABLE": "mdns"}, map[string]string{"PION_LOG_DISABLE": "mdns,turnc"}, true},
		// pion takes "all" as a level for DISABLE, which lowers nothing.
		{"PION_LOG_DISABLE=all", map[string]string{"PION_LOG_DISABLE": "all"}, map[string]string{"PION_LOG_DISABLE": "all,turnc"}, true},
		{"PION_LOG_DISABLE=MDNS,TurnC", map[string]string{"PION_LOG_DISABLE": "MDNS,TurnC"}, map[string]string{"PION_LOG_DISABLE": "MDNS,TurnC"}, true},
		// pion splits on commas without trimming, so " turnc" is no scope it logs.
		{"PION_LOG_DISABLE=mdns, turnc", map[string]string{"PION_LOG_DISABLE": "mdns, turnc"}, map[string]string{"PION_LOG_DISABLE": "mdns, turnc,turnc"}, true},
		{"PIONS_LOG_DISABLE=ice", map[string]string{"PIONS_LOG_DISABLE": "ice"}, map[string]string{"PIONS_LOG_DISABLE": "ice,turnc", "PION_LOG_DISABLE": ""}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
				for _, level := range []string{"DISABLE", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"} {
					t.Setenv(prefix+level, "")
				}
			}
			for k, v := range tc.set {
				t.Setenv(k, v)
			}
			quietTURNClientLog()
			for k, want := range tc.want {
				if got := os.Getenv(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
			var buf bytes.Buffer
			f := logging.NewDefaultLoggerFactory()
			f.Writer = &buf
			f.NewLogger("turnc").Errorf("Fail to refresh permissions: %s", "x")
			if quiet := buf.Len() == 0; quiet != tc.quiet {
				t.Errorf("pion's default factory printed %q for turnc; want quiet=%v", buf.String(), tc.quiet)
			}
		})
	}
}
