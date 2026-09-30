package transfer

// SendOptions.EndBarLine (FU-20 round 3, review lens A finding 2): an ending
// that lands while a file's bar is drawn part way leaves the bar's line
// ended, so the caller's next line starts on its own, while the plain send's
// output stays byte for byte what it was and a stop leaves the line to the
// caller's Ctrl+C line.

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// barLineRun sends 64 MiB with a terminal bar and ends the send inside the
// file, by the receiver's disk-full refusal or by a stop, and returns what
// the send printed and returned.
func barLineRun(t *testing.T, endBarLine, byStop bool) (string, error) {
	t.Helper()
	sender, rdc, l := stopPair(t)
	src := stopFile(t, "big.bin", 64<<20)
	stop := make(chan struct{})
	// Swapped before the send starts and put back after it has returned:
	// the bar draws from the send's goroutine (see deliverTwo).
	restore := captureStdout(t)
	errc := startStoppable(sender, []string{src}, SendOptions{EndBarLine: endBarLine, Stop: stop})
	l.await(t, "metadata", 20*time.Second, func(f frames) bool { return len(f.ids) == 1 })
	ackFile(t, rdc, l.snapshot().ids[0])
	l.await(t, "8 MiB of file bytes", 20*time.Second, func(f frames) bool { return f.bytes >= 8<<20 })
	// The bar redraws at most every 65 ms: let it draw past 0 percent.
	time.Sleep(150 * time.Millisecond)
	if byStop {
		close(stop)
	} else if err := rdc.Send([]byte(`{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"disk-full","saved":0}`)); err != nil {
		t.Fatalf("refusal: %v", err)
	}
	var err error
	select {
	case err = <-errc:
	case <-time.After(20 * time.Second):
		t.Fatal("the send did not end")
	}
	return restore(), err
}

func barTail(s string) string {
	if len(s) > 120 {
		return s[len(s)-120:]
	}
	return s
}

// TestEndBarLineStartsTheNextLineFresh: with EndBarLine, a refusal mid-file
// leaves the drawn bar's line ended exactly once.
func TestEndBarLineStartsTheNextLineFresh(t *testing.T) {
	out, err := barLineRun(t, true, false)
	var stopped *PeerStoppedError
	if !errors.As(err, &stopped) || stopped.Code != CodeDiskFull {
		t.Fatalf("the send returned %v, want the disk-full refusal", err)
	}
	if !strings.Contains(out, "%") {
		t.Fatalf("no bar was drawn: %q", barTail(out))
	}
	if !strings.HasSuffix(out, "\n") || strings.HasSuffix(out, "\n\n") {
		t.Fatalf("the bar's line was not ended exactly once: %q", barTail(out))
	}
}

// TestEndBarLineOffLeavesThePlainSendAsItWas: without it the bar's line
// stays open, as the plain send has always left it.
func TestEndBarLineOffLeavesThePlainSendAsItWas(t *testing.T) {
	out, err := barLineRun(t, false, false)
	var stopped *PeerStoppedError
	if !errors.As(err, &stopped) {
		t.Fatalf("the send returned %v, want the disk-full refusal", err)
	}
	if !strings.Contains(out, "%") || strings.HasSuffix(out, "\n") {
		t.Fatalf("the plain send's bar line changed: %q", barTail(out))
	}
}

// TestEndBarLineLeavesAStopToTheCaller: a stop gets no line break from the
// send, because the caller's Ctrl+C line opens with its own.
func TestEndBarLineLeavesAStopToTheCaller(t *testing.T) {
	out, err := barLineRun(t, true, true)
	if !errors.Is(err, ErrSendStopped) {
		t.Fatalf("the send returned %v, want ErrSendStopped", err)
	}
	if !strings.Contains(out, "%") || strings.HasSuffix(out, "\n") {
		t.Fatalf("a stop ended the bar's line: %q", barTail(out))
	}
}
