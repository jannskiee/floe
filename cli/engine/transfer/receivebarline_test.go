package transfer

// ReceiveOptions.EndBarLine, the receiving twin of SendOptions.EndBarLine
// (sendbarline_test.go): a receive that ends while a file's bar is drawn part
// way ends the bar's line once, so what the caller prints next ("Error: ...")
// starts on a line of its own. A line that a finished file already ended gets
// no second break, a bar that never drew gets none, and neither does a receive
// whose caller's Ctrl+C has taken the ending (Interrupted), because that line
// opens with its own line break.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// barReceive is one ReceiveFilesWithOptions with a terminal bar, fed by a
// sender the test drives by hand over a pumped loopback pair.
type barReceive struct {
	sender      *webrtc.DataChannel
	back        <-chan webrtc.DataChannelMessage
	out         string
	interrupted atomic.Bool
	errc        chan error
	restore     func() string
}

// startBarReceive starts the receive with EndBarLine set as given, and with
// Interrupted reading the run's own flag (stopNow sets it).
func startBarReceive(t *testing.T, endBarLine bool) *barReceive {
	t.Helper()
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}
	r := &barReceive{sender: sender, out: t.TempDir(), errc: make(chan error, 1)}
	r.back, _ = pumpChannel(sender, nil)
	opts := ReceiveOptions{
		Messages:    msgs,
		Closed:      closed,
		EndBarLine:  endBarLine,
		Interrupted: r.interrupted.Load,
	}
	// Swapped before the receive starts and put back after it has returned:
	// the bar draws from the receive's goroutine.
	r.restore = captureStdout(t)
	go func() { r.errc <- ReceiveFilesWithOptions(rdc, r.out, true, "test", "", opts) }()
	return r
}

// file announces file index of total (size bytes), waits for the receive's
// ack, sends the first sent bytes of it and, with end, its end marker. It
// returns once those bytes are in the file's .part, or with end once the file
// is saved under its name.
func (r *barReceive) file(t *testing.T, name string, size, index, total, sent int, end bool) {
	t.Helper()
	meta := fmt.Sprintf(`{"type":"metadata","id":"bar-%d","fileName":%q,"fileSize":%d,"index":%d,"total":%d,"totalBytes":%d}`,
		index, name, size, index, total, 64<<20)
	if err := r.sender.SendText(meta); err != nil {
		t.Fatalf("metadata: %v", err)
	}
	select {
	case <-r.back:
	case <-time.After(20 * time.Second):
		t.Fatal("the receive never acked the file")
	}
	chunk := make([]byte, 64<<10)
	for n := 0; n < sent; n += len(chunk) {
		if err := r.sender.Send(chunk); err != nil {
			t.Fatalf("file bytes: %v", err)
		}
	}
	at, want := filepath.Join(r.out, name+".part"), int64(sent)
	if end {
		if err := r.sender.SendText(`{"type":"end"}`); err != nil {
			t.Fatalf("end: %v", err)
		}
		at = filepath.Join(r.out, name)
	}
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		if fi, err := os.Stat(at); err == nil && fi.Size() >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never held %d bytes", at, want)
		}
	}
}

// closeNow ends the receive by the sender's close, after the caller's Ctrl+C
// has taken the ending when interrupted is set, and returns what the receive
// printed and returned.
func (r *barReceive) closeNow(t *testing.T, interrupted bool) (string, error) {
	t.Helper()
	if interrupted {
		r.interrupted.Store(true)
	}
	_ = r.sender.Close()
	select {
	case err := <-r.errc:
		return r.restore(), err
	case <-time.After(20 * time.Second):
		t.Fatal("the receive did not end")
		return "", nil
	}
}

// midFileRun ends a 64 MiB file's receive after 8 MiB, once the bar has drawn.
func midFileRun(t *testing.T, endBarLine, interrupted bool) (string, error) {
	t.Helper()
	r := startBarReceive(t, endBarLine)
	r.file(t, "big.bin", 64<<20, 1, 1, 8<<20, false)
	// The bar redraws at most every 65 ms: let it draw past 0 percent.
	time.Sleep(150 * time.Millisecond)
	return r.closeNow(t, interrupted)
}

func wantClosedMidFile(t *testing.T, err error) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "connection closed mid-transfer: big.bin (") {
		t.Fatalf("the receive returned %v, want the close mid-file", err)
	}
}

// TestReceiveEndBarLineStartsTheNextLineFresh: with EndBarLine, a close
// mid-file leaves the drawn bar's line ended exactly once.
func TestReceiveEndBarLineStartsTheNextLineFresh(t *testing.T) {
	out, err := midFileRun(t, true, false)
	wantClosedMidFile(t, err)
	if !strings.Contains(out, "%") {
		t.Fatalf("no bar was drawn: %q", barTail(out))
	}
	if !strings.HasSuffix(out, "\n") || strings.HasSuffix(out, "\n\n") {
		t.Fatalf("the bar's line was not ended exactly once: %q", barTail(out))
	}
}

// TestReceiveEndBarLineOffLeavesTheLineOpen: without it the bar's line stays
// open, as it always has for a caller that does not ask (Floe Desktop draws no
// bar at all).
func TestReceiveEndBarLineOffLeavesTheLineOpen(t *testing.T) {
	out, err := midFileRun(t, false, false)
	wantClosedMidFile(t, err)
	if !strings.Contains(out, "%") || strings.HasSuffix(out, "\n") {
		t.Fatalf("the bar's line changed without EndBarLine: %q", barTail(out))
	}
}

// TestReceiveEndBarLineLeavesAnInterruptToTheCaller: once the caller's Ctrl+C
// has taken the ending, the receive adds no line break, because the caller's
// "Canceled." line opens with its own.
func TestReceiveEndBarLineLeavesAnInterruptToTheCaller(t *testing.T) {
	out, err := midFileRun(t, true, true)
	wantClosedMidFile(t, err)
	if !strings.Contains(out, "%") || strings.HasSuffix(out, "\n") {
		t.Fatalf("an interrupted receive ended the bar's line: %q", barTail(out))
	}
}

// TestReceiveEndBarLineLeavesAFinishedLineAlone: the first of two files
// arrives whole, so its end marker already ended its bar's line, and a close
// before the second file adds no second break.
func TestReceiveEndBarLineLeavesAFinishedLineAlone(t *testing.T) {
	r := startBarReceive(t, true)
	r.file(t, "first.bin", 1<<20, 1, 2, 1<<20, true)
	out, err := r.closeNow(t, false)
	if err == nil || err.Error() != "connection closed after 1 of 2 files" {
		t.Fatalf("the receive returned %v, want the close between files", err)
	}
	if !strings.Contains(out, "100%") {
		t.Fatalf("the first file's bar never reached 100%%: %q", barTail(out))
	}
	if !strings.HasSuffix(out, "\n") || strings.HasSuffix(out, "\n\n") {
		t.Fatalf("a finished file's line was ended other than once: %q", barTail(out))
	}
}

// TestReceiveEndBarLineLeavesAnUndrawnBarAlone: a close after the ack and
// before any byte leaves a bar that never drew, and the cursor is already on
// the fresh line below the Incoming box.
func TestReceiveEndBarLineLeavesAnUndrawnBarAlone(t *testing.T) {
	r := startBarReceive(t, true)
	r.file(t, "big.bin", 64<<20, 1, 1, 0, false)
	out, err := r.closeNow(t, false)
	wantClosedMidFile(t, err)
	if strings.Contains(out, "%") {
		t.Fatalf("a bar was drawn with no byte received: %q", barTail(out))
	}
	if !strings.HasSuffix(out, divider+"\n\n") {
		t.Fatalf("a bar that never drew got a line break: %q", barTail(out))
	}
}
