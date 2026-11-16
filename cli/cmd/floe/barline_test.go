package main

// A plain floe send or floe receive that ends while a file's bar is drawn part
// way prints its error on a line of its own, right below the partial bar, as
// floe send --to already does (sendto_barline_test.go). Ctrl+C keeps exactly
// the one line break its "Canceled." line opens with, and an error after a
// finished file's line gets no blank line above it. stdout and stderr share
// one pipe here (combinedCapture), as they share a terminal.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v4"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

// TestSendMidFileErrorStartsItsOwnLine: the receiver's refusal and its close,
// each landing mid-file, print their "Error:" line below the partial bar, not
// on it.
func TestSendMidFileErrorStartsItsOwnLine(t *testing.T) {
	for _, c := range []struct {
		name, frame, line string
	}{
		{"disk-full", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"disk-full","saved":0}`,
			"Error: Their computer ran out of space.\n"},
		{"the receiver's close", "", "Error: error sending big.bin: "},
	} {
		t.Run(c.name, func(t *testing.T) {
			out := combinedCapture(t)
			url, seated := plainRoom(t)
			src, _ := oneFile(t, t.TempDir(), "big.bin", 64<<20)
			r := startCLI(t, src, "--server", url)
			plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
				id, ok := awaitFirstMetadata(early, quit)
				if !ok {
					t.Error("no metadata from the send")
					return
				}
				// The ack a Go receiver sends: binary, offset 0.
				if err := dc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1,"ver":"dev"}`)); err != nil {
					t.Errorf("receiver ack: %v", err)
					return
				}
				for got := 0; got < 8<<20; {
					select {
					case m := <-early.Msgs:
						if !m.IsString {
							got += len(m.Data)
						}
					case <-early.Closed:
						t.Error("the send closed before 8 MiB arrived")
						return
					case <-quit:
						return
					}
				}
				time.Sleep(300 * time.Millisecond) // the bar redraws at most every 65 ms
				if c.frame == "" {
					_ = dc.Close()
					return
				}
				if err := dc.Send([]byte(c.frame)); err != nil {
					t.Errorf("refusal: %v", err)
				}
			})
			r.wait(t, 90*time.Second)
			text := pionLog.ReplaceAllString(out(), "")
			if r.err == nil {
				t.Fatalf("the send succeeded, want it to end mid-file\n%q", streamTail(text))
			}
			wantOwnLineAfterBar(t, text, c.line)
		})
	}
}

// TestPlainSendCtrlCMidFileTakesOneLineBreak: "Canceled." opens with its own
// line break, and the send adds none, so the line sits right below the bar.
func TestPlainSendCtrlCMidFileTakesOneLineBreak(t *testing.T) {
	out := combinedCapture(t)
	url, seated := plainRoom(t)
	src, _ := oneFile(t, t.TempDir(), "big.bin", 64<<20)
	flowing := make(chan struct{})
	var once sync.Once
	c := newCtrlC(t)
	r := startCLI(t, src, "--server", url)
	c.letGo(t)
	plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
		id, ok := awaitFirstMetadata(early, quit)
		if !ok {
			return
		}
		if err := dc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1,"ver":"dev"}`)); err != nil {
			t.Errorf("receiver ack: %v", err)
			return
		}
		for got := 0; ; {
			select {
			case m := <-early.Msgs:
				if got += len(m.Data); got >= 8<<20 {
					once.Do(func() { close(flowing) })
				}
			case <-early.Closed:
				return
			case <-quit:
				return
			}
		}
	})
	select {
	case <-flowing:
	case <-time.After(30 * time.Second):
		t.Fatal("no bytes reached the receiver")
	}
	time.Sleep(300 * time.Millisecond) // the bar redraws at most every 65 ms
	c.press()
	c.wantOneLineAnd130(t, r, nil)
	wantOwnLineAfterBar(t, pionLog.ReplaceAllString(out(), ""), "  Canceled.\n")
}

// startReceive runs `floe receive args...` against the server at url through
// execute, as main runs it, on its own goroutine, and returns where its error
// arrives. The flags it sets and the Ctrl+C step it leaves go back afterwards.
func startReceive(t *testing.T, url string, args ...string) <-chan error {
	t.Helper()
	resetSharedFlags(t)
	t.Setenv("FLOE_NO_STATS", "1")
	rootCmd.SetOut(nil)
	rootCmd.SetErr(nil)
	argv := append([]string{"receive"}, args...)
	argv = append(argv, "--server", url, "--no-report")
	errc := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		errc <- execute(argv)
	}()
	t.Cleanup(func() {
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Errorf("floe receive was still running 30 s after the test")
		}
		resetReceiveStop()
		if f := rootCmd.PersistentFlags().Lookup("server"); f != nil {
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		}
		for _, name := range []string{"output", "yes", "no-report", "no-progress"} {
			if f := receiveCmd.Flags().Lookup(name); f != nil {
				_ = f.Value.Set(f.DefValue)
				f.Changed = false
			}
		}
		rootCmd.SetArgs(nil)
	})
	return errc
}

// waitForSize returns once the file at path holds at least n bytes.
func waitForSize(t *testing.T, path string, n int64) {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(2 * time.Millisecond) {
		if fi, err := os.Stat(path); err == nil && fi.Size() >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never held %d bytes", filepath.Base(path), n)
		}
	}
}

// handFile announces file index of total, size bytes, waits for its ack and
// sends the first sent bytes of it (a multiple of 64 KiB), then its end marker
// when end is set.
func handFile(dc *webrtc.DataChannel, back <-chan webrtc.DataChannelMessage, name string, size, index, total, sent int, end bool) error {
	meta := fmt.Sprintf(`{"type":"metadata","id":"hand-%d","fileName":%q,"fileSize":%d,"index":%d,"total":%d,"totalBytes":%d}`,
		index, name, size, index, total, 64<<20)
	if err := dc.SendText(meta); err != nil {
		return err
	}
	select {
	case <-back:
	case <-time.After(30 * time.Second):
		return errors.New("no ack from the receive")
	}
	chunk := make([]byte, 64<<10)
	for n := 0; n < sent; n += len(chunk) {
		if err := dc.Send(chunk); err != nil {
			return err
		}
	}
	if end {
		return dc.SendText(`{"type":"end"}`)
	}
	return nil
}

// TestReceiveMidFileErrorStartsItsOwnLine: the sender's stop (what a plain
// floe send's Ctrl+C sends) and its bare close, each landing mid-file, print
// their "Error:" line below the partial bar, not on it.
func TestReceiveMidFileErrorStartsItsOwnLine(t *testing.T) {
	for _, c := range []struct {
		name string
		stop bool
		line string
	}{
		{"the sender's stop", true, "Error: The sender stopped.\n"},
		{"the sender's close", false, "Error: connection closed mid-transfer: big.bin ("},
	} {
		t.Run(c.name, func(t *testing.T) {
			out := combinedCapture(t)
			url, _ := plainRoom(t)
			room := uuid.New().String()
			end := make(chan struct{})
			result := handRoomSender(t, url, room, func(dc *webrtc.DataChannel, back <-chan webrtc.DataChannelMessage) error {
				if err := handFile(dc, back, "big.bin", 64<<20, 1, 1, 8<<20, false); err != nil {
					return err
				}
				select {
				case <-end:
				case <-time.After(30 * time.Second):
					return errors.New("the test never ended the send")
				}
				if c.stop {
					transfer.AbortSend(dc, "dev", transfer.VisitorCancelReason)
				}
				return dc.Close()
			})
			dir := t.TempDir()
			errc := startReceive(t, url, url+"/#room="+room, "-y", "--output", dir)
			waitForSize(t, filepath.Join(dir, "big.bin.part"), 8<<20)
			time.Sleep(150 * time.Millisecond) // the bar redraws at most every 65 ms
			close(end)
			var err error
			select {
			case err = <-errc:
			case <-time.After(30 * time.Second):
				t.Fatal("the receive did not end")
			}
			if serr := <-result; serr != nil {
				t.Fatalf("the hand sender: %v", serr)
			}
			text := pionLog.ReplaceAllString(out(), "")
			if err == nil {
				t.Fatalf("the receive succeeded, want it to end mid-file\n%q", streamTail(text))
			}
			wantOwnLineAfterBar(t, text, c.line)
		})
	}
}

// TestReceiveErrorAfterAFinishedFileTakesNoBlankLine: the first of two files
// arrives whole, so its own line break already ended its bar's line, and the
// close before the second file prints its line right below that bar.
func TestReceiveErrorAfterAFinishedFileTakesNoBlankLine(t *testing.T) {
	out := combinedCapture(t)
	url, _ := plainRoom(t)
	room := uuid.New().String()
	dir := t.TempDir()
	saved := filepath.Join(dir, "first.bin")
	result := handRoomSender(t, url, room, func(dc *webrtc.DataChannel, back <-chan webrtc.DataChannelMessage) error {
		if err := handFile(dc, back, "first.bin", 1<<20, 1, 2, 1<<20, true); err != nil {
			return err
		}
		for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(2 * time.Millisecond) {
			if fi, err := os.Stat(saved); err == nil && fi.Size() == 1<<20 {
				break
			}
			if time.Now().After(deadline) {
				return errors.New("the receive never saved the first file")
			}
		}
		return dc.Close()
	})
	errc := startReceive(t, url, url+"/#room="+room, "-y", "--output", dir)
	var err error
	select {
	case err = <-errc:
	case <-time.After(30 * time.Second):
		t.Fatal("the receive did not end")
	}
	if serr := <-result; serr != nil {
		t.Fatalf("the hand sender: %v", serr)
	}
	text := pionLog.ReplaceAllString(out(), "")
	if err == nil {
		t.Fatalf("the receive succeeded, want the close between files\n%q", streamTail(text))
	}
	wantOwnLineAfterBar(t, text, "Error: connection closed after 1 of 2 files\n")
}

// TestReceiveCtrlCMidFileTakesOneLineBreak: "Canceled." opens with its own
// line break, so the receive adds none: the line sits right below the partial
// bar, and nothing follows it before the exit.
func TestReceiveCtrlCMidFileTakesOneLineBreak(t *testing.T) {
	got := receiveCtrlCMerged(t)
	wantOwnLineAfterBar(t, got, "  Canceled.\n"+exitMark)
	if !strings.HasSuffix(got, "\n  Canceled.\n"+exitMark) {
		t.Fatalf("something followed \"Canceled.\": %q", streamTail(got))
	}
}
