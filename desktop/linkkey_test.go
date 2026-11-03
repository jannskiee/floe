package main

// The link key on Floe Desktop: a Send's link and its detecting check, a code
// Receive that holds a link's key, and the request lane, whose host holds the key
// of every link it makes. The engine's own check has its tests in cli/engine/transfer;
// these prove the desktop hands it the right key and does the right thing with
// how it ends. Everything runs over real pion on this machine, through the fake
// signaling server of requestlink_test.go.
//
// Failure messages here never print a link, a key or a proof.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/linkkey"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

// otherKey is a key no link in the test holds.
func otherKey(t *testing.T) linkkey.Key {
	t.Helper()
	k, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// ---- The request lane -----------------------------------------------------

// ownUnverified is the frame an enforcing visitor stops with when the host's proof
// fails or never comes: TEXT, code unverified, and the range only a side that speaks
// kc overlaps.
const ownUnverified = `{"type":"incompatible","reason":"sender could not confirm the receiver holds this link","pv":2,"pvMin":2,"ver":"visitor","code":"unverified"}`

// laneUnverified reads the link's count of failed pairings.
func laneUnverified(a *App) int {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.unverified
}

// setLaneUnverified puts the count where a test wants to start from.
func setLaneUnverified(a *App, n int) {
	l := a.lane()
	l.mu.Lock()
	l.unverified = n
	l.mu.Unlock()
}

// assertNoDrop is what every hostile pairing must have left: no prompt or receiving
// state in any snapshot, nothing under the save base, and nothing that asks for the
// owner's attention. att may be nil.
func assertNoDrop(t *testing.T, rec *snapRecorder, att *attentionRec, base string) {
	t.Helper()
	for _, snap := range rec.all() {
		if snap.State == "deciding" || snap.State == "receiving" || snap.Prompt != nil || snap.PromptGen != 0 || snap.Result != nil {
			t.Fatalf("an unverified visitor reached the owner: state %q, prompt %+v, result %+v", snap.State, snap.Prompt, snap.Result)
		}
	}
	if got := treeUnder(t, base); len(got) != 0 {
		t.Fatalf("an unverified visitor left %q under the save base", got)
	}
	if att != nil {
		titles, flashes, toasts := att.snapshot()
		if len(titles) != 0 || len(flashes) != 0 || len(toasts) != 0 {
			t.Fatalf("an unverified pairing asked for attention: title %q, flash %v, toast %q", titles, flashes, toasts)
		}
	}
	for _, js := range rec.allRaw() {
		for _, words := range []string{"receive stopped", "could not be confirmed", "certificates"} {
			if strings.Contains(js, words) {
				t.Fatalf("a lane event carries the engine's words %q", words)
			}
		}
	}
}

// The ways a visitor can fail the check, each sent right after the channel opens.
var unverifiedVisitors = []struct {
	name    string
	proves  visitorProof
	act     func(v *testVisitor) error
	refused bool // the host stops it with its own frame; else the visitor stopped first
}{
	{"a proof under another key", proofBad, nil, true},
	{"a proof that is no tag", proofNone, func(v *testVisitor) error { return v.sendText(`{"type":"kc","tag":"not-a-tag"}`) }, true},
	{"a kc with no tag", proofNone, func(v *testVisitor) error { return v.sendText(`{"type":"kc"}`) }, true},
	{"metadata with no proof", proofNone, func(v *testVisitor) error { return v.sendText(metaFrame(1, 1, "a.txt", 4, 4)) }, true},
	{"binary first", proofNone, func(v *testVisitor) error { return v.sendBin([]byte("file bytes")) }, true},
	{"an over-cap string first", proofNone, func(v *testVisitor) error { return v.sendText(strings.Repeat("x", 2*controlFrameMax)) }, true},
	{"the visitor's own unverified", proofNone, func(v *testVisitor) error { return v.sendText(ownUnverified) }, false},
	{"the visitor's own unverified after a good proof", proofHonest, func(v *testVisitor) error { return v.sendText(ownUnverified) }, false},
}

// TestUnverifiedVisitorsEndWaiting (D9): each way of failing the check ends with the
// link waiting and code unverified, the room reopened, one failure counted, nothing
// on disk, and no prompt, toast, flash or title. The engine gates the visitor before
// Decide can run, so the owner never hears of it beyond W15.
func TestUnverifiedVisitorsEndWaiting(t *testing.T) {
	for _, c := range unverifiedVisitors {
		t.Run(c.name, func(t *testing.T) {
			var att *attentionRec
			a, rec, f, room, base := dropApp(t, func(a *App) { att = watchAttention(a, nil) })
			v := joinVisitor(t, f, room)
			v.proves = c.proves
			v.connect(t)
			if c.act != nil {
				if err := c.act(v); err != nil {
					t.Fatalf("the visitor's frame: %v", err)
				}
			}
			s := waitSnap(t, a, 15*time.Second, "waiting", "unverified")
			if s.Link == "" {
				t.Fatal("the link was forgotten by a pairing that did not end it")
			}
			waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
			if n := laneUnverified(a); n != 1 {
				t.Fatalf("%d failures counted, want 1", n)
			}
			if c.refused {
				stop := v.frameOfType(t, "incompatible", 5*time.Second)
				if stop["code"] != string(transfer.CodeUnverified) || stop["saved"] != float64(0) {
					t.Fatalf("the host's stop reads code %v, saved %v", stop["code"], stop["saved"])
				}
			}
			assertNoDrop(t, rec, att, base)
		})
	}
}

// TestUnverifiedVisitorsOnAnAutoAcceptLink: Auto-accept takes a drop with no prompt,
// so it is the one place a gate behind the prompt would let a stranger's files in.
// The check comes before Decide on this link too: nothing is made, and TO4 stays
// quiet.
func TestUnverifiedVisitorsOnAnAutoAcceptLink(t *testing.T) {
	for _, c := range []struct {
		name   string
		proves visitorProof
	}{
		{"metadata with no proof", proofNone},
		{"metadata behind a proof under another key", proofBad},
	} {
		t.Run(c.name, func(t *testing.T) {
			var att *attentionRec
			a, rec, f, room, base := dropAppWith(t, true, func(a *App) {
				roomyVolume().install(t)
				att = watchAttention(a, nil)
			})
			v := joinVisitor(t, f, room)
			v.proves = c.proves
			v.connect(t)
			if err := v.sendText(metaFrame(1, 1, "a.txt", 4, 4)); err != nil {
				t.Fatalf("the visitor's frame: %v", err)
			}
			waitSnap(t, a, 15*time.Second, "waiting", "unverified")
			assertNoDrop(t, rec, att, base)
		})
	}
}

// TestEnforcingVisitorHoldingAnotherKey is the real engine on both ends with two keys:
// the visitor names no file, the host counts a failure.
func TestEnforcingVisitorHoldingAnotherKey(t *testing.T) {
	a, rec, f, room, base := dropApp(t, nil)
	paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.bin": randomBytes(t, 4<<10)})
	v := joinVisitor(t, f, room)
	v.proves = proofNone
	v.connect(t)
	err := v.sendFiles(paths, transfer.SendOptions{
		KeyCheck: &transfer.KeyCheck{Key: otherKey(t), RoomID: room.RoomID, Enforce: true},
	})
	if !errors.Is(err, transfer.ErrReceiverNotConfirmed) {
		t.Fatalf("the visitor's send ended in %v, want the host's proof refused", err)
	}
	waitSnap(t, a, 15*time.Second, "waiting", "unverified")
	assertNoDrop(t, rec, nil, base)
}

// TestEnforcingVisitorHoldingTheKey is the same with the link's own key: the host
// proves the key first, the visitor's OnKeyVerified fires, and the drop arrives whole.
func TestEnforcingVisitorHoldingTheKey(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	data := randomBytes(t, 64<<10)
	paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.bin": data})
	v := joinVisitor(t, f, room)
	v.proves = proofNone
	v.connect(t)
	verified := 0
	sent := make(chan error, 1)
	go func() {
		sent <- v.sendFiles(paths, transfer.SendOptions{
			AckTimeout:      time.Minute,
			RequireReceived: true,
			KeyCheck:        &transfer.KeyCheck{Key: room.Key, RoomID: room.RoomID, Enforce: true},
			OnKeyVerified:   func() { verified++ },
		})
	}()
	acceptNext(t, a)
	select {
	case err := <-sent:
		if err != nil {
			t.Fatalf("the visitor's send: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the send did not finish")
	}
	if verified != 1 {
		t.Fatalf("OnKeyVerified fired %d times, want 1", verified)
	}
	v.leave()
	s := waitState(t, a, 15*time.Second, "done")
	if s.Result == nil || s.Result.Saved != 1 || s.Result.Verified != 1 {
		t.Fatalf("result %+v", s.Result)
	}
	got, err := os.ReadFile(filepath.Join(s.Result.Folder, "a.bin"))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("the file did not arrive intact: %v", err)
	}
	if n := laneUnverified(a); n != 0 {
		t.Fatalf("an honest drop counted %d failures", n)
	}
}

// TestHostProofLeads: the host's first frame on the channel is a kc, BINARY, as a file
// receiver's frames are, sent before the visitor has said anything. That it is the
// link's own proof is TestEnforcingVisitorHoldingTheKey's half: only an honest one gets
// that visitor past its wait.
func TestHostProofLeads(t *testing.T) {
	_, _, f, room, _ := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	v.proves = proofNone
	v.connect(t)
	data, isString := v.frame(t, 10*time.Second)
	if isString {
		t.Fatal("the host's proof went out as TEXT; a receiver's frames are BINARY")
	}
	var m map[string]any
	if json.Unmarshal(data, &m) != nil || m["type"] != "kc" {
		t.Fatal("the host's first frame is not a kc")
	}
	if tag, _ := m["tag"].(string); len(tag) != 43 || len(m) != 2 {
		t.Fatal("the host's kc is not a type and a 43-character tag")
	}
}

// TestHonestVisitorAfterAnUnverifiedPairing: a failed pairing costs the link nothing
// but one of its five: the key is still held, and the next visitor who holds the whole
// link reaches the prompt, with W15's code gone.
func TestHonestVisitorAfterAnUnverifiedPairing(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	bad := joinVisitor(t, f, room)
	bad.proves = proofBad
	bad.connect(t)
	waitSnap(t, a, 15*time.Second, "waiting", "unverified")
	waitFor(t, 5*time.Second, "the room to reopen", f.roomOpen)

	v := joinVisitor(t, f, room)
	v.connect(t)
	if err := v.sendText(metaFrame(1, 1, "a.txt", 4, 4)); err != nil {
		t.Fatalf("the visitor's frame: %v", err)
	}
	s := deciding(t, a)
	if s.Code != "" {
		t.Fatalf("the prompt carries code %q", s.Code)
	}
	if n := laneUnverified(a); n != 1 {
		t.Fatalf("%d failures counted, want the 1", n)
	}
	a.AnswerRequest(s.PromptGen, "decline")
	waitState(t, a, 5*time.Second, "declined")
}

// failPairing seats one visitor that fails the check and waits for the room to be
// free for the next.
func failPairing(t *testing.T, a *App, f *fakeSignalServer, room *transfer.KeyCheck) {
	t.Helper()
	v := joinVisitor(t, f, room)
	v.proves = proofBad
	v.connect(t)
	// The channel is open, so this pairing has cleared the last one's code.
	waitFor(t, 15*time.Second, "the pairing's end", func() bool {
		s := stateOf(a)
		return s.Code == "unverified" && (s.State == "waiting" || s.State == "ended")
	})
	if stateOf(a).State == "waiting" {
		waitFor(t, 5*time.Second, "the room to reopen", f.roomOpen)
	}
	v.conn.Close()
	v.sc.Close()
}

// TestFifthUnverifiedPairingEndsTheLink (D9, X7): a hostile server is not bound by its
// own seating budget, so the host stops at requestUnverifiedCap. The first four
// pairings each reopen, the fifth reopens and then closes, because closing a sealed room
// leaves a used marker and the next visitor would read that a link nobody used has been
// used (reviews 25 F2, 26 F2). Nothing else about it reaches the owner.
func TestFifthUnverifiedPairingEndsTheLink(t *testing.T) {
	var att *attentionRec
	a, rec, f, room, base := dropApp(t, func(a *App) { att = watchAttention(a, nil) })
	for i := 1; i < requestUnverifiedCap; i++ {
		failPairing(t, a, f, room)
		waitFor(t, 10*time.Second, "the failure to count", func() bool { return laneUnverified(a) == i })
		waitFor(t, 5*time.Second, "the reopen", func() bool { return f.count("request-reopen") == i })
		waitSnap(t, a, 5*time.Second, "waiting", "unverified")
		waitFor(t, 5*time.Second, "the room to reopen", f.roomOpen)
		if n := f.count("request-close"); n != 0 {
			t.Fatalf("request-close after %d failures", i)
		}
	}
	failPairing(t, a, f, room)
	s := waitSnap(t, a, 10*time.Second, "ended", "unverified")
	if s.Link != "" || s.Route != "" {
		t.Fatalf("the ended link kept its link (%v) or its last visitor's route %q", s.Link != "", s.Route)
	}
	waitFor(t, 5*time.Second, "request-close", func() bool { return f.count("request-close") == 1 })
	if n := f.count("request-reopen"); n != requestUnverifiedCap {
		t.Fatalf("%d reopens, want %d: the last pairing unseals the room before it closes it", n, requestUnverifiedCap)
	}
	_, _, sc := laneHandles(a)
	if sc != nil {
		t.Fatal("the lane kept the socket of a link that ended")
	}
	waitFor(t, 5*time.Second, "the host's socket to close", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.host == nil
	})
	assertNoDrop(t, rec, att, base)
	if st := stateOf(a); st.State != "ended" || st.Code != "unverified" {
		t.Fatalf("the link moved on to %s %q", st.State, st.Code)
	}
}

// TestMakeLinkResetsTheUnverifiedCount: the count is the link's own. Make link starts
// from none, beside the E-40 counts, so a new link gets all five.
func TestMakeLinkResetsTheUnverifiedCount(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	setLaneUnverified(a, requestUnverifiedCap-1)
	a.CloseRequestLink()
	waitState(t, a, 5*time.Second, "ended")
	if laneUnverified(a) != requestUnverifiedCap-1 {
		t.Fatal("closing the link should leave the count for Make link to clear")
	}
	a.MakeRequestLink("again", t.TempDir(), "24h", false)
	s := waitState(t, a, 10*time.Second, "waiting")
	if n := laneUnverified(a); n != 0 {
		t.Fatalf("a new link starts from %d failures", n)
	}
	next := linkRoom(t, s.Link)
	if next.RoomID == room.RoomID || next.Key == room.Key {
		t.Fatal("Make link reused the old link's room or key")
	}
	failPairing(t, a, f, next)
	if st := waitSnap(t, a, 5*time.Second, "waiting", "unverified"); st.Link == "" {
		t.Fatal("the new link ended on its first failure")
	}
}

// TestReconnectKeepsTheUnverifiedCount: a server that drops the host's socket does not
// get five more tries, and the link keeps its key across the re-join.
func TestReconnectKeepsTheUnverifiedCount(t *testing.T) {
	a, _, f, room, _ := dropApp(t, func(a *App) {
		l := a.lane()
		l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	})
	setLaneUnverified(a, requestUnverifiedCap-1)
	f.dropAll()
	waitFor(t, 5*time.Second, "the re-join", func() bool { return len(f.tokenJoins()) == 2 })
	waitState(t, a, 5*time.Second, "waiting")
	if n := laneUnverified(a); n != requestUnverifiedCap-1 {
		t.Fatalf("the re-join left the count at %d", n)
	}
	failPairing(t, a, f, room)
	waitSnap(t, a, 10*time.Second, "ended", "unverified")
}

// TestReconnectKeepsTheUnverifiedLine: W15 is all the owner hears of a failed check, so a
// socket drop must not wipe it with no new event (review 26 F3).
func TestReconnectKeepsTheUnverifiedLine(t *testing.T) {
	a, _, f, room, _ := dropApp(t, func(a *App) {
		l := a.lane()
		l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	})
	failPairing(t, a, f, room)
	waitSnap(t, a, 10*time.Second, "waiting", "unverified")
	joins := len(f.tokenJoins())
	f.dropAll()
	waitFor(t, 5*time.Second, "the re-join", func() bool { return len(f.tokenJoins()) == joins+1 })
	waitSnap(t, a, 5*time.Second, "waiting", "unverified")
}

// Every other line goes at a reconnect, as it always has: the wait comes back plain. It
// starts from a line of its own, or a reconnect that kept every line would pass here.
func TestReconnectLeavesAPlainWaitPlain(t *testing.T) {
	a, _, f, _, _ := dropApp(t, func(a *App) {
		l := a.lane()
		l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	})
	l := a.lane()
	l.mu.Lock()
	l.setStateLocked("waiting", "visitor-left")
	l.mu.Unlock()
	joins := len(f.tokenJoins())
	f.dropAll()
	waitFor(t, 5*time.Second, "the re-join", func() bool { return len(f.tokenJoins()) == joins+1 })
	waitSnap(t, a, 5*time.Second, "waiting", "")
}

// TestFailedPairingRereadsTheCloseSuggestion: W13 outranks W15, but only while it is still
// true. Two prompts that ended hours ago must not hide W15 behind "2 requests ended
// without Accept in 10 minutes" (review 26 F3). Two recent ones still do.
func TestFailedPairingRereadsTheCloseSuggestion(t *testing.T) {
	for _, c := range []struct {
		name string
		age  time.Duration
		want bool
	}{
		{"ended hours ago", 3 * time.Hour, false},
		{"ended a moment ago", time.Second, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			a, _, f, room, _ := dropApp(t, nil)
			l := a.lane()
			l.mu.Lock()
			at := l.now().Add(-c.age)
			l.promptEnds = []time.Time{at, at}
			l.suggestClose = true
			l.mu.Unlock()
			failPairing(t, a, f, room)
			s := waitSnap(t, a, 10*time.Second, "waiting", "unverified")
			if s.SuggestClose != c.want {
				t.Fatalf("suggestClose = %v, want %v", s.SuggestClose, c.want)
			}
		})
	}
}

// TestAcceptedDropKeepsItsBranch: a visitor that proved the key and was accepted, then
// sends unverified, stops an accepted drop as any other sender's stop does: the count
// stays where it was, and the code is the sender's stop, never W15.
func TestAcceptedDropKeepsItsBranch(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	v.connect(t)
	if err := v.sendText(metaFrame(1, 1, "a.txt", 1<<20, 1<<20)); err != nil {
		t.Fatalf("the visitor's frame: %v", err)
	}
	acceptNext(t, a)
	v.frameOfType(t, "ack", 10*time.Second)
	if err := v.sendText(ownUnverified); err != nil {
		t.Fatalf("the visitor's frame: %v", err)
	}
	waitSnap(t, a, 15*time.Second, "stopped", "peer-abort")
	if n := laneUnverified(a); n != 0 {
		t.Fatalf("an accepted drop counted %d failures", n)
	}
	if n := f.count("request-reopen"); n != 0 {
		t.Fatalf("%d reopens after an accepted drop", n)
	}
}

// TestStopBeforeProofIsNotAFailedCheck: a visitor that stops in its own words before
// any proof, or with another code, told the host nothing about the key: it left, as
// before the key, and uses up none of the five.
func TestStopBeforeProofIsNotAFailedCheck(t *testing.T) {
	for _, frame := range []string{
		`{"type":"incompatible","reason":"a stranger's words","pv":2,"pvMin":1}`,
		`{"type":"incompatible","reason":"a stranger's words","pv":2,"pvMin":1,"code":"stopped"}`,
	} {
		a, rec, f, room, base := dropApp(t, nil)
		v := joinVisitor(t, f, room)
		v.proves = proofNone
		v.connect(t)
		if err := v.sendText(frame); err != nil {
			t.Fatalf("the visitor's frame: %v", err)
		}
		waitSnap(t, a, 15*time.Second, "waiting", "visitor-left")
		if n := laneUnverified(a); n != 0 {
			t.Fatalf("a plain stop counted %d failures", n)
		}
		assertNoDrop(t, rec, nil, base)
	}
}

// TestEndRequestDropKeyCheckComesFirst: the two key-check cases stand ahead of every
// case that would read the same ending another way (a stop the visitor framed, a closed
// channel, this side's refusal, the E-35 timer), and an unreadable certificate counts
// no failure, because it says nothing about the visitor.
func TestEndRequestDropKeyCheckComesFirst(t *testing.T) {
	closed := make(chan struct{})
	close(closed)
	notConfirmed := &transfer.RefusedError{Code: transfer.CodeUnverified, Err: transfer.ErrSenderNotConfirmed}
	for _, c := range []struct {
		name     string
		err      error
		setup    func(d *requestDrop)
		wantCode string
		counted  int
	}{
		{"this side's refusal", notConfirmed, nil, "unverified", 1},
		{"the sender's own stop", transfer.ErrSenderNotConfirmed, func(d *requestDrop) { d.peerAbort.Store(true) }, "unverified", 1},
		{"with the channel closed", notConfirmed, func(d *requestDrop) { d.closed = closed }, "unverified", 1},
		{"with the E-35 timer fired", notConfirmed, func(d *requestDrop) { d.openExpired.Store(true) }, "unverified", 1},
		{"an unreadable certificate", transfer.ErrKeyCheckUnavailable, nil, "setup-failed", 0},
		{"an unreadable certificate, wrapped", fmt.Errorf("receive: %w", transfer.ErrKeyCheckUnavailable), nil, "setup-failed", 0},
		{"an unreadable certificate, with the channel closed", transfer.ErrKeyCheckUnavailable, func(d *requestDrop) { d.closed = closed }, "setup-failed", 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeSignalServer(t)
			a, _ := laneApp(t, f)
			s := makeWaiting(t, a)
			_, _, sc := laneHandles(a)
			d := &requestDrop{closed: make(chan struct{})}
			if c.setup != nil {
				c.setup(d)
			}
			if err := a.endRequestDrop(s.Gen, sc, d, c.err); !errors.Is(err, c.err) {
				t.Fatalf("endRequestDrop returned %v", err)
			}
			now := stateOf(a)
			if now.State != "waiting" || now.Code != c.wantCode {
				t.Fatalf("the link is %s %q, want waiting %q", now.State, now.Code, c.wantCode)
			}
			if n := laneUnverified(a); n != c.counted {
				t.Fatalf("%d failures counted, want %d", n, c.counted)
			}
			waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") == 1 })
		})
	}
}

// TestPairingWithoutAKeyNeverRuns: the check is only as good as the key the pairing
// carries, and a nil one in the options is a keyless receive, which takes anyone. A
// lane with no key offers to nobody: no ICE fetch, no offer, no state change.
func TestPairingWithoutAKeyNeverRuns(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	s := makeWaiting(t, a)
	_, _, sc := laneHandles(a)
	l := a.lane()
	l.mu.Lock()
	l.kc = nil
	l.mu.Unlock()
	a.pairRequest(s.Gen, sc)
	f.mu.Lock()
	hits, signals := f.turnHits, f.hostSignals
	f.mu.Unlock()
	if hits != 0 || signals != 0 {
		t.Fatalf("a pairing with no key fetched ICE %d times and signaled %d times", hits, signals)
	}
	if st := stateOf(a); st.State != "waiting" {
		t.Fatalf("a pairing with no key moved the lane to %s", st.State)
	}
}

// TestLaneHoldsTheKeyBesideItsLink: kc and link are set together and forgotten
// together, the room id is the one the link and the join name, and a printed pairing
// shows neither the key's text nor its bytes.
func TestLaneHoldsTheKeyBesideItsLink(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	s := makeWaiting(t, a)
	room := linkRoom(t, s.Link)
	l := a.lane()
	read := func() (*transfer.KeyCheck, string) {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.kc, l.link
	}
	kc, link := read()
	if kc == nil || link != s.Link {
		t.Fatal("the lane does not hold the key beside its link")
	}
	if kc.Key != room.Key || kc.RoomID != room.RoomID || kc.Enforce {
		t.Fatal("the lane's key check is not the link's, or enforces what only a sender can")
	}
	if joined := f.tokenJoins()[0].roomID; kc.RoomID != joined {
		t.Fatal("the key check's room is not the room the host joined")
	}

	p, ok := a.requestPairingFor(s.Gen)
	if !ok || p.kc != kc {
		t.Fatal("the pairing does not carry the lane's key check")
	}
	printed := fmt.Sprintf("%v %+v %#v", p, p, p)
	if strings.Contains(printed, room.Key.Encode()) || strings.Contains(printed, fmt.Sprint(room.Key[:])) || strings.Contains(printed, strings.Trim(fmt.Sprint(room.Key[:]), "[]")) {
		t.Fatal("a printed pairing shows the key")
	}

	a.CloseRequestLink()
	waitState(t, a, 5*time.Second, "ended")
	if kc, link := read(); kc != nil || link != "" {
		t.Fatal("an ended link kept its key or its link")
	}
}

// TestLinkKeyReachesNoServer: the fragment is the only place the key travels. Over a
// make, a re-join, a whole keyed drop and a close, no HTTP request and no socket frame
// from either end holds it, while the room id, which does reach the server, shows the
// scan can see.
func TestLinkKeyReachesNoServer(t *testing.T) {
	a, _, f, room, _ := dropApp(t, func(a *App) {
		l := a.lane()
		l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	})
	f.dropAll()
	waitFor(t, 5*time.Second, "the re-join", func() bool { return len(f.tokenJoins()) == 2 })
	waitState(t, a, 5*time.Second, "waiting")
	paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.bin": randomBytes(t, 8<<10)})
	v := joinVisitor(t, f, room)
	v.proves = proofNone
	v.connect(t)
	sent := make(chan error, 1)
	go func() {
		sent <- v.sendFiles(paths, transfer.SendOptions{
			AckTimeout: time.Minute,
			KeyCheck:   &transfer.KeyCheck{Key: room.Key, RoomID: room.RoomID, Enforce: true},
		})
	}()
	acceptNext(t, a)
	if err := <-sent; err != nil {
		t.Fatalf("the visitor's send: %v", err)
	}
	v.leave()
	waitState(t, a, 15*time.Second, "done")
	a.CloseRequestLink()
	if !f.wireHolds(room.RoomID) {
		t.Fatal("the scan saw nothing: the room id goes to the server by design")
	}
	if f.wireHolds(room.Key.Encode()) {
		t.Fatal("the link key reached the server")
	}
}

// TestUnverifiedCapMatchesTheCopy: X7 says the number out loud, and frozen copy cannot
// follow a constant, so a change to either has to change the other.
func TestUnverifiedCapMatchesTheCopy(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("frontend", "src", "requestCopy.ts"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`Link closed after (\d+) senders couldn't be confirmed`).FindSubmatch(src)
	if m == nil {
		t.Fatal("requestCopy.ts has no X7 line")
	}
	if got, _ := strconv.Atoi(string(m[1])); got != requestUnverifiedCap {
		t.Fatalf("X7 says %d, requestUnverifiedCap is %d", got, requestUnverifiedCap)
	}
}

// ---- Send and code Receive --------------------------------------------------

// transferEvents records what a Send or a code Receive told the frontend, in place of
// the Wails runtime, which only a running app has.
type transferEvents struct {
	mu  sync.Mutex
	got map[string][]any
}

func (r *transferEvents) emit(event string, payload any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.got == nil {
		r.got = map[string][]any{}
	}
	r.got[event] = append(r.got[event], payload)
}

func (r *transferEvents) of(event string) []any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]any(nil), r.got[event]...)
}

// wait waits for the first event of a name and returns its payload, failing at once
// when the attempt ends in send:error instead (its text is fixed engine copy or the
// status line's words).
func (r *transferEvents) wait(t *testing.T, d time.Duration, event string) any {
	t.Helper()
	var payload any
	waitFor(t, d, "event "+event, func() bool {
		if errs := r.of("send:error"); len(errs) > 0 && event != "send:error" {
			t.Fatalf("waiting for %s: send:error %v", event, errs[0])
		}
		got := r.of(event)
		if len(got) == 0 {
			return false
		}
		payload = got[0]
		return true
	})
	return payload
}

// roomFake is a fake signaling server that seats an ordinary room.
func roomFake(t *testing.T) *fakeSignalServer {
	t.Helper()
	f := newFakeSignalServer(t)
	f.set(func(f *fakeSignalServer) { f.rooms = true })
	return f
}

// transferApp is a bare App for one Send or code Receive on f.
//
// The t.TempDir() first, as in laneApp: a test's TempDirs share one removal, registered
// at the first call, so it runs after this cleanup, with no transfer still holding a
// file in one.
func transferApp(t *testing.T, f *fakeSignalServer) (*App, *transferEvents) {
	t.Helper()
	t.TempDir()
	rec := &transferEvents{}
	a := &App{
		notifyFn:       func(string, string) {},
		wake:           &wakeGuard{onBlock: func() {}, onAllow: func() {}},
		cfg:            appConfig{Server: f.url()},
		transferEmitFn: rec.emit,
	}
	t.Cleanup(func() {
		a.CancelTransfer()
		deadline := time.Now().Add(15 * time.Second)
		for slotOf(a).busy && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
	})
	return a, rec
}

// startSend starts a's Send of one file and returns the file's bytes, the link and the
// code it shared.
func startSend(t *testing.T, a *App, rec *transferEvents) (data []byte, link, phrase string) {
	t.Helper()
	data = randomBytes(t, 64<<10)
	paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.bin": data})
	if err := a.StartSend(paths, false); err != nil {
		t.Fatalf("StartSend: %v", err)
	}
	shared, ok := rec.wait(t, 15*time.Second, "send:code").(map[string]string)
	if !ok {
		t.Fatal("send:code carries no code and link")
	}
	return data, shared["link"], shared["code"]
}

// TestSendLinkReachesAReceiveHoldingIt: the link Send shares carries a key, and a
// receive of that link requires it, so this only arrives when Send proves the same key
// the link holds. The key goes nowhere else: not to /api/code, not in any frame.
func TestSendLinkReachesAReceiveHoldingIt(t *testing.T) {
	f := roomFake(t)
	sender, sent := transferApp(t, f)
	data, link, phrase := startSend(t, sender, sent)
	if phrase != fakeCode {
		t.Fatalf("Send shared code %q", phrase)
	}
	resolved, err := code.ResolveLink(f.url(), link)
	if err != nil {
		t.Fatalf("the engine cannot read Send's link: %v", err)
	}
	if !resolved.HasKey {
		t.Fatal("Send's link carries no key")
	}
	receiver, _ := transferApp(t, f)
	out := t.TempDir()
	dir, err := receiver.ReceiveByCode(link, out, false, false)
	if err != nil {
		t.Fatalf("the receive of Send's own link: %v", err)
	}
	sent.wait(t, 15*time.Second, "send:done")
	got, err := os.ReadFile(filepath.Join(dir, "a.bin"))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("the file did not arrive intact: %v", err)
	}
	if !f.wireHolds(resolved.RoomID) {
		t.Fatal("the scan saw nothing: the room id goes to the server by design")
	}
	if f.wireHolds(resolved.Key.Encode()) {
		t.Fatal("the link key reached the server")
	}
}

// TestSendThroughACodeArrives: a code holds no key, so the receive of one is keyless
// and Send, which only detects, goes on without a proof (O4, DV1). A receive that made
// up a key for a code would refuse here.
func TestSendThroughACodeArrives(t *testing.T) {
	f := roomFake(t)
	sender, sent := transferApp(t, f)
	data, _, phrase := startSend(t, sender, sent)
	receiver, _ := transferApp(t, f)
	dir, err := receiver.ReceiveByCode(phrase, t.TempDir(), false, false)
	if err != nil {
		t.Fatalf("the receive of a code: %v", err)
	}
	sent.wait(t, 15*time.Second, "send:done")
	got, err := os.ReadFile(filepath.Join(dir, "a.bin"))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("the file did not arrive intact: %v", err)
	}
}

// TestSendStopsOnAWrongProof: a receiver whose proof is wrong gets the stop and no file
// byte, whichever of Send's two looks sees the proof, and Send says what errors.ts maps.
func TestSendStopsOnAWrongProof(t *testing.T) {
	f := roomFake(t)
	sender, sent := transferApp(t, f)
	_, link, _ := startSend(t, sender, sent)
	resolved, err := code.ResolveLink(f.url(), link)
	if err != nil {
		t.Fatal(err)
	}
	sc, err := signaling.Connect(f.url())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sc.Close)
	if err := sc.JoinRoom(resolved.RoomID); err != nil {
		t.Fatal(err)
	}
	v := &testVisitor{sc: sc, proves: proofNone}
	v.connect(t)
	proof, err := v.proofOf(transfer.KeyCheck{Key: otherKey(t), RoomID: resolved.RoomID}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.sendBin(proof); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		data, isString := v.frame(t, time.Until(deadline))
		if !isString {
			t.Fatal("a file byte reached a receiver whose proof was wrong")
		}
		var m map[string]any
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m["type"] == "metadata" {
			ack, _ := json.Marshal(map[string]any{"type": "ack", "id": m["id"], "offset": 0, "pv": 2, "pvMin": 1})
			if err := v.sendBin(ack); err != nil {
				t.Fatal(err)
			}
		}
		if m["type"] == "incompatible" {
			if m["code"] != string(transfer.CodeUnverified) || m["pv"] != float64(2) || m["pvMin"] != float64(2) {
				t.Fatalf("the stop reads code %v, range %v to %v", m["code"], m["pvMin"], m["pv"])
			}
			break
		}
	}
	got := sent.wait(t, 10*time.Second, "send:error")
	if got != "transfer failed: "+transfer.ErrReceiverNotConfirmed.Error() {
		t.Fatalf("send:error %v", got)
	}
	if len(sent.of("send:done")) != 0 {
		t.Fatal("Send reported a finished send")
	}
}

// TestReceiveOfATamperedLinkStops: both ends are real, and the receive holds a key Send
// never made. It saves nothing and says RX-11's engine text. Send ends on one of the
// two sentences errors.ts gives the same line, or, if the close beat the receiver's stop
// frame, on the close's own, and never reports a finished send.
func TestReceiveOfATamperedLinkStops(t *testing.T) {
	f := roomFake(t)
	sender, sent := transferApp(t, f)
	_, link, _ := startSend(t, sender, sent)
	resolved, err := code.ResolveLink(f.url(), link)
	if err != nil {
		t.Fatal(err)
	}
	receiver, got := transferApp(t, f)
	out := t.TempDir()
	tampered := shareLink(f.url(), "deadbeef", resolved.RoomID, otherKey(t))
	_, err = receiver.ReceiveByCode(tampered, out, false, false)
	if err == nil || err.Error() != "transfer failed: "+transfer.ErrSenderNotConfirmed.Error() {
		t.Fatalf("the receive ended in %v", err)
	}
	if tree := treeUnder(t, out); len(tree) != 0 {
		t.Fatalf("a refused sender left %q", tree)
	}
	if n := len(got.of("recv:incoming")); n != 0 {
		t.Fatalf("the sender's metadata reached the frontend %d times", n)
	}
	end := sent.wait(t, 15*time.Second, "send:error")
	switch end {
	case (&transfer.PeerStoppedError{Code: transfer.CodeUnverified}).Error(),
		"transfer failed: " + transfer.ErrReceiverNotConfirmed.Error(),
		"transfer failed: connection closed while waiting for the receiver (transfer declined or receiver exited)":
	default:
		t.Fatalf("send:error %v", end)
	}
	if len(sent.of("send:done")) != 0 {
		t.Fatal("Send reported a finished send")
	}
}

// rawSender holds the first seat of an ordinary room and writes its own frames.
type rawSender struct {
	sc       *signaling.Client
	conn     *peer.Connection
	sendText func(string) error
}

func newRawSender(t *testing.T, f *fakeSignalServer, room string) *rawSender {
	t.Helper()
	sc, err := signaling.Connect(f.url())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sc.Close)
	if err := sc.JoinRoom(room); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sc.Role:
	case <-time.After(5 * time.Second):
		t.Fatal("no role")
	}
	return &rawSender{sc: sc}
}

// open waits for the receiver and sets up the channel.
func (s *rawSender) open(t *testing.T) error {
	select {
	case <-s.sc.PeerConnected:
	case <-time.After(15 * time.Second):
		return errors.New("no receiver joined")
	}
	conn, err := peer.New(nil, s.sc)
	if err != nil {
		return err
	}
	t.Cleanup(conn.Close)
	s.conn = conn
	dc, err := conn.SetupAsSender()
	if err != nil {
		return err
	}
	s.sendText = dc.SendText
	return nil
}

// TestReceiveHoldingAKeyRequiresTheSendersProof: a sender with no proof gets no answer
// about its file, and a stop in its own words before any proof reaches this side in
// fixed words, none of them the sender's.
func TestReceiveHoldingAKeyRequiresTheSendersProof(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	for _, c := range []struct {
		name, frame, want string
	}{
		{"metadata with no proof", metaFrame(1, 1, "a.txt", 4, 4), "transfer failed: " + transfer.ErrSenderNotConfirmed.Error()},
		{"a malformed proof", `{"type":"kc","tag":"not-a-tag"}`, "transfer failed: " + transfer.ErrSenderNotConfirmed.Error()},
		{"the sender's own unverified", ownUnverified, "transfer failed: " + transfer.ErrSenderNotConfirmed.Error()},
		{"a stop in its own words", `{"type":"incompatible","reason":"visit example.invalid","pv":2,"pvMin":1}`, "transfer failed: the sender stopped the transfer"},
		// Floe's own lines for a range miss, with none of the sender's text in them
		// (review 25 F1). The hint is this app's, not floe update.
		{"a range miss with its own version", `{"type":"incompatible","reason":"visit example.invalid","pv":9,"pvMin":9,"ver":"update at evil.example/floe"}`,
			"transfer failed: Cannot transfer: your floe is too old for this peer.\n  You: protocol 1-2 (dev)  Peer: protocol 9\n  " + desktopUpdateHint},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := roomFake(t)
			s := newRawSender(t, f, room)
			receiver, got := transferApp(t, f)
			out := t.TempDir()
			link := shareLink(f.url(), "deadbeef", room, otherKey(t))
			ended := make(chan error, 1)
			go func() {
				_, err := receiver.ReceiveByCode(link, out, false, false)
				ended <- err
			}()
			if err := s.open(t); err != nil {
				t.Fatalf("the sender's setup: %v", err)
			}
			if err := s.sendText(c.frame); err != nil {
				t.Fatalf("the sender's frame: %v", err)
			}
			select {
			case err := <-ended:
				if err == nil || err.Error() != c.want {
					t.Fatalf("the receive ended in %v, want %q", err, c.want)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("the receive did not end")
			}
			if tree := treeUnder(t, out); len(tree) != 0 {
				t.Fatalf("a refused sender left %q", tree)
			}
			if n := len(got.of("recv:incoming")); n != 0 {
				t.Fatalf("the sender's metadata reached the frontend %d times", n)
			}
		})
	}
}

// TestReceiveByCodeNeverQuotesThePaste (B9): the wrapper around a failed resolve used
// to print the paste back, and a keyed link holds its key. Each of these fails inside
// the resolve, makes no request, and comes back with neither the key nor the room id,
// behind the wrapper errors.ts matches.
func TestReceiveByCodeNeverQuotesThePaste(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	key := otherKey(t).Encode()
	// A fixed key for the bare rows: one drawn at random has no underscore and no capital
	// inside a word about once in 25,000 runs, and then it is shaped like a code.
	const bare = "Ab_cDeFgHiJkLmNoPqRsTg"
	server, hits := codeAPIStub(t)
	for _, paste := range []string{
		"https://floe.one/#k=" + key,
		"https://floe.one/?s=abc#k=" + key,
		"floe.one/#k=" + key,
		"https://floe.one/#k=" + key + "&room=6f1c2b9e-4a5d",
		"https://floe.one/#room=" + room + "&k=" + key + "&k=" + key,
		"https://floe.one/#k=" + key + "x&room=" + room,
		"https://floe.one/#K=" + key + "&room=" + room,
		"https://floe.one/?k=" + key + "&room=" + room,
		"https://floe.one/?x=" + key,
		"https://floe.one/%zz#k=" + key + "&room=" + room,
		bare,
		"<" + bare + ">",
	} {
		a := &App{wake: &wakeGuard{}, notifyFn: func(string, string) {}, cfg: appConfig{Server: server}}
		_, err := a.ReceiveByCode(paste, t.TempDir(), false, false)
		if err == nil {
			t.Fatal("a paste that cannot resolve was received")
		}
		if strings.Contains(err.Error(), key) || strings.Contains(err.Error(), bare) || strings.Contains(err.Error(), room) {
			t.Fatal("the error quotes the paste")
		}
		if !strings.HasPrefix(err.Error(), "could not resolve: ") {
			t.Fatalf("the error is %q, without the wrapper errors.ts matches", err.Error())
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the pastes made %d requests to the server, want 0", n)
	}
}
