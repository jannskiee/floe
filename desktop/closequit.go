package main

// The quit retry: a close the app agreed to is asked for again until the
// shutdown hook runs.

import (
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Measured 2026-09-25 (the CP-UI close probe, a UIA-driven built exe): after a
// request link's prompt had been up about 25 s and the link was closed, the
// next close request (the titlebar X or a WM_CLOSE) reached onBeforeClose,
// which returned false, yet shutdown never ran and the window stayed, in about
// half the runs, on builds back to 6dd5c3f. A goroutine dump of a stuck
// process held only Wails' idle message loop, so the quit Wails posts
// (PostQuitMessage through winc.Exit) was consumed by something on the UI
// thread rather than blocked; what consumed it is not identified, and neither
// Wails nor go-webview2 runs a nested message loop in Go after startup. A
// second close request quit in every stuck run, and in the retry's own live
// run one first retry was lost as well (1 of 8), hence three. So once
// onBeforeClose has let a close through, ask again after quitRetryFirst, then
// twice as long each time, until shutdown starts. A normal close reaches
// shutdown 63 to 76 ms after onBeforeClose, so an early retry changes nothing:
// shutdown sets shuttingDown before anything else, and a second
// PostQuitMessage on a thread already leaving its loop is dropped.
const (
	quitRetryFirst = 500 * time.Millisecond
	quitRetries    = 3
)

// requestQuit asks Wails to quit. runtime.Quit re-enters onBeforeClose first,
// which is why the retry checks closeBlocked before asking: a close that
// became blocked would otherwise pop the guard. ctx is read under mu, the way
// setTitle does, and a nil one (before startup stored it, or a bare test App)
// asks nothing, where runtime.Quit would log.Fatal.
func (a *App) requestQuit() {
	if a.quitFn != nil {
		a.quitFn()
		return
	}
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.Quit(ctx)
	}
}

// armQuitRetry starts a retry loop unless one is running: every retried quit
// re-enters onBeforeClose, which finds it armed and returns. The loop disarms
// when it ends, so a later accepted close (a Close anyway after the loop stood
// down) gets a retry of its own.
func (a *App) armQuitRetry() {
	if !a.quitRetryArmed.CompareAndSwap(false, true) {
		return
	}
	wait := a.quitRetryWait
	if wait <= 0 {
		wait = quitRetryFirst
	}
	go func() {
		defer a.quitRetryArmed.Store(false)
		for i := 0; i < quitRetries; i++ {
			time.Sleep(wait)
			wait *= 2
			// Blocked now means the close was lost and the owner, seeing the
			// window still up, started something: stand down without asking,
			// because asking would pop the close guard unprompted.
			if a.shuttingDown.Load() || a.closeBlocked() {
				return
			}
			a.requestQuit()
		}
	}()
}
