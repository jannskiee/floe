//go:build windows

package transfer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSanitizedNamesLandOnRealFiles drives the real safeJoin + claimPart +
// commitPart + applyMOTW chain with the names that broke it, and asserts on what is actually
// on disk afterwards.
//
// Every assertion below fails on the pre-fix code, each for a different reason:
//
//   - "backup:2026-08-19.log" wrote its payload into an NTFS alternate data
//     stream, leaving a VISIBLE FILE OF 0 BYTES named "backup". The size check
//     is what catches it, and the production integrity guard structurally
//     cannot: that guard compares the count Write returned against the
//     announced size, and an alternate-stream write returns the full count.
//   - "NUL" wrote to the null device and left nothing on disk at all. The
//     existence check catches it.
//   - "evil.exe " landed on a real "evil.exe", but applyMOTW then wrote
//     "evil.exe :Zone.Identifier" (the space is interior there, so Win32 keeps
//     it) and returned nil. The saved file carried no zone tag, so Windows
//     applied neither SmartScreen nor Office Protected View. The
//     Zone.Identifier check catches it.
//   - "what?.txt" and "report<v2>.pdf" could not be created at all, and the
//     caller turns that into an error that abandons every file still to come in
//     the batch. The create check catches it.
//
// This cannot use the loopback helpers: the sender reads real local files, and
// none of these names can exist on a Windows filesystem to be sent in the first
// place.
func TestSanitizedNamesLandOnRealFiles(t *testing.T) {
	payload := []byte("floe-regression-payload")

	cases := []struct {
		name     string
		fileName string
	}{
		{"colon splits an alternate data stream", "backup:2026-08-19.log"},
		{"null device swallows the write", "NUL"},
		{"trailing space detaches the zone tag", "evil.exe "},
		{"question mark cannot be created", "what?.txt"},
		{"angle brackets cannot be created", "report<v2>.pdf"},
		// The control: an already-safe name must still work end to end, so a
		// regression in applyMOTW itself cannot let this test pass vacuously.
		{"ordinary name still works", "plain.exe"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()

			dest := safeJoin(dir, tc.fileName)
			if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
				t.Fatalf("MkdirAll: %v", err)
			}

			// The real receive chain: claim a .part, write, commit by rename.
			f, claimed, err := claimPart(dest)
			if err != nil {
				t.Fatalf("claimPart(%q) failed, which aborts the whole batch: %v", dest, err)
			}
			written, err := f.Write(payload)
			if err != nil {
				t.Fatalf("write: %v", err)
			}
			if err := f.Close(); err != nil {
				t.Fatalf("close: %v", err)
			}
			if written != len(payload) {
				t.Fatalf("wrote %d bytes, want %d", written, len(payload))
			}
			// Production order: the zone tag goes on the .part BEFORE the
			// rename, so committing also proves the stream travels with it.
			if err := applyMOTW(f.Name()); err != nil {
				t.Fatalf("applyMOTW(%q): %v", f.Name(), err)
			}
			saved, err := commitPart(f.Name(), claimed, dest)
			if err != nil {
				t.Fatalf("commitPart: %v", err)
			}
			if _, err := os.Lstat(f.Name()); !os.IsNotExist(err) {
				t.Errorf("staging file %q still on disk after commit", f.Name())
			}

			// The bytes have to be in the file the name refers to, not beside
			// it in a stream and not in a device.
			st, err := os.Stat(saved)
			if err != nil {
				t.Fatalf("saved file %q does not exist: %v", saved, err)
			}
			if !st.Mode().IsRegular() {
				t.Errorf("saved %q is not a regular file (mode %v)", saved, st.Mode())
			}
			if st.Size() != int64(len(payload)) {
				t.Errorf("saved %q is %d bytes on disk, want %d (payload went somewhere else)",
					saved, st.Size(), len(payload))
			}

			// Mark of the Web has to have traveled with the rename and sit on
			// the file that was actually saved.
			zone, err := os.ReadFile(saved + ":Zone.Identifier")
			if err != nil {
				t.Fatalf("no Zone.Identifier on %q, so SmartScreen will not apply: %v", saved, err)
			}
			if !strings.Contains(string(zone), "ZoneId=3") {
				t.Errorf("Zone.Identifier = %q, want it to contain ZoneId=3", zone)
			}

			// The name that reached disk must carry nothing Win32 reinterprets.
			base := filepath.Base(saved)
			if strings.ContainsAny(base, `<>:"|?*`) {
				t.Errorf("saved name %q still contains a reserved character", base)
			}
			if strings.HasSuffix(base, " ") || strings.HasSuffix(base, ".") {
				t.Errorf("saved name %q still ends in a space or dot", base)
			}
			if got := filepath.Dir(saved); got != dir {
				t.Errorf("saved outside the output dir: %q, want %q", got, dir)
			}
		})
	}
}

// TestSafeJoinFolderStructureSurvives proves the sanitizer runs per component
// rather than over the whole string. Sanitizing the joined name would replace
// the separators and collapse a folder transfer into a single file.
func TestSafeJoinFolderStructureSurvives(t *testing.T) {
	dir := t.TempDir()

	got := safeJoin(dir, "project/src:main/report<1>.pdf")
	want := filepath.Join(dir, "project", "src_main", "report_1_.pdf")
	if got != want {
		t.Errorf("safeJoin = %q, want %q", got, want)
	}
}
