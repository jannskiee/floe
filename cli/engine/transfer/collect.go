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

// notAFile is the mode bits of a pipe, a socket and a device. None of them is
// a file with a size and an end: a pipe or a device sends as an empty file, and
// a socket or a pipe inside a folder stops or hangs the send.
const notAFile = os.ModeNamedPipe | os.ModeSocket | os.ModeDevice | os.ModeCharDevice

// collectFiles expands all paths: plain files are added directly,
// directories are walked and each file inside is added with its relative path.
// The same on-disk file listed more than once under the same send name
// (repeated args, ./a vs a, overlapping globs) is kept only once (#729).
func collectFiles(paths []string) ([]fileEntry, error) {
	var entries []fileEntry
	// listed is every file collected so far, by where it is on disk and
	// the name it will be sent under. A path given twice (a.txt a.txt,
	// ./a.txt beside a.txt, a glob that overlaps a named file, a folder
	// named twice) would list one file under one name twice, and the
	// receiver would save the second copy as "a (1).txt". Only that exact
	// repeat is skipped and the first is kept, so no name is lost: "album"
	// and "album/" name the same files differently, as do a folder and a
	// file inside it, and both still go. The request page (mergeSelection)
	// and Floe Desktop (mergePaths) keep the first of a repeat too.
	listed := make(map[[2]string]bool)
	add := func(onDisk string, e fileEntry) {
		key := [2]string{onDisk, e.displayName}
		if listed[key] {
			return
		}
		listed[key] = true
		entries = append(entries, e)
	}
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %w", p, err)
		}

		if !info.IsDir() {
			if info.Mode()&notAFile != 0 {
				return nil, fmt.Errorf("cannot send %s: it is a pipe, a socket or a device, not a file", p)
			}
			add(absolute(p), fileEntry{
				absPath:     p,
				displayName: filepath.Base(p),
				size:        info.Size(),
			})
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
		// Build top from p, not root: EvalSymlinks rewrites spelling (macOS
		// /var to /private/var, a Windows 8.3 name to the long one), so a key
		// from root would miss the same file named directly.
		top := absolute(p)
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
			// A pipe, a socket or a device inside the folder is left out, and so
			// is a link to one (fi is the target by now).
			if fi.Mode()&notAFile != 0 {
				return nil
			}
			// Named as before, from the path the person gave: the file's place
			// under root, seen from the folder that holds p.
			under, _ := filepath.Rel(root, path)
			rel, _ := filepath.Rel(filepath.Dir(p), filepath.Join(p, under))
			add(filepath.Join(top, under), fileEntry{
				absPath:     path,
				displayName: filepath.ToSlash(rel), // use forward slashes in metadata
				size:        fi.Size(),
			})
			return nil
		})
		if walkErr != nil {
			return nil, fmt.Errorf("cannot walk %s: %w", p, walkErr)
		}
	}
	return entries, nil
}

// absolute is p as a clean absolute path, so two spellings of one path
// (a.txt, ./a.txt, dir/./a.txt) compare equal. filepath.Abs fails only
// when the working directory cannot be read, and the cleaned path is the
// best left then.
func absolute(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return filepath.Clean(p)
}
