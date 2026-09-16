package main

import "sync"

// laneTransfer is the lane of the one-at-a-time Send and code Receive flows
// (beginTransfer's generations). Each lane numbers its own generations, so a
// generation only means something next to the lane it belongs to.
const laneTransfer = "transfer"

// wakeGuard is a concurrency-safe on/off switch for a system sleep inhibitor,
// shared by independent lanes. Each lane holds at most one share, tagged with
// the generation that took it: acquire(lane, g) takes (or keeps) that lane's
// share for generation g; release(lane, g) drops it only when g still owns it.
// The inhibitor is on while any lane holds a share. The ownership tag is what
// stops a superseded goroutine's unconditional deferred release from dropping
// the inhibitor under the live attempt of the same lane that acquired it
// moments earlier (releases may have no matching acquire, so a refcount would
// break the same way). The platform effect is delegated to onBlock/onAllow
// (wired to blockSleep/allowSleep by newWakeGuard); tests inject recorder
// funcs instead of touching the OS.
//
// The platform hook is invoked INSIDE the mu-protected state transition, and
// only when owners goes from empty to non-empty (onBlock) or from non-empty to
// empty (onAllow), whatever the number of lanes. That is what makes
// wake_windows.go's package-level stop channel safe: it is only ever touched
// during one of those two switches, which mu serializes across every lane. Do
// not move the hook calls outside the lock, and do not give a lane a guard of
// its own (two guards would fight over that one channel).
type wakeGuard struct {
	mu sync.Mutex
	// owners maps a lane to the generation holding that lane's share. An absent
	// lane is not held, and a stored generation is never 0 (generations start
	// at 1). Allocated on first use, so a zero-value guard works.
	owners  map[string]uint64
	onBlock func()
	onAllow func()
}

// newWakeGuard returns a guard wired to the real platform sleep inhibitor.
func newWakeGuard() *wakeGuard {
	return &wakeGuard{onBlock: blockSleep, onAllow: allowSleep}
}

// acquire asks the system to stay awake on behalf of generation g of lane.
// The platform hook fires only when no lane held a share before; a newer
// generation acquiring over an older one of the same lane just transfers that
// lane's share, and a second lane joining an already held guard fires nothing.
func (w *wakeGuard) acquire(lane string, g uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	cur := w.owners[lane] // 0 when the lane holds no share
	if cur == g {
		return
	}
	// Generations only grow within a lane, so an acquire from below the lane's
	// current owner is a dead goroutine that lost a race (e.g. its
	// success-branch select already had a buffered message when the user
	// cancelled). Refusing here keeps the documented invariant that a
	// superseded attempt can never touch the inhibitor: accepting would hand
	// the lane's share to the corpse, whose deferred release would then drop
	// the wake lock under the live attempt. Other lanes' generations are never
	// compared: they count independently.
	if g < cur {
		return
	}
	if w.owners == nil {
		w.owners = make(map[string]uint64)
	}
	wasHeld := len(w.owners) != 0
	w.owners[lane] = g
	if !wasHeld {
		w.onBlock()
	}
}

// release drops lane's share, but only when generation g still owns it, and
// lets the system sleep again once no lane holds a share. Safe to call
// repeatedly and without a matching acquire.
func (w *wakeGuard) release(lane string, g uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	cur, held := w.owners[lane]
	if !held || cur != g {
		return
	}
	delete(w.owners, lane)
	if len(w.owners) == 0 {
		w.onAllow()
	}
}
