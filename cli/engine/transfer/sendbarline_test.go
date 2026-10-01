package transfer

// SendOptions.EndBarLine (FU-20 round 3, review lens A finding 2): an ending
// that lands while a file's bar is drawn part way leaves the bar's line
// ended, so the caller's next line starts on its own, while the plain send's
// output stays byte for byte what it was and a stop leaves the line to the
// caller's Ctrl+C line.

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
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

// heldStdout swaps stdout for a pipe that holds the next write until release:
// a filler write larger than any pipe buffer fills the pipe and keeps its
// write lock, so the progress bar's next draw waits behind it. release lets
// the pipe drain; restore puts stdout back and returns what was written.
func heldStdout(t *testing.T) (release func(), restore func() string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	gate := make(chan struct{})
	var buf bytes.Buffer
	drained := make(chan struct{})
	go func() {
		<-gate
		_, _ = io.Copy(&buf, r)
		close(drained)
	}()
	go func() { _, _ = w.Write(bytes.Repeat([]byte("x"), 4<<20)) }()
	var releaseOnce, restoreOnce sync.Once
	release = func() { releaseOnce.Do(func() { close(gate) }) }
	restore = func() string {
		restoreOnce.Do(func() {
			release()
			os.Stdout = orig
			_ = w.Close()
			<-drained
			_ = r.Close()
		})
		return buf.String()
	}
	t.Cleanup(func() { restore() })
	return release, restore
}

// TestEndBarLineLeavesAStopThatLostToARefusal: a stop and the receiver's
// refusal land together and the refusal wins, so the send returns the refusal
// with its stop already closed. The caller's Ctrl+C line still opens with its
// own line break, so the send must add none, or a blank line sits between the
// bar and "You stopped this drop." (review re-check LA2-6). The bar's draw is
// held on a full stdout pipe while the stop closes and the refusal is queued,
// so the first thing the send reads after that draw is the refusal.
func TestEndBarLineLeavesAStopThatLostToARefusal(t *testing.T) {
	sender, rdc, l := stopPair(t)
	src := stopFile(t, "big.bin", 64<<20)
	stop := make(chan struct{})
	release, restore := heldStdout(t)
	errc := startStoppable(sender, []string{src}, SendOptions{EndBarLine: true, Stop: stop})
	l.await(t, "metadata", 20*time.Second, func(f frames) bool { return len(f.ids) == 1 })
	ackFile(t, rdc, l.snapshot().ids[0])
	l.await(t, "file bytes", 20*time.Second, func(f frames) bool { return f.bytes > 0 })
	// The bar's first draw (at 1 percent) waits on the held pipe: the bytes
	// stop well short of the file, and stay where they stopped.
	held, since := l.snapshot().bytes, time.Now()
	for deadline := time.Now().Add(20 * time.Second); time.Since(since) < 300*time.Millisecond; {
		if time.Now().After(deadline) {
			t.Fatal("the send never parked on the bar's draw")
		}
		time.Sleep(50 * time.Millisecond)
		if now := l.snapshot().bytes; now != held {
			held, since = now, time.Now()
		}
	}
	if held >= 64<<20 {
		t.Fatalf("the whole file went out (%d bytes) before the bar drew", held)
	}
	close(stop)
	if err := rdc.Send([]byte(`{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"disk-full","saved":0}`)); err != nil {
		t.Fatalf("refusal: %v", err)
	}
	// Let the refusal reach the send's queue before the draw returns.
	time.Sleep(300 * time.Millisecond)
	release()
	var err error
	select {
	case err = <-errc:
	case <-time.After(20 * time.Second):
		t.Fatal("the send did not end")
	}
	out := restore()
	var stopped *PeerStoppedError
	if !errors.As(err, &stopped) || stopped.Code != CodeDiskFull {
		t.Fatalf("the send returned %v, want the refusal that won over the stop", err)
	}
	if !strings.Contains(out, "%") {
		t.Fatalf("no bar was drawn: %q", barTail(out))
	}
	if strings.HasSuffix(out, "\n") {
		t.Fatalf("a stop that lost to a refusal ended the bar's line: %q", barTail(out))
	}
}
