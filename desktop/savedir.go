package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// envRef matches a %NAME% reference as cmd.exe and Explorer write one, so a
// folder typed as %USERPROFILE%\Downloads means what it does there.
var envRef = regexp.MustCompile(`%([A-Za-z_][A-Za-z0-9_()]*)%`)

// resolveSaveDir turns a folder the person typed into the absolute folder
// Floe writes to. filepath.Abs alone resolved a relative value against the
// process working directory, which for the installed build is the install
// folder: a drop sent to "Downloads\Floe" (the field's own placeholder) landed
// where the uninstaller deletes it. A relative path now means relative to the
// home folder, as the placeholder reads. A path rooted without a drive
// ("\Floe") takes the home folder's drive and a drive-relative one ("D:Floe")
// that drive's root, never a per-process current directory. Surrounding
// quotes, which Explorer's Copy as path adds, are dropped. An empty value
// stays empty so each caller keeps its own default.
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
	vol := filepath.VolumeName(dir)
	rest := dir[len(vol):]
	switch {
	case vol != "":
		return filepath.Join(vol+string(filepath.Separator), rest), nil
	case rest != "" && os.IsPathSeparator(rest[0]):
		return filepath.Join(filepath.VolumeName(home)+string(filepath.Separator), rest), nil
	default:
		return filepath.Join(home, dir), nil
	}
}
