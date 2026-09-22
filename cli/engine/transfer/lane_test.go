package transfer

// The lane exports (lane.go): the volume questions, the 24-hour cap and the
// open-channel deadline, the last two driven the way the desktop lane drives
// them around a real receive loop.

import (
	"encoding/json"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// TestDropTimeLimitReached: 24 hours from the start and later is reached, any
// moment before is not.
func TestDropTimeLimitReached(t *testing.T) {
	start := time.Date(2026, 9, 23, 2, 14, 0, 0, time.UTC)
	rows := []struct {
		after time.Duration
		want  bool
	}{
		{0, false},
		{23*time.Hour + 59*time.Minute, false},
		{24*time.Hour - time.Nanosecond, false},
		{24 * time.Hour, true},
		{25 * time.Hour, true},
		{-time.Hour, false},
	}
	for _, r := range rows {
		if got := DropTimeLimitReached(start, start.Add(r.after)); got != r.want {
			t.Errorf("DropTimeLimitReached(start, start+%v) = %v, want %v", r.after, got, r.want)
		}
	}
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
func TestIncomingDeadlineCanceledByOnIncoming(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	const deadline = 800 * time.Millisecond
	var fired atomic.Bool
	cancel := StartIncomingDeadline(deadline, func() { fired.Store(true) })
	t.Cleanup(cancel)
	start := time.Now()
	run := runHostile(t, metaFor("a.txt", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{
		OnIncoming: func(IncomingInfo) { cancel() },
		Decide: func(IncomingInfo) Decision {
			time.Sleep(2 * deadline)
			return Decision{Kind: DecisionAccept}
		},
	})
	wantSaved(t, run, "a.txt")
	if took := time.Since(start); took < 2*deadline {
		t.Fatalf("the drop took %v, so it never outlasted the deadline", took)
	}
	if fired.Load() {
		t.Fatal("the deadline fired although OnIncoming cancelled it")
	}
}

// TestIncomingDeadlineCancelRace: cancel and expiry racing settle on exactly
// one: after cancel returns, onExpire never starts.
func TestIncomingDeadlineCancelRace(t *testing.T) {
	for i := 0; i < 200; i++ {
		var ran atomic.Int32
		cancel := StartIncomingDeadline(time.Duration(i%3)*time.Microsecond, func() { ran.Add(1) })
		cancel()
		after := ran.Load()
		time.Sleep(time.Millisecond)
		if got := ran.Load(); got != after || got > 1 {
			t.Fatalf("round %d: onExpire ran %d times, %d of them after cancel returned", i, got, got-after)
		}
		cancel()
	}
}
