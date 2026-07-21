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

	g.acquire()
	if *blocks != 1 || *allows != 0 || !g.held {
		t.Fatalf("after acquire: blocks=%d allows=%d held=%v, want 1/0/true", *blocks, *allows, g.held)
	}
	g.acquire() // idempotent: must not block twice
	if *blocks != 1 {
		t.Fatalf("re-acquire called onBlock again: blocks=%d, want 1", *blocks)
	}

	g.release()
	if *allows != 1 || g.held {
		t.Fatalf("after release: allows=%d held=%v, want 1/false", *allows, g.held)
	}
	g.release() // idempotent: must not allow twice
	if *allows != 1 {
		t.Fatalf("re-release called onAllow again: allows=%d, want 1", *allows)
	}
}

func TestWakeGuardReleaseWithoutAcquire(t *testing.T) {
	g, blocks, allows := newTestGuard()
	g.release() // no matching acquire: must be a no-op
	if *blocks != 0 || *allows != 0 || g.held {
		t.Fatalf("release without acquire: blocks=%d allows=%d held=%v, want 0/0/false", *blocks, *allows, g.held)
	}
}

func TestWakeGuardReuse(t *testing.T) {
	g, blocks, allows := newTestGuard()
	for i := 0; i < 3; i++ {
		g.acquire()
		g.release()
	}
	if *blocks != 3 || *allows != 3 {
		t.Fatalf("reuse: blocks=%d allows=%d, want 3/3", *blocks, *allows)
	}
}

// TestWakeGuardConcurrent hammers acquire/release from many goroutines to prove
// the mutex keeps held/onBlock/onAllow consistent (meaningful under -race). The
// hooks run under the guard's lock, so plain counters would suffice, but atomics
// keep the post-join read unambiguous. Every not-held->held transition (onBlock)
// must be balanced by a held->not-held one (onAllow), and the guard must end
// released, because the globally last operation is always a release().
func TestWakeGuardConcurrent(t *testing.T) {
	var blocks, allows int64
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
				g.acquire()
				g.release()
			}
		}()
	}
	wg.Wait()

	if g.held {
		t.Fatal("guard still held after all goroutines finished")
	}
	if b, a := atomic.LoadInt64(&blocks), atomic.LoadInt64(&allows); b != a || b == 0 {
		t.Fatalf("unbalanced transitions: blocks=%d allows=%d", b, a)
	}
}
