package transfer

// Expanding the caller's paths into the list of files a send will actually
// transmit. Local filesystem work only: nothing here reads the data channel.

import (
	"fmt"
	"os"
	"path/filepath"
)

// fileEntry holds info about a file to be sent.
type fileEntry struct {
	absPath     string // absolute path on disk
	displayName string // shown in the UI (basename or relative path for folders)
	size        int64  // file size in bytes
}

// collectFiles expands all paths: plain files are added directly,
// directories are walked and each file inside is added with its relative path.
// A file listed more than once carries its data once: the same path spelled
// two ways (`a.txt a.txt`, `./a.txt a.txt`) and a glob that also matches a
// named file (`*.pdf report.pdf`) repeat one entry, and the receiver used to
// keep the repeats under its duplicate slot (`a (1).txt`). A folder listed
// twice walks once under each spelling, whose files land under identical
// names on identical paths, so one dedup covers all of them.
func collectFiles(paths []string) ([]fileEntry, error) {
	var entries []fileEntry
	// The key keeps the resolved path and the display name. Both spellings
	// of one path share both, while a folder reached under two listings
	// names its files differently on purpose (the folder and the trailing
	// separator spellings differ: album/sub/a.txt vs sub/a.txt), and the
	// receiver keeps one entry per name — so different names stay.
	seen := make(map[string]bool)
	list := func(absPath, displayName string, size int64) {
		key := displayName + "\x00" + absPath
		if seen[key] {
			return
		}
		seen[key] = true
		entries = append(entries, fileEntry{absPath: absPath, displayName: displayName, size: size})
	}
	// Paths that spell one file differently map to one key.
	canonical := func(p string) string {
		if cleaned, err := filepath.Abs(filepath.Clean(p)); err == nil {
			return cleaned
		}
		return p
	}
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %w", p, err)
		}

		if !info.IsDir() {
			list(canonical(p), filepath.Base(p), info.Size())
			continue
		}

		// Walk the directory. A path that is itself a link to a folder (or a
		// Windows junction) is the folder the person meant: Walk does not descend
		// into a link at its root, so it walks the resolved folder, and the files
		// are named from the path the person gave.
		root := p
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			root = resolved
		}
		walkErr := filepath.Walk(root, func(path string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return err
			}
			// Walk reports a link by Lstat, whose size is the link's own,
			// while the send opens the link and reads its target. Size it by
			// the target. A link to a folder is not followed (Walk would not
			// walk it, and reading it as a file fails after the receiver has
			// accepted), and a link that points nowhere cannot be read, so
			// both end the send here, before it connects. Go reports a Windows
			// junction or mount point as ModeIrregular rather than ModeSymlink,
			// so both bits mean a link here.
			if fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				target, err := os.Stat(path)
				if err != nil {
					return fmt.Errorf("cannot read %s: %w", path, err)
				}
				if target.IsDir() {
					return fmt.Errorf("cannot send %s: it is a link to a folder, which Floe does not follow", path)
				}
				fi = target
			}
			// Named as before, from the path the person gave: the file's place
			// under root, seen from the folder that holds p.
			under, _ := filepath.Rel(root, path)
			rel, _ := filepath.Rel(filepath.Dir(p), filepath.Join(p, under))
			list(canonical(path), filepath.ToSlash(rel), fi.Size())
			return nil
		})
		if walkErr != nil {
			return nil, fmt.Errorf("cannot walk %s: %w", p, walkErr)
		}
	}
	return entries, nil
}
