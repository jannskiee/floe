// Command floe-e2ehost is a test-only Go peer that the Playwright suite drives
// as a program. It is never part of a release: .goreleaser.yml builds only
// ./cmd/floe, and client/e2e/global-setup.ts builds this into the e2e temp
// directory for the length of one run.
//
// Usage:
//
//	floe-e2ehost host -out <dir> [-server URL] [-room UUID] [-hold D] [-timeout D]
//	floe-e2ehost send [-server URL] [-web URL] [-room UUID] [-corrupt-hash | -malformed-hash] <paths>
//	floe-e2ehost request -out <dir> [-server URL] [-web URL] [-decide STEPS] [-fast-timers]
//	    [-keep-waiting] [-corrupt-hash] [-blip-after EVENT] [-timeout D]
//
// The first argument is a mode word. Send mode is a CLI-shaped sender whose
// end frame can carry a digest that does not match what it sent, so the audit
// can prove a receiver refuses one; the engine sender has no such flag.
// Request mode is a request-link host for the Playwright request-link spec
// (request.go).
//
// Output contract: stdout carries one JSON event per line and nothing else,
// every value in it either a fixed word, the room id the caller passed or the
// harness generated (and the link id, in request mode's link), the role the
// signaling server assigned, a refusal code this side chose, or a count. The
// engine prints to os.Stdout on its own (the incoming file's name among it),
// so main points os.Stdout at the null device before any engine call and keeps
// the real stdout for events only. Exit 0 after {"event":"done"}, exit 1 after
// {"event":"error","stage":"<word>"}, or exit 2 after the usage stage (the Go flag convention),
// so a spec typo never reads as a pairing failure.
package main

import (
	"encoding/json"
	"os"
	"sync"
)

// events writes the harness's JSON lines to the real stdout. exit is a field
// so a Go test can drive a mode in process: os.Exit in a test binary would
// take the whole run down, and the modes end by exiting on purpose.
type events struct {
	mu   sync.Mutex
	enc  *json.Encoder
	exit func(int)
}

func (e *events) emit(v map[string]interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(v)
}

// fail emits an error event with a fixed stage word and exits 1.
func (e *events) fail(stage string) {
	e.emit(map[string]interface{}{"event": "error", "stage": stage})
	e.exit(1)
}

// usage emits the usage stage and exits 2.
func (e *events) usage() {
	e.emit(map[string]interface{}{"event": "error", "stage": "usage"})
	e.exit(2)
}

func main() {
	ev := &events{enc: json.NewEncoder(os.Stdout), exit: os.Exit}
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		ev.fail("init")
	}
	os.Stdout = devNull

	if len(os.Args) < 2 {
		ev.usage()
	}
	switch os.Args[1] {
	case "host":
		runHost(ev, os.Args[2:])
	case "send":
		runSend(ev, os.Args[2:])
	case "request":
		runRequest(ev, os.Args[2:])
	default:
		ev.usage()
	}
}
