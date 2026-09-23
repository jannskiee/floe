package transfer

// What the desktop request lane needs from the engine beyond ReceiveOptions:
// the two volume questions, the 24-hour cap and the open-channel deadline.
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

// VolumeMaxFileSize reports the largest single file the volume under dir can
// hold: 4294967295 on FAT and FAT32, 0 when there is no limit this code knows
// of or the platform cannot say. The lane reads it for the prompt's
// drive-limit warning; layer 1 refuses a larger file on its own.
func VolumeMaxFileSize(dir string) (int64, error) { return volumeMaxFileSize(dir) }

// DropTimeLimit is the most time one request-link drop may take (spec 06 4.5
// step 12). There is no throughput floor and no too-slow code (E-24): a drop
// that is merely slow runs until this cap or the 60 s stall watchdog.
const DropTimeLimit = 24 * time.Hour

// DropTimeLimitReached reports whether a drop that started at startedAt has
// run for DropTimeLimit or longer at now. The lane stops such a drop with
// AbortWithCode(CodeTimeLimit) and closes the connection. Pure, so a test can
// hand it any clock.
func DropTimeLimitReached(startedAt, now time.Time) bool {
	return now.Sub(startedAt) >= DropTimeLimit
}

// StartIncomingDeadline arms the open-channel deadline (E-35, spec 06 4.5
// step 9): onExpire runs on its own goroutine once d has passed, unless cancel
// ran first. The lane starts it when the data channel opens and cancels it
// from OnIncoming, so a sender that holds the channel open with frames that
// are not a metadata (non-control strings, binary data with no file open),
// which keep the receive loop's idle watchdog from ever firing, is still
// stopped: the lane's onExpire sends AbortWithCode(CodeStopped), closes the
// connection, and the loop returns through its closed channel.
//
// Exactly one of the two wins: once cancel has returned, onExpire will not
// start, and once onExpire has started, cancel does not wait for it. Calling
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
