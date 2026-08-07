//go:build windows

package main

import (
	goruntime "runtime"
	"testing"
)

// TestSetThreadExecutionStateSetsSystemRequired proves the real syscall used by
// blockSleep registers ES_SYSTEM_REQUIRED. Because the execution state is
// per-thread, it runs on a locked OS thread: it sets the continuous
// system-required state, then clears it. The clearing call returns the PREVIOUS
// state, which must carry the ES_SYSTEM_REQUIRED bit the first call set. The
// thread ends in ES_CONTINUOUS only, so the machine can sleep normally (this
// test does not leave the run host awake). Admin-free and deterministic.
func TestSetThreadExecutionStateSetsSystemRequired(t *testing.T) {
	done := make(chan uintptr, 1)
	go func() {
		goruntime.LockOSThread()
		defer goruntime.UnlockOSThread()
		procSetThreadExecutionState.Call(uintptr(esContinuous | esSystemRequired))
		prev, _, _ := procSetThreadExecutionState.Call(uintptr(esContinuous))
		done <- prev
	}()
	prev := <-done

	if prev == 0 {
		t.Fatal("SetThreadExecutionState returned 0 (the call failed)")
	}
	if prev&esSystemRequired == 0 {
		t.Fatalf("previous state = %#x, missing ES_SYSTEM_REQUIRED (%#x)", prev, esSystemRequired)
	}
}
