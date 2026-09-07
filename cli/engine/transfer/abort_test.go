// Telling the other side why a transfer stopped on purpose.
//
// Before this the only thing that crossed the wire on a deliberate abort was
// the close. A receiver blamed "the sender canceled, or the transfer was
// blocked" whatever the cause, and a sender with more files to send waited out
// the full 120 s ack deadline and then reported a timeout, which is the wrong
// cause two minutes late.
//
// The carrier is the existing "incompatible" frame with an OVERLAPPING pv
// range, so no new message type and no ProtocolVersion bump: every shipped peer
// already classifies it, and both senders already print its Reason verbatim
// when the ranges overlap.
package transfer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// TestAbortReasonFramingFollowsDirection pins the rule that keeps this safe.
// Sender to receiver must be TEXT, because on that path a binary frame is file
// data by definition and shipped Go receivers from v1.5.0 to v1.5.5 would write
// one into somebody's file. Receiver to sender stays binary, which is what
// every shipped receiver already sends.
//
// It also pins the cap on the ENCODED FRAME rather than on the reason: a
// browser receiver stops classifying a control message past controlMsgMax and
// would read the frame as data.
func TestAbortReasonFramingFollowsDirection(t *testing.T) {
	cases := []struct {
		name       string
		toReceiver bool
		wantString bool
		reason     string
	}{
		{"to receiver is text", true, true, "transfer blocked: relay connections are capped at 2 GB"},
		{"to sender is binary", false, false, "receiver discarded a file"},
		{"an overlong reason still fits the frame", true, true, strings.Repeat("very long prose. ", 500)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
			defer closeFn()

			select {
			case <-recvCh:
			case <-time.After(20 * time.Second):
				t.Fatal("receiver data channel never opened")
			}

			abortReason(sender, "test-ver", tc.reason, tc.toReceiver)

			var got webrtc.DataChannelMessage
			select {
			case got = <-msgs:
			case <-time.After(20 * time.Second):
				t.Fatal("the abort frame never arrived")
			}

			if got.IsString != tc.wantString {
				t.Fatalf("IsString = %v, want %v", got.IsString, tc.wantString)
			}
			if len(got.Data) > controlMsgMax {
				t.Fatalf("encoded frame is %d bytes, over the %d cap a browser receiver enforces",
					len(got.Data), controlMsgMax)
			}
			msgType, isControl := classifyControl(got.Data)
			if !isControl || msgType != "incompatible" {
				t.Fatalf("frame did not classify as an incompatible control message: type=%q control=%v",
					msgType, isControl)
			}
			var incompat incompatibleMsg
			if err := json.Unmarshal(got.Data, &incompat); err != nil {
				t.Fatalf("frame is not valid JSON after the cap trim: %v", err)
			}
			if incompat.Reason == "" {
				t.Fatal("the reason was trimmed away entirely")
			}
			// The pv range has to OVERLAP ours, or the peer rebuilds the message
			// from pv/pvMin and prints an update remedy instead of the reason.
			if ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv); !ok {
				t.Fatalf("pv range %d-%d does not overlap ours; the reason would be replaced by an update hint",
					incompat.PvMin, incompat.Pv)
			}
		})
	}
}

// TestReceiverReadsTheRelayCapReason is the issue's headline case, end to end.
// A real sender blocked by the 2 GB relay cap now tells a real receiver why,
// instead of leaving it to guess from a bare close.
func TestReceiverReadsTheRelayCapReason(t *testing.T) {
	orig := pathTypeFn
	t.Cleanup(func() { pathTypeFn = orig })
	pathTypeFn = func(*webrtc.DataChannel) (string, error) { return "relay", nil }

	// Sparse, so nothing like 2 GB is actually written.
	path := filepath.Join(t.TempDir(), "huge.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(RelaySizeLimit + 1); err != nil {
		f.Close()
		t.Skipf("cannot create sparse file: %v", err)
	}
	f.Close()

	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(rdc, outDir, true, "", "", ReceiveOptions{
			Messages: msgs,
			Closed:   closed,
		})
	}()

	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFiles(sender, []string{path}, "") }()

	select {
	case err := <-sendErr:
		if !errors.Is(err, ErrRelayOverLimit) {
			t.Fatalf("sender error = %v, want ErrRelayOverLimit", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("SendFiles did not return")
	}

	select {
	case err := <-recvErr:
		if err == nil {
			t.Fatal("receiver reported success for a blocked transfer")
		}
		if !strings.Contains(err.Error(), "capped at 2 GB") {
			t.Fatalf("receiver error does not carry the sender's reason: %v", err)
		}
		if strings.Contains(err.Error(), "connection closed before any file") {
			t.Fatalf("receiver fell back to its close diagnosis: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
}

// TestSenderReadsAReasonForTheLastFile is the case the per-file ack loop
// cannot cover, and it is the common one: a single-file transfer has no next
// file, so a receiver that refuses it sends its reason into the sender drain
// loop instead. Before abortFromPeer the drain loop matched only "received",
// discarded the frame, and printed a success summary over a receiver that had
// kept nothing.
func TestSenderReadsAReasonForTheLastFile(t *testing.T) {
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	defer closeFn()

	src := filepath.Join(t.TempDir(), "only.bin")
	if err := os.WriteFile(src, make([]byte, 64), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFiles(sender, []string{src}, "") }()

	// Ack the one file, let its bytes and the end marker through, then refuse
	// it. A scripted receiver, because the real one cannot be made to discard a
	// file that the real sender now bounds correctly.
	var meta struct {
		ID string `json:"id"`
	}
	select {
	case m := <-msgs:
		if err := json.Unmarshal(m.Data, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first message is not the metadata: %q", m.Data)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("metadata never arrived")
	}
	if err := rdc.Send([]byte(`{"type":"ack","id":"` + meta.ID + `","offset":0,"pv":1,"pvMin":1}`)); err != nil {
		t.Fatalf("ack: %v", err)
	}
	for {
		select {
		case m := <-msgs:
			if msgType, ok := classifyControl(m.Data); ok && msgType == "end" {
				goto refuse
			}
		case <-time.After(20 * time.Second):
			t.Fatal("the end marker never arrived")
		}
	}
refuse:
	// The same frame a real receiver sends: binary, pv range overlapping.
	refusal, _ := json.Marshal(incompatibleMsg{
		Type:   "incompatible",
		Reason: "receiver discarded a file: incomplete file \"only.bin\": received 40 of 64 bytes",
		Pv:     ProtocolVersion,
		PvMin:  MinProtocolVersion,
	})
	if err := rdc.Send(refusal); err != nil {
		t.Fatalf("refusal: %v", err)
	}

	select {
	case err := <-sendErr:
		if err == nil {
			t.Fatal("sender reported success over a receiver that kept nothing")
		}
		if !strings.Contains(err.Error(), "incomplete file") {
			t.Fatalf("sender error does not carry the reason: %v", err)
		}
		if strings.Contains(err.Error(), "floe update") {
			t.Fatalf("sender turned an overlapping range into an update hint: %v", err)
		}
	case <-time.After(40 * time.Second):
		t.Fatal("SendFiles did not return")
	}
}

// TestSenderReadsTheReceiversIntegrityReason: a receiver that discards a file
// now says so, so a sender with more files to send fails at once instead of
// waiting out its 120 s ack deadline and blaming a timeout.
func TestSenderReadsTheReceiversIntegrityReason(t *testing.T) {
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	// Watch what comes back to the sender.
	back := make(chan webrtc.DataChannelMessage, 8)
	sender.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case back <- m:
		default:
		}
	})

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(rdc, outDir, true, "", "", ReceiveOptions{
			Messages: msgs,
			Closed:   closed,
		})
	}()

	// A hand-written sender: announce 100 bytes, deliver 40, close the file off.
	meta := `{"type":"metadata","id":"a","fileName":"short.bin","fileSize":100,"index":1,"total":2,"totalBytes":140,"pv":1,"pvMin":1}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	// Drain the ack so it does not get mistaken for the abort below.
	select {
	case <-back:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver never acked")
	}
	if err := sender.Send(make([]byte, 40)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "incomplete file") {
			t.Fatalf("receiver error = %v, want an incomplete-file error", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}

	select {
	case m := <-back:
		var incompat incompatibleMsg
		if err := json.Unmarshal(m.Data, &incompat); err != nil {
			t.Fatalf("frame back to the sender is not JSON: %q", m.Data)
		}
		if incompat.Type != "incompatible" {
			t.Fatalf("frame back to the sender is a %q, want incompatible", incompat.Type)
		}
		if !strings.Contains(incompat.Reason, "incomplete file") {
			t.Fatalf("reason does not name the cause: %q", incompat.Reason)
		}
		// A real Go sender turns this into the reason itself, not an update
		// hint, because the pv ranges overlap. That is the whole reason this
		// reuses "incompatible" rather than adding a type.
		got := compatErrorFromIncompatible("test-ver", "", incompat)
		if !strings.Contains(got, "incomplete file") {
			t.Fatalf("a sender would print %q, which does not carry the reason", got)
		}
		if strings.Contains(got, "floe update") {
			t.Fatalf("a sender would tell the reader to update: %q", got)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receiver never told the sender why")
	}
}
