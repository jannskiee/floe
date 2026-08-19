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
// Only .part files are ever registered, and a successful commit renames that
// path away before the receiver unregisters, so a late AbandonPartials call
// finds nothing at the path and removes nothing. A completed file's final
// path never enters this map, which is what makes calling AbandonPartials at
// ANY moment safe: the historical hazard of a shutdown hook deleting a file
// that had just finished cannot occur by construction.
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
