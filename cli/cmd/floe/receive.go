package main

// The `floe receive` command, including its own flags. Cobra registers them
// from the init below; Go runs a package's init functions in file-name order,
// and receive.go still sorts after main.go, so the root flags are still
// registered first.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
	"github.com/spf13/cobra"
)

var (
	flagOutput     string
	flagAutoAccept bool
	flagNoReport   bool
)

// errFloeLinkOtherServer ends a receive of a room link made on floe.one while
// another server is chosen (runReceive). execute prints it as an outcome,
// alone on the indent, and main exits 1. Added by FU-53 and approved by the
// owner as written (D-156, approved-copy-cli.txt), byte for byte.
var errFloeLinkOtherServer = errors.New("That link is for floe.one, but this Floe is set to use another server. Unset FLOE_SERVER or use --server https://api.floe.one, then try again.")

// errOtherLinkFloeServer ends a receive of a room link made on another server
// while no server is chosen, so its room id would go to api.floe.one, which
// never held the room. Approved by the owner as written (round 6 of the docs
// final run, approved-copy-cli.txt).
var errOtherLinkFloeServer = errors.New("That link is for another Floe server, but this Floe is set to use floe.one. Use --server with that server's address, then try again.")

var receiveCmd = &cobra.Command{
	Use:   "receive <code | link>",
	Short: "Receive files from a peer",
	Long: `Receive files from a peer using a code or link.

After a successful transfer the receiver posts only the total byte count to
Floe's signaling server to power the public global-transfer counter. No file
names, contents, or identities are included. To opt out of this report, use
--no-report or set FLOE_NO_STATS=1 in your environment.`,
	Args:              cobra.ExactArgs(1),
	ValidArgsFunction: cobra.NoFileCompletions,
	RunE:              runReceive,
}

func init() {
	receiveCmd.Flags().StringVarP(&flagOutput, "output", "o", ".",
		"directory to save received files")
	if err := receiveCmd.MarkFlagDirname("output"); err != nil {
		panic(err)
	}
	receiveCmd.Flags().BoolVarP(&flagAutoAccept, "yes", "y", false,
		"auto-accept incoming files without confirmation")
	receiveCmd.Flags().BoolVar(&flagNoReport, "no-report", false,
		"do not report transferred bytes to Floe's public global counter")
}

func runReceive(cmd *cobra.Command, args []string) error {
	input := args[0]

	// Ctrl+C's stop step (FU-54): left in place for the rest of the process,
	// and a no-op until the data channel is open.
	r := &receiveRun{}
	step := r.stop
	interruptStop.Store(&step)

	fmt.Println()

	// 1. Resolve the input to a room ID
	//    Input can be: "olive-tiger-castle" (code) or a full URL
	roomId, err := code.Resolve(flagServer, input)
	if err != nil {
		// A request or drop link (TL-33, E-10) comes back as the engine's
		// sentinel, whose text is the approved sentence. Never put in the
		// wrapper below: it quotes the pasted input, which for a request link
		// is the room id in the fragment (desktop/transfer.go does the same).
		//
		// It prints in the approved form (approved-copy-cli.txt, TL-33): the
		// sentence alone on the two-space indent, without "Error: ", because
		// a refusal is an outcome and not a usage mistake. execute prints an
		// outcomeError that way, once, and main still exits 1 on it.
		if errors.Is(err, code.ErrRequestLink) || errors.Is(err, code.ErrDropLink) {
			return outcomeError{err}
		}
		// A room link whose room value is not a room id, cut short when it
		// was copied (A4-B27): the request-link send's line for an incomplete
		// link (TL-09), whose advice holds for a room link too, as an outcome
		// and without the wrapper, which would print the link back.
		if errors.Is(err, code.ErrIncompleteLink) {
			return outcomeError{errors.New(lineIncompleteLink)}
		}
		// A request link in a shape Resolve does not refuse as one (a
		// percent-encoded #, a bad escape, a mail-safety redirector, the whole
		// link percent-encoded) still carries its key, and the wrapper below
		// would print it. The send refuses the same shapes by the same rule
		// (looksLikeRequestLink, FU-46 L2); receive ends on TL-33 for them too
		// (FU-53 review 1 L-3).
		if looksLikeRequestLink(input) {
			return outcomeError{code.ErrRequestLink}
		}
		// An input that holds a room id, or is a room link, in a shape
		// Resolve cannot use: a room id pasted alone (a request link's
		// fragment copied without the link), a room link percent-encoded
		// whole, inside a mail-safety redirector or behind a host that cannot
		// be read, or one cut off at its room=. The incomplete-link line
		// again (TL-09), whose advice fits each, because the wrapper below
		// would print the room id (CLI-04). Only code-shaped input and links
		// that carry no room reach the wrapper.
		if code.HoldsRoomID(input) || looksLikeRoomLink(input) {
			return outcomeError{errors.New(lineIncompleteLink)}
		}
		return fmt.Errorf("could not resolve %q: %w", input, err)
	}
	// A room link names the server that holds its room, and join-room hands
	// the room id to whichever server is chosen, so the two must agree before
	// any network call: Resolve reads a link without one, and only a code,
	// which has no host, goes to the server. A floe.one link with another
	// server chosen (FLOE_SERVER, a self-hoster's standing setting, or
	// --server), and a link on another host with none chosen, both end here,
	// each with the line that names its fix. code.CheckLinkServer is the
	// request-link send's host rule (code.LinkServerMismatch, FU-32 F5-4) for
	// an input that may be a code (FU-53, FU-46 review 1 L5).
	switch code.CheckLinkServer(input, serverChosen(cmd, os.Getenv), flagServer) {
	case code.LinkFloeOneOtherServer:
		return outcomeError{errFloeLinkOtherServer}
	case code.LinkOtherNoServer:
		return outcomeError{errOtherLinkFloeServer}
	}

	// 2. Check that the output directory exists or can be made, and leave it
	//    unmade: the receive makes it when it saves its first file (the
	//    engine's claim), so a start that fails, a decline and a sender that
	//    never sends leave no empty folder behind. Here, before the join,
	//    because the sender's code is spent once this side takes its seat: an
	//    -o that cannot be made must end the command while the same code can
	//    still be tried again.
	if err := checkOutputDir(flagOutput); err != nil {
		return fmt.Errorf("cannot create output directory %s: %w", flagOutput, err)
	}
	absOutput, _ := filepath.Abs(flagOutput)

	// 3. Fetch ICE credentials
	iceServers, degraded, err := fetchICE(flagServer)
	if err != nil {
		return fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}
	// Before the room is joined, so a receiver that cannot connect does not take
	// up the sender's second slot in a two-peer room.
	if err := requireRelay(ice.HasRelay(iceServers), degraded); err != nil {
		return err
	}
	if flagNoRelay {
		iceServers = ice.StunOnly(iceServers)
	}

	// 4. Connect to signaling server
	sc, err := connectSignaling(flagServer)
	if err != nil {
		return signalingConnectError(err)
	}
	defer sc.Close()

	// 5. Join the room (we are the second → role = receiver)
	if err := sc.JoinRoom(roomId); err != nil {
		return joinFailed(sc, err)
	}

	// PeerLeft and the deadline are what the desktop copy of this block has
	// carried all along. Without them a server that accepts the socket and then
	// goes quiet hangs the command with no output and no way out but Ctrl+C.
	select {
	case role := <-sc.Role:
		if role != "receiver" {
			// The server only ever returns "sender" or "receiver"; a receiver
			// getting "sender" means it joined an empty room, so nobody is sharing
			// from it (the transfer already finished, or the sender left). The
			// input was a code or a pasted link, and a link has no code in it,
			// so the line names both.
			return fmt.Errorf("this code or link is no longer active; ask the sender for a new one")
		}
	case <-sc.RoomFull:
		return fmt.Errorf("room is full (someone else may already be receiving)")
	case errMsg := <-sc.Errors:
		return fmt.Errorf("server error: %s", errMsg)
	case <-sc.PeerLeft:
		return roleWaitClosed(sc)
	case <-time.After(roleAssignTimeout):
		return fmt.Errorf("timed out waiting for the server to assign a role")
	}

	fmt.Println("  Connecting to sender...")

	// 6. Set up WebRTC as the responder (receiver waits for offer)
	conn, err := peer.New(iceServers, sc, peerOptions()...)
	if err != nil {
		return fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()

	dc, err := conn.SetupAsReceiver()
	if err != nil {
		// Bounded and escaped (setupFailureLine): pion's parse error quotes
		// the peer's offer.
		return fmt.Errorf("%s", setupFailureLine(err))
	}

	if !r.connected(dc, conn) {
		return park()
	}
	fmt.Println(connectedLine(conn.ConnectionType()))

	// 7. Receive files
	statsURL := flagServer
	if flagNoReport || os.Getenv("FLOE_NO_STATS") == "1" {
		statsURL = "" // reportBytesToServer no-ops on empty URL
	}
	// The pump comes from the connection, not from ReceiveFilesWithOptions: see
	// peer.Early. This is the side that was actually losing the sender's first
	// message.
	early := conn.Early()
	err = transfer.ReceiveFilesWithOptions(dc, absOutput, flagAutoAccept, version, statsURL, transfer.ReceiveOptions{
		Messages: early.Msgs,
		Closed:   early.Closed,
		// For Ctrl+C's stop: a count of the files committed under their final
		// names, and the engine's word that it has finished.
		OnFileDone:     func(transfer.FileDone) { r.saved.Add(1) },
		OnReceivedSent: r.receivedSent,
	})
	if !r.finish() {
		return park()
	}
	return err
}

// checkOutputDir reports whether dir exists or can be made, and leaves the
// disk as it found it. It asks by making dir, the one answer that holds on
// every file system (a missing permission, a read-only volume and a name the
// system refuses all show only then), and then removes each folder that was
// not there before, innermost first. Lstat keeps a link that points nowhere
// from being read as missing. os.Remove would also delete a file, so each
// path is looked at again just before it goes, and only a plain folder is
// removed: a file or a link that appeared there in between is left alone, and
// a folder something was put into fails to go because it is not empty.
func checkOutputDir(dir string) error {
	var missing []string
	p := filepath.Clean(dir)
	for {
		if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
			break
		}
		missing = append(missing, p)
		parent := filepath.Dir(p)
		if parent == p {
			break
		}
		p = parent
	}
	err := os.MkdirAll(dir, 0755)
	for _, p := range missing {
		if fi, lerr := os.Lstat(p); lerr == nil && fi.Mode().IsDir() {
			_ = os.Remove(p)
		}
	}
	return err
}

// receiveStopFlush bounds the wait for the stop frame to leave before the
// close, inside the handler's interruptStopBound.
const receiveStopFlush = 750 * time.Millisecond

// receiveRun is what one receive shares with its Ctrl+C step, which runs on
// the signal goroutine (interruptStop). Exactly one of the two ends the
// command: the command with its outcome, or main's handler with "Canceled."
// and exit 130. The mutex decides which; once the receive has finished (the
// engine has queued its "received") the command keeps its ending (A4-B22).
type receiveRun struct {
	saved atomic.Int64 // the files committed under their final names (OnFileDone)

	mu sync.Mutex
	// over: the receive returned, and the command ends on its own.
	// interrupted: Ctrl+C took the ending, and the command prints nothing more.
	// finished: the engine queued "received" (OnReceivedSent).
	over, interrupted, finished bool
	dc                          *webrtc.DataChannel
	conn                        *peer.Connection
}

// receivedSent is the receive's OnReceivedSent: from here on the receive has
// finished, and Ctrl+C ends only its wait for the sender.
func (r *receiveRun) receivedSent() {
	r.mu.Lock()
	r.finished = true
	r.mu.Unlock()
	receiveFinished()
}

// receiveFinished runs once receivedSent has recorded the finish: from then on
// Ctrl+C leaves the command its ending. A no-op; a var only so a test can wait
// for that moment, since the sender can read "received" before it (the engine
// queues the frame, pion sends it on its own goroutine, and only then does the
// engine call OnReceivedSent).
var receiveFinished = func() {}

// stop is the receive's Ctrl+C step, run by main's handler before "Canceled."
// and the partial-file cleanup (FU-54). From the signal goroutine, so it
// works while the receive loop is parked at the Accept prompt or in a stalled
// write: it tells the sender the transfer was stopped (code stopped, with
// this side's saved count) and closes the connection, so the cleanup's
// closing of the in-flight .part can no longer make the loop send
// write-failed (QA-H6 N10). Before the channel opens there is nobody to tell,
// as before.
//
// It reports true, the command keeping its own ending, once the receive has
// returned and once the engine has queued "received" (A4-B22). The receive
// has then finished: all that is left is its wait for the sender to read that
// frame and the byte report. That used to end on "Canceled.", exit 130 and no
// report. Now endLinger closes the connection, which ends the wait at once,
// and the receive returns nil and reports as any success does.
//
// Finished is the engine's word (OnReceivedSent), never a count compared with
// the first metadata's total: a sender can raise its total in a later frame,
// and the loop is held to the latest one, so a Ctrl+C with as many files
// saved as the first frame announced can still be partway through a file
// (CLI-01). Before the frame is queued (the files are all committed, the
// summary box is printing) Ctrl+C is a stop like any other: closing then
// would cut off the "received" still to come, and a Go sender would report
// the delivery unconfirmed (CLI-02).
func (r *receiveRun) stop() bool {
	r.mu.Lock()
	if r.over {
		r.mu.Unlock()
		return true
	}
	dc, conn := r.dc, r.conn
	if r.finished && dc != nil && conn != nil {
		r.mu.Unlock()
		go endLinger(dc, conn)
		return true
	}
	r.interrupted = true
	r.mu.Unlock()
	if dc == nil || conn == nil {
		return false
	}
	tellStopped(dc, conn, int(r.saved.Load()))
	return false
}

// endLinger is stop's work once the receive has finished: a wait, bounded by
// receiveStopFlush, for this side's send buffer to empty, so the "received"
// frame the engine has already queued is not cut off behind the close, then
// the close. The wait also ends once the channel has closed: a sender that
// has gone never acknowledges the frame, so the count would not fall before
// the bound (TestEndLingerReturnsOnceTheChannelHasClosed). A var only so a
// test can stand in one that records.
var endLinger = func(dc *webrtc.DataChannel, conn *peer.Connection) {
	for wait := time.Now().Add(receiveStopFlush); dc.BufferedAmount() > 0 && dc.ReadyState() != webrtc.DataChannelStateClosed && time.Now().Before(wait); {
		time.Sleep(10 * time.Millisecond)
	}
	conn.Close()
}

// tellStopped is stop's work: the refusal frame with code stopped and its
// flush, bounded by receiveStopFlush, then the close, the shape the desktop's
// request-drop abort and the request-link send's tellAndClose use. A var only
// so a test can stand in one that records or stalls.
var tellStopped = func(dc *webrtc.DataChannel, conn *peer.Connection, saved int) {
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		transfer.AbortWithCode(dc, version, transfer.CodeStopped, transfer.CodeStopped.WireReason(), saved)
	}()
	select {
	case <-sent:
	case <-time.After(receiveStopFlush):
	}
	conn.Close()
}

// connected records the open channel for Ctrl+C. It reports false when a
// Ctrl+C during setup already took the ending.
func (r *receiveRun) connected(dc *webrtc.DataChannel, conn *peer.Connection) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.interrupted {
		return false
	}
	r.dc, r.conn = dc, conn
	return true
}

// finish decides who ends the command once the receive returns. It reports
// false when Ctrl+C has the ending.
func (r *receiveRun) finish() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.interrupted {
		return false
	}
	r.over = true
	return true
}
