package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"unicode/utf16"
)

// parseDropFiles decodes a CF_HDROP clipboard payload (a DROPFILES header
// followed by a null-separated, double-null-terminated file list) into absolute
// path strings. The header advertises wide (UTF-16) vs ANSI names; modern
// Explorer always uses wide. A malformed or empty payload yields nil. Kept
// separate from the syscall layer so it is unit-testable without the OS
// clipboard.
func parseDropFiles(data []byte) []string {
	// DROPFILES: pFiles(4) pt(8) fNC(4) fWide(4) = a 20-byte header.
	if len(data) < 20 {
		return nil
	}
	pFiles := binary.LittleEndian.Uint32(data[0:4])
	wide := binary.LittleEndian.Uint32(data[16:20]) != 0
	if int(pFiles) >= len(data) {
		return nil
	}
	list := data[pFiles:]

	var out []string
	if wide {
		u := make([]uint16, 0, len(list)/2)
		for i := 0; i+1 < len(list); i += 2 {
			u = append(u, uint16(list[i])|uint16(list[i+1])<<8)
		}
		start := 0
		for i, c := range u {
			if c != 0 {
				continue
			}
			if i == start { // an empty string means the terminating double-null
				break
			}
			out = append(out, string(utf16.Decode(u[start:i])))
			start = i + 1
		}
	} else {
		start := 0
		for i, b := range list {
			if b != 0 {
				continue
			}
			if i == start {
				break
			}
			out = append(out, string(list[start:i]))
			start = i + 1
		}
	}
	return out
}

// writeImageTemp stages pasted image bytes as pasted-image.png inside a fresh
// temp directory and returns the file path. The fixed inner name is what the
// receiver sees. The file must outlive this call (it sits in the send list until
// the user sends it), so there is no cleanup here; sweepPasteTemps reclaims the
// directory on the next launch.
func writeImageTemp(png []byte) (string, error) {
	dir, err := os.MkdirTemp("", "floe-paste-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "pasted-image.png")
	if err := os.WriteFile(path, png, 0o600); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	return path, nil
}

// sweepPasteTemps removes leftover pasted-image staging directories from prior
// runs. Called once at startup: the single-instance lock means no transfer is in
// flight yet, so every floe-paste-* directory is an orphan safe to delete. The
// text-send staging (floe-text-*) is left untouched.
func sweepPasteTemps() {
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "floe-paste-*"))
	if err != nil {
		return
	}
	for _, m := range matches {
		_ = os.RemoveAll(m)
	}
}
