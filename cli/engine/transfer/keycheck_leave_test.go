package transfer

// A keyed side that comes to its key check on a connection the other side has
// already closed. That is a leave and reads as one, as it does with no key: the
// certificates sentence is for a connection this side cannot read, and it used to
// tell a person whose receiver had left that something was wrong with certificates
// (reviews 25 F4 and 26 F1, both measured on real pion peers).

import (
	"errors"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const closedBeforeAnyFile = "connection closed before any file arrived (the sender canceled, or the transfer was blocked)"

// waitDTLSEnded waits until dc's own DTLS transport has seen the other side go. A
// test that went on before that would read a live connection and prove nothing.
func waitDTLSEnded(t *testing.T, dc *webrtc.DataChannel) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		switch dc.Transport().Transport().State() {
		case webrtc.DTLSTransportStateClosed, webrtc.DTLSTransportStateFailed:
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("DTLS on this side still reads %s", dc.Transport().Transport().State())
}

func TestKeyedReceiveReadsAClosedConnectionAsALeave(t *testing.T) {
	pcSender, _, _, recvCh := newConnectedPCs(t)
	var dc *webrtc.DataChannel
	select {
	case dc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("the receiver's channel never opened")
	}
	msgs, closed := pumpChannel(dc, nil)
	if err := pcSender.Close(); err != nil {
		t.Fatal(err)
	}
	waitDTLSEnded(t, dc)

	kc := newKeyCheck(t, false)
	out := t.TempDir()
	err := waitErrOf(t, func() error {
		return ReceiveFilesWithOptions(dc, out, true, "test", "", ReceiveOptions{Messages: msgs, Closed: closed, KeyCheck: &kc})
	})
	if errors.Is(err, ErrKeyCheckUnavailable) {
		t.Fatalf("a sender that left reads as this side's certificates: %v", err)
	}
	if err == nil || err.Error() != closedBeforeAnyFile {
		t.Fatalf("err = %v, want the sentence a keyless receive has for the same close", err)
	}
	wantEmptyDir(t, out)
}

// The same close on a receive with no key, so the sentence above stays that one.
func TestKeylessReceiveOnAClosedConnectionIsTheSentenceAKeyedOneUses(t *testing.T) {
	pcSender, _, _, recvCh := newConnectedPCs(t)
	var dc *webrtc.DataChannel
	select {
	case dc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("the receiver's channel never opened")
	}
	msgs, closed := pumpChannel(dc, nil)
	if err := pcSender.Close(); err != nil {
		t.Fatal(err)
	}
	waitDTLSEnded(t, dc)
	err := waitErrOf(t, func() error {
		return ReceiveFilesWithOptions(dc, t.TempDir(), true, "test", "", ReceiveOptions{Messages: msgs, Closed: closed})
	})
	if err == nil || err.Error() != closedBeforeAnyFile {
		t.Fatalf("err = %v, want %q", err, closedBeforeAnyFile)
	}
}

func TestKeyedSendReadsAClosedConnectionAsALeave(t *testing.T) {
	for _, enforce := range []bool{false, true} {
		name := "detect"
		if enforce {
			name = "enforce"
		}
		t.Run(name, func(t *testing.T) {
			_, pcReceiver, dc, recvCh := newConnectedPCs(t)
			select {
			case <-recvCh:
			case <-time.After(20 * time.Second):
				t.Fatal("the receiver's channel never opened")
			}
			msgs, closed := pumpChannel(dc, nil)
			if err := pcReceiver.Close(); err != nil {
				t.Fatal(err)
			}
			waitDTLSEnded(t, dc)

			kc := newKeyCheck(t, enforce)
			err := waitErrOf(t, func() error {
				return SendFilesWithOptions(dc, []string{kcTestFile(t, 16)}, "test", SendOptions{Messages: msgs, Closed: closed, KeyCheck: &kc})
			})
			if err != errClosedAwaitingReceiver {
				t.Fatalf("err = %v, want exactly errClosedAwaitingReceiver", err)
			}
		})
	}
}
