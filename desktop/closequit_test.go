package main

// The quit retry (closequit.go): a close onBeforeClose agreed to is asked for
// again, a bounded number of times, until the shutdown hook runs.

import (
	"sync/atomic"
	"testing"
	"time"
)

// waitQuits polls until quits reaches want or the deadline passes, then gives
// any extra call a moment to land so an unbounded retry would show.
func waitQuits(quits *atomic.Int32, want int32) int32 {
	deadline := time.Now().Add(2 * time.Second)
	for quits.Load() < want && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	return quits.Load()
}

// TestOnBeforeCloseRetriesQuitUntilShutdown: with no transfer and no live
// link, onBeforeClose lets the close through and, since shutdown never runs
// here, asks to quit again quitRetries times and then stops.
func TestOnBeforeCloseRetriesQuitUntilShutdown(t *testing.T) {
	var quits atomic.Int32
	a := &App{quitFn: func() { quits.Add(1) }, quitRetryWait: 5 * time.Millisecond}
	if a.onBeforeClose(nil) {
		t.Fatal("an idle app blocked its own close")
	}
	if got := waitQuits(&quits, quitRetries); got != quitRetries {
		t.Fatalf("quit asked again %d times, want exactly %d", got, quitRetries)
	}
}

// TestQuitRetryStopsOnceShutdownRuns: when the first quit gets through, the
// shutdown hook runs and no second quit is asked for.
func TestQuitRetryStopsOnceShutdownRuns(t *testing.T) {
	var quits atomic.Int32
	a := &App{quitFn: func() { quits.Add(1) }, quitRetryWait: 20 * time.Millisecond}
	if a.onBeforeClose(nil) {
		t.Fatal("an idle app blocked its own close")
	}
	a.shutdown(nil)
	if got := waitQuits(&quits, 1); got != 0 {
		t.Fatalf("quit asked again %d times after shutdown ran, want 0", got)
	}
}

// TestQuitRetryStandsDownWhenCloseBecomesBlocked: the close was lost, and the
// owner, seeing the window still up, started a transfer. The retry must not
// quit it, and must not ask either: runtime.Quit would re-enter onBeforeClose
// and pop the close guard seconds after the owner last touched the X.
func TestQuitRetryStandsDownWhenCloseBecomesBlocked(t *testing.T) {
	var quits atomic.Int32
	a := &App{quitFn: func() { quits.Add(1) }, quitRetryWait: 20 * time.Millisecond}
	if a.onBeforeClose(nil) {
		t.Fatal("an idle app blocked its own close")
	}
	a.beginTransfer()
	if got := waitQuits(&quits, 1); got != 0 {
		t.Fatalf("quit asked again %d times with a transfer running, want 0", got)
	}
}

// TestQuitRetryArmsOnce: every retried quit re-enters onBeforeClose (Wails
// asks it before each quit), and that must not start a second retry loop.
func TestQuitRetryArmsOnce(t *testing.T) {
	var quits atomic.Int32
	var a *App
	a = &App{quitRetryWait: 5 * time.Millisecond}
	a.quitFn = func() {
		quits.Add(1)
		a.onBeforeClose(nil) // what runtime.Quit does before it quits
	}
	a.onBeforeClose(nil)
	a.onBeforeClose(nil)
	if got := waitQuits(&quits, quitRetries); got != quitRetries {
		t.Fatalf("quit asked again %d times, want exactly %d (one retry loop)", got, quitRetries)
	}
}
