package transfer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The registry of in-flight .part staging files, so an exit path that cannot
// run deferred cleanup (the CLI's Ctrl+C handler exits the process; the
// desktop's shutdown hook fires while a transfer goroutine may still hold its
// handle) can still tidy the staging file.
//
// Only .part files are ever registered, and the receiver unregisters BEFORE
// committing. That ordering is load-bearing: an empirical review proved that
// removing a registered path can otherwise race the commit rename, with the
// delete disposition following the file to its final name so that both
// syscalls report success and the committed file vanishes.
//
// Each entry has its own lock, and that lock, not partialMu, is what keeps
// the ordering. An abandon holds an entry's lock across that one file's Close
// and Remove; unregisterPartial deletes the entry and then takes its lock
// before returning. So when unregisterPartial returns, an abandon has either
// finished closing and removing the file (the owner's own Close then fails
// with os.ErrClosed, the receiver's fingerprint for an abandoned transfer) or
// will never touch it (the entry is marked done). The receiver therefore
// cannot be inside the commit while an abandon works on its file, no
// registered path is ever mid-rename, and a completed file can never be
// deleted here. The owner of the file being closed still waits for the
// abandon, as it always has: that wait is what rules the race above out.
//
// partialMu guards the map only and is never held across a syscall. It used
// to be held across every Close and Remove, and on Windows a Close waits for
// every outstanding reference on the handle: one was seen to park under load
// with the lock held (its cause is not established), and every other file's
// register and unregister, which is the receive loop, parked behind it. With
// the per-entry rule only the parked file's owner waits.
//
// An abandon that takes an entry's lock after the last byte but before the
// owner's unregister deletes a complete .part during an explicit user abort,
// which is accepted: the sender was never told the transfer completed.
//
// A map rather than a single slot: the desktop shares this package and can in
// principle run more than one receive in a process lifetime; a single slot
// could be cleared by the wrong one.
var (
	partialMu    sync.Mutex
	partialFiles = map[*os.File]*partialEntry{}
)

// partialEntry is one registered file's ownership lock. done records that the
// file has been dealt with, closed and removed by an abandon or handed back
// by its owner's unregister, so whichever comes second leaves it alone.
type partialEntry struct {
	mu   sync.Mutex
	done bool
}

func registerPartial(f *os.File) {
	partialMu.Lock()
	defer partialMu.Unlock()
	partialFiles[f] = &partialEntry{}
}

// unregisterPartial hands the file back to its owner. Deleting the entry
// under partialMu hides it from every later abandon; taking the entry's own
// lock afterwards waits out an abandon that is closing this file right now;
// marking it done makes an abandon that holds it in its snapshot, but has not
// reached it yet, skip it.
func unregisterPartial(f *os.File) {
	partialMu.Lock()
	e := partialFiles[f]
	delete(partialFiles, f)
	partialMu.Unlock()
	if e == nil {
		return
	}
	e.mu.Lock()
	e.done = true
	e.mu.Unlock()
}

// discardPart drops a staging file the receive loop is giving up on.
//
// The order is the whole correctness argument and it is why this is one
// function rather than three copies. Unregister FIRST, so a concurrent
// AbandonPartials cannot pick the handle up after we have decided to drop it.
// Then use our own Close as the ownership test: it succeeding means abandon
// never touched this file and the path is still ours to remove; it failing
// means abandon owned the endgame and has already removed it, so removing by
// path here would delete whatever now sits at that name. A torture test
// proved exactly that theft when the code trusted the path string alone.
//
// There were three verbatim copies of this before, which is three places to
// get an ordering this subtle wrong.
func discardPart(f *os.File) {
	name := f.Name()
	unregisterPartial(f)
	if f.Close() == nil {
		_ = os.Remove(name)
	}
}

// closePartial is the Close AbandonPartials makes. A seam: a Close that parks
// cannot be produced on demand, so a test swaps in one that blocks.
var closePartial = func(f *os.File) error { return f.Close() }

// AbandonPartials best-effort removes every in-flight staging file. Close
// comes first: Go opens files on Windows without FILE_SHARE_DELETE, so
// removing a file the receive loop still holds open fails with a sharing
// violation, and the receive loop's own next Write failing with "file already
// closed" is irrelevant to a process that is exiting. Callers: the CLI signal
// handler before os.Exit and the desktop's shutdown hook, both through
// AbandonPartialsWithin.
//
// Three phases, so partialMu is never held across a syscall (see the registry
// comment): snapshot the entries under partialMu; close and remove each file
// under its entry's lock only, skipping one its owner has already
// unregistered; delete the entries under partialMu.
func AbandonPartials() {
	type pending struct {
		f *os.File
		e *partialEntry
	}
	partialMu.Lock()
	// Read once: a test restores the seam while an abandon that
	// AbandonPartialsWithin stopped waiting for may still be running.
	closeFile := closePartial
	snapshot := make([]pending, 0, len(partialFiles))
	for f, e := range partialFiles {
		snapshot = append(snapshot, pending{f, e})
	}
	partialMu.Unlock()

	for _, p := range snapshot {
		p.e.mu.Lock()
		if !p.e.done {
			name := p.f.Name()
			_ = closeFile(p.f)
			_ = os.Remove(name)
			p.e.done = true
		}
		p.e.mu.Unlock()
	}

	partialMu.Lock()
	for _, p := range snapshot {
		if partialFiles[p.f] == p.e {
			delete(partialFiles, p.f)
		}
	}
	partialMu.Unlock()
}

// AbandonPartialsWithin runs AbandonPartials and waits for it at most d,
// reporting whether it finished. The exit paths call this form so a Close
// that parks cannot hold the process: the abandon carries on in the
// background until the process ends. A file it has not finished stays as a
// .part unless its owner completes and verifies it first; partSuffix
// guarantees a .part is never mistaken for a finished file, and the next
// receive de-collides around it.
func AbandonPartialsWithin(d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		defer close(done)
		AbandonPartials()
	}()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

// partSuffix marks a staging file that is still being written. The full final
// name stays in front of it ("report.pdf.part"), so Explorer shows what the
// file will become, and ".part" is the convention download managers established
// for "incomplete": a crash-stale leftover can never be mistaken for a finished
// file. Bytes always land in a .part first; the final name is only ever taken
// by the rename in commitPart, so a process kill at any moment leaves nothing
// on disk that looks complete.
const partSuffix = ".part"

// maxDecollide bounds the suffix search. It is a backstop against a peer that
// sends the same name forever, not a tuning knob: with the scan resumed by
// nameHints the walk is linear in the number of files, so the number no longer
// costs anything to leave high, and lowering it would newly refuse a directory
// that legitimately holds that many files with one name.
const maxDecollide = 100000

// nameHints remembers, for one receive session, the next de-collision index to
// try for a base path.
//
// Without it claimPart restarts at i == 0 for every file, so N incoming names
// that land on one name cost N^2 Lstats. That is not a rare shape: sanitizing
// folds seven reserved characters to "_" on Windows, so a<b.txt, a>b.txt,
// a:b.txt, a?b.txt, a|b.txt, a*b.txt and a"b.txt all become a_b.txt. Measured
// on Windows 11 before this: 2.8 s for 250 such files, 10.7 s for 500, 42.4 s
// for 1000. It runs inside the metadata handler, ahead of the ack and outside
// the select, so the stall watchdog never fires and the sender simply waits.
//
// Per session, not per process: the desktop app runs for days, and a map that
// outlived a transfer would keep numbering upward against a directory the
// person may have emptied in between.
type nameHints struct {
	next map[string]int
	fold bool
}

// newNameHints reports whether to fold case from goos rather than a build tag,
// matching sanitizeComponent, so every branch is exercised on every CI leg.
func newNameHints(goos string) *nameHints {
	return &nameHints{next: map[string]int{}, fold: goos == "windows" || goos == "darwin"}
}

// key folds case where the filesystem does. On NTFS and a default APFS volume
// "Shot.png" and "shot.png" are two strings but one file, so an unfolded map
// would give every case variant its own cold scan and hand the quadratic back
// to whoever picks the names.
func (h *nameHints) key(base string) string {
	if h.fold {
		return strings.ToLower(base)
	}
	return base
}

// start is where the next scan for base begins. A nil *nameHints means no
// memory, which is the cold-scan behavior and is only for tests that pin it.
func (h *nameHints) start(base string) int {
	if h == nil {
		return 0
	}
	return h.next[h.key(base)]
}

// record notes that index i is now taken. The hint only ever moves forward, so
// a candidate freed later in the session costs a higher suffix and never a lost
// file: O_EXCL, not the hint, is what makes a claim exclusive.
func (h *nameHints) record(base string, i int) {
	if h == nil {
		return
	}
	if k := h.key(base); i+1 > h.next[k] {
		h.next[k] = i + 1
	}
}

// candidatePath returns the i-th de-collision candidate for base: base itself
// for i == 0, then "stem (i)ext". Shared by claimPart and commitPart so a
// commit-time re-collision numbers from the base and can never produce
// "shot (1) (1).png".
func candidatePath(base string, i int) string {
	if i == 0 {
		return base
	}
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	return fmt.Sprintf("%s (%d)%s", stem, i, ext)
}

// claimPart reserves a final name for an incoming file and opens its .part
// staging file. It never overwrites: a candidate whose final name is taken by
// an existing file or directory is skipped, as is one whose .part exists (a
// concurrent receive's live claim, or a stale leftover from a crash, which is
// deliberately not reused because it cannot be told apart from a live one).
// The O_EXCL open of the .part is the atomic claim, so two concurrent receives
// racing for the same name cannot both win a candidate.
//
// A candidate occupied by something that is neither a regular file nor a
// directory (a device that survived name sanitizing) aborts loudly instead of
// advancing: writing "past" a device would succeed byte-for-byte and vanish,
// and failing before any bandwidth is spent beats failing after.
func claimPart(base string, hints *nameHints) (part *os.File, dest string, err error) {
	for i := hints.start(base); i < maxDecollide; i++ {
		candidate := candidatePath(base, i)
		if st, lerr := os.Lstat(candidate); lerr == nil {
			if !st.Mode().IsRegular() && !st.IsDir() {
				return nil, "", fmt.Errorf("refusing to write %s: not a regular file (%s)",
					candidate, st.Mode())
			}
			continue // final name taken; advance
		}
		f, oerr := os.OpenFile(candidate+partSuffix, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0666)
		if oerr == nil {
			hints.record(base, i)
			return f, candidate, nil
		}
		if !os.IsExist(oerr) {
			return nil, "", oerr
		}
		// A live or stale .part blocks this candidate; advance.
	}
	return nil, "", fmt.Errorf("too many files named like %q", filepath.Base(base))
}

// commitPart publishes a verified .part staging file at its final name,
// never overwriting anything that is not ours.
//
// Go's os.Rename REPLACES an existing destination on every platform, Windows
// included, so a bare rename here would silently clobber a file that appeared
// at the destination mid-transfer. renameNoReplace makes the never-overwrite
// claim instead: atomically on Windows (MoveFileEx without the replace flag,
// so the final name never holds anything but the complete file, not even for
// an instant), and via a placeholder created and consumed inside the one call
// elsewhere.
//
// The rename gets a bounded retry because an AV scanner or indexer can hold
// the just-closed .part briefly (Go's Windows opens grant no
// FILE_SHARE_DELETE). A "destination exists" failure advances to the next
// candidate immediately instead of retrying: waiting cannot make a name free.
// On final failure the .part is deliberately LEFT IN PLACE: its bytes are
// complete and verified, and deleting them over a transient lock would be
// data loss.
func commitPart(partPath, claimedDest, basePath string) (dest string, err error) {
	for i := 0; i < maxDecollide; i++ {
		candidate := candidatePath(basePath, i)
		if i > 0 && candidate == claimedDest {
			continue // already tried first, below
		}
		if i == 0 {
			candidate = claimedDest // our claim gets the first shot
		}
		// Another receiver's live claim on this candidate; leave it alone.
		if candidate+partSuffix != partPath {
			if _, perr := os.Lstat(candidate + partSuffix); perr == nil {
				continue
			}
		}
		var rerr error
		for attempt := 0; attempt < 5; attempt++ {
			rerr = renameNoReplace(partPath, candidate)
			if rerr == nil {
				return candidate, nil
			}
			if os.IsExist(rerr) {
				break // name taken since the claim; advance to the next
			}
			if attempt < 4 {
				time.Sleep(200 * time.Millisecond)
			}
		}
		if os.IsExist(rerr) {
			continue
		}
		return "", fmt.Errorf("could not move %s into place: %w", partPath, rerr)
	}
	return "", fmt.Errorf("too many files named like %q", filepath.Base(basePath))
}
