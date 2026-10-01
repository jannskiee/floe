package transfer

// SendOptions.RequireReceived: the delivery wait under it ends only on the
// receiver's word ("received" or a refusal) or on the close, never on a
// drained buffer (FT-GO-REQRECV, from the FT-GO-CONFIRMS triage probe). A
// plain send gets the same wait when the receiver's ack carries confirms
// (FT-GO-CONFIRMS step 2), and keeps the drain without it (the tests at the
// end).
//
// A real receiver refuses the last file some time after it read the end
// frame, once its fsync, hash compare and remove are done, and it keeps its
// channel open while it does. The scripted receiver here does the same with a
// chosen delay. The sender's channel is pumped the way peer.Connection wires
// it (Messages and Closed), which is how every request-link visitor sends.

import (
	"encoding/json"
	"errors"
	"fmt"
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
	return startScriptedSendWiring(t, opts, true)
}

// startScriptedSendWiring is startScriptedSend with the sender's wiring
// chosen: pumped, or with Messages and Closed left nil so the sender installs
// its own OnMessage and OnClose, as SendFiles does.
func startScriptedSendWiring(t *testing.T, opts SendOptions, pumped bool) *scriptedSend {
	t.Helper()
	return startScriptedSendAck(t, opts, pumped, "")
}

// confirmsAck is what a receiver that promises its word adds to its ack:
// every Go receiver since FT-GO-CONFIRMS step 2.
const confirmsAck = `,"confirms":true`

// startScriptedSendAck is startScriptedSendWiring with ackExtra written into
// the scripted receiver's ack after pvMin: "" is the ack a browser receiver or
// an older Go receiver sends, confirmsAck the one a current Go receiver sends.
func startScriptedSendAck(t *testing.T, opts SendOptions, pumped bool, ackExtra string) *scriptedSend {
	t.Helper()
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	if pumped {
		// Installed before the receiver can say anything: it sends nothing
		// until it acks the metadata below.
		opts.Messages, opts.Closed = pumpChannel(sender, nil)
	}
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
	if err := rdc.Send([]byte(`{"type":"ack","id":"` + meta.ID + `","offset":0,"pv":1,"pvMin":1` + ackExtra + `}`)); err != nil {
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

// RequireReceived without the pump: Messages and Closed nil, so the sender
// installs its own OnMessage and OnClose, as SendFiles does. flushed is closed
// at once there and pion runs OnMessage before OnClose on one goroutine, so
// the two outcomes are the pumped ones: "received" is success, and a close
// before it is ErrClosedBeforeReceived, here with the buffer pinned empty
// (FT-GO-REQRECV review 1, F5).
func TestRequireReceivedWithoutThePump(t *testing.T) {
	t.Run("received", func(t *testing.T) {
		var got []Delivered
		s := startScriptedSendWiring(t, SendOptions{
			RequireReceived: true,
			OnDelivered:     func(d Delivered) { got = append(got, d) },
		}, false)
		if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
			t.Fatalf("the send returned %v %v after the end frame, before the receiver's received", err, s.sinceEnd())
		}
		if err := s.rdc.Send([]byte(`{"type":"received","verified":1}`)); err != nil {
			t.Fatalf("received: %v", err)
		}
		if err := s.result(t); err != nil {
			t.Fatalf("a received frame must end the wait with success, got: %v", err)
		}
		if len(got) != 1 || got[0] != (Delivered{Files: 1, Verified: 1, HasVerified: true}) {
			t.Fatalf("OnDelivered = %+v, want exactly one {Files:1 Verified:1 HasVerified:true}", got)
		}
	})
	t.Run("close before received", func(t *testing.T) {
		useDelivery(t, &fakeDrain{}, 0)
		s := startScriptedSendWiring(t, SendOptions{RequireReceived: true}, false)
		if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
			t.Fatalf("the send returned %v %v after the end frame with the receiver silent and open", err, s.sinceEnd())
		}
		if err := s.rdc.Close(); err != nil {
			t.Fatalf("close the receiver's channel: %v", err)
		}
		if err := s.result(t); !errors.Is(err, ErrClosedBeforeReceived) {
			t.Fatalf("the send returned %v; want ErrClosedBeforeReceived", err)
		}
	})
}

// ---- The receiver's promise: confirms on the ack (FT-GO-CONFIRMS step 2) ----
//
// A Go receiver's ack carries "confirms":true, its promise that it ends the
// batch with "received" after its last commit or with a refusal. A sender
// whose first ack carries it waits for that word as under RequireReceived,
// with zero SendOptions, which is how floe send and the desktop's Send call
// it. Without the field nothing changes (the no-capability guard at the end).

// TestReceiverAckCarriesConfirms: the real receive loop's ack carries the
// promise, as the literal true parseAckConfirms reads, on every file's ack,
// and keeps it: "received" follows the last commit. The scripted receivers
// below stand in for this one, so this pins that the real one says what they
// say.
func TestReceiverAckCarriesConfirms(t *testing.T) {
	h := newHandSender(t)
	files := [][]byte{[]byte("first"), []byte("the second file")}
	total := len(files[0]) + len(files[1])
	for i, data := range files {
		h.text(fmt.Sprintf(`{"type":"metadata","id":"c-%d","fileName":"f%d.txt","fileSize":%d,"index":%d,"total":2,"totalBytes":%d,"pv":1,"pvMin":1}`,
			i+1, i+1, len(data), i+1, total))
		select {
		case m := <-h.back:
			if !parseAckConfirms(m.Data) {
				t.Fatalf("file %d: the receiver's ack %q carries no confirms", i+1, m.Data)
			}
		case <-time.After(20 * time.Second):
			t.Fatalf("the receiver never acked file %d", i+1)
		}
		h.bytes(data)
		h.text(`{"type":"end","sha256":"` + hexSHA256(data) + `"}`)
	}
	res := h.finish()
	if res.err != nil {
		t.Fatalf("receive: %v", res.err)
	}
	for _, frame := range res.frames {
		if ok, verified, has := parseReceived(frame, 2); ok {
			if !has || verified != 2 {
				t.Fatalf("received %q, want both files verified", frame)
			}
			return
		}
	}
	t.Fatalf("no received after the last commit; frames back: %q", res.frames)
}

// TestConfirmsPlainSendReportsALateRefusal is the FT-GO-CONFIRMS probe with
// the capability: the receiver refuses 300 ms after the end frame, once its
// fsync, hash compare or commit is done, and keeps its channel open. Before
// the sender read confirms, a plain send returned nil about 49 ms after the
// end frame, before the refusal was even sent, and reported success over a
// file the receiver kept out. Each late code a Go receiver can send after the
// last byte is here, and each comes back as its own *PeerStoppedError.
func TestConfirmsPlainSendReportsALateRefusal(t *testing.T) {
	for _, code := range []RefusalCode{CodeHashMismatch, CodeWriteFailed, CodeSaveBlocked} {
		t.Run(string(code), func(t *testing.T) {
			s := startScriptedSendAck(t, SendOptions{}, true, confirmsAck)
			if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
				t.Fatalf("the plain send returned %v %v after the end frame, before the receiver that confirms said anything; want it to wait for the receiver's word",
					err, s.sinceEnd())
			}
			if err := s.rdc.Send(incompatibleFrame("test", code, code.WireReason(), 0)); err != nil {
				t.Fatalf("refusal: %v", err)
			}
			err := s.result(t)
			var stopped *PeerStoppedError
			if !errors.As(err, &stopped) || stopped.Code != code {
				t.Fatalf("the plain send returned %v; want the receiver's %s stop", err, code)
			}
			t.Logf("%s reported %v after the end frame", code, s.sinceEnd())
		})
	}
}

// TestConfirmsPlainSendEndsOnReceived: the promise kept is the success, with
// the count the received frame carried. It arrives 300 ms after the end frame,
// so the receiver's word ends the wait and not a drained buffer, and the
// Verified row reads a count the receiver really sent.
func TestConfirmsPlainSendEndsOnReceived(t *testing.T) {
	for _, wiring := range []struct {
		name   string
		pumped bool
	}{{"pumped", true}, {"own handlers", false}} {
		t.Run(wiring.name, func(t *testing.T) {
			var got []Delivered
			s := startScriptedSendAck(t, SendOptions{OnDelivered: func(d Delivered) { got = append(got, d) }}, wiring.pumped, confirmsAck)
			if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
				t.Fatalf("the plain send returned %v %v after the end frame, before the received of a receiver that confirms", err, s.sinceEnd())
			}
			if err := s.rdc.Send([]byte(`{"type":"received","verified":1}`)); err != nil {
				t.Fatalf("received: %v", err)
			}
			if err := s.result(t); err != nil {
				t.Fatalf("a received frame must end the wait with success, got: %v", err)
			}
			if len(got) != 1 || got[0] != (Delivered{Files: 1, Verified: 1, HasVerified: true}) {
				t.Fatalf("OnDelivered = %+v, want exactly one {Files:1 Verified:1 HasVerified:true}", got)
			}
		})
	}
}

// TestConfirmsPlainSendCloseBeforeReceivedIsAnError: a receiver that promised
// its word and closed without it did not confirm delivery, whatever the buffer
// reads, so the send returns ErrClosedBeforeReceived. floe send prints its
// text as it is, and the desktop maps it through errors.ts's 'connection
// closed' rule to its lost-connection line.
func TestConfirmsPlainSendCloseBeforeReceivedIsAnError(t *testing.T) {
	useDelivery(t, &fakeDrain{}, 0) // the buffer reads empty on every tick
	s := startScriptedSendAck(t, SendOptions{}, true, confirmsAck)
	if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
		t.Fatalf("the plain send returned %v %v after the end frame with a receiver that confirms silent and open", err, s.sinceEnd())
	}
	if err := s.rdc.Close(); err != nil {
		t.Fatalf("close the receiver's channel: %v", err)
	}
	if err := s.result(t); !errors.Is(err, ErrClosedBeforeReceived) {
		t.Fatalf("the plain send returned %v; want ErrClosedBeforeReceived", err)
	}
}

// TestConfirmsOnlyTheLiteralTrue: confirms counts only as the JSON literal
// true, read by its exact key. A string, a number or a key in another case is
// no promise, so the send ends in success at the drain as a plain send always
// has, within the file's 10 s ceiling (an outcome, never a one-tick bound).
func TestConfirmsOnlyTheLiteralTrue(t *testing.T) {
	for _, extra := range []string{`,"confirms":"true"`, `,"confirms":1`, `,"Confirms":true`, `,"confirms":true,"confirms":false`} {
		t.Run(extra, func(t *testing.T) {
			s := startScriptedSendAck(t, SendOptions{}, true, extra)
			select {
			case err := <-s.errc:
				if err != nil {
					t.Fatalf("the plain send returned %v at the drain; want success, since %s promises nothing", err, extra)
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("the plain send waited 10s past the drain for a receiver whose ack carried %s, which promises nothing", extra)
			}
		})
	}
}

// TestPlainSendWithoutConfirmsEndsAtDrain is the no-capability guard. A
// receiver whose ack carries no confirms (a browser, which never sends
// "received", or a Go receiver before FT-GO-CONFIRMS step 2) promised nothing,
// so a plain send still ends in success at the drain while that receiver stays
// silent and open: waiting for a word it will never send would end every such
// send in an error. A refusal such a receiver sends after the drain is still
// never seen, the gap that confirms closes for current Go receivers only.
//
// It asserts the outcome, not the timing: the send must end in success within
// the file's 10 s ceiling. An upper bound of one tick flakes under load
// (FT-GO-REQRECV review 1, F1).
func TestPlainSendWithoutConfirmsEndsAtDrain(t *testing.T) {
	s := startScriptedSend(t, SendOptions{})
	select {
	case err := <-s.errc:
		if err != nil {
			t.Fatalf("the plain send returned %v at the drain; want success for a receiver that promised nothing", err)
		}
		t.Logf("plain send ended in success %v after the end frame, with the receiver silent and open", s.sinceEnd())
	case <-time.After(10 * time.Second):
		t.Fatal("the plain send waited 10s past the drain for a receiver whose ack carried no confirms; it must end at the drain")
	}
}

// TestPlainSendCloseWithoutConfirms is the done arm's no-promise half (review
// A1 F2). A receiver whose ack carried no confirms and that closes while bytes
// are still unacknowledged keeps today's outcome, the error that counts them,
// never ErrClosedBeforeReceived, which belongs to a receiver that promised its
// word. The buffer holds at 4096 on every read, so no tick can end the wait
// first and the close is the only way out.
func TestPlainSendCloseWithoutConfirms(t *testing.T) {
	useDelivery(t, &fakeDrain{left: 4096}, 0)
	s := startScriptedSend(t, SendOptions{})
	if returned, err := s.waitOrReturn(300 * time.Millisecond); returned {
		t.Fatalf("the plain send returned %v %v after the end frame with 4096 bytes unacknowledged and the receiver open", err, s.sinceEnd())
	}
	if err := s.rdc.Close(); err != nil {
		t.Fatalf("close the receiver's channel: %v", err)
	}
	err := s.result(t)
	if errors.Is(err, ErrClosedBeforeReceived) {
		t.Fatalf("the plain send returned %v for a receiver that promised nothing; want the unacknowledged-bytes error", err)
	}
	if err == nil || err.Error() != "connection closed before delivery was confirmed (4096 bytes unacknowledged)" {
		t.Fatalf("the plain send returned %v; want connection closed before delivery was confirmed (4096 bytes unacknowledged)", err)
	}
}
