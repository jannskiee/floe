package main

// pion log scopes turned off from the environment: the packet mux's and the
// TURN client's for every command, as noise (deep QA QA-07, FU-32 F2-1), and
// the peer connection's and the data channel's on the request-link send
// (FU-32 F2-2, FU-46 review 1 L1).

import (
	"os"
	"strings"
)

// pionEnablingLevels are the levels pion's default logger factory reads from
// the environment (pion/logging v0.2.4, NewDefaultLoggerFactory) that turn
// logging on, each as PION_LOG_<level> and, when that one is empty,
// PIONS_LOG_<level>. The sixth, DISABLE, only ever turns it off. An empty
// value counts as unset there, and so here.
var pionEnablingLevels = [...]string{"ERROR", "WARN", "INFO", "DEBUG", "TRACE"}

// quietPeerConnectionLog disables pion's "pc" and "datachannel" scopes by
// quietPionScope's rule, on the request-link send only (FU-46, FU-32 F2-2,
// review 1 L1). runSendTo calls it before it makes its peer: peer.New builds
// its logger factory from pion's default, which reads the environment then
// (engine/peer/logging.go), and pion/webrtc hands that factory to the data
// channels it accepts.
//
// The link's host is a stranger, and D-147 (2) keeps every word it chooses
// off the visitor's terminal. FU-40's escape writes controls visibly, but
// printable text, ordinary or no-break spaces included, passes, so two lines
// at pion's default ERROR level printed the host's own sentence:
//   - pion/webrtc v4.2.19 logs a trickled candidate whose ufrag matches
//     nothing in the remote description as "pc ERROR: dropping candidate
//     with ufrag <ufrag> ...", the ufrag the host's (Latin-1 passes pion's
//     candidate reader), up to about 1 KiB a line;
//   - pion/datachannel v1.6.2 logs any DCEP message but an ACK on an open
//     channel as "datachannel ERROR: Failed to handle DCEP: ... Label(<label>)
//     Protocol(<protocol>)", both strings from a DATA_CHANNEL_OPEN the host
//     wrote, up to 64 KiB a line and once per message (a modified host stack
//     can send it; a browser cannot).
//
// Both scopes' other lines are pion's diagnostics, which this path never
// prints anyway: every outcome there is a fixed line. Plain send and receive
// keep both scopes.
func quietPeerConnectionLog() {
	quietPionScope("pc")
	quietPionScope("datachannel")
}

// quietMuxLog disables pion's "mux" scope for every command by
// quietPionScope's rule (deep QA QA-07). The data channel's packet mux logs
// at ERROR for each datagram it cannot hand on, and in one stalled send out
// of 38 in the QA runs it printed 174 lines of "mux ERROR: failed to read
// from packetio.Buffer short buffer" over floe's own output before the stall
// ended it. The lines go through the escaping factory, so they could not
// write controls, but they are pion's internals and nothing the person
// running floe can act on; floe's own message says what happened. Someone
// debugging pion turns a level on and gets them back.
func quietMuxLog() { quietPionScope("mux") }

// quietPionScope disables pion's scope (lower case, as pion names its own)
// unless the person running floe has turned a pion log level on. pion reads
// these variables when it builds a default factory, and peer.New builds its
// escaping one from that default (engine/peer/logging.go), so a variable set
// before a peer is made holds for every logger of that peer.
//
// Someone who turned a level on (ERROR, WARN, INFO, DEBUG or TRACE, as
// PION_LOG_ or PIONS_LOG_) is debugging pion, and floe leaves every pion
// variable as it is, even when the level names other scopes only: with
// PION_LOG_TRACE=ice, scope logs at pion's default ERROR level again. Someone
// who set only a DISABLE variable asked for less, so scope joins the one pion
// reads: PION_LOG_DISABLE, or PIONS_LOG_DISABLE when that one is empty. pion
// lower-cases the value and splits it on commas without trimming, and "all"
// disables nothing there, so scope is added unless one of those pieces is
// exactly scope already.
func quietPionScope(scope string) {
	for _, prefix := range [...]string{"PION_LOG_", "PIONS_LOG_"} {
		for _, level := range pionEnablingLevels {
			if os.Getenv(prefix+level) != "" {
				return
			}
		}
	}
	name, value := "PION_LOG_DISABLE", os.Getenv("PION_LOG_DISABLE")
	if value == "" {
		if v := os.Getenv("PIONS_LOG_DISABLE"); v != "" {
			name, value = "PIONS_LOG_DISABLE", v
		}
	}
	if value == "" {
		_ = os.Setenv(name, scope)
		return
	}
	for _, s := range strings.Split(strings.ToLower(value), ",") {
		if s == scope {
			return
		}
	}
	_ = os.Setenv(name, value+","+scope)
}

// At process start, before main and so before any command can build a peer.
// The test binary runs it too, which is what turnlog_test.go reads.
func init() {
	// The TURN client's "turnc" scope, by quietPionScope's rule, as noise and
	// no longer as a security stopgap: since pion/ice 4.4.3 (floe has 4.4.8
	// since #844) the client logs through newLoggerFactory, so its lines
	// arrive escaped (TestNoPionLoggerBypassesTheLoggerFactory pins that). Its
	// one ERROR line, a failed permission refresh, is relay housekeeping every
	// 120 s that the person running floe cannot act on. It runs first, as the
	// stopgap did, so floe sets the same DISABLE value as before.
	quietPionScope("turnc")
	quietMuxLog()
}
