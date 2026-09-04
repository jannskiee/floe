package main

// Driving a send or a receive end to end, from the engine call through the
// events the frontend listens for.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

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

// StartSend validates the given paths and launches the send flow in the
// background. Progress is reported to the UI via Wails events:
//   - "send:code"   {code, link}  once the room code is registered
//   - "send:status" string        status updates (peer connected, etc.)
//   - "send:done"   string        transfer finished
//   - "send:error"  string        any failure
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
	defer a.wake.release(g)
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

	iceServers, err := ice.Fetch(server)
	if err != nil {
		fail(fmt.Errorf("failed to fetch ICE credentials: %w", err))
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
	a.wake.acquire(g)

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
		UpdateHint: desktopUpdateHint,
		Messages:   sendEarly.Msgs,
		Closed:     sendEarly.Closed,
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
// Returns the absolute output directory on success.
func (a *App) ReceiveByCode(codeOrLink string, outputDir string, hideIP bool, reportStats bool) (string, error) {
	g := a.beginTransfer()
	dir, err := a.receiveByCode(g, codeOrLink, outputDir, hideIP, reportStats)
	if err != nil {
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
	defer a.wake.release(g)
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
		return "", fmt.Errorf("could not resolve %q: %w", codeOrLink, err)
	}

	iceServers, err := ice.Fetch(server)
	if err != nil {
		return "", fmt.Errorf("failed to fetch ICE credentials: %w", err)
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
	a.wake.acquire(g)

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
