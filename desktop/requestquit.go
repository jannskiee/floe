package main

// The record of a request drop that Floe closed during (deep QA A5-09, ST13).
// A quit ends the lane generation before the drop's own end can reach it, and
// a Windows Update restart or a Store update ends the process without the
// shutdown hook (Wails v2 does nothing on WM_ENDSESSION), so the saved files
// of such a drop had no History row and no line anywhere. The drop keeps this
// record beside desktop.json while its files arrive; the quit writes it once
// more as the drop stands, and a drop that ends on its own removes it. The
// next launch reads it once and shows the drop as stopped, code app-closed,
// which the frontend draws as ST13 and puts in History like any stopped drop.

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// quitRecordEvery is the most often the record is written while files arrive:
// a drop of 10,000 small files writes it about once a second, not once a
// file. A file saved inside that second is written when the second is over,
// even with no file after it, and the quit writes the count as it is, so only
// a process ended without the shutdown hook can miss the files of its last
// second.
const quitRecordEvery = time.Second

// quitRecordRetries is how many failed writes in a row are tried again a
// window later. On Windows the rename over the record fails with "Access is
// denied" while anything holds the record open (an antivirus scan, a reader;
// measured 2026-10-16 on Go 1.26 and 1.27), and the release run of
// desktop-v0.3.2 lost the owed write that way. Without a retry the files it
// covered waited for the next saved file, which a hookless end never sees.
// The bound keeps a record that can never be written (a read-only profile)
// from retrying for the whole drop.
const quitRecordRetries = 5

// quitRecordMax bounds the record a launch reads: 200 names of the longest
// path the engine saves is under 200 KiB.
const quitRecordMax = 1 << 20

// quitDrop is the record: the owner's label, when it was last written (unix
// milliseconds), and the drop's result as its tally had it then. The names
// are the engine's display-safe saved names, at most requestResultNames.
type quitDrop struct {
	Label  string        `json:"label"`
	At     int64         `json:"at"`
	Result RequestResult `json:"result"`
}

// quitDropPath is the record's file, beside desktop.json, or "" when the OS
// config directory cannot be found (no record is written or read then).
func quitDropPath() string { return floeConfigFile("quit-drop.json") }

// saveQuitDrop writes q to path through a temporary file and a rename, so a
// process ended mid-write leaves the last whole record or none.
func saveQuitDrop(path string, q quitDrop) error {
	body, err := json.Marshal(q)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, body)
}

// takeQuitDrop reads the record at path and removes the file, so the drop
// shows on one launch only. The file sits in a folder the owner can edit, so
// it is read the way normalizeSnapshot reads a snapshot: counts in range, at
// most requestResultNames names with a size or -1 beside each, an absolute
// folder or none, the label as Make link cuts it, and a time that is not in
// the future. NoNamedStreams is true, because a launch cannot know it (H7
// S-7: every doubt keeps the not-scanned line). A record with nothing saved,
// more files than a drop may hold, or no JSON at all is no record.
func takeQuitDrop(path string) (quitDrop, bool) {
	if path == "" {
		return quitDrop{}, false
	}
	// A process ended between saveQuitDrop's write and its rename leaves the
	// temporary file, saved names and all; nothing else would ever remove it.
	_ = os.Remove(path + ".tmp")
	f, err := os.Open(path)
	if err != nil {
		return quitDrop{}, false
	}
	raw, err := io.ReadAll(io.LimitReader(f, quitRecordMax))
	f.Close()
	_ = os.Remove(path)
	var q quitDrop
	if err != nil || json.Unmarshal(raw, &q) != nil {
		return quitDrop{}, false
	}
	r := &q.Result
	if r.Saved < 1 || r.Saved > requestMaxFiles {
		return quitDrop{}, false
	}
	r.Files = min(max(r.Files, r.Saved), requestMaxFiles)
	r.Bytes = max(r.Bytes, 0)
	r.Verified = min(max(r.Verified, 0), r.Saved)
	r.Renamed = min(max(r.Renamed, 0), r.Saved)
	if len(r.Names) > requestResultNames {
		r.Names = r.Names[:requestResultNames]
	}
	sizes := make([]int64, len(r.Names))
	for i := range sizes {
		sizes[i] = -1
		if i < len(r.Sizes) && r.Sizes[i] >= 0 {
			sizes[i] = r.Sizes[i]
		}
	}
	r.Sizes = sizes
	if !filepath.IsAbs(r.Folder) {
		r.Folder = ""
	}
	r.NoNamedStreams = true
	r.EndedAt = 0
	q.Label = displayLabel(q.Label)
	if now := time.Now().UnixMilli(); q.At <= 0 || q.At > now {
		q.At = now
	}
	return q, true
}

// dropRecord keeps one accepted drop's record in step with its tally. It is
// made at Accept (acceptRequestDrop), written by the receive loop after a
// saved file, flushed by the quit, and cleared when the drop ends while it
// still owns the lane. Every method is safe on a nil *dropRecord, which keeps
// nothing.
type dropRecord struct {
	mu      sync.Mutex
	path    string
	label   string
	files   int
	folder  string
	auto    bool
	tally   *dropTally
	last    time.Time // the last write; zero before the first
	cleared bool      // the drop ended on its own: nothing writes the record again
	now     func() time.Time
	// owed stops the write armed for files saved inside the last second, or
	// for a failed write's retry, nil when none is armed. after arms it; a
	// test stands in its own, as it does for save.
	owed   func() bool
	after  func(time.Duration, func()) (stop func() bool)
	save   func(path string, q quitDrop) error
	failed int // failed writes in a row since the last good one
}

// newDropRecord is the record of a drop of files files into folder, kept at
// path ("" keeps nothing).
func newDropRecord(path, label string, files int, folder string, auto bool, tally *dropTally) *dropRecord {
	return &dropRecord{path: path, label: label, files: files, folder: folder, auto: auto, tally: tally, now: time.Now,
		after: func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop },
		save:  saveQuitDrop}
}

// fileDone writes the record after a saved file, at most once a
// quitRecordEvery. A file inside that window arms one write for its end
// instead: without it, files that land early in a window with no file after
// them (small files ahead of a long one) stay out of the record until the
// next file, which a hookless end never sees. It runs on the receive loop,
// after the tally counted the file.
func (r *dropRecord) fileDone() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.last.IsZero() {
		if wait := quitRecordEvery - r.now().Sub(r.last); wait > 0 {
			if r.owed == nil {
				r.owed = r.after(wait, r.writeOwed)
			}
			return
		}
	}
	r.writeLocked()
}

// writeOwed is the write fileDone armed for the end of a window.
func (r *dropRecord) writeOwed() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.owed = nil
	r.writeLocked()
}

// flush writes the record as the drop stands now, for the quit.
func (r *dropRecord) flush() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeLocked()
}

// clear removes the record of a drop that ended on its own: its own snapshot
// takes it to History.
func (r *dropRecord) clear() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleared = true
	r.stopOwedLocked()
	if r.path != "" {
		_ = os.Remove(r.path)
	}
}

// writeLocked writes the record when a file was saved: with none, a launch
// would have nothing to show (a stopped drop with nothing saved has no History
// row) and nothing is written. A failed write keeps the last one and is tried
// again a window later, up to quitRecordRetries in a row. Any write covers the
// files an armed one was owed for, so it stops that one.
func (r *dropRecord) writeLocked() {
	if r.cleared || r.path == "" {
		return
	}
	r.stopOwedLocked()
	res := r.tally.result(r.files, r.folder)
	if res.Saved < 1 {
		return
	}
	res.AutoAccepted = r.auto
	res.NoNamedStreams = true
	now := r.now()
	if r.save(r.path, quitDrop{Label: r.label, At: now.UnixMilli(), Result: res}) == nil {
		r.last = now
		r.failed = 0
		return
	}
	r.failed++
	if r.failed <= quitRecordRetries {
		r.owed = r.after(quitRecordEvery, r.writeOwed)
	}
}

// stopOwedLocked stops the write fileDone armed, if one is.
func (r *dropRecord) stopOwedLocked() {
	if r.owed != nil {
		r.owed()
		r.owed = nil
	}
}

// restoreQuitDrop shows the record a launch read (takeQuitDrop) as the lane's
// state: stopped with app-closed, generation 0, the record's label and result,
// and the time it was written as EndedAt, so History dates the row by the
// drop, not by the launch. ok false changes nothing. The lane holds no link,
// so the close guard and the one-link rule stay off, and Make link moves on
// from it like from any result.
func (l *requestLane) restoreQuitDrop(q quitDrop, ok bool) {
	if !ok {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	res := q.Result
	res.EndedAt = q.At
	l.label = q.Label
	l.result = &res
	l.setStateLocked("stopped", "app-closed")
}
