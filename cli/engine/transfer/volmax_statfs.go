//go:build linux || darwin

package transfer

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

var statfsName = platformFSName

// volumeMaxFileSize asks the nearest existing folder because the receive
// checks the volume before it creates the save folder.
func volumeMaxFileSize(dir string) (int64, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return 0, err
	}
	for {
		_, err := os.Stat(abs)
		if err == nil {
			break
		}
		parent := filepath.Dir(abs)
		if !errors.Is(err, fs.ErrNotExist) || parent == abs {
			return 0, err
		}
		abs = parent
	}

	name, err := statfsName(abs)
	if err != nil {
		return 0, err
	}
	return fsMaxFileSize(name), nil
}
