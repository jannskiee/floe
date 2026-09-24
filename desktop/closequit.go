package main

// The quit retry: a close the app agreed to is asked for again until the
// shutdown hook runs.

import (
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Measured 2026-09-25 (CP-UI close probe, 14-test-evidence/CP-UI/walkthrough):
// after a request link's prompt had been up about 25 s and the link was closed,
// the next close request (the titlebar X or a WM_CLOSE) reached onBeforeClose,
// which returned false, yet shutdown never ran and the window stayed, in about
// half the runs, on builds back to 6dd5c3f. A goroutine dump of a stuck process
// showed only Wails' idle message loop: the quit Wails posts (PostQuitMessage
// through winc.Exit) was lost on the UI thread, not blocked. A second close
// request quit every time. So once onBeforeClose has let a close through, ask
// again after quitRetryAfter, up to quitRetries times, until shutdown starts.
// Asking again when the first quit got through is harmless: shutdown sets
// shuttingDown before anything else, and a second PostQuitMessage on a thread
// that is already leaving its loop changes nothing.
const (
	quitRetryAfter = 1500 * time.Millisecond
	quitRetries    = 3
)

// requestQuit asks Wails to quit: runtime.Quit re-enters onBeforeClose first,
// exactly as a close request does, so a close that became blocked in the
// meantime (a transfer started) still shows the guard instead of quitting.
func (a *App) requestQuit() {
	if a.quitFn != nil {
		a.quitFn()
		return
	}
	runtime.Quit(a.ctx)
}

// armQuitRetry starts the retry once per process; later calls (every retried
// quit re-enters onBeforeClose) find it armed and return.
func (a *App) armQuitRetry() {
	if !a.quitRetryArmed.CompareAndSwap(false, true) {
		return
	}
	wait := a.quitRetryWait
	if wait <= 0 {
		wait = quitRetryAfter
	}
	go func() {
		for i := 0; i < quitRetries; i++ {
			time.Sleep(wait)
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
