package main

// A stopgap for the one pion logger that floe cannot route through its own
// escaping factory (FU-32 F2-1).

import "os"

// pionLogLevels are the levels pion's default logger factory reads from the
// environment (pion/logging v0.2.4, NewDefaultLoggerFactory), each as
// PION_LOG_<level> and, when that one is empty, PIONS_LOG_<level>. An empty
// value counts as unset there, and so here.
var pionLogLevels = [...]string{"DISABLE", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"}

// quietTURNClientLog sets PION_LOG_DISABLE=turnc unless the person running
// floe has set a pion log level of their own.
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
// and nothing floe prints is one of its lines. Someone who set any
// PION_LOG_* or PIONS_LOG_* variable is debugging pion, and gets exactly the
// levels they asked for, the TURN client's lines included.
//
// Remove this once pion/ice hands the TURN client the setting engine's
// factory: pion/ice v4.4.3 does (pion/ice#976), and pion/webrtc v4.2.21 is
// the first release that requires it.
func quietTURNClientLog() {
	for _, prefix := range [...]string{"PION_LOG_", "PIONS_LOG_"} {
		for _, level := range pionLogLevels {
			if os.Getenv(prefix+level) != "" {
				return
			}
		}
	}
	_ = os.Setenv("PION_LOG_DISABLE", "turnc")
}

// At process start, before main and so before any command can build a peer.
// The test binary runs it too, which is what turnlog_test.go reads.
func init() { quietTURNClientLog() }
