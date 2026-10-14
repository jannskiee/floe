package transfer

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The tests below are about the terminal prompt of a receive with no Decide,
// which is `floe receive` without --yes: what the sender is told when the
// answer is no, what happens when the sender leaves while the prompt waits,
// and which moment the two summaries count their time from.

// heldStdin swaps os.Stdin for a pipe that holds nothing yet, and returns the
// function that types into it. swapStdin stages its answer before the receive
// starts; these tests need the answer to arrive after something else has
// happened.
func heldStdin(t *testing.T) func(answer string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = orig
		_ = w.Close()
		_ = r.Close()
	})
	return func(answer string) {
		t.Helper()
		if _, err := w.WriteString(answer); err != nil {
			t.Fatalf("type the answer: %v", err)
		}
	}
}

// watchedStdout is captureStdout that can also say when a given text has been
// printed, without restoring anything: seen is closed the first time the
// output holds needle. The test waits on it instead of sleeping and hoping the
// prompt is up.
func watchedStdout(t *testing.T, needle string) (seen <-chan struct{}, printed func() string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	var mu sync.Mutex
	var buf bytes.Buffer
	seenCh := make(chan struct{})
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		var once sync.Once
		chunk := make([]byte, 4096)
		for {
			n, err := r.Read(chunk)
			if n > 0 {
				mu.Lock()
				buf.Write(chunk[:n])
				found := strings.Contains(buf.String(), needle)
				mu.Unlock()
				if found {
					once.Do(func() { close(seenCh) })
				}
			}
			// EOF once the write end closes in restore; any other error is the
			// same pipe closing on the way out.
			if err != nil {
				return
			}
		}
	}()
	restored := false
	restore := func() string {
		if !restored {
			restored = true
			os.Stdout = orig
			_ = w.Close()
			<-drained
			_ = r.Close()
		}
		mu.Lock()
		defer mu.Unlock()
		return buf.String()
	}
	t.Cleanup(func() { restore() })
	return seenCh, restore
}

const promptText = "Accept? [Y/n]"

// TestPromptNoReachesGoSenderAsDeclined: a no typed at the prompt is a
// decision, and the sender is owed it in the same form a Decide gives it. The
// receive used to close the channel and say nothing, so `floe send` ended
// with "connection closed while waiting for the receiver (transfer declined
// or receiver exited)", which cannot tell a person who said no from a
// terminal that was closed.
func TestPromptNoReachesGoSenderAsDeclined(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	p := newOffererPair(t, nil)
	srcDir := t.TempDir()
	writeRandom(t, srcDir, "album/cover.txt", 1500)

	swapStdin(t, "n\n")
	printed := captureStdout(t)

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, outDir, false, "test-ver", "", ReceiveOptions{
			Messages: p.hostMsgs,
			Closed:   p.hostClosed,
		})
	}()

	sendErr := make(chan error, 1)
	go func() {
		sendErr <- SendFilesWithOptions(p.visitor, []string{filepath.Join(srcDir, "album")}, "test-ver", SendOptions{
			Messages:  p.visitorMsgs,
			Closed:    p.visitorClosed,
			NoSummary: true,
		})
	}()

	select {
	case err := <-sendErr:
		var stopped *PeerStoppedError
		if !errors.As(err, &stopped) {
			t.Fatalf("sender error = %v (%T), want *PeerStoppedError", err, err)
		}
		if stopped.Code != CodeDeclined {
			t.Fatalf("PeerStoppedError code = %q, want %q", stopped.Code, CodeDeclined)
		}
		if stopped.Saved != 0 {
			t.Fatalf("the sender was told %d files were saved; nothing was", stopped.Saved)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the sender never returned after the no")
	}

	select {
	case err := <-recvErr:
		// The prompt's own error value, with the sentence it has always had.
		if err == nil || err.Error() != ErrDeclined.Error() {
			t.Fatalf("receive error = %v, want %q", err, ErrDeclined)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receive did not return after the prompt was answered no")
	}
	if out := printed(); !strings.Contains(out, promptText) {
		t.Fatalf("the prompt did not run:\n%s", out)
	}
	requireEmptyDir(t, outDir)
}

// TestPromptAnswerAfterTheSenderLeftClaimsNothing: the sender closes while the
// prompt is still waiting, and the person then says yes. The Decide path has
// always asked whether the sender is still there before acting on an answer;
// the prompt did not, so a yes created the folder and a .part, acked into a
// closed channel and reported "connection closed mid-transfer", which blames
// a transfer for something that happened before it started.
func TestPromptAnswerAfterTheSenderLeftClaimsNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	for _, answer := range []string{"y\n", "n\n"} {
		t.Run("answer "+strings.TrimSpace(answer), func(t *testing.T) {
			p := newOffererPair(t, nil)
			typeAnswer := heldStdin(t)
			prompted, printed := watchedStdout(t, promptText)

			outDir := t.TempDir()
			recvErr := make(chan error, 1)
			go func() {
				recvErr <- ReceiveFilesWithOptions(p.host, outDir, false, "test-ver", "", ReceiveOptions{
					Messages: p.hostMsgs,
					Closed:   p.hostClosed,
				})
			}()

			if err := p.visitor.SendText(firstMeta); err != nil {
				t.Fatalf("SendText metadata: %v", err)
			}
			// The order under test: the prompt is up, THEN the sender leaves,
			// THEN the answer arrives. A close that raced the metadata would
			// be a different ending (closed before any file).
			select {
			case <-prompted:
			case <-time.After(20 * time.Second):
				t.Fatalf("the prompt never appeared:\n%s", printed())
			}
			_ = p.visitor.Close()
			select {
			case <-p.hostClosed:
			case <-time.After(20 * time.Second):
				t.Fatal("the receiving side never saw the close")
			}
			typeAnswer(answer)

			select {
			case err := <-recvErr:
				if !errors.Is(err, ErrSenderLeft) {
					t.Fatalf("receive error = %v (%T), want ErrSenderLeft", err, err)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("the receive did not return after the answer")
			}
			requireEmptyDir(t, outDir)
		})
	}
}

// timeRow reads the whole seconds of the "Time" row that follows label's row
// in a printed summary box ("Sent" or "Received").
func timeRow(t *testing.T, out, label string) int {
	t.Helper()
	at := regexp.MustCompile(`(?m)^\s+` + label + `\s`).FindStringIndex(out)
	if at == nil {
		t.Fatalf("no %q row in the output:\n%s", label, out)
	}
	m := regexp.MustCompile(`(?m)^\s+Time\s+(\d+)s\b`).FindStringSubmatch(out[at[1]:])
	if m == nil {
		t.Fatalf("no Time row in whole seconds after the %q row:\n%s", label, out)
	}
	secs, err := strconv.Atoi(m[1])
	if err != nil {
		t.Fatalf("Time row %q: %v", m[1], err)
	}
	return secs
}

// TestSummaryTimeCountsFromAccept: the "Time" row of both summaries, and the
// average speed worked out from it, is the time the files took. Both clocks
// used to start before the person at the receiving end had answered (the
// receiver's at the first metadata, the sender's before it), so a transfer
// that took a moment after a slow yes was reported as slow.
func TestSummaryTimeCountsFromAccept(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	// How long the person takes to answer. The file is 1,500 bytes over
	// loopback, so anything near this in a Time row is the wait, not the file.
	const thinking = 3 * time.Second

	p := newOffererPair(t, nil)
	srcDir := t.TempDir()
	writeRandom(t, srcDir, "album/cover.txt", 1500)

	typeAnswer := heldStdin(t)
	prompted, printed := watchedStdout(t, promptText)

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, outDir, false, "test-ver", "", ReceiveOptions{
			Messages: p.hostMsgs,
			Closed:   p.hostClosed,
		})
	}()
	sendErr := make(chan error, 1)
	go func() {
		sendErr <- SendFilesWithOptions(p.visitor, []string{filepath.Join(srcDir, "album")}, "test-ver", SendOptions{
			Messages: p.visitorMsgs,
			Closed:   p.visitorClosed,
		})
	}()

	select {
	case <-prompted:
	case <-time.After(30 * time.Second):
		t.Fatalf("the prompt never appeared:\n%s", printed())
	}
	time.Sleep(thinking)
	typeAnswer("y\n")

	p.finish(t, sendErr, recvErr, 30*time.Second)

	out := printed()
	limit := int(thinking / time.Second)
	if got := timeRow(t, out, "Received"); got >= limit {
		t.Errorf("the receiver's Time row is %ds after a %s wait at the prompt: it counted the wait", got, thinking)
	}
	if got := timeRow(t, out, "Sent"); got >= limit {
		t.Errorf("the sender's Time row is %ds after a %s wait at the prompt: it counted the wait", got, thinking)
	}
}

// closedStdin swaps os.Stdin for a pipe whose writing end is already closed,
// so the prompt's read returns at once with nothing: a run from a script or a
// service with no input.
func closedStdin(t *testing.T) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	_ = w.Close()
	orig := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = orig
		_ = r.Close()
	})
}

// TestPromptLineEndsOnlyWhenNothingWasRead (A4-B25, CLI-06): whatever ends
// an answer read from a terminal (the Enter, empty or not) is echoed, and that
// echo is what ends the prompt's line. A read that took nothing (stdin closed,
// or Ctrl+D at the prompt) echoes nothing, so the prompt and the first
// progress line used to share a line: "  Accept? [Y/n]   [1/1] ...". The
// prompt ends its own line then, and only then. Anything read, piped or typed,
// adds nothing: a console that echoes typed input through a pipe (mintty, an
// IDE's run console) looks like a pipe, and a line break there would follow
// the echo as a blank line.
func TestPromptLineEndsOnlyWhenNothingWasRead(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	for _, c := range []struct {
		name  string
		stage func(t *testing.T)
		ends  bool
	}{
		{"stdin closed, nothing read", closedStdin, true},
		{"an answer read", func(t *testing.T) { swapStdin(t, "y\n") }, false},
		{"an empty line read", func(t *testing.T) { swapStdin(t, "\n") }, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := newOffererPair(t, nil)
			srcDir := t.TempDir()
			writeRandom(t, srcDir, "album/cover.txt", 1500)
			c.stage(t)
			printed := captureStdout(t)

			outDir := t.TempDir()
			recvErr := make(chan error, 1)
			go func() {
				recvErr <- ReceiveFilesWithOptions(p.host, outDir, false, "test-ver", "", ReceiveOptions{
					Messages: p.hostMsgs,
					Closed:   p.hostClosed,
				})
			}()
			sendErr := make(chan error, 1)
			go func() {
				sendErr <- SendFilesWithOptions(p.visitor, []string{filepath.Join(srcDir, "album")}, "test-ver", SendOptions{
					Messages:  p.visitorMsgs,
					Closed:    p.visitorClosed,
					NoSummary: true,
				})
			}()
			p.finish(t, sendErr, recvErr, 30*time.Second)

			out := printed()
			at := strings.Index(out, promptText)
			if at < 0 {
				t.Fatalf("the prompt did not run:\n%s", out)
			}
			ended := strings.HasPrefix(out[at+len(promptText):], " \n")
			if c.ends && !ended {
				t.Fatalf("the prompt's line did not end; it reads %q", strings.SplitN(out[at:], "\n", 2)[0])
			}
			if !c.ends && ended {
				t.Fatal("the prompt added a line break after a read that took input, whose echo ends the line")
			}
		})
	}
}
