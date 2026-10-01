package transfer

// The request-link send's engine additions (S1-CLI-01, FU-20): NoSummary and
// OnAck, which default off so every other sender is unchanged, and the typed
// errors a caller with fixed copy of its own maps by errors.As and errors.Is
// (PeerEndedError, CompatError, ErrAckTimeout, ErrFileChanged), whose texts
// are byte for byte what the send returned before.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// TestAbortFromPeerTypesItsErrors: an incompatible frame with no known code is
// a *PeerEndedError when its range overlaps ours, carrying the frame's saved
// read and clamped exactly as a PeerStoppedError's is, and a *CompatError when
// the range misses, saying which side is behind. The text of each is the one
// the frame always produced, and each counts as from the peer.
func TestAbortFromPeerTypesItsErrors(t *testing.T) {
	const total = 3
	prose := "old peer prose\x1b[2K‮ $(calc)"
	reason, _ := json.Marshal(prose)
	frame := func(pv, fields string) []byte {
		return []byte(`{"type":"incompatible","reason":` + string(reason) + `,` + pv + fields + `}`)
	}
	overlap := `"pv":1,"pvMin":1`

	ended := []struct {
		name      string
		raw       []byte
		wantSaved int
	}{
		{"no code, no saved", frame(overlap, ``), 0},
		{"no code, saved 2", frame(overlap, `,"saved":2`), 2},
		{"unknown code, saved 2", frame(overlap, `,"code":"too-slow","saved":2`), 2},
		{"unknown code, saved over total", frame(overlap, `,"code":"too-slow","saved":99`), total},
		{"saved negative", frame(overlap, `,"saved":-4`), 0},
		{"saved a string", frame(overlap, `,"saved":"2"`), 0},
		{"saved a fraction", frame(overlap, `,"saved":1.5`), 0},
		{"code key case", frame(overlap, `,"CODE":"declined","saved":1`), 1},
	}
	for _, c := range ended {
		err := abortFromPeer(c.raw, "v1", "", total)
		var got *PeerEndedError
		if !errors.As(err, &got) {
			t.Fatalf("%s: %T %v, want a *PeerEndedError", c.name, err, err)
		}
		if got.Saved != c.wantSaved {
			t.Fatalf("%s: Saved = %d, want %d", c.name, got.Saved, c.wantSaved)
		}
		if want := displayText(prose, maxDisplayReason); err.Error() != want {
			t.Fatalf("%s: text %q, want the reason through displayText %q", c.name, err.Error(), want)
		}
		if !fromPeer(err) {
			t.Fatalf("%s: fromPeer is false for a frame off the wire", c.name)
		}
	}
	if err := abortFromPeer([]byte(`{"type":"incompatible","pv":1,"pvMin":1}`), "v1", "", total); err == nil ||
		err.Error() != "peer rejected transfer: protocol incompatible" {
		t.Fatalf("a frame with no reason gave %v, want the fixed fallback", err)
	}

	for _, c := range []struct {
		name        string
		pv          string
		localTooOld bool
	}{
		{"peer ahead of us", `"pv":9,"pvMin":9`, true},
		{"peer behind us", `"pv":-1,"pvMin":-1`, false},
	} {
		incompat := incompatibleMsg{}
		raw := frame(c.pv, `,"code":"nope","saved":2`)
		_ = json.Unmarshal(raw, &incompat)
		err := abortFromPeer(raw, "v1", "", total)
		var got *CompatError
		if !errors.As(err, &got) || got.LocalTooOld != c.localTooOld || !got.fromWire {
			t.Fatalf("%s: %T %+v, want a wire *CompatError with LocalTooOld %v", c.name, err, got, c.localTooOld)
		}
		if want := compatErrorFromIncompatible("v1", "", incompat); err.Error() != want {
			t.Fatalf("%s: text %q, want the rebuilt mismatch %q", c.name, err.Error(), want)
		}
		if !fromPeer(err) {
			t.Fatalf("%s: fromPeer is false for a frame off the wire", c.name)
		}
	}

	// The first ack's own check is not from the peer: the send keeps the file
	// name in front of it, wrapped or not.
	local := &CompatError{LocalTooOld: true, text: "Cannot transfer"}
	if fromPeer(local) || fromPeer(fmt.Errorf("error sending a.bin: %w", local)) {
		t.Fatal("fromPeer is true for the first ack's own compat check")
	}
}

// TestSentinelTextsAreUnchanged: the two sentinels the send now returns carry
// the words it returned before, so no caller that prints or matches them sees
// a difference.
func TestSentinelTextsAreUnchanged(t *testing.T) {
	if got := fmt.Errorf("error sending %s: %w", "a.bin", ErrAckTimeout).Error(); got != "error sending a.bin: timed out waiting for ack" {
		t.Fatalf("the ack timeout reads %q", got)
	}
	shrank := fmt.Errorf("the file shrank while it was being sent (announced %d bytes, read %d); %w", 64, 32, ErrFileChanged)
	if shrank.Error() != "the file shrank while it was being sent (announced 64 bytes, read 32); send it again once it stops changing" {
		t.Fatalf("the shrink reads %q", shrank)
	}
}

// deliverTwo sends two files over a loopback pair to a real receiver, with
// opts, and returns what the sender printed and returned.
func deliverTwo(t *testing.T, opts SendOptions) (printed string, err error) {
	t.Helper()
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	src := t.TempDir()
	var paths []string
	for _, name := range []string{"one.bin", "two.bin"} {
		p := filepath.Join(src, name)
		if werr := os.WriteFile(p, []byte(strings.Repeat(name, 4096)), 0o600); werr != nil {
			t.Fatal(werr)
		}
		paths = append(paths, p)
	}
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}
	out := t.TempDir()
	// Swapped before the receiver starts and put back only after it returned
	// (the recvErr receive below): the receiver prints too, and the loopback
	// between it and this goroutine is UDP, which gives the race detector no
	// order between its prints and the swap (race line FU-B6, 2e7d459).
	restore := captureStdout(t)
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(rdc, out, true, "", "", ReceiveOptions{
			OnProgress: func(Progress) {}, Messages: msgs, Closed: closed,
		})
	}()
	opts.OnProgress = func(Progress) {}
	err = SendFilesWithOptions(sender, paths, "", opts)
	// What the CLI's deferred close does the instant the send returns; the
	// receiver otherwise waits out its 5 s grace for it.
	_ = sender.Close()
	select {
	case rerr := <-recvErr:
		if rerr != nil {
			t.Fatalf("receive: %v", rerr)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receive never returned")
	}
	return restore(), err
}

// TestNewSendOptionsAreOffByDefault: the zero SendOptions prints the Sent box
// and calls nothing new, as before; NoSummary leaves the box out and OnAck
// fires once per file in order, with OnDelivered unchanged either way.
func TestNewSendOptionsAreOffByDefault(t *testing.T) {
	if (SendOptions{}).NoSummary || (SendOptions{}).OnAck != nil || (SendOptions{}).Stop != nil {
		t.Fatal("a zero SendOptions turns NoSummary, OnAck or Stop on")
	}

	var delivered []Delivered
	printed, err := deliverTwo(t, SendOptions{OnDelivered: func(d Delivered) { delivered = append(delivered, d) }})
	if err != nil {
		t.Fatalf("plain send: %v", err)
	}
	if !strings.Contains(printed, "  Sent ") || !strings.Contains(printed, "2 files") {
		t.Fatalf("the plain send printed no Sent box:\n%s", printed)
	}
	if len(delivered) != 1 || delivered[0].Files != 2 {
		t.Fatalf("OnDelivered = %+v, want one call for 2 files", delivered)
	}

	var acked []int
	delivered = nil
	printed, err = deliverTwo(t, SendOptions{
		NoSummary:   true,
		OnAck:       func(i int) { acked = append(acked, i) },
		OnDelivered: func(d Delivered) { delivered = append(delivered, d) },
	})
	if err != nil {
		t.Fatalf("send with the options on: %v", err)
	}
	if strings.Contains(printed, "  Sent ") {
		t.Fatalf("NoSummary still printed the Sent box:\n%s", printed)
	}
	if fmt.Sprint(acked) != "[1 2]" {
		t.Fatalf("OnAck saw %v, want [1 2]", acked)
	}
	if len(delivered) != 1 || delivered[0].Files != 2 {
		t.Fatalf("OnDelivered = %+v, want one call for 2 files", delivered)
	}
}

// ackOnce starts a one-file send with opts, pumped as peer.Connection pumps a
// channel, answers its metadata with one ack carrying ackFields, and returns
// what the send returned.
func ackOnce(t *testing.T, opts SendOptions, ackFields string) error {
	t.Helper()
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	opts.Messages, opts.Closed = pumpChannel(sender, nil)
	opts.OnProgress = func(Progress) {}
	src := filepath.Join(t.TempDir(), "tail.bin")
	if err := os.WriteFile(src, make([]byte, 1024), 0o600); err != nil {
		t.Fatal(err)
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
	case <-time.After(20 * time.Second):
		t.Fatal("metadata never arrived")
	}
	if err := rdc.Send([]byte(`{"type":"ack","id":"` + meta.ID + `","offset":0,` + ackFields + `}`)); err != nil {
		t.Fatalf("ack: %v", err)
	}
	select {
	case err := <-errc:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("the send did not return within 10s of the ack")
	}
	return nil
}

// TestFirstAckRangeMissIsALocalCompatError: a first ack whose pv range misses
// ours is this sender's own check. It returns a *CompatError behind the file
// name, exactly the text it returned before, and OnAck has already fired.
func TestFirstAckRangeMissIsALocalCompatError(t *testing.T) {
	var acked []int
	err := ackOnce(t, SendOptions{OnAck: func(i int) { acked = append(acked, i) }}, `"pv":9,"pvMin":9,"ver":"v9"`)
	var compat *CompatError
	if !errors.As(err, &compat) || !compat.LocalTooOld || compat.fromWire {
		t.Fatalf("the send returned %T %v, want a local *CompatError with LocalTooOld", err, err)
	}
	want := "error sending tail.bin: " + compatErrorMessage(true, "test", "v9", MinProtocolVersion, ProtocolVersion, 9, 9, "")
	if err.Error() != want {
		t.Fatalf("text %q, want %q", err.Error(), want)
	}
	if fmt.Sprint(acked) != "[1]" {
		t.Fatalf("OnAck saw %v, want [1]", acked)
	}
}

// TestVisitorCancelReasonMatchesTheWebPage pins the reason the CLI visitor's
// Ctrl+C sends to the one the /r page's Cancel sends (VISITOR_CANCEL_REASON),
// read from its source, so the two visitors cannot drift apart (review lens
// A, nit 9). The host maps any abort to its own copy, so a drift would not
// show; this row is the only thing that would catch it. The line may end in
// a carriage return: the repo has no .gitattributes, so a checkout with
// core.autocrlf=true (GitHub's windows-latest runner) writes CRLF, and Go's
// multi-line $ matches only before the \n (review re-check LA2-1, lens B N1).
func TestVisitorCancelReasonMatchesTheWebPage(t *testing.T) {
	for _, c := range []struct {
		file string
		re   *regexp.Regexp
	}{
		{"../../../client/lib/request/constants.ts",
			regexp.MustCompile(`(?m)^export const VISITOR_CANCEL_REASON = '` + regexp.QuoteMeta(VisitorCancelReason) + `';\r?$`)},
	} {
		src, err := os.ReadFile(filepath.FromSlash(c.file))
		if err != nil {
			t.Fatalf("read %s: %v", c.file, err)
		}
		if !c.re.Match(src) {
			t.Fatalf("%s no longer says %s", c.file, c.re)
		}
	}
}
