package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

// testLaneRequest stands in for the second lane in these tests. The production
// request lane constant arrives with the request lane itself, so this one
// carries a test-only name that cannot collide with it. The guard must already
// keep lanes apart, which is what the per-lane tests below pin.
const testLaneRequest = "request"

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

	g.acquire(laneTransfer, 1)
	if *blocks != 1 || *allows != 0 || g.owners[laneTransfer] == 0 {
		t.Fatalf("after acquire: blocks=%d allows=%d owner=%d, want 1/0/held", *blocks, *allows, g.owners[laneTransfer])
	}
	g.acquire(laneTransfer, 1) // idempotent: must not block twice
	if *blocks != 1 {
		t.Fatalf("re-acquire called onBlock again: blocks=%d, want 1", *blocks)
	}

	g.release(laneTransfer, 1)
	if *allows != 1 || len(g.owners) != 0 {
		t.Fatalf("after release: allows=%d owners=%v, want 1/empty", *allows, g.owners)
	}
	g.release(laneTransfer, 1) // idempotent: must not allow twice
	if *allows != 1 {
		t.Fatalf("re-release called onAllow again: allows=%d, want 1", *allows)
	}
}

func TestWakeGuardReleaseWithoutAcquire(t *testing.T) {
	g, blocks, allows := newTestGuard()
	g.release(laneTransfer, 1) // no matching acquire: must be a no-op
	if *blocks != 0 || *allows != 0 || len(g.owners) != 0 {
		t.Fatalf("release without acquire: blocks=%d allows=%d owners=%v, want 0/0/empty", *blocks, *allows, g.owners)
	}
}

func TestWakeGuardReuse(t *testing.T) {
	g, blocks, allows := newTestGuard()
	for i := uint64(1); i <= 3; i++ {
		g.acquire(laneTransfer, i)
		g.release(laneTransfer, i)
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

	g.acquire(laneTransfer, 1)
	g.acquire(laneTransfer, 2) // newer transfer takes ownership; still one block
	if *blocks != 1 || g.owners[laneTransfer] != 2 {
		t.Fatalf("after ownership transfer: blocks=%d owner=%d, want 1/2", *blocks, g.owners[laneTransfer])
	}
	g.release(laneTransfer, 1) // the dead generation's deferred release: must be ignored
	if *allows != 0 || g.owners[laneTransfer] != 2 {
		t.Fatalf("stolen release dropped the inhibitor: allows=%d owner=%d, want 0/2", *allows, g.owners[laneTransfer])
	}
	g.release(laneTransfer, 3) // a generation that never held it: no-op
	if *allows != 0 || g.owners[laneTransfer] != 2 {
		t.Fatalf("stranger release dropped the inhibitor: allows=%d owner=%d, want 0/2", *allows, g.owners[laneTransfer])
	}
	g.acquire(laneTransfer, 1) // a DEAD generation acquiring late must not steal ownership back
	if g.owners[laneTransfer] != 2 || *blocks != 1 {
		t.Fatalf("stale acquire stole ownership: owner=%d blocks=%d, want 2/1", g.owners[laneTransfer], *blocks)
	}
	g.release(laneTransfer, 1) // and its deferred release stays a no-op
	if *allows != 0 || g.owners[laneTransfer] != 2 {
		t.Fatalf("stale acquire+release dropped the inhibitor: allows=%d owner=%d, want 0/2", *allows, g.owners[laneTransfer])
	}
	g.release(laneTransfer, 2) // the true owner releases
	if *allows != 1 || len(g.owners) != 0 {
		t.Fatalf("owner release: allows=%d owners=%v, want 1/empty", *allows, g.owners)
	}
}

// TestWakeGuardConcurrent hammers acquire/release from many goroutines with
// unique generations to prove the mutex keeps owners/onBlock/onAllow consistent
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
				g.acquire(laneTransfer, gen)
				g.release(laneTransfer, gen)
			}
		}()
	}
	wg.Wait()

	if len(g.owners) != 0 {
		t.Fatalf("guard still held after all goroutines finished: owners=%v", g.owners)
	}
	if b, a := atomic.LoadInt64(&blocks), atomic.LoadInt64(&allows); b != a || b == 0 {
		t.Fatalf("unbalanced transitions: blocks=%d allows=%d", b, a)
	}
}

// TestWakeGuardTwoLanes pins that lanes hold the inhibitor independently: the
// transfer lane letting go must not drop it while the request lane still
// holds a share, and the last share's release allows sleep exactly once.
func TestWakeGuardTwoLanes(t *testing.T) {
	g, blocks, allows := newTestGuard()

	g.acquire(laneTransfer, 1)
	g.acquire(testLaneRequest, 1)
	g.release(laneTransfer, 1)
	if *allows != 0 {
		t.Fatalf("transfer release dropped the inhibitor under a held request lane: allows=%d, want 0", *allows)
	}
	if g.owners[testLaneRequest] != 1 {
		t.Fatalf("request lane lost its share: owners=%v, want request=1", g.owners)
	}
	g.release(testLaneRequest, 1)
	if *allows != 1 || len(g.owners) != 0 {
		t.Fatalf("last release: allows=%d owners=%v, want exactly 1/empty", *allows, g.owners)
	}
	if *blocks != 1 {
		t.Fatalf("two lanes blocked %d times, want 1", *blocks)
	}
}

// TestWakeGuardStalePerLane pins that the stale-generation refusal compares
// generations within one lane only: lanes number their generations
// independently, so a low request generation is not a dead goroutine just
// because the transfer lane has counted higher.
func TestWakeGuardStalePerLane(t *testing.T) {
	g, blocks, allows := newTestGuard()

	g.acquire(laneTransfer, 2)
	g.acquire(laneTransfer, 1) // stale within the transfer lane: refused
	if g.owners[laneTransfer] != 2 || *blocks != 1 {
		t.Fatalf("stale transfer acquire: owner=%d blocks=%d, want 2/1", g.owners[laneTransfer], *blocks)
	}
	g.acquire(testLaneRequest, 1) // below the transfer generation, but another lane: taken
	if got, ok := g.owners[testLaneRequest]; !ok || got != 1 {
		t.Fatalf("request generation 1 refused by the transfer lane's generation 2: owners=%v", g.owners)
	}
	if g.owners[laneTransfer] != 2 || *blocks != 1 || *allows != 0 {
		t.Fatalf("request acquire disturbed the transfer lane: owners=%v blocks=%d allows=%d, want transfer=2 1/0", g.owners, *blocks, *allows)
	}
	g.release(laneTransfer, 1) // the refused transfer generation's deferred release: no-op
	if g.owners[laneTransfer] != 2 || *allows != 0 {
		t.Fatalf("stale transfer release: owners=%v allows=%d, want transfer=2 0", g.owners, *allows)
	}
}

// TestWakeGuardHooksOnTransitionsOnly pins that the platform hooks fire only
// on the empty to non-empty and non-empty to empty switches of the whole
// guard: never for a second lane joining, a lane's ownership transfer, or a
// lane leaving while another still holds. That is what keeps one parked
// inhibitor thread in wake_windows.go.
func TestWakeGuardHooksOnTransitionsOnly(t *testing.T) {
	g, blocks, allows := newTestGuard()

	g.acquire(laneTransfer, 1)    // empty -> non-empty
	g.acquire(testLaneRequest, 1) // second lane joins
	g.acquire(laneTransfer, 2)    // ownership transfer within a lane
	g.acquire(testLaneRequest, 3) // and within the other lane
	if *blocks != 1 || *allows != 0 {
		t.Fatalf("while held: blocks=%d allows=%d, want 1/0", *blocks, *allows)
	}
	g.release(testLaneRequest, 3) // one lane leaves, the other still holds
	if *blocks != 1 || *allows != 0 {
		t.Fatalf("after first lane left: blocks=%d allows=%d, want 1/0", *blocks, *allows)
	}
	g.acquire(testLaneRequest, 4) // it rejoins while the guard is still held
	g.release(laneTransfer, 2)
	if *blocks != 1 || *allows != 0 {
		t.Fatalf("after lanes swapped: blocks=%d allows=%d, want 1/0", *blocks, *allows)
	}
	g.release(testLaneRequest, 4) // non-empty -> empty
	if *blocks != 1 || *allows != 1 {
		t.Fatalf("after last release: blocks=%d allows=%d, want 1/1", *blocks, *allows)
	}
	g.acquire(testLaneRequest, 5) // a fresh empty -> non-empty fires again
	if *blocks != 2 || *allows != 1 {
		t.Fatalf("after re-acquire: blocks=%d allows=%d, want 2/1", *blocks, *allows)
	}
}

// TestWakeGuardSupersededTransferStillHeld pins the Send and Receive
// supersede path on the lane map: a newer transfer acquires before the
// superseded goroutine's deferred release runs, and that release must leave
// the inhibitor held for the live transfer.
func TestWakeGuardSupersededTransferStillHeld(t *testing.T) {
	g, blocks, allows := newTestGuard()

	g.acquire(laneTransfer, 1)
	g.acquire(laneTransfer, 2)
	g.release(laneTransfer, 1) // the superseded goroutine's deferred release
	if *allows != 0 || g.owners[laneTransfer] != 2 {
		t.Fatalf("superseded release dropped the live transfer's share: allows=%d owners=%v, want 0 transfer=2", *allows, g.owners)
	}
	if *blocks != 1 {
		t.Fatalf("supersede re-fired onBlock: blocks=%d, want 1", *blocks)
	}
	g.release(laneTransfer, 2)
	if *allows != 1 || len(g.owners) != 0 {
		t.Fatalf("live transfer release: allows=%d owners=%v, want 1/empty", *allows, g.owners)
	}
}

// TestWakeGuardReleaseWithoutAcquirePerLane pins that a release with no
// matching acquire is a no-op for its own lane only: it neither drops another
// lane's share nor fires a hook, on an empty guard or on a held one.
func TestWakeGuardReleaseWithoutAcquirePerLane(t *testing.T) {
	g, blocks, allows := newTestGuard()

	g.release(testLaneRequest, 1) // empty guard
	g.release(laneTransfer, 1)
	if *blocks != 0 || *allows != 0 || len(g.owners) != 0 {
		t.Fatalf("release on an empty guard: blocks=%d allows=%d owners=%v, want 0/0/empty", *blocks, *allows, g.owners)
	}

	g.acquire(laneTransfer, 1)
	g.release(testLaneRequest, 1) // same generation number, but a lane that never acquired
	g.release(testLaneRequest, 0)
	if *allows != 0 || len(g.owners) != 1 || g.owners[laneTransfer] != 1 {
		t.Fatalf("request release without acquire touched the transfer share: allows=%d owners=%v, want 0 transfer=1", *allows, g.owners)
	}
	if _, ok := g.owners[testLaneRequest]; ok {
		t.Fatalf("release without acquire created a request share: owners=%v", g.owners)
	}
	g.release(laneTransfer, 1)
	if *blocks != 1 || *allows != 1 || len(g.owners) != 0 {
		t.Fatalf("after the transfer release: blocks=%d allows=%d owners=%v, want 1/1/empty", *blocks, *allows, g.owners)
	}
}
