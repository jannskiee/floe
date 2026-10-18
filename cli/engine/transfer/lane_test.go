package transfer

// The lane exports (lane.go): the volume questions, the 24-hour cap and the
// open-channel deadline, the last driven the way the desktop lane drives it
// around a real receive loop.

import (
	"encoding/json"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// TestDropTimeLimitIs24Hours: the cap the desktop lane arms for each drop
// (requestDropCap in desktop/transfer.go) is 24 hours.
func TestDropTimeLimitIs24Hours(t *testing.T) {
	if DropTimeLimit != 24*time.Hour {
		t.Fatalf("DropTimeLimit = %v, want 24h", DropTimeLimit)
	}
}

// TestDiskFreeAndVolumeMaxOnThisPlatform: the exports answer for a real
// folder on Windows (free space positive, a maximum of 0 or FAT32's) and
// "unknown" everywhere else.
func TestDiskFreeAndVolumeMaxOnThisPlatform(t *testing.T) {
	dir := t.TempDir()
	free, freeErr := DiskFree(dir)
	max, maxErr := VolumeMaxFileSize(dir)
	if runtime.GOOS != "windows" {
		if free != -1 || freeErr != nil || max != 0 || maxErr != nil {
			t.Fatalf("DiskFree = %d, %v; VolumeMaxFileSize = %d, %v; want -1, nil and 0, nil", free, freeErr, max, maxErr)
		}
		return
	}
	if freeErr != nil || free <= 0 {
		t.Fatalf("DiskFree(%s) = %d, %v; want a positive count", dir, free, freeErr)
	}
	if maxErr != nil || (max != 0 && max != 4294967295) {
		t.Fatalf("VolumeMaxFileSize(%s) = %d, %v; want 0 or 4294967295", dir, max, maxErr)
	}
}

// TestIncomingDeadlineStopsAJunkFlood (E-35, R-01): a sender that keeps the
// channel busy with frames that are not a metadata, non-control strings and
// binary data with no file open, keeps the receive loop's idle watchdog from
// ever firing, because the watchdog only measures silence. The flood below
// runs well past the (shrunk) idle timeout and the loop is still waiting.
// The lane's deadline, started when the channel opened and never cancelled
// because no metadata came, fires on its own goroutine, tells the sender
// stopped and closes the channel, and the loop returns through its closed
// channel within 2 s of that.
func TestIncomingDeadlineStopsAJunkFlood(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	origIdle := receiveIdleTimeout
	receiveIdleTimeout = 300 * time.Millisecond
	t.Cleanup(func() { receiveIdleTimeout = origIdle })

	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}
	replies := make(chan []byte, 8)
	sender.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case replies <- m.Data:
		default:
		}
	})

	const deadline = 1500 * time.Millisecond
	expired := make(chan time.Time, 1)
	start := time.Now()
	cancel := StartIncomingDeadline(deadline, func() {
		AbortWithCode(rdc, "", CodeStopped, CodeStopped.WireReason(), 0)
		_ = rdc.Close()
		expired <- time.Now()
	})
	t.Cleanup(cancel)

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(rdc, outDir, true, "", "", ReceiveOptions{
			Messages:   msgs,
			Closed:     closed,
			OnIncoming: func(IncomingInfo) { cancel() },
		})
	}()

	stop := make(chan struct{})
	flooded := make(chan int, 1)
	go func() {
		n := 0
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				flooded <- n
				return
			case <-tick.C:
				if sender.SendText("junk, not a control message") == nil && sender.Send([]byte{1, 2, 3}) == nil {
					n++
				}
			}
		}
	}()

	var err error
	select {
	case err = <-recvErr:
	case <-time.After(deadline + 15*time.Second):
		close(stop)
		t.Fatal("the flood kept the receive alive past the deadline")
	}
	returnedAt := time.Now()
	close(stop)
	sent := <-flooded

	if took := returnedAt.Sub(start); took < deadline {
		t.Fatalf("the receive returned after %v, before the deadline, with %v: the idle watchdog is supposed to be blind to a flood", took, err)
	}
	if err == nil || strings.Contains(err.Error(), "no data arrived") || !strings.Contains(err.Error(), "connection closed") {
		t.Fatalf("receive error = %v, want the closed-channel diagnosis", err)
	}
	var at time.Time
	select {
	case at = <-expired:
	default:
		t.Fatal("the deadline never fired")
	}
	if lag := returnedAt.Sub(at); lag > 2*time.Second {
		t.Fatalf("the receive returned %v after the deadline fired, want within 2 s", lag)
	}
	if sent < 10 {
		t.Fatalf("only %d junk rounds went out, so the flood did not outlast the idle timeout", sent)
	}
	t.Logf("%d junk rounds over %v; the receive returned %v after the deadline", sent, at.Sub(start), returnedAt.Sub(at))

	select {
	case frame := <-replies:
		var incompat incompatibleMsg
		if json.Unmarshal(frame, &incompat) != nil || incompat.Code != string(CodeStopped) {
			t.Fatalf("the sender got %q, want an incompatible frame with code stopped", frame)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the sender was never told stopped")
	}
	requireEmptyDir(t, outDir)
}

// TestIncomingDeadlineCanceledByOnIncoming: a real metadata arrives before the
// deadline, OnIncoming cancels it, and the drop then runs past the deadline
// (Decide holds longer than it) without the deadline ever firing.
//
// The deadline is armed before a whole loopback WebRTC setup, as the desktop
// arms it at user-connected. Under load that setup alone outlasted 800 ms
// (it failed on main on a loaded machine, 2026-10-16), and then the deadline
// fired before any OnIncoming existed to cancel it, which says nothing about
// the property. Such a round is retried with a longer deadline; a round whose
// OnIncoming came in time is judged strictly. The margin keeps a cancel from
// racing the expiry, which TestIncomingDeadlineCancelRace bounds instead.
func TestIncomingDeadlineCanceledByOnIncoming(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	const margin = 200 * time.Millisecond
	for _, deadline := range []time.Duration{800 * time.Millisecond, 2 * time.Second, 5 * time.Second} {
		var fired atomic.Bool
		var incomingAt atomic.Int64
		cancel := StartIncomingDeadline(deadline, func() { fired.Store(true) })
		start := time.Now()
		run := runHostile(t, metaFor("a.txt", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{
			OnIncoming: func(IncomingInfo) {
				incomingAt.Store(int64(time.Since(start)))
				cancel()
			},
			Decide: func(IncomingInfo) Decision {
				time.Sleep(2 * deadline)
				return Decision{Kind: DecisionAccept}
			},
		})
		cancel()
		if setup := time.Duration(incomingAt.Load()); setup > deadline-margin {
			t.Logf("OnIncoming came %v after the %v deadline was armed; retrying with a longer one", setup, deadline)
			continue
		}
		wantSaved(t, run, "a.txt")
		if took := time.Since(start); took < 2*deadline {
			t.Fatalf("the drop took %v, so it never outlasted the %v deadline", took, deadline)
		}
		if fired.Load() {
			t.Fatalf("the %v deadline fired although OnIncoming cancelled it", deadline)
		}
		return
	}
	t.Fatal("connection setup outlasted every deadline tried, so the property was never tested")
}

// TestIncomingDeadlineCancelRace: cancel and expiry racing settle on exactly
// one, and a cancel made well before the deadline means onExpire never runs.
// An expiry that wins settles under the lock and calls onExpire outside it,
// so in the racing rounds onExpire may still start just after cancel returns:
// those rounds bound the count, they do not order the two.
func TestIncomingDeadlineCancelRace(t *testing.T) {
	for i := 0; i < 200; i++ {
		var ran atomic.Int32
		cancel := StartIncomingDeadline(time.Duration(i%3)*time.Microsecond, func() { ran.Add(1) })
		cancel()
		cancel()
		time.Sleep(time.Millisecond)
		if got := ran.Load(); got > 1 {
			t.Fatalf("round %d: onExpire ran %d times", i, got)
		}
	}
	var ran atomic.Int32
	cancel := StartIncomingDeadline(100*time.Millisecond, func() { ran.Add(1) })
	cancel()
	time.Sleep(300 * time.Millisecond)
	if got := ran.Load(); got != 0 {
		t.Fatalf("onExpire ran %d times although cancel came 100 ms before the deadline", got)
	}
}
