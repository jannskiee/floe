package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/serverurl"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/jannskiee/floe/cli/engine/verify"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// defaultServer is the production Floe signaling server, used unless Settings
// names another one. On the default the desktop app talks to the same
// infrastructure as the browser and CLI, so transfers interoperate; point it at
// a self-hosted server and it interoperates with peers on that server instead.
const defaultServer = "https://api.floe.one"

const desktopUpdateHint = "Update Floe from the Microsoft Store or floe.one/download."

// The share-link origin is no longer a constant here. It is derived from the
// signaling origin by engine/serverurl, which the CLI uses too, so both surfaces
// emit identical links. See App.endpoints.

// contextMenuBase is the per-user Explorer context-menu key for all file types.
const contextMenuBase = `Software\Classes\*\shell\Floe`

// expectedCommand is the context-menu launch command for the given executable.
func expectedCommand(exe string) string {
	return fmt.Sprintf(`"%s" "%%1"`, exe)
}

// shareLink builds the browser link for a send. The room id is the transfer's only
// secret, so it goes in the URL fragment: browsers never send a fragment to a
// server, strip it from the Referer header, and ignore it in analytics. The nonce
// goes in the query instead. It carries no information, and it makes every link a
// distinct document so a phone that already has Floe open joins the new room rather
// than reusing a stale tab. Mirrors client/components/P2PTransfer.tsx.
func shareLink(base, nonce, roomID string) string {
	return base + "/?s=" + nonce + "#room=" + roomID
}

// filterFileArgs keeps only arguments that point at an existing file or
// directory, dropping flags, empty strings, and stale paths.
func filterFileArgs(args []string) []string {
	var out []string
	for _, arg := range args {
		if arg == "" || strings.HasPrefix(arg, "-") {
			continue
		}
		if _, err := os.Stat(arg); err == nil {
			out = append(out, arg)
		}
	}
	return out
}

// closer is the one method CancelTransfer needs from the signaling client and
// the peer connection. An interface so unit tests can register recorders.
type closer interface{ Close() }

// App struct
type App struct {
	ctx context.Context

	// mu guards the transfer generation and the handles to the in-flight
	// transfer's signaling and peer connections so CancelTransfer can close
	// them from the UI goroutine. gen is the id of the transfer that owns the
	// slots: a transfer goroutine carries the gen it was born with, and every
	// setter, clear, wake release, event emit, and toast refuses once a newer
	// transfer has begun or the user cancelled. A cancelled or superseded
	// goroutine can therefore never clobber a live transfer's handles (the old
	// bug: cancel, instantly restart, and up to 30 seconds later the dead
	// goroutine's deferred clear wiped the live transfer's cancel handles).
	mu        sync.Mutex
	gen       uint64
	cancelled bool // the OWNING generation was cancelled by the user
	curSC     closer
	curConn   closer

	// wake keeps the machine awake for the duration of a connected transfer
	// (Windows only; a no-op on other platforms). See wake.go.
	wake *wakeGuard

	// pendingFiles holds file paths passed on the command line (Explorer's
	// "Send with Floe", drag-onto-exe) until the frontend pulls them.
	pendingFiles []string

	// cfg is every persisted setting: the server override plus the preference
	// toggles. Written from the UI goroutine when the user saves Settings and read
	// from the transfer goroutine, so it is guarded by mu like everything else here.
	cfg appConfig

	// notifyFn is the test seam for OS notifications; nil means the real Wails
	// runtime notification (see notify).
	notifyFn func(title, body string)
}

// NewApp creates a new App application struct
func NewApp() *App {
	// Loaded here rather than in startup: startup runs on a goroutine after the
	// window exists, which would leave a window where a transfer could begin
	// against the wrong server. Failures fall back to the Floe defaults.
	return &App{wake: newWakeGuard(), cfg: loadConfig()}
}

// endpoints resolves the signaling origin and the share-link origin to use for
// one transfer.
//
// Callers take a single snapshot and pass it down, so changing the setting while
// a transfer is running cannot split that transfer across two servers.
func (a *App) endpoints() (server, web string) {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()

	server = cfg.Server
	if server == "" {
		server = defaultServer
	}
	web = cfg.Web
	if web == "" {
		// serverurl.Web maps the production and local-dev pairs to their web
		// hosts and leaves a one-domain self-hosted address alone. Shared with
		// the CLI so both surfaces emit identical links.
		web = serverurl.Web(server)
	}
	return server, web
}

// GetSettings returns every persisted setting for the Settings screen. Empty
// address fields mean "using the Floe defaults" and render as placeholders.
//
// When Migrated is false the toggles have never been written here, and the
// frontend imports them once from the localStorage keys they used to live in.
func (a *App) GetSettings() appConfig {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// SetSettings persists the whole settings record. Either address may be empty to
// fall back to the default. It does not verify the address; TestServer does that
// on demand, so a user can save an address for a server that is not up yet.
//
// Writing always marks the record migrated, so the one-time localStorage import
// cannot run twice and re-resurrect a preference the user has since changed.
func (a *App) SetSettings(server, web string, hideIP, reportStats bool) error {
	// The whole read-modify-write holds the lock. Wails dispatches every bound
	// call on its own goroutine, and this method races SetCheckUpdates when the
	// Settings screen fires unawaited saves on quick toggle flips; a snapshot
	// taken before the other writer's write-back would silently resurrect the
	// stale record. saveConfig is a small atomic write, cheap to hold across.
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := settingsFromArgs(a.cfg, server, web, hideIP, reportStats)
	if err := saveConfig(cfg); err != nil {
		return err
	}
	a.cfg = cfg
	return nil
}

// settingsFromArgs builds the record SetSettings persists. Fields owned by
// other setters (NoUpdateCheck, via SetCheckUpdates) are carried over from the
// current record: SetSettings used to construct a fresh appConfig from only
// its arguments, which silently zeroed any field the Settings screen did not
// know about on every save.
func settingsFromArgs(cur appConfig, server, web string, hideIP, reportStats bool) appConfig {
	return normalizeConfig(appConfig{
		Server:        server,
		Web:           web,
		HideIP:        hideIP,
		ReportStats:   reportStats,
		NoUpdateCheck: cur.NoUpdateCheck,
		Migrated:      true,
	})
}

// SetCheckUpdates persists the update-check toggle alone, leaving every other
// setting untouched. enabled=true is the shipped default (NoUpdateCheck=false).
// Holds the lock across the whole read-modify-write for the same reason
// SetSettings does: the two setters race on quick toggle flips.
func (a *App) SetCheckUpdates(enabled bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := a.cfg
	cfg.NoUpdateCheck = !enabled
	if err := saveConfig(cfg); err != nil {
		return err
	}
	a.cfg = cfg
	return nil
}

// startup is called when the app starts. The context is saved so we can call the
// runtime methods (events, dialogs).
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Best-effort: register the app for OS notifications (sets up the toast
	// AppUserModelID on Windows). Errors are non-fatal.
	_ = runtime.InitializeNotifications(ctx)

	// Reclaim any pasted-image staging dirs left by a previous run.
	sweepPasteTemps()

	// Files passed on the command line are staged for the frontend to pull once
	// it mounts (pull, not an event: startup runs before listeners exist).
	a.mu.Lock()
	a.pendingFiles = filterFileArgs(os.Args[1:])
	a.mu.Unlock()

	// Best-effort self-heal: if the user enabled the context menu and the exe
	// has moved since, rewrite the entry to point here. Skipped when packaged:
	// an MSIX process's HKCU write lands in a private view Explorer never
	// reads, so the rewrite could only produce a lie (see packaged_windows.go).
	if goruntime.GOOS == "windows" && !isPackaged() {
		if exe, err := os.Executable(); err == nil {
			if cmd, ok := contextMenuCommand(contextMenuBase); ok && cmd != expectedCommand(exe) {
				_ = registerContextMenu(contextMenuBase, exe)
			}
		}
	}
}

// shutdown runs when the app is quitting. A transfer goroutine may still hold
// its .part staging file open; its deferred cleanup will not get to run before
// the process ends, so tidy the staging file here. Safe at any moment: only
// .part files are registered, and a completed file's commit rename vacated
// that path, so nothing that finished can be touched.
func (a *App) shutdown(ctx context.Context) {
	transfer.AbandonPartials()
}

// onSecondInstanceLaunch fires when Floe is launched again while already running.
// Rather than open a second window, bring the existing one to the front and
// forward any file arguments (the Explorer context menu launches one process
// per selected file; each lands here).
func (a *App) onSecondInstanceLaunch(data options.SecondInstanceData) {
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
	if files := filterFileArgs(data.Args); len(files) > 0 {
		runtime.EventsEmit(a.ctx, "files:open", files)
	}
}

// GetPendingFiles returns files passed on the command line and clears them.
// The frontend calls this once on mount.
func (a *App) GetPendingFiles() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.pendingFiles
	a.pendingFiles = nil
	return p
}

// PasteFiles returns files to send from the OS clipboard for a Ctrl+V paste:
// file paths copied in Explorer (sent as-is, zero copy), or, failing that, a
// screenshot / copied image staged as a pasted-image.png temp file. Best-effort
// and Windows-only today; an empty or non-file clipboard yields nothing.
func (a *App) PasteFiles() []string {
	if paths := filterFileArgs(clipboardFilePaths()); len(paths) > 0 {
		return paths
	}
	if png := clipboardImagePNG(); len(png) > 0 {
		if path, err := writeImageTemp(png); err == nil {
			return []string{path}
		}
	}
	return nil
}

// IsPackaged reports whether this build runs with MSIX package identity (the
// Microsoft Store install). The Settings screen hides the Explorer
// context-menu toggle when it does: a packaged process's HKCU writes land in
// a private registry view that Explorer never reads, so the verb cannot work,
// and a Store uninstall runs no cleanup that could remove a stale entry.
func (a *App) IsPackaged() bool {
	return isPackaged()
}

// EnableContextMenu adds the "Send with Floe" entry to the Explorer right-click
// menu for the current user (Windows only, unpackaged builds only).
func (a *App) EnableContextMenu() error {
	if isPackaged() {
		// Unreachable through the UI (the toggle is hidden when packaged);
		// a clear error beats a write that would silently do nothing.
		return fmt.Errorf("the right-click menu is not available in the Microsoft Store build")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return registerContextMenu(contextMenuBase, exe)
}

// DisableContextMenu removes the Explorer entry. Deliberately not gated on
// isPackaged: removal is harmless everywhere, so a cleanup call can never fail
// for channel reasons.
func (a *App) DisableContextMenu() error {
	return unregisterContextMenu(contextMenuBase)
}

// ContextMenuEnabled reports whether the entry exists and points at the current
// executable; a moved exe reads as disabled until re-enabled. Always false when
// packaged: the merged registry view could report an entry that Explorer does
// not actually show, and false is the truth that matters (the feature is off).
func (a *App) ContextMenuEnabled() bool {
	if isPackaged() {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	cmd, ok := contextMenuCommand(contextMenuBase)
	return ok && cmd == expectedCommand(exe)
}

// notify sends a best-effort OS notification. Failures are ignored so a transfer
// outcome never depends on the notification succeeding. notifyFn is the test
// seam: nil means the real Wails runtime notification.
func (a *App) notify(title, body string) {
	if a.notifyFn != nil {
		a.notifyFn(title, body)
		return
	}
	_ = runtime.SendNotification(a.ctx, runtime.NotificationOptions{Title: title, Body: body})
}

// notifyTransferFailed sends the failure toast unless the transfer was
// cancelled by the user or superseded by a newer attempt: a cancel is not a
// failure, and a dead attempt must not toast over the live one. The body is
// deliberately generic (the toast matters exactly when the window is
// backgrounded); the in-app status line carries the mapped detail.
func (a *App) notifyTransferFailed(g uint64, title string) {
	if !a.transferActive(g) {
		return
	}
	a.notify(title, "The transfer did not complete. Open Floe to see what happened.")
}

// EngineProtocolVersion returns the wire protocol version of the embedded engine.
// It proves the shared engine is linked into the desktop binary.
func (a *App) EngineProtocolVersion() int {
	return transfer.ProtocolVersion
}

// GetVersion returns the app's build version string ("dev" for local builds).
func (a *App) GetVersion() string {
	return version
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

// fileExists reports whether p exists and is a regular file (not a directory).
func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// safeLeaf reduces a peer-supplied name to a single in-directory path component
// so it cannot escape the target dir when joined. It defeats path traversal
// (.., absolute, UNC, drive-letter, and forward- or back-slash separators) by
// normalizing every backslash to a forward slash and keeping only the final
// component, independent of the build OS. Returns ("", false) when there is no
// usable leaf (".", "..", ""), so the caller falls back to opening the folder.
// This is the security boundary for RevealFile/OpenFile: the UI passes the raw
// sender-controlled file name, so the guard must live here, not in the webview.
func safeLeaf(name string) (string, bool) {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	if name == "." || name == ".." || name == "" {
		return "", false
	}
	return name, true
}

// revealCmd returns the command that opens the OS file manager with path
// selected/highlighted. Windows uses `explorer /select,<path>` as a SINGLE
// argument: explorer parses its own command line, and splitting it into two
// args often opens the folder without selecting. The path must use backslashes,
// which filepath.Join yields on Windows (do not introduce forward slashes).
// macOS uses `open -R`. Linux has no portable "select this file" verb, so it
// opens the folder instead (dir is passed in for exactly this, so we never call
// filepath.Dir and the pure helper stays host-separator independent for tests).
func revealCmd(goos, dir, path string) *exec.Cmd {
	switch goos {
	case "windows":
		return exec.Command("explorer", "/select,"+path)
	case "darwin":
		return exec.Command("open", "-R", path)
	default:
		return exec.Command("xdg-open", dir)
	}
}

// openCmd returns the command that opens path in its default application.
// Windows uses rundll32's FileProtocolHandler, the reliable shell-open primitive
// (it avoids cmd.exe's quoting hazards and explorer.exe's unreliability). It
// treats the argument URL-ish, so a literal '#' or '%' in the path is a rare
// unhandled edge; the fully correct fix (ShellExecuteW) would need a syscall
// dependency and is not worth it here.
func openCmd(goos, path string) *exec.Cmd {
	switch goos {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	case "darwin":
		return exec.Command("open", path)
	default:
		return exec.Command("xdg-open", path)
	}
}

// RevealFile opens the OS file manager with the received file dir/name selected.
// If the exact file is missing it falls back to opening the folder, so the
// action is never broken. Live transfers pass the engine's SavedName (the real
// on-disk name, de-collided by createUnique), so the fallback now covers only
// history entries persisted before SavedName existed (those hold the sender's
// name forever) and files moved/deleted after the transfer.
func (a *App) RevealFile(dir, name string) error {
	if dir == "" {
		return fmt.Errorf("no folder to open")
	}
	leaf, ok := safeLeaf(name)
	if !ok {
		return a.OpenFolder(dir)
	}
	p := filepath.Join(dir, leaf)
	if fileExists(p) {
		return revealCmd(goruntime.GOOS, dir, p).Start()
	}
	return a.OpenFolder(dir)
}

// OpenFile opens the received file dir/name in its default application, falling
// back to opening the folder if the exact file is missing (see RevealFile).
func (a *App) OpenFile(dir, name string) error {
	if dir == "" {
		return fmt.Errorf("no file to open")
	}
	leaf, ok := safeLeaf(name)
	if !ok {
		return a.OpenFolder(dir)
	}
	p := filepath.Join(dir, leaf)
	if fileExists(p) {
		return openCmd(goruntime.GOOS, p).Start()
	}
	return a.OpenFolder(dir)
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

// beginTransfer claims the transfer slots for a new attempt and returns its
// generation tag. Any previous attempt is superseded from this moment: its
// setters, clear, wake release, emits, and toasts all become no-ops. The old
// goroutine's own defers still close the handles it holds.
func (a *App) beginTransfer() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.gen++
	a.cancelled = false
	a.curSC, a.curConn = nil, nil
	return a.gen
}

// setSignaling / setConn register a handle for generation g so CancelTransfer
// can reach it. They return false when g no longer owns the slots (superseded
// by a newer transfer) or was cancelled; the caller must bail out immediately
// and let its own deferred Close release the handle. Refusing on cancelled
// also closes the window where a cancel lands between the two setters and the
// goroutine would otherwise park un-interruptibly in WebRTC setup for up to
// 30 seconds holding an orphaned connection.
func (a *App) setSignaling(g uint64, sc closer) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if g != a.gen || a.cancelled {
		return false
	}
	a.curSC = sc
	return true
}

func (a *App) setConn(g uint64, conn closer) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if g != a.gen || a.cancelled {
		return false
	}
	a.curConn = conn
	return true
}

// clearTransfer releases the slots iff generation g still owns them, so a
// superseded goroutine's deferred clear cannot wipe a live transfer's handles.
func (a *App) clearTransfer(g uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if g != a.gen {
		return
	}
	a.curSC, a.curConn = nil, nil
}

// transferActive reports whether generation g is still the live, uncancelled
// transfer. It gates event emits and toasts so a cancelled or superseded
// attempt goes silent instead of talking over its successor.
func (a *App) transferActive(g uint64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return g == a.gen && !a.cancelled
}

// CancelTransfer aborts the current send or receive: it marks the owning
// generation cancelled (suppressing its failure toast and late events) and
// closes its signaling and peer connections. Closing the signaling client
// unblocks a sender waiting for a receiver (via PeerLeft); closing the peer
// connection unblocks a stuck WebRTC setup (via the connection-state error).
// Safe to call when nothing is running.
//
// Ordering contract: it cancels whatever attempt is live when it EXECUTES, so
// a caller must not dispatch a new StartSend/ReceiveByCode until this call has
// been issued and processed; two unawaited bridge calls fired in the same tick
// have no cross-call ordering guarantee, and a reordered pair would cancel the
// new attempt instead of the old one. The UI satisfies this trivially (the
// user's next click is far behind the cancel dispatch); programmatic drivers
// must await CancelTransfer before starting the next transfer.
func (a *App) CancelTransfer() {
	a.mu.Lock()
	a.cancelled = true
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

	if local, remote, fErr := conn.Fingerprints(); fErr == nil {
		vc := verify.Code(local, remote)
		go emit("send:verify", vc) // off the transfer critical path
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

	if local, remote, fErr := conn.Fingerprints(); fErr == nil {
		vc := verify.Code(local, remote)
		go emit("recv:verify", vc) // off the transfer critical path
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
