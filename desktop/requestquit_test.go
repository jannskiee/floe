package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// fillTally commits n files of 10 bytes to t, every one verified.
func fillTally(t *dropTally, n int) {
	for i := 0; i < n; i++ {
		t.add(transfer.FileDone{SavedName: "clip " + string(rune('a'+i)) + ".mov", Bytes: 10, Verified: true})
	}
}

// readQuitDrop reads the record at path as written, without the launch's
// clean-up.
func readQuitDrop(t *testing.T, path string) (quitDrop, bool) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return quitDrop{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	var q quitDrop
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatalf("the record is not JSON: %v", err)
	}
	return q, true
}

// TestQuitDropRoundTrip: the next launch reads the record once, and the file
// is gone after that read, so the stopped drop shows on one launch only.
func TestQuitDropRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "floe", "quit-drop.json")
	folder := filepath.Join(t.TempDir(), "Acme footage 2026-10-16 1405")
	in := quitDrop{Label: "Acme footage", At: time.Now().Add(-time.Hour).UnixMilli(), Result: RequestResult{
		Files: 12, Saved: 4, Bytes: 40, Verified: 4, Folder: folder,
		Names: []string{"a.mov", "b.mov", "c.mov", "d.mov"}, Sizes: []int64{10, 10, 10, 10}, AutoAccepted: true,
	}}
	if err := saveQuitDrop(path, in); err != nil {
		t.Fatal(err)
	}
	got, ok := takeQuitDrop(path)
	if !ok {
		t.Fatal("a record that was written did not come back")
	}
	if got.Label != in.Label || got.At != in.At || got.Result.Saved != 4 || got.Result.Files != 12 ||
		got.Result.Folder != folder || len(got.Result.Names) != 4 || !got.Result.AutoAccepted || !got.Result.NoNamedStreams {
		t.Fatalf("record = %+v, want %+v with NoNamedStreams", got, in)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the record is still on disk after the launch read it: %v", err)
	}
	if _, ok := takeQuitDrop(path); ok {
		t.Fatal("a second launch read the record again")
	}
	if _, ok := takeQuitDrop(""); ok {
		t.Fatal("no config folder read a record")
	}
}

// TestTakeQuitDropKeepsOnlyWhatALaunchCanShow: the record sits in a folder the
// owner can edit, so the launch reads it the way normalizeSnapshot reads a
// snapshot: counts in range, at most 200 names with a size beside each, an
// absolute folder or none, the label as Make link cuts it, and a time that is
// not in the future. A record with nothing saved, or one that does not parse,
// is no record, and the file goes either way.
func TestTakeQuitDropKeepsOnlyWhatALaunchCanShow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "quit-drop.json")
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	names := make([]string, 250)
	for i := range names {
		names[i] = "f.txt"
	}
	rawNames, _ := json.Marshal(names)
	write(`{"label":"  ` + strings.Repeat("x", 80) + `  ","at":` + "99999999999999" + `,"result":{"files":2,"saved":5,"bytes":-7,"verified":9,"renamed":-1,"folder":"relative\\dir","names":` + string(rawNames) + `,"sizes":[1,-5],"noNamedStreams":false}}`)
	q, ok := takeQuitDrop(path)
	if !ok {
		t.Fatal("a record with files saved was dropped")
	}
	r := q.Result
	if r.Saved != 5 || r.Files != 5 || r.Bytes != 0 || r.Verified != 5 || r.Renamed != 0 {
		t.Errorf("counts = %+v, want saved 5 of 5, 0 bytes, 5 verified, 0 renamed", r)
	}
	if len(r.Names) != requestResultNames || len(r.Sizes) != len(r.Names) || r.Sizes[0] != 1 || r.Sizes[1] != -1 || r.Sizes[2] != -1 {
		t.Errorf("names %d, sizes %v..., want 200 names and a size or -1 beside each", len(r.Names), r.Sizes[:3])
	}
	if r.Folder != "" {
		t.Errorf("a relative folder came back: %q", r.Folder)
	}
	if !r.NoNamedStreams {
		t.Error("the launch cannot ask the volume, so the not-scanned line must stay")
	}
	if want := strings.Repeat("x", requestLabelMax); q.Label != want {
		t.Errorf("label = %q, want it cut to %d runes", q.Label, requestLabelMax)
	}
	if q.At > time.Now().UnixMilli() {
		t.Errorf("a time in the future came back: %d", q.At)
	}

	for _, body := range []string{
		`{"label":"x","at":1,"result":{"files":12,"saved":0,"folder":"C:\\x"}}`,
		`{"label":"x","at":1,"result":{"files":20000,"saved":20000}}`,
		`not json`,
		``,
	} {
		write(body)
		if q, ok := takeQuitDrop(path); ok {
			t.Errorf("%q came back as %+v, want no record", body, q)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%q: the file stayed", body)
		}
	}
}

// TestDropRecordFollowsTheSavedFiles: the record is written at the first saved
// file, then at most once a second while files arrive, so a long drop of
// small files writes once a second and not once a file; flush writes the
// count as it is now whatever the clock says; after clear nothing writes it
// again.
func TestDropRecordFollowsTheSavedFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "floe", "quit-drop.json")
	tally := &dropTally{}
	clock := time.Date(2026, 10, 16, 14, 5, 0, 0, time.Local)
	rec := newDropRecord(path, "Acme", 12, `D:\Floe\Acme 2026-10-16 1405`, false, tally)
	rec.now = func() time.Time { return clock }
	// The write owed at the end of a window is the next test's; here it is
	// armed and never fires.
	rec.after = func(time.Duration, func()) func() bool { return func() bool { return true } }

	rec.fileDone()
	if _, ok := readQuitDrop(t, path); ok {
		t.Fatal("a record was written before any file was saved")
	}
	saved := func(n int) int {
		t.Helper()
		q, ok := readQuitDrop(t, path)
		if !ok {
			t.Fatalf("no record after %d saved files", n)
		}
		return q.Result.Saved
	}
	tally.add(transfer.FileDone{SavedName: "a.mov", Bytes: 10, Verified: true})
	rec.fileDone()
	if got := saved(1); got != 1 {
		t.Fatalf("first file: record says %d saved", got)
	}
	tally.add(transfer.FileDone{SavedName: "b.mov", Bytes: 10})
	clock = clock.Add(500 * time.Millisecond)
	rec.fileDone()
	if got := saved(2); got != 1 {
		t.Fatalf("half a second later the record was written again (%d saved)", got)
	}
	clock = clock.Add(600 * time.Millisecond)
	rec.fileDone()
	if got := saved(2); got != 2 {
		t.Fatalf("a second later the record says %d saved, want 2", got)
	}
	tally.add(transfer.FileDone{SavedName: "c.mov", Bytes: 10})
	rec.flush()
	q, _ := readQuitDrop(t, path)
	if q.Result.Saved != 3 || q.Result.Files != 12 || q.Label != "Acme" || q.At != clock.UnixMilli() || q.Result.Folder != `D:\Floe\Acme 2026-10-16 1405` {
		t.Fatalf("flushed record = %+v", q)
	}
	rec.clear()
	if _, ok := readQuitDrop(t, path); ok {
		t.Fatal("clear left the record")
	}
	tally.add(transfer.FileDone{SavedName: "d.mov", Bytes: 10})
	rec.flush()
	rec.fileDone()
	if _, ok := readQuitDrop(t, path); ok {
		t.Fatal("a cleared record was written again")
	}
	var none *dropRecord
	none.fileDone()
	none.flush()
	none.clear()
}

// TestDropRecordWritesWhatItsLastWindowSaved: files saved inside a window
// with no file after them (small files ahead of a long one) reach the record
// at the end of that window, not at the next saved file, which a process
// ended without the shutdown hook never gets to. One write is owed per
// window, a write before it covers it, and clear stops it.
func TestDropRecordWritesWhatItsLastWindowSaved(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quit-drop.json")
	tally := &dropTally{}
	clock := time.Date(2026, 10, 16, 14, 5, 0, 0, time.Local)
	rec := newDropRecord(path, "", 6, `D:\Floe\Request 2026-10-16 1405`, false, tally)
	rec.now = func() time.Time { return clock }
	var owed []time.Duration
	var fire func()
	stopped := 0
	rec.after = func(d time.Duration, f func()) func() bool {
		owed = append(owed, d)
		fire = f
		return func() bool { stopped++; return true }
	}
	saved := func() int {
		t.Helper()
		q, ok := readQuitDrop(t, path)
		if !ok {
			t.Fatal("no record")
		}
		return q.Result.Saved
	}

	tally.add(transfer.FileDone{SavedName: "a", Bytes: 1})
	rec.fileDone()
	for _, n := range []string{"b", "c", "d"} {
		clock = clock.Add(100 * time.Millisecond)
		tally.add(transfer.FileDone{SavedName: n, Bytes: 1})
		rec.fileDone()
	}
	if got := saved(); got != 1 {
		t.Fatalf("inside the window the record says %d saved, want 1", got)
	}
	if len(owed) != 1 || owed[0] != 900*time.Millisecond {
		t.Fatalf("owed writes %v, want one at the window's end (900ms)", owed)
	}
	clock = clock.Add(900 * time.Millisecond)
	fire()
	if got := saved(); got != 4 {
		t.Fatalf("at the window's end the record says %d saved, want 4", got)
	}

	// A write that comes first covers the owed one, which it stops.
	clock = clock.Add(100 * time.Millisecond)
	tally.add(transfer.FileDone{SavedName: "e", Bytes: 1})
	rec.fileDone()
	if len(owed) != 2 {
		t.Fatalf("owed writes %v, want a second", owed)
	}
	rec.flush()
	if got := saved(); got != 5 || stopped != 1 {
		t.Fatalf("flush: %d saved and %d owed writes stopped, want 5 and 1", got, stopped)
	}

	// clear stops an owed write, and one that fires anyway writes nothing.
	clock = clock.Add(100 * time.Millisecond)
	tally.add(transfer.FileDone{SavedName: "f", Bytes: 1})
	rec.fileDone()
	rec.clear()
	if stopped != 2 {
		t.Fatalf("clear stopped %d owed writes in all, want 2", stopped)
	}
	fire()
	if _, ok := readQuitDrop(t, path); ok {
		t.Fatal("an owed write after clear wrote the record again")
	}
}

// TestDropRecordRetriesAFailedWrite: on Windows the rename over the record
// fails while anything holds it open, and the release run of desktop-v0.3.2
// lost the owed write that way (the test below polls the file). A failed
// write is tried again a window later, a good write resets the count, and a
// record that never writes stops after quitRecordRetries tries in a row.
func TestDropRecordRetriesAFailedWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quit-drop.json")
	tally := &dropTally{}
	rec := newDropRecord(path, "", 5, `D:\Floe\Request 2026-10-16 1405`, false, tally)
	var owed []time.Duration
	var fire func()
	rec.after = func(d time.Duration, f func()) func() bool {
		owed = append(owed, d)
		fire = f
		return func() bool { return true }
	}
	failing := 1
	rec.save = func(p string, q quitDrop) error {
		if failing > 0 {
			failing--
			return errors.New("Access is denied.")
		}
		return saveQuitDrop(p, q)
	}

	tally.add(transfer.FileDone{SavedName: "a", Bytes: 1})
	rec.fileDone()
	if _, ok := readQuitDrop(t, path); ok {
		t.Fatal("a failed write left a record")
	}
	if len(owed) != 1 || owed[0] != quitRecordEvery {
		t.Fatalf("owed writes %v after a failed write, want one a window later", owed)
	}
	fire()
	if q, ok := readQuitDrop(t, path); !ok || q.Result.Saved != 1 {
		t.Fatalf("the retry wrote %+v (ok %v), want 1 saved", q.Result, ok)
	}
	if rec.failed != 0 {
		t.Fatalf("failed = %d after a good write, want 0", rec.failed)
	}

	// A record that can never be written is tried quitRecordRetries times.
	owed = nil
	failing = 1 << 30
	rec.flush()
	for i := 0; i < 2*quitRecordRetries && len(owed) > i; i++ {
		fire()
	}
	if len(owed) != quitRecordRetries {
		t.Fatalf("%d retries armed for a record that never writes, want %d", len(owed), quitRecordRetries)
	}
	rec.clear()
}

// TestDropRecordOwedWriteRuns is the same with the real timer: five files
// in the first second, then none, and the record says five. Its poller can
// hold the record open while the owed write renames over it, which the
// retry above now covers. The race also runs the other way: a poll that
// opens the record while that rename holds it fails on Windows with a
// sharing violation (seen on windows-latest in CI, 2026-10-28), so a poll
// that cannot read the record reads it again on the next tick.
func TestDropRecordOwedWriteRuns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quit-drop.json")
	tally := &dropTally{}
	rec := newDropRecord(path, "", 5, `D:\Floe\Request 2026-10-16 1405`, false, tally)
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		tally.add(transfer.FileDone{SavedName: n, Bytes: 1})
		rec.fileDone()
	}
	var q quitDrop
	var readErr error
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		var raw []byte
		if raw, readErr = os.ReadFile(path); readErr != nil {
			continue
		}
		q = quitDrop{}
		if err := json.Unmarshal(raw, &q); err != nil {
			t.Fatalf("the record is not JSON: %v", err)
		}
		if q.Result.Saved == 5 {
			rec.clear()
			return
		}
	}
	t.Fatalf("10 s after five files saved in the first second, the record says %d saved (last read error: %v)", q.Result.Saved, readErr)
}

// TestQuitMidDropKeepsTheRecord (deep QA A5-09): a quit during a drop ends the
// lane generation first, so the drop's own end never reaches the lane and no
// stopped snapshot ever left it; the saved files had no History row. Now the
// quit writes the record as the drop stands, and the drop's end, which loses
// the lane, leaves it for the next launch.
func TestQuitMidDropKeepsTheRecord(t *testing.T) {
	a, _ := laneApp(t, nil)
	path := filepath.Join(t.TempDir(), "quit-drop.json")
	folder := t.TempDir()
	d := &requestDrop{files: 12, folder: folder, auto: true}
	fillTally(&d.tally, 3)
	rec := newDropRecord(path, "Acme", 12, folder, true, &d.tally)
	d.record = rec
	forceGen(a, 1)
	if !a.setDropCancel(1, func() {}, rec) {
		t.Fatal("setDropCancel refused the lane's generation")
	}
	a.acceptDrop(1, RequestResult{Files: 12, Folder: folder, AutoAccepted: true})
	if _, ok := readQuitDrop(t, path); ok {
		t.Fatal("a record exists before any file was saved through the drop")
	}
	a.lane().closeForQuit()
	q, ok := readQuitDrop(t, path)
	if !ok {
		t.Fatal("the quit left no record of the drop")
	}
	if q.Result.Saved != 3 || q.Result.Files != 12 || q.Label != "Acme" || q.Result.Folder != folder || !q.Result.AutoAccepted || len(q.Result.Names) != 3 {
		t.Fatalf("record = %+v", q)
	}
	// The receive then returns, its connection closed, into a lane it no
	// longer owns.
	d.accepted.Store(true)
	_ = a.endRequestDrop(1, nil, d, errors.New("connection closed mid-transfer"))
	if _, ok := readQuitDrop(t, path); !ok {
		t.Fatal("the drop's end, after the quit, removed the record")
	}
}

// TestDropThatEndsOnItsOwnLeavesNoRecord: a drop that ends while it still owns
// the lane goes to History through its own snapshot, so its record goes.
func TestDropThatEndsOnItsOwnLeavesNoRecord(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"done", nil},
		{"stopped", &transfer.RefusedError{Code: transfer.CodeDiskFull, Saved: 2}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _ := laneApp(t, nil)
			path := filepath.Join(t.TempDir(), "quit-drop.json")
			folder := t.TempDir()
			d := &requestDrop{files: 2, folder: folder}
			fillTally(&d.tally, 2)
			d.record = newDropRecord(path, "", 2, folder, false, &d.tally)
			d.record.flush()
			if _, ok := readQuitDrop(t, path); !ok {
				t.Fatal("no record to remove")
			}
			forceGen(a, 1)
			a.setDropCancel(1, func() {}, d.record)
			a.acceptDrop(1, RequestResult{Files: 2, Folder: folder})
			d.accepted.Store(true)
			_ = a.endRequestDrop(1, nil, d, tc.err)
			if _, ok := readQuitDrop(t, path); ok {
				t.Fatal("a drop that ended on its own left its record")
			}
			// The quit after it writes nothing back.
			a.lane().closeForQuit()
			if _, ok := readQuitDrop(t, path); ok {
				t.Fatal("a quit after the drop ended wrote the record again")
			}
		})
	}
}

// TestRestoredDropIsTheStoppedDrop (ST13): the launch after the quit shows the
// drop once, as stopped with app-closed, gen 0 and the record's label and
// result, its time the record's; the frontend's History row and the stopped
// card come from that snapshot. Make link moves on from it like from any
// result.
func TestRestoredDropIsTheStoppedDrop(t *testing.T) {
	// Made before laneApp, so its removal runs after laneApp's cleanup has
	// waited for the lane: the Make link below returns at once, and its
	// goroutine's folder probe would race the removal ("not empty" on Windows).
	saveDir := t.TempDir()
	a, _ := laneApp(t, nil)
	at := time.Now().Add(-26 * time.Hour).UnixMilli()
	a.lane().restoreQuitDrop(quitDrop{Label: "Acme", At: at, Result: RequestResult{
		Files: 12, Saved: 4, Bytes: 40, Folder: `D:\Floe\Acme`, Names: []string{"a"}, Sizes: []int64{10}, NoNamedStreams: true,
	}})
	s := a.GetRequestLink()
	if s.State != "stopped" || s.Code != "app-closed" || s.Gen != 0 || s.Label != "Acme" || s.Link != "" {
		t.Fatalf("restored snapshot = %+v, want stopped app-closed at gen 0", s)
	}
	if s.Result == nil || s.Result.Saved != 4 || s.Result.Files != 12 || s.Result.EndedAt != at || s.Result.Folder != `D:\Floe\Acme` {
		t.Fatalf("restored result = %+v", s.Result)
	}
	if a.lane().closeGuardNow() || a.lane().live.Load() {
		t.Fatal("a restored drop holds the close guard or the one-link rule")
	}
	s = a.MakeRequestLink("x", saveDir, "24h", false)
	if s.State != "making" || s.Result != nil || s.Code != "" {
		t.Fatalf("Make link after a restored drop: %+v", s)
	}
}

// TestTakeQuitDropRemovesAStrayTemporaryFile: a process ended between the
// temporary file's write and its rename leaves quit-drop.json.tmp, which holds
// saved file names; the next launch removes it whether or not a record is
// there, so it never outlives the drop it was written for.
func TestTakeQuitDropRemovesAStrayTemporaryFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quit-drop.json")
	for _, withRecord := range []bool{false, true} {
		if err := os.WriteFile(path+".tmp", []byte(`{"label":"x","at":1,"result":{"files":1,"saved":1,"names":["secret.txt"]}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if withRecord {
			if err := saveQuitDrop(path, quitDrop{At: 1, Result: RequestResult{Files: 1, Saved: 1}}); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path+".tmp", []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if _, ok := takeQuitDrop(path); ok != withRecord {
			t.Fatalf("with a record %v: took one %v", withRecord, ok)
		}
		if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
			t.Fatalf("with a record %v: the temporary file stayed (%v)", withRecord, err)
		}
	}
}
