package main

import "sync"

// wakeGuard is a concurrency-safe on/off switch for a system sleep inhibitor,
// owned by a transfer generation. acquire(g) takes (or keeps) the inhibitor
// for generation g; release(g) turns it off only when g still owns it. The
// ownership tag is what stops a superseded transfer goroutine's unconditional
// deferred release from dropping the inhibitor under the live transfer that
// acquired it moments earlier (releases may have no matching acquire, so a
// refcount would break the same way). The platform effect is delegated to
// onBlock/onAllow (wired to blockSleep/allowSleep by newWakeGuard); tests
// inject recorder funcs instead of touching the OS.
//
// The platform hook is invoked INSIDE the mu-protected state transition. That is
// what makes wake_windows.go's package-level stop channel safe: it is only ever
// touched during the not-held -> held (or held -> not-held) switch, which mu
// serializes. Do not move the hook calls outside the lock.
type wakeGuard struct {
	mu      sync.Mutex
	owner   uint64 // generation currently holding the inhibitor; 0 = not held (generations start at 1)
	onBlock func()
	onAllow func()
}

// newWakeGuard returns a guard wired to the real platform sleep inhibitor.
func newWakeGuard() *wakeGuard {
	return &wakeGuard{onBlock: blockSleep, onAllow: allowSleep}
}

// acquire asks the system to stay awake on behalf of generation g. The platform
// hook fires only on the not-held -> held transition; a newer generation
// acquiring over an older one just transfers ownership.
func (w *wakeGuard) acquire(g uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.owner == g {
		return
	}
	// Generations only grow, so an acquire from below the current owner is a
	// dead goroutine that lost a race (e.g. its success-branch select already
	// had a buffered message when the user cancelled). Refusing here keeps the
	// documented invariant that a superseded attempt can never touch the
	// inhibitor: accepting would hand ownership to the corpse, whose deferred
	// release would then drop the wake lock under the live transfer.
	if g < w.owner {
		return
	}
	wasHeld := w.owner != 0
	w.owner = g
	if !wasHeld {
		w.onBlock()
	}
}

// release lets the system sleep again, but only when generation g still owns
// the inhibitor. Safe to call repeatedly and without a matching acquire.
func (w *wakeGuard) release(g uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.owner != g || w.owner == 0 {
		return
	}
	w.owner = 0
	w.onAllow()
}
