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
// committing, under this same mutex. That ordering is load-bearing: an
// empirical review proved that removing a registered path can otherwise race
// the commit rename, with the delete disposition following the file to its
// final name so that both syscalls report success and the committed file
// vanishes. With unregister-first the receiver cannot be inside the commit
// while an abandon holds the lock (unregister synchronizes on it), and once
// unregistered the path is invisible to abandon; so no registered path is
// ever mid-rename, and a completed file can never be deleted here. An abandon
// that wins the lock in the instant between verification and unregistration
// deletes a verified .part during an explicit user abort, which is accepted:
// the sender was never told the transfer completed.
//
// A map rather than a single slot: the desktop shares this package and can in
// principle run more than one receive in a process lifetime; a single slot
// could be cleared by the wrong one.
var (
	partialMu    sync.Mutex
	partialFiles = map[*os.File]struct{}{}
)

func registerPartial(f *os.File) {
	partialMu.Lock()
	defer partialMu.Unlock()
	partialFiles[f] = struct{}{}
}

func unregisterPartial(f *os.File) {
	partialMu.Lock()
	defer partialMu.Unlock()
	delete(partialFiles, f)
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

// AbandonPartials best-effort removes every in-flight staging file. Close
// comes first: Go opens files on Windows without FILE_SHARE_DELETE, so
// removing a file the receive loop still holds open fails with a sharing
// violation, and the receive loop's own next Write failing with "file already
// closed" is irrelevant to a process that is exiting. Callers: the CLI signal
// handler before os.Exit, the desktop's shutdown hook.
func AbandonPartials() {
	partialMu.Lock()
	defer partialMu.Unlock()
	for f := range partialFiles {
		name := f.Name()
		_ = f.Close()
		_ = os.Remove(name)
		delete(partialFiles, f)
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
func claimPart(base string) (part *os.File, dest string, err error) {
	for i := 0; i < 100000; i++ {
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
	for i := 0; i < 100000; i++ {
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
