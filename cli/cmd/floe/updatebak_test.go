package main

// The old image a Windows self-update leaves beside floe.exe (A4-B17,
// CLI-03), through the real main() in a child process.

import (
	"os"
	"os/exec"
	"runtime"
	"testing"
)

// TestStartRemovesTheUpdateBackupChild is the child: main() on `floe
// version`, which makes no network call on a dev build.
func TestStartRemovesTheUpdateBackupChild(t *testing.T) {
	if os.Getenv("FLOE_UPDATE_BAK_CHILD") == "" {
		t.Skip("runs only as the child of TestStartRemovesTheUpdateBackup")
	}
	os.Args = []string{"floe", "version"}
	main()
}

// TestStartRemovesTheUpdateBackup: a Windows update renames the running
// floe.exe to floe.exe.floe-update-old and moves the new one in, and the
// delete of that file which follows cannot succeed while that process runs
// from it, so the file stayed until the next update. The next start of floe
// removes it, and only it: a floe.exe.bak is the obvious name for a copy a
// person keeps by hand, so a start leaves it alone (CLI-03).
func TestStartRemovesTheUpdateBackup(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only a Windows update leaves its old image behind")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	old := exe + ".floe-update-old"
	kept := exe + ".bak"
	for _, p := range []string{old, kept} {
		if err := os.WriteFile(p, []byte("an older floe"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(p) })
	}
	cmd := exec.Command(exe, "-test.run", "^TestStartRemovesTheUpdateBackupChild$")
	cmd.Env = append(os.Environ(), "FLOE_UPDATE_BAK_CHILD=1", "FLOE_NO_UPDATE_CHECK=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("the child failed: %v\n%s", err, out)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("floe started and left %s behind (stat err %v)", old, err)
	}
	if _, err := os.Stat(kept); err != nil {
		t.Fatalf("floe started and removed %s, a file no update of this build made: %v", kept, err)
	}
	if _, err := os.Stat(exe); err != nil {
		t.Fatalf("the running floe itself is gone: %v", err)
	}
}
