package main

import "sync"

// wakeGuard is an idempotent, concurrency-safe on/off switch for a system sleep
// inhibitor. acquire() turns it on once, release() turns it off once, and repeat
// calls in either direction are no-ops. The platform effect is delegated to
// onBlock/onAllow (wired to blockSleep/allowSleep by newWakeGuard); tests inject
// recorder funcs instead of touching the OS.
//
// The platform hook is invoked INSIDE the mu-protected state transition. That is
// what makes wake_windows.go's package-level stop channel safe: it is only ever
// touched during the not-held -> held (or held -> not-held) switch, which mu
// serializes. Do not move the hook calls outside the lock.
type wakeGuard struct {
	mu      sync.Mutex
	held    bool
	onBlock func()
	onAllow func()
}

// newWakeGuard returns a guard wired to the real platform sleep inhibitor.
func newWakeGuard() *wakeGuard {
	return &wakeGuard{onBlock: blockSleep, onAllow: allowSleep}
}

// acquire asks the system to stay awake. Safe to call repeatedly; only the first
// call while released has any effect.
func (w *wakeGuard) acquire() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.held {
		return
	}
	w.held = true
	w.onBlock()
}

// release lets the system sleep again. Safe to call repeatedly, including without
// a matching acquire; only the first call while held has any effect.
func (w *wakeGuard) release() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.held {
		return
	}
	w.held = false
	w.onAllow()
}
