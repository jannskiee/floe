package main

import (
	"embed"
	"os"
	"path/filepath"

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

func main() {
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

	if err != nil {
		println("Error:", err.Error())
	}
}
