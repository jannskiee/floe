package transfer

// The per-file SHA-256: the receiver hashes while it writes and checks the
// sender's digest at end, before the rename. These tests drive a real receive
// loop with a hand-written sender, so every end frame carries exactly the
// digest a test chooses. They swap os.Stdout, so no test here may call
// t.Parallel (none in the package does).

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// handSender plays the sender's side of a real receive loop over a pumped
// loopback pair, one frame at a time.
type handSender struct {
	t        *testing.T
	sender   *webrtc.DataChannel
	back     chan webrtc.DataChannelMessage
	recvErr  chan error
	dir      string
	restore  func() string
	lastEnd  time.Time
	mu       sync.Mutex
	fileDone []FileDone
}

// newHandSender starts ReceiveFilesWithOptions on a fresh pair with stdout
// captured and OnFileDone recorded.
func newHandSender(t *testing.T) *handSender {
	t.Helper()
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}
	h := &handSender{t: t, sender: sender, back: make(chan webrtc.DataChannelMessage, 32), recvErr: make(chan error, 1), dir: t.TempDir()}
	sender.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case h.back <- m:
		default:
		}
	})
	h.restore = captureStdout(t)
	go func() {
		h.recvErr <- ReceiveFilesWithOptions(rdc, h.dir, true, "test-ver", "", ReceiveOptions{
			Messages: msgs,
			Closed:   closed,
			OnFileDone: func(d FileDone) {
				h.mu.Lock()
				h.fileDone = append(h.fileDone, d)
				h.mu.Unlock()
			},
		})
	}()
	return h
}

// meta announces a file and waits for its ack.
func (h *handSender) meta(name string, size, index, total int, totalBytes int) {
	h.t.Helper()
	frame := fmt.Sprintf(`{"type":"metadata","id":"h-%d-%s","fileName":%q,"fileSize":%d,"index":%d,"total":%d,"totalBytes":%d,"pv":1,"pvMin":1}`,
		index, name, name, size, index, total, totalBytes)
	h.text(frame)
	select {
	case m := <-h.back:
		if msgType, ok := classifyControl(m.Data); !ok || msgType != "ack" {
			h.t.Fatalf("expected the ack for %s, got %q", name, m.Data)
		}
	case <-time.After(20 * time.Second):
		h.t.Fatalf("receiver never acked %s", name)
	}
}

// bytes sends data as binary chunks.
func (h *handSender) bytes(data []byte) {
	h.t.Helper()
	const chunk = 16 * 1024
	for off := 0; off < len(data); off += chunk {
		end := off + chunk
		if end > len(data) {
			end = len(data)
		}
		if err := h.sender.Send(data[off:end]); err != nil {
			h.t.Fatalf("Send chunk: %v", err)
		}
	}
}

// text sends a string frame, which is how every control frame travels toward
// a receiver.
func (h *handSender) text(frame string) {
	h.t.Helper()
	if err := h.sender.SendText(frame); err != nil {
		h.t.Fatalf("SendText: %v", err)
	}
	if strings.Contains(frame, `"type":"end"`) {
		h.lastEnd = time.Now()
	}
}

// handResult is what a receive left behind.
type handResult struct {
	err      error
	frames   [][]byte // frames back to the sender after the last ack was read
	firstAt  time.Time
	stdout   string
	fileDone []FileDone
}

// finish waits for the receive to return. A "received" frame closes the
// sender's channel at once, as a Go sender does, so a success does not wait
// out the receiver's 5 s grace period.
func (h *handSender) finish() handResult {
	h.t.Helper()
	var res handResult
	deadline := time.After(30 * time.Second)
	for waiting := true; waiting; {
		select {
		case m := <-h.back:
			if res.firstAt.IsZero() {
				res.firstAt = time.Now()
			}
			res.frames = append(res.frames, m.Data)
			if msgType, ok := classifyControl(m.Data); ok && msgType == "received" {
				_ = h.sender.Close()
			}
		case res.err = <-h.recvErr:
			waiting = false
		case <-deadline:
			h.t.Fatal("ReceiveFilesWithOptions did not return")
		}
	}
	// A refusal is flushed before the receive returns; collect a straggler.
	for collecting := true; collecting; {
		select {
		case m := <-h.back:
			if res.firstAt.IsZero() {
				res.firstAt = time.Now()
			}
			res.frames = append(res.frames, m.Data)
		case <-time.After(300 * time.Millisecond):
			collecting = false
		}
	}
	res.stdout = h.restore()
	h.mu.Lock()
	res.fileDone = append([]FileDone(nil), h.fileDone...)
	h.mu.Unlock()
	return res
}

func hexSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func endWithSHA256(digest string) string {
	return `{"type":"end","sha256":"` + digest + `"}`
}

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return b
}

// findReceived returns the one "received" frame among frames, decoded with
// verified kept raw so a test can tell 0 from absent.
func findReceived(t *testing.T, frames [][]byte) map[string]json.RawMessage {
	t.Helper()
	for _, f := range frames {
		if msgType, ok := classifyControl(f); ok && msgType == "received" {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(f, &fields); err != nil {
				t.Fatalf("received frame is not JSON: %q", f)
			}
			return fields
		}
	}
	t.Fatalf("no received frame among %d frames", len(frames))
	return nil
}

// findRefusal returns the one incompatible frame among frames.
func findRefusal(t *testing.T, frames [][]byte) incompatibleMsg {
	t.Helper()
	for _, f := range frames {
		if msgType, ok := classifyControl(f); ok && msgType == "incompatible" {
			if len(f) > controlMsgMax {
				t.Fatalf("refusal frame is %d bytes, over the %d cap", len(f), controlMsgMax)
			}
			var incompat incompatibleMsg
			if err := json.Unmarshal(f, &incompat); err != nil {
				t.Fatalf("refusal frame is not JSON: %q", f)
			}
			return incompat
		}
	}
	t.Fatalf("no incompatible frame among %d frames", len(frames))
	return incompatibleMsg{}
}

var hex64 = regexp.MustCompile(`[0-9a-fA-F]{64}`)

// TestReceiverVerifiesSHA256: every size a chunk boundary can get wrong
// commits under its final name, received carries the count, OnFileDone reports
// each file as verified, the summary says so, and no digest is printed.
func TestReceiverVerifiesSHA256(t *testing.T) {
	sizes := []int{0, 1, 16383, 16384, 16385, 262143, 262144, 262145, 10 << 20}
	var total int
	for _, s := range sizes {
		total += s
	}
	h := newHandSender(t)
	datas := make([][]byte, len(sizes))
	for i, size := range sizes {
		datas[i] = randomBytes(t, size)
		h.meta(fmt.Sprintf("f%d.bin", i), size, i+1, len(sizes), total)
		h.bytes(datas[i])
		h.text(endWithSHA256(hexSHA256(datas[i])))
	}
	res := h.finish()
	if res.err != nil {
		t.Fatalf("receive failed: %v", res.err)
	}
	if got := string(findReceived(t, res.frames)["verified"]); got != fmt.Sprint(len(sizes)) {
		t.Fatalf("received.verified = %q, want %d", got, len(sizes))
	}
	if len(res.fileDone) != len(sizes) {
		t.Fatalf("OnFileDone fired %d times, want %d", len(res.fileDone), len(sizes))
	}
	for i, d := range res.fileDone {
		name := fmt.Sprintf("f%d.bin", i)
		if d.SavedName != name || d.Bytes != int64(sizes[i]) || !d.Verified {
			t.Fatalf("OnFileDone[%d] = %+v, want {%s %d true}", i, d, name, sizes[i])
		}
		onDisk, err := os.ReadFile(filepath.Join(h.dir, name))
		if err != nil || hexSHA256(onDisk) != hexSHA256(datas[i]) {
			t.Fatalf("%s on disk does not hold the bytes sent (%v)", name, err)
		}
	}
	for _, left := range listDir(t, h.dir) {
		if strings.HasSuffix(left, partSuffix) {
			t.Fatalf("a staging file was left behind: %s", left)
		}
	}
	if !strings.Contains(res.stdout, "Verified") || !strings.Contains(res.stdout, "SHA-256 matched") {
		t.Fatalf("summary has no Verified row:\n%s", res.stdout)
	}
	if hex64.MatchString(res.stdout) {
		t.Fatalf("a 64-hex digest was printed:\n%s", res.stdout)
	}
}

// TestReceiverHashMismatchDeletesPart is the refusal half: the first file
// commits, the second's digest is off by one hex digit, so it never gets a
// final name, its .part is gone, the sender is told hash-mismatch with saved 1
// within 2 s, and the caller gets a typed error that says mismatch.
func TestReceiverHashMismatchDeletesPart(t *testing.T) {
	h := newHandSender(t)
	first, second := randomBytes(t, 3000), randomBytes(t, 5000)
	h.meta("first.bin", len(first), 1, 2, len(first)+len(second))
	h.bytes(first)
	h.text(endWithSHA256(hexSHA256(first)))
	h.meta("second.bin", len(second), 2, 2, len(first)+len(second))
	h.bytes(second)
	digest := []byte(hexSHA256(second))
	if digest[63] == 'a' {
		digest[63] = 'b'
	} else {
		digest[63] = 'a'
	}
	h.text(endWithSHA256(string(digest)))
	res := h.finish()

	incompat := findRefusal(t, res.frames)
	if res.firstAt.Sub(h.lastEnd) > 2*time.Second {
		t.Fatalf("the sender was told %v after the end marker, want within 2 s", res.firstAt.Sub(h.lastEnd))
	}
	if incompat.Code != string(CodeHashMismatch) {
		t.Fatalf("code = %q, want %q", incompat.Code, CodeHashMismatch)
	}
	if incompat.Saved == nil || *incompat.Saved != 1 {
		t.Fatalf("saved = %v, want 1 (first.bin was committed)", incompat.Saved)
	}
	if incompat.Reason != "receiver discarded a file because its SHA-256 did not match" {
		t.Fatalf("reason = %q", incompat.Reason)
	}
	if ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, incompat.PvMin, incompat.Pv); !ok {
		t.Fatalf("pv range %d-%d does not overlap ours", incompat.PvMin, incompat.Pv)
	}
	var refused *RefusedError
	if !errors.As(res.err, &refused) || refused.Code != CodeHashMismatch || refused.Saved != 1 {
		t.Fatalf("receiver error = %v (%T), want *RefusedError{hash-mismatch, 1}", res.err, res.err)
	}
	if !errors.Is(res.err, errSHA256Mismatch) {
		t.Fatalf("errSHA256Mismatch is not reachable: %v", res.err)
	}
	if got := res.err.Error(); got != "a file did not match the SHA-256 the sender computed, so it was not kept" {
		t.Fatalf("Error() = %q", got)
	}
	if left := listDir(t, h.dir); len(left) != 1 || left[0] != "first.bin" {
		t.Fatalf("on disk: %v, want only first.bin", left)
	}
	if len(res.fileDone) != 1 || res.fileDone[0].SavedName != "first.bin" || !res.fileDone[0].Verified {
		t.Fatalf("OnFileDone = %+v, want only first.bin verified", res.fileDone)
	}
}

// TestReceiverRejectsMalformedSHA256: a digest that is present but not 64
// lowercase hex characters refuses the file with the unreadable reason, never
// commits it and never treats it as absent. JSON escapes are undone first, on
// both sides, so an escaped valid digest is accepted.
func TestReceiverRejectsMalformedSHA256(t *testing.T) {
	data := []byte("data")
	good := hexSHA256(data)
	cases := []struct {
		name, raw string
		accept    bool
	}{
		{"uppercase", `"` + strings.ToUpper(good) + `"`, false},
		{"63 characters", `"` + good[:63] + `"`, false},
		{"65 characters", `"` + good + `0"`, false},
		{"non-hex", `"` + good[:63] + `g"`, false},
		{"empty string", `""`, false},
		{"number", `123`, false},
		{"null", `null`, false},
		{"true", `true`, false},
		{"object", `{}`, false},
		{"array", `[]`, false},
		{"padded", `" ` + good + `"`, false},
		{"escaped valid", `"\u00` + hex.EncodeToString([]byte{good[0]}) + good[1:] + `"`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHandSender(t)
			h.meta("one.bin", len(data), 1, 1, len(data))
			h.bytes(data)
			h.text(`{"type":"end","sha256":` + tc.raw + `}`)
			res := h.finish()
			if tc.accept {
				if res.err != nil || len(res.fileDone) != 1 || !res.fileDone[0].Verified {
					t.Fatalf("an escaped valid digest must verify: err=%v done=%+v", res.err, res.fileDone)
				}
				return
			}
			var refused *RefusedError
			if !errors.As(res.err, &refused) || refused.Code != CodeHashMismatch || !errors.Is(res.err, errSHA256Unreadable) {
				t.Fatalf("receiver error = %v, want a hash-mismatch refusal for an unreadable digest", res.err)
			}
			if got := res.err.Error(); got != "the sender's SHA-256 for a file could not be read, so the file was not kept" {
				t.Fatalf("Error() = %q", got)
			}
			if incompat := findRefusal(t, res.frames); incompat.Reason != "receiver discarded a file because the sender's SHA-256 was not readable" {
				t.Fatalf("reason = %q", incompat.Reason)
			}
			if left := listDir(t, h.dir); len(left) != 0 {
				t.Fatalf("expected nothing on disk, found %v", left)
			}
			if len(res.fileDone) != 0 {
				t.Fatalf("OnFileDone fired for a refused file: %+v", res.fileDone)
			}
		})
	}
}

// TestReceiverEndWithoutHashStillCommits: an end without sha256, which every
// sender sends until senders hash, commits as before; received still carries
// verified, as 0, and the summary has no Verified row.
func TestReceiverEndWithoutHashStillCommits(t *testing.T) {
	h := newHandSender(t)
	data := randomBytes(t, 2048)
	h.meta("legacy.bin", len(data), 1, 1, len(data))
	h.bytes(data)
	h.text(`{"type":"end"}`)
	res := h.finish()
	if res.err != nil {
		t.Fatalf("receive failed: %v", res.err)
	}
	if got := findReceived(t, res.frames)["verified"]; string(got) != "0" {
		t.Fatalf("received.verified = %q, want 0 (present)", got)
	}
	if strings.Contains(res.stdout, "Verified") {
		t.Fatalf("summary shows a Verified row for an unhashed file:\n%s", res.stdout)
	}
	if len(res.fileDone) != 1 || res.fileDone[0].Verified || res.fileDone[0].Bytes != int64(len(data)) {
		t.Fatalf("OnFileDone = %+v, want one unverified file", res.fileDone)
	}
}

// TestReceiverIgnoresEndWithoutOpenFile: an end before any metadata and a
// repeated end after a committed file both match no open file, so neither is
// checked, refused or counted, even with a digest that could never match.
func TestReceiverIgnoresEndWithoutOpenFile(t *testing.T) {
	h := newHandSender(t)
	bogus := endWithSHA256(strings.Repeat("0", 64))
	h.text(bogus)
	a, b := randomBytes(t, 100), randomBytes(t, 200)
	h.meta("a.bin", len(a), 1, 2, len(a)+len(b))
	h.bytes(a)
	h.text(endWithSHA256(hexSHA256(a)))
	h.text(bogus)
	h.meta("b.bin", len(b), 2, 2, len(a)+len(b))
	h.bytes(b)
	h.text(endWithSHA256(hexSHA256(b)))
	res := h.finish()
	if res.err != nil {
		t.Fatalf("receive failed: %v", res.err)
	}
	if got := string(findReceived(t, res.frames)["verified"]); got != "2" {
		t.Fatalf("received.verified = %q, want 2", got)
	}
	for _, f := range res.frames {
		if msgType, _ := classifyControl(f); msgType == "incompatible" {
			t.Fatalf("a stray end was refused: %q", f)
		}
	}
}

// TestReceiverHashIsPerClaim: a second metadata while a file is open abandons
// that file, and the next file's digest covers only its own bytes.
func TestReceiverHashIsPerClaim(t *testing.T) {
	h := newHandSender(t)
	h.meta("abandoned.bin", 100, 1, 1, 100)
	h.bytes(randomBytes(t, 40))
	data := randomBytes(t, 50)
	h.meta("kept.bin", len(data), 1, 1, len(data))
	h.bytes(data)
	h.text(endWithSHA256(hexSHA256(data)))
	res := h.finish()
	if res.err != nil {
		t.Fatalf("receive failed: %v", res.err)
	}
	if got := string(findReceived(t, res.frames)["verified"]); got != "1" {
		t.Fatalf("received.verified = %q, want 1", got)
	}
	if left := listDir(t, h.dir); len(left) != 1 || left[0] != "kept.bin" {
		t.Fatalf("on disk: %v, want only kept.bin", left)
	}
}

// TestByteCountGuardUnchangedWithDigest: a short file with a correct digest of
// its short bytes still reports "incomplete file", because the byte count is
// checked before the hash.
func TestByteCountGuardUnchangedWithDigest(t *testing.T) {
	h := newHandSender(t)
	short := randomBytes(t, 40)
	h.meta("short.bin", 100, 1, 1, 100)
	h.bytes(short)
	h.text(endWithSHA256(hexSHA256(short)))
	res := h.finish()
	if res.err == nil || !strings.Contains(res.err.Error(), "incomplete file") {
		t.Fatalf("receiver error = %v, want an incomplete-file error", res.err)
	}
	incompat := findRefusal(t, res.frames)
	if incompat.Code != "" || !strings.Contains(incompat.Reason, "incomplete file") {
		t.Fatalf("refusal = %+v, want the uncoded incomplete-file reason", incompat)
	}
}

// TestReceiveSummaryVerifiedRow: the row appears only when every file in the
// batch matched; one unhashed file is enough to leave it out.
func TestReceiveSummaryVerifiedRow(t *testing.T) {
	for _, tc := range []struct {
		name     string
		hashBoth bool
	}{{"all hashed", true}, {"one unhashed", false}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHandSender(t)
			a, b := randomBytes(t, 10), randomBytes(t, 20)
			h.meta("a.bin", len(a), 1, 2, len(a)+len(b))
			h.bytes(a)
			h.text(endWithSHA256(hexSHA256(a)))
			h.meta("b.bin", len(b), 2, 2, len(a)+len(b))
			h.bytes(b)
			if tc.hashBoth {
				h.text(endWithSHA256(hexSHA256(b)))
			} else {
				h.text(`{"type":"end"}`)
			}
			res := h.finish()
			if res.err != nil {
				t.Fatalf("receive failed: %v", res.err)
			}
			if got := strings.Contains(res.stdout, "SHA-256 matched"); got != tc.hashBoth {
				t.Fatalf("Verified row shown = %v, want %v:\n%s", got, tc.hashBoth, res.stdout)
			}
		})
	}
}

// TestEndFrameWithSHA256FitsControlCap: the hashed end is small, keeps type
// first, and is byte for byte today's frame when no digest is set; both
// refusal reasons fit the cap without shrinking.
func TestEndFrameWithSHA256FitsControlCap(t *testing.T) {
	plain, _ := json.Marshal(endMsg{Type: "end"})
	if string(plain) != `{"type":"end"}` {
		t.Fatalf("unhashed end = %s, want the shipped frame", plain)
	}
	hashed, _ := json.Marshal(endMsg{Type: "end", SHA256: strings.Repeat("a", 64)})
	if len(hashed) != 90 || !strings.HasPrefix(string(hashed), `{"type":"end","sha256":"`) {
		t.Fatalf("hashed end = %s (%d bytes), want 90 bytes starting with type", hashed, len(hashed))
	}
	for _, reason := range []string{
		"receiver discarded a file because its SHA-256 did not match",
		"receiver discarded a file because the sender's SHA-256 was not readable",
	} {
		frame := incompatibleFrame("desktop-v0.3.0", CodeHashMismatch, reason, 999)
		var incompat incompatibleMsg
		if len(frame) > controlMsgMax || json.Unmarshal(frame, &incompat) != nil || incompat.Reason != reason {
			t.Fatalf("refusal frame %s does not carry the whole reason under the cap", frame)
		}
	}
}

// TestOldPeersIgnoreNewFields: the shapes shipped peers decode still read the
// new frames, and a hostile verified never stops a received frame from being
// one.
func TestOldPeersIgnoreNewFields(t *testing.T) {
	if msgType, ok := classifyControl([]byte(endWithSHA256(strings.Repeat("f", 64)))); !ok || msgType != "end" {
		t.Fatalf("a hashed end classifies as %q, %v", msgType, ok)
	}
	var old struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(`{"type":"received","verified":3}`), &old); err != nil || old.Type != "received" {
		t.Fatalf("a shipped sender's decode of received failed: %v", err)
	}
	for _, v := range []string{`-1`, `3.5`, `"3"`, `null`, `true`, `[3]`, `{}`, `1e999`, `4`} {
		if ok, _, has := parseReceived([]byte(`{"type":"received","verified":`+v+`}`), 3); !ok || has {
			t.Fatalf("verified %s: ok=%v has=%v, want a received frame without a usable count", v, ok, has)
		}
	}
}
