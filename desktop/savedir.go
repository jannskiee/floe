package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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
	dir, err := expandSaveDir(dir)
	if err != nil || dir == "" {
		return "", err
	}
	if filepath.IsAbs(dir) {
		return filepath.Clean(dir), nil
	}
	if filepath.VolumeName(dir) != "" || os.IsPathSeparator(dir[0]) {
		return "", errNotFullPath
	}
	// Read only here and for ~, so an unset USERPROFILE refuses no absolute
	// folder (W3 R2-11).
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, dir), nil
}

// expandSaveDir trims a typed folder, drops the quotes Explorer's Copy as path
// adds, and expands %NAME% and ~. A value that leaves nothing is "".
func expandSaveDir(dir string) (string, error) {
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
	// A %NAME% set to nothing (or to blanks) leaves nothing to resolve: the
	// caller's default, as for an empty field. resolveSaveDir used to index
	// dir[0] past this and panic (W3 R2-01).
	if strings.TrimSpace(dir) == "" {
		return "", nil
	}
	if dir == "~" || strings.HasPrefix(dir, `~/`) || strings.HasPrefix(dir, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, dir[1:])
	}
	return dir, nil
}

// resolveReceiveDir is resolveSaveDir for a code receive, which also takes the
// two forms Floe Desktop 0.2.12 accepted and saved there (W3 R2-05): a folder
// rooted without its drive (\Floe) and one relative to a drive's current
// folder (D:Floe), resolved as filepath.Abs resolves them, against the current
// drive. Only a request link refuses both, at Make link (D-177).
func resolveReceiveDir(dir string) (string, error) {
	abs, err := resolveSaveDir(dir)
	if !errors.Is(err, errNotFullPath) {
		return abs, err
	}
	if dir, err = expandSaveDir(dir); err != nil {
		return "", err
	}
	return filepath.Abs(dir)
}

// saveDirUsable reports whether an absolute save folder can be made: no name
// in it holds a character Windows refuses, and the nearest part of it that
// exists is a folder. A missing drive, an offline share, a path through a file
// or a name like a|b has none, and a link made there would only fail at
// Accept, spending the link on a refusal that blames the sender. Stat can
// stall for an offline share's network timeout, so callers ask it off the
// UI's path.
func saveDirUsable(dir string) bool {
	if runtime.GOOS == "windows" && strings.ContainsFunc(dir[len(filepath.VolumeName(dir)):], badNameRune) {
		return false
	}
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

// badNameRune is a character Windows refuses in a file or folder name: one of
// < > : " | ? * or a control character (W3 R2-02). The volume (C:, a share's
// \\server\share) is left to the Stat walk.
func badNameRune(r rune) bool {
	return r < 0x20 || strings.ContainsRune(`<>:"|?*`, r)
}
