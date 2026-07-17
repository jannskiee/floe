package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/jannskiee/floe/cli/engine/verify"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// defaultServer is the production Floe signaling server. The desktop app talks to
// the same infrastructure as the browser and CLI, so transfers interoperate.
const defaultServer = "https://api.floe.one"

// webURL is the browser app, used to build the shareable link for a send.
const webURL = "https://floe.one"

// App struct
type App struct {
	ctx context.Context

	// mu guards the handles to the in-flight transfer's signaling and peer
	// connections so CancelTransfer can close them from the UI goroutine to
	// unblock a send/receive that is waiting for a peer or stuck connecting.
	mu      sync.Mutex
	curSC   *signaling.Client
	curConn *peer.Connection
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved so we can call the
// runtime methods (events, dialogs).
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Best-effort: register the app for OS notifications (sets up the toast
	// AppUserModelID on Windows). Errors are non-fatal.
	_ = runtime.InitializeNotifications(ctx)
}

// onSecondInstanceLaunch fires when Floe is launched again while already running.
// Rather than open a second window, bring the existing one to the front.
func (a *App) onSecondInstanceLaunch(_ options.SecondInstanceData) {
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
}

// notify sends a best-effort OS notification. Failures are ignored so a transfer
// outcome never depends on the notification succeeding.
func (a *App) notify(title, body string) {
	_ = runtime.SendNotification(a.ctx, runtime.NotificationOptions{Title: title, Body: body})
}

// EngineProtocolVersion returns the wire protocol version of the embedded engine.
// It proves the shared engine is linked into the desktop binary.
func (a *App) EngineProtocolVersion() int {
	return transfer.ProtocolVersion
}

// SelectFiles opens a native file picker and returns the chosen absolute paths.
func (a *App) SelectFiles() ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select files to send",
	})
}

// SelectFolder opens a native folder picker and returns the chosen path.
// Used both to choose a folder to send and to choose where to save received files.
func (a *App) SelectFolder() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select a folder",
	})
}

// OpenFolder reveals the given path in the OS file manager.
func (a *App) OpenFolder(path string) error {
	if path == "" {
		return fmt.Errorf("no path to open")
	}
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	// Launch without waiting: explorer.exe in particular can return a non-zero
	// exit code even on success, and we only care that it started.
	return cmd.Start()
}

// defaultReceiveDir returns a safe default save location (the user's Downloads
// folder, or home) so a blank destination never writes into the app's working
// directory and clobbers unrelated files.
func defaultReceiveDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	if dl := filepath.Join(home, "Downloads"); dirExists(dl) {
		return dl
	}
	return home
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// relayOpts returns the peer options for a transfer: relay-only ("hide my IP")
// when hideIP is set, otherwise none.
func relayOpts(hideIP bool) []peer.Option {
	if hideIP {
		return []peer.Option{peer.WithRelayOnly()}
	}
	return nil
}

// setSignaling / setConn register the in-flight connections so CancelTransfer
// can reach them; clearTransfer resets them when the transfer goroutine returns.
func (a *App) setSignaling(sc *signaling.Client) {
	a.mu.Lock()
	a.curSC = sc
	a.mu.Unlock()
}

func (a *App) setConn(conn *peer.Connection) {
	a.mu.Lock()
	a.curConn = conn
	a.mu.Unlock()
}

func (a *App) clearTransfer() {
	a.mu.Lock()
	a.curSC = nil
	a.curConn = nil
	a.mu.Unlock()
}

// CancelTransfer aborts the current send or receive by closing its signaling and
// peer connections. Closing the signaling client unblocks a sender waiting for a
// receiver (via PeerLeft); closing the peer connection unblocks a stuck WebRTC
// setup (via the connection-state error). Safe to call when nothing is running.
func (a *App) CancelTransfer() {
	a.mu.Lock()
	sc, conn := a.curSC, a.curConn
	a.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
	if sc != nil {
		sc.Close()
	}
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
	go a.runSend(paths, hideIP)
	return nil
}

func (a *App) runSend(paths []string, hideIP bool) {
	fail := func(err error) {
		runtime.EventsEmit(a.ctx, "send:error", err.Error())
		a.notify("Floe - send failed", err.Error())
	}

	roomID := uuid.New().String()

	iceServers, err := ice.Fetch(defaultServer)
	if err != nil {
		fail(fmt.Errorf("failed to fetch ICE credentials: %w", err))
		return
	}

	sc, err := signaling.Connect(defaultServer)
	if err != nil {
		fail(fmt.Errorf("failed to connect to signaling server: %w", err))
		return
	}
	defer sc.Close()
	a.setSignaling(sc)
	defer a.clearTransfer()

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
	codePhrase, err := code.Register(defaultServer, roomID)
	if err != nil {
		codePhrase = ""
	}
	link := webURL + "?room=" + roomID
	runtime.EventsEmit(a.ctx, "send:code", map[string]string{"code": codePhrase, "link": link})

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
	runtime.EventsEmit(a.ctx, "send:status", "Peer connected. Sending...")

	// Set up WebRTC as the initiator and send.
	conn, err := peer.New(iceServers, sc, relayOpts(hideIP)...)
	if err != nil {
		fail(fmt.Errorf("failed to create peer connection: %w", err))
		return
	}
	defer conn.Close()
	a.setConn(conn)

	dc, err := conn.SetupAsSender()
	if err != nil {
		fail(fmt.Errorf("WebRTC setup failed: %w", err))
		return
	}

	if local, remote, fErr := conn.Fingerprints(); fErr == nil {
		vc := verify.Code(local, remote)
		go runtime.EventsEmit(a.ctx, "send:verify", vc) // off the transfer critical path
	}

	lastEmit := time.Now()
	onProgress := func(p transfer.Progress) {
		// Throttle UI events to ~10/sec, but always emit a file's final update
		// so the bar reliably reaches 100%.
		if time.Since(lastEmit) < 100*time.Millisecond && p.FileBytes < p.FileSize {
			return
		}
		lastEmit = time.Now()
		runtime.EventsEmit(a.ctx, "send:progress", p)
	}
	if err := transfer.SendFilesWithProgress(dc, paths, version, onProgress); err != nil {
		fail(fmt.Errorf("transfer failed: %w", err))
		return
	}
	runtime.EventsEmit(a.ctx, "send:done", "Files sent successfully.")
	a.notify("Floe", "Files sent successfully.")
}

// ReceiveByCode connects to a peer using a Floe room code (or link) and receives
// the incoming files into outputDir. It reuses the exact same engine the CLI uses
// (signaling, Pion WebRTC, the transfer protocol), so it interoperates with both
// browser senders and CLI senders. WebRTC and all file bytes run in Go here; the
// webview never touches the data channel.
//
// Returns the absolute output directory on success.
func (a *App) ReceiveByCode(codeOrLink string, outputDir string, hideIP bool) (string, error) {
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

	roomID, err := code.Resolve(defaultServer, codeOrLink)
	if err != nil {
		return "", fmt.Errorf("could not resolve %q: %w", codeOrLink, err)
	}

	iceServers, err := ice.Fetch(defaultServer)
	if err != nil {
		return "", fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}

	sc, err := signaling.Connect(defaultServer)
	if err != nil {
		return "", fmt.Errorf("failed to connect to signaling server: %w", err)
	}
	defer sc.Close()
	a.setSignaling(sc)
	defer a.clearTransfer()

	if err := sc.JoinRoom(roomID); err != nil {
		return "", fmt.Errorf("failed to join room: %w", err)
	}

	select {
	case role := <-sc.Role:
		if role != "receiver" {
			return "", fmt.Errorf("expected receiver role, got %q (is the code correct?)", role)
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

	conn, err := peer.New(iceServers, sc, relayOpts(hideIP)...)
	if err != nil {
		return "", fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()
	a.setConn(conn)

	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return "", fmt.Errorf("WebRTC setup failed: %w", err)
	}

	if local, remote, fErr := conn.Fingerprints(); fErr == nil {
		vc := verify.Code(local, remote)
		go runtime.EventsEmit(a.ctx, "recv:verify", vc) // off the transfer critical path
	}

	// autoAccept=true: a GUI cannot answer a terminal prompt. statsURL="" so the
	// skeleton does not report to the global counter.
	lastEmit := time.Now()
	onProgress := func(p transfer.Progress) {
		if time.Since(lastEmit) < 100*time.Millisecond && p.FileBytes < p.FileSize {
			return
		}
		lastEmit = time.Now()
		runtime.EventsEmit(a.ctx, "recv:progress", p)
	}
	if err := transfer.ReceiveFilesWithProgress(dc, absOutput, true, version, "", onProgress); err != nil {
		return "", fmt.Errorf("transfer failed: %w", err)
	}

	a.notify("Floe", "Files received.")
	return absOutput, nil
}
