package peer_test

// F4-01 (DV-AUDIT CP-QA): data channels the answering side opens on the
// offerer's connection, through the real pairing (pairHostVisitor in
// hostreceive_test.go).

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

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
