package transfer

import (
	"os"
	"sync"
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
