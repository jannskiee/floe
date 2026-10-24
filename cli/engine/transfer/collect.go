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
// A path seen before is skipped, keeping the first listing: the same file
// given twice (a.txt a.txt, ./a.txt a.txt, a glob that also matches a named
// file, a folder named twice) reached the receiver as two copies. The key is
// the resolved path together with the display name, because the name depends
// on how the folder was typed (album names its files album/sub/a.txt, album/
// names them sub/a.txt) and the receiver keys its copies on the name.
func collectFiles(paths []string) ([]fileEntry, error) {
	var entries []fileEntry
	seen := make(map[string]bool)
	add := func(absPath, displayName string, size int64) {
		key := absPath + "\x00" + displayName
		if seen[key] {
			return
		}
		seen[key] = true
		entries = append(entries, fileEntry{absPath: absPath, displayName: displayName, size: size})
	}
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %w", p, err)
		}

		if !info.IsDir() {
			resolved := p
			if r, err := filepath.EvalSymlinks(p); err == nil {
				resolved = r
			}
			add(resolved, filepath.Base(p), info.Size())
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
			add(path, filepath.ToSlash(rel), fi.Size()) // forward slashes in metadata
			return nil
		})
		if walkErr != nil {
			return nil, fmt.Errorf("cannot walk %s: %w", p, walkErr)
		}
	}
	return entries, nil
}
