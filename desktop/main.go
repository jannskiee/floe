package main

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is the release string reported to the transfer peer. Overridden at
// build time via -ldflags "-X main.version=v1.0.0"; "dev" for local builds.
var version = "dev"

const fatalTitle = "Floe"

// The one startup failure a user can actually fix themselves, so it is worth
// naming explicitly rather than showing them a nil pointer dereference.
const webview2Hint = "Floe needs the Microsoft WebView2 runtime. " +
	"If this PC is offline or behind a filtering proxy, install WebView2 from " +
	"https://developer.microsoft.com/microsoft-edge/webview2/ and start Floe again."

// fatalMessage turns a panic value or an error into text a user can act on.
//
// hint is searched alongside the cause because the failure we most want to
// explain carries no useful text of its own: when the WebView2 runtime is
// missing and its download cannot be reached, Wails' preflight check panics
// with a bare nil pointer dereference, and only the stack names the package.
func fatalMessage(cause any, hint string) string {
	detail := strings.TrimSpace(fmt.Sprint(cause))
	if detail == "" {
		detail = "unknown error"
	}
	msg := "Floe could not start.\n\n" + detail
	// Joined with a newline rather than concatenated: a bare join could match
	// across the seam, on a cause ending "webview" and a hint starting "2".
	if strings.Contains(strings.ToLower(detail+"\n"+hint), "webview2") {
		msg += "\n\n" + webview2Hint
	}
	return msg
}

func main() {
	// A release build is linked with -H windowsgui, so it has no console and a
	// panic escaping main would end the process with nothing on screen. Wails
	// runs its WebView2 preflight check before any window exists, and a
	// transport failure fetching the runtime panics inside it, so this is a
	// reachable path rather than a theoretical one. The stack still goes to
	// stderr for `wails dev`, where a console does exist.
	defer func() {
		if r := recover(); r != nil {
			stack := debug.Stack()
			fmt.Fprintf(os.Stderr, "panic: %v\n\n%s", r, stack)
			showFatal(fatalTitle, fatalMessage(r, string(stack)))
			os.Exit(1)
		}
	}()

	// Create an instance of the app structure
	app := NewApp()

	// Pin the WebView2 profile to a path that does not depend on the exe name,
	// adopting the profile from the historical %APPDATA%\<exe>.exe locations on
	// first run so history and settings carry over.
	webviewData := webviewDataPath()
	if appData := os.Getenv("APPDATA"); appData != "" {
		migrateWebviewProfile(webviewData,
			filepath.Join(appData, "floe-desktop.exe"),
			filepath.Join(appData, "desktop.exe"))
	}

	// Create application with options
	err := wails.Run(&options.App{
		Windows: &windows.Options{
			WebviewUserDataPath: webviewData,
		},
		Title:     "Floe",
		Width:     1140,
		Height:    720,
		MinWidth:  1000,
		MinHeight: 640,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 9, G: 9, B: 11, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnBeforeClose:    app.onBeforeClose,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "one.floe.desktop",
			OnSecondInstanceLaunch: app.onSecondInstanceLaunch,
		},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		Bind: []interface{}{
			app,
		},
	})

	// Exit non-zero as well as showing the dialog: the previous println went to
	// a console the release build does not have, and falling out of main left
	// the process reporting success on a failed start.
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		showFatal(fatalTitle, fatalMessage(err, ""))
		os.Exit(1)
	}
}
