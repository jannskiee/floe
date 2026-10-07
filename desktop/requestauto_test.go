package main

// Auto-accept, per request link (D-173, from D-135 D8 and D-137): the owner's
// switch is carried from Make link to the pairing and no further, and it is
// never a setting; the Decide path takes a drop without asking only when
// nothing about it is unusual (G4 to G6, G11, G13), and otherwise asks exactly
// as before. Every test here runs on a bare App with its seams set; none binds
// a port or reaches a server (the pion loopback tests are in transfer_test.go).

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// autoLaneApp is a bare App whose probe answers unreachable at once, so a
// Make link ends in error without asking any server and the next Make link is
// allowed. Cleanup closes the link and waits out the lane goroutine.
func autoLaneApp(t *testing.T) *App {
	t.Helper()
	a := &App{notifyFn: func(string, string) {}, wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}}
	a.cfg = appConfig{Server: "http://127.0.0.1:9"}
	l := a.lane()
	l.emitFn = func(string, any) {}
	l.supportFn = func(string) FeatureResult { return FeatureResult{} }
	t.Cleanup(func() {
		a.CloseRequestLink()
		l.wg.Wait()
	})
	return a
}

// TestMakeRequestLinkCarriesAutoAccept (G1): the choice rides on the link it
// was made with, into the snapshot and into that link's pairing, and never
// into the next link. The one-link refusal leaves the live link's choice alone.
func TestMakeRequestLinkCarriesAutoAccept(t *testing.T) {
	a := autoLaneApp(t)
	made := a.MakeRequestLink("x", t.TempDir(), "24h", true)
	if !made.AutoAccept {
		t.Fatalf("Make link with Auto-accept on returned %+v", made)
	}
	waitState(t, a, 5*time.Second, "error")
	if !stateOf(a).AutoAccept {
		t.Fatal("the link lost its choice")
	}
	p, ok := a.requestPairingFor(made.Gen)
	if !ok || !p.autoAccept {
		t.Fatalf("the pairing of an automatic link carries autoAccept=%v (ok %v)", p.autoAccept, ok)
	}

	next := a.MakeRequestLink("y", t.TempDir(), "24h", false)
	if next.AutoAccept {
		t.Fatal("the next link, made with Auto-accept off, came back automatic")
	}
	waitState(t, a, 5*time.Second, "error")
	if p, ok := a.requestPairingFor(next.Gen); !ok || p.autoAccept {
		t.Fatalf("the automatic choice carried over to the next link's pairing (ok %v)", ok)
	}
	if _, ok := a.requestPairingFor(made.Gen); ok {
		t.Fatal("the old link's generation still reads a pairing")
	}

	// An open link refuses a second Make link and keeps its own choice.
	third := a.MakeRequestLink("z", t.TempDir(), "24h", true)
	waitState(t, a, 5*time.Second, "error")
	forceState(a, "waiting", 0)
	if s := a.MakeRequestLink("w", t.TempDir(), "24h", false); s.State != "error" || s.Code != "already-open" {
		t.Fatalf("a second link while one waits: %+v", s)
	}
	if p, ok := a.requestPairingFor(third.Gen); !ok || !p.autoAccept || !stateOf(a).AutoAccept {
		t.Fatal("the refused Make link changed the open link's choice")
	}
	forceState(a, "off", 0)
}

// TestAutoAcceptIsNeverASetting (G2, D-173): the choice is per link and never
// remembered, so nothing of it may live in desktop.json.
func TestAutoAcceptIsNeverASetting(t *testing.T) {
	ty := reflect.TypeOf(appConfig{})
	for i := 0; i < ty.NumField(); i++ {
		f := ty.Field(i)
		for _, s := range []string{f.Name, f.Tag.Get("json")} {
			if strings.Contains(strings.ToLower(s), "accept") {
				t.Errorf("appConfig field %s (json %q) looks like a remembered accept choice", f.Name, f.Tag.Get("json"))
			}
		}
	}
	raw, err := json.Marshal(appConfig{HideIP: true, ReportStats: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(raw)), "accept") {
		t.Errorf("desktop.json would carry an accept choice: %s", raw)
	}
}

// ---- The Decide path (G4 to G6, G11, G13) -----------------------------------

const gib = int64(1) << 30

// to4 is the one notification an automatic drop sends at its start (D-137
// D10, D-173), spelled out here so the tests do not depend on the table they
// check.
var to4 = [2]string{"Floe", "Receiving files through your request link"}

// autoIncoming is a drop the default volume has room for: 3 files, 4 GiB.
var autoIncoming = transfer.IncomingInfo{Files: 3, TotalBytes: 4 * gib, FirstName: "a.bin", FirstSize: 1 << 20}

// autoVolume stands in the save volume for the Decide path: its free bytes
// and DiskFree's error, its size and the size query's error, whether it keeps
// named streams and that query's error, and its largest file (0: no limit).
type autoVolume struct {
	free       int64
	freeErr    error
	capacity   int64
	sizeErr    error
	streams    bool
	streamsErr error
	maxFile    int64
}

// roomyVolume is a 1 TiB NTFS drive with 500 GiB free.
func roomyVolume() autoVolume {
	return autoVolume{free: 500 * gib, capacity: 1024 * gib, streams: true}
}

// install puts v behind every volume seam the Decide path reads, and the Done
// view's named-streams question, so no test depends on the machine it runs on.
func (v autoVolume) install(t *testing.T) {
	t.Helper()
	setVar(t, &requestDiskFreeFn, func(string) (int64, error) { return v.free, v.freeErr })
	setVar(t, &requestVolumeSizeFn, func(string) (int64, error) { return v.capacity, v.sizeErr })
	setVar(t, &requestVolumeStreamsFn, func(string) (bool, error) { return v.streams, v.streamsErr })
	setVar(t, &requestVolumeMaxFn, func(string) (int64, error) { return v.maxFile, nil })
}

// autoDecide is one pairing's Decide on a bare App at lane generation 1, in
// connecting: the link's own stop channel, a drop on route, and every emit,
// toast, title, flash and abort recorded.
type autoDecide struct {
	a       *App
	rec     *snapRecorder
	att     *attentionRec
	wake    *wakeGuard
	p       requestPairing
	d       *requestDrop
	base    string
	closed  chan struct{} // the data channel close the drop watches
	aborted chan transfer.RefusalCode
}

func newAutoDecide(t *testing.T, autoAccept bool, route string) *autoDecide {
	t.Helper()
	w := &wakeGuard{onBlock: func() {}, onAllow: func() {}}
	a := &App{wake: w}
	rec := &snapRecorder{}
	l := a.lane()
	l.emitFn = rec.emit
	att := watchAttention(a, nil)
	forceGen(a, 1)
	forceState(a, "connecting", 0)
	stop := make(chan struct{})
	l.mu.Lock()
	l.stop = stop
	l.label = "Acme footage"
	l.autoAccept = autoAccept
	l.mu.Unlock()
	x := &autoDecide{a: a, rec: rec, att: att, wake: w, base: filepath.Join(t.TempDir(), "Floe"), closed: make(chan struct{}), aborted: make(chan transfer.RefusalCode, 4)}
	x.p = requestPairing{saveDir: x.base, label: "Acme footage", autoAccept: autoAccept, stop: stop}
	x.d = &requestDrop{closed: x.closed, route: route}
	x.d.abort = func(code transfer.RefusalCode) { x.aborted <- code }
	t.Cleanup(func() {
		if x.d.cap != nil {
			x.d.cap.Stop()
		}
	})
	return x
}

func (x *autoDecide) decide(in transfer.IncomingInfo) transfer.Decision {
	return x.a.requestDecide(1, x.p, x.d, in)
}

// sawPrompt reports whether any emitted snapshot was a prompt.
func (x *autoDecide) sawPrompt() bool {
	for _, s := range x.rec.all() {
		if s.State == "deciding" || s.Prompt != nil {
			return true
		}
	}
	return false
}

// baseMissing reports whether nothing, not even the save base, was created.
func (x *autoDecide) baseMissing() bool {
	_, err := os.Stat(x.base)
	return errors.Is(err, os.ErrNotExist)
}

// TestRequestDecideAutoAcceptSkipsPrompt (G4 to G7, G9, L9, L14): on a link
// made with Auto-accept on, a drop with nothing unusual about it is accepted
// inside Decide: no prompt snapshot, no promptGen, no flash, no "(1) Floe", no
// TO1; TO4 once; the drop's own folder, the wake hold, and a result that names
// the count and the folder from Accept on and marks the drop as accepted
// automatically. The drop's end is the prompted path's.
func TestRequestDecideAutoAcceptSkipsPrompt(t *testing.T) {
	roomyVolume().install(t)
	x := newAutoDecide(t, true, "direct")
	dec := x.decide(autoIncoming)
	if dec.Kind != transfer.DecisionAccept {
		t.Fatalf("decision %+v, want Accept with no prompt", dec)
	}
	if filepath.Dir(dec.OutputDir) != x.base || !dirExists(dec.OutputDir) {
		t.Fatalf("the drop landed in %q, want its own new folder under %q", dec.OutputDir, x.base)
	}
	if x.sawPrompt() {
		t.Fatal("an automatic drop emitted a prompt snapshot")
	}
	s := stateOf(x.a)
	if s.State != "receiving" || s.PromptGen != 0 || s.Prompt != nil {
		t.Fatalf("after the automatic Accept: %+v", s)
	}
	if r := s.Result; r == nil || r.Files != 3 || r.Folder != dec.OutputDir || !r.AutoAccepted || r.Saved != 0 {
		t.Fatalf("result %+v, want the announced count, the folder and the automatic mark", r)
	}
	if !x.d.accepted.Load() || !x.d.auto || x.d.folder != dec.OutputDir {
		t.Fatalf("the drop is not recorded as accepted automatically (accepted %v, auto %v)", x.d.accepted.Load(), x.d.auto)
	}
	titles, flashes, toasts := x.att.snapshot()
	if len(titles) != 0 || len(flashes) != 0 {
		t.Fatalf("an automatic drop set the title %q or flashed %v: those mean an answer is needed", titles, flashes)
	}
	if len(toasts) != 1 || toasts[0] != to4 {
		t.Fatalf("notifications %q, want TO4 once and nothing else", toasts)
	}
	if !requestHeld(x.wake) {
		t.Fatal("the automatic Accept took no wake hold")
	}
	x.a.endDrop(1, "done", "", &RequestResult{Files: 3, Saved: 3, Verified: 3, Folder: dec.OutputDir, AutoAccepted: true})
	if requestHeld(x.wake) {
		t.Fatal("the drop's end left the wake hold")
	}
	if x.att.count(to2[0], to2[1]) != 1 {
		t.Fatal("Files received did not follow the automatic drop's end")
	}
}

// TestAutoAcceptCarriesTheBatteryFact (P11, E-94): the battery answer is
// asked at a prompt, and the automatic path opens none, so it asks at its own
// Accept; otherwise the Receiving view's laptop line could never show for an
// automatic drop.
func TestAutoAcceptCarriesTheBatteryFact(t *testing.T) {
	roomyVolume().install(t)
	for _, battery := range []bool{true, false} {
		setVar(t, &hasBatteryFn, func() bool { return battery })
		x := newAutoDecide(t, true, "direct")
		if dec := x.decide(autoIncoming); dec.Kind != transfer.DecisionAccept {
			t.Fatalf("battery %v: decision %+v", battery, dec)
		}
		if s := stateOf(x.a); s.State != "receiving" || s.Battery != battery {
			t.Fatalf("battery %v: the receiving snapshot says %v", battery, s.Battery)
		}
		x.a.requestWakeRelease(1)
	}
}

// TestAutoAcceptFallsBackToThePrompt (G4, G5, G6, G13, D-137 D11 kept by
// D-173): each drop below asks, exactly as on a link made with Auto-accept
// off: a prompt, TO1, and nothing on disk until the owner answers (here the
// answer window runs out). Each subtest goes red when its own condition is
// deleted, except low-space and DiskFree (-1, nil), which the G13 floor also
// catches by construction (the floor is at least 20 GiB, above the 2 GiB
// reserve and any arithmetic on -1): they prove the combined behavior.
func TestAutoAcceptFallsBackToThePrompt(t *testing.T) {
	in := func(files int, total, first int64) transfer.IncomingInfo {
		return transfer.IncomingInfo{Files: files, TotalBytes: total, FirstName: "a.bin", FirstSize: first}
	}
	overCap := transfer.RelaySizeLimit + 1
	cases := []struct {
		name  string
		auto  bool
		route string
		vol   func(v *autoVolume)
		in    transfer.IncomingInfo
	}{
		{"an Auto-accept off link", false, "direct", nil, autoIncoming},
		{"low-space", true, "direct", func(v *autoVolume) { v.free = 3 * gib }, in(3, 2*gib, 1<<20)},
		{"file-too-large-for-drive", true, "direct", func(v *autoVolume) { v.maxFile = 4*gib - 1 }, in(1, 5*gib, 5*gib)},
		{"relay-over-cap", true, "relay", nil, in(2, overCap, 1<<20)},
		{"route unknown", true, "", nil, in(2, overCap, 1<<20)},
		{"DiskFree error", true, "direct", func(v *autoVolume) { v.freeErr = errors.New("the volume did not answer") }, autoIncoming},
		{"DiskFree unknown (-1, nil)", true, "direct", func(v *autoVolume) { v.free = -1 }, autoIncoming},
		{"no named streams (exFAT)", true, "direct", func(v *autoVolume) { v.streams = false }, autoIncoming},
		{"named streams query error", true, "direct", func(v *autoVolume) {
			v.streams, v.streamsErr = true, errors.New("the volume did not answer")
		}, autoIncoming},
		{"capacity unknown", true, "direct", func(v *autoVolume) { v.capacity = 0 }, autoIncoming},
		{"capacity query error", true, "direct", func(v *autoVolume) { v.sizeErr = errors.New("the volume did not answer") }, autoIncoming},
		{"under the 20 GiB floor", true, "direct", func(v *autoVolume) { v.free, v.capacity = 30*gib, 100*gib }, in(3, 12*gib, 1<<20)},
		{"under a tenth of the drive", true, "direct", func(v *autoVolume) { v.free, v.capacity = 150*gib, 1024*gib }, in(3, 60*gib, 1<<20)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := roomyVolume()
			if tc.vol != nil {
				tc.vol(&v)
			}
			v.install(t)
			setVar(t, &requestDecideWindow, 50*time.Millisecond)
			x := newAutoDecide(t, tc.auto, tc.route)
			assertAsked(t, x, x.decide(tc.in))
		})
	}
}

// assertAsked checks a Decide that asked and whose window then ran out: the
// expired refusal, a prompt, TO1 once and no TO4, and nothing on disk.
func assertAsked(t *testing.T, x *autoDecide, dec transfer.Decision) {
	t.Helper()
	if dec.Kind != transfer.DecisionRefuse || dec.Code != transfer.CodeExpired {
		t.Fatalf("decision %+v, want the prompt, then the expired refusal", dec)
	}
	if !x.sawPrompt() {
		t.Fatal("no prompt snapshot")
	}
	if x.d.accepted.Load() || x.d.auto {
		t.Fatal("the drop was accepted")
	}
	if x.att.count(to1[0], to1[1]) != 1 || x.att.count(to4[0], to4[1]) != 0 {
		_, _, toasts := x.att.snapshot()
		t.Fatalf("notifications %q, want TO1 once and no TO4", toasts)
	}
	if !x.baseMissing() {
		t.Fatalf("a drop that asked left %q", treeUnder(t, filepath.Dir(x.base)))
	}
}

// TestAutoAcceptAsksOnASlowVolume (G6, G13, fail closed): a volume that does
// not answer the named-streams or the size question within its bound counts
// as unknown, so the drop asks, and the prompt is held back by about one
// bound, not by the volume's own timeout. The two questions run side by side.
func TestAutoAcceptAsksOnASlowVolume(t *testing.T) {
	for _, slow := range []string{"named streams", "size", "both"} {
		t.Run(slow, func(t *testing.T) {
			roomyVolume().install(t)
			setVar(t, &requestDecideWindow, 50*time.Millisecond)
			setVar(t, &requestVolumeStreamsBound, 100*time.Millisecond)
			setVar(t, &requestVolumeSizeBound, 100*time.Millisecond)
			release := make(chan struct{})
			t.Cleanup(func() { close(release) })
			if slow != "size" {
				setVar(t, &requestVolumeStreamsFn, func(string) (bool, error) { <-release; return true, nil })
			}
			if slow != "named streams" {
				setVar(t, &requestVolumeSizeFn, func(string) (int64, error) { <-release; return 1024 * gib, nil })
			}
			x := newAutoDecide(t, true, "direct")
			start := time.Now()
			dec := x.decide(autoIncoming)
			if took := time.Since(start); took > 2*time.Second {
				t.Fatalf("Decide took %v with a 100 ms bound per question", took)
			}
			assertAsked(t, x, dec)
		})
	}
}

// TestVolumeCapacityBoundsTheQuestion: the size question answers 0 (unknown)
// for an error, a negative size or no answer within the bound, and its
// goroutine ends on its own once the late answer comes.
func TestVolumeCapacityBoundsTheQuestion(t *testing.T) {
	for _, c := range []struct {
		name string
		size int64
		err  error
		want int64
	}{
		{"a size", 1024 * gib, nil, 1024 * gib},
		{"an error", 1024 * gib, errors.New("boom"), 0},
		{"a negative size", -1, nil, 0},
		{"no size", 0, nil, 0},
	} {
		setVar(t, &requestVolumeSizeFn, func(string) (int64, error) { return c.size, c.err })
		if got := volumeCapacity(`D:\x`); got != c.want {
			t.Errorf("%s: volumeCapacity = %d, want %d", c.name, got, c.want)
		}
	}
	setVar(t, &requestVolumeSizeBound, 100*time.Millisecond)
	release, returned := make(chan struct{}), make(chan struct{})
	setVar(t, &requestVolumeSizeFn, func(string) (int64, error) {
		defer close(returned)
		<-release
		return 1024 * gib, nil
	})
	start := time.Now()
	if got := volumeCapacity(`D:\x`); got != 0 {
		t.Fatalf("a question past the bound answered %d, want 0 (unknown)", got)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("volumeCapacity took %v, want about the 100 ms bound", took)
	}
	close(release)
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("the late question never returned")
	}
}

// TestAutoLinkPromptedAcceptIsNotMarked (HA1, C1-09): a drop on a link made
// with Auto-accept on that asked (here, low on space) and that the owner
// accepted by hand is the owner's decision: its result is not marked as
// accepted automatically, and TO4 does not fire.
func TestAutoLinkPromptedAcceptIsNotMarked(t *testing.T) {
	v := roomyVolume()
	v.free = 3 * gib
	v.install(t)
	x := newAutoDecide(t, true, "direct")
	x.a.lane().emitFn = func(event string, data any) {
		x.rec.emit(event, data)
		if s, ok := data.(RequestLinkSnapshot); ok && s.State == "deciding" {
			x.a.AnswerRequest(s.PromptGen, "accept")
		}
	}
	dec := x.decide(transfer.IncomingInfo{Files: 1, TotalBytes: 2 * gib, FirstName: "a.bin", FirstSize: 2 * gib})
	if dec.Kind != transfer.DecisionAccept || !x.sawPrompt() {
		t.Fatalf("decision %+v (prompt shown %v), want the owner's Accept on a prompt", dec, x.sawPrompt())
	}
	if r := stateOf(x.a).Result; r == nil || r.AutoAccepted || x.d.auto {
		t.Fatalf("a drop the owner accepted by hand is marked automatic: %+v, d.auto %v", r, x.d.auto)
	}
	if n := x.att.count(to4[0], to4[1]); n != 0 {
		t.Fatalf("TO4 fired %d times for a drop the owner accepted by hand", n)
	}
	x.a.requestWakeRelease(1)
}

// TestAutoAcceptAfterCloseLinkMakesNoFolder (G11, C2-10): Close link ended the
// link while its visitor's metadata was on the way. The automatic branch never
// selects on the link's stop the way a prompt does, so it checks it first:
// nothing is made, not even the save base, and nothing is announced.
func TestAutoAcceptAfterCloseLinkMakesNoFolder(t *testing.T) {
	roomyVolume().install(t)
	x := newAutoDecide(t, true, "direct")
	x.a.CloseRequestLink()
	dec := x.decide(autoIncoming)
	if dec.Kind != transfer.DecisionRefuse || dec.Code != transfer.CodeStopped {
		t.Fatalf("decision %+v after Close link, want the stopped refusal", dec)
	}
	if !x.baseMissing() {
		t.Fatalf("Close link, then an automatic pairing, made %q", treeUnder(t, filepath.Dir(x.base)))
	}
	if _, _, toasts := x.att.snapshot(); len(toasts) != 0 {
		t.Fatalf("a closed link announced %q", toasts)
	}
}

// TestAutoAcceptClosedChannelMakesNothing (implication 8 on the automatic
// path): the visitor's channel closed before Decide ran. Nothing is made, the
// pairing ends as a leave, and E-40 counts nothing, because no prompt was
// shown to end.
func TestAutoAcceptClosedChannelMakesNothing(t *testing.T) {
	roomyVolume().install(t)
	x := newAutoDecide(t, true, "direct")
	close(x.closed)
	dec := x.decide(autoIncoming)
	if dec.Kind != transfer.DecisionRefuse || dec.Code != transfer.CodeStopped || x.d.accepted.Load() {
		t.Fatalf("decision %+v on a closed channel, want the stopped refusal", dec)
	}
	if x.d.outcome != "left" {
		t.Fatalf("outcome %q, want left", x.d.outcome)
	}
	if !x.baseMissing() {
		t.Fatalf("an automatic Accept on a closed channel left %q", treeUnder(t, filepath.Dir(x.base)))
	}
	l := x.a.lane()
	l.mu.Lock()
	ends := len(l.promptEnds)
	l.mu.Unlock()
	if ends != 0 {
		t.Fatalf("E-40 counted %d prompt ends for a drop that showed no prompt", ends)
	}
	titles, flashes, toasts := x.att.snapshot()
	if len(titles)+len(flashes)+len(toasts) != 0 {
		t.Fatalf("a closed channel drew attention: %q %v %q", titles, flashes, toasts)
	}
}

// TestAutoAcceptCancelDrop (G8): Cancel drop stops an automatic drop the way
// it stops a prompted one: the owner's stop is recorded and the coded stop
// goes to the visitor.
func TestAutoAcceptCancelDrop(t *testing.T) {
	roomyVolume().install(t)
	x := newAutoDecide(t, true, "direct")
	if dec := x.decide(autoIncoming); dec.Kind != transfer.DecisionAccept {
		t.Fatalf("decision %+v", dec)
	}
	x.a.CancelRequestDrop()
	select {
	case code := <-x.aborted:
		if code != transfer.CodeStopped {
			t.Fatalf("Cancel drop sent %q, want stopped", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Cancel drop did nothing on the automatic path")
	}
	if !x.d.ownerCancel.Load() {
		t.Fatal("Cancel drop did not record the owner's stop")
	}
	x.a.requestWakeRelease(1)
}

// TestAutoAcceptCancelDuringTO4EndsTheDrop (G8, review 1 R2 b): TO4 is sent
// inside Decide once the lane already shows receiving, so the owner's Cancel
// drop can land before the engine's own closed check, which then reports the
// connection the Cancel closed as the visitor leaving. It is the owner's
// stop: the drop ends stopped, with no failure toast, and the link is used
// up. It never reopens to take the next visitor's drop by itself.
func TestAutoAcceptCancelDuringTO4EndsTheDrop(t *testing.T) {
	roomyVolume().install(t)
	x := newAutoDecide(t, true, "direct")
	x.a.notifyFn = func(title, body string) {
		x.att.toast(title, body)
		if [2]string{title, body} == to4 {
			x.a.CancelRequestDrop()
		}
	}
	dec := x.decide(autoIncoming)
	if dec.Kind != transfer.DecisionAccept {
		t.Fatalf("decision %+v", dec)
	}
	if !x.d.ownerCancel.Load() {
		t.Fatal("the Cancel drop during TO4 did not reach the drop")
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("the owner's Cancel drop was read as the visitor leaving: the link was reopened (%v)", r)
		}
	}()
	// The engine's closed check finds the connection the Cancel closed.
	_ = x.a.endRequestDrop(1, nil, x.d, transfer.ErrSenderLeft)
	s := stateOf(x.a)
	if s.State != "stopped" || s.Code != "stopped" {
		t.Fatalf("after the owner's Cancel: %s %q, want stopped stopped (the link used up)", s.State, s.Code)
	}
	if _, _, toasts := x.att.snapshot(); len(toasts) != 1 || toasts[0] != to4 {
		t.Fatalf("notifications %q, want TO4 alone (no failure toast for the owner's own stop)", toasts)
	}
	if requestHeld(x.wake) {
		t.Fatal("the stopped drop kept the wake hold")
	}
	if got := treeUnder(t, x.base); len(got) != 0 {
		t.Fatalf("the stopped drop that saved nothing left %q", got)
	}
}

// TestAutoAcceptToastQuietAfterTwoAbandoned (review 1 R2 a): a link holder
// can send a first metadata and close as the automatic Accept runs, over and
// over, and each time the owner would read "Receiving files through your
// request link" for a drop that never starts. After two such abandoned
// automatic Accepts within E-40's 10 minutes, TO4 stays quiet; once they
// leave the window, it speaks again. One abandoned Accept quiets nothing.
func TestAutoAcceptToastQuietAfterTwoAbandoned(t *testing.T) {
	roomyVolume().install(t)
	clock := time.Unix(1_800_000_000, 0)
	x := newAutoDecide(t, true, "direct")
	l := x.a.lane()
	l.mu.Lock()
	l.now = func() time.Time { return clock }
	l.mu.Unlock()
	pairing := func() {
		t.Helper()
		forceState(x.a, "connecting", 0)
		x.closed = make(chan struct{})
		x.d = &requestDrop{closed: x.closed, route: "direct", abort: func(transfer.RefusalCode) {}}
		if dec := x.decide(autoIncoming); dec.Kind != transfer.DecisionAccept {
			t.Fatalf("decision %+v", dec)
		}
		x.d.cap.Stop()
		x.a.requestWakeRelease(1)
	}
	to4s := func() int { return x.att.count(to4[0], to4[1]) }

	x.a.autoAbandoned(1)
	pairing()
	if n := to4s(); n != 1 {
		t.Fatalf("after one abandoned automatic Accept: %d TO4, want 1", n)
	}
	x.a.autoAbandoned(1)
	pairing()
	if n := to4s(); n != 1 {
		t.Fatalf("after two abandoned automatic Accepts in 10 minutes: %d TO4, want still 1 (quiet)", n)
	}
	clock = clock.Add(requestSpamWindow + time.Second)
	pairing()
	if n := to4s(); n != 2 {
		t.Fatalf("once the abandoned Accepts left the window: %d TO4, want 2", n)
	}
}

// TestMakeRequestLinkForgetsAbandonedAccepts (review 1 R2 a): the count that
// quiets TO4 belongs to one link; a new link starts with none, and a
// generation that no longer owns the lane counts nothing.
func TestMakeRequestLinkForgetsAbandonedAccepts(t *testing.T) {
	a := autoLaneApp(t)
	made := a.MakeRequestLink("x", t.TempDir(), "24h", true)
	waitState(t, a, 5*time.Second, "error")
	a.autoAbandoned(made.Gen)
	a.autoAbandoned(made.Gen)
	counted := func() int {
		l := a.lane()
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.autoEnds)
	}
	if n := counted(); n != 2 {
		t.Fatalf("%d abandoned Accepts counted, want 2", n)
	}
	next := a.MakeRequestLink("y", t.TempDir(), "24h", true)
	waitState(t, a, 5*time.Second, "error")
	if n := counted(); n != 0 {
		t.Fatalf("the new link inherited %d abandoned Accepts", n)
	}
	a.autoAbandoned(made.Gen)
	if n := counted(); n != 0 {
		t.Fatalf("an old generation counted an abandoned Accept on the new link (%d)", n)
	}
	a.autoAbandoned(next.Gen)
	if n := counted(); n != 1 {
		t.Fatalf("the live link counted %d, want 1", n)
	}
}

// TestAutoAcceptKeepsPromptSpamCount (E-40, PLAN 3.3 RR-12, review 2 F1): only
// the owner's Accept answers E-40. On a link made with Auto-accept on, a link
// holder could otherwise alternate drops that ask and then leave with a small
// drop the link takes by itself and then abandons: each automatic Accept
// would clear the count, so TO1 would never go quiet and "Close this link?"
// would not stay. Two unanswered prompts, one automatic Accept, then a third
// prompt: no TO1 and suggestClose on, as on a link made with Auto-accept off.
// The owner's own Accept on the next prompt still clears both.
func TestAutoAcceptKeepsPromptSpamCount(t *testing.T) {
	roomyVolume().install(t)
	clock := time.Unix(1_800_000_000, 0)
	x := newAutoDecide(t, true, "direct")
	l := x.a.lane()
	l.mu.Lock()
	l.now = func() time.Time { return clock }
	l.mu.Unlock()
	// 600 GiB on the 500 GiB-free test volume: low-space, so the drop asks.
	huge := transfer.IncomingInfo{Files: 1, TotalBytes: 600 * gib, FirstName: "a.bin", FirstSize: 1 << 20}
	fresh := func() {
		forceState(x.a, "connecting", 0)
		x.closed = make(chan struct{})
		x.d = &requestDrop{closed: x.closed, route: "direct", abort: func(transfer.RefusalCode) {}}
	}
	// asking starts a drop of in that must ask, and returns its Decide's answer
	// once the prompt is up.
	asking := func(in transfer.IncomingInfo) <-chan transfer.Decision {
		t.Helper()
		fresh()
		done := make(chan transfer.Decision, 1)
		go func() { done <- x.decide(in) }()
		waitState(t, x.a, 5*time.Second, "deciding")
		return done
	}
	askedThenLeft := func() {
		t.Helper()
		done := asking(huge)
		close(x.closed)
		if dec := <-done; dec.Kind == transfer.DecisionAccept {
			t.Fatalf("a low-space drop was accepted: %+v", dec)
		}
		clock = clock.Add(time.Minute)
	}
	promptEnds := func() int {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.promptEnds)
	}
	to1s := func() int { return x.att.count(to1[0], to1[1]) }

	askedThenLeft()
	askedThenLeft()
	if n := to1s(); n != 2 {
		t.Fatalf("two prompts sent %d TO1, want 2", n)
	}
	// A small drop the link takes by itself; its visitor then abandons it
	// before the engine claims anything (endRequestDrop's first branch).
	fresh()
	if dec := x.decide(autoIncoming); dec.Kind != transfer.DecisionAccept || !x.d.auto {
		t.Fatalf("the small drop was not accepted automatically: %+v (auto %v)", dec, x.d.auto)
	}
	x.d.cap.Stop()
	x.a.requestWakeRelease(1)
	x.a.autoAbandoned(1)
	if n := promptEnds(); n != 2 {
		t.Errorf("the automatic Accept cleared E-40's count: %d prompt ends left, want 2", n)
	}
	askedThenLeft()
	if n := to1s(); n != 2 {
		t.Errorf("after two unanswered prompts and one automatic Accept, the next prompt toasted (%d TO1, want 2)", n)
	}
	if !x.a.GetRequestLink().SuggestClose {
		t.Errorf("suggestClose is off after two unanswered prompts and one automatic Accept")
	}

	// The owner's Accept is an answer: it clears the count and the hint.
	done := asking(huge)
	x.a.AnswerRequest(stateOf(x.a).PromptGen, "accept")
	if dec := <-done; dec.Kind != transfer.DecisionAccept || x.d.auto {
		t.Fatalf("the owner's Accept: %+v (auto %v)", dec, x.d.auto)
	}
	x.d.cap.Stop()
	x.a.requestWakeRelease(1)
	if n := promptEnds(); n != 0 || x.a.GetRequestLink().SuggestClose {
		t.Fatalf("the owner's Accept left %d prompt ends and suggestClose %v, want none and off", n, x.a.GetRequestLink().SuggestClose)
	}
}

// TestAutoAcceptKeepsTheCloseHint (review 1 R1, the W13 half of review 2 F1):
// three unanswered prompts on a link made with Auto-accept on set the "Close
// this link?" hint (the third prompt opened quiet). An automatic Accept
// answers no prompt, so right after it the hint is still on and the three
// prompt ends are kept, and the waiting view still shows W13 once the visitor
// abandons the automatic drop. TestAutoAcceptKeepsPromptSpamCount reads the
// hint only after a later prompt has set it again from the count, so a
// change that cleared only the hint passed it.
func TestAutoAcceptKeepsTheCloseHint(t *testing.T) {
	roomyVolume().install(t)
	clock := time.Unix(1_800_000_000, 0)
	x := newAutoDecide(t, true, "direct")
	l := x.a.lane()
	l.mu.Lock()
	l.now = func() time.Time { return clock }
	l.mu.Unlock()
	// 600 GiB on the 500 GiB-free test volume: low-space, so the drop asks.
	huge := transfer.IncomingInfo{Files: 1, TotalBytes: 600 * gib, FirstName: "a.bin", FirstSize: 1 << 20}
	fresh := func() {
		forceState(x.a, "connecting", 0)
		x.closed = make(chan struct{})
		x.d = &requestDrop{closed: x.closed, route: "direct", abort: func(transfer.RefusalCode) {}}
	}
	askedThenLeft := func() {
		t.Helper()
		fresh()
		done := make(chan transfer.Decision, 1)
		go func() { done <- x.decide(huge) }()
		waitState(t, x.a, 5*time.Second, "deciding")
		close(x.closed)
		if dec := <-done; dec.Kind == transfer.DecisionAccept {
			t.Fatalf("a low-space drop was accepted: %+v", dec)
		}
		clock = clock.Add(time.Minute)
	}
	promptEnds := func() int {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.promptEnds)
	}
	for i := 0; i < 3; i++ {
		askedThenLeft()
	}
	if !x.a.GetRequestLink().SuggestClose || promptEnds() != 3 {
		t.Fatalf("after three unanswered prompts: suggestClose %v, %d prompt ends; want on and 3", x.a.GetRequestLink().SuggestClose, promptEnds())
	}
	fresh()
	if dec := x.decide(autoIncoming); dec.Kind != transfer.DecisionAccept || !x.d.auto {
		t.Fatalf("the small drop was not accepted automatically: %+v (auto %v)", dec, x.d.auto)
	}
	if !x.a.GetRequestLink().SuggestClose {
		t.Error("the automatic Accept cleared the close hint (W13)")
	}
	if n := promptEnds(); n != 3 {
		t.Errorf("the automatic Accept left %d prompt ends, want the 3 it found", n)
	}
	// The visitor abandons the automatic drop and the link waits again: the
	// hint is still there for the waiting view.
	x.d.cap.Stop()
	x.a.requestWakeRelease(1)
	x.a.autoAbandoned(1)
	if !x.a.GetRequestLink().SuggestClose {
		t.Error("the close hint is gone once the abandoned automatic drop let the link wait again")
	}
}

// TestAutoAcceptToastIsConstant (G7, S9, VR3-G08): whatever the owner's label
// and the visitor's first name hold, an automatic drop's one notification is
// TO4 and carries none of it.
func TestAutoAcceptToastIsConstant(t *testing.T) {
	roomyVolume().install(t)
	label := "$(calc) ]]><x `id` \u202e"
	x := newAutoDecide(t, true, "direct")
	l := x.a.lane()
	l.mu.Lock()
	l.label = label
	l.mu.Unlock()
	x.p.label = label
	in := autoIncoming
	in.FirstName = "`whoami`.txt ]]><![CDATA[ photo\u202egnp.exe"
	if dec := x.decide(in); dec.Kind != transfer.DecisionAccept {
		t.Fatalf("decision %+v", dec)
	}
	_, _, toasts := x.att.snapshot()
	if len(toasts) != 1 || toasts[0] != to4 {
		t.Fatalf("notifications %q, want TO4 only", toasts)
	}
	for _, h := range []string{"calc", "]]>", "`", "\u202e", "whoami", "CDATA", "gnp"} {
		if strings.Contains(toasts[0][0]+toasts[0][1], h) {
			t.Fatalf("TO4 carries %q", h)
		}
	}
	x.a.requestWakeRelease(1)
}

// TestWaitAgainClearsResult (C2-10, L9): a link that waits again after a
// pairing carries no result, so a reopened link never shows the count or the
// folder of a drop that did not happen.
func TestWaitAgainClearsResult(t *testing.T) {
	a := &App{wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}, notifyFn: func(string, string) {}}
	a.lane().emitFn = func(string, any) {}
	forceGen(a, 1)
	if !a.acceptDrop(1, RequestResult{Files: 12, Folder: filepath.Join("D:", "Floe", "x"), AutoAccepted: true}) {
		t.Fatal("Accept refused the live generation")
	}
	if s := stateOf(a); s.Result == nil || s.Result.Files != 12 {
		t.Fatalf("receiving carries result %+v, want the accepted count", s.Result)
	}
	a.requestWakeRelease(1)
	a.waitAgain(1, "visitor-left")
	if s := stateOf(a); s.State != "waiting" || s.Result != nil {
		t.Fatalf("after waitAgain: state %s, result %+v", s.State, s.Result)
	}
}

// TestEndRequestDropKeepsTheAutomaticMark (HA1): the result an accepted drop
// ends with carries the automatic mark to Done (and to a stop that saved
// files), where History reads it; a drop accepted on a prompt ends unmarked.
func TestEndRequestDropKeepsTheAutomaticMark(t *testing.T) {
	setVar(t, &requestVolumeStreamsFn, func(string) (bool, error) { return true, nil })
	for _, auto := range []bool{true, false} {
		a := &App{wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}, notifyFn: func(string, string) {}}
		a.lane().emitFn = func(string, any) {}
		forceGen(a, 1)
		forceState(a, "receiving", 0)
		d := &requestDrop{closed: make(chan struct{}), files: 2, folder: t.TempDir(), auto: auto}
		d.accepted.Store(true)
		_ = a.endRequestDrop(1, nil, d, nil)
		s := stateOf(a)
		if s.State != "done" || s.Result == nil || s.Result.AutoAccepted != auto {
			t.Fatalf("auto %v: ended %s with result %+v", auto, s.State, s.Result)
		}
	}
}

// TestAutoEligible (G4, G5, G6, G13): the pure rule, with its boundaries.
func TestAutoEligible(t *testing.T) {
	roomy := requestSpace{free: 500 * gib, freeKnown: true, capacity: 1024 * gib, namedStreams: true}
	small := requestSpace{free: 30 * gib, freeKnown: true, capacity: 100 * gib, namedStreams: true} // floor 20 GiB
	pr := func(total int64, warnings ...string) RequestPrompt {
		return RequestPrompt{Files: 1, TotalBytes: total, Warnings: warnings}
	}
	with := func(sp requestSpace, fn func(*requestSpace)) requestSpace { fn(&sp); return sp }
	floor := roomy.capacity / 10 // 102.4 GiB beats 20 GiB on a 1 TiB drive
	cases := []struct {
		name  string
		pr    RequestPrompt
		route string
		sp    requestSpace
		want  bool
	}{
		{"direct, roomy", pr(4 * gib), "direct", roomy, true},
		{"relay, roomy", pr(1 * gib), "relay", roomy, true},
		{"low-space", pr(4*gib, "low-space"), "direct", roomy, false},
		{"file-too-large-for-drive", pr(4*gib, "file-too-large-for-drive"), "direct", roomy, false},
		{"relay-over-cap", pr(4*gib, "relay-over-cap"), "relay", roomy, false},
		{"an unknown warning", pr(4*gib, "something-new"), "direct", roomy, false},
		{"route unknown", pr(4 * gib), "", roomy, false},
		{"route not a route", pr(4 * gib), "tcp", roomy, false},
		{"free space unknown", pr(4 * gib), "direct", with(roomy, func(s *requestSpace) { s.freeKnown = false }), false},
		{"no named streams", pr(4 * gib), "direct", with(roomy, func(s *requestSpace) { s.namedStreams = false }), false},
		{"capacity unknown", pr(4 * gib), "direct", with(roomy, func(s *requestSpace) { s.capacity = 0 }), false},
		{"capacity negative", pr(4 * gib), "direct", with(roomy, func(s *requestSpace) { s.capacity = -1 }), false},
		{"exactly the tenth left", pr(roomy.free - floor), "direct", roomy, true},
		{"a byte under the tenth", pr(roomy.free - floor + 1), "direct", roomy, false},
		{"exactly 20 GiB left", pr(10 * gib), "direct", small, true},
		{"a byte under 20 GiB", pr(10*gib + 1), "direct", small, false},
		{"a total over the free space", pr(600 * gib), "direct", roomy, false},
		{"a negative total", pr(-1), "direct", with(small, func(s *requestSpace) { s.free = 20*gib - 1 }), false},
	}
	for _, tc := range cases {
		if got := autoEligible(tc.pr, tc.route, tc.sp); got != tc.want {
			t.Errorf("%s: autoEligible = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestRequestSpaceForAsksTheNearestFolder: the drop folder does not exist
// before Accept, and neither may the save base, so every volume question goes
// to the nearest folder that exists.
func TestRequestSpaceForAsksTheNearestFolder(t *testing.T) {
	root := t.TempDir()
	var asked []string
	setVar(t, &requestDiskFreeFn, func(dir string) (int64, error) { asked = append(asked, "free "+dir); return 500 * gib, nil })
	setVar(t, &requestVolumeSizeFn, func(string) (int64, error) { return 1024 * gib, nil })
	setVar(t, &requestVolumeStreamsFn, func(string) (bool, error) { return true, nil })
	sp := requestSpaceFor(filepath.Join(root, "Floe", "not yet"))
	if want := (requestSpace{free: 500 * gib, freeKnown: true, capacity: 1024 * gib, namedStreams: true}); sp != want {
		t.Fatalf("requestSpaceFor = %+v, want %+v", sp, want)
	}
	if len(asked) != 1 || asked[0] != "free "+root {
		t.Fatalf("free space asked of %q, want the nearest existing folder %q", asked, root)
	}
}

// TestRequestToastTextIsCalm (D-167, D-173): every toast in the table, TO4
// included, is one line with no closing period, and a key past the table has
// no text.
func TestRequestToastTextIsCalm(t *testing.T) {
	for _, k := range []requestToast{toastRequestArrived, toastDropDone, toastDropFailed, toastDropAutoAccepted} {
		title, body, ok := requestToastText(k)
		if !ok || title == "" || body == "" {
			t.Fatalf("toast %d: %q / %q (ok %v)", k, title, body, ok)
		}
		for _, s := range []string{title, body} {
			if strings.HasSuffix(s, ".") || strings.Contains(s, "\n") {
				t.Errorf("toast %d: %q is not one calm line", k, s)
			}
		}
	}
	if title, body, _ := requestToastText(toastDropAutoAccepted); [2]string{title, body} != to4 {
		t.Errorf("TO4 reads %q / %q, want %q", title, body, to4)
	}
	if _, _, ok := requestToastText(toastDropAutoAccepted + 1); ok {
		t.Error("a key past the table has text")
	}
}
