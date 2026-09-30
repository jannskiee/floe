package peer_test

// The link between a Failed watcher and the outcome a person sees (review B-1
// B3): closeOnFailed and watchConnFailed end a send's wait with a LOCAL
// Connection.Close, and that close must end a plain send to a receiver that
// promised its word (the ack's confirms) with ErrClosedBeforeReceived. The
// pieces had tests of their own (Failed to Close in cmd/floe, a remote close to
// ErrClosedBeforeReceived in transfer); this drives the local close end to end
// over two real peer.Connections.

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// TestLocalCloseEndsTheConfirmsWait: the visitor sends with plain SendOptions,
// the host acks with confirms and then stays silent and open, as a receiver
// that vanished after the last byte looks from the sender's side. The send
// waits; this side's own Close, which is what the watchers do when Failed
// fires, ends it within 5 s with ErrClosedBeforeReceived.
func TestLocalCloseEndsTheConfirmsWait(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	host, visitor := pairHostVisitor(t, newRelay(t))
	src := t.TempDir()
	writeRandom(t, src, "a.bin", 64<<10)

	sendErr := make(chan error, 1)
	go func() {
		sendErr <- transfer.SendFilesWithOptions(visitor.dc, []string{filepath.Join(src, "a.bin")}, "", transfer.SendOptions{
			OnProgress: func(transfer.Progress) {},
			Messages:   visitor.early.Msgs,
			Closed:     visitor.early.Closed,
		})
	}()

	// The host promises its word and never gives it: an ack with confirms,
	// the bytes read to the end frame, then nothing.
	var ended time.Time
	for deadline := time.After(30 * time.Second); ended.IsZero(); {
		select {
		case m := <-host.early.Msgs:
			if !m.IsString {
				continue
			}
			var f map[string]any
			if json.Unmarshal(m.Data, &f) != nil {
				continue
			}
			switch f["type"] {
			case "metadata":
				id, _ := f["id"].(string)
				if err := host.dc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1,"confirms":true}`)); err != nil {
					t.Fatalf("ack: %v", err)
				}
			case "end":
				ended = time.Now()
			}
		case err := <-sendErr:
			t.Fatalf("the send returned %v before its end frame", err)
		case <-deadline:
			t.Fatal("no end frame within 30s")
		}
	}

	select {
	case err := <-sendErr:
		t.Fatalf("the plain send returned %v %v after the end frame, with a receiver that confirms silent and open", err, time.Since(ended).Round(time.Millisecond))
	case <-time.After(1500 * time.Millisecond):
	}

	closed := time.Now()
	visitor.conn.Close() // what closeOnFailed and watchConnFailed do on Failed
	select {
	case err := <-sendErr:
		if !errors.Is(err, transfer.ErrClosedBeforeReceived) {
			t.Fatalf("after the local close the send returned %v; want ErrClosedBeforeReceived", err)
		}
		t.Logf("the send ended %v after the local close", time.Since(closed).Round(time.Millisecond))
	case <-time.After(5 * time.Second):
		t.Fatal("the send was still waiting 5s after the local close")
	}
}
