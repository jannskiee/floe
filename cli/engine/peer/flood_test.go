package peer_test

// F2-01 (DV-AUDIT CP-SE): what a peer's frames can pin in the host's memory
// while nothing reads the pump, through the real pairing (pairHostVisitor in
// hostreceive_test.go) and pion's own read loop.

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// floodBudget is the pump's byte budget (peer.EarlyBufferBytes): 256 frames
// of the largest chunk any Floe sender sends, 256 KiB. A literal, so these
// tests also run against code that predates the constant.
const floodBudget = 64 << 20

// settledLen waits until len(ch) has not changed for a second and returns it:
// by then pion's read loop is parked, either in the pump's handler or on an
// empty SCTP queue.
func settledLen[M any](ch <-chan M, most time.Duration) int {
	last, since := len(ch), time.Now()
	for deadline := time.Now().Add(most); time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
		if n := len(ch); n != last {
			last, since = n, time.Now()
		} else if time.Since(since) >= time.Second {
			break
		}
	}
	return last
}

// TestHostPumpBoundsFloodWhileDeciding: while Decide holds the receive loop
// (a person is deciding, for up to HostDecisionWindow), a visitor that sends
// frames far larger than any Floe chunk gets at most the byte budget of them
// into the host's pump. pion delivers 4 MiB frames, and the pump used to take
// up to 256 of them (1 GiB) before its count stopped it.
func TestHostPumpBoundsFloodWhileDeciding(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	const frame = 4 << 20
	const frames = 40 // 160 MiB: past the budget, under the pump's 256-frame count
	host, visitor := pairHostVisitor(t, newRelay(t))

	deciding := make(chan struct{})
	release := make(chan struct{})
	var decideOnce, releaseOnce sync.Once
	letGo := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(letGo)
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- transfer.ReceiveFilesWithOptions(host.dc, t.TempDir(), true, "", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			Decide: func(transfer.IncomingInfo) transfer.Decision {
				decideOnce.Do(func() { close(deciding) })
				select {
				case <-release:
				case <-host.early.Closed:
				}
				return transfer.Decision{Kind: transfer.DecisionDecline}
			},
			Messages: host.early.Msgs,
			Closed:   host.early.Closed,
		})
	}()

	meta, _ := json.Marshal(map[string]any{
		"type": "metadata", "id": "flood", "fileName": "a.bin", "fileSize": 4,
		"index": 1, "total": 1, "totalBytes": 4,
		"pv": transfer.ProtocolVersion, "pvMin": transfer.MinProtocolVersion,
	})
	if err := visitor.dc.SendText(string(meta)); err != nil {
		t.Fatalf("visitor metadata: %v", err)
	}
	select {
	case <-deciding:
	case <-time.After(10 * time.Second):
		t.Fatal("Decide never ran")
	}

	// Send while the visitor's own buffer drains; stop once it has not moved
	// for two seconds, which is the host no longer reading.
	payload := make([]byte, frame)
	sent := 0
	lastBuffered, moved := visitor.dc.BufferedAmount(), time.Now()
	for deadline := time.Now().Add(30 * time.Second); sent < frames && time.Now().Before(deadline); {
		b := visitor.dc.BufferedAmount()
		if b != lastBuffered {
			lastBuffered, moved = b, time.Now()
		}
		if b > 24<<20 {
			if time.Since(moved) > 2*time.Second {
				break
			}
			time.Sleep(20 * time.Millisecond)
			continue
		}
		if err := visitor.dc.Send(payload); err != nil {
			t.Fatalf("visitor frame %d: %v", sent+1, err)
		}
		sent++
	}
	queued := settledLen(host.early.Msgs, 15*time.Second)
	t.Logf("visitor sent %d frames of 4 MiB; the host's pump holds %d while Decide is open", sent, queued)
	if held := queued * frame; held > floodBudget {
		t.Fatalf("the host's pump holds %d frames of 4 MiB (%d MiB) while Decide is open, want at most %d MiB",
			queued, held>>20, floodBudget>>20)
	}

	letGo()
	select {
	case err := <-recvErr:
		if !errors.Is(err, transfer.ErrDeclined) {
			t.Fatalf("receive returned %v, want the decline", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receive did not return after the decline")
	}
}

// TestHostPumpReleasesOnCloseWhenFull: a pump left full by a reader that has
// gone (a receive that returned while the peer kept sending) must not pin
// pion's read loop, and every frame queued behind it, past the Connection's
// own Close. pion fires OnClose only when that loop exits, and the loop is the
// goroutine parked in the handler, so a handler that waits for the channel's
// close alone waits forever.
func TestHostPumpReleasesOnCloseWhenFull(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	host, visitor := pairHostVisitor(t, newRelay(t))

	// Nobody reads the host's pump: fill it past its 256-frame count.
	small := make([]byte, 1024)
	for i := 0; i < 300; i++ {
		if err := visitor.dc.Send(small); err != nil {
			t.Fatalf("visitor frame %d: %v", i+1, err)
		}
	}
	if n := settledLen(host.early.Msgs, 15*time.Second); n != cap(host.early.Msgs) {
		t.Fatalf("the host's pump holds %d frames, want it full at %d", n, cap(host.early.Msgs))
	}

	host.conn.Close()
	select {
	case <-host.early.Closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the host's data channel never reported its close after Connection.Close: " +
			"pion's read loop is parked in the pump's handler, holding every queued frame")
	}
}
