//go:build windows

package main

// Delivery of an OS toast on Windows (H7 S-13, S-14; deep QA A2-02). This is
// the ONE file that imports go-toast, and toastXML is the one place a toast is
// built: TestNoDirectNotifyInRequestLane pins both. Every toast goes out
// through go-toast's COM path, wintoast.Push with no option. Wails' runtime
// notification and go-toast's Notification.Push both add the PowerShell
// fallback, which on any COM error runs a hidden "PowerShell -ExecutionPolicy
// Bypass -File <temp>.ps1" that the caller waits on with no bound, and whose
// here-string would run a "$(...)" in the text (spec 05 section 10, L14). The
// fallback shows nothing the COM path could not, so it is never engaged. What
// reaches this file is still only what notify was handed: a constant title and
// body, never a name, a label or engine text.

import (
	"context"
	_ "embed"
	"encoding/xml"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"

	"git.sr.ht/~jackmordaunt/go-toast/v2/wintoast"
	"golang.org/x/sys/windows/registry"
)

// toastKeyRoot is where Windows keeps one notification sender per exe. Wails
// registers Floe under the exe's file name and go-toast fills in the rest.
const toastKeyRoot = `Software\Classes\AppUserModelId\`

// toastDisplayName is what Windows lists as the sender: the constant "Floe"
// rather than the exe's file name, which is what it shows by default.
const toastDisplayName = "Floe"

// toastIconPNG is the icon Windows reads for an unpackaged build's toast, from
// the temp-folder path Wails registers at startup. Wails writes that file only
// when its own notification is sent, which Floe no longer uses, so
// ensureToastIcon writes this one there whenever it is missing. A 96 px MSIX
// asset, not the 1024 px app icon. A packaged build's toasts take the package's
// logo instead.
//
//go:embed build/msix/assets/Square44x44Logo.targetsize-96.png
var toastIconPNG []byte

// The registry seams: tests never touch the real HKCU keys.
var (
	toastIconURIFn = readToastIconURI
	toastWriteFn   = writeToastString
)

// toastAppID is the sender a toast goes out under: the package's own
// AppUserModelID when Floe runs from its MSIX package (the Store build), and
// "" otherwise, which go-toast reads as the exe-name ID Wails registered at
// startup. Under the package that registration lands in the package's private
// registry view, which Windows' notification service never reads, so a toast
// sent under the exe name shows nothing on a PC that has only the Store build.
// It is read once: a process's package identity never changes. A test seam.
var toastAppID = sync.OnceValue(packageAppID)

// toastQueueSize bounds the toasts waiting for the one goroutine that shows
// them. A drop's prompt toast is sent from inside its Decide, and a code
// receive's before ReceiveByCode returns, so delivery never runs on the
// caller; a full queue drops the toast, which is best-effort anyway.
const toastQueueSize = 8

// toastJob is one built toast and the sender it goes out under.
type toastJob struct{ appID, xml string }

// toastLine carries toasts to the one goroutine that shows them.
type toastLine struct {
	queue chan toastJob
	start sync.Once
	push  func(appID, xml string) error
}

// toasts is the app's one line; tests build their own.
var toasts = &toastLine{queue: make(chan toastJob, toastQueueSize), push: comToast}

// comToast shows one toast through the Windows Runtime. The call passes no
// option, so go-toast's PowerShell fallback is never engaged.
func comToast(appID, xml string) error {
	return wintoast.Push(appID, xml)
}

// send queues one toast without waiting, starting the delivery goroutine on
// first use. It reports whether the toast was queued.
func (l *toastLine) send(job toastJob) bool {
	l.start.Do(func() { go l.run() })
	select {
	case l.queue <- job:
		return true
	default:
		return false
	}
}

// run shows the queued toasts one at a time on one locked thread, so
// go-toast's one-time Windows Runtime start and every push share it.
func (l *toastLine) run() {
	goruntime.LockOSThread()
	for job := range l.queue {
		ensureToastIcon()
		_ = l.push(job.appID, job.xml)
	}
}

// pushToast hands one toast to the delivery goroutine and returns at once.
func pushToast(ctx context.Context, title, body string, silent bool) {
	toasts.send(toastJob{appID: toastAppID(), xml: toastXML(title, body, silent)})
}

// toastXML builds the one toast Floe shows: a title, a body, foreground
// activation with no launch value (a click runs nothing), and Windows' default
// sound unless silent. No image, action or input. The text is escaped rather
// than wrapped in CDATA, so no title or body can end an element.
func toastXML(title, body string, silent bool) string {
	var b strings.Builder
	b.WriteString(`<toast activationType="foreground" launch="" duration="short"><visual><binding template="ToastGeneric"><text hint-maxLines="1">`)
	_ = xml.EscapeText(&b, []byte(title))
	b.WriteString(`</text><text>`)
	_ = xml.EscapeText(&b, []byte(body))
	b.WriteString(`</text></binding></visual>`)
	if silent {
		b.WriteString(`<audio silent="true" />`)
	}
	b.WriteString(`</toast>`)
	return b.String()
}

// ensureToastIcon restores the toast icon when it has gone missing. The path
// comes from the registry, where anything could have written it, so it is used
// only when it is a .png that is a direct child of the temp folder, and the
// file is created exclusively: an existing one is never touched.
func ensureToastIcon() {
	p := toastIconURIFn()
	if !isTempPNG(p) {
		return
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return
	}
	_, werr := f.Write(toastIconPNG)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		os.Remove(p) // a half-written icon would never be repaired
	}
}

// isTempPNG reports whether p is a .png directly inside the temp folder.
func isTempPNG(p string) bool {
	if p == "" || !strings.EqualFold(filepath.Ext(p), ".png") {
		return false
	}
	return strings.EqualFold(filepath.Clean(filepath.Dir(p)), filepath.Clean(os.TempDir()))
}

// readToastIconURI reads the icon path Wails registered for this exe, or "".
func readToastIconURI() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, toastKeyRoot+filepath.Base(exe), registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("IconUri")
	if err != nil {
		return ""
	}
	return v
}

// setToastDisplayName names the sender "Floe". It runs before Wails registers
// the app, and writes unconditionally: Wails and go-toast fill DisplayName in
// only when it is empty, so a run that predates this would keep the exe name.
// Under an MSIX package the write lands in a private registry view and does
// nothing, which is harmless.
func setToastDisplayName() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	_ = toastWriteFn(toastKeyRoot+filepath.Base(exe), "DisplayName", toastDisplayName)
}

// writeToastString writes one string value, creating the key.
func writeToastString(path, name, value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}
