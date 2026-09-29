package peer_test

// F4-01 (DV-AUDIT CP-QA): data channels the answering side opens on the
// offerer's connection, and (review A R3) further channels the offering side
// opens on the answerer's, through the real pairing (pairHostVisitor in
// hostreceive_test.go).

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// settledGoroutines is the goroutine count once it has stopped falling.
func settledGoroutines() int {
	for i := 0; i < 20; i++ {
		runtime.GC()
		time.Sleep(20 * time.Millisecond)
	}
	return runtime.NumGoroutine()
}

// goroutinesIn returns the stack of every goroutine with a frame in any of the
// named functions.
func goroutinesIn(names ...string) []string {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	var out []string
	for _, g := range strings.Split(string(buf), "\n\n") {
		for _, name := range names {
			if strings.Contains(g, name) {
				out = append(out, g)
				break
			}
		}
	}
	return out
}

// TestOffererClosesWhenTheAnswererOpensAChannel: no Floe answerer opens a data
// channel, so one the visitor opens ends the host's whole connection, and the
// host's floe channel closes within seconds. Before, pion's default handler
// closed each such channel and kept it, label and all, for the connection's
// life, while the floe channel stayed open for the next one.
func TestOffererClosesWhenTheAnswererOpensAChannel(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback pairing in -short mode")
	}
	host, visitor := pairHostVisitor(t, newRelay(t))

	opened := time.Now()
	if _, err := visitor.conn.PeerConnectionForTest().CreateDataChannel("not-floe", nil); err != nil {
		t.Fatalf("visitor CreateDataChannel: %v", err)
	}
	select {
	case <-host.early.Closed:
		t.Logf("the host's floe channel closed %v after the visitor opened a second channel",
			time.Since(opened).Round(time.Millisecond))
	case <-time.After(5 * time.Second):
		t.Fatal("the host's floe channel is still open 5 s after the visitor opened a channel of its own")
	}
	// The whole connection, not the floe channel alone. pion reports closed only
	// at the end of its Close, after the channels close and ICE stops, so the
	// state is polled rather than read once.
	pc := host.conn.PeerConnectionForTest()
	for deadline := time.Now().Add(5 * time.Second); pc.ConnectionState() != webrtc.PeerConnectionStateClosed; {
		if time.Now().After(deadline) {
			t.Fatalf("the host's peer connection is %s 5 s after its floe channel closed, want closed", pc.ConnectionState())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestReceiverClosesWhenTheSenderOpensASecondChannel (review A R3): the
// answerer (SetupAsReceiver) takes the first channel the offerer opens, and a
// further one ends its whole connection, as the offerer does for an extra
// channel from the answerer; no pump is attached to it. After both sides close,
// no goroutine is left in SetupAsReceiver's callbacks, in a pump's waiter or in
// a FrameQueue, and the count is back to where it was before the pairing.
// Before, every remote channel got a pump, Early was replaced by the latest,
// and each OnOpen past the second parked for good on the one-slot hand-off.
func TestReceiverClosesWhenTheSenderOpensASecondChannel(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback pairing in -short mode")
	}
	relayURL := newRelay(t)
	before := settledGoroutines()
	host, visitor := pairHostVisitor(t, relayURL)

	opened := time.Now()
	// The first extra channel must open. The visitor may end the connection
	// as soon as it sees that one, which is the behavior under test, and its
	// close can reach the host before this loop is done (ubuntu-latest CI,
	// 2026-09-29: "InvalidStateError: connection closed" on a later channel),
	// so a later channel that finds the connection closed stops the loop.
	for i := 0; i < 4; i++ {
		if _, err := host.conn.PeerConnectionForTest().CreateDataChannel(fmt.Sprintf("extra-%d", i), nil); err != nil {
			if i == 0 {
				t.Fatalf("host CreateDataChannel: %v", err)
			}
			t.Logf("extra channel %d found the connection already closed (%v): the visitor ended it", i, err)
			break
		}
	}
	select {
	case <-visitor.early.Closed:
		t.Logf("the visitor's floe channel closed %v after the host opened more channels",
			time.Since(opened).Round(time.Millisecond))
	case <-time.After(5 * time.Second):
		t.Error("the visitor's floe channel is still open 5 s after the host opened channels of its own")
	}
	pc := visitor.conn.PeerConnectionForTest()
	for deadline := time.Now().Add(5 * time.Second); pc.ConnectionState() != webrtc.PeerConnectionStateClosed; {
		if time.Now().After(deadline) {
			t.Errorf("the visitor's peer connection is %s 5 s after, want closed", pc.ConnectionState())
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	host.close()
	visitor.close()
	var stuck []string
	var now int
	for deadline := time.Now().Add(10 * time.Second); ; {
		stuck = goroutinesIn("peer.(*Connection).SetupAsReceiver", "peer.(*Connection).attach", "peer.(*FrameQueue")
		now = runtime.NumGoroutine()
		if len(stuck) == 0 && now <= before+5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("10 s after both sides closed: %d goroutines (%d before the pairing), %d still in SetupAsReceiver, a pump or a FrameQueue:\n%s",
				now, before, len(stuck), strings.Join(stuck, "\n\n"))
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Logf("after both sides closed: %d goroutines (%d before the pairing), none in SetupAsReceiver, a pump or a FrameQueue", now, before)
}
