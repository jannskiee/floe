package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// envRef matches a %NAME% reference as cmd.exe and Explorer write one, so a
// folder typed as %USERPROFILE%\Downloads means what it does there.
var envRef = regexp.MustCompile(`%([A-Za-z_][A-Za-z0-9_()]*)%`)

// errNotFullPath is a typed folder that names no place the owner can see: one
// rooted without a drive ("\Floe") or relative to a drive's own current
// directory ("D:Floe").
var errNotFullPath = errors.New("not a full folder path")

// resolveSaveDir turns a folder the person typed into the absolute folder
// Floe writes to. filepath.Abs alone resolved a relative value against the
// process working directory, which for the installed build is the install
// folder: a drop sent to "Downloads\Floe" (the field's own placeholder) landed
// where the uninstaller deletes it. A relative path now means relative to the
// home folder, as the placeholder reads; %NAME% and ~ are expanded; the quotes
// Explorer's Copy as path adds are dropped. A path rooted without a drive, or
// relative to a drive's current directory, is refused (errNotFullPath). An
// empty value stays empty so each caller keeps its own default.
func resolveSaveDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if len(dir) >= 2 && strings.HasPrefix(dir, `"`) && strings.HasSuffix(dir, `"`) {
		dir = strings.TrimSpace(dir[1 : len(dir)-1])
	}
	if dir == "" {
		return "", nil
	}
	dir = envRef.ReplaceAllStringFunc(dir, func(ref string) string {
		if v, ok := os.LookupEnv(ref[1 : len(ref)-1]); ok {
			return v
		}
		return ref
	})
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if dir == "~" || strings.HasPrefix(dir, `~/`) || strings.HasPrefix(dir, `~\`) {
		dir = filepath.Join(home, dir[1:])
	}
	if filepath.IsAbs(dir) {
		return filepath.Clean(dir), nil
	}
	if filepath.VolumeName(dir) != "" || os.IsPathSeparator(dir[0]) {
		return "", errNotFullPath
	}
	return filepath.Join(home, dir), nil
}

// saveDirUsable reports whether an absolute save folder can be made: the
// nearest part of it that exists is a folder. A missing drive, an offline
// share or a path through a file has none, and a link made there would only
// fail at Accept, spending the link on a refusal that blames the sender.
// Stat can stall for an offline share's network timeout, so callers ask it
// off the UI's path.
func saveDirUsable(dir string) bool {
	for p := filepath.Clean(dir); ; {
		if fi, err := os.Stat(p); err == nil {
			return fi.IsDir()
		}
		parent := filepath.Dir(p)
		if parent == p {
			return false
		}
		p = parent
	}
}
