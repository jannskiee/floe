// Command floe-e2ehost is a test-only Go peer that the Playwright suite drives
// as a program. It is never part of a release: .goreleaser.yml builds only
// ./cmd/floe, and client/e2e/global-setup.ts builds this into the e2e temp
// directory for the length of one run.
//
// Usage:
//
//	floe-e2ehost host -out <dir> [-server URL] [-room UUID] [-hold D] [-timeout D]
//
// The first argument is a mode word, so later modes can be added beside host.
//
// Output contract: stdout carries one JSON event per line and nothing else,
// every value in it either a fixed word, the room id the caller passed or the
// harness generated, the role the signaling server assigned, or a count. The
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

// events writes the harness's JSON lines to the real stdout.
type events struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (e *events) emit(v map[string]interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(v)
}

// fail emits an error event with a fixed stage word and exits 1.
func (e *events) fail(stage string) {
	e.emit(map[string]interface{}{"event": "error", "stage": stage})
	os.Exit(1)
}

// usage emits the usage stage and exits 2.
func (e *events) usage() {
	e.emit(map[string]interface{}{"event": "error", "stage": "usage"})
	os.Exit(2)
}

func main() {
	ev := &events{enc: json.NewEncoder(os.Stdout)}
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
	default:
		ev.usage()
	}
}
