package transfer

// SendOptions.RequireReceived: the delivery wait under it ends only on the
// receiver's word ("received" or a refusal) or on the close, never on a
// drained buffer (FT-GO-REQRECV, from the FT-GO-CONFIRMS triage probe).
//
// A real receiver refuses the last file some time after it read the end
// frame, once its fsync, hash compare and remove are done, and it keeps its
// channel open while it does. The scripted receiver here does the same with a
// chosen delay. The sender's channel is pumped the way peer.Connection wires
// it (Messages and Closed), which is how every request-link visitor sends.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// hashRefusal is a Go receiver's hash-mismatch refusal, as AbortWithCode sends
// it after the compare failed and the part file was removed.
const hashRefusal = `{"type":"incompatible","reason":"receiver discarded a file because its SHA-256 did not match","pv":1,"pvMin":1,"ver":"test","code":"hash-mismatch","saved":0}`

// scriptedSend is one 64 KB file on its way through the engine sender to a
// scripted receiver that has acked it and read its bytes and its end frame.
// The receiver's channel is still open: the test decides what it says next.
type scriptedSend struct {
	rdc   *webrtc.DataChannel
	errc  <-chan error
	endAt time.Time
}

// startScriptedSend sends one file with opts (Messages and Closed are the
// sender's pump, set here) and returns once the end frame reached the
// receiver.
func startScriptedSend(t *testing.T, opts SendOptions) *scriptedSend {
	t.Helper()
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	// Installed before the receiver can say anything: it sends nothing until
	// it acks the metadata below.
	opts.Messages, opts.Closed = pumpChannel(sender, nil)
	if opts.OnProgress == nil {
		opts.OnProgress = func(Progress) {}
	}

	src := filepath.Join(t.TempDir(), "tail.bin")
	if err := os.WriteFile(src, make([]byte, 64*1024), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	errc := make(chan error, 1)
	go func() { errc <- SendFilesWithOptions(sender, []string{src}, "test", opts) }()

	var meta struct {
		ID string `json:"id"`
	}
	select {
	case m := <-msgs:
		if err := json.Unmarshal(m.Data, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first message is not the metadata: %q", m.Data)
		}
	case err := <-errc:
		t.Fatalf("send ended before the metadata: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("metadata never arrived")
	}
	if err := rdc.Send([]byte(`{"type":"ack","id":"` + meta.ID + `","offset":0,"pv":1,"pvMin":1}`)); err != nil {
		t.Fatalf("ack: %v", err)
	}
	for ended := false; !ended; {
		select {
		case m := <-msgs:
			if msgType, ok := classifyControl(m.Data); ok && msgType == "end" {
				ended = true
			}
		case <-time.After(20 * time.Second):
			t.Fatal("the end frame never arrived")
		}
	}
	return &scriptedSend{rdc: rdc, errc: errc, endAt: time.Now()}
}

// waitOrReturn waits delay after the end frame, or until the send returns,
// whichever is first. returned says which.
func (s *scriptedSend) waitOrReturn(delay time.Duration) (returned bool, err error) {
	select {
	case err = <-s.errc:
		return true, err
	case <-time.After(time.Until(s.endAt.Add(delay))):
		return false, nil
	}
}

// result waits for the send to return after the receiver acted.
func (s *scriptedSend) result(t *testing.T) error {
	t.Helper()
	select {
	case err := <-s.errc:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("the send did not return within 10s of the receiver's answer")
	}
	return nil
}

// sinceEnd is how long after the end frame the send has been running, for the
// failure messages and logs.
func (s *scriptedSend) sinceEnd() time.Duration {
	return time.Since(s.endAt).Round(time.Millisecond)
}

// lateRefusal has the receiver refuse with hash-mismatch delay after the end
// frame, keeping its channel open, and requires the send to report exactly
// that refusal. With delay 0 the refusal is on its way at once; with 300 ms
// the send's 50 ms tick reads a drained buffer several times first.
func lateRefusal(t *testing.T, delay time.Duration) {
	s := startScriptedSend(t, SendOptions{RequireReceived: true})
	if returned, err := s.waitOrReturn(delay); returned {
		t.Fatalf("delay %v: the send returned %v %v after the end frame, before the receiver said anything; want it to wait for the receiver's word",
			delay, err, s.sinceEnd())
	}
	if err := s.rdc.Send([]byte(hashRefusal)); err != nil {
		t.Fatalf("refusal: %v", err)
	}
	err := s.result(t)
	var stopped *PeerStoppedError
	if !errors.As(err, &stopped) || stopped.Code != CodeHashMismatch {
		t.Fatalf("delay %v: the send returned %v; want the receiver's hash-mismatch stop", delay, err)
	}
	t.Logf("delay %v: hash-mismatch reported %v after the end frame", delay, s.sinceEnd())
}

// The triage probe: a refusal 300 ms after the end frame. Without the option's
// wait, the tick arm returned nil about 49 ms after the end frame, before the
// refusal was even sent (FT-GO-CONFIRMS, 10 of 10).
func TestRequireReceivedReportsALateRefusal(t *testing.T) { lateRefusal(t, 300*time.Millisecond) }

// The probe's 0 ms variant, which was already reported before the option.
func TestRequireReceivedReportsAPromptRefusal(t *testing.T) { lateRefusal(t, 0) }

// A close with no "received" is not a delivery under RequireReceived, whatever
// the buffer reads. The buffer is a fake here, so the empty case is pinned: the
// tick arm reads 0 on every tick for 300 ms, and only the close ends the wait.
func TestRequireReceivedCloseBeforeReceivedIsAnError(t *testing.T) {
	for _, c := range []struct {
		name string
		left uint64
	}{
		{"empty buffer", 0},
		{"bytes still buffered", 5 << 20},
	} {
		t.Run(c.name, func(t *testing.T) {
			// step 0: the buffer holds at left. The stall window keeps its 60 s
			// default, so no stall can end the wait first.
			useDelivery(t, &fakeDrain{left: c.left}, 0)
			s := startScriptedSend(t, SendOptions{RequireReceived: true})
			if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
				t.Fatalf("the send returned %v %v after the end frame with the receiver silent and open", err, s.sinceEnd())
			}
			if err := s.rdc.Close(); err != nil {
				t.Fatalf("close the receiver's channel: %v", err)
			}
			err := s.result(t)
			if !errors.Is(err, ErrClosedBeforeReceived) {
				t.Fatalf("the send returned %v; want ErrClosedBeforeReceived", err)
			}
		})
	}
}

// "received" is the success, and OnDelivered fires once with the count it
// carried. It arrives 300 ms after the end frame, so it is the receiver's word
// and not a drained buffer that ends the wait; before the option, the tick arm
// ended it first and OnDelivered lost the count.
func TestRequireReceivedEndsOnReceivedWithItsVerifiedCount(t *testing.T) {
	var got []Delivered
	s := startScriptedSend(t, SendOptions{
		RequireReceived: true,
		OnDelivered:     func(d Delivered) { got = append(got, d) },
	})
	if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
		t.Fatalf("the send returned %v %v after the end frame, before the receiver's received", err, s.sinceEnd())
	}
	// Binary, as the Go receiver sends it.
	if err := s.rdc.Send([]byte(`{"type":"received","verified":1}`)); err != nil {
		t.Fatalf("received: %v", err)
	}
	if err := s.result(t); err != nil {
		t.Fatalf("a received frame must end the wait with success, got: %v", err)
	}
	if len(got) != 1 || got[0] != (Delivered{Files: 1, Verified: 1, HasVerified: true}) {
		t.Fatalf("OnDelivered = %+v, want exactly one {Files:1 Verified:1 HasVerified:true}", got)
	}
}

// TestKnownGapPlainSendEndsAtDrainBeforeALateRefusal pins a KNOWN GAP, not a
// desired property. Without RequireReceived the delivery wait still ends in
// success on the first tick that reads a drained buffer, so a refusal the
// receiver sends 300 ms after the end frame is never seen and the plain send
// reports success over a file the receiver discarded. That is the Phase F
// plain-send gap of FT-GO-CONFIRMS (triage Q5), left open on purpose: a
// browser receiver never sends "received", so a plain send cannot wait for it.
// This test FLIPS when the capability-ack card lands (a Go receiver that
// announces it always answers makes a plain send wait too): then rewrite it
// against a receiver that does not announce it, the browser case.
func TestKnownGapPlainSendEndsAtDrainBeforeALateRefusal(t *testing.T) {
	s := startScriptedSend(t, SendOptions{})
	returned, err := s.waitOrReturn(300 * time.Millisecond)
	if !returned {
		if sendErr := s.rdc.Send([]byte(hashRefusal)); sendErr != nil {
			t.Fatalf("refusal: %v", sendErr)
		}
		err = s.result(t)
		t.Fatalf("the plain send waited past the drain and returned %v after the late refusal; if the capability ack has landed, this test is due to flip (see its comment)", err)
	}
	if err != nil {
		t.Fatalf("the plain send returned %v at the drain; want success, the known gap", err)
	}
	t.Logf("plain send ended in success %v after the end frame, before the refusal was sent", s.sinceEnd())
}
