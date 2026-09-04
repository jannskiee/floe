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
func collectFiles(paths []string) ([]fileEntry, error) {
	var entries []fileEntry
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %w", p, err)
		}

		if !info.IsDir() {
			entries = append(entries, fileEntry{
				absPath:     p,
				displayName: filepath.Base(p),
				size:        info.Size(),
			})
			continue
		}

		// Walk the directory
		base := filepath.Dir(p)
		walkErr := filepath.Walk(p, func(path string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(base, path)
			entries = append(entries, fileEntry{
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
