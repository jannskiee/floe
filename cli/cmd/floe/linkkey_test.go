package main

// The link key on the command line: the keyed links floe send prints, what
// --link-only asks of the receiver, floe receive checking the sender, floe send --to
// checking the host, and every place a pasted link used to be printed back. Each line
// the check ends on is pinned here by its literal, because it is approved copy.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/linkkey"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// The lines PLAN.md "New copy" names, byte for byte.
const (
	copySendUnverified    = "Couldn't confirm the person who opened your link. Nothing was sent. Make a new link and try again."
	copySendSilent        = "Couldn't confirm the receiver. They may need to run floe update, or open the link in a browser."
	copyReceiveUnverified = "Couldn't confirm who sent this link. Nothing was saved. Ask them for a new link."
	copyHostUnverified    = "Couldn't confirm their computer. Nothing was sent."
	copyAskLinkMaker      = "Ask the person who made this link for a new one."
)

// TestLinkKeyCopyIsTheApprovedCopy pins the frozen constants, and the engine
// sentence the refusal's first line reads.
func TestLinkKeyCopyIsTheApprovedCopy(t *testing.T) {
	if lineUnverified != copyHostUnverified || lineAskLinkMaker != copyAskLinkMaker {
		t.Fatalf("frozen lines: %q and %q", lineUnverified, lineAskLinkMaker)
	}
	if errSendUnverified.Error() != copySendUnverified || errSendSilent.Error() != copySendSilent || errReceiveUnverified.Error() != copyReceiveUnverified {
		t.Fatalf("plain lines: %q, %q, %q", errSendUnverified, errSendSilent, errReceiveUnverified)
	}
	if got := refusalLines(transfer.CodeUnverified, 0, 3); fmt.Sprint(got) != fmt.Sprint([]string{"Their computer couldn't confirm this link.", "Nothing was sent.", copyAskLinkMaker}) {
		t.Fatalf("TL-36 at 0 saved: %q", got)
	}
	if got := refusalLines(transfer.CodeUnverified, 2, 3); fmt.Sprint(got) != fmt.Sprint([]string{"Their computer couldn't confirm this link.", "2 of 3 files were saved.", copyAskLinkMaker}) {
		t.Fatalf("TL-36 at 2 saved: %q", got)
	}
}

// newTestKey is a key for a test that needs a real one.
func newTestKey(t *testing.T) linkkey.Key {
	t.Helper()
	key, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// wantNoKey fails if a run's output holds a key or a tag.
func wantNoKey(t *testing.T, what, printed string, key linkkey.Key) {
	t.Helper()
	if strings.Contains(printed, key.Encode()) {
		t.Fatalf("%s printed the key:\n%s", what, printed)
	}
}

var printedLink = regexp.MustCompile(`https?://\S+`)

// ── floe send ────────────────────────────────────────────────────────────────

// keyedReceiver is the far end of a plain send: the printed link is what it was
// given, and receive runs the engine's check with what that link says. The link is
// read off the send's stdout, so it proves what the command really prints.
func keyedReceiver(t *testing.T, url string, seated func() int, linkOf func() string, out string, override func(code.ResolvedLink) *transfer.KeyCheck) (result <-chan error) {
	t.Helper()
	res := make(chan error, 1)
	plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
		link, err := code.ResolveLink("", linkOf())
		if err != nil {
			res <- fmt.Errorf("the printed link does not resolve: %w", err)
			return
		}
		kc := &transfer.KeyCheck{Key: link.Key, RoomID: link.RoomID}
		if override != nil {
			kc = override(link)
		}
		res <- transfer.ReceiveFilesWithOptions(dc, out, true, "test", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			Messages:   early.Msgs,
			Closed:     early.Closed,
			KeyCheck:   kc,
		})
	})
	return res
}

// streamingOutput is captureOutput's pipes read as they fill, so a test can take the
// printed link while the command is still running. The result is the same text.
type streamingOutput struct {
	out    atomicBuffer
	err    atomicBuffer
	once   sync.Once
	finish func()
}

// text restores stdout and stderr and returns what was printed. Call it once every
// goroutine that prints has ended, as captureOutput's text.
func (s *streamingOutput) text() (stdout, stderr string) {
	s.once.Do(s.finish)
	return s.out.String(), s.err.String()
}

type atomicBuffer struct {
	v atomic.Pointer[string]
}

func (b *atomicBuffer) Write(p []byte) (int, error) {
	prev := ""
	if s := b.v.Load(); s != nil {
		prev = *s
	}
	next := prev + string(p)
	b.v.Store(&next)
	return len(p), nil
}

func (b *atomicBuffer) String() string {
	if s := b.v.Load(); s != nil {
		return *s
	}
	return ""
}

func captureStreaming(t *testing.T) *streamingOutput {
	t.Helper()
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	s := &streamingOutput{}
	origOut, origErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outW, errW
	drained := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(&s.out, outR); drained <- struct{}{} }()
	go func() { _, _ = io.Copy(&s.err, errR); drained <- struct{}{} }()
	s.finish = func() {
		os.Stdout, os.Stderr = origOut, origErr
		_ = outW.Close()
		_ = errW.Close()
		<-drained
		<-drained
		_ = outR.Close()
		_ = errR.Close()
	}
	t.Cleanup(func() { s.once.Do(s.finish) })
	return s
}

// linkFrom waits for the link row on stdout.
func (s *streamingOutput) linkFrom(t *testing.T) string {
	t.Helper()
	for wait := time.Now().Add(20 * time.Second); time.Now().Before(wait); time.Sleep(5 * time.Millisecond) {
		if m := printedLink.FindString(s.out.String()); m != "" {
			return m
		}
	}
	t.Error("no link printed within 20 s")
	return ""
}

// TestPlainSendPrintsAKeyedLinkAndDelivers: the link is <web>/#k=<key>&room=<room>,
// k first, with no nonce, the code still beside it; a receiver holding what that
// link says gets the file; and the key is on the one line that is the link.
func TestPlainSendPrintsAKeyedLinkAndDelivers(t *testing.T) {
	s := captureStreaming(t)
	url, seated := plainRoom(t)
	stubNetwork(t, url)
	out := t.TempDir()
	r := startCLI(t, sendFile(t), "--server", url, "--web", "https://files.example.com")
	received := keyedReceiver(t, url, seated, func() string { return s.linkFrom(t) }, out, nil)
	select {
	case err := <-received:
		if err != nil {
			t.Fatalf("receive: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the receive did not end")
	}
	r.wait(t, 30*time.Second)
	stdout, stderr := s.text()
	if r.err != nil {
		t.Fatalf("send: %v\n%s", r.err, stderr)
	}
	link := printedLink.FindString(stdout)
	if !regexp.MustCompile(`^https://files\.example\.com/#k=[A-Za-z0-9_-]{21}[AQgw]&room=[0-9a-f-]{36}$`).MatchString(link) {
		t.Fatalf("the link is %q", link)
	}
	if !strings.Contains(stdout, "olive-tiger-castle") {
		t.Fatalf("no code beside the link:\n%s", stdout)
	}
	parsed, err := code.ResolveLink("", link)
	if err != nil || !parsed.HasKey {
		t.Fatalf("the printed link: %v", err)
	}
	if n := strings.Count(stdout, parsed.Key.Encode()); n != 1 {
		t.Fatalf("the key is on %d places of stdout, want the one link:\n%s", n, stdout)
	}
	if strings.Contains(stderr, parsed.Key.Encode()) {
		t.Fatalf("the key reached stderr:\n%s", stderr)
	}
	if got, err := os.ReadFile(filepath.Join(out, "hello.txt")); err != nil || string(got) != "hello" {
		t.Fatalf("saved %q, %v", got, err)
	}
}

// A code receiver holds no key, so a detecting send goes on past its silence: the
// room code keeps working, and that is the documented gap.
func TestPlainSendReachesAReceiverWithNoKey(t *testing.T) {
	o := captureOutput(t)
	url, seated := plainRoom(t)
	stubNetwork(t, url)
	out := t.TempDir()
	r := startCLI(t, sendFile(t), "--server", url)
	received := keyedReceiver(t, url, seated, func() string { return "https://floe.one/#room=" + uuid.New().String() }, out,
		func(code.ResolvedLink) *transfer.KeyCheck { return nil })
	if err := <-received; err != nil {
		t.Fatalf("receive: %v", err)
	}
	r.wait(t, 30*time.Second).read(o)
	if r.err != nil {
		t.Fatalf("send: %v\n%s", r.err, r.stderr)
	}
	if got, err := os.ReadFile(filepath.Join(out, "hello.txt")); err != nil || string(got) != "hello" {
		t.Fatalf("saved %q, %v", got, err)
	}
}

// A receiver whose proof is wrong, for a detecting send, ends on the plain send's
// line, alone on the indent, with no file name and nothing saved.
func TestPlainSendBadProofEndsOnItsLine(t *testing.T) {
	s := captureStreaming(t)
	url, seated := plainRoom(t)
	stubNetwork(t, url)
	out := t.TempDir()
	r := startCLI(t, sendFile(t), "--server", url, "--web", "https://files.example.com")
	received := keyedReceiver(t, url, seated, func() string { return s.linkFrom(t) }, out,
		func(link code.ResolvedLink) *transfer.KeyCheck {
			return &transfer.KeyCheck{Key: newTestKey(t), RoomID: link.RoomID}
		})
	if err := <-received; !errors.Is(err, transfer.ErrSenderNotConfirmed) {
		t.Fatalf("receive: %v", err)
	}
	r.wait(t, 30*time.Second)
	_, stderr := s.text()
	var outcome outcomeError
	if !errors.As(r.err, &outcome) || r.err.Error() != copySendUnverified {
		t.Fatalf("send: %T %v", r.err, r.err)
	}
	if want := "  " + copySendUnverified + "\n"; !strings.HasSuffix(stderr, want) {
		t.Fatalf("stderr is %q, want it to end on %q", stderr, want)
	}
	if strings.Contains(stderr, "hello.txt") || strings.Contains(stderr, "Error:") {
		t.Fatalf("a wrap or a prefix reached the line: %q", stderr)
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatalf("the receiver's folder holds %d entries", len(entries))
	}
}

// plainSendEnd maps each typed ending to its line. ErrKeyCheckUnavailable has no line
// in the copy, so its fixed engine text stands.
func TestPlainSendEndMapsTheKeyCheck(t *testing.T) {
	for _, c := range []struct {
		in   error
		want string
	}{
		{transfer.ErrReceiverNotConfirmed, copySendUnverified},
		{&transfer.PeerStoppedError{Code: transfer.CodeUnverified}, copySendUnverified},
		{transfer.ErrReceiverSilent, copySendSilent},
	} {
		got := plainSendEnd(c.in)
		var outcome outcomeError
		if !errors.As(got, &outcome) || got.Error() != c.want {
			t.Errorf("%v became %T %v, want the outcome %q", c.in, got, got, c.want)
		}
	}
	if got := plainSendEnd(transfer.ErrKeyCheckUnavailable); got != transfer.ErrKeyCheckUnavailable {
		t.Errorf("ErrKeyCheckUnavailable became %v", got)
	}
}

// ── --link-only ──────────────────────────────────────────────────────────────

// --link-only registers no code, prints no Code row, waits for the receiver's proof
// before naming the file, and delivers to a receiver that holds the key.
func TestLinkOnlyRegistersNoCodeAndDelivers(t *testing.T) {
	s := captureStreaming(t)
	url, seated, _, codes, heard := plainRoomCounting(t)
	stubNetwork(t, url)
	out := t.TempDir()
	r := startCLI(t, sendFile(t), "--link-only", "--server", url, "--web", "https://files.example.com")
	received := keyedReceiver(t, url, seated, func() string { return s.linkFrom(t) }, out, nil)
	if err := <-received; err != nil {
		t.Fatalf("receive: %v", err)
	}
	r.wait(t, 30*time.Second)
	stdout, stderr := s.text()
	if r.err != nil {
		t.Fatalf("send: %v\n%s", r.err, stderr)
	}
	if strings.Contains(stdout, "Code ") || strings.Contains(stdout, "olive-tiger-castle") {
		t.Fatalf("a code row with --link-only:\n%s", stdout)
	}
	if strings.Contains(stderr+stdout, "could not generate short code") {
		t.Fatal("a warning about the code nobody asked for")
	}
	if n := codes(); n != 0 {
		t.Fatalf("%d requests reached the code API", n)
	}
	if got, err := os.ReadFile(filepath.Join(out, "hello.txt")); err != nil || string(got) != "hello" {
		t.Fatalf("saved %q, %v", got, err)
	}
	wantNotHeard(t, heard(), printedLink.FindString(stdout))
}

// wantNotHeard fails if the key of link reached the server, in any frame or request.
func wantNotHeard(t *testing.T, heard, link string) {
	t.Helper()
	parsed, err := code.ResolveLink("", link)
	if err != nil || !parsed.HasKey {
		t.Fatalf("the link: %v", err)
	}
	if !strings.Contains(heard, parsed.RoomID) {
		t.Fatalf("the server never heard the room, so this checks nothing:\n%s", heard)
	}
	if strings.Contains(heard, parsed.Key.Encode()) {
		t.Fatal("the key reached the server")
	}
}

// Without the flag the code is registered, once: the counter above is not asleep.
func TestPlainSendRegistersItsCode(t *testing.T) {
	s := captureStreaming(t)
	url, seated, _, codes, heard := plainRoomCounting(t)
	stubNetwork(t, url)
	out := t.TempDir()
	r := startCLI(t, sendFile(t), "--server", url, "--web", "https://files.example.com")
	received := keyedReceiver(t, url, seated, func() string { return s.linkFrom(t) }, out, nil)
	if err := <-received; err != nil {
		t.Fatalf("receive: %v", err)
	}
	r.wait(t, 30*time.Second)
	stdout, _ := s.text()
	if n := codes(); n != 1 {
		t.Fatalf("%d requests reached the code API, want 1", n)
	}
	wantNotHeard(t, heard(), printedLink.FindString(stdout))
}

// --link-only against a receiver with the wrong key: the plain send's line, and the
// file is named to nobody.
func TestLinkOnlyBadProofNamesNoFile(t *testing.T) {
	s := captureStreaming(t)
	url, seated := plainRoom(t)
	stubNetwork(t, url)
	out := t.TempDir()
	var metadata atomic.Int32
	r := startCLI(t, sendFile(t), "--link-only", "--server", url, "--web", "https://files.example.com")
	done := make(chan error, 1)
	plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
		link, err := code.ResolveLink("", s.linkFrom(t))
		if err != nil {
			done <- err
			return
		}
		proof, err := transfer.LinkKeyProof(dc, transfer.KeyCheck{Key: newTestKey(t), RoomID: link.RoomID}, false)
		if err != nil {
			done <- err
			return
		}
		if err := dc.Send(proof); err != nil {
			done <- err
			return
		}
		h := &heardFromSender{}
		for {
			select {
			case m := <-early.Msgs:
				if typ, _ := controlOf(m); typ == "metadata" {
					metadata.Add(1)
				} else if typ == "incompatible" {
					h.aborted = true
				}
				if h.aborted {
					done <- nil
					return
				}
			case <-early.Closed:
				done <- errors.New("the send closed with no abort")
				return
			case <-quit:
				return
			case <-time.After(20 * time.Second):
				done <- errors.New("no abort within 20 s")
				return
			}
		}
	})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	r.wait(t, 30*time.Second)
	_, stderr := s.text()
	if metadata.Load() != 0 {
		t.Fatal("a file was named before the proof")
	}
	if want := "  " + copySendUnverified + "\n"; !strings.HasSuffix(stderr, want) {
		t.Fatalf("stderr is %q, want it to end on %q", stderr, want)
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatalf("the folder holds %d entries", len(entries))
	}
}

// --link-only is the wait: while the receiver holds its proof back, nothing but the
// sender's own kc comes, and the file is named only once the proof is in.
func TestLinkOnlyNamesNoFileBeforeTheProof(t *testing.T) {
	s := captureStreaming(t)
	url, seated := plainRoom(t)
	stubNetwork(t, url)
	r := startCLI(t, sendFile(t), "--link-only", "--server", url, "--web", "https://files.example.com")
	done := make(chan error, 1)
	plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
		link, err := code.ResolveLink("", s.linkFrom(t))
		if err != nil {
			done <- err
			return
		}
		held := time.After(600 * time.Millisecond)
	holding:
		for {
			select {
			case m := <-early.Msgs:
				if typ, _ := controlOf(m); typ != "kc" {
					done <- fmt.Errorf("a %q frame came before the proof", typ)
					return
				}
			case <-held:
				break holding
			case <-quit:
				done <- errors.New("the test ended")
				return
			}
		}
		proof, err := transfer.LinkKeyProof(dc, transfer.KeyCheck{Key: link.Key, RoomID: link.RoomID}, false)
		if err != nil {
			done <- err
			return
		}
		if err := dc.Send(proof); err != nil {
			done <- err
			return
		}
		if _, ok := awaitFirstMetadata(early, quit); !ok {
			done <- errors.New("no metadata after the proof")
			return
		}
		// It named the file once the proof was in; the rest is not this test's.
		done <- dc.Send([]byte(`{"type":"incompatible","reason":"receiver declined the transfer","pv":2,"pvMin":1,"code":"declined","saved":0}`))
	})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	r.wait(t, 30*time.Second)
	if _, stderr := s.text(); !strings.Contains(stderr, "They declined.") {
		t.Fatalf("stderr: %q", stderr)
	}
}

// FLOE_LINK_ONLY is no setting: --link-only is a decision about one transfer.
func TestLinkOnlyHasNoEnvironmentTwin(t *testing.T) {
	src, err := os.ReadFile("send.go")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(src, []byte("FLOE_LINK_ONLY")) {
		t.Fatal("send.go reads FLOE_LINK_ONLY")
	}
	f := sendCmd.Flags().Lookup("link-only")
	if f == nil || f.DefValue != "false" {
		t.Fatalf("--link-only = %+v", f)
	}
	if strings.Contains(f.Usage, "[env:") {
		t.Fatalf("the help line names an environment variable: %q", f.Usage)
	}
	for _, c := range rootCmd.Commands() {
		if c != sendCmd && c.Flags().Lookup("link-only") != nil {
			t.Fatalf("%s has a --link-only flag", c.Name())
		}
	}
	if rootCmd.PersistentFlags().Lookup("link-only") != nil {
		t.Fatal("--link-only is on every command")
	}
}

// --link-only with --to is a usage error before any network, and it does not print
// the link. Neither order of the flags changes that.
func TestLinkOnlyIsExclusiveWithTo(t *testing.T) {
	room := uuid.New().String()
	key := newTestKey(t)
	link := "https://floe.one/r/Xk3p9Q0aB1c#" + room + "." + key.Encode()
	for name, args := range map[string][]string{
		"--to first":   {sendFile(t), "--to", link, "--link-only"},
		"--link first": {sendFile(t), "--link-only", "--to", link},
	} {
		t.Run(name, func(t *testing.T) {
			o := captureOutput(t)
			net := stubNetwork(t, "")
			r := runCLI(t, args...).read(o)
			if r.err == nil {
				t.Fatal("the command succeeded; want a usage error")
			}
			if !strings.Contains(r.stderr, "Error: if any flags in the group [to link-only] are set none of the others can be") {
				t.Fatalf("stderr: %q", r.stderr)
			}
			if net.ice.Load() != 0 || net.connect.Load() != 0 {
				t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
			}
			wantNoKey(t, "the usage error", r.stdout+r.stderr, key)
			if strings.Contains(r.stdout+r.stderr, room) {
				t.Fatalf("the usage error printed the room:\n%s", r.stderr)
			}
		})
	}
}

// The fifteen-second clock itself, against a real command: a receiver that shows no
// proof gets the abort, and the sender ends on the neutral line. Opt-in, since it
// holds a real timer (CLAUDE.md, FLOE_LONG_TESTS); the engine's own tests shrink it.
func TestLinkOnlySilentReceiverEndsOnTheNeutralLine(t *testing.T) {
	if os.Getenv("FLOE_LONG_TESTS") == "" {
		t.Skip("holds a real 15 s timer; set FLOE_LONG_TESTS to run it")
	}
	s := captureStreaming(t)
	url, seated := plainRoom(t)
	stubNetwork(t, url)
	out := t.TempDir()
	start := time.Now()
	r := startCLI(t, sendFile(t), "--link-only", "--server", url, "--web", "https://files.example.com")
	received := keyedReceiver(t, url, seated, func() string { return s.linkFrom(t) }, out,
		func(code.ResolvedLink) *transfer.KeyCheck { return nil })
	if err := <-received; !errors.Is(err, transfer.ErrSenderNotConfirmed) {
		t.Fatalf("receive: %v", err)
	}
	r.wait(t, 40*time.Second)
	if took := time.Since(start); took < transfer.KeyCheckWait {
		t.Fatalf("the send ended after %v, before its clock", took)
	}
	_, stderr := s.text()
	if want := "  " + copySendSilent + "\n"; !strings.HasSuffix(stderr, want) {
		t.Fatalf("stderr is %q, want it to end on %q", stderr, want)
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatalf("the receiver's folder holds %d entries", len(entries))
	}
}

// ── floe receive ─────────────────────────────────────────────────────────────

// keyedSender is the far end of a receive: seated first, it offers and sends with
// the engine, under kc.
func keyedSender(t *testing.T, url, room string, paths []string, kc *transfer.KeyCheck) (result <-chan error) {
	t.Helper()
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatalf("sender signaling connect: %v", err)
	}
	if err := sc.JoinRoom(room); err != nil {
		t.Fatalf("sender join: %v", err)
	}
	select {
	case <-sc.Role:
	case <-time.After(10 * time.Second):
		t.Fatal("the in-process sender was never seated")
	}
	res := make(chan error, 1)
	var conn atomic.Pointer[peer.Connection]
	go func() {
		select {
		case <-sc.PeerConnected:
		case <-time.After(30 * time.Second):
			res <- errors.New("no receiver came")
			return
		}
		c, err := peer.New(nil, sc)
		if err != nil {
			res <- err
			return
		}
		conn.Store(c)
		dc, err := c.SetupAsSender()
		if err != nil {
			res <- err
			return
		}
		early := c.Early()
		// NoSummary, because the command under test holds os.Stdout and puts it back
		// with nothing to order that against this goroutine's prints.
		err = transfer.SendFilesWithOptions(dc, paths, "dev", transfer.SendOptions{
			Messages:   early.Msgs,
			Closed:     early.Closed,
			OnProgress: func(transfer.Progress) {},
			NoSummary:  true,
			KeyCheck:   kc,
		})
		res <- err
		c.Close()
	}()
	t.Cleanup(func() {
		if c := conn.Load(); c != nil {
			c.Close()
		}
		sc.Close()
	})
	return res
}

// floe receive holds the key the link carries, and a sender holding it delivers. The
// room goes to the server and the key to nobody.
func TestReceiveKeyedLinkDelivers(t *testing.T) {
	url, _, _, _, heard := plainRoomCounting(t)
	room := uuid.New().String()
	key := newTestKey(t)
	src := sendFile(t)
	sent := keyedSender(t, url, room, []string{src}, &transfer.KeyCheck{Key: key, RoomID: room})
	out := t.TempDir()
	stdout, stderr, err := receiveInto(t, nil, out, url+"/#k="+key.Encode()+"&room="+room, "-y", "--server", url)
	if err != nil {
		t.Fatalf("receive: %v\n%s", err, stderr)
	}
	if err := <-sent; err != nil {
		t.Fatalf("send: %v", err)
	}
	wantNoKey(t, "floe receive", stdout+stderr, key)
	if got, err := os.ReadFile(filepath.Join(out, "hello.txt")); err != nil || string(got) != "hello" {
		t.Fatalf("saved %q, %v", got, err)
	}
	wantNotHeard(t, heard(), "https://floe.one/#k="+key.Encode()+"&room="+room)
}

// A sender that cannot prove it holds the key, whether it holds another key or none
// at all (a released sender), ends the receive on its line, as an outcome, with
// nothing saved.
func TestReceiveKeyedLinkRefusesAnUnprovenSender(t *testing.T) {
	for name, senderKC := range map[string]func(key linkkey.Key, room string) *transfer.KeyCheck{
		"another key": func(_ linkkey.Key, room string) *transfer.KeyCheck {
			return &transfer.KeyCheck{Key: newTestKey(t), RoomID: room}
		},
		"no key at all": func(linkkey.Key, string) *transfer.KeyCheck { return nil },
	} {
		t.Run(name, func(t *testing.T) {
			url, _ := plainRoom(t)
			room := uuid.New().String()
			key := newTestKey(t)
			sent := keyedSender(t, url, room, []string{sendFile(t)}, senderKC(key, room))
			out := t.TempDir()
			stdout, stderr, err := receiveInto(t, nil, out, url+"/#k="+key.Encode()+"&room="+room, "-y", "--server", url)
			var outcome outcomeError
			if !errors.As(err, &outcome) || !errors.Is(err, errReceiveUnverified) {
				t.Fatalf("execute returned %T %v, want the outcome\nstderr:\n%s", err, err, stderr)
			}
			if want := "  " + copyReceiveUnverified + "\n"; !strings.HasSuffix(stderr, want) {
				t.Fatalf("stderr is %q, want it to end on %q", stderr, want)
			}
			if strings.Contains(stderr, "Error:") {
				t.Fatalf("an outcome took cobra's prefix: %q", stderr)
			}
			wantNoKey(t, "floe receive", stdout+stderr, key)
			if strings.Contains(stdout, "hello.txt") || strings.Contains(stdout, "Incoming") {
				t.Fatalf("the sender's file was named or offered:\n%s", stdout)
			}
			entries, _ := os.ReadDir(out)
			if len(entries) != 0 {
				t.Fatalf("the output folder holds %d entries", len(entries))
			}
			select {
			case <-sent:
			case <-time.After(20 * time.Second):
				t.Fatal("the sender did not end after the refusal")
			}
		})
	}
}

// keyCarryingInputs is every way the plan and the code could think of to paste a
// link that holds key, whole or in part.
func keyCarryingInputs(key, room string) map[string]string {
	const id = "Xk3p9Q0aB1c"
	cut := key[:12]
	return map[string]string{
		"k alone":                                "https://floe.one/#k=" + key,
		"k cut short":                            "https://floe.one/#k=" + cut,
		"k and an empty room":                    "https://floe.one/#k=" + key + "&room=",
		"k and a cut room":                       "https://floe.one/#k=" + key + "&room=" + room[:13],
		"k with no slash":                        "https://floe.one#k=" + key,
		"k on a self-hosted link":                "https://files.example.com/#k=" + key,
		"k, no scheme":                           "floe.one/#k=" + key,
		"k, hash first":                          "#k=" + key,
		"k, angle brackets":                      "<https://floe.one/#k=" + key + ">",
		"k, quotes":                              `"https://floe.one/#k=` + key + `"`,
		"k with a bad escape":                    "https://floe.one/#k=" + key + "%zz",
		"k in the query":                         "https://floe.one/?k=" + key,
		"k in the query, second":                 "https://floe.one/?x=1&k=" + key,
		"k second in the fragment":               "https://floe.one/#x=1&k=" + key,
		"k behind a semicolon":                   "https://floe.one/#x=1;k=" + key,
		"k after a cut room":                     "https://floe.one/#room=" + room[:10] + "&k=" + key,
		"k in capitals":                          "https://floe.one/#K=" + key,
		"a mail client's &amp;":                  "https://floe.one/#k=" + key + "&amp;room=" + room,
		"the fragment percent-encoded":           "https://floe.one/#k%3D" + key + "%26room%3D" + room[:13],
		"a whole link percent-encoded":           "https%3A%2F%2Ffloe.one%2F%23k%3D" + key,
		"inside a mail-safety redirector":        "https://safelinks.example/?url=https%3A%2F%2Ffloe.one%2F%23k%3D" + key + "%26room%3D" + room + "&data=05",
		"a redirector inside a redirector":       "https://x.example/?u=https%3A%2F%2Fsafelinks.example%2F%3Furl%3Dhttps%253A%252F%252Ffloe.one%252F%2523k%253D" + key,
		"a host that cannot be read":             "https://[floe.one/#k=" + key,
		"a label in front":                       "Link: https://floe.one/#k=" + key,
		"a file URL":                             "file:///floe.one/#k=" + key,
		"k= alone":                               "k=" + key,
		"k= and an empty room":                   "k=" + key + "&room=",
		"k= with quotes":                         `"k=` + key + `"`,
		"a request link":                         "https://floe.one/r/" + id + "#" + room + "." + key,
		"a request link cut inside its key":      "https://floe.one/r/" + id + "#" + room + "." + cut,
		"a request link, no scheme":              "floe.one/r/" + id + "#" + room + "." + key,
		"a request link, percent-encoded #":      "https://floe.one/r/" + id + "%23" + room + "." + key,
		"a request link, a short id":             "https://floe.one/r/Xk3p9Q0aB#" + room + "." + key,
		"a request fragment on the home page":    "https://floe.one/#" + room + "." + key,
		"a request fragment alone":               "#" + room + "." + key,
		"a room and a key, no hash":              room + "." + key,
		"a fragment with no room behind its dot": "https://floe.one/#." + key,
		"a bad escape after a request fragment":  "https://floe.one/r/" + id + "#" + room + "." + key + "%zz",
	}
}

// TestReceiveNeverPrintsAKey is B9's property: no input that carries a key reaches
// "could not resolve %q", which quotes its input. The wrapper stays for everything
// else, because six docs pages and the released strings hold its words. The inputs
// run through the whole command against a stubbed network, each with a fresh key.
func TestReceiveNeverPrintsAKey(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	rounds := 8
	for round := 0; round < rounds; round++ {
		key := newTestKey(t).Encode()
		room := uuid.New().String()
		for name, input := range keyCarryingInputs(key, room) {
			calls := stubNetwork(t, "")
			hits.Store(0)
			stdout, stderr, err := receiveWith(t, nil, input, "--server", srv.URL)
			if err == nil {
				t.Fatalf("%s: the receive succeeded", name)
			}
			all := stdout + stderr
			if strings.Contains(all, "could not resolve") {
				t.Errorf("%s: the wrapper was reached:\n%s", name, all)
			}
			for _, part := range []string{key, key[:12]} {
				if strings.Contains(all, part) {
					t.Errorf("%s: %q was printed:\n%s", name, part, all)
				}
			}
			if strings.Contains(strings.ToLower(all), strings.ToLower(key[:12])) {
				t.Errorf("%s: the key was printed in another case:\n%s", name, all)
			}
			if n := hits.Load(); n != 0 {
				t.Errorf("%s: %d requests reached the code API", name, n)
			}
			if c := calls.connect.Load(); c != 0 {
				t.Errorf("%s: %d signaling connects", name, c)
			}
		}
	}
	// A key alone, where only its shape can say what it is. These hold what no
	// typed code does; TestResolveNeverLooksUpAKeyAlone has the plain-words edge.
	for _, input := range []string{"aBcDeFgHiJkLmNoPqRsTuA", "<aBcDeFgHiJkLmNoPqRsTuA>", "Ab_cDeFgHiJkLmNoPqRsTg"} {
		hits.Store(0)
		stubNetwork(t, "")
		stdout, stderr, err := receiveWith(t, nil, input, "--server", srv.URL)
		if err == nil {
			t.Fatalf("%q: the receive succeeded", input)
		}
		if want := "  " + lineIncompleteLink + "\n"; stderr != want || strings.Contains(stdout, input) {
			t.Errorf("%q: stdout %q, stderr %q, want %q", input, stdout, stderr, want)
		}
		if n := hits.Load(); n != 0 {
			t.Errorf("%q: %d requests reached the code API", input, n)
		}
	}
}

// A whole keyed link goes on to the network, and what fails there quotes nothing of
// it either. ICE is refused here, so this ends at the fetch.
func TestReceiveWholeKeyedLinkPrintsNoKeyOnAFailure(t *testing.T) {
	key := newTestKey(t).Encode()
	room := uuid.New().String()
	calls := stubNetwork(t, "")
	stdout, stderr, err := receiveWith(t, nil, "https://files.example.com/#k="+key+"&room="+room, "--server", closedServer)
	if err == nil {
		t.Fatal("the receive succeeded")
	}
	if calls.ice.Load() != 1 {
		t.Fatalf("ICE fetches %d, want 1", calls.ice.Load())
	}
	if strings.Contains(stdout+stderr, key) || strings.Contains(stdout+stderr, room) {
		t.Fatalf("a part of the link was printed:\n%s%s", stdout, stderr)
	}
}

// The host rule reads a keyed link as it does any other room link.
func TestReceiveKeyedLinkKeepsTheHostRule(t *testing.T) {
	key := newTestKey(t).Encode()
	room := uuid.New().String()
	calls := stubNetwork(t, "")
	_, stderr, err := receiveWith(t, nil, "https://floe.one/#k="+key+"&room="+room, "--server", closedServer)
	if !errors.Is(err, errFloeLinkOtherServer) || calls.ice.Load() != 0 {
		t.Fatalf("a floe.one link with another server: %v, %d ICE fetches\n%s", err, calls.ice.Load(), stderr)
	}
	stubNetwork(t, "")
	_, stderr, err = receiveWith(t, nil, "https://files.example.com/#k="+key+"&room="+room)
	if !errors.Is(err, errOtherLinkFloeServer) {
		t.Fatalf("another host with no server: %v\n%s", err, stderr)
	}
	if strings.Contains(stderr, key) {
		t.Fatalf("the key was printed: %q", stderr)
	}
}

// ── A link where it does not belong (B12, B16) ───────────────────────────────

// B12: a share link cut after its key has no room= to be known by. Every keyed shape
// is a room link now, and a file name with no such mark is not.
func TestLooksLikeRoomLinkKnowsTheKey(t *testing.T) {
	key := newTestKey(t).Encode()
	room := uuid.New().String()
	for name, input := range keyCarryingInputs(key, room) {
		if !looksLikeRoomLink(input) && !looksLikeRequestLink(input) {
			t.Errorf("%s: %q is neither a room link nor a request link", name, input)
		}
	}
	// A key cut short has no shape of its own, so only its marks can tell. A longer cut
	// would pass through HoldsLinkKey and prove nothing about them (review 19, L7).
	for _, s := range []string{
		"https://floe.one/#k=abc", "https://floe.one/?k=abc", "https://floe.one/?x=1&k=abc", "https://floe.one/#x=1;k=abc",
		"k=abc", `"k=abc"`, "https://floe.one/r/x#.abc", "#.abc",
	} {
		if !looksLikeRoomLink(s) {
			t.Errorf("looksLikeRoomLink(%q) = false", s)
		}
	}
	for _, s := range []string{
		"", "shoot", "notes.txt", "a&b.txt", "rock=1.txt", "park=1", "bk=1", "olive-tiger-castle",
		"olive-tiger-castle-dog", "https://floe.one/about", "https://floe.one/?kk=1", "https://floe.one/#blink=1",
	} {
		if looksLikeRoomLink(s) {
			t.Errorf("looksLikeRoomLink(%q) = true", s)
		}
	}
}

// B16: a share link typed where a path goes is never printed back. A plain send
// names floe receive, and floe send --to its one line for a link in that place. A
// missing path that is not shaped like a link keeps the stat sentence.
func TestShareLinkTypedAsAPathIsNeverPrintedBack(t *testing.T) {
	key := newTestKey(t).Encode()
	room := uuid.New().String()
	shapes := map[string]string{
		"keyed":             "https://floe.one/#k=" + key + "&room=" + room,
		"keyed, with nonce": "https://floe.one/?s=deadbeef#k=" + key + "&room=" + room,
		"cut after k":       "https://floe.one/#k=" + key,
		"no scheme":         "floe.one/#k=" + key + "&room=" + room,
		"keyless":           "https://floe.one/#room=" + room,
		"keyless query":     "https://floe.one/?room=" + room,
		"percent-encoded":   "https%3A%2F%2Ffloe.one%2F%23k%3D" + key + "%26room%3D" + room,
		"a key alone":       "aBcDeFgHiJkLmNoPqRsTuA",
	}
	wantClean := func(t *testing.T, r *cliRun) {
		t.Helper()
		all := r.stdout + r.stderr
		for _, leak := range []string{key, room, "aBcDeFgHiJ", "cannot read"} {
			if strings.Contains(all, leak) {
				t.Fatalf("%q was printed:\nstdout:\n%s\nstderr:\n%s", leak, r.stdout, r.stderr)
			}
		}
	}
	for name, link := range shapes {
		t.Run("plain send: "+name, func(t *testing.T) {
			o := captureOutput(t)
			net := stubNetwork(t, "")
			r := runCLI(t, sendFile(t), link, "--server", closedServer).read(o)
			wantClean(t, r)
			if r.err == nil {
				t.Fatal("the command succeeded; want exit 1")
			}
			if want := "  " + errRoomLinkTypedAsCommand.Error() + "\n"; r.stdout != "" || r.stderr != want {
				t.Fatalf("want the one line %q\nstdout:\n%q\nstderr:\n%q", want, r.stdout, r.stderr)
			}
			if net.ice.Load() != 0 || net.connect.Load() != 0 {
				t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
			}
		})
		t.Run("send --to: "+name, func(t *testing.T) {
			o := captureOutput(t)
			net := stubNetwork(t, "")
			r := runCLI(t, link, "--to", "https://floe.one/r/Xk3p9Q0aB1c#"+uuid.New().String()).read(o)
			wantClean(t, r)
			wantOutcome(t, r, lineIncompleteLink)
			if net.ice.Load() != 0 || net.connect.Load() != 0 {
				t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
			}
		})
	}
	t.Run("a missing path keeps its sentence", func(t *testing.T) {
		o := captureOutput(t)
		stubNetwork(t, "")
		missing := filepath.Join(t.TempDir(), "shoot.bin")
		r := runCLI(t, missing, "--server", closedServer).read(o)
		if r.err == nil || !strings.Contains(r.stderr, "Error: cannot read "+missing+": ") {
			t.Fatalf("a missing path no longer ends on its sentence (%v):\n%s", r.err, r.stderr)
		}
	})
}

// A wrong file name that is no link keeps its "cannot read" (review 19 L9, review 20
// finding 5). The whole key shape stays a link: a key pasted alone is what a double
// click in a terminal selects, and a file named exactly like one is rare enough.
func TestPathLooksLikeRoomLinkSparesFileNames(t *testing.T) {
	key := newTestKey(t).Encode()
	room := uuid.New().String()
	for _, name := range []string{
		"Learning C#.pdf", "notes#.txt", "report#.txt", "k=1.txt", "park=12345678.txt", "a&k=1.txt",
		"Screenshot_2026_1102_w.png", "Summer_Vacation_Pics_Q.zip", "shoot.bin", "a&b.txt",
	} {
		if pathLooksLikeRoomLink(name) {
			t.Errorf("pathLooksLikeRoomLink(%q) = true", name)
		}
	}
	for _, link := range []string{
		"https://floe.one/#k=" + key + "&room=" + room,
		"https://floe.one/#k=" + key,
		"https://floe.one/#k=" + key[:8],
		"https://floe.one/?k=" + key,
		"k=" + key,
		`"k=` + key + `"`,
		"https://floe.one/#." + key,
		"https://floe.one/#room=" + room,
		"https%3A%2F%2Ffloe.one%2F%23k%3D" + key,
		"aBcDeFgHiJkLmNoPqRsTuA",
		`"aBcDeFgHiJkLmNoPqRsTuA"`,
	} {
		if !pathLooksLikeRoomLink(link) {
			t.Errorf("pathLooksLikeRoomLink(%q) = false", link)
		}
	}
	missing := filepath.Join(t.TempDir(), "Learning C#.pdf")
	t.Run("plain send", func(t *testing.T) {
		o := captureOutput(t)
		stubNetwork(t, "")
		r := runCLI(t, missing, "--server", closedServer).read(o)
		if r.err == nil || !strings.Contains(r.stderr, "Error: cannot read "+missing+": ") {
			t.Fatalf("a missing path no longer ends on its sentence (%v):\n%s", r.err, r.stderr)
		}
	})
	t.Run("send --to", func(t *testing.T) {
		o := captureOutput(t)
		stubNetwork(t, "")
		r := runCLI(t, missing, "--to", "https://floe.one/r/Xk3p9Q0aB1c#"+room).read(o)
		if r.err == nil || !strings.Contains(r.stderr, "cannot read "+missing+": ") {
			t.Fatalf("a missing path no longer ends on its sentence (%v):\n%s", r.err, r.stderr)
		}
	})
}

// pflag quotes the argument it could not read, and a link holds a room id and a key
// (review 19, L6). A flag error with no link in it is as it was.
func TestFlagErrorsNeverPrintALink(t *testing.T) {
	key := newTestKey(t)
	room := uuid.New().String()
	link := "https://floe.one/#k=" + key.Encode() + "&room=" + room
	for name, args := range map[string][]string{
		"--link-only=<link>":  {sendFile(t), "--link-only=" + link},
		"--relay-only=<link>": {sendFile(t), "--relay-only=" + link},
		"a request link":      {sendFile(t), "--link-only=https://floe.one/r/Xk3p9Q0aB1c#" + room + "." + key.Encode()},
	} {
		t.Run(name, func(t *testing.T) {
			o := captureOutput(t)
			net := stubNetwork(t, "")
			r := runCLI(t, args...).read(o)
			if r.err == nil {
				t.Fatal("the command succeeded; want the fixed line")
			}
			wantNoKey(t, "the flag error", r.stdout+r.stderr, key)
			if strings.Contains(r.stdout+r.stderr, room) {
				t.Fatalf("the flag error printed the room:\n%s", r.stderr)
			}
			if net.ice.Load() != 0 || net.connect.Load() != 0 {
				t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
			}
		})
	}
	// -<link> reads as -h and fails on the next letter, in pflag's words. Asked here and
	// not through the tree, where the -h it read would stay set for every later test.
	t.Run("a link read as short flags", func(t *testing.T) {
		err := flagErrorWithoutLink(nil, fmt.Errorf("unknown shorthand flag: 't' in -%s", link))
		var outcome outcomeError
		if !errors.As(err, &outcome) {
			t.Fatalf("err = %T, want the fixed line", err)
		}
		wantNoKey(t, "the flag error", err.Error(), key)
		if strings.Contains(err.Error(), room) {
			t.Fatalf("the flag error printed the room: %s", err)
		}
	})
	t.Run("no link keeps its words", func(t *testing.T) {
		o := captureOutput(t)
		stubNetwork(t, "")
		r := runCLI(t, sendFile(t), "--link-only=maybe").read(o)
		if r.err == nil || !strings.Contains(r.stderr, `invalid argument "maybe"`) {
			t.Fatalf("a flag error with no link changed (%v):\n%s", r.err, r.stderr)
		}
	})
}

// A keyed link typed as the command, or after help, ends on the fixed line too.
func TestKeyedLinkTypedAsTheCommandIsNeverPrintedBack(t *testing.T) {
	const line = "That looks like a link to receive from. To receive, use: floe receive <link>"
	key := newTestKey(t).Encode()
	room := uuid.New().String()
	for name, args := range map[string][]string{
		"whole":       {"https://floe.one/#k=" + key + "&room=" + room},
		"cut after k": {"https://floe.one/#k=" + key},
		"after help":  {"help", "https://floe.one/#k=" + key + "&room=" + room},
	} {
		t.Run(name, func(t *testing.T) {
			stdout, stderr, err := runArgsAll(t, args...)
			if strings.Contains(stdout+stderr, key) {
				t.Fatalf("the key was printed:\nstdout:\n%s\nstderr:\n%s", stdout, stderr)
			}
			if err == nil || stderr != "  "+line+"\n" {
				t.Fatalf("err %v, stderr %q", err, stderr)
			}
		})
	}
	// A keyed request link keeps its own line.
	stdout, stderr, err := runArgsAll(t, "https://floe.one/r/Xk3p9Q0aB1c#"+room+"."+key)
	if strings.Contains(stdout+stderr, key) || err == nil || stderr != "  "+errLinkTypedAsPath.Error()+"\n" {
		t.Fatalf("a keyed request link as the command: %v\nstdout:\n%s\nstderr:\n%s", err, stdout, stderr)
	}
}

// ── floe send --to ───────────────────────────────────────────────────────────

// keyedLink is a request link on a self-hosted server for a fresh room, with its key.
func keyedLink(t *testing.T) (link string, kc *transfer.KeyCheck) {
	t.Helper()
	room := uuid.New().String()
	key := newTestKey(t)
	return "https://files.example.com/floe/r/Xk3p9Q0aB1c#" + room + "." + key.Encode(), &transfer.KeyCheck{Key: key, RoomID: room}
}

// provenRefusalAtMetadata is refuseAtMetadata for a keyed link: the host's honest
// proof, then the refusal once the visitor names its file.
func provenRefusalAtMetadata(kc *transfer.KeyCheck, frame string) func(*testHost) error {
	return func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		proof, err := transfer.LinkKeyProof(h.dc, *kc, false)
		if err != nil {
			return err
		}
		if err := h.dc.Send(proof); err != nil {
			return err
		}
		if _, err := h.awaitMetadata(); err != nil {
			return err
		}
		if err := h.dc.Send([]byte(frame)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	}
}

// keyedHost is deliveringHost holding the key: a real engine receive under kc.
func keyedHost(out string, kc *transfer.KeyCheck, decided *atomic.Int32) func(*testHost) error {
	return func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		return transfer.ReceiveFilesWithOptions(h.dc, out, false, "desktop-test", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			Decide: func(transfer.IncomingInfo) transfer.Decision {
				decided.Add(1)
				return transfer.Decision{Kind: transfer.DecisionAccept}
			},
			Messages: h.early.Msgs,
			Closed:   h.early.Closed,
			KeyCheck: kc,
		})
	}
}

// The link decides: a keyed link checks the host, and WAIT prints once it has passed.
func TestSendToKeyedLinkDelivers(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	link, kc := keyedLink(t)
	out := t.TempDir()
	var decided atomic.Int32
	h := startHost(t, s, keyedHost(out, kc, &decided))
	r := runCLI(t, p, "--to", link, "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	if r.err != nil {
		t.Fatalf("send: %v\n%s", r.err, r.stderr)
	}
	wantInOrder(t, r.stdout, tlJoining, tlConnecting, tlWaiting)
	if strings.Count(r.stdout, tlWaiting) != 1 {
		t.Fatalf("WAIT printed %d times:\n%s", strings.Count(r.stdout, tlWaiting), r.stdout)
	}
	if decided.Load() != 1 {
		t.Fatalf("the host decided %d times", decided.Load())
	}
	wantNoKey(t, "floe send --to", r.stdout+r.stderr, kc.Key)
	if _, err := os.Stat(filepath.Join(out, "a.bin")); err != nil {
		t.Fatalf("the file did not arrive: %v", err)
	}
	s.mu.Lock()
	heard := s.heard.String()
	s.mu.Unlock()
	if !strings.Contains(heard, kc.RoomID) || strings.Contains(heard, kc.Key.Encode()) {
		t.Fatalf("the server heard the room %v and the key %v, want only the room", strings.Contains(heard, kc.RoomID), strings.Contains(heard, kc.Key.Encode()))
	}
}

// A host that cannot show the proof, whether it holds another key or answers wrongly,
// is never told a file's name: TL-35, no WAIT line, and nothing on the host's disk.
func TestSendToKeyedLinkRefusesABadHost(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "secret-name.bin", 4096)
	link, kc := keyedLink(t)
	out := t.TempDir()
	var decided atomic.Int32
	other := &transfer.KeyCheck{Key: newTestKey(t), RoomID: kc.RoomID}
	var hostErr error
	h := startHost(t, s, func(h *testHost) error {
		hostErr = keyedHost(out, other, &decided)(h)
		return nil
	})
	r := runCLI(t, p, "--to", link, "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantOutcome(t, r, copyHostUnverified)
	if strings.Contains(r.stdout, tlWaiting) {
		t.Fatalf("WAIT printed for a host that failed the check:\n%s", r.stdout)
	}
	if !errors.Is(hostErr, transfer.ErrSenderNotConfirmed) {
		t.Fatalf("the host's receive: %v", hostErr)
	}
	if decided.Load() != 0 {
		t.Fatal("the host was asked about a visitor that failed the check")
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatalf("the host's folder holds %d entries", len(entries))
	}
	wantNoKey(t, "floe send --to", r.stdout+r.stderr, kc.Key)
}

// floe send --to is the wait too: nothing but the kc comes while the host holds its
// proof back, and no WAIT line until the proof is in.
func TestSendToKeyedLinkNamesNoFileBeforeTheProof(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	link, kc := keyedLink(t)
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		held := time.After(600 * time.Millisecond)
	holding:
		for {
			select {
			case m := <-h.early.Msgs:
				if typ, _ := controlOf(m); typ != "kc" {
					return fmt.Errorf("a %q frame came before the proof", typ)
				}
			case <-held:
				break holding
			case <-h.quit:
				return errors.New("the test ended")
			}
		}
		proof, err := transfer.LinkKeyProof(h.dc, *kc, false)
		if err != nil {
			return err
		}
		if err := h.dc.Send(proof); err != nil {
			return err
		}
		if _, err := h.awaitMetadata(); err != nil {
			return err
		}
		if err := h.dc.Send([]byte(`{"type":"incompatible","reason":"receiver declined the transfer","pv":2,"pvMin":1,"code":"declined","saved":0}`)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	})
	r := runCLI(t, p, "--to", link, "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantOutcome(t, r, "They declined. Nothing was sent.")
	wantInOrder(t, r.stdout, tlConnecting, tlWaiting)
}

// A host that proves itself and then refuses this visitor's proof is TL-36's three
// lines, in that order, with WAIT printed first because the host had passed.
func TestSendToKeyedHostRefusesTheVisitor(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	link, kc := keyedLink(t)
	h := startHost(t, s, provenRefusalAtMetadata(kc, `{"type":"incompatible","reason":"receiver could not confirm the sender holds this link","pv":2,"pvMin":2,"code":"unverified","saved":0}`))
	r := runCLI(t, p, "--to", link, "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantOutcome(t, r, "Their computer couldn't confirm this link.", "Nothing was sent.", copyAskLinkMaker)
	wantInOrder(t, r.stdout, tlWaiting)
}

// A visitor whose link was cut before its key holds nothing to check with. A keyed
// host refuses it, and the fix is the whole link, so it gets TL-09 and no new line.
func TestSendToBareLinkRefusedAsUnverifiedIsAnIncompleteLink(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	_, kc := keyedLink(t)
	out := t.TempDir()
	var decided atomic.Int32
	var hostErr error
	h := startHost(t, s, func(h *testHost) error {
		hostErr = keyedHost(out, kc, &decided)(h)
		return nil
	})
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantOutcome(t, r, lineIncompleteLink)
	if !errors.Is(hostErr, transfer.ErrSenderNotConfirmed) || decided.Load() != 0 {
		t.Fatalf("the host's receive: %v, decided %d", hostErr, decided.Load())
	}
}

// A bare link is as today: no key, no wait, and WAIT before the send starts.
func TestSendToBareLinkHasNoWait(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	out := t.TempDir()
	var doneFiles []transfer.FileDone
	var mu sync.Mutex
	h := startHost(t, s, deliveringHost(out, &doneFiles, &mu))
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	if r.err != nil {
		t.Fatalf("send: %v\n%s", r.err, r.stderr)
	}
	wantInOrder(t, r.stdout, tlConnecting, tlWaiting)
}

// DV5 on the request link: the relay abort that goes out before the send tells an
// unconfirmed host nothing about the drop's size.
func TestSendToKeyedRelayAbortCarriesNoSize(t *testing.T) {
	for name, keyed := range map[string]bool{"keyed": true, "bare": false} {
		t.Run(name, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "seat")
			stubNetwork(t, s.URL)
			prev := relayGateFor
			t.Cleanup(func() { relayGateFor = prev })
			blocked := fmt.Errorf("transfer blocked: %w (selected 3 GB)", transfer.ErrRelayOverLimit)
			relayGateFor = func(*webrtc.DataChannel, int64) error { return blocked }
			p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
			link := linkFor()
			if keyed {
				link, _ = keyedLink(t)
			}
			var first webrtc.DataChannelMessage
			h := startHost(t, s, func(h *testHost) error {
				if err := h.offer(); err != nil {
					return err
				}
				m, err := h.frame(20 * time.Second)
				if err != nil {
					return err
				}
				first = m
				h.holdOpen()
				return nil
			})
			r := runCLI(t, p, "--to", link, "--server", s.URL)
			herr := h.wait(t)
			r.read(o)
			if herr != nil {
				t.Fatalf("host: %v", herr)
			}
			if !errors.Is(r.err, transfer.ErrRelayOverLimit) || !strings.Contains(r.stderr, "(selected 3 GB)") {
				t.Fatalf("the visitor's own line lost its numbers: %v\n%s", r.err, r.stderr)
			}
			var f struct {
				Type   string `json:"type"`
				Reason string `json:"reason"`
			}
			if !first.IsString || json.Unmarshal(first.Data, &f) != nil || f.Type != "incompatible" {
				t.Fatalf("the host's first frame was %q", first.Data)
			}
			want := blocked.Error()
			if keyed {
				want = transfer.ErrRelayOverLimit.Error()
			}
			if f.Reason != want {
				t.Fatalf("the abort's reason is %q, want %q", f.Reason, want)
			}
		})
	}
}

// The outcomes the check ends on, by errors.Is alone and ahead of the acked==0 cases.
func TestSendToOutcomeMapsTheKeyCheck(t *testing.T) {
	for _, err := range []error{transfer.ErrReceiverNotConfirmed, transfer.ErrReceiverSilent, transfer.ErrKeyCheckUnavailable} {
		for _, acked := range []int{0, 1} {
			lines, keep := sendToOutcome(err, 3, acked)
			if keep != nil || len(lines) != 1 || lines[0] != copyHostUnverified {
				t.Errorf("%v at acked %d: %q, %v", err, acked, lines, keep)
			}
		}
	}
	lines, keep := sendToOutcome(&transfer.PeerStoppedError{Code: transfer.CodeUnverified, Saved: 0}, 3, 0)
	if keep != nil || fmt.Sprint(lines) != fmt.Sprint([]string{"Their computer couldn't confirm this link.", "Nothing was sent.", copyAskLinkMaker}) {
		t.Errorf("a refusal: %q, %v", lines, keep)
	}
}

// The silent host's fifteen seconds, against the whole command. Opt-in, as above.
func TestSendToKeyedSilentHostEndsOnTL35(t *testing.T) {
	if os.Getenv("FLOE_LONG_TESTS") == "" {
		t.Skip("holds a real 15 s timer; set FLOE_LONG_TESTS to run it")
	}
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	link, kc := keyedLink(t)
	var abortFrame string
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		for {
			m, err := h.frame(30 * time.Second)
			if err != nil {
				return err
			}
			if typ, _ := controlOf(m); typ == "metadata" {
				return errors.New("the visitor named a file to a silent host")
			} else if typ == "incompatible" {
				abortFrame = string(m.Data)
				h.holdOpen()
				return nil
			}
		}
	})
	start := time.Now()
	r := runCLI(t, p, "--to", link, "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	if took := time.Since(start); took < transfer.KeyCheckWait {
		t.Fatalf("the send ended after %v", took)
	}
	wantOutcome(t, r, copyHostUnverified)
	if strings.Contains(r.stdout, tlWaiting) {
		t.Fatalf("WAIT printed for a silent host:\n%s", r.stdout)
	}
	if !strings.Contains(abortFrame, `"code":"unverified"`) || !strings.Contains(abortFrame, `"pv":2,"pvMin":2`) {
		t.Fatalf("the abort is %s", abortFrame)
	}
	wantNoKey(t, "floe send --to", r.stdout+r.stderr, kc.Key)
}
