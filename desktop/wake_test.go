package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

// newTestGuard returns a guard whose platform hooks are counters, so the pure
// state machine can be exercised without any OS call (and on any platform).
func newTestGuard() (g *wakeGuard, blocks, allows *int) {
	var b, a int
	g = &wakeGuard{
		onBlock: func() { b++ },
		onAllow: func() { a++ },
	}
	return g, &b, &a
}

func TestWakeGuardAcquireReleaseIdempotent(t *testing.T) {
	g, blocks, allows := newTestGuard()

	g.acquire(1)
	if *blocks != 1 || *allows != 0 || g.owner == 0 {
		t.Fatalf("after acquire: blocks=%d allows=%d owner=%d, want 1/0/held", *blocks, *allows, g.owner)
	}
	g.acquire(1) // idempotent: must not block twice
	if *blocks != 1 {
		t.Fatalf("re-acquire called onBlock again: blocks=%d, want 1", *blocks)
	}

	g.release(1)
	if *allows != 1 || g.owner != 0 {
		t.Fatalf("after release: allows=%d owner=%d, want 1/0", *allows, g.owner)
	}
	g.release(1) // idempotent: must not allow twice
	if *allows != 1 {
		t.Fatalf("re-release called onAllow again: allows=%d, want 1", *allows)
	}
}

func TestWakeGuardReleaseWithoutAcquire(t *testing.T) {
	g, blocks, allows := newTestGuard()
	g.release(1) // no matching acquire: must be a no-op
	if *blocks != 0 || *allows != 0 || g.owner != 0 {
		t.Fatalf("release without acquire: blocks=%d allows=%d owner=%d, want 0/0/0", *blocks, *allows, g.owner)
	}
}

func TestWakeGuardReuse(t *testing.T) {
	g, blocks, allows := newTestGuard()
	for i := uint64(1); i <= 3; i++ {
		g.acquire(i)
		g.release(i)
	}
	if *blocks != 3 || *allows != 3 {
		t.Fatalf("reuse: blocks=%d allows=%d, want 3/3", *blocks, *allows)
	}
}

// TestWakeGuardStolenReleaseIgnored pins the ownership contract: a superseded
// generation's deferred release must not drop the inhibitor a newer transfer
// holds (the old boolean guard's exact bug), and ownership transfer must not
// re-fire the platform hook.
func TestWakeGuardStolenReleaseIgnored(t *testing.T) {
	g, blocks, allows := newTestGuard()

	g.acquire(1)
	g.acquire(2) // newer transfer takes ownership; still one block
	if *blocks != 1 || g.owner != 2 {
		t.Fatalf("after ownership transfer: blocks=%d owner=%d, want 1/2", *blocks, g.owner)
	}
	g.release(1) // the dead generation's deferred release: must be ignored
	if *allows != 0 || g.owner != 2 {
		t.Fatalf("stolen release dropped the inhibitor: allows=%d owner=%d, want 0/2", *allows, g.owner)
	}
	g.release(3) // a generation that never held it: no-op
	if *allows != 0 || g.owner != 2 {
		t.Fatalf("stranger release dropped the inhibitor: allows=%d owner=%d, want 0/2", *allows, g.owner)
	}
	g.release(2) // the true owner releases
	if *allows != 1 || g.owner != 0 {
		t.Fatalf("owner release: allows=%d owner=%d, want 1/0", *allows, g.owner)
	}
}

// TestWakeGuardConcurrent hammers acquire/release from many goroutines with
// unique generations to prove the mutex keeps owner/onBlock/onAllow consistent
// (meaningful under -race). Ownership transfers fire no hooks, so every
// not-held->held transition (onBlock) is balanced by a held->not-held one
// (onAllow), and the guard must end released: each generation acquires before
// it releases, so the final owner's release can never have run early.
func TestWakeGuardConcurrent(t *testing.T) {
	var blocks, allows int64
	var genCounter uint64
	g := &wakeGuard{
		onBlock: func() { atomic.AddInt64(&blocks, 1) },
		onAllow: func() { atomic.AddInt64(&allows, 1) },
	}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				gen := atomic.AddUint64(&genCounter, 1)
				g.acquire(gen)
				g.release(gen)
			}
		}()
	}
	wg.Wait()

	if g.owner != 0 {
		t.Fatalf("guard still held by generation %d after all goroutines finished", g.owner)
	}
	if b, a := atomic.LoadInt64(&blocks), atomic.LoadInt64(&allows); b != a || b == 0 {
		t.Fatalf("unbalanced transitions: blocks=%d allows=%d", b, a)
	}
}
