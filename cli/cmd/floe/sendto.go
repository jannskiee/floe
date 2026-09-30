package main

// `floe send <paths> --to <request link>`: the CLI visitor of a request link
// (spec 05 8.13, S1-CLI-01). It parses the link locally, joins the link's room
// with request-join, answers the host's offer and sends through the engine
// sender on the visitor's ack clock, and it succeeds only on the host's
// received.
//
// Every outcome prints the approved CLI copy (approved-copy-cli.txt, TL-01 to
// TL-34, amended by D-144), byte for byte. Nothing the host sent is ever
// printed from here: a refusal is read only through its allowlisted code and
// its count clamped to the drop, and every other error is mapped by errors.As
// and errors.Is to a fixed line, or left to cobra when it is today's local
// sentence (TL-11, TL-12, TL-32 and the walk's own errors).

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
	"github.com/spf13/cobra"
)

// sendToAckTimeout is how long the send waits for each ack from the host: the
// visitor's clock, the one the /r page keeps too (critic M-04), so the host's
// own window (transfer.HostDecisionWindow) always ends first and its
// "expired" has time to arrive. A var only so a test can shrink it, and never
// a literal: it moves when the engine's pair moves.
var sendToAckTimeout = transfer.VisitorAckTimeout + transfer.VisitorAckGrace

// sendToJoinTimeout bounds the wait for the server's answer to request-join.
// A server that predates request links never answers (TL-08). The signaling
// client bounds its own wait at the same 10 s; this one exists so a test can
// shrink it, and whichever ends first ends the join.
var sendToJoinTimeout = 10 * time.Second

// fetchICE and connectSignaling are the send's first two network calls, as
// vars so a test can count them and refuse every server but its own fake: a
// guard that a mutation removes must never reach api.floe.one from a test.
var (
	fetchICE         = ice.FetchDetail
	connectSignaling = signaling.Connect
)

// relayGateFor is transfer.RelayGate, the send's own relay cap, as a var so a
// test can stand in a relayed path, which a loopback pairing never selects.
var relayGateFor = transfer.RelayGate

// The approved copy, unindented; sendToEnd and the success path add today's
// two-space indent. The refusal-code lines are PeerStoppedError's fixed text
// for an allowlisted code (refusalLines), the one table spec 05 8.6 names.
const (
	lineJoining        = "Joining the request link..."
	lineConnecting     = "Connecting..."
	lineNothingSaved   = "Nothing is saved until they accept."
	lineHostAbsent     = "Their computer is not connected right now. The person who made this link may have closed Floe."
	lineRoomFull       = "This link has already been used. Ask the person who made it for a new one."
	lineDisabled       = "Request links are turned off right now."
	lineNoAnswer       = "Request links are not available on this Floe server."
	lineIncompleteLink = "This link looks incomplete. Copy the whole link again, including everything after the # sign. Put the link in quotes."
	// TL-10, and D-144.8's line for every case with no approved line of its
	// own: the host leaving during setup, the server connection lost during
	// setup, and a link made on another server.
	lineCouldNotConnect = "Couldn't connect to their computer. Nothing was sent."
	lineNeedsUpdate     = "Their Floe needs an update to receive from this link."
	lineUnknownStop     = "The drop stopped on their computer."
	lineTooManyFiles    = "This drop has more than 10,000 files. Zip them first."
	linePathTooLong     = "A folder path is too long to send. Zip deeply nested folders first."
	lineVerified        = "Their app reports every file's SHA-256 matched."
	lineSendTheRest     = "Ask them for a new link to send the rest."
	lineNothingSent     = "Nothing was sent."
	lineRelayNothing    = "Nothing was sent. Send under 2 GB."
	// The channel closed before the host accepted. The CLI copy draws no
	// state for it; this is the /r page's own line for the same moment
	// (approved-copy-web.md C-112), which the CLI copy mirrors.
	lineLostNothingSent = "Connection lost. Nothing was sent."
	lineCanceled        = "Canceled. Nothing was sent."
	lineYouStopped      = "You stopped this drop."
)

// lineWaiting is WAIT's first line (D-144 (6)): the host's decision window
// rounded down to whole minutes (D-143), so it never promises more time than
// the host gives. The window is 9 min 45 s, so it reads "9 min".
var lineWaiting = fmt.Sprintf("Waiting for them to accept. They have %d min to answer.",
	int(transfer.HostDecisionWindow/time.Minute))

// errSendToEnded is what runSendTo returns once it has printed the line that
// ends the command: main exits 1 on it and cobra prints nothing, because the
// line is the outcome and not a usage mistake (approved copy, Conventions).
var errSendToEnded = errors.New("the request-link send ended; its outcome is printed above")

// sendToEnd prints the lines that end the command, indented, and silences
// cobra for this return.
func sendToEnd(cmd *cobra.Command, lines ...string) error {
	for _, l := range lines {
		fmt.Fprintln(os.Stderr, "  "+l)
	}
	cmd.SilenceErrors = true
	return errSendToEnded
}

// sendToRun is what one send shares with its Ctrl+C handler, which reads it
// from the signal goroutine: how many files it announced, the last file the
// host acked (0 until it accepts), and the connection once there is one.
type sendToRun struct {
	files atomic.Int64
	acked atomic.Int64
	mu    sync.Mutex
	dc    *webrtc.DataChannel
	conn  *peer.Connection
}

// interrupt is the send's Ctrl+C (TL-28, TL-29): the phase line, and a stop
// that tells the host with the visitor's fixed reason, as the /r page's
// Cancel does, and then closes the connection so the host hears the end at
// once instead of at its ICE timeout. Both run before main's exit 130.
func (r *sendToRun) interrupt() (string, func()) {
	line := "\n  " + lineCanceled
	if acked := int(r.acked.Load()); acked > 0 {
		line = "\n  " + lineYouStopped + " " + savedSentence(acked-1, int(r.files.Load()))
	}
	r.mu.Lock()
	dc, conn := r.dc, r.conn
	r.mu.Unlock()
	return line, func() {
		if dc != nil {
			transfer.AbortSend(dc, version, transfer.VisitorCancelReason)
		}
		if conn != nil {
			conn.Close()
		}
	}
}

func runSendTo(cmd *cobra.Command, args []string) error {
	run := &sendToRun{}
	hook := run.interrupt
	interruptHook.Store(&hook)
	defer interruptHook.Store(nil)

	fmt.Println()

	// TL-32: the check and the sentence a plain send makes.
	for _, p := range args {
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("cannot read %s: %w", p, err)
		}
	}

	// TL-09, before the walk and before any network, so an incomplete link
	// never reaches anyone. The link id is dropped here; only the room id
	// ever leaves this machine, in request-join.
	_, roomID, err := code.ParseRequestLink(flagTo)
	if err != nil {
		return sendToEnd(cmd, lineIncompleteLink)
	}
	if linkServerMismatch(flagTo, serverChosen(cmd, os.Getenv)) {
		return sendToEnd(cmd, lineCouldNotConnect)
	}

	files, err := transfer.PrecheckDrop(args, version)
	switch {
	case errors.Is(err, transfer.ErrTooManyFiles):
		return sendToEnd(cmd, lineTooManyFiles)
	case errors.Is(err, transfer.ErrMetadataTooLarge):
		return sendToEnd(cmd, linePathTooLong)
	case err != nil:
		return err
	}
	run.files.Store(int64(files))
	summary, err := transfer.Summarize(args)
	if err != nil {
		return err
	}
	fmt.Printf("  Sending   %s\n", sendToLabel(args, files, summary.TotalBytes))

	iceServers, degraded, err := fetchICE(flagServer)
	if err != nil {
		return sendToEnd(cmd, lineCouldNotConnect)
	}
	// TL-12: after the ICE fetch and before joining, so a visitor that could
	// never connect does not take the link's one seat.
	if err := requireRelay(ice.HasRelay(iceServers), degraded); err != nil {
		return err
	}
	if flagNoRelay {
		iceServers = ice.StunOnly(iceServers)
	}

	fmt.Println("  " + lineJoining)
	sc, err := connectSignaling(flagServer)
	if err != nil {
		return sendToEnd(cmd, lineCouldNotConnect)
	}
	defer sc.Close()
	// The peer exists before the join (spec 07 4.8): the host offers the
	// moment the server seats this visitor.
	conn, err := peer.New(iceServers, sc, peerOptions()...)
	if err != nil {
		return sendToEnd(cmd, lineCouldNotConnect)
	}
	defer conn.Close()

	switch requestJoin(sc, roomID) {
	case signaling.VisitorJoined:
	case signaling.VisitorHostAbsent:
		return sendToEnd(cmd, lineHostAbsent)
	case signaling.VisitorRoomFull:
		return sendToEnd(cmd, lineRoomFull)
	case signaling.VisitorDisabled:
		return sendToEnd(cmd, lineDisabled)
	case signaling.VisitorTimeout:
		return sendToEnd(cmd, lineNoAnswer)
	default:
		// An error frame, a seat that is not the visitor's, or the socket
		// gone before an answer: no approved line of its own (D-144.8).
		return sendToEnd(cmd, lineCouldNotConnect)
	}

	fmt.Println("  " + lineConnecting)
	dc, ended, err := setupWatched(sc, conn)
	if err != nil {
		if ended == "disabled" {
			return sendToEnd(cmd, lineDisabled)
		}
		return sendToEnd(cmd, lineCouldNotConnect)
	}
	run.mu.Lock()
	run.dc, run.conn = dc, conn
	run.mu.Unlock()

	fmt.Println(connectedLine(conn.ConnectionType()))
	// TL-11: a relayed drop over the cap ends here, before WAIT, on today's
	// sentence, and the host is told why exactly as the send's own gate tells
	// it (a text abort with the gate's words, then the flush).
	if err := relayGateFor(dc, summary.TotalBytes); err != nil {
		transfer.AbortSend(dc, version, err.Error())
		return err
	}
	fmt.Println("  " + lineWaiting)
	fmt.Println("  " + lineNothingSaved)

	var acceptedAt time.Time
	var delivered transfer.Delivered
	onAck := func(index int) {
		if index == 1 {
			acceptedAt = time.Now()
		}
		run.acked.Store(int64(index))
	}
	stopWatch := make(chan struct{})
	watchFailed(conn, stopWatch)
	err = transfer.SendFilesWithOptions(dc, args, version,
		sendToOptions(conn.Early(), onAck, func(d transfer.Delivered) { delivered = d }))
	close(stopWatch)

	if err != nil {
		lines, keep := sendToOutcome(err, files, int(run.acked.Load()))
		if keep != nil {
			return keep
		}
		return sendToEnd(cmd, lines...)
	}

	if acceptedAt.IsZero() {
		acceptedAt = time.Now()
	}
	fmt.Println()
	fmt.Println("  " + arrivedLine(delivered.Files, summary.TotalBytes, time.Since(acceptedAt), routeOf(conn)))
	// The host's report, not a proof made here, and only when it says every
	// file matched (verified is the received frame's count, which the engine
	// accepts only from 0 to the file count).
	if delivered.HasVerified && delivered.Files > 0 && delivered.Verified == delivered.Files {
		fmt.Println("  " + lineVerified)
	}
	return nil
}

// sendToOptions is the one place the send's engine options are made: the
// visitor's ack clock, success only on the host's received, no summary box
// (TL-03 replaces it), the ack callback that tracks the phase, and the
// connection's own pump (see peer.Early).
func sendToOptions(early *peer.Early, onAck func(int), onDelivered func(transfer.Delivered)) transfer.SendOptions {
	return transfer.SendOptions{
		Messages:        early.Msgs,
		Closed:          early.Closed,
		AckTimeout:      sendToAckTimeout,
		RequireReceived: true,
		NoSummary:       true,
		OnAck:           onAck,
		OnDelivered:     onDelivered,
	}
}

// requestJoin asks for the visitor seat and waits up to sendToJoinTimeout for
// the server's answer. The answer channel is buffered, so a RequestJoin that
// outlives this wait ends on its own (its timeout, or the socket's close when
// the send returns) without blocking.
func requestJoin(sc *signaling.Client, roomID string) signaling.RequestJoinResult {
	answer := make(chan signaling.RequestJoinResult, 1)
	go func() {
		res, _ := sc.RequestJoin(roomID)
		answer <- res
	}()
	select {
	case res := <-answer:
		return res
	case <-time.After(sendToJoinTimeout):
		return signaling.VisitorTimeout
	}
}

// setupWatched answers the host's offer while it watches for the three
// answers that take the seat away during setup: room-full (the host reopened
// the link, evicting this visitor, E-03), host-absent (the host left or
// closed the link before the room sealed: the server sends that, and not
// peer-disconnected, to an unsealed visitor) and disabled. SetupAsReceiver
// watches PeerLeft and the socket itself (S1-ENG-11) and cannot see these, so
// the watcher closes the connection, which ends the setup at once instead of
// at its 30 s wait. ended names which one did it, "" for none.
func setupWatched(sc *signaling.Client, conn *peer.Connection) (dc *webrtc.DataChannel, ended string, err error) {
	why := make(chan string, 1)
	stop := make(chan struct{})
	go func() {
		var w string
		select {
		case <-sc.RoomFull:
			w = "room-full"
		case <-sc.HostAbsent:
			w = "host-absent"
		case <-sc.Disabled:
			w = "disabled"
		case <-stop:
			return
		}
		why <- w
		conn.Close()
	}()
	dc, err = conn.SetupAsReceiver()
	close(stop)
	if err != nil {
		select {
		case ended = <-why:
		default:
		}
	}
	return dc, ended, err
}

// failer is what watchFailed needs of a connection.
type failer interface {
	Failed() <-chan struct{}
	Close()
}

// watchFailed closes conn when its peer connection fails, until stop is
// closed. The wait for the host's received has no deadline of its own
// (SendOptions.RequireReceived), and a host that vanished without a close
// this side can hear (a crash, a network gone) would hold it open for good.
// Failed fires about 30 s after the last packet (peer.Connection.Failed), and
// the close ends the send as a lost connection (TL-27).
func watchFailed(conn failer, stop <-chan struct{}) {
	go func() {
		select {
		case <-conn.Failed():
			conn.Close()
		case <-stop:
		}
	}()
}

// sendToOutcome maps a failed send to the lines that end the command, or to
// an error to hand cobra as it is: today's sentence for the relay gate
// (TL-11), a local file that could not be read or changed while it was read,
// and a version miss that this side must fix. Only errors.As and errors.Is
// decide; no error's text is ever printed from here, because the ones that
// came off the wire hold the host's words. acked is the last file the host
// acked, 0 before it accepted.
func sendToOutcome(err error, files, acked int) (lines []string, keep error) {
	var stopped *transfer.PeerStoppedError
	var ended *transfer.PeerEndedError
	var compat *transfer.CompatError
	var pathErr *fs.PathError
	switch {
	case errors.As(err, &stopped):
		return refusalLines(stopped.Code, stopped.Saved, files), nil
	case errors.As(err, &ended):
		return []string{lineUnknownStop, savedSentence(ended.Saved, files)}, nil
	case errors.As(err, &compat):
		// TL-13 names the host as the side to update, which is true only when
		// it is the side behind; when this CLI is, today's message and its
		// `floe update` are the remedy.
		if compat.LocalTooOld {
			return nil, err
		}
		return []string{lineNeedsUpdate}, nil
	case errors.Is(err, transfer.ErrRelayOverLimit),
		errors.Is(err, transfer.ErrFileChanged),
		errors.As(err, &pathErr):
		return nil, err
	case acked == 0 && errors.Is(err, transfer.ErrAckTimeout):
		// TL-15: the same sentence as the host's expired.
		return []string{(&transfer.PeerStoppedError{Code: transfer.CodeExpired}).Error()}, nil
	case acked == 0:
		return []string{lineLostNothingSent}, nil
	}
	return []string{lostLine(acked-1, files)}, nil
}

// refusalLines is the host's refusal as the approved copy prints it (TL-14 to
// TL-26): the fixed line for the code, then the saved line, which declined and
// expired carry in their own line, relay-cap words its own way at 0, and
// hash-mismatch follows with the new-link line. The code is checked against
// the allowlist again here; an unknown one is TL-26.
func refusalLines(code transfer.RefusalCode, saved, files int) []string {
	c, ok := transfer.ParseRefusalCode(string(code))
	if !ok {
		return []string{lineUnknownStop, savedSentence(saved, files)}
	}
	first := (&transfer.PeerStoppedError{Code: c}).Error()
	switch c {
	case transfer.CodeDeclined, transfer.CodeExpired:
		return []string{first}
	case transfer.CodeRelayCap:
		if clampCount(saved, files) == 0 {
			return []string{first, lineRelayNothing}
		}
	case transfer.CodeHashMismatch:
		return []string{first, savedSentence(saved, files), lineSendTheRest}
	}
	return []string{first, savedSentence(saved, files)}
}

// clampCount holds a count to [0, n]; the counts it sees came off the wire
// already clamped by the engine, and this clamps them to this side's own n.
func clampCount(v, n int) int {
	switch {
	case v < 0:
		return 0
	case v > n:
		return n
	}
	return v
}

// savedSentence is the saved line: "Nothing was sent." at 0, else "4 of 12
// files were saved." (singular, D-123: "1 of 1 file was saved.").
func savedSentence(saved, n int) string {
	saved = clampCount(saved, n)
	switch {
	case saved == 0:
		return lineNothingSent
	case n == 1:
		return fmt.Sprintf("%d of 1 file was saved.", saved)
	}
	return fmt.Sprintf("%d of %d files were saved.", saved, n)
}

// lostLine is TL-27: "Connection lost. 4 of 12 files arrived. Ask them for a
// new link to send the other 8.", with "the rest" when none are left to name
// and D-123's singular (approved-copy-web.md C-111: "0 of 1 file arrived. Ask
// them for a new link to send it.").
func lostLine(arrived, n int) string {
	arrived = clampCount(arrived, n)
	count := fmt.Sprintf("%d of %d files arrived.", arrived, n)
	if n == 1 {
		count = fmt.Sprintf("%d of 1 file arrived.", arrived)
	}
	rest := lineSendTheRest
	switch left := n - arrived; {
	case left > 0 && n == 1:
		rest = "Ask them for a new link to send it."
	case left > 0:
		rest = fmt.Sprintf("Ask them for a new link to send the other %d.", left)
	}
	return "Connection lost. " + count + " " + rest
}

// countFiles is "1 file" or "12 files".
func countFiles(n int) string {
	if n == 1 {
		return "1 file"
	}
	return fmt.Sprintf("%d files", n)
}

// sendToLabel is START's label: the paths as typed, then the count and the
// size, "shoot (12 files, 38 GB)" (TL-01).
func sendToLabel(paths []string, files int, totalBytes int64) string {
	return fmt.Sprintf("%s (%s, %s)", strings.Join(paths, ", "), countFiles(files), transfer.FormatBytes(totalBytes))
}

// arrivedLine is TL-03 and TL-04's first line, "All 12 files arrived (38 GB in
// 17m 4s, direct).", D-123's singular for one file (approved-copy-web.md
// SR-04: "1 file arrived."), and the route left out when it could not be read.
func arrivedLine(files int, totalBytes int64, took time.Duration, route string) string {
	head := fmt.Sprintf("All %d files arrived", files)
	if files == 1 {
		head = "1 file arrived"
	}
	detail := transfer.FormatBytes(totalBytes) + " in " + transfer.FormatDuration(took)
	if route != "" {
		detail += ", " + route
	}
	return head + " (" + detail + ")."
}

// routeOf is the selected path, "direct" or "relay", or "" when it cannot be
// read, which connectedLine treats the same way.
func routeOf(conn *peer.Connection) string {
	route, err := conn.ConnectionType()
	if err != nil || (route != "direct" && route != "relay") {
		return ""
	}
	return route
}

// linkServerMismatch reports whether a link was made on a server this run is
// not pointed at: its host is not floe.one or www.floe.one, and no server was
// chosen. Joining would then ask api.floe.one about a room it has never seen,
// and hand it the room id on the way, so the send ends first with TL-10
// (D-144.8) and no network call at all. A link typed without its scheme is
// read as https.
func linkServerMismatch(link string, serverChosen bool) bool {
	if serverChosen {
		return false
	}
	link = strings.TrimSpace(link)
	u, err := url.Parse(link)
	if err == nil && u.Scheme == "" && u.Host == "" {
		u, err = url.Parse("https://" + link)
	}
	if err != nil {
		return true
	}
	switch strings.ToLower(u.Hostname()) {
	case "floe.one", "www.floe.one":
		return false
	}
	return true
}

// serverChosen reports whether this run names its server: --server typed, or
// FLOE_SERVER set (applyEnv has already copied it into flagServer).
func serverChosen(cmd *cobra.Command, getenv func(string) string) bool {
	return cmd.Flags().Changed("server") || getenv("FLOE_SERVER") != ""
}
