package main

// Driving a send or a receive end to end, from the engine call through the
// events the frontend listens for.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// relayOpts returns the peer options for a transfer: relay-only ("hide my IP")
// when hideIP is set, otherwise none.
func relayOpts(hideIP bool) []peer.Option {
	if hideIP {
		return []peer.Option{peer.WithRelayOnly()}
	}
	return nil
}

// Two reasons a Hide my IP transfer cannot start, kept apart because they need
// different things from the person reading them. With relay-only forced and no
// TURN URL in the list, ICE gathers no usable candidate at all, so the attempt
// used to die about thirty seconds later as "timed out establishing a
// connection", which errors.ts maps to advice about both devices being online.
// They are online.
//
// Both open with the same clause, which is what errors.ts PASSTHROUGH anchors
// on to print them verbatim.
var (
	errNoRelay = errors.New("Hide my IP needs a TURN relay and this server has none. Turn off Hide my IP, or add a relay to the server.")
	// The server answered with nothing usable, or did not answer at all, so
	// this side fell back to public STUN and cannot say what the server offers.
	// Blaming its configuration would be a confident guess: the common causes
	// are a wrong address, a reverse proxy not forwarding /api/, and the TURN
	// endpoint's own rate limiter.
	errRelayUnknown = errors.New("Hide my IP needs a TURN relay, and this server's connection details could not be read. Check the server address, or turn off Hide my IP.")
)

// requireRelay is the transfer-time half of the Settings probe's relay check.
//
// It runs here as well as there because ice.Fetch falls back to public STUN
// whenever it cannot read the server's list, so even a TURN-capable server can
// hand this particular transfer a list with nothing to relay through. Only the
// list actually in use can answer the question, and only `degraded` can say
// whether "no relay" is the server's answer or this side's guess.
//
// Takes the already-computed answers rather than the server list: naming
// webrtc.ICEServer in a desktop signature would promote pion from an indirect
// to a direct requirement in desktop/go.mod, and that file's dependency graph
// reaches the released floe binary through the workspace.
func requireRelay(hideIP, hasRelay, degraded bool) error {
	if !hideIP || hasRelay {
		return nil
	}
	if degraded {
		return errRelayUnknown
	}
	return errNoRelay
}

// StartSend validates the given paths and launches the send flow in the
// background. Progress is reported to the UI via Wails events:
//   - "send:code"      {code, link}                    once the room code is registered
//   - "send:status"    string                          status updates (peer connected, etc.)
//   - "send:done"      string                          transfer finished
//   - "send:delivered" {files, verified, hasVerified}  the receiver's delivery report
//   - "send:error"     string                          any failure
func (a *App) StartSend(paths []string, hideIP bool) error {
	if len(paths) == 0 {
		return fmt.Errorf("no files selected")
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("cannot read %s: %w", p, err)
		}
	}
	// Claim the generation synchronously so a cancel arriving right after the
	// click targets this attempt, not the previous one.
	g := a.beginTransfer()
	go a.runSend(g, paths, hideIP)
	return nil
}

// writeTextTemp writes text to <tempdir>/message.txt and returns the file path
// plus a cleanup that removes the directory. The fixed inner name is what the
// receiver sees; the random temp-dir name never crosses the wire.
func writeTextTemp(text string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "floe-text-")
	if err != nil {
		return "", nil, err
	}
	path := filepath.Join(dir, "message.txt")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		os.RemoveAll(dir)
		return "", nil, err
	}
	return path, func() { os.RemoveAll(dir) }, nil
}

// StartSendText sends a text note as a message.txt file through the normal send
// flow. Zero protocol change, so any Floe peer (browser, CLI, desktop) can
// receive it. The temp file is removed when the transfer goroutine ends,
// whether it completed, failed, or was cancelled.
func (a *App) StartSendText(text string, hideIP bool) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("nothing to send")
	}
	path, cleanup, err := writeTextTemp(text)
	if err != nil {
		return fmt.Errorf("could not stage the text: %w", err)
	}
	// Claimed after staging succeeds so a staging failure supersedes nothing.
	g := a.beginTransfer()
	go func() {
		defer cleanup()
		a.runSend(g, []string{path}, hideIP)
	}()
	return nil
}

func (a *App) runSend(g uint64, paths []string, hideIP bool) {
	// Release any sleep inhibitor on every exit (success, error, cancel, panic).
	// Owner-tagged: a no-op if we never acquired it or a newer transfer holds it.
	defer a.wake.release(laneTransfer, g)
	defer a.clearTransfer(g)

	// emit forwards an event to the UI unless this attempt was cancelled or
	// superseded, so a dead goroutine's late events cannot talk over the live
	// transfer (the frontend's own ref guard resets on the next attempt and
	// cannot close this on its own).
	emit := func(event string, payload any) {
		if !a.transferActive(g) {
			return
		}
		runtime.EventsEmit(a.ctx, event, payload)
	}

	fail := func(err error) {
		if !a.transferActive(g) {
			return // user cancelled, or a newer attempt owns the UI
		}
		runtime.EventsEmit(a.ctx, "send:error", err.Error())
		// The status line above carries the detail; the toast stays generic
		// because raw engine errors read like stack traces in a notification.
		a.notifyTransferFailed(g, "Floe - send failed")
	}

	roomID := uuid.New().String()

	// One snapshot for the whole send: changing the setting mid-transfer must
	// not move the second half onto a different server.
	server, web := a.endpoints()

	iceServers, degraded, err := ice.FetchDetail(server)
	if err != nil {
		fail(fmt.Errorf("failed to fetch ICE credentials: %w", err))
		return
	}
	// Before the room code is registered, so nobody is handed a share link that
	// could never have worked.
	if err := requireRelay(hideIP, ice.HasRelay(iceServers), degraded); err != nil {
		fail(err)
		return
	}

	sc, err := signaling.Connect(server)
	if err != nil {
		fail(fmt.Errorf("failed to connect to signaling server: %w", err))
		return
	}
	defer sc.Close()
	if !a.setSignaling(g, sc) {
		return // cancelled or superseded before we registered; the defer closes sc
	}

	if err := sc.JoinRoom(roomID); err != nil {
		fail(fmt.Errorf("failed to join room: %w", err))
		return
	}

	select {
	case role := <-sc.Role:
		if role != "sender" {
			fail(fmt.Errorf("expected sender role, got %q", role))
			return
		}
	case <-sc.RoomFull:
		fail(fmt.Errorf("room is full"))
		return
	case errMsg := <-sc.Errors:
		fail(fmt.Errorf("server error: %s", errMsg))
		return
	case <-sc.PeerLeft:
		fail(fmt.Errorf("connection closed"))
		return
	case <-time.After(20 * time.Second):
		fail(fmt.Errorf("timed out waiting for the server to assign a role"))
		return
	}

	// Register a short shareable code and emit it to the UI immediately.
	codePhrase, err := code.Register(server, roomID)
	if err != nil {
		codePhrase = ""
	}
	link := shareLink(web, uuid.New().String()[:8], roomID)
	emit("send:code", map[string]string{"code": codePhrase, "link": link})

	// Wait for a receiver to join. This wait is intentionally unbounded (you may
	// share a link and wait) — CancelTransfer closes sc to abort it via PeerLeft.
	select {
	case <-sc.PeerConnected:
	case <-sc.PeerLeft:
		fail(fmt.Errorf("peer disconnected before connecting"))
		return
	case errMsg := <-sc.Errors:
		fail(fmt.Errorf("server error: %s", errMsg))
		return
	}
	emit("send:status", "Peer connected. Sending...")

	// A peer is connected: keep the machine awake through WebRTC setup and the
	// data transfer. Placed here, not at the top, so the unbounded wait for a
	// receiver above never holds a laptop awake on an unanswered share link.
	a.wake.acquire(laneTransfer, g)

	// Set up WebRTC as the initiator and send.
	conn, err := peer.New(iceServers, sc, relayOpts(hideIP)...)
	if err != nil {
		fail(fmt.Errorf("failed to create peer connection: %w", err))
		return
	}
	defer conn.Close()
	if !a.setConn(g, conn) {
		return // cancelled or superseded; the defer closes conn
	}

	dc, err := conn.SetupAsSender()
	if err != nil {
		fail(fmt.Errorf("WebRTC setup failed: %w", err))
		return
	}

	if ct, ctErr := conn.ConnectionType(); ctErr == nil {
		emit("send:route", ct) // "direct" or "relay", best-effort
	}

	lastEmit := time.Now()
	onProgress := func(p transfer.Progress) {
		// Throttle UI events to ~10/sec, but always emit a file's final update
		// so the bar reliably reaches 100%.
		if time.Since(lastEmit) < 100*time.Millisecond && p.FileBytes < p.FileSize {
			return
		}
		lastEmit = time.Now()
		emit("send:progress", p)
	}
	// The pump comes from the connection: see peer.Early for why registering the
	// handler down in the transfer layer can silently lose the peer's first
	// message on a fast path.
	sendEarly := conn.Early()
	if err := transfer.SendFilesWithOptions(dc, paths, version, transfer.SendOptions{
		OnProgress: onProgress,
		// Fires once when the receiver confirms delivery, with the numbers the
		// CLI's Verified row reads. The UI shows only a boolean from it.
		OnDelivered: func(d transfer.Delivered) { emit("send:delivered", d) },
		UpdateHint:  desktopUpdateHint,
		Messages:    sendEarly.Msgs,
		Closed:      sendEarly.Closed,
	}); err != nil {
		// The relay cap is a policy block, not a failure: skip the "transfer
		// failed" wrapper, and when Hide my IP forced the relay, name the
		// toggle that lifts the cap.
		if errors.Is(err, transfer.ErrRelayOverLimit) {
			if hideIP {
				err = fmt.Errorf("%w. Turn off Hide my IP to send larger files", err)
			}
			fail(err)
			return
		}
		fail(fmt.Errorf("transfer failed: %w", err))
		return
	}
	emit("send:done", "Files sent successfully.")
	if a.transferActive(g) {
		a.notify("Floe", "Files sent successfully.")
	}
}

// ReceiveByCode connects to a peer using a Floe room code (or link) and receives
// the incoming files into outputDir. It reuses the exact same engine the CLI uses
// (signaling, Pion WebRTC, the transfer protocol), so it interoperates with both
// browser senders and CLI senders. WebRTC and all file bytes run in Go here; the
// webview never touches the data channel.
//
// Progress is reported to the UI via Wails events:
//   - "recv:incoming"  IncomingInfo                 as the sender's first metadata arrives
//   - "recv:progress"  Progress                     throttled to ten a second
//   - "recv:file-done" {savedName, bytes, verified} once per committed file
//
// Returns the absolute output directory on success.
func (a *App) ReceiveByCode(codeOrLink string, outputDir string, hideIP bool, reportStats bool) (string, error) {
	g := a.beginTransfer()
	dir, err := a.receiveByCode(g, codeOrLink, outputDir, hideIP, reportStats)
	if err != nil {
		// A pasted request or drop link is a mix-up the status line explains
		// (CP2), not a failed transfer, so it gets no failure toast.
		if isRequestLinkPaste(err) {
			return "", err
		}
		// Receive failures used to be completely silent behind a minimized
		// window; mirror the send path's toast. Suppressed on user cancel and
		// when a newer attempt has taken over.
		a.notifyTransferFailed(g, "Floe - receive failed")
		return "", err
	}
	return dir, nil
}

// receiveByCode is the body of ReceiveByCode, carrying the generation tag of
// the attempt it belongs to.
func (a *App) receiveByCode(g uint64, codeOrLink string, outputDir string, hideIP bool, reportStats bool) (string, error) {
	// Release any sleep inhibitor on every exit (success, error, cancel, panic).
	// Owner-tagged: a no-op if we never acquired it or a newer transfer holds it.
	defer a.wake.release(laneTransfer, g)
	defer a.clearTransfer(g)

	// emit forwards an event to the UI unless this attempt was cancelled or
	// superseded (see runSend's twin for the rationale).
	emit := func(event string, payload any) {
		if !a.transferActive(g) {
			return
		}
		runtime.EventsEmit(a.ctx, event, payload)
	}

	if outputDir == "" {
		outputDir = defaultReceiveDir()
	}
	absOutput, err := filepath.Abs(outputDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absOutput, 0o755); err != nil {
		return "", fmt.Errorf("cannot create output directory: %w", err)
	}

	// One snapshot for the whole receive, for the same reason as runSend.
	server, _ := a.endpoints()

	roomID, err := code.Resolve(server, codeOrLink)
	if err != nil {
		// A request or drop link (S1-DSK-07, E-10) comes back as the engine's
		// sentinel, whose text is the approved sentence. Returned bare, never
		// wrapped: the wrapper below quotes the pasted input, which for these
		// links is the room id in the fragment.
		if isRequestLinkPaste(err) {
			return "", err
		}
		return "", fmt.Errorf("could not resolve %q: %w", codeOrLink, err)
	}

	iceServers, degraded, err := ice.FetchDetail(server)
	if err != nil {
		return "", fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}
	// Before JoinRoom, so a receiver that cannot connect does not take up the
	// sender's second slot in a two-peer room.
	if err := requireRelay(hideIP, ice.HasRelay(iceServers), degraded); err != nil {
		return "", err
	}

	sc, err := signaling.Connect(server)
	if err != nil {
		return "", fmt.Errorf("failed to connect to signaling server: %w", err)
	}
	defer sc.Close()
	if !a.setSignaling(g, sc) {
		return "", fmt.Errorf("transfer canceled")
	}

	if err := sc.JoinRoom(roomID); err != nil {
		return "", fmt.Errorf("failed to join room: %w", err)
	}

	select {
	case role := <-sc.Role:
		if role != "receiver" {
			// The server only ever returns "sender" or "receiver"; a receiver
			// getting "sender" means it joined an empty room, so nobody is sharing
			// with this code (codes are single-use: the transfer already finished,
			// or the sender left).
			return "", fmt.Errorf("this code is no longer active; ask for a new one")
		}
	case <-sc.RoomFull:
		return "", fmt.Errorf("room is full (someone else may already be receiving)")
	case errMsg := <-sc.Errors:
		return "", fmt.Errorf("server error: %s", errMsg)
	case <-sc.PeerLeft:
		return "", fmt.Errorf("connection closed")
	case <-time.After(20 * time.Second):
		return "", fmt.Errorf("timed out waiting for the server to assign a role")
	}

	// A receiver role means a sender is already present: keep the machine awake
	// through WebRTC setup and the data transfer.
	a.wake.acquire(laneTransfer, g)

	conn, err := peer.New(iceServers, sc, relayOpts(hideIP)...)
	if err != nil {
		return "", fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()
	if !a.setConn(g, conn) {
		return "", fmt.Errorf("transfer canceled")
	}

	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return "", fmt.Errorf("WebRTC setup failed: %w", err)
	}

	if ct, ctErr := conn.ConnectionType(); ctErr == nil {
		emit("recv:route", ct) // "direct" or "relay", best-effort
	}

	// autoAccept=true: a GUI cannot answer a terminal prompt. The receiver reports
	// received bytes to the global stats counter unless the user opted out (the
	// engine skips the report when statsURL is empty).
	statsURL := ""
	if reportStats {
		statsURL = server
	}
	lastEmit := time.Now()
	onProgress := func(p transfer.Progress) {
		if time.Since(lastEmit) < 100*time.Millisecond && p.FileBytes < p.FileSize {
			return
		}
		lastEmit = time.Now()
		emit("recv:progress", p)
	}
	// The pump comes from the connection: see peer.Early. This is the side the
	// race was actually being lost on.
	recvEarly := conn.Early()
	opts := transfer.ReceiveOptions{
		OnProgress: onProgress,
		UpdateHint: desktopUpdateHint,
		// Fires once as the sender's first metadata arrives, before any byte
		// lands: the UI shows what is incoming while the transfer starts.
		OnIncoming: func(inc transfer.IncomingInfo) { emit("recv:incoming", inc) },
		// Fires once per committed file, after the rename. It delays the next
		// ack, so this does nothing but forward: emit is non-blocking and the
		// UI does the counting.
		OnFileDone: func(d transfer.FileDone) { emit("recv:file-done", d) },
		Messages:   recvEarly.Msgs,
		Closed:     recvEarly.Closed,
	}
	if err := transfer.ReceiveFilesWithOptions(dc, absOutput, true, version, statsURL, opts); err != nil {
		return "", fmt.Errorf("transfer failed: %w", err)
	}

	if a.transferActive(g) {
		a.notify("Floe", "Files received.")
	}
	return absOutput, nil
}

// runRequestDrop is one visitor on a request link, from user-connected to the
// end of its drop (S1-DSK-03b; spec 06 4.5 steps 4 to 16, spec 05 8.12). It
// runs as the lane's pairFn, on the goroutine that owns sc, and returns with
// the lane in waiting (the visitor left, setup failed, the request was
// missed), declined, done or stopped, or with rg gone. The error is for tests;
// nothing shows it, and no engine or OS text reaches a snapshot (E-42).
//
// It sits beside receiveByCode on purpose (OD-30): the same engine calls in
// the other direction, since the host offers and then receives.
func (a *App) runRequestDrop(rg uint64, sc *signaling.Client, p requestPairing) error {
	// a. A previous visitor's trickled candidates never reach this one (E-39),
	// and a previous visitor's leave never ends this one's setup at once.
	drainSignals(sc)

	// b. ICE now, never at Make link (L13); the list lives for this pairing.
	iceServers, degraded, err := iceFetchFn(p.server)
	if err != nil {
		code := "setup-failed"
		if p.hideIP {
			code = "relay-unknown"
		}
		return a.reopenRequest(rg, sc, code, err)
	}
	if err := requireRelay(p.hideIP, ice.HasRelay(iceServers), degraded); err != nil {
		code := "no-relay"
		if errors.Is(err, errRelayUnknown) {
			code = "relay-unknown"
		}
		return a.reopenRequest(rg, sc, code, err)
	}

	// c. The offer. A visitor who leaves during setup (after the offer, too,
	// once the server sealed the room for two signaling seats, D-116) is
	// reported at once by the engine (S1-ENG-11), not after 30 s.
	if !a.reqUpdate(rg, func(l *requestLane) { l.setStateLocked("connecting", "") }) {
		return nil
	}
	conn, err := peer.New(iceServers, sc, relayOpts(p.hideIP)...)
	if err != nil {
		return a.reopenRequest(rg, sc, "setup-failed", err)
	}
	defer conn.Close()
	if !a.setRequestConn(rg, conn) {
		return nil
	}
	defer a.clearRequestConn(conn)
	dc, err := conn.SetupAsSender()
	if err != nil {
		code := "setup-failed"
		if errors.Is(err, peer.ErrPeerLeft) {
			code = "visitor-left" // nobody is there, so W11 would be wrong
		}
		return a.reopenRequest(rg, sc, code, err)
	}

	d := &requestDrop{closed: conn.Early().Closed}
	d.abort = func(code transfer.RefusalCode) {
		transfer.AbortWithCode(dc, version, code, code.WireReason(), d.tally.savedCount())
		conn.Close()
	}

	// d. The channel is open: seal the room, so a later request-join gets
	// room-full, and give the visitor until the E-35 timer to send its first
	// metadata. The timer is cancelled at OnIncoming and again when the
	// receive returns (WP-A2 review L3a): a first metadata that the limits
	// refuse never reaches OnIncoming.
	_ = sc.RequestSeal()
	cancelOpen := transfer.StartIncomingDeadline(requestOpenChannelTimeout, func() {
		d.openExpired.Store(true)
		requestOpenChannelExpired()
		d.abort(transfer.CodeStopped)
	})
	defer cancelOpen()

	// e. The route, best effort.
	if ct, ctErr := conn.ConnectionType(); ctErr == nil {
		d.route = ct
		a.reqUpdate(rg, func(l *requestLane) { l.route = ct })
	}

	// f. The global stats report follows the owner's switch, read at pairing
	// (E-32): the engine skips it when statsURL is empty.
	statsURL := ""
	if p.reportStats {
		statsURL = p.server
	}

	// g. The receive, into the base folder until Decide accepts with the drop's
	// own. While it runs the lane never reads sc.PeerLeft: only the channel
	// closing or the receive returning ends the drop (spec 06 4.17).
	quit := make(chan struct{})
	defer close(quit)
	early := conn.Early()
	msgs, closed := watchAbortFrames(early.Msgs, early.Closed, quit, &d.peerAbort)
	opts := transfer.ReceiveOptions{
		OnIncoming: func(transfer.IncomingInfo) {
			d.incoming.Store(true)
			cancelOpen()
		},
		Decide: func(in transfer.IncomingInfo) transfer.Decision { return a.requestDecide(rg, p, d, in) },
		Limits: requestLimits(),
		OnProgress: throttleProgress(requestProgressEvery, time.Now, func(pr transfer.Progress) {
			if a.requestActive(rg) {
				a.emitRequest("request:progress", pr)
			}
		}),
		OnFileDone: d.tally.add,
		UpdateHint: desktopUpdateHint,
		Messages:   msgs,
		Closed:     closed,
	}
	err = transfer.ReceiveFilesWithOptions(dc, p.saveDir, true, version, statsURL, opts)
	cancelOpen()
	if d.cap != nil {
		d.cap.Stop()
	}
	return a.endRequestDrop(rg, sc, d, err)
}

// The request drop's clocks and limits, package vars only so a test can
// shrink a clock. requestDecideWindow is derived from the engine's constant
// and never assigned a literal (M-04): the visitor's ack wait is
// VisitorAckTimeout plus VisitorAckGrace, so this side always answers first.
var (
	// requestOpenChannelTimeout is E-35's wall clock from channel open to the
	// first metadata: a visitor that holds the channel open with frames that
	// are not a metadata keeps the engine's idle watchdog blind, so this one
	// stops it.
	requestOpenChannelTimeout = 30 * time.Second
	// requestDecideWindow is how long the owner has to answer a prompt.
	requestDecideWindow = transfer.HostDecisionWindow
	// requestDropCap is the most time one accepted drop may take (E-05).
	requestDropCap = transfer.DropTimeLimit
	// iceFetchFn fetches the pairing's ICE list, at user-connected only (L13).
	iceFetchFn = ice.FetchDetail
	// requestOpenChannelExpired runs when the E-35 timer fires; tests count it.
	requestOpenChannelExpired = func() {}
)

// The request link's receive policy (layer 2, spec 06 4.6): at most 10,000
// files, and 2 GiB left free after every file.
const (
	requestMaxFiles    = 10000
	requestFreeReserve = int64(2) << 30
	// requestCommitRetry is E-36's window for a finished file whose move into
	// place a scanner is holding: retried once a second, then save-blocked,
	// with the verified .part kept either way.
	requestCommitRetry = 5 * time.Minute
	// requestResultNames caps the saved names a result keeps; Files keeps the
	// real count.
	requestResultNames = 200
	// requestProgressEvery throttles request:progress like recv:progress.
	requestProgressEvery = 100 * time.Millisecond
)

// requestDrop is one pairing's own state, from channel open to its end. The
// fields without a lock are written and read on the receive loop's goroutine
// only (Decide and OnFileDone run on it); the flags are set from the timers,
// the cancel and the message watcher.
type requestDrop struct {
	abort  func(code transfer.RefusalCode) // the coded frame, then the connection closed
	closed <-chan struct{}                 // the data channel's own close (peer.Early)
	route  string
	tally  dropTally
	cap    *time.Timer // the 24 h cap, armed at Accept

	files   int    // the visitor's announced count, for the result
	folder  string // the drop's own folder, "" until Accept
	outcome string // how a prompt ended without a drop: declined, expired, left

	incoming    atomic.Bool // the first metadata reached OnIncoming
	accepted    atomic.Bool // Accept found the channel open and made the folder
	openExpired atomic.Bool // the E-35 timer fired
	peerAbort   atomic.Bool // the visitor sent an incompatible frame
	capHit      atomic.Bool // the 24 h cap fired
	ownerCancel atomic.Bool // the owner's Cancel drop
}

// cancelFunc is the drop's Cancel drop: it records that the owner stopped it,
// then sends stopped and closes on its own goroutine, so the bound call never
// waits on a flush, a close, or a receive held in a commit retry of up to 5
// minutes (WP-A2 review L3b). The receive returns on its own and ends the drop.
func (d *requestDrop) cancelFunc() func() {
	return func() {
		d.ownerCancel.Store(true)
		go d.abort(transfer.CodeStopped)
	}
}

// requestDecide is the drop's Decide (step 3): the prompt from numbers and
// host values only, then the owner's answer, the window, the visitor leaving,
// or the link ending, whichever comes first. The engine consults it before any
// folder, staging file or ack exists, and it never returns Accept for a
// channel that already closed (implication 8).
func (a *App) requestDecide(rg uint64, p requestPairing, d *requestDrop, in transfer.IncomingInfo) transfer.Decision {
	refuse := func(code transfer.RefusalCode) transfer.Decision {
		return transfer.Decision{Kind: transfer.DecisionRefuse, Code: code}
	}
	d.files = in.Files
	l := a.lane()
	l.mu.Lock()
	now := l.now
	l.mu.Unlock()
	at := now()
	pg := a.openPrompt(rg, requestPromptFor(p, in, d.route, at))
	if pg == 0 {
		return refuse(transfer.CodeStopped)
	}
	window := time.NewTimer(requestDecideWindow)
	defer window.Stop()
	for {
		select {
		case ans := <-l.decision:
			if ans.promptGen != pg {
				continue
			}
			if ans.answer == "accept" {
				return a.acceptRequestDrop(rg, p, d, at)
			}
			d.outcome = "declined"
			a.endPrompt(rg)
			a.reqUpdate(rg, func(l *requestLane) {
				l.prompt = nil
				l.setStateLocked("declined", "")
			})
			return transfer.Decision{Kind: transfer.DecisionDecline}
		case <-window.C:
			d.outcome = "expired"
			a.endPrompt(rg)
			a.reqUpdate(rg, func(l *requestLane) { l.missedAt = now() })
			return refuse(transfer.CodeExpired)
		case <-d.closed:
			// The visitor left while the owner decided. The engine hears the
			// close only once this returns (F-18), so Decide watches it itself.
			d.outcome = "left"
			a.endPrompt(rg)
			return refuse(transfer.CodeStopped)
		case <-p.stop:
			return refuse(transfer.CodeStopped)
		}
	}
}

// acceptRequestDrop is Accept's half of requestDecide: the channel must still
// be open, then the drop's own folder is made, the 24 h cap is armed, Cancel
// drop is wired, and the lane goes to receiving with the wake hold. Nothing
// exists on disk for an Accept that met a closed channel.
func (a *App) acceptRequestDrop(rg uint64, p requestPairing, d *requestDrop, at time.Time) transfer.Decision {
	stopped := transfer.Decision{Kind: transfer.DecisionRefuse, Code: transfer.CodeStopped}
	select {
	case <-d.closed:
		d.outcome = "left"
		a.endPrompt(rg)
		return stopped
	default:
	}
	folder, err := makeDropFolder(p.saveDir, p.label, at)
	if err != nil {
		a.attentionOff()
		return transfer.Decision{Kind: transfer.DecisionRefuse, Code: transfer.CodeWriteFailed}
	}
	if !a.setDropCancel(rg, d.cancelFunc()) || !a.acceptDrop(rg) {
		_ = os.Remove(folder)
		return stopped
	}
	d.folder = folder
	d.accepted.Store(true)
	d.cap = time.AfterFunc(requestDropCap, func() {
		d.capHit.Store(true)
		d.abort(transfer.CodeTimeLimit)
	})
	return transfer.Decision{Kind: transfer.DecisionAccept, OutputDir: folder}
}

// endRequestDrop maps how the receive ended to the lane's state (step 4). A
// drop that was accepted ends through endDrop, whatever rg is now: done, or
// stopped with a fixed code, and its folder removed when nothing was saved in
// it. A pairing that made no drop reopens the room and waits again, stays
// declined, or stops on a refusal this side sent.
func (a *App) endRequestDrop(rg uint64, sc *signaling.Client, d *requestDrop, err error) error {
	if d.accepted.Load() && errors.Is(err, transfer.ErrSenderLeft) {
		// The visitor left between Accept's own open check and the engine's:
		// nothing was claimed or acked. The empty folder goes, the wake hold
		// Accept took is released here (no endDrop: the link was not used),
		// and the link waits again as for any leave before a drop.
		_ = os.Remove(d.folder)
		a.requestWakeRelease(rg)
		d.accepted.Store(false)
		d.outcome = "left"
	}
	if d.accepted.Load() {
		state, code := "done", ""
		if err != nil {
			state, code = "stopped", d.stopCode(err)
		}
		res := d.tally.result(d.files, d.folder)
		if state == "stopped" && res.Saved == 0 {
			_ = os.Remove(d.folder) // an empty folder only; anything in it stays
		}
		a.endDrop(rg, state, code, &res)
		return err
	}
	if !a.requestActive(rg) {
		return err
	}
	var refused *transfer.RefusedError
	switch {
	case d.outcome == "declined":
		return err // the owner picks Keep waiting or Close link
	case d.outcome == "expired":
		return a.reopenRequest(rg, sc, "", err) // missedAt is set (W10)
	case d.outcome == "left", errors.Is(err, transfer.ErrSenderLeft):
		return a.reopenRequest(rg, sc, "visitor-left", err)
	case d.openExpired.Load():
		return a.reopenRequest(rg, sc, "setup-failed", err) // E-35
	case errors.As(err, &refused) && refused.Code != "":
		// This side refused before anything was accepted (the limits, or a
		// drop folder that could not be made): the link is used up.
		res := d.tally.result(d.files, "")
		a.endDrop(rg, "stopped", string(refused.Code), &res)
		return err
	case d.peerAbort.Load(), channelClosed(d.closed):
		// The visitor stopped before anything was accepted, in its own words
		// or with a bare close: nothing was agreed, so the link waits again.
		return a.reopenRequest(rg, sc, "visitor-left", err)
	case !d.incoming.Load():
		// No first metadata ever arrived (the idle watchdog), or the visitor
		// speaks a protocol this side cannot: the sender could not connect.
		return a.reopenRequest(rg, sc, "setup-failed", err)
	}
	res := d.tally.result(d.files, "")
	a.endDrop(rg, "stopped", "unknown", &res)
	return err
}

// stopCode is the fixed code for an accepted drop that ended in err: the
// owner's Cancel drop, the 24 h cap, a file that could not be moved into
// place, a refusal this side sent, an abort the visitor sent in its own words
// (the only code that blames the sender, E-42), or unknown (ST14) for every
// engine error that no peer frame explains. The visitor's own code, if it sent
// one, never picks the owner's copy.
func (d *requestDrop) stopCode(err error) string {
	var commit *transfer.CommitError
	var refused *transfer.RefusedError
	switch {
	case d.ownerCancel.Load():
		return string(transfer.CodeStopped)
	case d.capHit.Load():
		return string(transfer.CodeTimeLimit)
	case errors.As(err, &commit):
		return string(transfer.CodeSaveBlocked)
	case errors.As(err, &refused) && refused.Code != "":
		return string(refused.Code)
	case d.peerAbort.Load():
		return "peer-abort"
	}
	return "unknown"
}

// channelClosed reports whether ch has closed, without waiting.
func channelClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// drainSignals empties sc.Signal without blocking and takes one PeerLeft push,
// before each peer.New: a previous visitor's trickled candidates must never
// reach this visitor's connection (E-39), and a previous visitor's leave must
// not end this visitor's setup at once now that setup watches PeerLeft
// (S1-ENG-11). It returns how many signals it dropped.
func drainSignals(sc *signaling.Client) int {
	n := 0
	for {
		select {
		case <-sc.Signal:
			n++
		default:
			select {
			case <-sc.PeerLeft:
			default:
			}
			return n
		}
	}
}

// requestLimits is the drop's ReceiveLimits: the request link's layer 2
// (10,000 files, the 2 GiB reserve, the name hook, the host relay check) and
// E-36's five-minute commit retry.
func requestLimits() *transfer.ReceiveLimits {
	return &transfer.ReceiveLimits{
		MaxFiles:        requestMaxFiles,
		FreeReserve:     requestFreeReserve,
		BlockShellTypes: true,
		HostRelayCheck:  true,
		CommitRetry:     requestCommitRetry,
	}
}

// requestPromptFor builds the Accept prompt from numbers and host values only
// (OD-04, Q-C7): the visitor's counts, this PC's folder, clock and free space,
// and warning codes. in.FirstName is never read.
func requestPromptFor(p requestPairing, in transfer.IncomingInfo, route string, now time.Time) RequestPrompt {
	pr := RequestPrompt{
		Files:      in.Files,
		TotalBytes: in.TotalBytes,
		Folder:     filepath.Join(filepath.Base(p.saveDir), dropFolderName(p.label, now)),
		AnswerBy:   now.Add(requestDecideWindow).UnixMilli(),
	}
	// The drop folder does not exist yet, so the volume is asked through the
	// nearest folder that does.
	if dir := nearestDir(p.saveDir); dir != "" {
		if free, err := transfer.DiskFree(dir); err == nil && free >= 0 {
			pr.FreeBytes = free
			if free-in.TotalBytes < requestFreeReserve {
				pr.Warnings = append(pr.Warnings, "low-space")
			}
		}
		if limit, err := transfer.VolumeMaxFileSize(dir); err == nil && limit > 0 && limit < max(in.FirstSize, in.TotalBytes) {
			pr.Warnings = append(pr.Warnings, "file-too-large-for-drive")
		}
	}
	if (route == "relay" || p.hideIP) && in.TotalBytes > transfer.RelaySizeLimit {
		pr.Warnings = append(pr.Warnings, "relay-over-cap")
	}
	return pr
}

// nearestDir is dir, or its nearest parent that exists, or "".
func nearestDir(dir string) string {
	for d := filepath.Clean(dir); ; {
		if dirExists(d) {
			return d
		}
		parent := filepath.Dir(d)
		if parent == d {
			return ""
		}
		d = parent
	}
}

// dropFolderStamp is the time part of a drop folder's name, and
// dropFolderMaxBytes the most its label part may take: the whole name, with
// the stamp and a " (99)", stays within the 255-byte component limit of ext4
// and APFS, and UTF-8 never takes fewer bytes than UTF-16 takes units, so
// NTFS's 255 units hold as well (review 1b N2).
const (
	dropFolderStamp    = "2006-01-02 1504"
	dropFolderMaxBytes = 255 - len(" "+dropFolderStamp) - len(" (99)")
)

// dropFolderName is "<label> YYYY-MM-DD HHMM" from this PC's clock (spec 06
// 4.7): the label through sanitizeRequestLabel, cut on a rune boundary to
// dropFolderMaxBytes.
func dropFolderName(label string, now time.Time) string {
	l := sanitizeRequestLabel(label)
	for len(l) > dropFolderMaxBytes {
		_, size := utf8.DecodeLastRuneInString(l)
		l = l[:len(l)-size]
	}
	if l = strings.TrimRight(l, " ."); l == "" {
		l = "Request"
	}
	return l + " " + now.Format(dropFolderStamp)
}

// makeDropFolder creates the drop's own folder under base, only now that the
// owner accepted with the channel open (spec 06 4.7): MkdirAll on the base,
// then an exclusive Mkdir on the leaf, trying " (2)" to " (99)" when the name
// is taken. It never reuses, and never writes into, a folder that exists.
func makeDropFolder(base, label string, now time.Time) (string, error) {
	abs, err := filepath.Abs(base)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", err
	}
	name := dropFolderName(label, now)
	for i := 1; i <= 99; i++ {
		leaf := name
		if i > 1 {
			leaf = fmt.Sprintf("%s (%d)", name, i)
		}
		p := filepath.Join(abs, leaf)
		err := os.Mkdir(p, 0o755)
		if err == nil {
			return p, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", fmt.Errorf("no free drop folder name under the save folder")
}

// dropTally counts an accepted drop's committed files for its result.
// OnFileDone feeds it on the receive loop; the cancel and the 24 h cap read
// the saved count from their own goroutines, hence the lock.
type dropTally struct {
	mu       sync.Mutex
	saved    int
	bytes    int64
	verified int
	renamed  int
	names    []string
}

// add records one committed file. SavedName is the engine's on-disk name,
// relative to the drop folder; a name the hook renamed ends in .floe-blocked.
func (t *dropTally) add(d transfer.FileDone) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.saved++
	t.bytes += d.Bytes
	if d.Verified {
		t.verified++
	}
	if strings.HasSuffix(d.SavedName, ".floe-blocked") {
		t.renamed++
	}
	if len(t.names) < requestResultNames {
		t.names = append(t.names, d.SavedName)
	}
}

func (t *dropTally) savedCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.saved
}

// result is the drop's RequestResult: files is the visitor's announced count,
// folder the drop's own folder.
func (t *dropTally) result(files int, folder string) RequestResult {
	t.mu.Lock()
	defer t.mu.Unlock()
	return RequestResult{
		Files: files, Saved: t.saved, Bytes: t.bytes, Verified: t.verified, Renamed: t.renamed,
		Folder: folder, Names: append([]string{}, t.names...),
	}
}

// throttleProgress forwards progress at most once per every, and always a
// file's final update, like recv:progress in receiveByCode.
func throttleProgress(every time.Duration, now func() time.Time, emit func(transfer.Progress)) func(transfer.Progress) {
	var last time.Time
	return func(p transfer.Progress) {
		t := now()
		if !last.IsZero() && t.Sub(last) < every && p.FileBytes < p.FileSize {
			return
		}
		last = t
		emit(p)
	}
}

// dataMessage is pion's DataChannelMessage by shape; see watchAbortFrames.
type dataMessage = struct {
	IsString bool
	Data     []byte
}

// controlFrameMax is the engine's control-frame cap (transfer's
// controlMsgMax): a longer string is prose to the engine, never an abort.
const controlFrameMax = 1000

// watchAbortFrames sits between the data channel's pump (peer.Early) and the
// receive loop and hands every message on, in order, noting in saw whether the
// visitor sent an incompatible frame: an abort in its own words, the one peer
// frame that makes a stop the sender's (peer-abort, ST11, E-42). Only the
// frame's type is read; the reason it carries never leaves isAbortFrame. The
// closed channel it returns closes once the data channel has closed AND every
// message queued before the close was handed on, so the receive loop, which
// prefers queued messages to a close, still sees them all. quit stops it once
// the receive has returned.
//
// Generic over the message type because naming pion's type here would make
// pion a direct requirement of desktop/go.mod, which reaches the released
// floe binary through the workspace (see requireRelay); the constraint still
// pins the shape at compile time.
func watchAbortFrames[M ~dataMessage](in <-chan M, closed, quit <-chan struct{}, saw *atomic.Bool) (<-chan M, <-chan struct{}) {
	out := make(chan M, cap(in))
	outClosed := make(chan struct{})
	pass := func(m M) bool {
		if dm := dataMessage(m); dm.IsString && isAbortFrame(dm.Data) {
			saw.Store(true)
		}
		select {
		case out <- m:
			return true
		case <-quit:
			return false
		}
	}
	go func() {
		for {
			select {
			case m := <-in:
				if !pass(m) {
					return
				}
			case <-closed:
				for {
					select {
					case m := <-in:
						if !pass(m) {
							return
						}
					default:
						close(outClosed)
						return
					}
				}
			case <-quit:
				return
			}
		}
	}()
	return out, outClosed
}

// isAbortFrame reports whether a text frame from the visitor is an
// incompatible frame, the way the engine classifies control frames: at most
// controlFrameMax bytes, a JSON object, "type" read by its exact key.
func isAbortFrame(data []byte) bool {
	if len(data) > controlFrameMax {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return false
	}
	var typ string
	return json.Unmarshal(fields["type"], &typ) == nil && typ == "incompatible"
}

// isRequestLinkPaste reports whether a receive failed because the input was a
// browser-only request or drop link (code.ErrRequestLink, code.ErrDropLink).
// Both errors carry the one approved sentence (CP2). The frontend refuses these
// before calling ReceiveByCode; this is the defense in depth behind it.
func isRequestLinkPaste(err error) bool {
	return errors.Is(err, code.ErrRequestLink) || errors.Is(err, code.ErrDropLink)
}
