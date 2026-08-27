// Hostile-peer tests: everything a sender can put in a metadata or an
// incompatible message reaches a person through the Incoming box, the accept
// prompt, the GUI callbacks, the progress line and the returned error. None of
// it may carry a control character, a bidi mark or an unbounded length there,
// and no number in it may crash the receiver. Driven with raw senders over
// real in-process pion pairs (see loopback_test.go and early_test.go for the
// harnesses). Every fixture is hostile on purpose, and the file references no
// symbol the fix introduced, so it compiles against the pre-fix engine and
// documents the failure it replaced.
package transfer

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"
)

// captureStdout swaps os.Stdout for a pipe and returns a function that
// restores it and yields everything printed in between. The receiver prints
// the Incoming box, the peer-version note and the summary straight to
// os.Stdout, so this is the only way to assert on what a person would see.
// The package has no t.Parallel, so a process-wide swap is safe; the Cleanup
// restores the original even when an assertion fails before the explicit
// restore runs.
func captureStdout(t *testing.T) func() string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	var buf bytes.Buffer
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(&buf, r)
		close(drained)
	}()
	restored := false
	restore := func() string {
		if restored {
			return buf.String()
		}
		restored = true
		os.Stdout = orig
		_ = w.Close()
		<-drained
		_ = r.Close()
		return buf.String()
	}
	t.Cleanup(func() { restore() })
	return restore
}

// TestReceiverRejectsImpossibleSizes: a metadata whose numbers cannot describe
// a file ends the receive with an error before the Incoming box, the accept
// prompt or OnIncoming, and leaves nothing on disk.
//
// Before the fix, rows 1 and 2 panicked the test binary: parseMetadata
// converted -1 and 1e300 to a negative int64 (int64 of an out-of-range float
// is MinInt64 on amd64), formatBytes took math.Log of it, got NaN, indexed
// units with int(NaN) and died with "index out of range
// [-9223372036854775808]". The receive loop runs on a goroutine with no
// recover, so in the desktop app that ended the whole process before the
// person saw anything. Row 3 fired OnIncoming with "0 files", claimed a file
// and hung until the stall watchdog.
func TestReceiverRejectsImpossibleSizes(t *testing.T) {
	cases := []struct{ name, meta string }{
		{"negative sizes", `{"type":"metadata","id":"h-1","fileName":"neg.bin","fileSize":-1,"index":1,"total":1,"totalBytes":-1}`},
		{"size past int64", `{"type":"metadata","id":"h-2","fileName":"huge.bin","fileSize":1e300,"index":1,"total":1,"totalBytes":1e300}`},
		{"position zero", `{"type":"metadata","id":"h-3","fileName":"zero.bin","fileSize":4,"index":0,"total":0,"totalBytes":4}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sender, recvCh, closeFn := newConnectedPair(t)
			defer closeFn()

			outDir := t.TempDir()
			incoming := 0
			opts := ReceiveOptions{OnIncoming: func(IncomingInfo) { incoming++ }}
			recvErr := make(chan error, 1)
			go func() {
				dc := <-recvCh
				recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", opts)
			}()

			// Registered before the metadata goes out, so the reply cannot
			// land before anyone is listening.
			replies := watchReplies(sender)
			time.Sleep(300 * time.Millisecond)
			if err := sender.SendText(tc.meta); err != nil {
				t.Fatalf("SendText metadata: %v", err)
			}

			select {
			case err := <-recvErr:
				if err == nil || !strings.Contains(err.Error(), "file description") {
					t.Fatalf("expected a rejected file description, got: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("ReceiveFilesWithOptions did not return")
			}
			if incoming != 0 {
				t.Fatalf("OnIncoming fired %d times for an impossible announcement, want 0", incoming)
			}
			if left := listDir(t, outDir); len(left) != 0 {
				t.Fatalf("expected nothing on disk, found %v", left)
			}
			// The sender is told why, in a frame it already displays.
			expectRejectionFrame(t, replies)
		})
	}
}

// watchReplies collects what the receiver sends back on a raw sender channel.
// Register it before sending anything: pion drops a message delivered while
// the handler is still nil, and nothing arrives before the sender speaks.
func watchReplies(sender *webrtc.DataChannel) <-chan []byte {
	replies := make(chan []byte, 8)
	sender.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case replies <- m.Data:
		default:
		}
	})
	return replies
}

// expectRejectionFrame asserts the receiver explained its refusal on the
// wire as an "incompatible" whose reason names the file description, which is
// what both senders print instead of a bare "connection closed".
func expectRejectionFrame(t *testing.T, replies <-chan []byte) {
	t.Helper()
	select {
	case frame := <-replies:
		var incompat incompatibleMsg
		if err := json.Unmarshal(frame, &incompat); err != nil || incompat.Type != "incompatible" {
			t.Fatalf("expected an incompatible frame, got %q (%v)", frame, err)
		}
		if !strings.Contains(incompat.Reason, "file description") {
			t.Fatalf("reason does not name the file description: %q", incompat.Reason)
		}
		// A current sender rebuilds nothing here (the pv range overlaps), so
		// the reason is what it prints.
		if got := compatErrorFromIncompatible("", "", incompat); !strings.Contains(got, "file description") {
			t.Fatalf("sender-side message lost the reason: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the receiver never told the sender why it refused")
	}
}

// TestReceiverStopsAtAnnouncedSize: a sender that keeps going past the size it
// announced is stopped at the first frame that would cross the line, and the
// staging file is removed, so the announced size bounds what lands on disk
// instead of the end-of-file check catching it after the disk is full.
func TestReceiverStopsAtAnnouncedSize(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"h-6","fileName":"over.bin","fileSize":4,"index":1,"total":1,"totalBytes":4}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 8)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "announced size") {
			t.Fatalf("expected the announced size to be named, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	// Neither a finished file nor a .part: listDir walks every file.
	if left := listDir(t, outDir); len(left) != 0 {
		t.Fatalf("expected nothing on disk after the overrun, found %v", left)
	}
}

// TestSenderRejectsImpossibleOffset: the resume offset in an ack is refused
// when it lies outside the file, with the number named, instead of a bare
// Seek error for a negative one or a zero-byte send for one past the end.
func TestSenderRejectsImpossibleOffset(t *testing.T) {
	cases := []struct {
		name   string
		offset string // written into the JSON verbatim
	}{
		{"most negative int64", "-9223372036854775808"},
		{"one past the end", "65"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
			defer closeFn()

			src := filepath.Join(t.TempDir(), "offset.bin")
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

			var meta struct {
				ID string `json:"id"`
			}
			select {
			case m := <-msgs:
				if err := json.Unmarshal(m.Data, &meta); err != nil || meta.ID == "" {
					t.Fatalf("first message is not the metadata: %q", m.Data)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("sender's metadata never reached the receiver")
			}
			ack := `{"type":"ack","id":"` + meta.ID + `","offset":` + tc.offset + `,"pv":1,"pvMin":1}`
			if err := rdc.Send([]byte(ack)); err != nil {
				t.Fatalf("reply: %v", err)
			}

			select {
			case err := <-sendErr:
				if err == nil {
					t.Fatal("expected an error, got nil")
				}
				if !strings.Contains(err.Error(), "resume") || !strings.Contains(err.Error(), tc.offset) {
					t.Fatalf("expected the offset %s to be named in a resume error, got: %v", tc.offset, err)
				}
			case <-time.After(15 * time.Second):
				t.Fatal("SendFiles did not return")
			}
		})
	}
}

// TestSenderSeesReceiverRejection runs the real sender against the real
// receiver: the sender's own release string is long enough to push its
// metadata past the control cap, the receiver refuses it, and the sender's
// error carries the receiver's reason rather than a closed-connection notice.
func TestSenderSeesReceiverRejection(t *testing.T) {
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()

	src := filepath.Join(t.TempDir(), "hostile.bin")
	if err := os.WriteFile(src, make([]byte, 64), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
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
	go func() { sendErr <- SendFiles(sender, []string{src}, strings.Repeat("v", 1100)) }()

	select {
	case err := <-sendErr:
		if err == nil || !strings.Contains(err.Error(), "file description") {
			t.Fatalf("expected the receiver's reason in the sender's error, got: %v", err)
		}
		if strings.Contains(err.Error(), "connection closed") {
			t.Fatalf("sender reported the close instead of the reason: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("SendFiles did not return")
	}
	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "control message") {
			t.Fatalf("expected the receiver to name the control cap, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not return")
	}
	if left := listDir(t, outDir); len(left) != 0 {
		t.Fatalf("expected nothing on disk, found %v", left)
	}
}

// TestReceiverIncomingIsDisplaySafe: the name and version a sender chooses
// reach the terminal, OnIncoming and OnProgress only in their display form,
// while the on-disk name still comes from safeJoin.
//
// Before the fix, FirstName and every Progress.FileName carried the raw
// U+202E, the Incoming box printed it (so the accept prompt read
// "photoexe.png"), and the peer-version note printed a bare ESC sequence.
func TestReceiverIncomingIsDisplaySafe(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	var incoming []IncomingInfo
	var progress []Progress
	opts := ReceiveOptions{
		OnIncoming: func(inc IncomingInfo) { incoming = append(incoming, inc) },
		OnProgress: func(p Progress) { progress = append(progress, p) },
	}
	restore := captureStdout(t)
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "v0.0.0-test", "", opts)
	}()

	time.Sleep(300 * time.Millisecond)

	// JSON escapes keep the hostile characters out of this source file; the
	// receiver decodes them to the real U+202E and ESC.
	meta := `{"type":"metadata","id":"h-4","fileName":"photo\u202egnp.exe","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"\u001b[2Kbad"}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	_ = sender.Close()

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("expected success, got: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not return")
	}
	out := restore()

	const want = "photo_gnp.exe"
	if len(incoming) != 1 || incoming[0].FirstName != want {
		t.Fatalf("OnIncoming = %+v, want exactly one call with FirstName %q", incoming, want)
	}
	if len(progress) == 0 {
		t.Fatal("no progress events fired, so the FileName claim below is vacuous")
	}
	for _, p := range progress {
		if p.FileName != want {
			t.Errorf("Progress.FileName = %q, want %q", p.FileName, want)
		}
		if p.SavedName != want {
			t.Errorf("Progress.SavedName = %q, want %q", p.SavedName, want)
		}
	}
	if _, err := os.Stat(filepath.Join(outDir, want)); err != nil {
		t.Errorf("file missing at the sanitized name: %v", err)
	}
	for _, s := range []string{"Incoming", want, "Peer version: _[2Kbad"} {
		if !strings.Contains(out, s) {
			t.Errorf("stdout lacks %q:\n%s", s, out)
		}
	}
	if strings.Contains(out, "\u202e") || strings.Contains(out, "\x1b") {
		t.Errorf("a raw control or bidi character reached stdout:\n%q", out)
	}

	// More shapes, asserting FirstName only: the long name may fail at
	// claimPart (the OS caps a component at 255), which is fine here because
	// OnIncoming has already fired by then. The long name keeps its extension
	// across the cut, so the prompt still says what the file is.
	rows := []struct{ name, fileName, wantFirst string }{
		{"escape sequence", "\x1b[2Kfake.txt", "_[2Kfake.txt"},
		{"carriage return", "a\rb", "a_b"},
		{"400 rune name", strings.Repeat("n", 400) + ".txt", strings.Repeat("n", 195) + "….txt"},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			sender, recvCh, closeFn := newConnectedPair(t)
			defer closeFn()

			outDir := t.TempDir()
			got := make(chan IncomingInfo, 1)
			opts := ReceiveOptions{OnIncoming: func(inc IncomingInfo) { got <- inc }}
			restore := captureStdout(t)
			recvErr := make(chan error, 1)
			go func() {
				dc := <-recvCh
				recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", opts)
			}()

			time.Sleep(300 * time.Millisecond)
			meta, _ := json.Marshal(map[string]interface{}{
				"type": "metadata", "id": "h-" + row.name, "fileName": row.fileName,
				"fileSize": 4, "index": 1, "total": 1, "totalBytes": 4,
			})
			if err := sender.SendText(string(meta)); err != nil {
				t.Fatalf("SendText metadata: %v", err)
			}

			var inc IncomingInfo
			select {
			case inc = <-got:
			case <-time.After(10 * time.Second):
				t.Fatal("OnIncoming never fired")
			}
			_ = sender.Close()
			select {
			case <-recvErr:
			case <-time.After(10 * time.Second):
				t.Fatal("ReceiveFilesWithOptions did not return")
			}
			restore()

			if inc.FirstName != row.wantFirst {
				t.Errorf("FirstName = %q, want %q", inc.FirstName, row.wantFirst)
			}
		})
	}
}

// TestReceiverRejectsOversizeStringControl: a string past the control cap is
// never file data, so the receiver names the cap and ends the transfer rather
// than parsing whatever the peer put in it.
//
// Before the fix the cap was gated to binary, so this metadata parsed, its
// 1900-character name fired OnIncoming, and the receive died at claimPart with
// a file-system error instead.
func TestReceiverRejectsOversizeStringControl(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	incoming := 0
	opts := ReceiveOptions{OnIncoming: func(IncomingInfo) { incoming++ }}
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", opts)
	}()

	replies := watchReplies(sender)
	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"h-5","fileName":"` + strings.Repeat("n", 1900) + `","fileSize":4,"index":1,"total":1,"totalBytes":4}`
	if len(meta) <= 1000 {
		t.Fatalf("fixture is %d bytes, must exceed the control cap", len(meta))
	}
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "control message") {
			t.Fatalf("expected the control cap to be named, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not return")
	}
	if incoming != 0 {
		t.Fatalf("OnIncoming fired %d times for an over-cap string, want 0", incoming)
	}
	if left := listDir(t, outDir); len(left) != 0 {
		t.Fatalf("expected nothing on disk, found %v", left)
	}
	expectRejectionFrame(t, replies)
}

// TestSenderIncompatibleTextIsDisplaySafe: what a receiver puts in an
// incompatible message reaches the sender's terminal and the desktop status
// line only cleaned and capped, and a message past the control cap is not
// parsed at all.
//
// The pumped pair is used so the test can wait for the metadata to land at
// the receiver deterministically before replying; registering a handler on
// the receiver's channel after it opens would race pion's read loop (see
// early_test.go).
func TestSenderIncompatibleTextIsDisplaySafe(t *testing.T) {
	escReason := strings.Repeat("\x1b[2K\n", 75)
	escPayload, _ := json.Marshal(incompatibleMsg{Type: "incompatible", Reason: escReason, Pv: 1, PvMin: 1})
	bidiVer := strings.Repeat("v\u202e", 200)
	bidiPayload, _ := json.Marshal(incompatibleMsg{Type: "incompatible", Reason: "x", Pv: 2, PvMin: 2, Ver: bidiVer})
	hugePayload, _ := json.Marshal(incompatibleMsg{Type: "incompatible", Reason: strings.Repeat("evil ", 2048), Pv: 1, PvMin: 1})
	for _, p := range [][]byte{escPayload, bidiPayload} {
		if len(p) > 1000 {
			t.Fatalf("fixture is %d bytes on the wire, must stay under the control cap", len(p))
		}
	}
	if len(hugePayload) <= 1000 {
		t.Fatalf("huge fixture is %d bytes, must exceed the control cap", len(hugePayload))
	}

	const prefix = "error sending hostile.bin: "
	cases := []struct {
		name       string
		payload    []byte
		closeAfter bool
		check      func(t *testing.T, err error)
	}{
		{"legacy reason full of escapes and newlines", escPayload, false, func(t *testing.T, err error) {
			s := err.Error()
			if strings.Contains(s, "\x1b") || strings.Contains(s, "\n") {
				t.Errorf("a raw control character reached the error: %q", s)
			}
			body := strings.TrimPrefix(s, prefix)
			if body == s {
				t.Errorf("error lacks the sender's wrapping prefix: %q", s)
			}
			if n := utf8.RuneCountInString(body); n > 300 {
				t.Errorf("reason is %d runes, want at most 300", n)
			}
		}},
		{"current peer with a bidi version string", bidiPayload, false, func(t *testing.T, err error) {
			s := err.Error()
			if !strings.Contains(s, "Cannot transfer") {
				t.Errorf("expected the rebuilt compat message, got: %q", s)
			}
			if strings.Contains(s, "\u202e") {
				t.Errorf("a raw bidi override reached the error: %q", s)
			}
		}},
		{"10 KB reason is never parsed", hugePayload, true, func(t *testing.T, err error) {
			s := err.Error()
			if !strings.Contains(s, "connection closed while waiting") {
				t.Errorf("expected the closed-channel error, got: %q", s)
			}
			if strings.Contains(s, "evil evil") {
				t.Errorf("the over-cap payload reached the error: %q", s)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
			defer closeFn()

			src := filepath.Join(t.TempDir(), "hostile.bin")
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
			go func() { sendErr <- SendFiles(sender, []string{src}, "v0.0.0-test") }()

			select {
			case m := <-msgs:
				if !strings.Contains(string(m.Data), `"metadata"`) {
					t.Fatalf("first message is not the metadata: %q", m.Data)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("sender's metadata never reached the receiver")
			}
			if err := rdc.Send(tc.payload); err != nil {
				t.Fatalf("reply: %v", err)
			}
			if tc.closeAfter {
				// Let the payload land before the close races it.
				time.Sleep(300 * time.Millisecond)
				_ = rdc.Close()
			}

			select {
			case err := <-sendErr:
				if err == nil {
					t.Fatal("expected an error, got nil")
				}
				tc.check(t, err)
			case <-time.After(15 * time.Second):
				t.Fatal("SendFiles did not return")
			}
		})
	}
}
