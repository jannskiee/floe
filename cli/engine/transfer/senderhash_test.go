// The sender's half of the per-file SHA-256: it hashes the bytes it hands to
// the data channel and puts the digest on that file's end frame. These tests
// drive the real SendFiles over a real pion pair with a hand-written receiver,
// so the assertion is the frame on the wire rather than an internal value.
//
// The receiver's half lives in hash_test.go; the two meet in
// TestLoopbackVerifiedEveryFile below, which runs both real loops.
package transfer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// sendAndCollect writes data to a source file, runs the real sender against a
// hand-written receiver that acks at ackOffset, and returns the sender's error
// with every frame the receiver saw. The ack is sent only after the metadata
// arrives, which is the protocol's own ordering rather than a sleep.
func sendAndCollect(t *testing.T, data []byte, ackOffset int64) (error, [][]byte) {
	t.Helper()

	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	defer closeFn()

	src := filepath.Join(t.TempDir(), "hashed.bin")
	if err := os.WriteFile(src, data, 0o600); err != nil {
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
	var frames [][]byte
	select {
	case m := <-msgs:
		frames = append(frames, append([]byte(nil), m.Data...))
		if err := json.Unmarshal(m.Data, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first message is not the metadata: %q", m.Data)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("sender's metadata never reached the receiver")
	}

	ack := `{"type":"ack","id":"` + meta.ID + `","offset":` + itoa(ackOffset) + `,"pv":1,"pvMin":1}`
	if err := rdc.Send([]byte(ack)); err != nil {
		t.Fatalf("reply: %v", err)
	}

	var err error
	select {
	case err = <-sendErr:
	case <-time.After(60 * time.Second):
		t.Fatal("SendFiles did not return")
	}

	// Let anything still in flight land before the frames are read off.
	time.Sleep(300 * time.Millisecond)
	for {
		select {
		case m := <-msgs:
			frames = append(frames, append([]byte(nil), m.Data...))
			continue
		default:
		}
		break
	}
	return err, frames
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// findEnd returns the one end frame among frames, decoded.
func findEnd(t *testing.T, frames [][]byte) endMsg {
	t.Helper()
	var found *endMsg
	for _, f := range frames {
		if msgType, ok := classifyControl(f); !ok || msgType != "end" {
			continue
		}
		var end endMsg
		if err := json.Unmarshal(f, &end); err != nil {
			t.Fatalf("end frame is not JSON: %q", f)
		}
		if found != nil {
			t.Fatalf("more than one end frame among %d frames", len(frames))
		}
		copied := end
		found = &copied
	}
	if found == nil {
		t.Fatalf("no end frame among %d frames", len(frames))
	}
	return *found
}

// TestSenderSendsSHA256WhenEnabled: the digest on the end frame is the digest
// of the bytes the receiver saw, at every size a chunk boundary can get wrong.
func TestSenderSendsSHA256WhenEnabled(t *testing.T) {
	for _, size := range []int{0, 1, 16384, 16385, 262145, 4 << 20} {
		data := randomBytes(t, size)
		err, frames := sendAndCollect(t, data, 0)
		if err != nil {
			t.Fatalf("size %d: SendFiles: %v", size, err)
		}
		end := findEnd(t, frames)
		want := hexSHA256(data)
		if end.SHA256 != want {
			t.Fatalf("size %d: end.sha256 = %q, want the digest of the sent bytes", size, end.SHA256)
		}
		// The bytes on the wire are what the digest covers.
		var got []byte
		for _, f := range frames {
			if _, isControl := classifyControl(f); isControl {
				continue
			}
			got = append(got, f...)
		}
		if hexSHA256(got) != want {
			t.Fatalf("size %d: the digest does not cover the bytes that were sent", size)
		}
		// type stays first on the wire (the transfer audit's hashbad cells match on it).
		for _, f := range frames {
			if msgType, ok := classifyControl(f); ok && msgType == "end" && size > 0 {
				if !strings.HasPrefix(string(f), `{"type":"end","sha256":"`) {
					t.Fatalf("size %d: end frame shape changed: %q", size, f)
				}
			}
		}
	}
}

// TestSenderOmitsSHA256WhenDisabled: with the rollback lever off the frame
// carries no digest at all, so a receiver falls back to its byte-count check.
func TestSenderOmitsSHA256WhenDisabled(t *testing.T) {
	sendFileHashes = false
	defer func() { sendFileHashes = true }()

	err, frames := sendAndCollect(t, randomBytes(t, 64<<10), 0)
	if err != nil {
		t.Fatalf("SendFiles: %v", err)
	}
	if end := findEnd(t, frames); end.SHA256 != "" {
		t.Fatalf("end.sha256 = %q, want absent with hashing off", end.SHA256)
	}
	for _, f := range frames {
		if msgType, ok := classifyControl(f); ok && msgType == "end" {
			if strings.Contains(string(f), "sha256") {
				t.Fatalf("end frame still names sha256 with hashing off: %q", f)
			}
		}
	}
}

// TestSenderOmitsSHA256AtNonZeroOffset: a resumed file is sent from the middle,
// so a digest of what was sent would never match the whole file the receiver
// hashes. The frame must carry none.
func TestSenderOmitsSHA256AtNonZeroOffset(t *testing.T) {
	err, frames := sendAndCollect(t, randomBytes(t, 64<<10), 16<<10)
	if err != nil {
		t.Fatalf("SendFiles: %v", err)
	}
	if end := findEnd(t, frames); end.SHA256 != "" {
		t.Fatalf("end.sha256 = %q, want absent when the receiver resumed", end.SHA256)
	}
}

// TestLoopbackVerifiedEveryFile runs both real loops against each other at
// every size a chunk boundary can get wrong, plus a folder, and pins what the
// two people see: every file lands verified, the receiver's `received` frame
// counts them, and both summaries carry the Verified row.
func TestLoopbackVerifiedEveryFile(t *testing.T) {
	sizes := []int{0, 1, 16383, 16384, 16385, 262143, 262144, 262145, 4 << 20}
	srcDir := t.TempDir()
	var paths []string
	want := map[string][]byte{}
	for i, size := range sizes {
		name := "f" + itoa(int64(i)) + ".bin"
		data := randomBytes(t, size)
		p := filepath.Join(srcDir, name)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		paths = append(paths, p)
		want[name] = data
	}
	// A folder too: the sender walks it and the receiver rebuilds it, so the
	// digest has to survive a name that carries a directory.
	folder := filepath.Join(srcDir, "box")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	inner := randomBytes(t, 70000)
	if err := os.WriteFile(filepath.Join(folder, "inner.bin"), inner, 0o600); err != nil {
		t.Fatalf("write inner: %v", err)
	}
	paths = append(paths, folder)
	want["box/inner.bin"] = inner

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	restore := captureStdout(t)
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()
	time.Sleep(300 * time.Millisecond)

	sendErr := SendFiles(sender, paths, "")
	// Close as the CLI's deferred Close does; left open, the receive waits out
	// its 5 s post-completion grace.
	_ = sender.Close()
	var receiveErr error
	select {
	case receiveErr = <-recvErr:
	case <-time.After(120 * time.Second):
		restore()
		t.Fatal("ReceiveFiles did not complete")
	}
	out := restore()
	if sendErr != nil {
		t.Fatalf("SendFiles: %v", sendErr)
	}
	if receiveErr != nil {
		t.Fatalf("ReceiveFiles: %v", receiveErr)
	}

	for name, data := range want {
		onDisk, err := os.ReadFile(filepath.Join(outDir, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if hexSHA256(onDisk) != hexSHA256(data) {
			t.Fatalf("%s on disk does not hold the bytes sent", name)
		}
	}

	// Both summaries say it, so both people see it: the receiver prints its row
	// after the last file, the sender prints its own from the received frame.
	rows := strings.Count(out, "SHA-256 matched")
	if rows < 2 {
		t.Fatalf("Verified rows = %d, want the receiver's and the sender's; output:\n%s", rows, out)
	}
	// A digest never reaches a person's screen.
	if hex64.MatchString(out) {
		t.Fatalf("a 64-hex digest was printed:\n%s", out)
	}
}

// TestLoopbackForcedMismatchStopsSender: a sender whose digest does not match
// the bytes it sent must not leave the file behind, and the receiver's refusal
// has to reach that sender rather than being swallowed by the drain loop. The
// wrong digest lives here, in the test, and never in shipped code.
func TestLoopbackForcedMismatchStopsSender(t *testing.T) {
	data := randomBytes(t, 300000)
	h := newHandSender(t)
	h.meta("wrong.bin", len(data), 1, 1, len(data))
	h.bytes(data)

	// One hex digit changed: a digest of the right shape that cannot match.
	digest := []byte(hexSHA256(data))
	if digest[0] == '0' {
		digest[0] = '1'
	} else {
		digest[0] = '0'
	}
	started := time.Now()
	h.text(endWithSHA256(string(digest)))
	res := h.finish()

	if res.err == nil {
		t.Fatal("ReceiveFiles returned nil for a file whose digest did not match")
	}
	refusal := findRefusal(t, res.frames)
	if refusal.Code != "hash-mismatch" {
		t.Fatalf("refusal code = %q, want hash-mismatch", refusal.Code)
	}
	if time.Since(started) > 10*time.Second {
		t.Fatalf("the refusal took %s to reach the sender", time.Since(started))
	}
	names, err := os.ReadDir(h.dir)
	if err != nil {
		t.Fatalf("read output dir: %v", err)
	}
	for _, n := range names {
		t.Fatalf("output dir still holds %q after a mismatch", n.Name())
	}
}

// sendOneAndAnswer sends one small file to a scripted receiver that acks it,
// reads the bytes and the end marker, then answers with the frame given. It
// returns what the sender printed and its error.
func sendOneAndAnswer(t *testing.T, answer string) (string, error) {
	t.Helper()
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	src := filepath.Join(t.TempDir(), "one.bin")
	if err := os.WriteFile(src, []byte("four"), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}
	restore := captureStdout(t)
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
			t.Fatal("the end marker never arrived")
		}
	}
	if err := rdc.Send([]byte(answer)); err != nil {
		t.Fatalf("received: %v", err)
	}
	select {
	case err := <-sendErr:
		return restore(), err
	case <-time.After(20 * time.Second):
		t.Fatal("SendFiles did not return after received")
	}
	return "", nil
}

// TestSenderReadsVerifiedCount: a received frame ends the delivery wait
// whatever its verified holds, and only a count equal to the file count shows
// the Verified row. A hostile value never fails the decode and never reads as a
// match.
func TestSenderReadsVerifiedCount(t *testing.T) {
	cases := []struct {
		name, frame string
		row         bool
	}{
		{"negative", `{"type":"received","verified":-1}`, false},
		{"above the count", `{"type":"received","verified":2}`, false},
		{"fraction", `{"type":"received","verified":0.5}`, false},
		{"string", `{"type":"received","verified":"1"}`, false},
		{"null", `{"type":"received","verified":null}`, false},
		{"missing", `{"type":"received"}`, false},
		{"zero", `{"type":"received","verified":0}`, false},
		{"equal", `{"type":"received","verified":1}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := sendOneAndAnswer(t, tc.frame)
			if err != nil {
				t.Fatalf("a received frame must end the send cleanly, got: %v", err)
			}
			if got := strings.Contains(out, "SHA-256 matched"); got != tc.row {
				t.Fatalf("Verified row shown = %v, want %v:\n%s", got, tc.row, out)
			}
			if hex64.MatchString(out) {
				t.Fatalf("a 64-hex digest was printed:\n%s", out)
			}
		})
	}
}

// TestSendSummaryVerifiedRow: the Sent box gains the row only for the
// receiver's full count, and the row sits between Sent and Time.
func TestSendSummaryVerifiedRow(t *testing.T) {
	out, err := sendOneAndAnswer(t, `{"type":"received","verified":1}`)
	if err != nil {
		t.Fatalf("send failed: %v", err)
	}
	sent, verified, timeRow := strings.Index(out, "Sent"), strings.Index(out, "Verified"), strings.Index(out, "Time")
	if sent < 0 || verified < 0 || timeRow < 0 || !(sent < verified && verified < timeRow) {
		t.Fatalf("want Sent, Verified, Time in that order:\n%s", out)
	}
}
