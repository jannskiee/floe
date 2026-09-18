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
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

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

// TestAbortWithCodeKeepsCodeWhenReasonShrinks pins the one rule a coded frame
// adds to the cap: only the reason shrinks. A current reader acts on code and
// saved, so trimming the frame to fit must never cost either of them, and the
// frame must still fit, or a browser sender reads it as nothing at all.
func TestAbortWithCodeKeepsCodeWhenReasonShrinks(t *testing.T) {
	// abortReason's frame is unchanged by the generalization: no code key and
	// no saved key, byte for byte what shipped peers already read.
	if got, want := string(incompatibleFrame("v1.10.10", "", "stop", -1)),
		`{"type":"incompatible","reason":"stop","pv":1,"pvMin":1,"ver":"v1.10.10"}`; got != want {
		t.Fatalf("uncoded frame = %s, want %s", got, want)
	}

	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	defer closeFn()
	select {
	case <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	cases := []struct {
		name   string
		code   RefusalCode
		reason string
		saved  int
	}{
		// 2,000 bytes of plain text: a budget halving or two.
		{"ascii", CodeWriteFailed, strings.Repeat("x", 2000), 3},
		// Go's encoder writes each '<' as the 6-byte escape \u003c, so
		// 2,000 bytes of reason cost 12,000 on the wire. Saved 0 must still be sent.
		{"escaped", CodeHashMismatch, strings.Repeat("<", 2000), 0},
		// Three bytes per rune; a negative saved omits the field.
		{"multibyte", CodeWriteFailed, strings.Repeat("\u6587", 667), -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The pumped side stands in for a sender reading a receiver's frame.
			AbortWithCode(sender, "desktop-v0.3.0", tc.code, tc.reason, tc.saved)

			var got webrtc.DataChannelMessage
			select {
			case got = <-msgs:
			case <-time.After(20 * time.Second):
				t.Fatal("the coded frame never arrived")
			}
			if got.IsString {
				t.Fatal("a receiver-to-sender frame must be BINARY")
			}
			if len(got.Data) > controlMsgMax {
				t.Fatalf("encoded frame is %d bytes, over the %d cap", len(got.Data), controlMsgMax)
			}
			if msgType, ok := classifyControl(got.Data); !ok || msgType != "incompatible" {
				t.Fatalf("frame did not classify as incompatible: type=%q control=%v", msgType, ok)
			}
			var incompat incompatibleMsg
			if err := json.Unmarshal(got.Data, &incompat); err != nil {
				t.Fatalf("frame is not valid JSON: %v", err)
			}
			if incompat.Code != string(tc.code) {
				t.Fatalf("code = %q, want %q (dropped to make room?)", incompat.Code, tc.code)
			}
			switch {
			case tc.saved < 0 && incompat.Saved != nil:
				t.Fatalf("saved = %d, want the field omitted for a negative count", *incompat.Saved)
			case tc.saved >= 0 && incompat.Saved == nil:
				t.Fatalf("saved was dropped, want %d", tc.saved)
			case tc.saved >= 0 && *incompat.Saved != tc.saved:
				t.Fatalf("saved = %d, want %d", *incompat.Saved, tc.saved)
			}
			// Shrunk, not emptied: 1,000 bytes leave room for a real reason.
			if incompat.Reason == "" || len(incompat.Reason) >= len(tc.reason) {
				t.Fatalf("reason was not shrunk to fit (%d bytes of %d)", len(incompat.Reason), len(tc.reason))
			}
			if !strings.HasPrefix(tc.reason, strings.TrimSuffix(incompat.Reason, "\u2026")) {
				t.Fatalf("shrunk reason is not a prefix of the original: %q", incompat.Reason)
			}
			if ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv); !ok {
				t.Fatalf("pv range %d-%d does not overlap ours", incompat.PvMin, incompat.Pv)
			}
		})
	}
}

// TestReceiverSyncErrorSendsWriteFailed is the Phase 0 exit criterion for the
// end arm: a flush that fails on our OWN handle (a network share, a USB bridge,
// a delayed write error) used to share the abandon branch, so the .part stayed
// on disk forever and the sender heard nothing but a close. Now the .part goes,
// the sender is told write-failed within 2 s, and the caller gets a typed error.
//
// Two files, and only the second fails, so saved is proved to count the file
// that was committed before the failure and not a constant.
func TestReceiverSyncErrorSendsWriteFailed(t *testing.T) {
	simulated := errors.New("simulated delayed write failure")
	orig := syncPart
	t.Cleanup(func() { syncPart = orig })
	syncPart = func(f *os.File) error {
		if filepath.Base(f.Name()) == "second.bin"+partSuffix {
			return simulated
		}
		return f.Sync()
	}

	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

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
		recvErr <- ReceiveFilesWithOptions(rdc, outDir, true, "test-ver", "", ReceiveOptions{
			Messages: msgs,
			Closed:   closed,
		})
	}()

	// A hand-written sender: metadata, wait for the ack, the bytes, end. The
	// second ack also proves the first file was committed, because the receive
	// loop handles the first end before it reads the second metadata.
	var endSent time.Time
	for _, name := range []string{"first", "second"} {
		index := 1
		if name == "second" {
			index = 2
		}
		meta := fmt.Sprintf(`{"type":"metadata","id":"wf-%d","fileName":"%s.bin","fileSize":4,"index":%d,"total":2,"totalBytes":8,"pv":1,"pvMin":1}`,
			index, name, index)
		if err := sender.SendText(meta); err != nil {
			t.Fatalf("SendText metadata %s: %v", name, err)
		}
		select {
		case <-back:
		case <-time.After(20 * time.Second):
			t.Fatalf("receiver never acked %s.bin", name)
		}
		if err := sender.Send([]byte("data")); err != nil {
			t.Fatalf("Send chunk %s: %v", name, err)
		}
		if err := sender.SendText(`{"type":"end"}`); err != nil {
			t.Fatalf("SendText end %s: %v", name, err)
		}
		endSent = time.Now()
	}

	// The sender is told within 2 s of its end marker, not at a close.
	var got webrtc.DataChannelMessage
	select {
	case got = <-back:
	case <-time.After(2*time.Second - time.Since(endSent)):
		t.Fatal("the sender was not told within 2 s of the end marker")
	}
	if got.IsString {
		t.Fatal("the refusal must be BINARY toward a sender")
	}
	if len(got.Data) > controlMsgMax {
		t.Fatalf("refusal frame is %d bytes, over the %d cap", len(got.Data), controlMsgMax)
	}
	var incompat incompatibleMsg
	if err := json.Unmarshal(got.Data, &incompat); err != nil || incompat.Type != "incompatible" {
		t.Fatalf("frame back to the sender is not an incompatible: %q (%v)", got.Data, err)
	}
	if incompat.Code != string(CodeWriteFailed) {
		t.Fatalf("code = %q, want %q", incompat.Code, CodeWriteFailed)
	}
	if incompat.Saved == nil || *incompat.Saved != 1 {
		t.Fatalf("saved = %v, want 1 (first.bin was committed)", incompat.Saved)
	}
	if ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv); !ok {
		t.Fatalf("pv range %d-%d does not overlap ours; a shipped sender would print an update hint", incompat.PvMin, incompat.Pv)
	}
	// Shown verbatim by every sender that predates code, so it names no file,
	// no folder and no surface.
	if incompat.Reason != "receiver could not finish writing a file" {
		t.Fatalf("reason = %q", incompat.Reason)
	}

	select {
	case err := <-recvErr:
		var refused *RefusedError
		if !errors.As(err, &refused) {
			t.Fatalf("receiver error = %v (%T), want *RefusedError", err, err)
		}
		if refused.Code != CodeWriteFailed || refused.Saved != 1 {
			t.Fatalf("RefusedError{Code: %q, Saved: %d}, want write-failed and 1", refused.Code, refused.Saved)
		}
		if !errors.Is(err, simulated) {
			t.Fatalf("the local cause is not reachable with errors.Is: %v", err)
		}
		if msg := err.Error(); strings.Contains(msg, "second") || strings.Contains(msg, "simulated") {
			t.Fatalf("Error() must be fixed wording, got %q", msg)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}

	// The failed file left nothing: no .part and no final name. The file that
	// completed before it is kept.
	if left := listDir(t, outDir); len(left) != 1 || left[0] != "first.bin" {
		t.Fatalf("expected only first.bin to remain, found %v", left)
	}
}

// TestReceiverWriteErrorClassifiesDiskFull: a chunk write that fails on this
// side's own handle used to return a raw "write error" and send nothing, so
// the sender waited out its ack deadline. Now the sender is told within 2 s,
// disk-full when the OS says the drive is full and write-failed for anything
// else, the caller gets a *RefusedError with the cause reachable and a fixed
// sentence, and no .part remains. Two files with the second failing, so saved
// is proved to count. The Sync arm is classified the same way, so one of the
// full-drive cases fails there instead of on the write.
func TestReceiverWriteErrorClassifiesDiskFull(t *testing.T) {
	type tc struct {
		name     string
		err      error
		onSync   bool
		wantCode RefusalCode
	}
	pathErr := func(op string, errno syscall.Errno) error {
		return &os.PathError{Op: op, Path: "second.bin" + partSuffix, Err: errno}
	}
	cases := []tc{
		{"ENOSPC on write", pathErr("write", syscall.ENOSPC), false, CodeDiskFull},
		{"ENOSPC on sync", pathErr("sync", syscall.ENOSPC), true, CodeDiskFull},
		{"any other error on write", errors.New("simulated I/O failure"), false, CodeWriteFailed},
		{"any other error on sync", errors.New("simulated delayed write failure"), true, CodeWriteFailed},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases,
			tc{"ERROR_DISK_FULL on write", pathErr("write", syscall.Errno(112)), false, CodeDiskFull},
			tc{"ERROR_HANDLE_DISK_FULL on write", pathErr("write", syscall.Errno(39)), false, CodeDiskFull},
		)
	} else {
		// 112 and 39 are other errnos off Windows and must not read as full.
		cases = append(cases, tc{"errno 112 elsewhere", pathErr("write", syscall.Errno(112)), false, CodeWriteFailed})
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			origWrite, origSync := writePart, syncPart
			t.Cleanup(func() { writePart, syncPart = origWrite, origSync })
			failing := func(f *os.File) bool { return filepath.Base(f.Name()) == "second.bin"+partSuffix }
			writePart = func(f *os.File, b []byte) (int, error) {
				if !c.onSync && failing(f) {
					return 0, c.err
				}
				return f.Write(b)
			}
			syncPart = func(f *os.File) error {
				if c.onSync && failing(f) {
					return c.err
				}
				return f.Sync()
			}

			h := newHandSender(t)
			h.meta("first.bin", 4, 1, 2, 8)
			h.bytes([]byte("data"))
			h.text(`{"type":"end"}`)
			h.meta("second.bin", 4, 2, 2, 8)
			at := time.Now()
			h.bytes([]byte("data"))
			if c.onSync {
				h.text(`{"type":"end"}`)
			}
			res := h.finish()

			incompat := findRefusal(t, res.frames)
			if took := res.firstAt.Sub(at); took > 2*time.Second {
				t.Fatalf("the sender was told %v after the failing frame, want within 2 s", took)
			}
			if incompat.Code != string(c.wantCode) {
				t.Fatalf("code = %q, want %q", incompat.Code, c.wantCode)
			}
			if incompat.Saved == nil || *incompat.Saved != 1 {
				t.Fatalf("saved = %v, want 1 (first.bin was committed)", incompat.Saved)
			}
			if incompat.Reason != c.wantCode.WireReason() {
				t.Fatalf("reason = %q, want %q", incompat.Reason, c.wantCode.WireReason())
			}
			if ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv); !ok {
				t.Fatalf("pv range %d-%d does not overlap ours", incompat.PvMin, incompat.Pv)
			}
			var refused *RefusedError
			if !errors.As(res.err, &refused) {
				t.Fatalf("receiver error = %v (%T), want *RefusedError", res.err, res.err)
			}
			if refused.Code != c.wantCode || refused.Saved != 1 {
				t.Fatalf("RefusedError{%q, %d}, want {%q, 1}", refused.Code, refused.Saved, c.wantCode)
			}
			if !errors.Is(res.err, c.err) {
				t.Fatalf("the cause is not reachable with errors.Is: %v", res.err)
			}
			if msg := res.err.Error(); strings.Contains(msg, "second") || strings.Contains(msg, "simulated") || strings.Contains(msg, partSuffix) {
				t.Fatalf("Error() must be fixed wording, got %q", msg)
			}
			if !strings.HasPrefix(res.err.Error(), "write error: ") {
				t.Fatalf("Error() = %q, want the write error prefix the desktop maps", res.err.Error())
			}
			if left := listDir(t, h.dir); len(left) != 1 || left[0] != "first.bin" {
				t.Fatalf("expected only first.bin to remain, found %v", left)
			}
		})
	}
}

// TestReceiverCreateErrorSendsWriteFailedFrame: a name the filesystem refuses
// at claim time used to fail after Accept with a raw OS error and no frame to
// the sender (a 704-byte name did exactly that on Windows). Now the sender
// receives write-failed with the create-time reason within 2 s of the
// metadata, the receiver returns a *RefusedError, and nothing is left on
// disk. The first two cases fail the claim through the openPart seam with
// the errors a long name and a full drive produce, so they do not depend on
// the temp volume's limits; the last sends the real 704-byte name and skips
// only if this filesystem accepts it.
func TestReceiverCreateErrorSendsWriteFailedFrame(t *testing.T) {
	cases := []struct {
		name       string
		claimErr   error // nil means the real claimPart
		fileName   string
		wantCode   RefusalCode
		wantReason string
	}{
		{"name too long", &os.PathError{Op: "open", Path: "long.part", Err: syscall.ENAMETOOLONG}, "deep.bin", CodeWriteFailed, "receiver could not create a file"},
		{"drive full at claim", &os.PathError{Op: "open", Path: "x.part", Err: syscall.ENOSPC}, "deep.bin", CodeDiskFull, CodeDiskFull.WireReason()},
		{"real 704-byte name", nil, strings.Repeat("n", 700) + ".bin", CodeWriteFailed, "receiver could not create a file"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.claimErr != nil {
				orig := openPart
				t.Cleanup(func() { openPart = orig })
				openPart = func(string, *nameHints) (*os.File, string, error) { return nil, "", tc.claimErr }
			}
			h := newHandSender(t)
			meta := fmt.Sprintf(`{"type":"metadata","id":"c-1","fileName":%q,"fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1}`, tc.fileName)
			if len(meta) > controlMsgMax {
				t.Fatalf("fixture is %d bytes, must stay under the control cap", len(meta))
			}
			at := time.Now()
			h.text(meta)

			// The receiver either acks (the claim succeeded) or refuses.
			var first webrtc.DataChannelMessage
			select {
			case first = <-h.back:
			case <-time.After(20 * time.Second):
				t.Fatal("the receiver neither acked nor refused")
			}
			if msgType, ok := classifyControl(first.Data); ok && msgType == "ack" {
				if tc.claimErr != nil {
					t.Fatal("the receiver acked although the claim was failed")
				}
				_ = h.sender.Close()
				h.finish()
				t.Skipf("this filesystem accepts a %d-byte name component", len(tc.fileName))
			}
			if time.Since(at) > 2*time.Second {
				t.Fatalf("the sender was told %v after the metadata, want within 2 s", time.Since(at))
			}
			res := h.finish()
			incompat := findRefusal(t, append([][]byte{first.Data}, res.frames...))
			if incompat.Code != string(tc.wantCode) {
				t.Fatalf("code = %q, want %q", incompat.Code, tc.wantCode)
			}
			if incompat.Saved == nil || *incompat.Saved != 0 {
				t.Fatalf("saved = %v, want 0", incompat.Saved)
			}
			if incompat.Reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", incompat.Reason, tc.wantReason)
			}
			if strings.Contains(incompat.Reason, "nnn") || strings.Contains(incompat.Reason, "deep") {
				t.Fatalf("the file name reached the wire reason: %q", incompat.Reason)
			}
			var refused *RefusedError
			if !errors.As(res.err, &refused) || refused.Code != tc.wantCode || refused.Saved != 0 {
				t.Fatalf("receiver error = %v (%T), want *RefusedError{%q, 0}", res.err, res.err, tc.wantCode)
			}
			if tc.claimErr != nil && !errors.Is(res.err, tc.claimErr) {
				t.Fatalf("the cause is not reachable with errors.Is: %v", res.err)
			}
			if msg := res.err.Error(); strings.Contains(msg, "deep") || strings.Contains(msg, "nnn") || strings.Contains(msg, partSuffix) {
				t.Fatalf("Error() must be fixed wording, got %q", msg)
			}
			if left := listDir(t, h.dir); len(left) != 0 {
				t.Fatalf("expected nothing on disk, found %v", left)
			}
		})
	}
}

// TestAbortWithCodeFrameFitsCap is the frame budget proof for the largest
// coded frame: the longest code, a five-digit saved, a 64-rune ver and a
// 300-rune reason, in three alphabets whose worst per-rune wire cost differs
// (1 byte, 3 bytes, and 6 for a character Go escapes). Pure, on the encoder:
// the frame fits the cap, code and saved survive whole, ver never shrinks,
// the ASCII reason arrives unshrunk and the other two shrunk but not emptied.
// The floor with an empty reason is also pinned, well under half the cap, so
// code and saved can never be what pushes a frame over it.
func TestAbortWithCodeFrameFitsCap(t *testing.T) {
	longest := CodeFileTooLargeForFolder
	for _, c := range RefusalCodes {
		if len(c) > len(longest) {
			t.Fatalf("%q is longer than %q; the budget below assumes the longest code", c, longest)
		}
	}
	const saved = 10000
	cases := []struct {
		name      string
		ver       string
		reason    string
		wantWhole bool
	}{
		{"ascii", strings.Repeat("v", 64), strings.Repeat("r", 300), true},
		{"cjk", strings.Repeat("文", 64), strings.Repeat("文", 300), false},
		{"escaped", strings.Repeat("<", 64), strings.Repeat("<", 300), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			frame := incompatibleFrame(tc.ver, longest, tc.reason, saved)
			if len(frame) > controlMsgMax {
				t.Fatalf("frame is %d bytes, over the %d cap", len(frame), controlMsgMax)
			}
			if msgType, ok := classifyControl(frame); !ok || msgType != "incompatible" {
				t.Fatalf("frame did not classify as incompatible: type=%q control=%v", msgType, ok)
			}
			var incompat incompatibleMsg
			if err := json.Unmarshal(frame, &incompat); err != nil {
				t.Fatalf("frame is not valid JSON: %v", err)
			}
			if incompat.Code != string(longest) {
				t.Fatalf("code = %q, want %q", incompat.Code, longest)
			}
			if incompat.Saved == nil || *incompat.Saved != saved {
				t.Fatalf("saved = %v, want %d", incompat.Saved, saved)
			}
			if incompat.Ver != tc.ver {
				t.Fatalf("ver was changed to fit: %q", incompat.Ver)
			}
			if ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv); !ok {
				t.Fatalf("pv range %d-%d does not overlap ours", incompat.PvMin, incompat.Pv)
			}
			if tc.wantWhole {
				if incompat.Reason != tc.reason {
					t.Fatalf("the ASCII reason was shrunk: %d of %d runes", utf8.RuneCountInString(incompat.Reason), 300)
				}
				return
			}
			if incompat.Reason == "" || utf8.RuneCountInString(incompat.Reason) >= 300 {
				t.Fatalf("reason was not shrunk to fit (%d runes)", utf8.RuneCountInString(incompat.Reason))
			}
			if !strings.HasPrefix(tc.reason, strings.TrimSuffix(incompat.Reason, "…")) {
				t.Fatalf("shrunk reason is not a prefix of the original: %q", incompat.Reason)
			}
		})
	}
	floor := incompatibleFrame(strings.Repeat("<", 64), longest, "", saved)
	if len(floor) > controlMsgMax/2 {
		t.Fatalf("the frame with an empty reason is %d bytes; code and saved must never be what crosses the cap", len(floor))
	}
}

// TestEveryRefusalCodeReachesGoSenderWithin2s: for each of the twelve codes, a
// receiver that refuses from its metadata arm (a coded frame instead of the
// ack) makes SendFiles return a *PeerStoppedError with that code and its
// clamped saved count within 2 s, and nothing the peer wrote is in the text.
// One pair for all twelve rounds: the sender's channel outlives each call.
func TestEveryRefusalCodeReachesGoSenderWithin2s(t *testing.T) {
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	defer closeFn()
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "only.bin")
	if err := os.WriteFile(src, make([]byte, 64), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	for i, code := range RefusalCodes {
		saved := i % 2 // one file, so the clamp keeps 0 or 1
		t.Run(string(code), func(t *testing.T) {
			sendErr := make(chan error, 1)
			go func() { sendErr <- SendFiles(sender, []string{src}, "test-ver") }()

			select {
			case m := <-msgs:
				if msgType, ok := classifyControl(m.Data); !ok || msgType != "metadata" {
					t.Fatalf("first message is not the metadata: %q", m.Data)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("metadata never arrived")
			}
			sentAt := time.Now()
			AbortWithCode(rdc, "test-ver", code, code.WireReason(), saved)

			select {
			case err := <-sendErr:
				if took := time.Since(sentAt); took > 2*time.Second {
					t.Fatalf("the sender returned %v after the refusal, want within 2 s", took)
				}
				var stopped *PeerStoppedError
				if !errors.As(err, &stopped) {
					t.Fatalf("sender error = %v (%T), want *PeerStoppedError", err, err)
				}
				if stopped.Code != code || stopped.Saved != saved {
					t.Fatalf("PeerStoppedError{%q, %d}, want {%q, %d}", stopped.Code, stopped.Saved, code, saved)
				}
				if got, want := err.Error(), "error sending only.bin: "+stopped.Error(); got != want {
					t.Fatalf("sender error text = %q, want %q", got, want)
				}
				if strings.Contains(err.Error(), code.WireReason()) {
					t.Fatalf("the wire reason reached the sender's text: %q", err.Error())
				}
			case <-time.After(10 * time.Second):
				t.Fatal("SendFiles did not return")
			}
		})
	}
	if left := listDir(t, srcDir); len(left) != 1 || left[0] != "only.bin" {
		t.Fatalf("the sender's folder changed: %v", left)
	}
}

// TestSenderUnknownCodeKeepsReasonText: a code this build does not know, or
// no code at all, is not a refusal it can name, so the frame reads exactly as
// it did before code existed: the peer's reason through displayText, or the
// rebuilt version mismatch. Nothing became mandatory.
func TestSenderUnknownCodeKeepsReasonText(t *testing.T) {
	prose := "old peer prose\x1b[2K‮ tail"
	want := displayText(prose, maxDisplayReason)
	if want == prose || strings.Contains(want, "\x1b") {
		t.Fatalf("fixture is not hostile enough: %q", want)
	}
	frame := func(fields string) []byte {
		reason, _ := json.Marshal(prose)
		return []byte(`{"type":"incompatible","reason":` + string(reason) + `,"pv":1,"pvMin":1` + fields + `}`)
	}
	for name, raw := range map[string][]byte{
		"unknown code":  frame(`,"code":"too-slow","saved":3`),
		"absent code":   frame(``),
		"numeric code":  frame(`,"code":7`),
		"null code":     frame(`,"code":null`),
		"code key case": frame(`,"CODE":"declined"`),
	} {
		err := abortFromPeer(raw, "v1", "", 3)
		if err == nil {
			t.Fatalf("%s: abortFromPeer returned nil for an incompatible frame", name)
		}
		var stopped *PeerStoppedError
		if errors.As(err, &stopped) {
			t.Fatalf("%s: became a PeerStoppedError{%q}", name, stopped.Code)
		}
		if err.Error() != want {
			t.Fatalf("%s: text = %q, want the reason through displayText %q", name, err.Error(), want)
		}
	}
	if err := abortFromPeer(nil, "v1", "", 3); err != nil {
		t.Fatalf("an empty frame returned %v", err)
	}
	// A version mismatch with an unknown code is still rebuilt locally.
	mismatch := []byte(`{"type":"incompatible","reason":"x","pv":9,"pvMin":9,"code":"nope"}`)
	if err := abortFromPeer(mismatch, "v1", "", 3); err == nil || !strings.Contains(err.Error(), "Cannot transfer") {
		t.Fatalf("a disjoint range with an unknown code = %v, want the rebuilt mismatch", err)
	}
	if err := abortFromPeer([]byte(`{"type":"ack","id":"x","offset":0}`), "v1", "", 3); err != nil {
		t.Fatalf("an ack returned %v", err)
	}
	if err := abortFromPeer([]byte(`{"type":"incompatible","reason":"`+strings.Repeat("o", controlMsgMax)+`","pv":1,"pvMin":1,"code":"declined"}`), "v1", "", 3); err != nil {
		t.Fatalf("an over-cap frame returned %v", err)
	}
}

// TestAbortFromPeerReadsCodeAndSavedByExactKey pins the reader's decisions
// against the browser's: code and saved by exact key, saved as an
// integer-valued number clamped to [0, total] and 0 otherwise, a mistyped
// optional field tolerated rather than dropping the frame, and a known code
// winning over a disjoint pv range.
func TestAbortFromPeerReadsCodeAndSavedByExactKey(t *testing.T) {
	const total = 3
	cases := []struct {
		name      string
		frame     string
		wantCode  RefusalCode // "" means not a PeerStoppedError
		wantSaved int
	}{
		{"saved string", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":"x"}`, CodeWriteFailed, 0},
		{"saved 1e300 clamps to total", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":1e300}`, CodeWriteFailed, total},
		{"saved 1e999 is out of range", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":1e999}`, CodeWriteFailed, 0},
		{"saved 3.0", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":3.0}`, CodeWriteFailed, 3},
		{"saved 2.5", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":2.5}`, CodeWriteFailed, 0},
		{"saved -1", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":-1}`, CodeWriteFailed, 0},
		{"saved 2", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":2}`, CodeWriteFailed, 2},
		{"saved null", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","saved":null}`, CodeWriteFailed, 0},
		{"saved absent", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed"}`, CodeWriteFailed, 0},
		{"saved key case", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"write-failed","SAVED":2}`, CodeWriteFailed, 0},
		{"known code wins over a disjoint range", `{"type":"incompatible","reason":"x","pv":9,"pvMin":9,"code":"declined","saved":1}`, CodeDeclined, 1},
		{"pv string with code", `{"type":"incompatible","reason":"x","pv":"1","pvMin":1,"code":"expired"}`, CodeExpired, 0},
		{"reason number with code", `{"type":"incompatible","reason":7,"pv":1,"pvMin":1,"code":"stopped","saved":1}`, CodeStopped, 1},
		{"duplicate code bad then good", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"nope","code":"time-limit"}`, CodeTimeLimit, 0},
		{"duplicate code good then bad", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"time-limit","code":"nope"}`, "", 0},
		{"code key case", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"CODE":"declined"}`, "", 0},
		{"code with surrounding space", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":" declined"}`, "", 0},
		{"code upper", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"DECLINED"}`, "", 0},
		{"code array", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":["declined"]}`, "", 0},
		{"code escaped", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"declined"}`, CodeDeclined, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := abortFromPeer([]byte(tc.frame), "v1", "", total)
			if err == nil {
				t.Fatal("abortFromPeer returned nil for an incompatible frame")
			}
			var stopped *PeerStoppedError
			isStopped := errors.As(err, &stopped)
			if tc.wantCode == "" {
				if isStopped {
					t.Fatalf("became a PeerStoppedError{%q, %d}", stopped.Code, stopped.Saved)
				}
				return
			}
			if !isStopped {
				t.Fatalf("error = %v (%T), want *PeerStoppedError", err, err)
			}
			if stopped.Code != tc.wantCode || stopped.Saved != tc.wantSaved {
				t.Fatalf("PeerStoppedError{%q, %d}, want {%q, %d}", stopped.Code, stopped.Saved, tc.wantCode, tc.wantSaved)
			}
		})
	}
	for _, raw := range []string{
		`{"TYPE":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"declined"}`,
		`{"type":7,"code":"declined"}`,
		`{"type":"incompatible"`,
		`[{"type":"incompatible","code":"declined"}]`,
		`null`,
	} {
		if err := abortFromPeer([]byte(raw), "v1", "", total); err != nil {
			t.Errorf("%s: returned %v, want nil (not an incompatible frame)", raw, err)
		}
	}
}

// TestSenderAckWaitReadsTypeByExactKey: a frame whose type key is spelled
// "TYPE" is not an ack, as the browser already decided; a struct tag used to
// accept it here and start sending. The receiver answers the metadata with
// that frame first and a real ack 300 ms later, and no chunk may leave before
// the real one arrives.
func TestSenderAckWaitReadsTypeByExactKey(t *testing.T) {
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	defer closeFn()
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	src := filepath.Join(t.TempDir(), "only.bin")
	if err := os.WriteFile(src, make([]byte, 64), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFiles(sender, []string{src}, "") }()

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
	if err := rdc.Send([]byte(`{"TYPE":"ack","id":"` + meta.ID + `","offset":0,"pv":1,"pvMin":1}`)); err != nil {
		t.Fatalf("bad ack: %v", err)
	}
	select {
	case m := <-msgs:
		t.Fatalf("the sender acted on a frame whose type key is \"TYPE\" and sent %d bytes (string=%v)", len(m.Data), m.IsString)
	case <-time.After(300 * time.Millisecond):
	}
	if err := rdc.Send([]byte(`{"type":"ack","id":"` + meta.ID + `","offset":0,"pv":1,"pvMin":1}`)); err != nil {
		t.Fatalf("ack: %v", err)
	}
	for {
		select {
		case m := <-msgs:
			if msgType, ok := classifyControl(m.Data); ok && msgType == "end" {
				goto delivered
			}
		case <-time.After(20 * time.Second):
			t.Fatal("the end marker never arrived after the real ack")
		}
	}
delivered:
	if err := rdc.Send([]byte(`{"type":"received","verified":0}`)); err != nil {
		t.Fatalf("received: %v", err)
	}
	select {
	case err := <-sendErr:
		if err != nil {
			t.Fatalf("SendFiles returned %v after the real ack", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("SendFiles did not return")
	}
}
