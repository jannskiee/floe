//go:build windows

package main

import (
	goruntime "runtime"
)

// Power-management flags for SetThreadExecutionState. Untyped constants so they
// convert cleanly to uintptr on 64-bit Windows (0x80000000 overflows int32).
const (
	esContinuous     = 0x80000000 // the state persists until the next call changes it
	esSystemRequired = 0x00000001 // keep the machine awake (deliberately NOT the display)
)

// procSetThreadExecutionState reuses the kernel32 lazy DLL declared in
// clipboard_windows.go (same package main, both windows-tagged).
var procSetThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")

// wakeStop signals the parked inhibitor goroutine to release its wake request.
// It is written only during wakeGuard's mu-protected state transition and, since
// Floe runs one transfer at a time, never concurrently. If concurrent transfers
// are ever added, replace this parked-goroutine model with a ticker + refcount:
// N parked threads each holding ES_CONTINUOUS do not compose.
var wakeStop chan struct{}

// blockSleep asks Windows to keep the system awake until allowSleep is called.
//
// SetThreadExecutionState's ES_CONTINUOUS state is per-OS-thread, but Go moves
// goroutines between threads, so the acquiring and releasing calls must run on
// the SAME thread. We dedicate one locked OS thread: it sets the flag, parks
// until released, then clears the flag and exits (unlocking the thread). We set
// only ES_SYSTEM_REQUIRED (not ES_DISPLAY_REQUIRED), so the screen may still
// power off; only the machine stays awake. This is a best-effort hint: it does
// not override a lid close or a manual sleep, and a failed call is ignored (the
// transfer proceeds regardless), matching the app's best-effort notify().
func blockSleep() {
	if wakeStop != nil {
		return
	}
	stop := make(chan struct{})
	ready := make(chan struct{})
	wakeStop = stop
	go func() {
		goruntime.LockOSThread()
		defer goruntime.UnlockOSThread()
		procSetThreadExecutionState.Call(uintptr(esContinuous | esSystemRequired))
		close(ready)
		<-stop
		procSetThreadExecutionState.Call(uintptr(esContinuous)) // clear the requirement
	}()
	<-ready
}

// allowSleep releases the wake request set by blockSleep. Safe if none is held.
func allowSleep() {
	if wakeStop == nil {
		return
	}
	close(wakeStop)
	wakeStop = nil
}
