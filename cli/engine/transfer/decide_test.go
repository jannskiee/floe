package transfer

// ReceiveOptions.Decide: the accept decision the receive loop asks for at the
// first metadata, and what each of the three answers leaves behind. The
// assertion every test here shares is about disk: at the moment Decide is
// asked nothing has been created, and only DecisionAccept may change that.
//
// The fixture for that is a nested first file. Reaching the claim would run
// os.MkdirAll for its folder, and the deferred cleanup removes only the
// staging file, never a directory, so "the output folder is still empty" is
// exactly "the claim never ran", which also means no ack was written: the ack
// is sent after the claim.
//
// Driven over real in-process pion pairs (see loopback_test.go for the raw
// harness and offerer_test.go for the host-receives one).

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// heldDecide is a Decide that blocks for a while and then accepts, the way a
// person at a prompt does. It records what it actually did, so a caller can
// prove the hold happened rather than assume it. watchdog_test.go passes its
// accept method too, so the held-decision shape is written once.
//
// calls and held are written on the receive loop's goroutine and read after
// that receive has returned.
type heldDecide struct {
	hold  time.Duration
	calls int
	held  time.Duration
}

func (h *heldDecide) accept(IncomingInfo) Decision {
	h.calls++
	start := time.Now()
	time.Sleep(h.hold)
	h.held = time.Since(start)
	return Decision{Kind: DecisionAccept}
}

// requireEmptyDir fails unless dir holds nothing at all, directories included.
// See the file comment: a directory is what survives the loop's own cleanup,
// so it is the evidence that the claim ran.
func requireEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	if len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("the output folder holds %v; nothing may be created for a transfer that was not accepted", names)
	}
}

// swapStdin replaces os.Stdin with a pipe already holding answer, so the
// receive loop's fmt.Scanln reads it with nobody at the keyboard. Scanln reads
// os.Stdin directly, so swapping the package variable is the only way in. The
// package has no t.Parallel, so a process-wide swap is safe, and the returned
// restore also runs from t.Cleanup when an assertion fails before it.
func swapStdin(t *testing.T, answer string) func() {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	if _, err := w.WriteString(answer); err != nil {
		t.Fatalf("stage stdin: %v", err)
	}
	orig := os.Stdin
	os.Stdin = r
	restored := false
	restore := func() {
		if restored {
			return
		}
		restored = true
		os.Stdin = orig
		_ = w.Close()
		_ = r.Close()
	}
	t.Cleanup(restore)
	return restore
}

// firstMeta is a first-metadata frame for a batch of one nested file, the
// fixture described at the top of this file.
const firstMeta = `{"type":"metadata","id":"d-1","fileName":"album/cover.txt","fileSize":1500,"index":1,"total":1,"totalBytes":1500}`

// TestDecideDeclineReachesGoSenderWithin2sAndClaimsNothing: a Decide that
// declines stops the transfer with a code the sender can act on, in the time a
// person would wait, and leaves the output folder untouched. The frame has to
// go out before the close, which is what makes the sender's error the typed
// refusal rather than generic closed-while-waiting text.
func TestDecideDeclineReachesGoSenderWithin2sAndClaimsNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	p := newOffererPair(t, nil)
	srcDir := t.TempDir()
	writeRandom(t, srcDir, "album/cover.txt", 1500)

	outDir := t.TempDir()
	decided := make(chan time.Time, 1)
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, outDir, false, "test-ver", "", ReceiveOptions{
			Decide: func(IncomingInfo) Decision {
				decided <- time.Now()
				return Decision{Kind: DecisionDecline}
			},
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

	var decidedAt time.Time
	select {
	case decidedAt = <-decided:
	case <-time.After(30 * time.Second):
		t.Fatal("Decide was never asked")
	}

	select {
	case err := <-sendErr:
		took := time.Since(decidedAt)
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
		if took > 2*time.Second {
			t.Fatalf("the decline reached the sender %s after Decide returned, want under 2 s", took)
		}
		t.Logf("the decline reached the sender %s after Decide returned", took)
	case <-time.After(30 * time.Second):
		t.Fatal("the sender never returned after the decline")
	}

	select {
	case err := <-recvErr:
		if !errors.Is(err, ErrDeclined) {
			t.Fatalf("receive error = %v (%T), want ErrDeclined", err, err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receive did not return after declining")
	}
	requireEmptyDir(t, outDir)
}

// TestDecideRefuseSendsCode: a Decide that refuses sends the code it named,
// the sender reads that code back, and the receive returns it typed. Both
// rows are codes the request lane answers with on its own, without a person.
func TestDecideRefuseSendsCode(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	for _, code := range []RefusalCode{CodeExpired, CodeOverApproved} {
		t.Run(string(code), func(t *testing.T) {
			p := newOffererPair(t, nil)
			srcDir := t.TempDir()
			writeRandom(t, srcDir, "album/cover.txt", 1500)

			outDir := t.TempDir()
			recvErr := make(chan error, 1)
			go func() {
				recvErr <- ReceiveFilesWithOptions(p.host, outDir, true, "test-ver", "", ReceiveOptions{
					Decide: func(IncomingInfo) Decision {
						return Decision{Kind: DecisionRefuse, Code: code}
					},
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
			case err := <-sendErr:
				var stopped *PeerStoppedError
				if !errors.As(err, &stopped) {
					t.Fatalf("sender error = %v (%T), want *PeerStoppedError", err, err)
				}
				if stopped.Code != code {
					t.Fatalf("PeerStoppedError code = %q, want %q", stopped.Code, code)
				}
			case <-time.After(30 * time.Second):
				t.Fatal("the sender never returned after the refusal")
			}

			select {
			case err := <-recvErr:
				var refused *RefusedError
				if !errors.As(err, &refused) {
					t.Fatalf("receive error = %v (%T), want *RefusedError", err, err)
				}
				if refused.Code != code {
					t.Fatalf("RefusedError code = %q, want %q", refused.Code, code)
				}
				if refused.Saved != 0 {
					t.Fatalf("RefusedError saved = %d, want 0", refused.Saved)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("the receive did not return after refusing")
			}
			requireEmptyDir(t, outDir)
		})
	}
}

// TestDecideAcceptAcksAfterDecision: the first ack is the sender's signal that
// the files are wanted, so it may not leave before the decision that wanted
// them. Decide holds, and the ack is timed against the instant it returned.
func TestDecideAcceptAcksAfterDecision(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	acks := make(chan time.Time, 4)
	pumpChannel(sender, func(m webrtc.DataChannelMessage) {
		if kind, ok := classifyControl(m.Data); ok && kind == "ack" {
			acks <- time.Now()
		}
	})

	outDir := t.TempDir()
	returned := make(chan time.Time, 1)
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", ReceiveOptions{
			Decide: func(IncomingInfo) Decision {
				time.Sleep(300 * time.Millisecond)
				returned <- time.Now()
				return Decision{Kind: DecisionAccept}
			},
		})
	}()

	// Let the receive register its handler before anything is sent.
	time.Sleep(300 * time.Millisecond)
	if err := sender.SendText(`{"type":"metadata","id":"d-ack","fileName":"a.txt","fileSize":4,"index":1,"total":1,"totalBytes":4}`); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}

	var returnedAt time.Time
	select {
	case returnedAt = <-returned:
	case <-time.After(20 * time.Second):
		t.Fatal("Decide never returned")
	}
	select {
	case ackAt := <-acks:
		if !ackAt.After(returnedAt) {
			t.Fatalf("the ack left %s before Decide returned, so the sender was told to send a transfer nobody had accepted", returnedAt.Sub(ackAt))
		}
	case <-time.After(20 * time.Second):
		t.Fatal("no ack ever reached the sender")
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
			t.Fatalf("expected the accepted transfer to finish, got: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receive did not return")
	}
	if got := listDir(t, outDir); len(got) != 1 || got[0] != "a.txt" {
		t.Fatalf("output tree %v, want only a.txt", got)
	}
}

// TestDecideAcceptOutputDirReplacesTarget: an Accept that names its own folder
// moves every path the receive produces into it. The folder is created inside
// Decide, which is the point of the field: before the answer there is nothing
// to delete.
//
// The three sites a test can see are checked by behavior. The fourth (the
// committed-name correction) fires only when something outside the process
// claims the final name between the claim and the commit, which no test can
// stage, so all four are pinned in source as well, in the style of
// TestSenderAckWaitArmsNothingElse.
func TestDecideAcceptOutputDirReplacesTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	src, err := os.ReadFile("receiver.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, joined := range []string{"safeJoin(outputDir", "filepath.Rel(outputDir", `{"Saved to", outputDir}`} {
		if strings.Contains(string(src), joined) {
			t.Fatalf("receiver.go still resolves a path against the caller's outputDir (%s), so an accepted folder would not reach it", joined)
		}
	}

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	drop := filepath.Join(outDir, "drop")
	var mkdirErr error
	var progress []Progress
	var finished []FileDone
	printed := captureStdout(t)

	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", ReceiveOptions{
			OnProgress: func(p Progress) { progress = append(progress, p) },
			OnFileDone: func(d FileDone) { finished = append(finished, d) },
			Decide: func(IncomingInfo) Decision {
				mkdirErr = os.MkdirAll(drop, 0o755)
				return Decision{Kind: DecisionAccept, OutputDir: drop}
			},
		})
	}()

	time.Sleep(300 * time.Millisecond)
	if err := sender.SendText(`{"type":"metadata","id":"d-out","fileName":"a.txt","fileSize":4,"index":1,"total":1,"totalBytes":4}`); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send([]byte("abcd")); err != nil {
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
			t.Fatalf("expected the accepted transfer to finish, got: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receive did not return")
	}
	out := printed()
	if mkdirErr != nil {
		t.Fatalf("create the accepted folder: %v", mkdirErr)
	}

	if got, err := os.ReadFile(filepath.Join(drop, "a.txt")); err != nil || string(got) != "abcd" {
		t.Fatalf("read the accepted folder: %q %v", got, err)
	}
	if got := listDir(t, outDir); len(got) != 1 || got[0] != "drop/a.txt" {
		t.Fatalf("output tree %v, want only drop/a.txt", got)
	}
	if len(progress) == 0 {
		t.Fatal("no progress events, so the SavedName claim would be vacuous")
	}
	if last := progress[len(progress)-1]; last.SavedName != "a.txt" {
		t.Fatalf("Progress.SavedName = %q, want a.txt (relative to the accepted folder, not its parent)", last.SavedName)
	}
	if len(finished) != 1 || finished[0].SavedName != "a.txt" {
		t.Fatalf("FileDone = %+v, want one with SavedName a.txt", finished)
	}
	if !strings.Contains(out, drop) {
		t.Fatalf("the summary does not name the folder the files went to:\n%s", out)
	}
}

// TestDecideRunsBeforeThePrompt: with a Decide set, the terminal prompt never
// runs, even with an answer waiting on stdin and autoAccept false. A prompt
// after a decision asks the wrong person, and on the request lane there is
// nobody at that terminal at all.
func TestDecideRunsBeforeThePrompt(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	replies := make(chan []byte, 8)
	pumpChannel(sender, func(m webrtc.DataChannelMessage) {
		select {
		case replies <- append([]byte(nil), m.Data...):
		default:
		}
	})

	// Stdin would say yes. Nothing may read it.
	swapStdin(t, "y\n")
	printed := captureStdout(t)

	outDir := t.TempDir()
	asked := 0
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, false, "test-ver", "", ReceiveOptions{
			Decide: func(IncomingInfo) Decision {
				asked++
				return Decision{Kind: DecisionDecline}
			},
		})
	}()

	time.Sleep(300 * time.Millisecond)
	if err := sender.SendText(firstMeta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}

	select {
	case err := <-recvErr:
		if !errors.Is(err, ErrDeclined) {
			t.Fatalf("receive error = %v (%T), want ErrDeclined", err, err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receive did not return after declining")
	}
	out := printed()

	if asked != 1 {
		t.Fatalf("Decide was asked %d times, want exactly 1", asked)
	}
	if strings.Contains(out, "Accept?") {
		t.Fatalf("the accept prompt was printed although a Decide had answered:\n%s", out)
	}
	requireEmptyDir(t, outDir)

	// The sender is told why, in the frame it already reads.
	select {
	case frame := <-replies:
		var incompat incompatibleMsg
		if err := json.Unmarshal(frame, &incompat); err != nil || incompat.Type != "incompatible" {
			t.Fatalf("expected an incompatible frame, got %q (%v)", frame, err)
		}
		if incompat.Code != string(CodeDeclined) {
			t.Fatalf("frame code = %q, want %q", incompat.Code, CodeDeclined)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the receiver never told the sender why it stopped")
	}
}

// TestNilDecideIsUnchanged: with Decide nil the prompt is still the decision,
// both ways. This is the other half of the guard TestDecideRunsBeforeThePrompt
// checks, and the reason every other test in this package can keep passing
// ReceiveOptions without one.
func TestNilDecideIsUnchanged(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	t.Run("yes at the prompt receives the file", func(t *testing.T) {
		sender, recvCh, closeFn := newConnectedPair(t)
		defer closeFn()

		swapStdin(t, "y\n")
		printed := captureStdout(t)

		outDir := t.TempDir()
		recvErr := make(chan error, 1)
		go func() {
			dc := <-recvCh
			recvErr <- ReceiveFilesWithOptions(dc, outDir, false, "", "", ReceiveOptions{})
		}()

		time.Sleep(300 * time.Millisecond)
		if err := sender.SendText(`{"type":"metadata","id":"d-yes","fileName":"a.txt","fileSize":4,"index":1,"total":1,"totalBytes":4}`); err != nil {
			t.Fatalf("SendText metadata: %v", err)
		}
		if err := sender.Send([]byte("abcd")); err != nil {
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
				t.Fatalf("expected the accepted transfer to finish, got: %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("the receive did not return")
		}
		if out := printed(); !strings.Contains(out, "Accept? [Y/n]") {
			t.Fatalf("the prompt did not run for a nil Decide:\n%s", out)
		}
		if got := listDir(t, outDir); len(got) != 1 || got[0] != "a.txt" {
			t.Fatalf("output tree %v, want only a.txt", got)
		}
	})

	t.Run("no at the prompt keeps its own sentence", func(t *testing.T) {
		sender, recvCh, closeFn := newConnectedPair(t)
		defer closeFn()

		swapStdin(t, "n\n")
		printed := captureStdout(t)

		outDir := t.TempDir()
		recvErr := make(chan error, 1)
		go func() {
			dc := <-recvCh
			recvErr <- ReceiveFilesWithOptions(dc, outDir, false, "", "", ReceiveOptions{})
		}()

		time.Sleep(300 * time.Millisecond)
		if err := sender.SendText(firstMeta); err != nil {
			t.Fatalf("SendText metadata: %v", err)
		}

		select {
		case err := <-recvErr:
			// The prompt returns its own error value, as it always has. Only
			// the Decide path returns the ErrDeclined sentinel, and the two
			// carry the same sentence.
			if err == nil || err.Error() != ErrDeclined.Error() {
				t.Fatalf("receive error = %v, want %q", err, ErrDeclined)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("the receive did not return after the prompt was answered no")
		}
		if out := printed(); !strings.Contains(out, "Accept? [Y/n]") {
			t.Fatalf("the prompt did not run for a nil Decide:\n%s", out)
		}
		requireEmptyDir(t, outDir)
	})
}

// TestCloseWhileDecidingLeavesNothingOnDisk: the sender walks away while the
// person is still deciding. Decide owes the loop a return when Closed fires,
// and the loop owes the disk nothing whatever the answer then says: this one
// accepts, and still nothing is created.
func TestCloseWhileDecidingLeavesNothingOnDisk(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	p := newOffererPair(t, nil)
	srcDir := t.TempDir()
	writeRandom(t, srcDir, "album/cover.txt", 1500)

	outDir := t.TempDir()
	deciding := make(chan struct{})
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, outDir, true, "test-ver", "", ReceiveOptions{
			Decide: func(IncomingInfo) Decision {
				close(deciding)
				<-p.hostClosed
				return Decision{Kind: DecisionAccept}
			},
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
	case <-deciding:
	case <-time.After(30 * time.Second):
		t.Fatal("Decide was never asked")
	}
	if err := p.visitor.Close(); err != nil {
		t.Fatalf("visitor close: %v", err)
	}

	select {
	case err := <-recvErr:
		if !errors.Is(err, ErrSenderLeft) {
			t.Fatalf("receive error = %v (%T), want ErrSenderLeft", err, err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the receive did not return after the sender closed")
	}
	requireEmptyDir(t, outDir)

	select {
	case <-sendErr:
	case <-time.After(20 * time.Second):
		t.Fatal("the sender did not return after closing its own channel")
	}
}

// TestLateAcceptAfterSenderLeftClaimsNothingAndSaysSo: the decision arrives
// after the sender gave up on its ack and its caller closed. Before the done
// check this claimed a staging file, acked a channel nobody was reading, and
// reported a mid-transfer close for a transfer that had never started.
func TestLateAcceptAfterSenderLeftClaimsNothingAndSaysSo(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	var mu sync.Mutex
	acks := 0
	senderMsgs, senderClosed := pumpChannel(sender, func(m webrtc.DataChannelMessage) {
		if kind, ok := classifyControl(m.Data); ok && kind == "ack" {
			mu.Lock()
			acks++
			mu.Unlock()
		}
	})

	srcDir := t.TempDir()
	writeRandom(t, srcDir, "album/cover.txt", 1500)

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "test-ver", "", ReceiveOptions{
			Decide: func(IncomingInfo) Decision {
				// Three seconds against the sender's one: by the time this
				// answers, the sender has timed out and closed.
				time.Sleep(3 * time.Second)
				return Decision{Kind: DecisionAccept}
			},
		})
	}()

	// Let the receive register its handler before anything is sent.
	time.Sleep(300 * time.Millisecond)

	sendErr := make(chan error, 1)
	go func() {
		err := SendFilesWithOptions(sender, []string{filepath.Join(srcDir, "album")}, "test-ver", SendOptions{
			AckTimeout: time.Second,
			Messages:   senderMsgs,
			Closed:     senderClosed,
		})
		// What send.go's deferred conn.Close() does the instant the send
		// returns. This is the fixture: the sender is gone.
		_ = sender.Close()
		sendErr <- err
	}()

	select {
	case err := <-sendErr:
		if err == nil || !strings.Contains(err.Error(), "timed out waiting for ack") {
			t.Fatalf("sender error = %v, want its ack timeout", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the sender never gave up on its ack")
	}

	select {
	case err := <-recvErr:
		if !errors.Is(err, ErrSenderLeft) {
			t.Fatalf("receive error = %v (%T), want ErrSenderLeft", err, err)
		}
		if strings.Contains(err.Error(), "mid-transfer") {
			t.Fatalf("the receive reported a transfer that never started: %q", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the receive did not return after the late accept")
	}

	requireEmptyDir(t, outDir)
	mu.Lock()
	defer mu.Unlock()
	if acks != 0 {
		t.Fatalf("the receiver acked %d times for a sender that had already gone", acks)
	}
}
