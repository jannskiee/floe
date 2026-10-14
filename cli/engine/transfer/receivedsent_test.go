package transfer

// OnReceivedSent is the one signal that the receive has finished: it fires
// once, right after the "received" frame is handed to the channel, which the
// loop does only when it has committed as many files as the total it is held
// to, the latest metadata's. floe receive's Ctrl+C reads it to decide whether
// the command keeps its own ending (CLI-01, CLI-02): the first metadata's
// total, which a sender may raise in a later frame, cannot say that, and a
// close made before the frame is queued would cut it off.

import (
	"slices"
	"sync"
	"testing"
	"time"
)

// TestOnReceivedSentFiresOnceTheLoopHasEnded: a sender announces 2 files,
// then 3 in its second metadata frame. After file 2 is committed, the first
// total is met but the loop goes on, so nothing fires and no "received" goes
// out. After file 3 the callback fires exactly once, after the last
// OnFileDone, by which time the frame is on its way to the sender.
func TestOnReceivedSentFiresOnceTheLoopHasEnded(t *testing.T) {
	var mu sync.Mutex
	var events []string
	record := func(e string) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	}
	seen := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(events)
	}
	h := newHandSenderOpts(t, t.TempDir(), ReceiveOptions{
		OnFileDone:     func(FileDone) { record("done") },
		OnReceivedSent: func() { record("sent") },
	})

	one, two, three := []byte("a"), []byte("bb"), []byte("ccc")
	h.meta("a.txt", len(one), 1, 2, 3)
	h.bytes(one)
	h.text(`{"type":"end","sha256":"` + hexSHA256(one) + `"}`)
	h.meta("b.txt", len(two), 2, 3, 6)
	h.bytes(two)
	h.text(`{"type":"end","sha256":"` + hexSHA256(two) + `"}`)

	for deadline := time.Now().Add(20 * time.Second); len(seen()) < 2; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("file 2 was never committed: %v", seen())
		}
	}
	// The first metadata's total is met; the latest one's is not.
	select {
	case m := <-h.back:
		t.Fatalf("after file 2 of 3 the receiver sent %q", m.Data)
	case <-time.After(300 * time.Millisecond):
	}
	if got := seen(); !slices.Equal(got, []string{"done", "done"}) {
		t.Fatalf("after file 2 of 3: %v, want two commits and no received", got)
	}

	h.meta("c.txt", len(three), 3, 3, 6)
	h.bytes(three)
	h.text(`{"type":"end","sha256":"` + hexSHA256(three) + `"}`)
	res := h.finish()
	if res.err != nil {
		t.Fatalf("the receive ended on %v", res.err)
	}
	received := 0
	for _, f := range res.frames {
		if msgType, ok := classifyControl(f); ok && msgType == "received" {
			received++
		}
	}
	if received != 1 {
		t.Fatalf("the sender read %d received frame(s), want 1", received)
	}
	if got := seen(); !slices.Equal(got, []string{"done", "done", "done", "sent"}) {
		t.Fatalf("events %v, want three commits, then the received frame sent once", got)
	}
}

// TestOnReceivedSentNeverFiresForAReceiveThatStops: a receive that ends
// before its last file (here the sender closes mid-file) never fires it.
func TestOnReceivedSentNeverFiresForAReceiveThatStops(t *testing.T) {
	var fired sync.Once
	sent := make(chan struct{})
	h := newHandSenderOpts(t, t.TempDir(), ReceiveOptions{
		OnReceivedSent: func() { fired.Do(func() { close(sent) }) },
	})
	h.meta("a.txt", 10, 1, 1, 10)
	h.bytes([]byte("abc"))
	_ = h.sender.Close()
	select {
	case err := <-h.recvErr:
		if err == nil {
			t.Fatal("a receive whose sender closed mid-file returned nil")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the receive did not return after the sender closed")
	}
	select {
	case <-sent:
		t.Fatal("OnReceivedSent fired for a receive that stopped")
	default:
	}
}
