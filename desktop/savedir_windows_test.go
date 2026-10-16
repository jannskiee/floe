//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// lockFolder makes dir a folder this process can read but cannot create
// anything in: a protected DACL that denies everyone FILE_ADD_FILE and
// FILE_ADD_SUBDIRECTORY (0x6) and allows the rest, the shape Program Files
// has for a standard user. The cleanup gives the folder an allow-all DACL
// back before t.TempDir removes it. It skips when the lock does not hold, so
// the test never passes on a folder it failed to lock.
func lockFolder(t *testing.T, dir string) {
	t.Helper()
	set := func(sddl string) error {
		sd, err := windows.SecurityDescriptorFromString(sddl)
		if err != nil {
			return err
		}
		dacl, _, err := sd.DACL()
		if err != nil {
			return err
		}
		return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
	}
	if err := set("D:P(D;;0x6;;;WD)(A;OICI;FA;;;WD)"); err != nil {
		t.Fatalf("locking %s: %v", dir, err)
	}
	t.Cleanup(func() {
		if err := set("D:P(A;OICI;FA;;;WD)"); err != nil {
			t.Errorf("unlocking %s: %v", dir, err)
		}
	})
	if err := os.Mkdir(filepath.Join(dir, "probe"), 0o755); err == nil {
		t.Skip("the deny ACE did not stop a mkdir here, so the lock cannot be tested")
	}
}

// TestSaveDirUsableRefusesAFolderFloeCannotWriteIn (deep QA R2-02 rest): a
// folder that exists but takes no new entry, like Program Files for a
// standard user, passed Make link and failed at Accept, when makeDropFolder
// could not make the drop's folder, so the link was spent on write-failed.
// The folder itself and a folder still to be made under it are both refused.
func TestSaveDirUsableRefusesAFolderFloeCannotWriteIn(t *testing.T) {
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.Mkdir(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	lockFolder(t, locked)
	if saveDirUsable(locked) {
		t.Errorf("%s takes no new folder, yet it is usable", locked)
	}
	if saveDirUsable(filepath.Join(locked, "Floe")) {
		t.Errorf("a folder to be made under %s is usable", locked)
	}
}

// TestMakeRequestLinkRefusesAFolderFloeCannotWriteIn: the same folder ends Make
// link with save-folder, E9's "Couldn't use that folder", before any server is
// asked.
func TestMakeRequestLinkRefusesAFolderFloeCannotWriteIn(t *testing.T) {
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.Mkdir(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	lockFolder(t, locked)
	fs := newFakeSignalServer(t)
	a, _ := laneApp(t, fs)
	a.MakeRequestLink("x", locked, "24h", false)
	s := waitState(t, a, 10*time.Second, "error")
	if s.Code != "save-folder" {
		t.Fatalf("Make link into %q: code %q, want save-folder", locked, s.Code)
	}
	if n := len(fs.tokenJoins()); n != 0 {
		t.Fatalf("Make link into %q asked the server %d time(s)", locked, n)
	}
}
