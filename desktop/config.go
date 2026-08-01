package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/jannskiee/floe/cli/engine/serverurl"
)

// appConfig is every persisted setting the app keeps outside the WebView.
//
// It lives in a Go-owned file rather than localStorage because settings must
// survive the webview profile. Historically the binary shipped under two names
// (desktop.exe from wails build, floe-desktop.exe from the installer) and the
// profile was keyed to the exe basename, so localStorage values silently
// reverted to the Floe defaults when the user moved between builds, and because
// ice.Fetch fails open nothing would report the fallback. The name is unified
// and the profile pinned now (webviewDataPath), but the Go-owned file keeps two
// properties localStorage cannot offer: atomic writes, and readability before
// the webview exists.
//
// That reasoning was written for the server addresses but applies just as much to
// the preference toggles, which is why they moved here too. History and the save
// directory deliberately stay in localStorage: this file is rewritten atomically
// on every change, so it is the wrong home for unbounded, high-churn data.
//
// An empty address field means "use the built-in default", so a fresh install and
// an explicitly cleared field behave identically.
type appConfig struct {
	Server string `json:"server"` // signaling origin; "" uses defaultServer
	Web    string `json:"web"`    // share-link origin; "" derives from Server

	HideIP      bool `json:"hideIP"`
	ReportStats bool `json:"reportStats"`

	// Migrated records that the two toggles above came from somewhere real: either
	// the user, or the one-time import of the localStorage keys they used to live
	// in. It is load-bearing, not bookkeeping. Go's zero value for a bool is false,
	// but ReportStats defaults to TRUE, so without this flag a fresh or unreadable
	// file is indistinguishable from "the user switched everything off" and would
	// silently opt people out of the stats counter they had agreed to.
	Migrated bool `json:"migrated"`
}

// configPath returns the settings file, or "" if the OS config directory cannot
// be determined. Mirrors the CLI's update-check cache, which already writes into
// the same floe/ directory.
func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "floe", "desktop.json")
}

// webviewDataPath returns the pinned WebView2 user-data directory, or "" if the
// OS config directory cannot be determined ("" makes Wails fall back to its
// default; a non-empty invalid path would be a message box and exit instead).
//
// Pinning matters: without it the profile lands in %APPDATA%\<exe basename>, so
// renaming or moving the executable orphans everything in localStorage (history,
// the save folder, the context-menu choice marker). Pinned, the portable build
// can live anywhere under any name and keep its state.
func webviewDataPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "floe", "webview")
}

// migrateWebviewProfile adopts a profile from the old exe-basename location the
// first time the pinned path is used, so history and settings survive the
// switch. Best-effort: runs before the webview exists (no locks yet), first
// come wins, and any failure just means starting with a fresh profile.
//
// A FILELESS tree at the target does not count as an existing profile: bare
// directories hold nothing to protect, and an early scaffold left exactly such
// a husk behind (webview/EBWebView with no files), which would otherwise
// permanently block the adoption.
func migrateWebviewProfile(newPath string, oldPaths ...string) {
	if newPath == "" {
		return
	}
	if _, err := os.Stat(newPath); err == nil {
		if dirHasFiles(newPath) {
			return // a real profile lives here: never overwrite
		}
		if os.RemoveAll(newPath) != nil {
			return // fileless but unremovable; leave it be
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return // unknowable state: do nothing
	}
	for _, old := range oldPaths {
		if old == "" {
			continue
		}
		if info, err := os.Stat(old); err != nil || !info.IsDir() {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
			return
		}
		if os.Rename(old, newPath) == nil {
			return
		}
	}
}

// dirHasFiles reports whether any regular file exists anywhere under root.
// Errors count as "has files": when the tree cannot be inspected, the caller
// must treat it as data worth protecting.
func dirHasFiles(root string) bool {
	found := errors.New("found")
	err := filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return found
		}
		if !d.IsDir() {
			return found
		}
		return nil
	})
	return err != nil
}

// loadConfig reads the settings file, falling back to defaults on any problem.
// A missing, empty, unreadable, or malformed file is not an error the user needs
// to see: the app simply runs against Floe's own servers.
func loadConfig() appConfig { return loadConfigFrom(configPath()) }

func loadConfigFrom(path string) appConfig {
	if path == "" {
		return appConfig{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return appConfig{}
	}
	var c appConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return appConfig{}
	}
	return normalizeConfig(c)
}

// saveConfig writes the settings file atomically. A crash or a second instance
// mid-write leaves the previous file intact rather than a truncated one.
func saveConfig(c appConfig) error { return saveConfigTo(configPath(), c) }

func saveConfigTo(path string, c appConfig) error {
	if path == "" {
		return errors.New("cannot locate the user configuration directory")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(normalizeConfig(c), "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// normalizeConfig trims both origins on the way in and out, so a pasted address
// with a trailing slash cannot reach the code that appends paths to it.
func normalizeConfig(c appConfig) appConfig {
	c.Server = serverurl.Normalize(c.Server)
	c.Web = serverurl.Normalize(c.Web)
	return c
}
