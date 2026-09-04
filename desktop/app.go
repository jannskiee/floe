package main

import (
	"context"
	"fmt"
	"os"
	goruntime "runtime"
	"strings"
	"sync"

	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

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

	// busy is true from beginTransfer until the owning goroutine's deferred
	// clearTransfer; together with !cancelled it is the close guard's
	// predicate. allowClose is the one-way "Close anyway" latch: once set,
	// onBeforeClose can never again prevent quitting, no matter what any
	// later transfer does.
	busy       bool
	allowClose bool

	// wake keeps the machine awake for the duration of a connected transfer
	// (Windows only; a no-op on other platforms). See wake.go.
	wake *wakeGuard

	// pendingFiles holds file paths passed on the command line (Explorer's
	// "Send with Floe", drag-onto-exe) until the frontend pulls them.
	// frontendReady flips true, once and forever, the moment the frontend
	// pulls: from then on second-instance files are emitted as events instead
	// of staged, because the pull proves the 'files:open' listener exists (the
	// frontend registers it in the same synchronous effect, just before the
	// pull). Before that flip the JS event bus silently discards emits, which
	// is how a multi-select "Send with Floe" used to deliver one file of five.
	pendingFiles  []string
	frontendReady bool

	// cfg is every persisted setting: the server override plus the preference
	// toggles. Written from the UI goroutine when the user saves Settings and read
	// from the transfer goroutine, so it is guarded by mu like everything else here.
	cfg appConfig

	// notifyFn is the test seam for OS notifications; nil means the real Wails
	// runtime notification (see notify).
	notifyFn func(title, body string)

	// quitFn is the test seam for quitting; nil means runtime.Quit, which
	// log.Fatals on the nil context a bare test App carries.
	quitFn func()
}

// NewApp creates a new App application struct
func NewApp() *App {
	// Loaded here rather than in startup: startup runs on a goroutine after the
	// window exists, which would leave a window where a transfer could begin
	// against the wrong server. Failures fall back to the Floe defaults.
	return &App{wake: newWakeGuard(), cfg: loadConfig()}
}

// startup is called when the app starts. The context is saved so we can call the
// runtime methods (events, dialogs).
func (a *App) startup(ctx context.Context) {
	// Under mu: onSecondInstanceLaunch runs on its own goroutine and reads
	// a.ctx, so an unguarded write here is a race exactly during the
	// multi-select cold-start burst this code exists to survive.
	a.mu.Lock()
	a.ctx = ctx
	a.mu.Unlock()
	// Best-effort: register the app for OS notifications (sets up the toast
	// AppUserModelID on Windows). Errors are non-fatal.
	_ = runtime.InitializeNotifications(ctx)

	// Reclaim any pasted-image staging dirs left by a previous run.
	sweepPasteTemps()

	// Files passed on the command line go through the same stage-or-emit seam
	// as second-instance forwards. Staging must MERGE, not assign: a second
	// instance can land before this goroutine runs, and an assignment would
	// silently discard what it staged. The emit branch covers the reverse
	// interleave, where the frontend somehow pulled first.
	if files := filterFileArgs(os.Args[1:]); a.stageOrEmit(files) {
		runtime.EventsEmit(ctx, "files:open", files)
	}

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
	files := filterFileArgs(data.Args)
	a.mu.Lock()
	ctx := a.ctx
	if ctx == nil {
		// startup has not stored the context yet: its goroutine races this
		// callback during a multi-select cold-start burst. Every runtime call
		// below log.Fatals on a nil context, which used to kill the first
		// instance outright and lose every file. Stage and return; the window
		// being raised is still being created anyway.
		a.pendingFiles = append(a.pendingFiles, files...)
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	runtime.WindowUnminimise(ctx)
	runtime.WindowShow(ctx)
	if a.stageOrEmit(files) {
		runtime.EventsEmit(ctx, "files:open", files)
	}
}

// stageOrEmit decides delivery for command-line files: before the frontend's
// one pull, stage them (append: a burst of Explorer launches lands one file
// per call, and cold-start args merge in whatever order they arrive); after
// it, tell the caller to emit. State only, no runtime calls, so tests can
// drive it on a bare &App{}.
func (a *App) stageOrEmit(files []string) (emit bool) {
	if len(files) == 0 {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.frontendReady {
		a.pendingFiles = append(a.pendingFiles, files...)
		return false
	}
	return true
}

// GetPendingFiles returns files passed on the command line and clears them.
// The frontend calls this once on mount. Draining and flipping frontendReady
// in one critical section is what makes delivery lossless: anything staged
// before this instant is in the returned slice, and anything after it sees
// frontendReady and is emitted into a listener the frontend provably
// registered before making this call.
func (a *App) GetPendingFiles() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.frontendReady = true
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
