package transfer

// What the desktop request lane needs from the engine beyond ReceiveOptions:
// the volume questions, the 24-hour cap and the open-channel deadline.
// Each is a helper the lane applies around the receive loop, so the loop
// itself gains no modes and the CLI's behavior does not change.

import (
	"sync"
	"time"
)

// DiskFree reports the bytes this process may still write under dir, or -1
// when this platform cannot say (every GOOS but Windows). The lane reads it
// for the Accept prompt's space warning; the engine's own per-file check reads
// the same answer (ReceiveLimits.FreeReserve).
func DiskFree(dir string) (int64, error) { return diskFree(dir) }

// VolumeNamedStreams reports whether the volume under dir can carry the
// Windows downloaded-file mark, the Zone.Identifier stream applyMOTW writes:
// false on FAT32, exFAT and many network shares, where Windows then has
// nothing to warn with at open time, and false off Windows, where no mark is
// written at all. The lane reads it for the Done view's not-scanned line. An
// error means the volume could not say.
func VolumeNamedStreams(dir string) (bool, error) { return volumeNamedStreams(dir) }

// DropTimeLimit is the most time one request-link drop may take (spec 06 4.5
// step 12). There is no throughput floor and no too-slow code (E-24): a drop
// that is merely slow runs until this cap or the 60 s stall watchdog.
const DropTimeLimit = 24 * time.Hour

// StartIncomingDeadline arms the open-channel deadline (E-35, spec 06 4.5
// step 9): onExpire runs on its own goroutine once d has passed, unless cancel
// ran first. The lane starts it when the data channel opens and cancels it
// from OnIncoming, so a sender that holds the channel open with frames that
// are not a metadata (non-control strings, binary data with no file open),
// which keep the receive loop's idle watchdog from ever firing, is still
// stopped: the lane's onExpire sends AbortWithCode(CodeStopped), closes the
// connection, and the loop returns through its closed channel.
//
// Exactly one of the two wins. A cancel that wins means onExpire never runs.
// An expiry that wins is settled before onExpire is called, so a cancel racing
// it can return just before onExpire starts, and never waits for it. Calling
// cancel more than once is safe.
func StartIncomingDeadline(d time.Duration, onExpire func()) (cancel func()) {
	var mu sync.Mutex
	settled := false
	t := time.AfterFunc(d, func() {
		mu.Lock()
		if settled {
			mu.Unlock()
			return
		}
		settled = true
		mu.Unlock()
		onExpire()
	})
	return func() {
		mu.Lock()
		settled = true
		mu.Unlock()
		t.Stop()
	}
}
