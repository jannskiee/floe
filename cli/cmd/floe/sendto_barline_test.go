package main

// An outcome that lands while a file's bar is drawn part way starts on a line
// of its own (FU-20 round 3, review lens A finding 2). The copy draws the
// saved forms of TL-16 to TL-26 and TL-27 below the partial bar, and TL-29's
// Ctrl+C line takes exactly the one line break it opens with. stdout and
// stderr share one pipe here, as they share a terminal; the other tests read
// stderr alone, where the join cannot show.

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

// combinedCapture sends stdout and stderr into one pipe, in the order they
// are written, and returns a func that restores both and returns what came
// through. As with captureOutput: call it before anything that prints
// starts, and read it only once every printer has ended.
func combinedCapture(t *testing.T) func() string {
	t.Helper()
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	origOut, origErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = pw, pw
	var buf bytes.Buffer
	var drain sync.WaitGroup
	drain.Add(1)
	go func() { defer drain.Done(); _, _ = io.Copy(&buf, pr) }()
	var once sync.Once
	restore := func() string {
		once.Do(func() {
			os.Stdout, os.Stderr = origOut, origErr
			_ = pw.Close()
			drain.Wait()
			_ = pr.Close()
		})
		return buf.String()
	}
	t.Cleanup(func() { restore() })
	return restore
}

// streamTail is the end of a captured stream, for a failure message.
func streamTail(s string) string {
	if len(s) > 400 {
		return s[len(s)-400:]
	}
	return s
}

// wantOwnLineAfterBar requires lines to start a line of their own right below
// the partial bar: exactly one line break between the two, so neither on the
// bar's line nor after a blank one. The bar redraws in place, so the line
// above is what follows the last carriage return.
func wantOwnLineAfterBar(t *testing.T, out, lines string) {
	t.Helper()
	at := strings.Index(out, lines)
	if at < 1 {
		t.Fatalf("%q never printed:\n%q", lines, streamTail(out))
	}
	if out[at-1] != '\n' {
		t.Fatalf("%q shares the bar's line:\n%q", lines, streamTail(out[:at+len(lines)]))
	}
	above := out[:at-1]
	if i := strings.LastIndexAny(above, "\r\n"); i >= 0 {
		above = above[i+1:]
	}
	if !strings.Contains(above, "%") {
		t.Fatalf("the line above %q is %q; want the partial bar right above it\n%q", lines, above, streamTail(out[:at+len(lines)]))
	}
}

// barHost acks the first file, reads 8 MiB of it and lets the bar draw, then
// ends the drop mid-file: with frame, a refusal sent as a Go receiver sends
// it, or when frame is "", with its close. It prints nothing.
func barHost(frame string) func(*testHost) error {
	return func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		id, err := h.awaitMetadata()
		if err != nil {
			return err
		}
		if err := h.ack(id); err != nil {
			return err
		}
		for got := 0; got < 8<<20; {
			m, err := h.frame(20 * time.Second)
			if err != nil {
				return err
			}
			got += len(m.Data)
		}
		time.Sleep(300 * time.Millisecond) // the bar redraws at most every 65 ms
		if frame == "" {
			h.conn.Close()
			return nil
		}
		if err := h.dc.Send([]byte(frame)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	}
}

// TestSendToMidFileOutcomeStartsItsOwnLine: a refusal (TL-16's saved form)
// and a close (TL-27) that land mid-file print their lines below the partial
// bar, not on it.
func TestSendToMidFileOutcomeStartsItsOwnLine(t *testing.T) {
	for _, c := range []struct {
		name, frame, lines string
	}{
		{"disk-full (TL-16)", `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"disk-full","saved":0}`,
			"  Their computer ran out of space.\n  Nothing was sent.\n"},
		{"the host's close (TL-27)", "",
			"  Connection lost. 0 of 1 file arrived. Ask them for a new link to send it.\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			out := combinedCapture(t)
			s := newReqServer(t, "seat")
			stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "big.bin", 64<<20)
			h := startHost(t, s, barHost(c.frame))
			r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
			herr := h.wait(t)
			text := out()
			if herr != nil || !errors.Is(r.err, errSendToEnded) {
				t.Fatalf("host %v, command %v\n%q", herr, r.err, streamTail(text))
			}
			wantOwnLineAfterBar(t, text, c.lines)
		})
	}
}

// TestSendToCtrlCMidFileTakesOneLineBreak: TL-29 mid-file opens with its own
// line break, and the send adds none, so the line sits right below the bar.
func TestSendToCtrlCMidFileTakesOneLineBreak(t *testing.T) {
	out := combinedCapture(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "big.bin", 64<<20)
	flowing := make(chan struct{})
	var once sync.Once
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		id, err := h.awaitMetadata()
		if err != nil {
			return err
		}
		if err := h.ack(id); err != nil {
			return err
		}
		for got := 0; ; {
			m, err := h.frame(20 * time.Second)
			if err != nil {
				return nil // the visitor's close
			}
			if got += len(m.Data); got >= 8<<20 {
				once.Do(func() { close(flowing) })
			}
		}
	})
	c := newCtrlC(t)
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL)
	c.letGo(t)
	select {
	case <-flowing:
	case <-time.After(30 * time.Second):
		t.Fatal("no bytes reached the host")
	}
	time.Sleep(300 * time.Millisecond) // the bar redraws at most every 65 ms
	c.press()
	c.wantOneLineAnd130(t, r, nil)
	if herr := h.wait(t); herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantOwnLineAfterBar(t, out(), "  You stopped this drop. Nothing was sent.\n")
}
