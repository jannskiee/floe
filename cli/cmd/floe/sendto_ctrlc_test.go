package main

// Ctrl+C on the request-link send (TL-28, TL-29; FU-20 round 3: review lens A
// findings 1 and 4, lens B M1, M3 and I2). main's own handler runs here
// (handleInterrupts) with os.Exit recorded, so each test sees what the process
// would: which exit came first, and every line either side printed. Before
// this round the command's own outcome path printed a second, contradictory
// line ("Connection lost. ...") and main's exit 1 beat the handler's 130.

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// ctrlC is main's handler on a test channel, with os.Exit recorded and the
// command's park made releasable.
type ctrlC struct {
	sig         chan os.Signal
	exits       exitRecorder
	parked      chan struct{}
	parkOnce    sync.Once
	release     chan struct{}
	releaseOnce sync.Once
}

// newCtrlC starts main's handler for one test. Call it before startCLI: the
// park seam it sets is then in place before the command runs, and its
// cleanup, which runs after startCLI's, restores the seam only once the
// command has ended.
func newCtrlC(t *testing.T) *ctrlC {
	t.Helper()
	c := &ctrlC{
		sig:     make(chan os.Signal, 1),
		exits:   make(exitRecorder, 4),
		parked:  make(chan struct{}),
		release: make(chan struct{}),
	}
	prev := parkUntilExit
	parkUntilExit = func() {
		c.parkOnce.Do(func() { close(c.parked) })
		<-c.release
	}
	go handleInterrupts(c.sig, c.exits.exit)
	t.Cleanup(func() {
		parkUntilExit = prev
		close(c.sig) // frees the goroutine that waits for a second signal
	})
	return c
}

// letGo lets a parked command return when the test ends. Call it after
// startCLI, so this cleanup runs before startCLI's waits for the command.
func (c *ctrlC) letGo(t *testing.T) {
	t.Cleanup(c.free)
}

func (c *ctrlC) free() { c.releaseOnce.Do(func() { close(c.release) }) }

func (c *ctrlC) press() { c.sig <- os.Interrupt }

// wantOneLineAnd130 asserts the process as main runs it: the handler's exit
// 130 came while the command had not returned (so main's exit 1 could not
// race it), and the command then parked. It lets the command return and
// reads what both printed.
func (c *ctrlC) wantOneLineAnd130(t *testing.T, r *cliRun, o *output) {
	t.Helper()
	if code := c.exits.awaitExit(t, 10*time.Second, "Ctrl+C"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	select {
	case <-r.done:
		t.Fatalf("the command returned (%v) before the handler's exit: main's os.Exit(1) would have raced the 130", r.err)
	default:
	}
	select {
	case <-c.parked:
	case <-time.After(10 * time.Second):
		t.Fatal("the command never parked after Ctrl+C took its ending")
	}
	c.free()
	r.wait(t, 20*time.Second)
	if r.err != errSendToEnded || !sendCmd.SilenceErrors {
		t.Fatalf("the parked command returned %v (cobra silenced: %v), want the silent end", r.err, sendCmd.SilenceErrors)
	}
}

// pionLog is a line pion's default logger writes to stderr on its own: not
// the command's, so not part of what the command printed.
var pionLog = regexp.MustCompile(`(?m)^[a-z0-9_-]+ (ERROR|WARNING|INFO|DEBUG|TRACE): .*\n`)

// wantOnlyLine requires the Ctrl+C line, and nothing else from the command, on
// stderr.
func wantOnlyLine(t *testing.T, r *cliRun, line string) {
	t.Helper()
	if got := pionLog.ReplaceAllString(r.stderr, ""); got != line+"\n" {
		t.Fatalf("stderr = %q, want the Ctrl+C line alone, %q\nstdout:\n%s", got, line+"\n", r.stdout)
	}
}

const (
	tl28Line = "\n  Canceled. Nothing was sent."
	tl29Line = "\n  You stopped this drop. Nothing was sent."
)

// TestSendToCtrlCLineFollowsThePhase: the hook's answer in each phase, and
// who ends the command when the command and Ctrl+C meet. No network: the
// command's side is driven by hand.
func TestSendToCtrlCLineFollowsThePhase(t *testing.T) {
	if line, stop := interruptLine(); line != "\n  Canceled." || stop == nil {
		t.Fatalf("with no hook, Ctrl+C prints %q", line)
	}
	prev := sendToStopWait
	sendToStopWait = 50 * time.Millisecond
	t.Cleanup(func() { sendToStopWait = prev })

	// Setup: TL-28 at once, nothing to tell a host that has no channel yet,
	// and the command can neither go on nor take the ending back.
	r := newSendToRun()
	r.files.Store(12)
	line, stop := r.interrupt()
	if line != tl28Line || stop == nil {
		t.Fatalf("Ctrl+C in setup = %q (stop %v)", line, stop != nil)
	}
	stop()
	if r.enterSending(nil, nil) || r.finish(false) || r.finish(true) {
		t.Fatal("the command went on, or took the ending back, after a Ctrl+C in setup")
	}

	// Sending: the send sees its stop, the command settles, and the line
	// follows the last ack (TL-28 before the host accepted, TL-29 after).
	for _, c := range []struct {
		acked int64
		want  string
	}{
		{0, tl28Line},
		{1, tl29Line},
		{5, "\n  You stopped this drop. 4 of 12 files were saved."},
	} {
		r := newSendToRun()
		r.files.Store(12)
		r.enterSending(nil, nil)
		r.acked.Store(c.acked)
		got := make(chan string, 1)
		go func() {
			line, stop := r.interrupt()
			if stop == nil {
				line = "(no stop)"
			}
			got <- line
		}()
		<-r.stop
		if r.finish(false) {
			t.Fatalf("acked %d: the stopped send took the ending back", c.acked)
		}
		if line := <-got; line != c.want {
			t.Fatalf("acked %d: Ctrl+C prints %q, want %q", c.acked, line, c.want)
		}
	}

	// Over: the outcome is out, so Ctrl+C prints nothing and leaves the exit
	// code to the command (review lens A finding 4).
	r = newSendToRun()
	r.enterSending(nil, nil)
	if !r.finish(false) {
		t.Fatal("the command could not take its own ending")
	}
	if line, stop := r.interrupt(); line != "" || stop != nil {
		t.Fatalf("Ctrl+C after the outcome = %q (stop %v), want nothing", line, stop != nil)
	}

	// A received that lands with the stop is a success, and Ctrl+C then
	// prints nothing.
	r = newSendToRun()
	r.enterSending(nil, nil)
	got := make(chan bool, 1)
	go func() {
		line, stop := r.interrupt()
		got <- line == "" && stop == nil
	}()
	<-r.stop
	if !r.finish(true) {
		t.Fatal("a drop that arrived as Ctrl+C came did not end as a success")
	}
	if !<-got {
		t.Fatal("Ctrl+C still printed its line over a success")
	}

	// Once the line is committed, a late success stays the handler's.
	r = newSendToRun()
	r.enterSending(nil, nil)
	if line, stop := r.interrupt(); line != tl28Line || stop == nil {
		t.Fatalf("Ctrl+C with a send that never settled = %q", line)
	}
	if r.finish(true) {
		t.Fatal("a success after the Ctrl+C line took the ending back")
	}
}

// decidingHost is Floe Desktop while the person decides: it holds the first
// metadata unanswered, reads what the visitor sends next, and closes once
// that is the visitor's abort (runRequestDrop's deferred close).
func decidingHost(deciding chan<- struct{}, reason chan<- string) func(*testHost) error {
	return func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		if _, err := h.awaitMetadata(); err != nil {
			return err
		}
		close(deciding)
		for {
			m, err := h.frame(20 * time.Second)
			if err != nil {
				return err
			}
			if typ, _ := controlOf(m); typ == "incompatible" {
				var f struct {
					Reason string `json:"reason"`
				}
				_ = json.Unmarshal(m.Data, &f)
				reason <- f.Reason
				h.conn.Close()
				return nil
			}
		}
	}
}

// TestSendToCtrlCBeforeAcceptEndsOnOneLine: Ctrl+C while the host decides
// prints TL-28 and nothing else, exits 130, and tells the host with the
// visitor's fixed reason, although the host's close answers it at once.
func TestSendToCtrlCBeforeAcceptEndsOnOneLine(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	deciding := make(chan struct{})
	reason := make(chan string, 1)
	h := startHost(t, s, decidingHost(deciding, reason))
	c := newCtrlC(t)
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL)
	c.letGo(t)
	select {
	case <-deciding:
	case <-time.After(30 * time.Second):
		t.Fatal("the host never got the metadata")
	}
	c.press()
	c.wantOneLineAnd130(t, r, o)
	if herr := h.wait(t); herr != nil {
		t.Fatalf("host: %v", herr)
	}
	r.read(o)
	wantOnlyLine(t, r, tl28Line)
	if got := <-reason; got != transfer.VisitorCancelReason {
		t.Fatalf("the host read %q, want the visitor's fixed reason", got)
	}
}

// TestSendToCtrlCMidDropEndsOnOneLine: Ctrl+C mid-file against Floe Desktop's
// receive, which closes the moment its receive returns, prints TL-29 and
// nothing else and exits 130; the host ends on the visitor's fixed reason.
func TestSendToCtrlCMidDropEndsOnOneLine(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "big.bin", 64<<20)
	out := t.TempDir()
	flowing := make(chan struct{})
	var once sync.Once
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		defer h.conn.Close()
		return transfer.ReceiveFilesWithOptions(h.dc, out, false, "desktop-test", "", transfer.ReceiveOptions{
			OnProgress: func(pr transfer.Progress) {
				if pr.FileBytes > 0 {
					once.Do(func() { close(flowing) })
				}
			},
			Decide: func(transfer.IncomingInfo) transfer.Decision {
				return transfer.Decision{Kind: transfer.DecisionAccept, OutputDir: out}
			},
			Messages: h.early.Msgs,
			Closed:   h.early.Closed,
		})
	})
	c := newCtrlC(t)
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL)
	c.letGo(t)
	select {
	case <-flowing:
	case <-time.After(30 * time.Second):
		t.Fatal("no bytes reached the host")
	}
	c.press()
	c.wantOneLineAnd130(t, r, o)
	herr := h.wait(t)
	r.read(o)
	wantOnlyLine(t, r, tl29Line)
	if herr == nil || herr.Error() != transfer.VisitorCancelReason {
		t.Fatalf("host = %v, want the visitor's fixed reason %q", herr, transfer.VisitorCancelReason)
	}
}

// TestSendToCtrlCSendsNothingAfterTheAbort: a host that ignores the abort and
// reads on gets no file byte after it (lens B probed 121.9 MB of a 128 MiB
// file before this round). The send stops before the abort goes out.
func TestSendToCtrlCSendsNothingAfterTheAbort(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "big.bin", 64<<20)
	flowing := make(chan struct{})
	var once sync.Once
	var before, after int64
	var sawAbort bool
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
		for {
			m, err := h.frame(20 * time.Second)
			if err != nil {
				return nil // the visitor's close ends the count
			}
			if !m.IsString {
				if sawAbort {
					after += int64(len(m.Data))
				} else if before += int64(len(m.Data)); before >= 4<<20 {
					once.Do(func() { close(flowing) })
				}
				continue
			}
			if typ, _ := controlOf(m); typ == "incompatible" {
				sawAbort = true // and reads on, as a hostile host would
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
	c.press()
	c.wantOneLineAnd130(t, r, o)
	if herr := h.wait(t); herr != nil {
		t.Fatalf("host: %v", herr)
	}
	r.read(o)
	if !sawAbort {
		t.Fatal("the host never got the abort frame")
	}
	if after != 0 {
		t.Fatalf("%d file bytes followed the abort frame (%d before it)", after, before)
	}
}

// TestSendToCtrlCAfterTheOutcomePrintsNothing: once the drop has arrived, a
// Ctrl+C adds no line and no exit of its own; the command keeps its 0.
func TestSendToCtrlCAfterTheOutcomePrintsNothing(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
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
		if err := h.awaitEnd(); err != nil {
			return err
		}
		if err := h.dc.Send([]byte(`{"type":"received","verified":1}`)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	})
	c := newCtrlC(t)
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL)
	c.letGo(t)
	r.wait(t, 30*time.Second)
	c.press()
	select {
	case code := <-c.exits:
		t.Fatalf("exit %d from a Ctrl+C after the drop arrived", code)
	case <-time.After(300 * time.Millisecond):
	}
	if herr := h.wait(t); herr != nil {
		t.Fatalf("host: %v", herr)
	}
	r.read(o)
	if r.err != nil {
		t.Fatalf("the command returned %v after the drop arrived", r.err)
	}
	if got := pionLog.ReplaceAllString(r.stderr, ""); got != "" {
		t.Fatalf("stderr = %q, want nothing", got)
	}
	if !regexp.MustCompile(`(?m)^  1 file arrived \(4 KB in \d+s, direct\)\.$`).MatchString(r.stdout) {
		t.Fatalf("stdout lacks the arrived line:\n%s", r.stdout)
	}
}

// TestSendToCtrlCDuringSetupEndsAtOnce: Ctrl+C while the answer is still being
// set up prints TL-28 and exits 130 at once; the setup ending afterwards (the
// host leaves) adds nothing.
func TestSendToCtrlCDuringSetupEndsAtOnce(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
	startHost(t, s, silentHost)
	c := newCtrlC(t)
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL)
	c.letGo(t)
	select {
	case <-s.seated:
	case <-time.After(20 * time.Second):
		t.Fatal("the visitor was never seated")
	}
	time.Sleep(200 * time.Millisecond) // past the seat, into the setup wait
	pressed := time.Now()
	c.press()
	if code := c.exits.awaitExit(t, 5*time.Second, "Ctrl+C in setup"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	if took := time.Since(pressed); took > time.Second {
		t.Fatalf("Ctrl+C in setup took %v to exit", took)
	}
	s.drop(true) // the setup now fails on its own, which must print nothing
	select {
	case <-c.parked:
	case <-time.After(10 * time.Second):
		t.Fatal("the command never parked after its setup failed")
	}
	c.free()
	r.wait(t, 20*time.Second).read(o)
	wantOnlyLine(t, r, tl28Line)
	if strings.Contains(r.stdout, "Connected") {
		t.Fatalf("Connected printed after a Ctrl+C in setup:\n%s", r.stdout)
	}
}
