//go:build windows

package main

// Delivery of an OS toast on Windows (H7 S-13, S-14). This is the ONE file that
// imports go-toast, and toastFor is the one place a toast.Notification is built:
// TestNoDirectNotifyInRequestLane pins both. go-toast falls back to a
// PowerShell script on any COM error, where a visitor string could run a
// command (spec 05 section 10, L14), so what reaches this file is only what
// notify was handed: a constant title and body, never a name, a label or engine
// text.

import (
	"context"
	_ "embed"
	"os"
	"path/filepath"
	"strings"

	toast "git.sr.ht/~jackmordaunt/go-toast/v2"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows/registry"
)

// toastKeyRoot is where Windows keeps one notification sender per exe. Wails
// registers Floe under the exe's file name and go-toast fills in the rest.
const toastKeyRoot = `Software\Classes\AppUserModelId\`

// toastDisplayName is what Windows lists as the sender: the constant "Floe"
// rather than the exe's file name, which is what it shows by default.
const toastDisplayName = "Floe"

// toastIconPNG is the fallback for the icon Windows reads for a toast. Wails
// extracts it into the temp folder once per run, and a silent toast can fire
// before any sound toast has made it. A 96 px MSIX asset, not the 1024 px app
// icon: it rides in the binary for a rare repair.
//
//go:embed build/msix/assets/Square44x44Logo.targetsize-96.png
var toastIconPNG []byte

// The registry seams: tests never touch the real HKCU keys.
var (
	toastIconURIFn = readToastIconURI
	toastWriteFn   = writeToastString
)

// pushToast delivers one toast. With sound on it is today's path, Wails'
// runtime notification, unchanged. Silent goes straight to go-toast, because
// Wails passes only a title and a body and so always plays the default sound.
func pushToast(ctx context.Context, title, body string, silent bool) {
	if !silent {
		_ = runtime.SendNotification(ctx, runtime.NotificationOptions{Title: title, Body: body})
		return
	}
	ensureToastIcon()
	n := toastFor(title, body)
	_ = n.Push()
}

// toastFor is the silent toast: a title, a body, foreground activation and no
// sound. No icon (Windows takes the registered one), no actions or inputs, and
// no launch value, so a click runs nothing.
func toastFor(title, body string) toast.Notification {
	return toast.Notification{
		Title:          title,
		Body:           body,
		ActivationType: toast.Foreground,
		Audio:          toast.Silent,
	}
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
