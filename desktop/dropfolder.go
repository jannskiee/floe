package main

// The request drop's own folder: its name, from the owner's label and this
// PC's clock, the folder made without ever reusing one, and the folder
// removed when a stopped drop saved nothing in it.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// sanitizeRequestLabel turns the owner's label into one Windows-valid path
// component for the drop's subfolder (spec 06 4.7): the engine's
// single-component sanitizer (separators, controls, bidi marks, and on Windows
// the reserved characters, trailing dots and spaces, device names), then the
// rules that must hold on every OS: trailing dots and spaces trimmed, capped at
// requestLabelMax runes, a bare device name suffixed with "_", and "Request"
// when nothing is left.
func sanitizeRequestLabel(label string) string {
	s := transfer.SafeFolderName(strings.TrimSpace(label))
	s = strings.TrimRight(s, " .")
	if utf8.RuneCountInString(s) > requestLabelMax {
		s = string([]rune(s)[:requestLabelMax])
		s = strings.TrimRight(s, " .")
	}
	if isDeviceName(s) {
		s += "_"
	}
	if s == "" || s == "." || s == ".." {
		return "Request"
	}
	return s
}

// isDeviceName reports whether s is a Win32 device name, case-insensitively
// and as the whole name.
func isDeviceName(s string) bool {
	u := strings.ToUpper(s)
	switch u {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if len(u) == 4 && (strings.HasPrefix(u, "COM") || strings.HasPrefix(u, "LPT")) && u[3] >= '1' && u[3] <= '9' {
		return true
	}
	return false
}

// dropFolderStamp is the time part of a drop folder's name, and
// dropFolderMaxBytes the most its label part may take: the whole name, with
// the stamp and a " (99)", stays within the 255-byte component limit of ext4
// and APFS, and UTF-8 never takes fewer bytes than UTF-16 takes units, so
// NTFS's 255 units hold as well (review 1b N2).
const (
	dropFolderStamp    = "2006-01-02 1504"
	dropFolderMaxBytes = 255 - len(" "+dropFolderStamp) - len(" (99)")
)

// dropFolderName is "<label> YYYY-MM-DD HHMM" from this PC's clock (spec 06
// 4.7): the label through sanitizeRequestLabel, cut on a rune boundary to
// dropFolderMaxBytes.
func dropFolderName(label string, now time.Time) string {
	l := sanitizeRequestLabel(label)
	for len(l) > dropFolderMaxBytes {
		_, size := utf8.DecodeLastRuneInString(l)
		l = l[:len(l)-size]
	}
	if l = strings.TrimRight(l, " ."); l == "" {
		l = "Request"
	}
	return l + " " + now.Format(dropFolderStamp)
}

// makeDropFolder creates the drop's own folder under base, only now that the
// owner accepted with the channel open (spec 06 4.7): MkdirAll on the base,
// then an exclusive Mkdir on the leaf, trying " (2)" to " (99)" when the name
// is taken. It never reuses, and never writes into, a folder that exists.
func makeDropFolder(base, label string, now time.Time) (string, error) {
	abs, err := filepath.Abs(base)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", err
	}
	name := dropFolderName(label, now)
	for i := 1; i <= 99; i++ {
		leaf := name
		if i > 1 {
			leaf = fmt.Sprintf("%s (%d)", name, i)
		}
		p := filepath.Join(abs, leaf)
		err := os.Mkdir(p, 0o755)
		if err == nil {
			return p, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", fmt.Errorf("no free drop folder name under the save folder")
}

// removeEmptyDirs removes root and the directories under it that are empty,
// deepest first, so a folder whose subfolders were all empty goes with them.
// It never removes a file, so a kept .part keeps every folder above it
// (D-128), and os.Remove refuses a directory that is not empty. A stopped
// drop that saved nothing needs this rather than one os.Remove: for a folder
// drop the engine has already made the visitor's subfolders (CP-QA
// F2-CPQA-02), and with nothing saved there is no History row or Show in
// folder to lead the owner to them. WalkDir does not follow a link inside root
// and reports it as no directory, so nothing outside root is walked or removed.
func removeEmptyDirs(root string) {
	var dirs []string
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	})
	// WalkDir lists a directory before anything in it, so the reverse order
	// reaches every child before its parent.
	for i := len(dirs) - 1; i >= 0; i-- {
		_ = os.Remove(dirs[i])
	}
}
