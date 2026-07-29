package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/jannskiee/floe/cli/engine/serverurl"
)

// serverConfig is the only persisted setting the app keeps outside the WebView.
//
// It lives in a Go-owned file rather than localStorage because the WebView2
// profile is keyed to the executable's basename, and this binary ships under two
// names (wails.json builds desktop.exe; the installer lays it down as
// floe-desktop.exe). A value stored in localStorage would silently revert to the
// Floe defaults when the user moved between those builds, and because ice.Fetch
// fails open nothing would report the fallback.
//
// An empty field means "use the built-in default", so a fresh install and an
// explicitly cleared field behave identically.
type serverConfig struct {
	Server string `json:"server"` // signaling origin; "" uses defaultServer
	Web    string `json:"web"`    // share-link origin; "" derives from Server
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

// loadConfig reads the settings file, falling back to defaults on any problem.
// A missing, empty, unreadable, or malformed file is not an error the user needs
// to see: the app simply runs against Floe's own servers.
func loadConfig() serverConfig { return loadConfigFrom(configPath()) }

func loadConfigFrom(path string) serverConfig {
	if path == "" {
		return serverConfig{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return serverConfig{}
	}
	var c serverConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return serverConfig{}
	}
	return normalizeConfig(c)
}

// saveConfig writes the settings file atomically. A crash or a second instance
// mid-write leaves the previous file intact rather than a truncated one.
func saveConfig(c serverConfig) error { return saveConfigTo(configPath(), c) }

func saveConfigTo(path string, c serverConfig) error {
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
func normalizeConfig(c serverConfig) serverConfig {
	return serverConfig{
		Server: serverurl.Normalize(c.Server),
		Web:    serverurl.Normalize(c.Web),
	}
}
