package main

// pion log scopes turned off from the environment: a stopgap for the one pion
// logger that floe cannot route through its own escaping factory (FU-32
// F2-1), and the peer connection's and the data channel's on the
// request-link send (FU-32 F2-2, FU-46 review 1 L1).

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

// quietTURNClientLog disables pion's "turnc" scope unless the person running
// floe has turned a pion log level on.
//
// pion/ice v4.4.0 gives its TURN client pion's DEFAULT logger factory, not the
// escaping one peer.New hands pion/webrtc (engine/peer/logging.go), so the
// client's lines reach stderr as they are. Its one ERROR line, pion/turn's
// "Fail to refresh permissions: ...", quotes the reason phrase of the TURN
// server's error response byte for byte, and pion/turn takes any error
// response whose transaction id matches, with no MESSAGE-INTEGRITY check. So
// anyone on the UDP path to the TURN server, not only the server, can answer
// the permission refresh that runs every 120 s once a relay allocation holds a
// permission (whichever path the transfer took), and write terminal controls
// onto the terminal of floe send or floe receive: a screen clear, an OSC 52
// clipboard write, an OSC 8 link, lines that pass for floe's own.
//
// pion/ice builds that factory when it makes each ICE agent, reading the
// environment then, so a variable set before any command runs silences the
// "turnc" scope for the whole process. Only the TURN client logs as "turnc",
// and nothing floe prints is one of its lines. Someone who turned a level on
// (ERROR, WARN, INFO, DEBUG or TRACE, as PION_LOG_ or PIONS_LOG_) is
// debugging pion, and floe leaves every pion variable as it is. That leaves
// turnc on even when the level names other scopes only: with
// PION_LOG_TRACE=ice, turnc logs at pion's default ERROR level, so its ERROR
// line, the one a forged reason reaches, prints raw again. Someone who set
// only a DISABLE variable asked for less, so turnc joins the one pion reads:
// PION_LOG_DISABLE, or PIONS_LOG_DISABLE when that one is empty. pion
// lower-cases the value and splits it on commas without trimming, and "all"
// disables nothing there, so turnc is added unless one of those pieces is
// exactly "turnc" already.
//
// Remove this once pion/ice hands the TURN client the setting engine's
// factory: pion/ice v4.4.3 does (pion/ice#976), and pion/webrtc v4.2.21 is
// the first release that requires it.
func quietTURNClientLog() { quietPionScope("turnc") }

// quietPeerConnectionLog disables pion's "pc" and "datachannel" scopes by the
// same rule, on the request-link send only (FU-46, FU-32 F2-2, review 1 L1).
// runSendTo calls it before it makes its peer: peer.New builds its logger
// factory from pion's default, which reads the environment then
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

// quietPionScope disables pion's scope (lower case, as pion names its own)
// unless the person running floe has turned a pion log level on, the rule
// quietTURNClientLog states for turnc: nothing changes while a PION_LOG_ or
// PIONS_LOG_ ERROR, WARN, INFO, DEBUG or TRACE is set, and otherwise scope
// joins the DISABLE variable pion reads unless pion reads it there already.
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
func init() { quietTURNClientLog() }
