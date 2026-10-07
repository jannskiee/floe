package main

// Auto-accept for one request link (D-173, from D-135 D8 and D-137). A link
// made with the Make link form's Auto-accept switch on takes a drop inside
// Decide, without a prompt, only when nothing about that drop is unusual;
// every other drop asks exactly as on a link made with it off. The choice is
// per link (requestLane.autoAccept), off on every new form, never a setting,
// and never reaches the server or the visitor.
//
// What the automatic path still asks about (D-137 D11, unchanged by D-173):
//   - G4: any warning the prompt would carry (low-space,
//     file-too-large-for-drive, relay-over-cap, or a code this build does not
//     know), and a route this side could not read, since relay-over-cap is
//     computed only for a known relay;
//   - G5: free space this side could not read (an error, or -1 off Windows);
//   - G6: a volume that cannot carry the downloaded-file mark (FAT, FAT32,
//     exFAT, many network shares), or one that could not say within the
//     bound: the Done view's own bounded question, volumeLacksMark;
//   - G13: a drop that would leave less than 20 GiB or a tenth of the drive
//     free, and a drive whose size could not be read within the bound.
//
// The volume questions are asked here, in desktop/, behind seams, never in
// cli/engine/transfer, so the released floe binary and the go.work coupling
// are untouched. The decision reads the visitor's validated numbers and this
// PC's answers only, never a visitor string, and the one boolean it makes
// reaches no screen, log, file or wire.

import "time"

var (
	// requestVolumeSizeFn is the save volume's size in bytes, for G13's
	// floor (volume_windows.go; volume_other.go answers 0, unknown); a test
	// stands in any volume, so the runner's own drive never decides one.
	requestVolumeSizeFn = volumeSize
	// requestVolumeSizeBound is the longest the automatic path waits for that
	// answer, as volumeLacksMark waits for its own: a share that stops
	// answering would otherwise hold the prompt back for the SMB timeout.
	requestVolumeSizeBound = 2 * time.Second
)

// autoFloorBytes and autoFloorShare are G13's floor: an unattended drop must
// leave at least 20 GiB, and at least a tenth of the drive, free after it, or
// it asks. 20 GiB covers a Windows feature update's 6 to 11 GB with margin; a
// tenth keeps a large drive from being filled to its last 20 GiB.
const (
	autoFloorBytes = int64(20) << 30
	autoFloorShare = 10
)

// requestSpace is what the automatic path knows of the drop's volume.
type requestSpace struct {
	free         int64 // bytes this process may still write; meaningful only when freeKnown
	freeKnown    bool  // DiskFree answered with no error and not -1 (G5)
	capacity     int64 // the volume's size; 0 when it could not be read (G13 then asks)
	namedStreams bool  // the volume positively keeps the downloaded-file mark (G6)
}

// requestSpaceFor asks the save folder's volume, through the nearest folder
// that exists (the drop folder is made only at Accept). Free space is the
// answer requestPromptFor already got for pr, never asked twice (review R1
// F1: the second, unbounded call came out of the owner's answer window on a
// slow share). A volume that cannot answer is unknown in every field, so the
// drop asks. The two bounded questions run side by side, so a volume that
// answers neither holds the decision back by one bound, not two.
func requestSpaceFor(saveDir string, pr RequestPrompt) requestSpace {
	sp := requestSpace{free: pr.FreeBytes, freeKnown: pr.freeKnown}
	dir := nearestDir(saveDir)
	if dir == "" {
		return requestSpace{}
	}
	size := make(chan int64, 1)
	go func() { size <- volumeCapacity(dir) }()
	sp.namedStreams = !volumeLacksMark(dir)
	sp.capacity = <-size
	return sp
}

// volumeCapacity is the size of the volume under dir, or 0 when it could not
// be read: an error, a negative answer, or none within requestVolumeSizeBound.
// Asked on its own goroutine, as volumeLacksMark asks: the answer channel has
// room for the late reply, so the goroutine ends on its own and the reply is
// dropped; it touches no lane state.
func volumeCapacity(dir string) int64 {
	type answer struct {
		size int64
		err  error
	}
	ask := requestVolumeSizeFn // read here, so a later swap cannot race the goroutine
	reply := make(chan answer, 1)
	go func() {
		size, err := ask(dir)
		reply <- answer{size, err}
	}()
	bound := time.NewTimer(requestVolumeSizeBound)
	defer bound.Stop()
	select {
	case a := <-reply:
		if a.err != nil || a.size < 0 {
			return 0
		}
		return a.size
	case <-bound.C:
		return 0
	}
}

// autoPromptOK is G4, the half of autoEligible that needs no volume: a prompt
// with no warning on a known route. requestDecide asks it first, so a drop
// that will ask anyway never waits on a volume question (review R1, the old
// R3 residual).
func autoPromptOK(pr RequestPrompt, route string) bool {
	if len(pr.Warnings) > 0 {
		return false // the owner must see a prompt that warns
	}
	// relay-over-cap is computed only for a known relay
	return route == "direct" || route == "relay"
}

// autoEligible reports whether a drop on a link made with Auto-accept on may
// be accepted without asking: pr is the prompt it would have shown, built
// from the visitor's validated numbers and this PC's values only, route the
// pairing's route, sp the volume. Anything unknown answers false, so the drop
// asks.
func autoEligible(pr RequestPrompt, route string, sp requestSpace) bool {
	if !autoPromptOK(pr, route) {
		return false
	}
	if !sp.freeKnown {
		return false // G5
	}
	if !sp.namedStreams {
		return false // G6: no downloaded-file mark on this volume, or no answer
	}
	if sp.capacity <= 0 {
		return false // G13: no floor without the drive's size
	}
	floor := max(autoFloorBytes, sp.capacity/autoFloorShare)
	// free is at least 0 here and TotalBytes at most 2^53 - 1 (the engine's
	// byteCount), so the subtraction cannot overflow; a negative total never
	// comes from the engine and is refused rather than trusted.
	return pr.TotalBytes >= 0 && sp.free-pr.TotalBytes >= floor // G13
}
